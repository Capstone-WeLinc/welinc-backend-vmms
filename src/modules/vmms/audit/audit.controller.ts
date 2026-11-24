import { Controller, Get, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { SystemType, UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { RoleSystem, Roles } from '../../../auth/decorators/roles.decorator';
import { PrismaService } from '../../../shared/prisma.service';

type BusinessAuditRecord = {
  id: string;
  source: 'business';
  category:
    | 'vehicle'
    | 'fuel'
    | 'maintenance_schedule'
    | 'maintenance_costing';
  actor: string;
  action: string;
  entity: string;
  details: string | null;
  previousValue: string | null;
  newValue: string | null;
  createdAt: string;
};

function details(...values: Array<string | null | undefined>): string | null {
  const text = values
    .map((value) => value?.trim())
    .filter(Boolean)
    .join(' · ');
  return text || null;
}

function record(
  id: string,
  actor: string,
  action: string,
  entity: string,
  createdAt: Date,
  options: {
    category: BusinessAuditRecord['category'];
    details?: string | null;
    previousValue?: string | null;
    newValue?: string | null;
  },
): BusinessAuditRecord {
  return {
    id,
    source: 'business',
    category: options.category,
    actor,
    action,
    entity,
    details: options.details ?? null,
    previousValue: options.previousValue ?? null,
    newValue: options.newValue ?? null,
    createdAt: createdAt.toISOString(),
  };
}

@Controller('audit-logs')
@UseGuards(JwtAuthGuard, RolesGuard)
@RoleSystem(SystemType.VMMS)
@Roles(UserRole.ADMIN)
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('business')
  async business(@Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const take = 100;
    const [
      vehicles,
      fuel,
      cancellations,
      costing,
      editUnlocks,
      edits,
    ] = await Promise.all([
      this.prisma.vehicleAuditLog.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take,
        select: {
          id: true,
          email: true,
          action: true,
          fieldName: true,
          previousValue: true,
          newValue: true,
          createdAt: true,
          vehicle: { select: { plateNumber: true } },
        },
      }),
      this.prisma.fuelAuditLog.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take,
        select: {
          id: true,
          actorEmail: true,
          action: true,
          reason: true,
          details: true,
          createdAt: true,
          fillUp: { select: { vehicle: { select: { plateNumber: true } } } },
        },
      }),
      this.prisma.maintenanceScheduleCancellation.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take,
        select: {
          id: true,
          actorName: true,
          reason: true,
          reviewStatus: true,
          reviewReason: true,
          createdAt: true,
          schedule: { select: { title: true } },
        },
      }),
      this.prisma.maintenanceCostingThresholdAudit.findMany({
        orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
        take,
        select: {
          id: true,
          actorEmail: true,
          previousThreshold: true,
          newThreshold: true,
          changedAt: true,
        },
      }),
      this.prisma.maintenanceLogEditUnlock.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take,
        select: {
          id: true,
          actorName: true,
          reason: true,
          reviewStatus: true,
          createdAt: true,
          schedule: { select: { title: true } },
        },
      }),
      this.prisma.maintenanceLogEditAudit.findMany({
        orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
        take,
        select: {
          id: true,
          actorName: true,
          fieldName: true,
          unlockReason: true,
          previousValue: true,
          newValue: true,
          changedAt: true,
          schedule: { select: { title: true } },
        },
      }),
    ]);

    const records: BusinessAuditRecord[] = [
      ...vehicles.map((row) =>
        record(
          row.id,
          row.email,
          row.action,
          `Vehicle ${row.vehicle.plateNumber}`,
          row.createdAt,
          {
            category: 'vehicle',
            details: row.fieldName,
            previousValue: row.previousValue,
            newValue: row.newValue,
          },
        ),
      ),
      ...fuel.map((row) =>
        record(
          row.id,
          row.actorEmail,
          row.action,
          row.fillUp ? `Fuel ${row.fillUp.vehicle.plateNumber}` : 'Fuel report',
          row.createdAt,
          {
            category: 'fuel',
            details: details(
              row.reason,
              row.details == null ? null : JSON.stringify(row.details),
            ),
          },
        ),
      ),
      ...cancellations.map((row) =>
        record(
          row.id,
          row.actorName,
          `SCHEDULE_${row.reviewStatus}`,
          `Schedule ${row.schedule.title}`,
          row.createdAt,
          {
            category: 'maintenance_schedule',
            details: details(row.reason, row.reviewReason),
          },
        ),
      ),
      ...costing.map((row) =>
        record(
          row.id,
          row.actorEmail,
          'COST_THRESHOLD_CHANGED',
          'Maintenance costing settings',
          row.changedAt,
          {
            category: 'maintenance_costing',
            previousValue: row.previousThreshold?.toString() ?? null,
            newValue: row.newThreshold.toString(),
          },
        ),
      ),
      ...editUnlocks.map((row) =>
        record(
          row.id,
          row.actorName,
          `LOG_EDIT_${row.reviewStatus}`,
          `Schedule ${row.schedule.title}`,
          row.createdAt,
          { category: 'maintenance_schedule', details: row.reason },
        ),
      ),
      ...edits.map((row) =>
        record(
          row.id,
          row.actorName,
          `LOG_FIELD_${row.fieldName}`,
          `Schedule ${row.schedule.title}`,
          row.changedAt,
          {
            category: 'maintenance_schedule',
            details: row.unlockReason,
            previousValue: row.previousValue,
            newValue: row.newValue,
          },
        ),
      ),
    ];

    records.sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    );
    return { records: records.slice(0, take) };
  }
}
