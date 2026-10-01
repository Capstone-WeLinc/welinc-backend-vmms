import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  AccountType,
  MaintenanceSchedule,
  MaintenanceStatus,
  MaintenanceTriggerType,
  Prisma,
  VehicleStatus,
} from '@prisma/client';
import { PrismaService } from '../../../shared/prisma.service';
import { applyWorkOrderWorkflow, AssignedChecklistItem } from './work-order-workflow';
import { scheduleScope, ScheduleActor } from './schedule-access';
import { CreateMaintenanceScheduleDto } from './dto/create-maintenance-schedule.dto';
import { scheduleDue } from './schedule-due';
import { validateStartDate } from './schedule-start-date';
import { validateScheduleMileage } from './schedule-mileage';
import { validateTimeSchedule, getTimeInterval } from './time-interval';
import { createReadStream } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { extname, join, resolve } from 'node:path';

type WorkOrderUploadFile = { originalname: string; mimetype: string; size: number; buffer: Buffer };

@Injectable()
export class MaintenanceSchedulesService {
  private readonly logger = new Logger(MaintenanceSchedulesService.name);

  constructor(private readonly prisma: PrismaService) {}

  private readonly attachmentMimeTypes: Record<string, string> = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4',
    '.pdf': 'application/pdf', '.txt': 'text/plain',
  };

  private async getAttachmentSchedule(id: string, actor: ScheduleActor) {
    const scope = scheduleScope(actor);
    const schedule = await this.prisma.maintenanceSchedule.findFirst({
      where: { id, deletedAt: null, ...scope },
    });
    if (!schedule) throw new NotFoundException('Work order not found.');
    return schedule;
  }

  private assertAssignedMechanic(schedule: MaintenanceSchedule, actor: ScheduleActor) {
    if (schedule.assignedMechanicId !== actor.sub) {
      throw new ForbiddenException('Only the assigned mechanic can manage work order attachments.');
    }
  }

  async uploadAttachment(id: string, itemId: string, file: WorkOrderUploadFile | undefined, actor: ScheduleActor) {
    if (!file) throw new BadRequestException('Choose a supported file no larger than 5 MB.');
    if (!itemId?.trim()) throw new BadRequestException('A checklist item is required.');
    const schedule = await this.getAttachmentSchedule(id, actor);
    this.assertAssignedMechanic(schedule, actor);
    const progress = this.asProgressRecord(schedule.workOrderProgress);
    const execution = Array.isArray(progress.executionItems) ? progress.executionItems : [];
    const changed = execution.some((raw) => {
      const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      return item.id === itemId && item.status === 'changed';
    });
    if (!changed) throw new BadRequestException('Attachments can only be added to checklist items marked Changed.');

    const extension = extname(file.originalname).toLowerCase();
    const contentType = this.attachmentMimeTypes[extension];
    if (!contentType) throw new BadRequestException('Unsupported attachment type.');
    const attachmentId = randomUUID();
    const storageName = `${attachmentId}${extension}`;
    const directory = resolve('private-uploads', 'work-orders', id);
    const filePath = join(directory, storageName);
    await mkdir(directory, { recursive: true });
    await writeFile(filePath, file.buffer, { flag: 'wx' });

    try {
      const partDetails = progress.partDetails && typeof progress.partDetails === 'object'
        ? progress.partDetails as Record<string, unknown> : {};
      const rawEntry = partDetails[itemId];
      const entry = rawEntry && typeof rawEntry === 'object'
        ? rawEntry as Record<string, unknown> : {};
      const attachments = Array.isArray(entry.attachments) ? entry.attachments : [];
      const retainedAttachments = attachments.filter((candidate) => {
        if (typeof candidate === 'string') return candidate.toLowerCase() !== file.originalname.toLowerCase();
        if (!candidate || typeof candidate !== 'object') return true;
        const previous = candidate as Record<string, unknown>;
        return !(typeof previous.name === 'string' && previous.name.toLowerCase() === file.originalname.toLowerCase() && !previous.storageName);
      });
      if (retainedAttachments.length >= 5) throw new BadRequestException('A checklist item can have at most 5 attachments.');
      const attachment = {
        id: attachmentId,
        name: file.originalname,
        sizeMb: Number((file.size / (1024 * 1024)).toFixed(2)),
        contentType,
        storageName,
      };
      const nextProgress = {
        ...progress,
        partDetails: { ...partDetails, [itemId]: { ...entry, attachments: [...retainedAttachments, attachment] } },
      } as Prisma.InputJsonObject;
      await this.prisma.maintenanceSchedule.update({
        where: { id: schedule.id, updatedAt: schedule.updatedAt },
        data: { workOrderProgress: nextProgress },
      });
      return { ...attachment, url: `/maintenance-schedules/${id}/attachments/${attachmentId}` };
    } catch (error) {
      await unlink(filePath).catch(() => undefined);
      throw error;
    }
  }

  async getAttachment(id: string, attachmentId: string, actor: ScheduleActor) {
    const schedule = await this.getAttachmentSchedule(id, actor);
    const progress = this.asProgressRecord(schedule.workOrderProgress);
    const partDetails = progress.partDetails && typeof progress.partDetails === 'object'
      ? progress.partDetails as Record<string, unknown> : {};
    for (const rawEntry of Object.values(partDetails)) {
      const entry = rawEntry && typeof rawEntry === 'object' ? rawEntry as Record<string, unknown> : {};
      const attachments = Array.isArray(entry.attachments) ? entry.attachments : [];
      const rawAttachment = attachments.find((candidate) => candidate && typeof candidate === 'object' && (candidate as Record<string, unknown>).id === attachmentId);
      if (!rawAttachment) continue;
      const attachment = rawAttachment as Record<string, unknown>;
      const storageName = typeof attachment.storageName === 'string' ? attachment.storageName : '';
      const extension = extname(storageName).toLowerCase();
      if (!storageName || storageName !== `${attachmentId}${extension}` || !this.attachmentMimeTypes[extension]) {
        throw new NotFoundException('Attachment not found.');
      }
      return {
        name: typeof attachment.name === 'string' ? attachment.name : 'attachment',
        contentType: this.attachmentMimeTypes[extension],
        stream: createReadStream(join(resolve('private-uploads', 'work-orders', id), storageName)),
      };
    }
    throw new NotFoundException('Attachment not found.');
  }

  async deleteAttachment(id: string, attachmentId: string, actor: ScheduleActor) {
    const schedule = await this.getAttachmentSchedule(id, actor);
    this.assertAssignedMechanic(schedule, actor);
    const progress = this.asProgressRecord(schedule.workOrderProgress);
    const partDetails = progress.partDetails && typeof progress.partDetails === 'object'
      ? progress.partDetails as Record<string, unknown> : {};
    let storageName: string | null = null;
    const nextPartDetails: Record<string, unknown> = {};
    for (const [itemId, rawEntry] of Object.entries(partDetails)) {
      const entry = rawEntry && typeof rawEntry === 'object' ? rawEntry as Record<string, unknown> : {};
      const attachments = Array.isArray(entry.attachments) ? entry.attachments : [];
      const removed = attachments.find((candidate) => candidate && typeof candidate === 'object' && (candidate as Record<string, unknown>).id === attachmentId);
      if (removed) storageName = typeof (removed as Record<string, unknown>).storageName === 'string' ? (removed as Record<string, unknown>).storageName as string : null;
      nextPartDetails[itemId] = { ...entry, attachments: attachments.filter((candidate) => !candidate || typeof candidate !== 'object' || (candidate as Record<string, unknown>).id !== attachmentId) };
    }
    if (!storageName) throw new NotFoundException('Attachment not found.');
    await this.prisma.maintenanceSchedule.update({
      where: { id: schedule.id, updatedAt: schedule.updatedAt },
      data: { workOrderProgress: { ...progress, partDetails: nextPartDetails } as Prisma.InputJsonObject },
    });
    const extension = extname(storageName).toLowerCase();
    if (storageName === `${attachmentId}${extension}` && this.attachmentMimeTypes[extension]) {
      await unlink(join(resolve('private-uploads', 'work-orders', id), storageName)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    return { success: true };
  }

  private asProgressRecord(value: Prisma.JsonValue | null): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : {};
  }

  private async resolveMileage(db: Pick<Prisma.TransactionClient, 'vehicle'>, data: CreateMaintenanceScheduleDto, previous?: MaintenanceSchedule) {
    const vehicle = (data.triggerType ?? previous?.triggerType) === MaintenanceTriggerType.ODOMETER
      ? await db.vehicle.findFirst({ where: { plateNumber: { equals: data.vehicleId.trim(), mode: 'insensitive' }, deletedAt: null, isActive: true }, select: { odometer: true } })
      : null;
    return validateScheduleMileage(data, previous, vehicle?.odometer);
  }

  private async resolveChecklistTemplate(
    db: Pick<Prisma.TransactionClient, 'checklistTemplate'>,
    data: CreateMaintenanceScheduleDto,
    previous?: MaintenanceSchedule,
  ) {
    const title = data.title.trim();
    const requestedId = data.checklistTemplateId ??
      (previous?.title.trim().toLowerCase() === title.toLowerCase() ? previous.checklistTemplateId : undefined);
    const templates = await db.checklistTemplate.findMany({
      where: {
        ...(requestedId ? { id: requestedId } : { type: { equals: title, mode: 'insensitive' as const } }),
        deletedAt: null,
      },
      select: { id: true, type: true, items: { where: { deletedAt: null }, select: { id: true }, take: 1 } },
      take: 2,
    });
    if (templates.length !== 1 || templates[0].type.trim().toLowerCase() !== title.toLowerCase()) {
      throw new BadRequestException('Select one active checklist template matching the maintenance type. Refresh the templates and try again.');
    }
    const template = templates[0];
    if (!template.items.length) throw new BadRequestException('The selected checklist template has no active items.');
    if (previous && ['IN_PROGRESS', 'DONE'].includes(previous.status) && template.id !== previous.checklistTemplateId) {
      throw new BadRequestException('The assigned checklist cannot be changed after work has started.');
    }
    return { checklistTemplateId: template.id, title: template.type };
  }

  // title is the maintenance type selected from checklist templates in the UI.
  // Keep this comparison identical to the partial unique index in the migration.
  private async assertNoPendingDuplicate(
    db: Pick<Prisma.TransactionClient, '$queryRaw'>,
    data: Pick<CreateMaintenanceScheduleDto, 'vehicleId' | 'title' | 'status'>,
    excludeId?: string,
  ) {
    if ((data.status ?? MaintenanceStatus.PENDING) !== MaintenanceStatus.PENDING) return;
    const duplicates = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT id FROM maintenance_schedules
      WHERE status = 'PENDING' AND deleted_at IS NULL
        AND LOWER(BTRIM("vehicleId")) = LOWER(BTRIM(${data.vehicleId}))
        AND LOWER(BTRIM(title)) = LOWER(BTRIM(${data.title}))
        ${excludeId ? Prisma.sql`AND id <> ${excludeId}::uuid` : Prisma.empty}
      LIMIT 1
    `);
    if (duplicates.length) {
      throw new ConflictException('A pending schedule of this type already exists for this truck');
    }
  }

  private async handleScheduleWriteConflict(
    error: unknown,
    data: CreateMaintenanceScheduleDto,
    excludeId?: string,
  ): Promise<never> {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      throw new ConflictException('The schedule changed. Refresh before updating.');
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      // Recheck outside the failed transaction, including a competing insert
      // committed after our precheck. Unrelated unique errors retain their cause.
      await this.assertNoPendingDuplicate(this.prisma, data, excludeId);
    }
    throw error;
  }

  async findAll(actor?: ScheduleActor) {
    const scope = actor ? scheduleScope(actor) : {};
    try {
      const schedules = await this.prisma.maintenanceSchedule.findMany({
        where: { deletedAt: null, ...scope },
        orderBy: { createdAt: 'desc' },
        include: { cancellations: { orderBy: { createdAt: 'desc' } } },
      });

      return schedules.map((schedule) => {
        const costs = this.normalizeCostPayload({
          partsCost: schedule.partsCost,
          laborCost: schedule.laborCost,
          totalCost: schedule.totalCost,
        });

        return {
          id: schedule.id,
          workOrderNumber: schedule.workOrderNumber,
          vehicleId: schedule.vehicleId,
          title: schedule.title,
          status: schedule.status,
          cancellations: schedule.cancellations ?? [],
          ...scheduleDue(schedule),
          date: this.formatDateOnly(schedule.createdAt),
          startDate: this.formatDateOnly(schedule.startDate),
          assignedMechanic: schedule.assignedMechanic,
          assignedMechanicId: schedule.assignedMechanicId,
          assignedDriver: schedule.assignedMechanic,
          chiefMechanicId: schedule.chiefMechanicId ?? null,
          chiefMechanic: schedule.chiefMechanic ?? null,
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
          timeIntervalValue: schedule.timeIntervalValue ?? null,
          timeIntervalUnit: schedule.timeIntervalUnit ?? null,
          startReferenceDate: this.formatDateOnly(schedule.startReferenceDate),
          previousScheduleId: schedule.previousScheduleId ?? null,
          workOrderProgress: schedule.workOrderProgress ?? null,
          partsCost: costs.partsCost,
          laborCost: costs.laborCost,
          totalCost: costs.totalCost,
        };
      });
    } catch (err) {
      // Fail closed: never fall back to an unscoped mobile query.
      if (Object.keys(scope).length) throw err;
      // If the database schema is missing columns (e.g. during development), fall
      // back to a resilient raw query selecting a minimal set of columns. This
      // prevents the entire endpoint from returning 500 due to schema drift.
      console.error('Prisma findMany failed, falling back to raw query', err);

      type RawScheduleRow = {
        id: string;
        work_order_number?: string | null;
        vehicleId: string | null;
        title: string | null;
        status: string | null;
        created_at: Date | string | null;
        start_date?: Date | string | null;
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
        parts_cost?: number | null;
        labor_cost?: number | null;
        total_cost?: number | null;
      };

      const columns = await this.getMaintenanceScheduleColumns();
      const createdDateColumn = columns.has('created_at')
        ? 'created_at'
        : columns.has('scheduled_date')
          ? 'scheduled_date'
          : null;
      const optionalColumn = (column: string) =>
        columns.has(column) ? column : 'NULL';
      const dateOrder = createdDateColumn ?? 'id';
      const whereClause = columns.has('deleted_at') ? 'WHERE deleted_at IS NULL' : '';
      const rows = await this.prisma.$queryRawUnsafe<RawScheduleRow[]>(
        `SELECT id, ${optionalColumn('work_order_number')} AS work_order_number, ${optionalColumn('vehicle_id')} AS vehicleId, title, status, ${optionalColumn('created_at')} AS created_at, ${optionalColumn('start_date')} AS start_date, ${optionalColumn('scheduled_date')} AS scheduled_date, assigned_mechanic, account_type, checklist_template_id, ${optionalColumn('garage_id')} AS garage_id, odometer_reading, trigger_type, ${optionalColumn('interval_km')} AS interval_km, ${optionalColumn('buffer_distance_km')} AS buffer_distance_km, ${optionalColumn('starting_reference_reading_km')} AS starting_reference_reading_km, ${optionalColumn('interval_type')} AS interval_type, ${optionalColumn('start_reference_date')} AS start_reference_date, ${optionalColumn('previous_schedule_id')} AS previous_schedule_id, ${optionalColumn('work_order_progress')} AS work_order_progress, ${optionalColumn('parts_cost')} AS parts_cost, ${optionalColumn('labor_cost')} AS labor_cost, ${optionalColumn('total_cost')} AS total_cost FROM maintenance_schedules ${whereClause} ORDER BY ${dateOrder} DESC`,
      );

      return rows.map((r) => {
        const costs = this.normalizeCostPayload({
          partsCost: r.parts_cost,
          laborCost: r.labor_cost,
          totalCost: r.total_cost,
        });

        return {
          id: String(r.id),
          workOrderNumber: r.work_order_number ?? null,
          vehicleId: r.vehicleId ?? '',
          title: r.title ?? '',
          status: r.status ?? MaintenanceStatus.PENDING,
          date: this.formatDateOnly(r.created_at ?? r.scheduled_date ?? null),
          startDate: this.formatDateOnly(r.start_date ?? null),
          assignedMechanic: r.assigned_mechanic ?? null,
          assignedDriver: r.assigned_mechanic ?? null,
          chiefMechanicId: (r as any).chief_mechanic_id ?? null,
          chiefMechanic: (r as any).chief_mechanic ?? null,
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
          partsCost: costs.partsCost,
          laborCost: costs.laborCost,
          totalCost: costs.totalCost,
        };
      });
    }
  }

  async create(data: CreateMaintenanceScheduleDto) {
    if (data.status === 'CANCELLED') throw new BadRequestException('Create a pending schedule before cancelling it with a reason.');
    if (data.status === 'COMPLETED' || data.status === 'DONE' || data.status === 'IN_PROGRESS' || data.workOrderProgress != null || data.work_order_progress != null) throw new ForbiddenException('Use the assigned work order workflow to start, submit or complete work.');
    const startDate = validateStartDate(data.startDate);
    const time = validateTimeSchedule(data);
    await this.assertNoPendingDuplicate(this.prisma, data);
    const checklist = await this.resolveChecklistTemplate(this.prisma, data);
    const workOrderProgress = this.normalizeWorkOrderProgress(
      data.workOrderProgress ?? data.work_order_progress,
    );
    const normalizedCosts = this.normalizeCostPayload({
      partsCost: data.partsCost ?? data.parts_cost,
      laborCost: data.laborCost ?? data.labor_cost,
      totalCost: data.totalCost ?? data.total_cost,
    });
    const { chiefMechanicId, chiefMechanic } = await this.resolveChiefMechanic(data);

    const schedule = await this.prisma.$transaction(async (tx) => {
      const mileage = await this.resolveMileage(tx, data);
      return tx.maintenanceSchedule.create({
      data: {
        vehicleId: data.vehicleId,
        startDate,
        status: data.status ?? MaintenanceStatus.PENDING,
        ...await this.resolveAssignedMechanic(data),
        chiefMechanicId,
        chiefMechanic,
        accountType: data.accountType ?? data.account_type,
        ...checklist,
        garageId: data.garageId,
        ...mileage,
        triggerType: data.triggerType,
        intervalType: data.intervalType,
        startReferenceDate: data.startReferenceDate
          ? new Date(`${data.startReferenceDate}T00:00:00.000Z`)
          : undefined,
        ...time,
        ...(workOrderProgress !== undefined
          ? { workOrderProgress }
          : {}),
        partsCost: normalizedCosts.partsCost ?? undefined,
        laborCost: normalizedCosts.laborCost ?? undefined,
        totalCost: normalizedCosts.totalCost ?? undefined,
      },
      });
    }).catch((error: unknown) => this.handleScheduleWriteConflict(error, data));

    const costs = this.normalizeCostPayload({
      partsCost: schedule.partsCost,
      laborCost: schedule.laborCost,
      totalCost: schedule.totalCost,
    });

    return {
      id: schedule.id,
      workOrderNumber: schedule.workOrderNumber,
      vehicleId: schedule.vehicleId,
      title: schedule.title,
      status: schedule.status,
      date: schedule.createdAt.toISOString().slice(0, 10),
      startDate: this.formatDateOnly(schedule.startDate),
      assignedMechanic: schedule.assignedMechanic,
          assignedMechanicId: schedule.assignedMechanicId,
      assignedDriver: schedule.assignedMechanic,
      chiefMechanicId: schedule.chiefMechanicId ?? null,
      chiefMechanic: schedule.chiefMechanic ?? null,
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
      timeIntervalValue: schedule.timeIntervalValue ?? null,
      timeIntervalUnit: schedule.timeIntervalUnit ?? null,
      startReferenceDate: schedule.startReferenceDate
        ? schedule.startReferenceDate.toISOString().slice(0, 10)
        : null,
      previousScheduleId: schedule.previousScheduleId ?? null,
      workOrderProgress: schedule.workOrderProgress ?? null,
      partsCost: costs.partsCost,
      laborCost: costs.laborCost,
      totalCost: costs.totalCost,
    };
  }

  async update(id: string, data: CreateMaintenanceScheduleDto) {
    if (data.status === 'CANCELLED') throw new BadRequestException('Use the cancellation endpoint and provide a reason.');
    if (data.status === 'COMPLETED' || data.status === 'DONE') throw new ForbiddenException('Use the assigned work order workflow to submit or complete work.');
    const workOrderProgress = this.normalizeWorkOrderProgress(
      data.workOrderProgress ?? data.work_order_progress,
    );
    const normalizedCosts = this.normalizeCostPayload({
      partsCost: data.partsCost ?? data.parts_cost,
      laborCost: data.laborCost ?? data.labor_cost,
      totalCost: data.totalCost ?? data.total_cost,
    });
    const { chiefMechanicId, chiefMechanic } = await this.resolveChiefMechanic(data);

    const schedule = await this.prisma.$transaction(async (tx) => {
      const previous = await tx.maintenanceSchedule.findUniqueOrThrow({
        where: { id },
      });

      if (previous.status === 'COMPLETED') throw new ForbiddenException('Completed work orders are closed.');
      if (['IN_PROGRESS', 'DONE'].includes(previous.status) && data.status !== previous.status) {
        throw new BadRequestException('Started work cannot return to pending scheduling. Use the assigned work order workflow.');
      }
      if (workOrderProgress !== undefined && JSON.stringify(workOrderProgress) !== JSON.stringify(previous.workOrderProgress)) throw new ForbiddenException('Use the assigned work order progress endpoint.');
      if (data.status === 'IN_PROGRESS' && previous.status !== 'IN_PROGRESS') throw new ForbiddenException('Only the assigned mechanic can start work.');
      const startDate = validateStartDate(data.startDate, previous.startDate);
      if (['IN_PROGRESS', 'DONE'].includes(previous.status) && startDate.getTime() !== previous.startDate?.getTime()) {
        throw new BadRequestException('The schedule start date cannot change after work has started.');
      }
      await this.assertNoPendingDuplicate(tx, data, id);
      const checklist = await this.resolveChecklistTemplate(tx, data, previous);
      const mileage = await this.resolveMileage(tx, data, previous);
      const time = validateTimeSchedule(data, previous);
      const updated = await tx.maintenanceSchedule.update({
        where: { id, status: previous.status, updatedAt: previous.updatedAt },
        data: {
          vehicleId: data.vehicleId,
          startDate,
          status: data.status ?? MaintenanceStatus.PENDING,
          ...await this.resolveAssignedMechanic(data),
          chiefMechanicId: chiefMechanicId ?? previous.chiefMechanicId,
          chiefMechanic: chiefMechanic ?? previous.chiefMechanic,
          accountType: data.accountType ?? data.account_type,
          ...checklist,
          garageId: data.garageId,
          ...mileage,
          triggerType: data.triggerType,
          intervalType: data.intervalType,
          startReferenceDate: data.startReferenceDate
            ? new Date(`${data.startReferenceDate}T00:00:00.000Z`)
            : undefined,
          ...time,
          ...(workOrderProgress !== undefined ? { workOrderProgress } : {}),
          partsCost: normalizedCosts.partsCost ?? undefined,
          laborCost: normalizedCosts.laborCost ?? undefined,
          totalCost: normalizedCosts.totalCost ?? undefined,
        },
      });

      const justCompleted =
        this.isCompleted(updated.status) && !this.isCompleted(previous.status);

      if (justCompleted) {
        await this.syncCompletedOdometer(tx, updated);
        await this.createNextRecurringSchedule(tx, updated);
      }

      return updated;
    }).catch((error: unknown) => this.handleScheduleWriteConflict(error, data, id));

    // Sync vehicle status based on the new schedule status
    if (data.vehicleId && data.status) {
      await this.syncVehicleStatus(data.vehicleId, data.status);
    }

    const costs = this.normalizeCostPayload({
      partsCost: schedule.partsCost,
      laborCost: schedule.laborCost,
      totalCost: schedule.totalCost,
    });

    return {
      id: schedule.id,
      workOrderNumber: schedule.workOrderNumber,
      vehicleId: schedule.vehicleId,
      title: schedule.title,
      status: schedule.status,
      date: this.formatDateOnly(schedule.createdAt),
      startDate: this.formatDateOnly(schedule.startDate),
      assignedMechanic: schedule.assignedMechanic,
          assignedMechanicId: schedule.assignedMechanicId,
      assignedDriver: schedule.assignedMechanic,
      chiefMechanicId: schedule.chiefMechanicId ?? null,
      chiefMechanic: schedule.chiefMechanic ?? null,
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
      timeIntervalValue: schedule.timeIntervalValue ?? null,
      timeIntervalUnit: schedule.timeIntervalUnit ?? null,
      startReferenceDate: this.formatDateOnly(schedule.startReferenceDate),
      previousScheduleId: schedule.previousScheduleId ?? null,
      workOrderProgress: schedule.workOrderProgress ?? null,
      partsCost: costs.partsCost,
      laborCost: costs.laborCost,
      totalCost: costs.totalCost,
    };
  }

  async cancel(id: string, reason: unknown, actor: ScheduleActor) {
    if (!actor?.sub || !actor.roles?.some((role) => role.system === 'VMMS' && role.role === 'OPERATIONS')) {
      throw new ForbiddenException('Only Operations can cancel a maintenance schedule.');
    }
    if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 2000) {
      throw new BadRequestException('A cancellation reason of 1 to 2000 characters is required.');
    }
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findFirst({
        where: { id: actor.sub, isActive: true, deletedAt: null, roles: { some: { role: 'OPERATIONS', system: 'VMMS' } } },
        select: { id: true, name: true, email: true },
      });
      if (!user) throw new ForbiddenException('An active VMMS Operations account is required.');
      const schedule = await tx.maintenanceSchedule.findFirst({ where: { id, deletedAt: null } });
      if (!schedule) throw new NotFoundException('Maintenance schedule not found.');
      if (['IN_PROGRESS', 'DONE', 'COMPLETED'].includes(schedule.status)) {
        throw new BadRequestException('Schedule cannot be cancelled once work has started. Use ‘Extension’ instead.');
      }
      if (!['PENDING', 'DUE', 'OVERDUE'].includes(schedule.status)) {
        throw new BadRequestException('This schedule has already been cancelled.');
      }
      const changed = await tx.maintenanceSchedule.updateMany({
        where: { id, status: schedule.status, updatedAt: schedule.updatedAt, deletedAt: null },
        data: { status: MaintenanceStatus.CANCELLED },
      });
      if (changed.count !== 1) throw new ConflictException('The schedule changed. Refresh before cancelling.');
      await tx.maintenanceScheduleCancellation.create({ data: {
        scheduleId: id, actorId: user.id, actorName: user.name, actorEmail: user.email,
        reason: reason.trim(), previousStatus: schedule.status,
      } });
      return {
        id, status: MaintenanceStatus.CANCELLED,
        cancellations: await tx.maintenanceScheduleCancellation.findMany({ where: { scheduleId: id }, orderBy: { createdAt: 'desc' } }),
      };
    });
  }

  async updateProgress(id: string, progress: any, actor: ScheduleActor) {
    const scope = scheduleScope(actor);
    const accessible = await this.prisma.maintenanceSchedule.findFirst({ where: { id, deletedAt: null, ...scope } });
    if (!accessible) throw new ForbiddenException('This work order is not assigned to you.');
    let input = this.getUpdateProgressPayload(progress);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BadRequestException('A work order progress object is required.');
    const storedProgress = this.asProgressRecord(accessible.workOrderProgress);
    const storedParts = storedProgress.partDetails && typeof storedProgress.partDetails === 'object'
      ? storedProgress.partDetails as Record<string, unknown> : {};
    const requestedProgress = input as Record<string, unknown>;
    const requestedParts = requestedProgress.partDetails && typeof requestedProgress.partDetails === 'object'
      ? requestedProgress.partDetails as Record<string, unknown> : {};
    let preserveAttachmentState = false;
    const mergedParts = { ...requestedParts };
    for (const [itemId, storedValue] of Object.entries(storedParts)) {
      const storedEntry = storedValue && typeof storedValue === 'object'
        ? storedValue as Record<string, unknown> : {};
      if (!Array.isArray(storedEntry.attachments)) continue;
      preserveAttachmentState = true;
      const requestedValue = requestedParts[itemId];
      const requestedEntry = requestedValue && typeof requestedValue === 'object'
        ? requestedValue as Record<string, unknown> : {};
      mergedParts[itemId] = { ...storedEntry, ...requestedEntry, attachments: storedEntry.attachments };
    }
    if (preserveAttachmentState) {
      input = { ...requestedProgress, partDetails: mergedParts } as Prisma.InputJsonObject;
    }
    const assignments: Record<string, unknown> = {
      assignedMechanicId: accessible.assignedMechanicId,
      assignedMechanic: accessible.assignedMechanic,
      assignedDriver: accessible.assignedMechanic,
      chiefMechanicId: accessible.chiefMechanicId,
      chief_mechanic_id: accessible.chiefMechanicId,
      chiefMechanic: accessible.chiefMechanic,
      chief_mechanic: accessible.chiefMechanic,
    };
    for (const source of [progress, input]) {
      if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
      for (const [field, current] of Object.entries(assignments)) {
        if (!(field in source)) continue;
        // Older mobile clients send an empty inspector display name. Ignore it;
        // it must never clear the assignment saved by Operations.
        if (field === 'chiefMechanic' && source[field] === '') continue;
        if (source[field] !== current) {
          throw new ForbiddenException('Only Operations can change mechanic assignments through schedule editing.');
        }
      }
    }
    let assignedItems: AssignedChecklistItem[] | undefined;
    if (progress.action === 'SUBMIT') {
      if (!accessible.checklistTemplateId) {
        throw new BadRequestException('No checklist is assigned. Ask Operations to assign a checklist before submitting.');
      }
      assignedItems = await this.prisma.checklistItem.findMany({
        where: { checklistTemplateId: accessible.checklistTemplateId, deletedAt: null },
        select: { id: true, text: true },
        orderBy: { order: 'asc' },
      });
    }
    const workflow = applyWorkOrderWorkflow(accessible, input as Record<string, any>, progress.action, actor, assignedItems);
    const normalizedProgress = workflow.progress as Prisma.InputJsonObject;
    const normalizedCosts = this.normalizeCostPayload({
      partsCost: progress.partsCost ?? progress.parts_cost,
      laborCost: progress.laborCost ?? progress.labor_cost,
      totalCost: progress.totalCost ?? progress.total_cost,
    });

    const payload: Record<string, any> = {
      status: workflow.status,
      ...(workflow.status === MaintenanceStatus.COMPLETED ? { completedAt: new Date() } : {}),
      partsCost: normalizedCosts.partsCost ?? undefined,
      laborCost: normalizedCosts.laborCost ?? undefined,
      totalCost: normalizedCosts.totalCost ?? undefined,
    };

    if (normalizedProgress !== undefined) {
      payload.workOrderProgress = {
        ...normalizedProgress,
        chiefMechanic: accessible.chiefMechanic ?? '',
      };
    }

    const { schedule, nextSchedule } = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.maintenanceSchedule.update({
        where: { id, deletedAt: null, updatedAt: accessible.updatedAt, AND: scope },
        data: payload,
      });
      let nextSchedule: MaintenanceSchedule | null = null;
      if (workflow.status === MaintenanceStatus.COMPLETED) {
        await this.syncCompletedOdometer(tx, updated);
        nextSchedule = await this.createNextRecurringSchedule(tx, updated);
      }
      return { schedule: updated, nextSchedule };
    }).catch((error: unknown) => this.handleScheduleWriteConflict(error, {
      vehicleId: accessible.vehicleId, title: accessible.title, status: MaintenanceStatus.PENDING,
    }, id));
    await this.syncVehicleStatus(schedule.vehicleId, schedule.status);

    const costs = this.normalizeCostPayload({
      partsCost: schedule.partsCost,
      laborCost: schedule.laborCost,
      totalCost: schedule.totalCost,
    });

    return {
      id: schedule.id,
      status: schedule.status,
      nextSchedule: nextSchedule ? { id: nextSchedule.id, ...scheduleDue(nextSchedule) } : null,
      workOrderProgress: schedule.workOrderProgress ?? null,
      partsCost: costs.partsCost,
      laborCost: costs.laborCost,
      totalCost: costs.totalCost,
    };
  }

  private getUpdateProgressPayload(progress: any): Prisma.InputJsonValue | undefined {
    if (progress == null) return undefined;

    const explicitProgress =
      progress.workOrderProgress ?? progress.work_order_progress;

    if (explicitProgress !== undefined) {
      return this.normalizeWorkOrderProgress(explicitProgress);
    }

    const costKeys = [
      'partsCost',
      'parts_cost',
      'laborCost',
      'labor_cost',
      'totalCost',
      'total_cost',
    ];

    const hasOnlyCostKeys =
      typeof progress === 'object' &&
      !Array.isArray(progress) &&
      Object.keys(progress).length > 0 &&
      Object.keys(progress).every((key) => costKeys.includes(key));

    if (Array.isArray(progress) || !hasOnlyCostKeys) {
      return this.normalizeWorkOrderProgress(progress);
    }

    return undefined;
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

    if (
      scheduleStatus === MaintenanceStatus.IN_PROGRESS ||
      scheduleStatus === MaintenanceStatus.DONE
    ) {
      newStatus = VehicleStatus.UNDER_MAINTENANCE;
    } else if (
      scheduleStatus === MaintenanceStatus.COMPLETED ||
      scheduleStatus === MaintenanceStatus.CANCELLED
    ) {
      newStatus = VehicleStatus.AVAILABLE;
    }

    if (newStatus && vehicle.status !== newStatus) {
      // Enforce repair precedence in the write, even if VRMS changes status
      // after the initial read. Do not update a concurrently archived vehicle.
      const result = await this.prisma.vehicle.updateMany({
        where: {
          id: vehicle.id,
          deletedAt: null,
          status: { not: VehicleStatus.UNDER_REPAIR },
        },
        data: { status: newStatus },
      });
      if (result.count === 0) return;
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

    const date = value instanceof Date ? value : new Date(value);

    if (Number.isNaN(date.getTime())) {
      return null;
    }

    const dateParts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Manila',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      dateParts.find((item) => item.type === type)?.value;
    const year = part('year');
    const month = part('month');
    const day = part('day');

    return year && month && day ? `${year}-${month}-${day}` : null;
  }

  private normalizeCostValue(value: unknown): number | null {
    if (value == null || value === '') {
      return null;
    }

    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }

    if (typeof value === 'string') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }

    if (typeof value === 'bigint') {
      return Number(value);
    }

    if (typeof value === 'object' && value !== null) {
      const maybeDecimal = value as {
        toNumber?: () => number;
        toJSON?: () => unknown;
        toString?: () => string;
      };

      if (typeof maybeDecimal.toNumber === 'function') {
        const parsed = maybeDecimal.toNumber();
        return Number.isFinite(parsed) ? parsed : null;
      }

      if (typeof maybeDecimal.toJSON === 'function') {
        const parsed = Number(maybeDecimal.toJSON());
        return Number.isFinite(parsed) ? parsed : null;
      }

      if (typeof maybeDecimal.toString === 'function') {
        const parsed = Number(maybeDecimal.toString());
        return Number.isFinite(parsed) ? parsed : null;
      }
    }

    return null;
  }

  private normalizeCostPayload(values: {
    partsCost?: unknown;
    laborCost?: unknown;
    totalCost?: unknown;
  }): { partsCost: number | null; laborCost: number | null; totalCost: number | null } {
    const partsCost = this.normalizeCostValue(values.partsCost);
    const laborCost = this.normalizeCostValue(values.laborCost);
    const totalCost =
      this.normalizeCostValue(values.totalCost) ??
      (partsCost != null && laborCost != null ? partsCost + laborCost : null);

    return { partsCost, laborCost, totalCost };
  }

  private normalizeWorkOrderProgress(
    progress: any,
  ): Prisma.InputJsonValue | undefined {
    if (progress == null) {
      return undefined;
    }

    const normalize = (value: any): any => {
      if (Array.isArray(value)) {
        return value.map(normalize);
      }
      if (value && typeof value === 'object') {
        return Object.fromEntries(
          Object.entries(value).map(([key, val]) => [
            key,
            key.match(/^(note|notes)$/i)
              ? val == null
                ? ''
                : normalize(val)
              : normalize(val),
          ]),
        );
      }
      return value;
    };

    return normalize(progress);
  }

  private async getMaintenanceScheduleColumns(): Promise<Set<string>> {
    const rows = await this.prisma.$queryRaw<
      { column_name: string }[]
    >`SELECT column_name FROM information_schema.columns WHERE table_name = 'maintenance_schedules'`;

    return new Set(rows.map((row) => row.column_name));
  }

  private async resolveAssignedMechanic(data: CreateMaintenanceScheduleDto) {
    const name = this.getAssignedMechanic(data).trim();
    if ((data.accountType ?? data.account_type) === AccountType.OUTSOURCED) {
      return { assignedMechanic: name, assignedMechanicId: null };
    }
    const users = await this.prisma.user.findMany({
      where: {
        ...(data.assignedMechanicId ? { id: data.assignedMechanicId } : { name: { equals: name, mode: 'insensitive' as const } }),
        deletedAt: null, isActive: true,
        roles: { some: { role: 'MECHANIC', system: 'VMMS' } },
      },
      select: { id: true, name: true }, take: 2,
    });
    if (users.length !== 1) throw new BadRequestException('Choose one active VMMS mechanic using assignedMechanicId; the name is missing or ambiguous.');
    return { assignedMechanic: users[0].name, assignedMechanicId: users[0].id };
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
  ): Promise<MaintenanceSchedule | null> {
    if (schedule.status !== MaintenanceStatus.COMPLETED || schedule.deletedAt) return null;

    const odometerRecurring =
      schedule.triggerType === MaintenanceTriggerType.ODOMETER;
    const timeRecurring =
      schedule.triggerType === MaintenanceTriggerType.TIME;

    if (!odometerRecurring && !timeRecurring) return null;

    const existing = await tx.maintenanceSchedule.findUnique({ where: { previousScheduleId: schedule.id } });
    if (existing) return existing;
    await this.assertNoPendingDuplicate(tx, { vehicleId: schedule.vehicleId, title: schedule.title });

    if (odometerRecurring && (!Number.isInteger(schedule.intervalKm) || schedule.intervalKm! <= 0)) {
      throw new BadRequestException('Configure a positive odometer interval before approving recurring maintenance.');
    }
    const vehicle = odometerRecurring ? await tx.vehicle.findFirst({
      where: { plateNumber: schedule.vehicleId, deletedAt: null }, select: { odometer: true },
    }) : null;
    const readings = [schedule.odometerReading, vehicle?.odometer]
      .filter((reading): reading is number => typeof reading === 'number' && Number.isInteger(reading) && reading >= 0);
    const nextOdometer = readings.length ? Math.max(...readings) : null;
    if (odometerRecurring && nextOdometer === null) {
      throw new BadRequestException('Record a current odometer reading before approving recurring maintenance.');
    }
    if (odometerRecurring) validateScheduleMileage({
      vehicleId: schedule.vehicleId, title: schedule.title, triggerType: MaintenanceTriggerType.ODOMETER,
      odometerReading: String(nextOdometer), startingReferenceReadingKm: String(nextOdometer), intervalKm: String(schedule.intervalKm),
    }, undefined, nextOdometer);

    // Date-only references use Philippine business days, like schedule events.
    // Store the cycle reference, not its due date: consumers add one interval.
    const completionDay = new Date(schedule.updatedAt.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
    const referenceDate = new Date(`${completionDay}T00:00:00.000Z`);
    const timeInterval = getTimeInterval(schedule) ?? { value: 3, unit: 'MONTHS' as const };
    const timeFields = timeRecurring ? validateTimeSchedule({
      vehicleId: schedule.vehicleId, title: schedule.title, triggerType: MaintenanceTriggerType.TIME,
      timeIntervalValue: timeInterval.value, timeIntervalUnit: timeInterval.unit, startReferenceDate: completionDay,
    }) : {};

    return tx.maintenanceSchedule.upsert({
      where: { previousScheduleId: schedule.id },
      update: {},
      create: {
        vehicleId: schedule.vehicleId,
        title: schedule.title,
        garageId: schedule.garageId,
        status: MaintenanceStatus.PENDING,
        assignedMechanic: schedule.assignedMechanic,
          assignedMechanicId: schedule.assignedMechanicId,
        chiefMechanicId: schedule.chiefMechanicId,
        chiefMechanic: schedule.chiefMechanic,
        accountType: schedule.accountType,
        checklistTemplateId: schedule.checklistTemplateId,
        odometerReading: nextOdometer,
        triggerType: schedule.triggerType,
        intervalKm: schedule.intervalKm,
        bufferDistanceKm: odometerRecurring ? (schedule.bufferDistanceKm ?? 0) : schedule.bufferDistanceKm,
        startingReferenceReadingKm: odometerRecurring ? nextOdometer : null,
        intervalType: schedule.intervalType,
        startReferenceDate: timeRecurring ? referenceDate : null,
        previousScheduleId: schedule.id,
        startDate: referenceDate,
        ...timeFields,
      },
    });
  }

  private async resolveChiefMechanic(data: CreateMaintenanceScheduleDto): Promise<{
    chiefMechanicId: string | null;
    chiefMechanic: string | null;
  }> {
    const rawId = data.chiefMechanicId ?? data.chief_mechanic_id;
    const rawName = data.chiefMechanic ?? data.chief_mechanic;

    if (rawId && rawId.trim()) {
      const user = await this.prisma.user.findFirst({
        where: { id: rawId, deletedAt: null },
        include: { roles: true },
      });

      if (!user) {
        throw new BadRequestException(`Chief Mechanic with ID ${rawId} was not found.`);
      }

      if (!user.isActive) {
        throw new BadRequestException(`Selected Chief Mechanic (${user.name}) is inactive.`);
      }

      const hasChiefMechanicRole = user.roles.some(
        (r) => (r.role as string) === 'CHIEF_MECHANIC',
      );

      if (!hasChiefMechanicRole) {
        throw new BadRequestException(
          `Selected user (${user.name}) does not have the Chief Mechanic role.`,
        );
      }

      return {
        chiefMechanicId: user.id,
        chiefMechanic: user.name,
      };
    }

    if (rawName && rawName.trim()) {
      const user = await this.prisma.user.findFirst({
        where: {
          OR: [{ name: rawName.trim() }, { email: rawName.trim() }],
          deletedAt: null,
        },
        include: { roles: true },
      });

      if (user && user.roles.some((r) => (r.role as string) === 'CHIEF_MECHANIC')) {
        return {
          chiefMechanicId: user.id,
          chiefMechanic: user.name,
        };
      }

      return {
        chiefMechanicId: null,
        chiefMechanic: rawName.trim(),
      };
    }

    return {
      chiefMechanicId: null,
      chiefMechanic: null,
    };
  }

}
