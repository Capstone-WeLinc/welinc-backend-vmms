import { BadRequestException, Injectable } from '@nestjs/common';
import { MaintenanceApprovalStatus, MaintenanceStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma.service';

export type MaintenanceCostingActor = { sub: string; email: string };

type CostSchedule = {
  id: string;
  workOrderNumber: string;
  vehicleId: string;
  title: string;
  assignedMechanic: string;
  completedAt: Date | null;
  partsCost: Prisma.Decimal | null;
  laborCost: Prisma.Decimal | null;
  totalCost: Prisma.Decimal | null;
  workOrderProgress: Prisma.JsonValue | null;
  assignedMechanicUser: { name: string } | null;
};

function decimalNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  if (typeof value === 'object' && value !== null && 'toNumber' in value && typeof value.toNumber === 'function') {
    const parsed = value.toNumber();
    return Number.isFinite(parsed) ? parsed : null;
  }
  const parsed = typeof value === 'number' ? value : Number(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function executionPartsCost(progress: Prisma.JsonValue | null): number {
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)) return 0;
  const data = progress as Record<string, Prisma.JsonValue>;
  const execution = data.execution;
  if (execution && typeof execution === 'object' && !Array.isArray(execution)) {
    const items = (execution as Record<string, Prisma.JsonValue>).items;
    if (Array.isArray(items)) {
      const legacy = items.reduce<number>((sum, item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return sum;
        return sum + (decimalNumber((item as Record<string, Prisma.JsonValue>).partsCost) ?? 0);
      }, 0);
      if (legacy > 0) return legacy;
    }
  }
  const partDetails = data.partDetails;
  if (!partDetails || typeof partDetails !== 'object' || Array.isArray(partDetails)) return 0;
  return Object.values(partDetails as Record<string, Prisma.JsonValue>).reduce<number>((sum, detail) => {
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return sum;
    const part = detail as Record<string, Prisma.JsonValue>;
    if (typeof part.partsUsed !== 'string' || !part.partsUsed.trim()) return sum;
    return sum + (decimalNumber(part.materialCost) ?? 0);
  }, 0);
}

function scheduleCost(schedule: CostSchedule) {
  const parts = decimalNumber(schedule.partsCost);
  const labor = decimalNumber(schedule.laborCost);
  const storedTotal = decimalNumber(schedule.totalCost);
  const legacyParts = executionPartsCost(schedule.workOrderProgress);
  const partsCost = parts ?? (legacyParts > 0 ? legacyParts : null);
  const derivedTotal = partsCost != null || labor != null
    ? (partsCost ?? 0) + (labor ?? 0)
    : null;
  const totalCost = derivedTotal ?? storedTotal ?? legacyParts;
  return {
    partsCost,
    laborCost: labor,
    totalCost: Math.round(Math.max(0, totalCost) * 100) / 100,
  };
}

function manilaDateParts(date: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return { year: read('year'), month: read('month'), day: read('day') };
}

function dateKey(year: number, month: number, day: number) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function defaultPeriod(now: Date) {
  const { year, month } = manilaDateParts(now);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: dateKey(year, month, 1), to: dateKey(year, month, lastDay) };
}

function parseDateOnly(value: string, field: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BadRequestException(`${field} must use YYYY-MM-DD format.`);
  }
  const [year, month, day] = value.split('-').map(Number);
  const normalized = dateKey(year, month, day);
  const utcDate = new Date(Date.UTC(year, month - 1, day));
  if (normalized !== value || utcDate.toISOString().slice(0, 10) !== value) {
    throw new BadRequestException(`${field} must be a valid calendar date.`);
  }
  return new Date(`${value}T00:00:00+08:00`);
}

function nextDate(dateOnly: string) {
  const [year, month, day] = dateOnly.split('-').map(Number);
  return dateKey(...(() => {
    const date = new Date(Date.UTC(year, month - 1, day + 1));
    return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()] as const;
  })());
}

function manilaMonthKey(date: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit',
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  return year && month ? `${year}-${month}` : '';
}

