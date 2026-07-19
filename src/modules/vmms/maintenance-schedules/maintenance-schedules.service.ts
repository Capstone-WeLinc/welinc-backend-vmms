import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  AccountType,
  MaintenanceIntervalType,
  MaintenanceSchedule,
  MaintenanceStatus,
  MaintenanceTriggerType,
  Prisma,
  VehicleStatus,
} from '@prisma/client';
import { PrismaService } from '../../../shared/prisma.service';
import { CreateMaintenanceScheduleDto } from './dto/create-maintenance-schedule.dto';

@Injectable()
export class MaintenanceSchedulesService {
  private readonly logger = new Logger(MaintenanceSchedulesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    try {
      const schedules = await this.prisma.maintenanceSchedule.findMany({
        where: { deletedAt: null },
        orderBy: { createdAt: 'desc' },
      });

      return schedules.map((schedule) => ({
        id: schedule.id,
        vehicleId: schedule.vehicleId,
        title: schedule.title,
        status: schedule.status,
        date: schedule.createdAt.toISOString().slice(0, 10),
        assignedMechanic: schedule.assignedMechanic,
        assignedDriver: schedule.assignedMechanic,
        accountType: schedule.accountType ?? null,
        checklistTemplateId: schedule.checklistTemplateId ?? null,
        garageId: schedule.garageId ?? null,
        odometerReading: schedule.odometerReading?.toString() ?? null,
        triggerType: schedule.triggerType ?? null,
        intervalKm: schedule.intervalKm?.toString() ?? null,
        bufferDistanceKm: schedule.bufferDistanceKm?.toString() ?? null,
        startingReferenceReadingKm:
          schedule.startingReferenceReadingKm?.toString() ?? null,
        intervalType: schedule.intervalType ?? null,
        startReferenceDate: schedule.startReferenceDate
          ? schedule.startReferenceDate.toISOString().slice(0, 10)
          : null,
        previousScheduleId: schedule.previousScheduleId ?? null,
        workOrderProgress: schedule.workOrderProgress ?? null,
      }));
    } catch (err) {
      // If the database schema is missing columns (e.g. during development), fall
      // back to a resilient raw query selecting a minimal set of columns. This
      // prevents the entire endpoint from returning 500 due to schema drift.
      console.error('Prisma findMany failed, falling back to raw query', err);

      type RawScheduleRow = {
        id: string;
        vehicleId: string | null;
        title: string | null;
        status: string | null;
        created_at: Date | string | null;
        scheduled_date?: Date | string | null;
        assigned_mechanic: string | null;
        account_type: string | null;
        checklist_template_id: string | null;
        garage_id?: string | null;
        odometer_reading: number | null;
        trigger_type: string | null;
        interval_km?: number | null;
        buffer_distance_km?: number | null;
        starting_reference_reading_km?: number | null;
        interval_type?: string | null;
        start_reference_date?: Date | string | null;
        previous_schedule_id?: string | null;
        work_order_progress?: Prisma.JsonValue | null;
      };

      const columns = await this.getMaintenanceScheduleColumns();
      const createdDateColumn = columns.has('created_at')
        ? 'created_at'
        : columns.has('scheduled_date')
          ? 'scheduled_date'
          : null;
      const optionalColumn = (column: string) =>
        columns.has(column) ? column : `NULL AS ${column}`;
      const dateOrder = createdDateColumn ?? 'id';
      const whereClause = columns.has('deleted_at') ? 'WHERE deleted_at IS NULL' : '';
      const rows = await this.prisma.$queryRawUnsafe<RawScheduleRow[]>(
        `SELECT id, "vehicleId", title, status, ${optionalColumn('created_at')}, ${optionalColumn('scheduled_date')}, assigned_mechanic, account_type, checklist_template_id, ${optionalColumn('garage_id')}, odometer_reading, trigger_type, ${optionalColumn('interval_km')}, ${optionalColumn('buffer_distance_km')}, ${optionalColumn('starting_reference_reading_km')}, ${optionalColumn('interval_type')}, ${optionalColumn('start_reference_date')}, ${optionalColumn('previous_schedule_id')}, ${optionalColumn('work_order_progress')} FROM maintenance_schedules ${whereClause} ORDER BY ${dateOrder} DESC`,
      );

      return rows.map((r) => ({
        id: String(r.id),
        vehicleId: r.vehicleId ?? '',
        title: r.title ?? '',
        status: r.status ?? MaintenanceStatus.PENDING,
        date: this.formatDateOnly(r.created_at ?? r.scheduled_date ?? null),
        assignedMechanic: r.assigned_mechanic ?? null,
        assignedDriver: r.assigned_mechanic ?? null,
        accountType: r.account_type ?? null,
        checklistTemplateId: r.checklist_template_id ?? null,
        garageId: r.garage_id ?? null,
        odometerReading:
          r.odometer_reading != null ? String(r.odometer_reading) : null,
        triggerType: r.trigger_type ?? null,
        intervalKm: r.interval_km != null ? String(r.interval_km) : null,
        bufferDistanceKm:
          r.buffer_distance_km != null ? String(r.buffer_distance_km) : null,
        startingReferenceReadingKm:
          r.starting_reference_reading_km != null
            ? String(r.starting_reference_reading_km)
            : null,
        intervalType: r.interval_type ?? null,
        startReferenceDate: this.formatDateOnly(r.start_reference_date ?? null),
        previousScheduleId: r.previous_schedule_id ?? null,
        workOrderProgress: r.work_order_progress ?? null,
      }));
    }
  }

