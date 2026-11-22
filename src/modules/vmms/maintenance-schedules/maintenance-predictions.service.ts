import { Injectable } from '@nestjs/common';
import {
  MaintenanceIntervalType,
  MaintenanceStatus,
  MaintenanceTriggerType,
} from '@prisma/client';
import { PrismaService } from '../../../shared/prisma.service';
import { scheduleDue } from './schedule-due';

const HISTORY_DAYS = 90;
const MIN_HISTORY_READINGS = 3;
const MIN_HISTORY_SPAN_DAYS = 30;
const PREDICTION_HORIZON_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

type ReadingPoint = {
  date: string;
  odometer: number;
};

function manilaDate(value: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);
}

function daysBetween(start: string, end: string): number {
  return (
    (Date.parse(`${end}T00:00:00.000Z`) -
      Date.parse(`${start}T00:00:00.000Z`)) /
    DAY_MS
  );
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function parseReading(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const reading = Number(value);
  return Number.isSafeInteger(reading) ? reading : null;
}

function predictionForSchedule(
  schedule: {
    triggerType: MaintenanceTriggerType | null;
    startingReferenceReadingKm: number | null;
    odometerReading: number | null;
    intervalKm: number | null;
    bufferDistanceKm: number | null;
    intervalType: MaintenanceIntervalType | null;
    startReferenceDate: Date | null;
    targetDueDate: Date | null;
    timeIntervalValue: number | null;
    timeIntervalUnit: string | null;
  },
  currentOdometer: number,
  points: ReadingPoint[],
  now: Date,
) {
  if (
    schedule.triggerType !== MaintenanceTriggerType.ODOMETER ||
    points.length < MIN_HISTORY_READINGS ||
    daysBetween(points[0].date, points[points.length - 1].date) <
      MIN_HISTORY_SPAN_DAYS ||
    points[points.length - 1].odometer !== currentOdometer
  ) {
    return null;
  }

  const rates: number[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const elapsedDays = daysBetween(previous.date, current.date);
    if (elapsedDays <= 0 || current.odometer <= previous.odometer) return null;
    rates.push((current.odometer - previous.odometer) / elapsedDays);
  }

  const dailyRate = median(rates);
  const dueOdometer = scheduleDue(schedule).dueOdometer;
  if (!Number.isFinite(dailyRate) || dailyRate <= 0 || dueOdometer == null)
    return null;

  const remainingKm = dueOdometer - currentOdometer;
  if (remainingKm <= 0) return null;
  const projectedAt = new Date(
    now.getTime() + (remainingKm / dailyRate) * DAY_MS,
  );
  const estimatedDueDate = manilaDate(projectedAt);
  const daysUntilDue = daysBetween(manilaDate(now), estimatedDueDate);
  if (daysUntilDue < 0 || daysUntilDue > PREDICTION_HORIZON_DAYS)
    return null;

  return {
    dueOdometer,
    remainingKm,
    daysUntilDue,
    dailyRateKm: Math.round(dailyRate * 100) / 100,
    estimatedDueDate,
    historyCount: points.length,
    historyStartDate: points[0].date,
    historyEndDate: points[points.length - 1].date,
  };
}

@Injectable()
export class MaintenancePredictionsService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const now = new Date();
    const cutoff = new Date(now.getTime() - HISTORY_DAYS * DAY_MS);
    const [vehicles, schedules] = await Promise.all([
      this.prisma.vehicle.findMany({
        where: { isActive: true, deletedAt: null },
        select: { id: true, plateNumber: true, odometer: true },
      }),
      this.prisma.maintenanceSchedule.findMany({
        where: {
          deletedAt: null,
          triggerType: MaintenanceTriggerType.ODOMETER,
          status: { in: [MaintenanceStatus.PENDING, MaintenanceStatus.DUE] },
        },
        select: {
          id: true,
          workOrderNumber: true,
          vehicleId: true,
          title: true,
          status: true,
          triggerType: true,
          startingReferenceReadingKm: true,
          odometerReading: true,
          intervalKm: true,
          bufferDistanceKm: true,
          intervalType: true,
          startReferenceDate: true,
          targetDueDate: true,
          timeIntervalValue: true,
          timeIntervalUnit: true,
        },
      }),
    ]);

    if (!vehicles.length || !schedules.length) return [];

    const vehicleByPlate = new Map(
      vehicles.map((vehicle) => [vehicle.plateNumber, vehicle]),
    );
    const auditRows = await this.prisma.vehicleAuditLog.findMany({
      where: {
        vehicleId: { in: vehicles.map((vehicle) => vehicle.id) },
        action: 'ODOMETER_UPDATED',
        fieldName: 'odometer',
        createdAt: { gte: cutoff },
      },
      select: {
        vehicleId: true,
        newValue: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    const pointsByVehicle = new Map<string, Map<string, ReadingPoint>>();
    const invalidHistory = new Set<string>();
    for (const row of auditRows) {
      const odometer = parseReading(row.newValue);
      if (odometer === null) {
        invalidHistory.add(row.vehicleId);
        continue;
      }
      const date = manilaDate(row.createdAt);
      const points = pointsByVehicle.get(row.vehicleId) ?? new Map();
      const previousPoints = [...points.values()];
      const previousPoint = previousPoints[previousPoints.length - 1];
      if (previousPoint && odometer <= previousPoint.odometer)
        invalidHistory.add(row.vehicleId);
      points.set(date, { date, odometer });
      pointsByVehicle.set(row.vehicleId, points);
    }

    const predictions = schedules.flatMap((schedule) => {
      const vehicle = vehicleByPlate.get(schedule.vehicleId);
      if (!vehicle || invalidHistory.has(vehicle.id)) return [];
      const points = [
        ...(pointsByVehicle.get(vehicle.id)?.values() ?? []),
      ].sort((left, right) => left.date.localeCompare(right.date));
      const estimate = predictionForSchedule(
        schedule,
        vehicle.odometer,
        points,
        now,
      );
      if (!estimate) return [];
      return [
        {
          scheduleId: schedule.id,
          workOrderNumber: schedule.workOrderNumber,
          vehicleId: schedule.vehicleId,
          title: schedule.title,
          currentOdometer: vehicle.odometer,
          status: schedule.status,
          ...estimate,
        },
      ];
    });

    return predictions.sort(
      (left, right) =>
        left.estimatedDueDate.localeCompare(right.estimatedDueDate) ||
        left.vehicleId.localeCompare(right.vehicleId),
    );
  }
}