function monthOffset(monthKey: string, offset: number) {
  const [year, month] = monthKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

@Injectable()
export class MaintenanceCostingService {
  constructor(private readonly prisma: PrismaService) {}

  async getDashboard(fromInput?: string, toInput?: string, now = new Date()) {
    if (Boolean(fromInput) !== Boolean(toInput)) {
      throw new BadRequestException('Provide both from and to dates, or neither.');
    }
    const period = fromInput && toInput ? { from: fromInput, to: toInput } : defaultPeriod(now);
    const from = parseDateOnly(period.from, 'from');
    const toExclusive = parseDateOnly(nextDate(period.to), 'to');
    const toInclusive = parseDateOnly(period.to, 'to');
    if (from.getTime() > toInclusive.getTime()) {
      throw new BadRequestException('from must be on or before to.');
    }

    const historyMonthStart = monthOffset(manilaMonthKey(from), -2);
    const historyFrom = parseDateOnly(`${historyMonthStart}-01`, 'from');
    const [vehicles, schedules, setting] = await Promise.all([
      this.prisma.vehicle.findMany({
        where: { deletedAt: null },
        select: { id: true, plateNumber: true, make: true, model: true, isActive: true, garage: { select: { name: true } } },
        orderBy: { plateNumber: 'asc' },
      }),
      this.prisma.maintenanceSchedule.findMany({
        where: {
          deletedAt: null,
          status: MaintenanceStatus.COMPLETED,
          approvalStatus: MaintenanceApprovalStatus.VERIFIED,
          completedAt: { gte: historyFrom, lt: toExclusive },
        },
        select: {
          id: true,
          workOrderNumber: true,
          vehicleId: true,
          title: true,
          assignedMechanic: true,
          completedAt: true,
          partsCost: true,
          laborCost: true,
          totalCost: true,
          workOrderProgress: true,
          assignedMechanicUser: { select: { name: true } },
        },
        orderBy: { completedAt: 'desc' },
      }),
      this.prisma.maintenanceCostingSetting.findUnique({ where: { id: 'default' } }),
    ]);

    const vehicleByPlate = new Map(vehicles.map((vehicle) => [vehicle.plateNumber, vehicle]));
    const totals = new Map<string, number>();
    const monthlyTotals = new Map<string, Map<string, number>>();
    const recordsByVehicle = new Map<string, Array<Record<string, unknown>>>();
    for (const schedule of schedules as CostSchedule[]) {
      const vehicle = vehicleByPlate.get(schedule.vehicleId);
      if (!vehicle || !schedule.completedAt) continue;
      const cost = scheduleCost(schedule);

      const month = manilaMonthKey(schedule.completedAt);
      const byMonth = monthlyTotals.get(vehicle.id) ?? new Map<string, number>();
      byMonth.set(month, (byMonth.get(month) ?? 0) + cost.totalCost);
      monthlyTotals.set(vehicle.id, byMonth);

      if (schedule.completedAt >= from && schedule.completedAt < toExclusive) {
        const currentTotal = totals.get(vehicle.id) ?? 0;
        totals.set(vehicle.id, currentTotal + cost.totalCost);
        const rows = recordsByVehicle.get(vehicle.id) ?? [];
        rows.push({
          id: schedule.id,
          workOrderNumber: schedule.workOrderNumber,
          title: schedule.title,
          type: schedule.title,
          completedAt: schedule.completedAt,
          mechanicName: schedule.assignedMechanicUser?.name ?? schedule.assignedMechanic,
          ...cost,
        });
        recordsByVehicle.set(vehicle.id, rows);
      }
    }

    const threshold = setting?.threshold == null ? null : decimalNumber(setting.threshold);
    const truckCosts = vehicles.map((vehicle) => {
      const totalCost = Math.round((totals.get(vehicle.id) ?? 0) * 100) / 100;
      const months = monthlyTotals.get(vehicle.id) ?? new Map<string, number>();
      const lastMonth = manilaMonthKey(toInclusive);
      const recurringHighCost = threshold != null && [0, 1, 2].every((offset) =>
        (months.get(monthOffset(lastMonth, -offset)) ?? 0) > threshold,
      );
      return {
        vehicleId: vehicle.id,
        plateNumber: vehicle.plateNumber,
        make: vehicle.make,
        model: vehicle.model,
        garageName: vehicle.garage?.name ?? null,
        isActive: vehicle.isActive,
        totalCost,
        flagged: threshold != null && totalCost > threshold,
        recurringHighCost,
        records: recordsByVehicle.get(vehicle.id) ?? [],
      };
    });

    const totalMaintenanceCosts = Math.round(truckCosts.reduce((sum, truck) => sum + truck.totalCost, 0) * 100) / 100;
    const totalActiveTrucks = vehicles.filter((vehicle) => vehicle.isActive).length;
    const trucksWithCosts = truckCosts.filter((truck) => truck.records.length > 0);
    const mostCostlyTruck = truckCosts
      .filter((truck) => truck.records.length > 0)
      .sort((left, right) => right.totalCost - left.totalCost)[0] ?? null;

    return {
      period,
      threshold,
      totalMaintenanceCosts,
      mostCostlyTruck: mostCostlyTruck ? {
        vehicleId: mostCostlyTruck.vehicleId,
        plateNumber: mostCostlyTruck.plateNumber,
        totalCost: mostCostlyTruck.totalCost,
      } : null,
      averageCostPerTruck: totalActiveTrucks
        ? Math.round((totalMaintenanceCosts / totalActiveTrucks) * 100) / 100
        : 0,
      totalActiveTrucks,
      trucksWithCosts: trucksWithCosts.length,
      trucks: truckCosts,
    };
  }

  async updateThreshold(value: number, actor: MaintenanceCostingActor) {
    if (!Number.isFinite(value) || value <= 0 || Math.abs(value * 100 - Math.round(value * 100)) > 1e-8) {
      throw new BadRequestException('Threshold must be a positive amount with at most two decimal places.');
    }
    const threshold = new Prisma.Decimal(value.toFixed(2));
    return this.prisma.$transaction(async (tx) => {
      const previous = await tx.maintenanceCostingSetting.findUnique({ where: { id: 'default' } });
      const saved = await tx.maintenanceCostingSetting.upsert({
        where: { id: 'default' },
        create: { id: 'default', threshold, updatedById: actor.sub, updatedByEmail: actor.email },
        update: { threshold, updatedById: actor.sub, updatedByEmail: actor.email },
      });
      await tx.maintenanceCostingThresholdAudit.create({
        data: {
          actorId: actor.sub,
          actorEmail: actor.email,
          previousThreshold: previous?.threshold ?? null,
          newThreshold: threshold,
        },
      });
      return {
        threshold: decimalNumber(saved.threshold) ?? Number(value.toFixed(2)),
        updatedAt: saved.updatedAt,
      };
    });
  }
}