  async create(data: CreateMaintenanceScheduleDto) {
    const schedule = await this.prisma.maintenanceSchedule.create({
      data: {
        vehicleId: data.vehicleId,
        title: data.title,
        status: data.status ?? MaintenanceStatus.PENDING,
        assignedMechanic: this.getAssignedMechanic(data),
        accountType: data.accountType ?? data.account_type,
        checklistTemplateId: data.checklistTemplateId,
        garageId: data.garageId,
        odometerReading: data.odometerReading
          ? parseInt(data.odometerReading, 10)
          : undefined,
        triggerType: data.triggerType,
        intervalKm: data.intervalKm ? parseInt(data.intervalKm, 10) : undefined,
        bufferDistanceKm: data.bufferDistanceKm
          ? parseInt(data.bufferDistanceKm, 10)
          : undefined,
        startingReferenceReadingKm: data.startingReferenceReadingKm
          ? parseInt(data.startingReferenceReadingKm, 10)
          : undefined,
        intervalType: data.intervalType,
        startReferenceDate: data.startReferenceDate
          ? new Date(`${data.startReferenceDate}T00:00:00.000Z`)
          : undefined,
      },
    });

    return {
      id: schedule.id,
      vehicleId: schedule.vehicleId,
      title: schedule.title,
      status: schedule.status,
      date: schedule.createdAt.toISOString().slice(0, 10),
      assignedMechanic: schedule.assignedMechanic,
      assignedDriver: schedule.assignedMechanic,
      accountType: schedule.accountType ?? null,
      checklistTemplateId: schedule.checklistTemplateId ?? null,
      garageId: schedule.garageId ?? null,
      odometerReading: schedule.odometerReading?.toString() ?? null,
      triggerType: schedule.triggerType ?? null,
      intervalKm: schedule.intervalKm?.toString() ?? null,
      bufferDistanceKm: schedule.bufferDistanceKm?.toString() ?? null,
      startingReferenceReadingKm:
        schedule.startingReferenceReadingKm?.toString() ?? null,
      intervalType: schedule.intervalType ?? null,
      startReferenceDate: schedule.startReferenceDate
        ? schedule.startReferenceDate.toISOString().slice(0, 10)
        : null,
      previousScheduleId: schedule.previousScheduleId ?? null,
      workOrderProgress: schedule.workOrderProgress ?? null,
    };
  }

  async update(id: string, data: CreateMaintenanceScheduleDto) {
    const schedule = await this.prisma.$transaction(async (tx) => {
      const previous = await tx.maintenanceSchedule.findUniqueOrThrow({
        where: { id },
      });

      const updated = await tx.maintenanceSchedule.update({
        where: { id },
        data: {
          vehicleId: data.vehicleId,
          title: data.title,
          status: data.status ?? MaintenanceStatus.PENDING,
          assignedMechanic: this.getAssignedMechanic(data),
          accountType: data.accountType ?? data.account_type,
          checklistTemplateId: data.checklistTemplateId,
          garageId: data.garageId,
          odometerReading: data.odometerReading
            ? parseInt(data.odometerReading, 10)
            : undefined,
          triggerType: data.triggerType,
          intervalKm: data.intervalKm ? parseInt(data.intervalKm, 10) : undefined,
          bufferDistanceKm: data.bufferDistanceKm
            ? parseInt(data.bufferDistanceKm, 10)
            : undefined,
          startingReferenceReadingKm: data.startingReferenceReadingKm
            ? parseInt(data.startingReferenceReadingKm, 10)
            : undefined,
          intervalType: data.intervalType,
          startReferenceDate: data.startReferenceDate
            ? new Date(`${data.startReferenceDate}T00:00:00.000Z`)
            : undefined,
        },
      });

      const justCompleted =
        this.isCompleted(updated.status) && !this.isCompleted(previous.status);

      if (justCompleted) {
        await this.syncCompletedOdometer(tx, updated);
        await this.createNextRecurringSchedule(tx, updated);
      }

      return updated;
    });

    // Sync vehicle status based on the new schedule status
    if (data.vehicleId && data.status) {
      await this.syncVehicleStatus(data.vehicleId, data.status);
    }

    return {
      id: schedule.id,
      vehicleId: schedule.vehicleId,
      title: schedule.title,
      status: schedule.status,
      date: schedule.createdAt.toISOString().slice(0, 10),
      assignedMechanic: schedule.assignedMechanic,
      assignedDriver: schedule.assignedMechanic,
      accountType: schedule.accountType ?? null,
      checklistTemplateId: schedule.checklistTemplateId ?? null,
      garageId: schedule.garageId ?? null,
      odometerReading: schedule.odometerReading?.toString() ?? null,
      triggerType: schedule.triggerType ?? null,
      intervalKm: schedule.intervalKm?.toString() ?? null,
      bufferDistanceKm: schedule.bufferDistanceKm?.toString() ?? null,
      startingReferenceReadingKm:
        schedule.startingReferenceReadingKm?.toString() ?? null,
      intervalType: schedule.intervalType ?? null,
      startReferenceDate: schedule.startReferenceDate
        ? schedule.startReferenceDate.toISOString().slice(0, 10)
        : null,
      previousScheduleId: schedule.previousScheduleId ?? null,
      workOrderProgress: schedule.workOrderProgress ?? null,
    };
  }

  async updateProgress(id: string, progress: unknown) {
    const schedule = await this.prisma.maintenanceSchedule.update({
      where: { id },
      data: {
        workOrderProgress: progress as Prisma.InputJsonValue,
      },
    });

    return {
      id: schedule.id,
      workOrderProgress: schedule.workOrderProgress ?? null,
    };
  }

  async remove(id: string) {
    await this.prisma.maintenanceSchedule.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return { success: true };
  }

  // ── Private helper: sync Vehicle.status based on maintenance schedule status ──
  //
  // MaintenanceSchedule.vehicleId stores the plate number (VarChar), not a UUID.
  // We resolve the Vehicle record via plateNumber and update its status so that
  // BMS correctly blocks booking when a vehicle is under maintenance.

  private async syncVehicleStatus(
    plateNumber: string,
    scheduleStatus: MaintenanceStatus,
  ): Promise<void> {
    const vehicle = await this.prisma.vehicle.findFirst({
      where: { plateNumber, deletedAt: null },
    });

    if (!vehicle) {
      this.logger.warn(
        `Vehicle with plate "${plateNumber}" not found — skipping status sync`,
      );
      return;
    }

    let newStatus: VehicleStatus | null = null;

    if (scheduleStatus === MaintenanceStatus.IN_PROGRESS) {
      newStatus = VehicleStatus.UNDER_MAINTENANCE;
    } else if (
      scheduleStatus === MaintenanceStatus.COMPLETED ||
      scheduleStatus === MaintenanceStatus.CANCELLED
    ) {
      newStatus = VehicleStatus.AVAILABLE;
    }

    if (newStatus && vehicle.status !== newStatus) {
      await this.prisma.vehicle.update({
        where: { id: vehicle.id },
        data: { status: newStatus },
      });
      this.logger.log(
        `Vehicle ${plateNumber} status synced: ${vehicle.status} → ${newStatus} (schedule ${scheduleStatus})`,
      );
    }
  }

  private isCompleted(status: MaintenanceStatus): boolean {
    return status === MaintenanceStatus.COMPLETED;
  }

  private formatDateOnly(value: Date | string | null): string | null {
    if (value == null) return null;
    return value instanceof Date
      ? value.toISOString().slice(0, 10)
      : String(value).slice(0, 10);
  }

  private async getMaintenanceScheduleColumns(): Promise<Set<string>> {
    const rows = await this.prisma.$queryRaw<
      { column_name: string }[]
    >`SELECT column_name FROM information_schema.columns WHERE table_name = 'maintenance_schedules'`;

    return new Set(rows.map((row) => row.column_name));
  }

  private getAssignedMechanic(data: CreateMaintenanceScheduleDto): string {
    const assignedMechanic = data.assignedMechanic ?? data.assignedDriver;

    if (!assignedMechanic?.trim()) {
      throw new BadRequestException('assignedMechanic is required');
    }

    return assignedMechanic;
  }

  private async syncCompletedOdometer(
    tx: Prisma.TransactionClient,
    schedule: {
      vehicleId: string;
      odometerReading: number | null;
    },
  ): Promise<void> {
    if (schedule.odometerReading == null) return;

    await tx.vehicle.updateMany({
      where: {
        plateNumber: schedule.vehicleId,
        odometer: { lt: schedule.odometerReading },
      },
      data: { odometer: schedule.odometerReading },
    });
  }

  private async createNextRecurringSchedule(
    tx: Prisma.TransactionClient,
    schedule: MaintenanceSchedule,
  ): Promise<void> {
    const odometerRecurring =
      schedule.triggerType === MaintenanceTriggerType.ODOMETER &&
      schedule.intervalKm != null &&
      schedule.intervalKm > 0;
    const timeRecurring =
      schedule.triggerType === MaintenanceTriggerType.TIME &&
      Boolean(schedule.intervalType);

    if (!odometerRecurring && !timeRecurring) return;

    const nextOdometer = schedule.odometerReading;
    const nextDate = this.advanceScheduleDate(
      schedule.startReferenceDate ?? schedule.createdAt,
      schedule.intervalType,
    );

    await tx.maintenanceSchedule.upsert({
      where: { previousScheduleId: schedule.id },
      update: {},
      create: {
        vehicleId: schedule.vehicleId,
        title: schedule.title,
        garageId: schedule.garageId,
        status: MaintenanceStatus.PENDING,
        assignedMechanic: schedule.assignedMechanic,
        accountType: schedule.accountType,
        checklistTemplateId: schedule.checklistTemplateId,
        odometerReading: nextOdometer,
        triggerType: schedule.triggerType,
        intervalKm: schedule.intervalKm,
        bufferDistanceKm: schedule.bufferDistanceKm,
        startingReferenceReadingKm: schedule.odometerReading,
        intervalType: schedule.intervalType,
        startReferenceDate: timeRecurring ? nextDate : null,
        previousScheduleId: schedule.id,
      },
    });
  }

  private advanceScheduleDate(
    date: Date,
    intervalType: MaintenanceIntervalType | null,
  ): Date {
    const next = new Date(date);

    switch (intervalType) {
      case MaintenanceIntervalType.DAILY:
        next.setUTCDate(next.getUTCDate() + 1);
        break;
      case MaintenanceIntervalType.WEEKLY:
        next.setUTCDate(next.getUTCDate() + 7);
        break;
      case MaintenanceIntervalType.QUARTERLY:
        next.setUTCMonth(next.getUTCMonth() + 3);
        break;
      case MaintenanceIntervalType.SEMI_ANNUALLY:
        next.setUTCMonth(next.getUTCMonth() + 6);
        break;
      case MaintenanceIntervalType.ANNUALLY:
        next.setUTCFullYear(next.getUTCFullYear() + 1);
        break;
      case MaintenanceIntervalType.MONTHLY:
        next.setUTCMonth(next.getUTCMonth() + 1);
        break;
    }

    return next;
  }
}
