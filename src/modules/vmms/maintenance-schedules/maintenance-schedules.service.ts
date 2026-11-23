import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  AccountType,
  MaintenanceCancellationReviewStatus,
  MaintenanceScheduleExtensionAuditEventType,
  MaintenanceScheduleExtensionReviewStatus,
  MaintenanceSchedule,
  MaintenancePriority,
  MaintenanceScheduleRescheduleSource,
  MaintenanceStatus,
  MaintenanceTriggerType,
  Prisma,
  VehicleStatus,
} from '@prisma/client';
import { PrismaService } from '../../../shared/prisma.service';
import {
  BlobStorageService,
  StorageUnavailableException,
} from '../../../shared/blob-storage.service';
import {
  applyWorkOrderWorkflow,
  AssignedChecklistItem,
} from './work-order-workflow';
import { progressForClient, stateForStorage } from './work-order-state';
import { scheduleScope, ScheduleActor } from './schedule-access';
import { CreateMaintenanceScheduleDto } from './dto/create-maintenance-schedule.dto';
import { CreateMaintenanceScheduleExtensionDto } from './dto/create-maintenance-schedule-extension.dto';
import { UpdateMaintenanceLogDto } from './dto/update-maintenance-log.dto';
import { scheduleDue } from './schedule-due';
import { validateStartDate } from './schedule-start-date';
import { validateScheduleMileage } from './schedule-mileage';
import {
  validateTimeSchedule,
  getTimeInterval,
  addTimeInterval,
} from './time-interval';
import { validateTargetDueDate } from './schedule-target-date';

type CanonicalScheduleLike = {
  status?: MaintenanceStatus | string | null;
  triggerType?: MaintenanceTriggerType | string | null;
  intervalType?: string | null;
  targetDueDate?: Date | string | null;
  startReferenceDate?: Date | string | null;
  timeIntervalValue?: number | null;
  timeIntervalUnit?: string | null;
  startingReferenceReadingKm?: number | null;
  odometerReading?: number | null;
  intervalKm?: number | null;
  bufferDistanceKm?: number | null;
};
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { extname } from 'node:path';

type WorkOrderUploadFile = {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asUnknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

@Injectable()
export class MaintenanceSchedulesService {
  private readonly logger = new Logger(MaintenanceSchedulesService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly storage?: BlobStorageService,
  ) {}

  private fileStorage(): BlobStorageService {
    if (!this.storage) throw new StorageUnavailableException();
    return this.storage;
  }

  private readonly attachmentMimeTypes: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.mp4': 'video/mp4',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
  };

  private async getAttachmentSchedule(id: string, actor: ScheduleActor) {
    const scope = scheduleScope(actor);
    const schedule = await this.prisma.maintenanceSchedule.findFirst({
      where: { id, deletedAt: null, ...scope },
    });
    if (!schedule) throw new NotFoundException('Work order not found.');
    return schedule;
  }

  private assertAssignedMechanic(
    schedule: MaintenanceSchedule,
    actor: ScheduleActor,
  ) {
    if (schedule.assignedMechanicId !== actor.sub) {
      throw new ForbiddenException(
        'Only the assigned mechanic can manage work order attachments.',
      );
    }
  }

  private assertScheduleOpen(
    schedule: Pick<MaintenanceSchedule, 'status' | 'workOrderProgress'>,
  ) {
    const progress = this.asProgressRecord(schedule.workOrderProgress);
    const isCancelledMaintenanceLog =
      schedule.status === MaintenanceStatus.CANCELLED &&
      progress.maintenanceLogLocked === true;
    if (
      schedule.status === MaintenanceStatus.COMPLETED ||
      isCancelledMaintenanceLog
    ) {
      throw new ForbiddenException(
        'Completed and Cancelled work orders are locked. An Admin must unlock the maintenance log before editing.',
      );
    }
  }

  private assertMechanicActor(actor: ScheduleActor) {
    if (
      !actor?.sub ||
      (actor.system && actor.system !== 'VMMS') ||
      !actor.roles?.some(
        (role) => role.system === 'VMMS' && role.role === 'MECHANIC',
      )
    ) {
      throw new ForbiddenException(
        'Only an authenticated VMMS Mechanic can request a schedule extension.',
      );
    }
  }

  private assertAdminActor(actor: ScheduleActor) {
    if (
      !actor?.sub ||
      (actor.system && actor.system !== 'VMMS') ||
      !actor.roles?.some(
        (role) => role.system === 'VMMS' && role.role === 'ADMIN',
      )
    ) {
      throw new ForbiddenException(
        'Only a VMMS Admin can review extension requests.',
      );
    }
  }

  private isExtensionEligible(
    schedule: Pick<MaintenanceSchedule, 'status' | 'workOrderProgress'>,
  ) {
    if (schedule.status === MaintenanceStatus.IN_PROGRESS) return true;
    return (
      schedule.status === MaintenanceStatus.OVERDUE &&
      this.asProgressRecord(schedule.workOrderProgress).overdueFromStatus ===
        MaintenanceStatus.IN_PROGRESS
    );
  }

  private parseExtensionDate(value: unknown): Date {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new BadRequestException(
        'A valid target due date in YYYY-MM-DD format is required.',
      );
    }
    const date = new Date(`${value}T00:00:00.000Z`);
    if (
      !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== value
    ) {
      throw new BadRequestException('The requested target due date is invalid.');
    }
    return date;
  }

  private manilaTodayDate(now: Date) {
    return new Date(now.getTime() + 8 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
  }

  private withoutOverdueMarker(
    value: Prisma.JsonValue | null,
  ): Prisma.InputJsonObject {
    const progress =
      value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return Object.fromEntries(
      Object.entries(progress).filter(([key]) => key !== 'overdueFromStatus'),
    ) as Prisma.InputJsonObject;
  }

  private assertAttachmentWritable(schedule: MaintenanceSchedule) {
    if (
      schedule.status === MaintenanceStatus.COMPLETED ||
      schedule.status === MaintenanceStatus.CANCELLED
    ) {
      throw new ForbiddenException(
        'Completed and Cancelled work orders are locked.',
      );
    }
  }

  private canViewMaintenanceCosts(actor?: ScheduleActor): boolean {
    if (!actor) return true;
    return actor.roles.some(
      ({ role, system }) =>
        system === 'VMMS' &&
        ['ADMIN', 'OPERATIONS', 'CHIEF_MECHANIC'].includes(role),
    );
  }

  async uploadAttachment(
    id: string,
    itemId: string,
    file: WorkOrderUploadFile | undefined,
    actor: ScheduleActor,
  ) {
    if (!file)
      throw new BadRequestException(
        'Choose a supported file no larger than 5 MB.',
      );
    if (!itemId?.trim())
      throw new BadRequestException('A checklist item is required.');
    const schedule = await this.getAttachmentSchedule(id, actor);
    this.assertAttachmentWritable(schedule);
    this.assertAssignedMechanic(schedule, actor);
    const progress = this.asProgressRecord(schedule.workOrderProgress);
    const execution = asUnknownArray(progress.executionItems);
    const changed = execution.some((raw) => {
      const item =
        raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
      return item.id === itemId && item.status === 'changed';
    });
    if (!changed)
      throw new BadRequestException(
        'Attachments can only be added to checklist items marked Changed.',
      );

    const extension = extname(file.originalname).toLowerCase();
    const contentType = this.attachmentMimeTypes[extension];
    if (!contentType)
      throw new BadRequestException('Unsupported attachment type.');
    const attachmentId = randomUUID();
    const storageName = `work-orders/${id}/${attachmentId}${extension}`;
    const fileStorage = this.fileStorage();
    await fileStorage.put(storageName, file.buffer, contentType);

    try {
      const partDetails =
        progress.partDetails && typeof progress.partDetails === 'object'
          ? (progress.partDetails as Record<string, unknown>)
          : {};
      const rawEntry = partDetails[itemId];
      const entry =
        rawEntry && typeof rawEntry === 'object'
          ? (rawEntry as Record<string, unknown>)
          : {};
      const attachments = asUnknownArray(entry.attachments);
      const retainedAttachments = attachments.filter((candidate) => {
        if (typeof candidate === 'string')
          return candidate.toLowerCase() !== file.originalname.toLowerCase();
        if (!candidate || typeof candidate !== 'object') return true;
        const previous = candidate as Record<string, unknown>;
        return !(
          typeof previous.name === 'string' &&
          previous.name.toLowerCase() === file.originalname.toLowerCase() &&
          !previous.storageName
        );
      });
      if (retainedAttachments.length >= 5)
        throw new BadRequestException(
          'A checklist item can have at most 5 attachments.',
        );
      const attachment = {
        id: attachmentId,
        name: file.originalname,
        sizeMb: Number((file.size / (1024 * 1024)).toFixed(2)),
        contentType,
        storageName,
      };
      const nextProgress = {
        ...progress,
        partDetails: {
          ...partDetails,
          [itemId]: {
            ...entry,
            attachments: [...retainedAttachments, attachment],
          },
        },
      } as Prisma.InputJsonObject;
      await this.prisma.maintenanceSchedule.update({
        where: { id: schedule.id, updatedAt: schedule.updatedAt },
        data: { workOrderProgress: nextProgress },
      });
      return {
        ...attachment,
        url: `/maintenance-schedules/${id}/attachments/${attachmentId}`,
      };
    } catch (error) {
      await fileStorage.delete(storageName).catch(() => undefined);
      throw error;
    }
  }

  async getAttachment(id: string, attachmentId: string, actor: ScheduleActor) {
    const schedule = await this.getAttachmentSchedule(id, actor);
    const progress = this.asProgressRecord(schedule.workOrderProgress);
    const partDetails =
      progress.partDetails && typeof progress.partDetails === 'object'
        ? (progress.partDetails as Record<string, unknown>)
        : {};
    for (const rawEntry of Object.values(partDetails)) {
      const entry =
        rawEntry && typeof rawEntry === 'object'
          ? (rawEntry as Record<string, unknown>)
          : {};
      const attachments = asUnknownArray(entry.attachments);
      const rawAttachment = attachments.find(
        (candidate) =>
          candidate &&
          typeof candidate === 'object' &&
          (candidate as Record<string, unknown>).id === attachmentId,
      );
      if (!rawAttachment) continue;
      const attachment = rawAttachment as Record<string, unknown>;
      const storageName =
        typeof attachment.storageName === 'string'
          ? attachment.storageName
          : '';
      const extension = extname(storageName).toLowerCase();
      if (
        !storageName ||
        storageName !== `work-orders/${id}/${attachmentId}${extension}` ||
        !this.attachmentMimeTypes[extension]
      ) {
        throw new NotFoundException('Attachment not found.');
      }
      return {
        name:
          typeof attachment.name === 'string' ? attachment.name : 'attachment',
        contentType: this.attachmentMimeTypes[extension],
        stream: Readable.from([await this.fileStorage().get(storageName)]),
      };
    }
    throw new NotFoundException('Attachment not found.');
  }

  async deleteAttachment(
    id: string,
    attachmentId: string,
    actor: ScheduleActor,
  ) {
    const schedule = await this.getAttachmentSchedule(id, actor);
    this.assertAttachmentWritable(schedule);
    this.assertAssignedMechanic(schedule, actor);
    const progress = this.asProgressRecord(schedule.workOrderProgress);
    const partDetails =
      progress.partDetails && typeof progress.partDetails === 'object'
        ? (progress.partDetails as Record<string, unknown>)
        : {};
    let storageName: string | null = null;
    const nextPartDetails: Record<string, unknown> = {};
    for (const [itemId, rawEntry] of Object.entries(partDetails)) {
      const entry =
        rawEntry && typeof rawEntry === 'object'
          ? (rawEntry as Record<string, unknown>)
          : {};
      const attachments = asUnknownArray(entry.attachments);
      const removed = attachments.find(
        (candidate) =>
          candidate &&
          typeof candidate === 'object' &&
          (candidate as Record<string, unknown>).id === attachmentId,
      );
      if (removed)
        storageName =
          typeof (removed as Record<string, unknown>).storageName === 'string'
            ? ((removed as Record<string, unknown>).storageName as string)
            : null;
      nextPartDetails[itemId] = {
        ...entry,
        attachments: attachments.filter(
          (candidate) =>
            !candidate ||
            typeof candidate !== 'object' ||
            (candidate as Record<string, unknown>).id !== attachmentId,
        ),
      };
    }
    if (!storageName) throw new NotFoundException('Attachment not found.');
    const extension = extname(storageName).toLowerCase();
    const expectedStorageName = `work-orders/${id}/${attachmentId}${extension}`;
    if (
      storageName !== expectedStorageName ||
      !this.attachmentMimeTypes[extension]
    ) {
      throw new NotFoundException('Attachment not found.');
    }
    const fileStorage = this.fileStorage();
    await this.prisma.maintenanceSchedule.update({
      where: { id: schedule.id, updatedAt: schedule.updatedAt },
      data: {
        workOrderProgress: {
          ...progress,
          partDetails: nextPartDetails,
        } as Prisma.InputJsonObject,
      },
    });
    await fileStorage.delete(storageName);
    return { success: true };
  }

  private asProgressRecord(
    value: Prisma.JsonValue | null,
  ): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : {};
  }

  private async resolveMileage(
    db: Pick<Prisma.TransactionClient, 'vehicle' | 'vehicleMaintenanceDefault'>,
    data: CreateMaintenanceScheduleDto,
    checklistTemplateId: string,
    previous?: MaintenanceSchedule,
  ) {
    const vehicle =
      (data.triggerType ?? previous?.triggerType) ===
      MaintenanceTriggerType.ODOMETER
        ? await db.vehicle.findFirst({
            where: {
              plateNumber: {
                equals: data.vehicleId.trim(),
                mode: 'insensitive',
              },
              deletedAt: null,
              isActive: true,
            },
            select: {
              id: true,
              odometer: true,
              defaultMaintenanceIntervalKm: true,
              defaultMaintenanceBufferKm: true,
            },
          })
        : null;
    if (
      (data.triggerType ?? previous?.triggerType) !==
      MaintenanceTriggerType.ODOMETER
    )
      return validateScheduleMileage(data, previous, vehicle?.odometer);

    let mileageData = data;
    if (data.useVehicleDefaults) {
      if (!vehicle)
        throw new BadRequestException(
          'Select an active truck before using its maintenance defaults.',
        );
      const categoryDefault = await db.vehicleMaintenanceDefault.findUnique({
        where: {
          vehicleId_checklistTemplateId: {
            vehicleId: vehicle.id,
            checklistTemplateId,
          },
        },
        select: { intervalKm: true, bufferDistanceKm: true },
      });
      const intervalKm =
        categoryDefault?.intervalKm ?? vehicle.defaultMaintenanceIntervalKm;
      const bufferDistanceKm =
        categoryDefault?.bufferDistanceKm ?? vehicle.defaultMaintenanceBufferKm;
      if (intervalKm == null || bufferDistanceKm == null)
        throw new BadRequestException(
          'No maintenance defaults are configured for this vehicle and category. Choose Custom and enter an interval and buffer.',
        );
      mileageData = {
        ...data,
        intervalKm: String(intervalKm),
        bufferDistanceKm: String(bufferDistanceKm),
      };
    } else {
      const intervalValue =
        data.intervalKm === undefined
          ? previous?.intervalKm?.toString()
          : data.intervalKm;
      const bufferValue =
        data.bufferDistanceKm === undefined
          ? previous?.bufferDistanceKm?.toString()
          : data.bufferDistanceKm;
      if (!previous && (!intervalValue || !bufferValue))
        throw new BadRequestException(
          'Custom odometer schedules require both an interval and buffer.',
        );
      mileageData = {
        ...data,
        intervalKm: intervalValue,
        bufferDistanceKm: bufferValue,
      };
    }

    return validateScheduleMileage(mileageData, previous, vehicle?.odometer);
  }

  private async resolveChecklistTemplate(
    db: Pick<Prisma.TransactionClient, 'checklistTemplate'>,
    data: CreateMaintenanceScheduleDto,
    previous?: MaintenanceSchedule,
  ) {
    const title = data.title.trim();
    const requestedId =
      data.checklistTemplateId ??
      (previous?.title.trim().toLowerCase() === title.toLowerCase()
        ? previous.checklistTemplateId
        : undefined);
    const templates = await db.checklistTemplate.findMany({
      where: {
        ...(requestedId
          ? { id: requestedId }
          : { type: { equals: title, mode: 'insensitive' as const } }),
        deletedAt: null,
      },
      select: {
        id: true,
        type: true,
        items: { where: { deletedAt: null }, select: { id: true }, take: 1 },
      },
      take: 2,
    });
    if (
      templates.length !== 1 ||
      templates[0].type.trim().toLowerCase() !== title.toLowerCase()
    ) {
      throw new BadRequestException(
        'Select one active checklist template matching the maintenance type. Refresh the templates and try again.',
      );
    }
    const template = templates[0];
    if (!template.items.length)
      throw new BadRequestException(
        'The selected checklist template has no active items.',
      );
    if (
      previous &&
      ['IN_PROGRESS', 'DONE'].includes(previous.status) &&
      template.id !== previous.checklistTemplateId
    ) {
      throw new BadRequestException(
        'The assigned checklist cannot be changed after work has started.',
      );
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
    if (
      (data.status ?? MaintenanceStatus.PENDING) !== MaintenanceStatus.PENDING
    )
      return;
    const duplicates = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT id FROM maintenance_schedules
      WHERE status = 'PENDING' AND deleted_at IS NULL
        AND LOWER(BTRIM("vehicleId")) = LOWER(BTRIM(${data.vehicleId}))
        AND LOWER(BTRIM(title)) = LOWER(BTRIM(${data.title}))
        ${excludeId ? Prisma.sql`AND id <> ${excludeId}::uuid` : Prisma.empty}
      LIMIT 1
    `);
    if (duplicates.length) {
      throw new ConflictException(
        'A pending schedule of this type already exists for this truck',
      );
    }
  }

  private async handleScheduleWriteConflict(
    error: unknown,
    data: CreateMaintenanceScheduleDto,
    excludeId?: string,
  ): Promise<never> {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2025'
    ) {
      throw new ConflictException(
        'The schedule changed. Refresh before updating.',
      );
    }
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      // Recheck outside the failed transaction, including a competing insert
      // committed after our precheck. Unrelated unique errors retain their cause.
      await this.assertNoPendingDuplicate(this.prisma, data, excludeId);
    }
    throw error;
  }

  async findAll(actor?: ScheduleActor) {
    const scope = actor ? scheduleScope(actor) : {};
    const includeCosts = this.canViewMaintenanceCosts(actor);
    try {
      const schedules = await this.prisma.maintenanceSchedule.findMany({
        where: { deletedAt: null, ...scope },
        orderBy: { createdAt: 'desc' },
        include: {
          cancellations: { orderBy: { createdAt: 'desc' } },
          maintenanceLogEditUnlocks: {
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              actorId: true,
              actorName: true,
              reason: true,
              reviewStatus: true,
              reviewedAt: true,
              activatedAt: true,
              consumedAt: true,
            },
          },
        },
      });

      return schedules.map((schedule) => {
        const costs = this.normalizeCostPayload({
          partsCost: schedule.partsCost,
          laborCost: schedule.laborCost,
          totalCost: schedule.totalCost,
        });

        const canonical = this.canonicalScheduleFields(schedule);

        return {
          id: schedule.id,
          workOrderNumber: schedule.workOrderNumber,
          logNumber: schedule.logNumber,
          vehicleId: schedule.vehicleId,
          title: schedule.title,
          status: schedule.status,
          computedStatus: canonical.computedStatus,
          priority: schedule.priority,
          cancellations: schedule.cancellations ?? [],
          maintenanceLogUnlockRequests:
            schedule.maintenanceLogEditUnlocks ?? [],
          dueDate: canonical.dueDate,
          dueOdometer: canonical.dueOdometer,
          date: this.formatDateOnly(schedule.createdAt),
          startDate: this.formatDateOnly(schedule.startDate),
          targetDueDate: this.formatDateOnly(schedule.targetDueDate),
          assignedMechanic: schedule.assignedMechanic,
          assignedMechanicId: schedule.assignedMechanicId,
          assignedDriver: schedule.assignedMechanic,
          chiefMechanicId: schedule.chiefMechanicId ?? null,
          chiefMechanic: schedule.chiefMechanic ?? null,
          accountType: schedule.accountType ?? null,
          outsourcedProvider: schedule.outsourcedProvider ?? null,
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
          approvalStatus: schedule.approvalStatus,
          workOrderProgress: progressForClient(schedule),
          ...(includeCosts
            ? {
                partsCost: costs.partsCost,
                laborCost: costs.laborCost,
                totalCost: costs.totalCost,
              }
            : {}),
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
        log_number?: string | null;
        vehicleId: string | null;
        title: string | null;
        status: string | null;
        created_at: Date | string | null;
        start_date?: Date | string | null;
        target_due_date?: Date | string | null;
        scheduled_date?: Date | string | null;
        assigned_mechanic: string | null;
        chief_mechanic_id?: string | null;
        chief_mechanic?: string | null;
        account_type: string | null;
        outsourced_provider?: string | null;
        checklist_template_id: string | null;
        garage_id?: string | null;
        odometer_reading: number | null;
        trigger_type: string | null;
        interval_km?: number | null;
        buffer_distance_km?: number | null;
        starting_reference_reading_km?: number | null;
        interval_type?: string | null;
        time_interval_value?: number | null;
        time_interval_unit?: string | null;
        start_reference_date?: Date | string | null;
        previous_schedule_id?: string | null;
        work_order_progress?: Prisma.JsonValue | null;
        approval_status?: string;
        parts_cost?: number | null;
        labor_cost?: number | null;
        total_cost?: number | null;
        priority?: string | null;
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
      const whereClause = columns.has('deleted_at')
        ? 'WHERE deleted_at IS NULL'
        : '';
      const rows = await this.prisma.$queryRawUnsafe<RawScheduleRow[]>(
        `SELECT id, ${optionalColumn('work_order_number')} AS work_order_number, ${optionalColumn('log_number')} AS log_number, ${optionalColumn('vehicle_id')} AS vehicleId, title, status, ${optionalColumn('priority')} AS priority, ${optionalColumn('created_at')} AS created_at, ${optionalColumn('start_date')} AS start_date, ${optionalColumn('target_due_date')} AS target_due_date, ${optionalColumn('scheduled_date')} AS scheduled_date, assigned_mechanic, ${optionalColumn('chief_mechanic_id')} AS chief_mechanic_id, ${optionalColumn('chief_mechanic')} AS chief_mechanic, account_type, ${optionalColumn('outsourced_provider')} AS outsourced_provider, checklist_template_id, ${optionalColumn('garage_id')} AS garage_id, odometer_reading, trigger_type, ${optionalColumn('interval_km')} AS interval_km, ${optionalColumn('buffer_distance_km')} AS buffer_distance_km, ${optionalColumn('starting_reference_reading_km')} AS starting_reference_reading_km, ${optionalColumn('interval_type')} AS interval_type, ${optionalColumn('time_interval_value')} AS time_interval_value, ${optionalColumn('time_interval_unit')} AS time_interval_unit, ${optionalColumn('start_reference_date')} AS start_reference_date, ${optionalColumn('previous_schedule_id')} AS previous_schedule_id, ${optionalColumn('work_order_progress')} AS work_order_progress, ${optionalColumn('approval_status')} AS approval_status, ${optionalColumn('parts_cost')} AS parts_cost, ${optionalColumn('labor_cost')} AS labor_cost, ${optionalColumn('total_cost')} AS total_cost FROM maintenance_schedules ${whereClause} ORDER BY ${dateOrder} DESC`,
      );

      return rows.map((r) => {
        const costs = this.normalizeCostPayload({
          partsCost: r.parts_cost,
          laborCost: r.labor_cost,
          totalCost: r.total_cost,
        });

        const canonical = this.canonicalScheduleFields({
          status: r.status ?? MaintenanceStatus.PENDING,
          triggerType: r.trigger_type,
          intervalType: r.interval_type,
          targetDueDate: r.target_due_date ?? null,
          startReferenceDate: r.start_reference_date ?? null,
          timeIntervalValue: r.time_interval_value ?? null,
          timeIntervalUnit: r.time_interval_unit ?? null,
          startingReferenceReadingKm: r.starting_reference_reading_km ?? null,
          odometerReading: r.odometer_reading ?? null,
          intervalKm: r.interval_km ?? null,
          bufferDistanceKm: r.buffer_distance_km ?? null,
        });

        return {
          id: String(r.id),
          workOrderNumber: r.work_order_number ?? null,
          logNumber: r.log_number ?? null,
          vehicleId: r.vehicleId ?? '',
          title: r.title ?? '',
          status: r.status ?? MaintenanceStatus.PENDING,
          computedStatus: canonical.computedStatus,
          priority: r.priority ?? MaintenancePriority.MEDIUM,
          date: this.formatDateOnly(r.created_at ?? r.scheduled_date ?? null),
          startDate: this.formatDateOnly(r.start_date ?? null),
          targetDueDate: this.formatDateOnly(r.target_due_date ?? null),
          dueDate: canonical.dueDate,
          dueOdometer: canonical.dueOdometer,
          assignedMechanic: r.assigned_mechanic ?? null,
          assignedDriver: r.assigned_mechanic ?? null,
          chiefMechanicId: r.chief_mechanic_id ?? null,
          chiefMechanic: r.chief_mechanic ?? null,
          accountType: r.account_type ?? null,
          outsourcedProvider: r.outsourced_provider ?? null,
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
          startReferenceDate: this.formatDateOnly(
            r.start_reference_date ?? null,
          ),
          previousScheduleId: r.previous_schedule_id ?? null,
          approvalStatus: r.approval_status,
          workOrderProgress: progressForClient({
            status: r.status,
            approvalStatus: r.approval_status,
            workOrderProgress: r.work_order_progress,
          }),
          ...(includeCosts
            ? {
                partsCost: costs.partsCost,
                laborCost: costs.laborCost,
                totalCost: costs.totalCost,
              }
            : {}),
        };
      });
    }
  }

  async create(data: CreateMaintenanceScheduleDto) {
    if (data.status === 'CANCELLED')
      throw new BadRequestException(
        'Create a pending schedule before cancelling it with a reason.',
      );
    if (
      data.status === 'COMPLETED' ||
      data.status === 'DONE' ||
      data.status === 'IN_PROGRESS' ||
      data.workOrderProgress != null ||
      data.work_order_progress != null
    )
      throw new ForbiddenException(
        'Use the assigned work order workflow to start, submit or complete work.',
      );
    const startDate = validateStartDate(data.startDate);
    const time = validateTimeSchedule(data);
    const targetDueDate =
      validateTargetDueDate(data.targetDueDate, startDate) ??
      (time.startReferenceDate && getTimeInterval(time)
        ? addTimeInterval(time.startReferenceDate, getTimeInterval(time)!)
        : null);
    if (!targetDueDate)
      throw new BadRequestException(
        'A target due date is required for every maintenance schedule.',
      );
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
    const { chiefMechanicId, chiefMechanic } =
      await this.resolveChiefMechanic(data);
    const outsourcedProvider = await this.resolveOutsourcedProvider(
      this.prisma,
      data,
    );

    const schedule = await this.prisma
      .$transaction(async (tx) => {
        const mileage = await this.resolveMileage(
          tx,
          data,
          checklist.checklistTemplateId,
        );
        return tx.maintenanceSchedule.create({
          data: {
            vehicleId: data.vehicleId,
            startDate,
            targetDueDate,
            status: data.status ?? MaintenanceStatus.PENDING,
            priority: data.priority ?? MaintenancePriority.MEDIUM,
            ...(await this.resolveAssignedMechanic(data)),
            chiefMechanicId,
            chiefMechanic,
            accountType: data.accountType ?? data.account_type,
            outsourcedProvider,
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
      })
      .catch((error: unknown) => this.handleScheduleWriteConflict(error, data));

    const costs = this.normalizeCostPayload({
      partsCost: schedule.partsCost,
      laborCost: schedule.laborCost,
      totalCost: schedule.totalCost,
    });
    const canonical = this.canonicalScheduleFields(schedule);

    return {
      id: schedule.id,
      logNumber: schedule.logNumber ?? null,
      workOrderNumber: schedule.workOrderNumber,
      vehicleId: schedule.vehicleId,
      title: schedule.title,
      status: schedule.status,
      computedStatus: canonical.computedStatus,
      priority: schedule.priority,
      date: schedule.createdAt.toISOString().slice(0, 10),
      startDate: this.formatDateOnly(schedule.startDate),
      targetDueDate: this.formatDateOnly(schedule.targetDueDate),
      dueDate: canonical.dueDate,
      dueOdometer: canonical.dueOdometer,
      assignedMechanic: schedule.assignedMechanic,
      assignedMechanicId: schedule.assignedMechanicId,
      assignedDriver: schedule.assignedMechanic,
      chiefMechanicId: schedule.chiefMechanicId ?? null,
      chiefMechanic: schedule.chiefMechanic ?? null,
      accountType: schedule.accountType ?? null,
      outsourcedProvider: schedule.outsourcedProvider ?? null,
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
      approvalStatus: schedule.approvalStatus,
      workOrderProgress: progressForClient(schedule),
      partsCost: costs.partsCost,
      laborCost: costs.laborCost,
      totalCost: costs.totalCost,
    };
  }

  async update(
    id: string,
    data: CreateMaintenanceScheduleDto,
    actor?: ScheduleActor,
  ) {
    if (data.status === 'CANCELLED')
      throw new BadRequestException(
        'Use the cancellation endpoint and provide a reason.',
      );
    if (data.status === 'COMPLETED' || data.status === 'DONE')
      throw new ForbiddenException(
        'Use the assigned work order workflow to submit or complete work.',
      );
    const workOrderProgress = this.normalizeWorkOrderProgress(
      data.workOrderProgress ?? data.work_order_progress,
    );
    const normalizedCosts = this.normalizeCostPayload({
      partsCost: data.partsCost ?? data.parts_cost,
      laborCost: data.laborCost ?? data.labor_cost,
      totalCost: data.totalCost ?? data.total_cost,
    });
    const { chiefMechanicId, chiefMechanic } =
      await this.resolveChiefMechanic(data);

    const schedule = await this.prisma
      .$transaction(async (tx) => {
        const previous = await tx.maintenanceSchedule.findUniqueOrThrow({
          where: { id },
        });

        this.assertScheduleOpen(previous);
        if (
          ['IN_PROGRESS', 'DONE'].includes(previous.status) &&
          data.status !== previous.status
        ) {
          throw new BadRequestException(
            'Started work cannot return to pending scheduling. Use the assigned work order workflow.',
          );
        }
        if (
          workOrderProgress !== undefined &&
          JSON.stringify(workOrderProgress) !==
            JSON.stringify(previous.workOrderProgress)
        )
          throw new ForbiddenException(
            'Use the assigned work order progress endpoint.',
          );
        if (data.status === 'IN_PROGRESS' && previous.status !== 'IN_PROGRESS')
          throw new ForbiddenException(
            'Only the assigned mechanic can start work.',
          );
        const startDate = validateStartDate(data.startDate, previous.startDate);
        const time = validateTimeSchedule(data, previous);
        const targetDueDate =
          validateTargetDueDate(
            data.targetDueDate,
            startDate,
            previous.targetDueDate,
          ) ??
          (time.startReferenceDate && getTimeInterval(time)
            ? addTimeInterval(time.startReferenceDate, getTimeInterval(time)!)
            : null);
        if (!targetDueDate)
          throw new BadRequestException(
            'A target due date is required for every maintenance schedule.',
          );
        if (
          ['IN_PROGRESS', 'DONE'].includes(previous.status) &&
          startDate.getTime() !== previous.startDate?.getTime()
        ) {
          throw new BadRequestException(
            'The schedule start date cannot change after work has started.',
          );
        }
        await this.assertNoPendingDuplicate(tx, data, id);
        const checklist = await this.resolveChecklistTemplate(
          tx,
          data,
          previous,
        );
        const mileage = await this.resolveMileage(
          tx,
          data,
          checklist.checklistTemplateId,
          previous,
        );
        const outsourcedProvider = await this.resolveOutsourcedProvider(
          tx,
          data,
          previous,
        );
        const updated = await tx.maintenanceSchedule.update({
          where: { id, status: previous.status, updatedAt: previous.updatedAt },
          data: {
            vehicleId: data.vehicleId,
            startDate,
            targetDueDate,
            status: data.status ?? MaintenanceStatus.PENDING,
            priority: data.priority ?? previous.priority,
            ...(await this.resolveAssignedMechanic(data)),
            chiefMechanicId: chiefMechanicId ?? previous.chiefMechanicId,
            chiefMechanic: chiefMechanic ?? previous.chiefMechanic,
            accountType:
              data.accountType ??
              data.account_type ??
              previous.accountType ??
              undefined,
            outsourcedProvider,
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

        const datesChanged =
          this.formatDateOnly(previous.startDate) !==
            this.formatDateOnly(updated.startDate) ||
          this.formatDateOnly(previous.targetDueDate) !==
            this.formatDateOnly(updated.targetDueDate);
        if (datesChanged) {
          if (!actor?.sub || !actor.name || !actor.email) {
            throw new ForbiddenException(
              'An authenticated actor is required to reschedule maintenance.',
            );
          }
          await tx.maintenanceScheduleRescheduleAudit.create({
            data: {
              scheduleId: id,
              source: MaintenanceScheduleRescheduleSource.MANUAL_UPDATE,
              actorId: actor.sub,
              actorName: actor.name,
              actorEmail: actor.email,
              previousStartDate: previous.startDate,
              newStartDate: updated.startDate,
              previousTargetDueDate: previous.targetDueDate,
              newTargetDueDate: updated.targetDueDate,
            },
          });
        }

        const justCompleted =
          this.isCompleted(updated.status) &&
          !this.isCompleted(previous.status);

        if (justCompleted) {
          await this.createNextRecurringSchedule(tx, updated);
        }

        return updated;
      })
      .catch((error: unknown) =>
        this.handleScheduleWriteConflict(error, data, id),
      );

    // Sync vehicle status based on the new schedule status
    if (data.vehicleId && data.status) {
      await this.syncVehicleStatus(data.vehicleId, data.status);
    }

    const costs = this.normalizeCostPayload({
      partsCost: schedule.partsCost,
      laborCost: schedule.laborCost,
      totalCost: schedule.totalCost,
    });
    const canonical = this.canonicalScheduleFields(schedule);

    return {
      id: schedule.id,
      workOrderNumber: schedule.workOrderNumber,
      vehicleId: schedule.vehicleId,
      title: schedule.title,
      status: schedule.status,
      computedStatus: canonical.computedStatus,
      priority: schedule.priority,
      date: this.formatDateOnly(schedule.createdAt),
      startDate: this.formatDateOnly(schedule.startDate),
      targetDueDate: this.formatDateOnly(schedule.targetDueDate),
      dueDate: canonical.dueDate,
      dueOdometer: canonical.dueOdometer,
      assignedMechanic: schedule.assignedMechanic,
      assignedMechanicId: schedule.assignedMechanicId,
      assignedDriver: schedule.assignedMechanic,
      chiefMechanicId: schedule.chiefMechanicId ?? null,
      chiefMechanic: schedule.chiefMechanic ?? null,
      accountType: schedule.accountType ?? null,
      outsourcedProvider: schedule.outsourcedProvider ?? null,
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
      approvalStatus: schedule.approvalStatus,
      workOrderProgress: progressForClient(schedule),
      partsCost: costs.partsCost,
      laborCost: costs.laborCost,
      totalCost: costs.totalCost,
    };
  }

  async requestExtension(
    id: string,
    data: CreateMaintenanceScheduleExtensionDto,
    actor: ScheduleActor,
  ) {
    this.assertMechanicActor(actor);
    if (!actor.name?.trim() || !actor.email?.trim()) {
      throw new ForbiddenException(
        'An authenticated mechanic identity is required.',
      );
    }

    const requestedDueDate = this.parseExtensionDate(data.requestedDueDate);
    const reason = typeof data.reason === 'string' ? data.reason.trim() : '';
    if (!reason || reason.length > 2000) {
      throw new BadRequestException(
        'A request reason of 1 to 2000 characters is required.',
      );
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const schedule = await tx.maintenanceSchedule.findFirst({
          where: { id, deletedAt: null },
        });
        if (!schedule) throw new NotFoundException('Work order not found.');
        if (schedule.assignedMechanicId !== actor.sub) {
          throw new ForbiddenException(
            'Only the assigned mechanic can request a schedule extension.',
          );
        }
        if (!this.isExtensionEligible(schedule)) {
          throw new ConflictException(
            'Extensions are available only while assigned work is in progress.',
          );
        }
        if (!schedule.targetDueDate) {
          throw new ConflictException(
            'A schedule without a target due date cannot be extended.',
          );
        }
        if (requestedDueDate <= schedule.targetDueDate) {
          throw new BadRequestException(
            'The requested target due date must be later than the current target due date.',
          );
        }

        const [requestCount, pendingRequest] = await Promise.all([
          tx.maintenanceScheduleExtension.count({ where: { scheduleId: id } }),
          tx.maintenanceScheduleExtension.findFirst({
            where: {
              scheduleId: id,
              reviewStatus: MaintenanceScheduleExtensionReviewStatus.PENDING,
            },
            select: { id: true },
          }),
        ]);
        if (requestCount >= 2) {
          throw new ConflictException(
            'This schedule has reached its two extension request limit.',
          );
        }
        if (pendingRequest) {
          throw new ConflictException(
            'An extension request is already pending for this schedule.',
          );
        }

        const request = await tx.maintenanceScheduleExtension.create({
          data: {
            scheduleId: id,
            actorId: actor.sub,
            actorName: actor.name.trim(),
            actorEmail: actor.email.trim(),
            requestedDueDate,
            reason,
          },
        });
        await tx.maintenanceScheduleExtensionAudit.create({
          data: {
            scheduleId: id,
            extensionId: request.id,
            eventType: MaintenanceScheduleExtensionAuditEventType.REQUESTED,
            actorId: actor.sub,
            actorName: actor.name.trim(),
            actorEmail: actor.email.trim(),
            previousDueDate: schedule.targetDueDate,
            requestedDueDate,
            reason,
            recordedAt: request.createdAt,
          },
        });

        return {
          id: request.id,
          scheduleId: request.scheduleId,
          requestedDueDate: this.formatDateOnly(request.requestedDueDate),
          reason: request.reason,
          reviewStatus: request.reviewStatus,
          actorName: request.actorName,
          requestedAt: request.createdAt.toISOString(),
          reviewedAt: null,
        };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'An extension request is already pending for this schedule.',
        );
      }
      throw error;
    }
  }

  async findPendingExtensionRequests(actor: ScheduleActor, cursor?: string) {
    this.assertAdminActor(actor);
    const pageSize = 50;
    const requests = await this.prisma.maintenanceScheduleExtension.findMany({
      where: {
        reviewStatus: MaintenanceScheduleExtensionReviewStatus.PENDING,
        schedule: { is: { deletedAt: null } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: pageSize + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        scheduleId: true,
        actorName: true,
        requestedDueDate: true,
        reason: true,
        createdAt: true,
        schedule: {
          select: {
            workOrderNumber: true,
            vehicleId: true,
            title: true,
            status: true,
            targetDueDate: true,
            assignedMechanic: true,
          },
        },
      },
    });
    const hasMore = requests.length > pageSize;
    const page = hasMore ? requests.slice(0, pageSize) : requests;

    return {
      items: page.map((request) => ({
        id: request.id,
        scheduleId: request.scheduleId,
        actorName: request.actorName,
        requestedDueDate: this.formatDateOnly(request.requestedDueDate),
        reason: request.reason,
        requestedAt: request.createdAt.toISOString(),
        schedule: {
          workOrderNumber: request.schedule.workOrderNumber,
          vehicleId: request.schedule.vehicleId,
          title: request.schedule.title,
          status: request.schedule.status,
          targetDueDate: this.formatDateOnly(request.schedule.targetDueDate),
          assignedMechanic: request.schedule.assignedMechanic,
        },
      })),
      nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null,
    };
  }

  async getExtensionHistory(id: string, actor: ScheduleActor) {
    const scope = scheduleScope(actor);
    const schedule = await this.prisma.maintenanceSchedule.findFirst({
      where: { id, deletedAt: null, ...scope },
      select: { id: true, targetDueDate: true },
    });
    if (!schedule) throw new NotFoundException('Work order not found.');

    const [requests, extensionEvents, rescheduleEvents] = await Promise.all([
      this.prisma.maintenanceScheduleExtension.findMany({
        where: { scheduleId: id },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          actorName: true,
          requestedDueDate: true,
          reason: true,
          reviewStatus: true,
          reviewedByName: true,
          reviewReason: true,
          createdAt: true,
          reviewedAt: true,
        },
      }),
      this.prisma.maintenanceScheduleExtensionAudit.findMany({
        where: { scheduleId: id },
        orderBy: { recordedAt: 'desc' },
        select: {
          extensionId: true,
          eventType: true,
          actorName: true,
          previousDueDate: true,
          requestedDueDate: true,
          reason: true,
          recordedAt: true,
        },
      }),
      this.prisma.maintenanceScheduleRescheduleAudit.findMany({
        where: { scheduleId: id },
        orderBy: { changedAt: 'desc' },
        select: {
          source: true,
          actorName: true,
          previousStartDate: true,
          newStartDate: true,
          previousTargetDueDate: true,
          newTargetDueDate: true,
          changedAt: true,
        },
      }),
    ]);

    return {
      currentTargetDueDate: this.formatDateOnly(schedule.targetDueDate),
      requests: requests.map((request) => ({
        id: request.id,
        actorName: request.actorName,
        requestedDueDate: this.formatDateOnly(request.requestedDueDate),
        reason: request.reason,
        reviewStatus: request.reviewStatus,
        reviewedByName: request.reviewedByName,
        reviewReason: request.reviewReason,
        requestedAt: request.createdAt.toISOString(),
        reviewedAt: request.reviewedAt?.toISOString() ?? null,
      })),
      extensionEvents: extensionEvents.map((event) => ({
        extensionId: event.extensionId,
        eventType: event.eventType,
        actorName: event.actorName,
        previousDueDate: this.formatDateOnly(event.previousDueDate),
        requestedDueDate: this.formatDateOnly(event.requestedDueDate),
        reason: event.reason,
        recordedAt: event.recordedAt.toISOString(),
      })),
      rescheduleEvents: rescheduleEvents.map((event) => ({
        source: event.source,
        actorName: event.actorName,
        previousStartDate: this.formatDateOnly(event.previousStartDate),
        newStartDate: this.formatDateOnly(event.newStartDate),
        previousTargetDueDate: this.formatDateOnly(
          event.previousTargetDueDate,
        ),
        newTargetDueDate: this.formatDateOnly(event.newTargetDueDate),
        changedAt: event.changedAt.toISOString(),
      })),
    };
  }

  async reviewExtensionRequest(
    id: string,
    requestId: string,
    decision: 'APPROVE' | 'REJECT',
    reviewReason: unknown,
    actor: ScheduleActor,
  ) {
    this.assertAdminActor(actor);
    if (!actor.name?.trim() || !actor.email?.trim()) {
      throw new ForbiddenException('An authenticated Admin identity is required.');
    }
    if (decision !== 'APPROVE' && decision !== 'REJECT') {
      throw new BadRequestException('A valid extension decision is required.');
    }
    const reason =
      typeof reviewReason === 'string' ? reviewReason.trim() : '';
    if (decision === 'REJECT' && (!reason || reason.length > 2000)) {
      throw new BadRequestException(
        'A rejection reason of 1 to 2000 characters is required.',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const schedule = await tx.maintenanceSchedule.findFirst({
        where: { id, deletedAt: null },
      });
      if (!schedule) throw new NotFoundException('Work order not found.');
      const request = await tx.maintenanceScheduleExtension.findFirst({
        where: {
          id: requestId,
          scheduleId: id,
          reviewStatus: MaintenanceScheduleExtensionReviewStatus.PENDING,
        },
      });
      if (!request) {
        throw new NotFoundException('Pending extension request not found.');
      }

      const now = new Date();
      let nextStatus = schedule.status;
      if (decision === 'APPROVE') {
        if (!this.isExtensionEligible(schedule)) {
          throw new ConflictException(
            'This schedule is no longer eligible for an extension.',
          );
        }
        if (
          !schedule.targetDueDate ||
          request.requestedDueDate <= schedule.targetDueDate
        ) {
          throw new ConflictException(
            'The requested date no longer extends the current target due date.',
          );
        }

        const resumeWork =
          schedule.status === MaintenanceStatus.OVERDUE &&
          this.formatDateOnly(request.requestedDueDate)! >=
            this.manilaTodayDate(now);
        nextStatus = resumeWork
          ? MaintenanceStatus.IN_PROGRESS
          : schedule.status;
        const update = await tx.maintenanceSchedule.updateMany({
          where: {
            id,
            deletedAt: null,
            status: schedule.status,
            updatedAt: schedule.updatedAt,
            targetDueDate: schedule.targetDueDate,
          },
          data: {
            targetDueDate: request.requestedDueDate,
            ...(resumeWork
              ? {
                  status: MaintenanceStatus.IN_PROGRESS,
                  workOrderProgress: this.withoutOverdueMarker(
                    schedule.workOrderProgress,
                  ),
                }
              : {}),
          },
        });
        if (update.count !== 1) {
          throw new ConflictException(
            'The schedule changed while the extension was being reviewed.',
          );
        }
        await tx.maintenanceScheduleRescheduleAudit.create({
          data: {
            scheduleId: id,
            extensionId: request.id,
            source: MaintenanceScheduleRescheduleSource.EXTENSION_APPROVAL,
            actorId: actor.sub,
            actorName: actor.name.trim(),
            actorEmail: actor.email.trim(),
            previousStartDate: schedule.startDate,
            newStartDate: schedule.startDate,
            previousTargetDueDate: schedule.targetDueDate,
            newTargetDueDate: request.requestedDueDate,
            changedAt: now,
          },
        });
      }

      const reviewStatus =
        decision === 'APPROVE'
          ? MaintenanceScheduleExtensionReviewStatus.APPROVED
          : MaintenanceScheduleExtensionReviewStatus.REJECTED;
      const reviewed = await tx.maintenanceScheduleExtension.updateMany({
        where: {
          id: requestId,
          scheduleId: id,
          reviewStatus: MaintenanceScheduleExtensionReviewStatus.PENDING,
        },
        data: {
          reviewStatus,
          reviewedById: actor.sub,
          reviewedByName: actor.name.trim(),
          reviewedByEmail: actor.email.trim(),
          reviewReason: decision === 'REJECT' ? reason : null,
          reviewedAt: now,
        },
      });
      if (reviewed.count !== 1) {
        throw new ConflictException(
          'This extension request has already been reviewed.',
        );
      }
      await tx.maintenanceScheduleExtensionAudit.create({
        data: {
          scheduleId: id,
          extensionId: request.id,
          eventType:
            decision === 'APPROVE'
              ? MaintenanceScheduleExtensionAuditEventType.APPROVED
              : MaintenanceScheduleExtensionAuditEventType.REJECTED,
          actorId: actor.sub,
          actorName: actor.name.trim(),
          actorEmail: actor.email.trim(),
          previousDueDate: schedule.targetDueDate,
          requestedDueDate: request.requestedDueDate,
          reason: decision === 'REJECT' ? reason : null,
          recordedAt: now,
        },
      });

      return {
        id: request.id,
        scheduleId: id,
        reviewStatus,
        requestedDueDate: this.formatDateOnly(request.requestedDueDate),
        targetDueDate: this.formatDateOnly(
          decision === 'APPROVE'
            ? request.requestedDueDate
            : schedule.targetDueDate,
        ),
        status: nextStatus,
        reviewedByName: actor.name.trim(),
        reviewReason: decision === 'REJECT' ? reason : null,
        reviewedAt: now.toISOString(),
      };
    });
  }

  async updatePriority(
    id: string,
    priority: MaintenancePriority,
    actor: ScheduleActor,
  ) {
    const canEditPriority = actor?.roles?.some(
      (role) =>
        role.system === 'VMMS' && ['ADMIN', 'OPERATIONS'].includes(role.role),
    );
    if (!actor?.sub || !canEditPriority) {
      throw new ForbiddenException(
        'Only Admin or Operations can change work-order priority.',
      );
    }
    const schedule = await this.prisma.maintenanceSchedule.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!schedule) throw new NotFoundException('Work order not found.');
    if (
      schedule.status === MaintenanceStatus.COMPLETED ||
      schedule.status === MaintenanceStatus.CANCELLED
    ) {
      throw new ForbiddenException(
        'Priority cannot be changed on a closed work order.',
      );
    }
    return this.prisma.maintenanceSchedule.update({
      where: { id },
      data: { priority },
      select: { id: true, priority: true },
    });
  }

  async cancel(id: string, reason: unknown, actor: ScheduleActor) {
    if (
      !actor?.sub ||
      !actor.roles?.some(
        (role) => role.system === 'VMMS' && role.role === 'OPERATIONS',
      )
    ) {
      throw new ForbiddenException(
        'Only Operations can cancel a maintenance schedule.',
      );
    }
    if (
      typeof reason !== 'string' ||
      !reason.trim() ||
      reason.trim().length > 2000
    ) {
      throw new BadRequestException(
        'A cancellation reason of 1 to 2000 characters is required.',
      );
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        const schedule = await tx.maintenanceSchedule.findFirst({
          where: { id, deletedAt: null },
        });
        if (!schedule)
          throw new NotFoundException('Maintenance schedule not found.');
        if (['IN_PROGRESS', 'DONE', 'COMPLETED'].includes(schedule.status)) {
          throw new BadRequestException(
            'Schedule cannot be cancelled once work has started. Use ‘Extension’ instead.',
          );
        }
        if (!['PENDING', 'DUE', 'OVERDUE'].includes(schedule.status)) {
          throw new BadRequestException(
            'This schedule has already been cancelled.',
          );
        }
        const pendingRequest =
          await tx.maintenanceScheduleCancellation.findFirst({
            where: {
              scheduleId: id,
              reviewStatus: MaintenanceCancellationReviewStatus.PENDING,
            },
            select: { id: true },
          });
        if (pendingRequest)
          throw new ConflictException(
            'A cancellation request is already awaiting Admin review.',
          );

        await tx.maintenanceScheduleCancellation.create({
          data: {
            scheduleId: id,
            actorId: actor.sub,
            actorName: actor.name,
            actorEmail: actor.email,
            reason: reason.trim(),
            previousStatus: schedule.status,
            reviewStatus: MaintenanceCancellationReviewStatus.PENDING,
          },
        });
        return {
          id,
          status: schedule.status,
          cancellations: await tx.maintenanceScheduleCancellation.findMany({
            where: { scheduleId: id },
            orderBy: { createdAt: 'desc' },
          }),
        };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'A cancellation request is already awaiting Admin review.',
        );
      }
      throw error;
    }
  }

  async reviewCancellationRequest(
    id: string,
    requestId: string,
    decision: 'APPROVE' | 'REJECT',
    reason: unknown,
    actor: ScheduleActor,
  ) {
    if (
      !actor?.sub ||
      !actor.roles?.some(
        (role) => role.system === 'VMMS' && role.role === 'ADMIN',
      )
    ) {
      throw new ForbiddenException(
        'Only Admin can review schedule cancellation requests.',
      );
    }
    if (
      decision === 'REJECT' &&
      (typeof reason !== 'string' ||
        !reason.trim() ||
        reason.trim().length > 2000)
    ) {
      throw new BadRequestException(
        'A rejection reason of 1 to 2000 characters is required.',
      );
    }
    if (decision !== 'APPROVE' && decision !== 'REJECT') {
      throw new BadRequestException(
        'A valid cancellation decision is required.',
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const schedule = await tx.maintenanceSchedule.findFirst({
        where: { id, deletedAt: null },
      });
      if (!schedule)
        throw new NotFoundException('Maintenance schedule not found.');
      const request = await tx.maintenanceScheduleCancellation.findFirst({
        where: {
          id: requestId,
          scheduleId: id,
          reviewStatus: MaintenanceCancellationReviewStatus.PENDING,
        },
        select: { id: true },
      });
      if (!request)
        throw new NotFoundException('Pending cancellation request not found.');
      const isMaintenanceLogVoid = Boolean(schedule.logNumber);

      if (decision === 'APPROVE') {
        if (
          isMaintenanceLogVoid &&
          schedule.status !== MaintenanceStatus.COMPLETED
        ) {
          throw new ConflictException(
            'This maintenance log changed and can no longer be voided.',
          );
        }
        if (isMaintenanceLogVoid) {
          await tx.maintenanceLogEditUnlock.updateMany({
            where: { scheduleId: id, consumedAt: null },
            data: { consumedAt: new Date() },
          });
        }
        const changed = await tx.maintenanceSchedule.updateMany({
          where: isMaintenanceLogVoid
            ? {
                id,
                status: schedule.status,
                updatedAt: schedule.updatedAt,
                deletedAt: null,
              }
            : {
                id,
                status: {
                  in: [
                    MaintenanceStatus.PENDING,
                    MaintenanceStatus.DUE,
                    MaintenanceStatus.OVERDUE,
                  ],
                },
                deletedAt: null,
              },
          data: isMaintenanceLogVoid
            ? {
                status: MaintenanceStatus.CANCELLED,
                workOrderProgress: {
                  ...this.asProgressRecord(schedule.workOrderProgress),
                  maintenanceLogLocked: true,
                },
              }
            : { status: MaintenanceStatus.CANCELLED },
        });
        if (changed.count !== 1) {
          throw new ConflictException(
            isMaintenanceLogVoid
              ? 'The maintenance log changed. Refresh before approving the void request.'
              : 'The schedule can no longer be cancelled because its status changed or work has started.',
          );
        }
      }

      const reviewed = await tx.maintenanceScheduleCancellation.updateMany({
        where: {
          id: requestId,
          scheduleId: id,
          reviewStatus: MaintenanceCancellationReviewStatus.PENDING,
        },
        data: {
          reviewStatus:
            decision === 'APPROVE'
              ? MaintenanceCancellationReviewStatus.APPROVED
              : MaintenanceCancellationReviewStatus.REJECTED,
          reviewedById: actor.sub,
          reviewedByName: actor.name,
          reviewedByEmail: actor.email,
          reviewReason:
            decision === 'REJECT' ? (reason as string).trim() : null,
          reviewedAt: new Date(),
        },
      });
      if (reviewed.count !== 1)
        throw new ConflictException(
          'This cancellation request has already been reviewed.',
        );

      return {
        id,
        vehicleId:
          isMaintenanceLogVoid && decision === 'APPROVE'
            ? schedule.vehicleId
            : null,
        status:
          decision === 'APPROVE'
            ? MaintenanceStatus.CANCELLED
            : schedule.status,
        cancellations: await tx.maintenanceScheduleCancellation.findMany({
          where: { scheduleId: id },
          orderBy: { createdAt: 'desc' },
        }),
      };
    });
    if (result.vehicleId)
      await this.syncVehicleStatus(
        result.vehicleId,
        MaintenanceStatus.CANCELLED,
      );
    const { vehicleId, ...response } = result;
    void vehicleId;
    return response;
  }

  async cancelMaintenanceLog(
    id: string,
    reason: unknown,
    actor: ScheduleActor,
  ) {
    if (
      !actor?.sub ||
      !actor.roles?.some(
        (role) => role.system === 'VMMS' && role.role === 'ADMIN',
      )
    ) {
      throw new ForbiddenException('Only Admin can cancel a maintenance log.');
    }
    if (
      typeof reason !== 'string' ||
      !reason.trim() ||
      reason.trim().length > 2000
    ) {
      throw new BadRequestException(
        'A cancellation reason of 1 to 2000 characters is required.',
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const schedule = await tx.maintenanceSchedule.findFirst({
        where: { id, deletedAt: null },
      });
      if (!schedule) throw new NotFoundException('Maintenance log not found.');
      if (schedule.status === MaintenanceStatus.CANCELLED) {
        throw new BadRequestException(
          'This maintenance log has already been cancelled.',
        );
      }
      await tx.maintenanceLogEditUnlock.updateMany({
        where: { scheduleId: id, consumedAt: null },
        data: { consumedAt: new Date() },
      });

      const changed = await tx.maintenanceSchedule.updateMany({
        where: {
          id,
          status: schedule.status,
          updatedAt: schedule.updatedAt,
          deletedAt: null,
        },
        data: {
          status: MaintenanceStatus.CANCELLED,
          workOrderProgress: {
            ...this.asProgressRecord(schedule.workOrderProgress),
            maintenanceLogLocked: true,
          },
        },
      });
      if (changed.count !== 1)
        throw new ConflictException(
          'The work order changed. Refresh before cancelling.',
        );
      await tx.maintenanceScheduleCancellation.create({
        data: {
          scheduleId: id,
          actorId: actor.sub,
          actorName: actor.name,
          actorEmail: actor.email,
          reason: reason.trim(),
          previousStatus: schedule.status,
        },
      });
      return {
        id,
        vehicleId: schedule.vehicleId,
        status: MaintenanceStatus.CANCELLED,
        cancellations: await tx.maintenanceScheduleCancellation.findMany({
          where: { scheduleId: id },
          orderBy: { createdAt: 'desc' },
        }),
      };
    });
    await this.syncVehicleStatus(result.vehicleId, MaintenanceStatus.CANCELLED);
    const { vehicleId, ...response } = result;
    void vehicleId;
    return response;
  }

  async unlockMaintenanceLog(
    id: string,
    reason: unknown,
    actor: ScheduleActor,
  ) {
    if (
      !actor?.sub ||
      !actor.roles?.some(
        (role) => role.system === 'VMMS' && role.role === 'OPERATIONS',
      )
    ) {
      throw new ForbiddenException(
        'Only Operations can request a maintenance-log unlock.',
      );
    }
    if (
      typeof reason !== 'string' ||
      !reason.trim() ||
      reason.trim().length > 2000
    ) {
      throw new BadRequestException(
        'An unlock reason of 1 to 2000 characters is required.',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM maintenance_schedules WHERE id = ${id}::uuid FOR UPDATE`;
      const schedule = await tx.maintenanceSchedule.findFirst({
        where: { id, deletedAt: null },
      });
      if (!schedule) throw new NotFoundException('Maintenance log not found.');
      this.assertMaintenanceLogClosed(schedule);
      const activeUnlock = await tx.maintenanceLogEditUnlock.findFirst({
        where: {
          scheduleId: id,
          consumedAt: null,
          OR: [
            { reviewStatus: MaintenanceCancellationReviewStatus.PENDING },
            {
              reviewStatus: MaintenanceCancellationReviewStatus.APPROVED,
              activatedAt: { gte: new Date(Date.now() - 15 * 60 * 1000) },
            },
          ],
        },
      });
      if (activeUnlock)
        throw new ConflictException(
          'This maintenance log already has a pending request or active unlock.',
        );
      const unlock = await tx.maintenanceLogEditUnlock.create({
        data: {
          scheduleId: id,
          actorId: actor.sub,
          actorName: actor.name,
          actorEmail: actor.email,
          reason: reason.trim(),
          reviewStatus: MaintenanceCancellationReviewStatus.PENDING,
        },
      });
      return {
        id: unlock.id,
        scheduleId: unlock.scheduleId,
        reviewStatus: unlock.reviewStatus,
        createdAt: unlock.createdAt,
        actorId: unlock.actorId,
        actorName: unlock.actorName,
        reason: unlock.reason,
        reviewedAt: unlock.reviewedAt,
        activatedAt: unlock.activatedAt,
        consumedAt: unlock.consumedAt,
      };
    });
  }

  async reviewMaintenanceLogUnlock(
    id: string,
    requestId: string,
    decision: 'APPROVE' | 'REJECT',
    reason: unknown,
    actor: ScheduleActor,
  ) {
    if (
      !actor?.sub ||
      !actor.roles?.some(
        (role) => role.system === 'VMMS' && role.role === 'ADMIN',
      )
    ) {
      throw new ForbiddenException(
        'Only Admin can review maintenance-log unlock requests.',
      );
    }
    if (decision !== 'APPROVE' && decision !== 'REJECT')
      throw new BadRequestException('A valid unlock decision is required.');
    if (
      decision === 'REJECT' &&
      (typeof reason !== 'string' ||
        !reason.trim() ||
        reason.trim().length > 2000)
    ) {
      throw new BadRequestException(
        'A rejection reason of 1 to 2000 characters is required.',
      );
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM maintenance_schedules WHERE id = ${id}::uuid FOR UPDATE`;
      const schedule = await tx.maintenanceSchedule.findFirst({
        where: { id, deletedAt: null },
      });
      if (!schedule) throw new NotFoundException('Maintenance log not found.');
      this.assertMaintenanceLogClosed(schedule);
      const pending = await tx.maintenanceLogEditUnlock.findFirst({
        where: {
          id: requestId,
          scheduleId: id,
          reviewStatus: MaintenanceCancellationReviewStatus.PENDING,
          consumedAt: null,
        },
      });
      if (!pending)
        throw new NotFoundException(
          'Pending maintenance-log unlock request not found.',
        );
      const reviewedAt = new Date();
      const updated = await tx.maintenanceLogEditUnlock.updateMany({
        where: {
          id: requestId,
          scheduleId: id,
          reviewStatus: MaintenanceCancellationReviewStatus.PENDING,
          consumedAt: null,
        },
        data: {
          reviewStatus:
            decision === 'APPROVE'
              ? MaintenanceCancellationReviewStatus.APPROVED
              : MaintenanceCancellationReviewStatus.REJECTED,
          reviewedById: actor.sub,
          reviewedByName: actor.name,
          reviewedByEmail: actor.email,
          reviewReason:
            decision === 'REJECT' ? (reason as string).trim() : null,
          reviewedAt,
          activatedAt: decision === 'APPROVE' ? reviewedAt : null,
        },
      });
      if (updated.count !== 1)
        throw new ConflictException(
          'This unlock request has already been reviewed.',
        );
      return {
        id: requestId,
        scheduleId: id,
        reviewStatus:
          decision === 'APPROVE'
            ? MaintenanceCancellationReviewStatus.APPROVED
            : MaintenanceCancellationReviewStatus.REJECTED,
        activatedAt: decision === 'APPROVE' ? reviewedAt : null,
      };
    });
  }

  async updateMaintenanceLog(
    id: string,
    data: UpdateMaintenanceLogDto,
    actor: ScheduleActor,
  ) {
    if (
      !actor?.sub ||
      !actor.roles?.some(
        (role) => role.system === 'VMMS' && role.role === 'OPERATIONS',
      )
    ) {
      throw new ForbiddenException(
        'Only Operations can save an Admin-authorized maintenance-log edit.',
      );
    }
    if (!data || Object.keys(data).length === 0)
      throw new BadRequestException(
        'Provide at least one maintenance-log field to update.',
      );

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM maintenance_schedules WHERE id = ${id}::uuid FOR UPDATE`;
      const schedule = await tx.maintenanceSchedule.findFirst({
        where: { id, deletedAt: null },
      });
      if (!schedule) throw new NotFoundException('Maintenance log not found.');
      this.assertMaintenanceLogClosed(schedule);

      const now = new Date();
      const unlock = await tx.maintenanceLogEditUnlock.findFirst({
        where: {
          scheduleId: id,
          consumedAt: null,
          reviewStatus: MaintenanceCancellationReviewStatus.APPROVED,
          activatedAt: { gte: new Date(now.getTime() - 15 * 60 * 1000) },
        },
        orderBy: { activatedAt: 'desc' },
      });
      if (!unlock)
        throw new ForbiddenException(
          'An active Admin unlock with a reason is required before editing this maintenance log.',
        );

      const progress = this.asProgressRecord(schedule.workOrderProgress);
      const currentPartDetails =
        progress.partDetails && typeof progress.partDetails === 'object'
          ? (progress.partDetails as Record<string, unknown>)
          : {};
      const nextPartDetails = data.partDetails ?? currentPartDetails;
      const nextClass = data.maintenanceClass ?? progress.maintenanceClass;
      const nextRemarks =
        data.maintenanceRemarks ?? progress.maintenanceRemarks;
      const nextOdometer =
        data.serviceOdometerReading ??
        progress.serviceOdometerReading ??
        schedule.odometerReading;
      const nextLaborCost =
        data.laborCost ??
        this.normalizeCostValue(progress.laborCost) ??
        this.normalizeCostValue(schedule.laborCost);

      if (
        data.maintenanceClass !== undefined &&
        !['REPAIR', 'PREVENTIVE'].includes(data.maintenanceClass)
      )
        throw new BadRequestException(
          'Maintenance type must be Repair or Preventive.',
        );
      if (
        data.maintenanceRemarks !== undefined &&
        (typeof data.maintenanceRemarks !== 'string' ||
          !data.maintenanceRemarks.trim())
      )
        throw new BadRequestException('Work description cannot be empty.');
      if (
        data.serviceOdometerReading !== undefined &&
        (!Number.isSafeInteger(data.serviceOdometerReading) ||
          data.serviceOdometerReading <= 0)
      )
        throw new BadRequestException(
          'Service odometer must be a positive whole number.',
        );
      if (
        data.laborCost !== undefined &&
        (!Number.isFinite(data.laborCost) || data.laborCost < 0)
      )
        throw new BadRequestException('Labor cost must be zero or greater.');

      const hasItemizedPartDetails =
        data.partDetails !== undefined ||
        Boolean(
          progress.partDetails && typeof progress.partDetails === 'object',
        );
      const partsCost = hasItemizedPartDetails
        ? this.calculateItemizedPartsCost(nextPartDetails)
        : (this.normalizeCostValue(schedule.partsCost) ?? 0);
      const labor = this.normalizeCostValue(nextLaborCost);
      if (labor == null)
        throw new BadRequestException(
          'A labor cost is required to compute the total maintenance cost.',
        );
      const totalCost = Number((partsCost + labor).toFixed(2));

      const before: Record<string, unknown> = {
        maintenanceClass: progress.maintenanceClass ?? null,
        maintenanceRemarks: progress.maintenanceRemarks ?? null,
        serviceOdometerReading:
          progress.serviceOdometerReading ?? schedule.odometerReading ?? null,
        laborCost:
          this.normalizeCostValue(progress.laborCost) ??
          this.normalizeCostValue(schedule.laborCost),
        partDetails: currentPartDetails,
        partsCost: this.normalizeCostValue(schedule.partsCost),
        totalCost: this.normalizeCostValue(schedule.totalCost),
      };
      const after: Record<string, unknown> = {
        maintenanceClass: nextClass ?? null,
        maintenanceRemarks: nextRemarks ?? null,
        serviceOdometerReading: nextOdometer ?? null,
        laborCost: labor,
        partDetails: nextPartDetails,
        partsCost,
        totalCost,
      };
      const changedFieldSet = new Set(Object.keys(data));
      for (const field of ['partsCost', 'totalCost']) {
        if (JSON.stringify(before[field]) !== JSON.stringify(after[field]))
          changedFieldSet.add(field);
      }
      const changedFields = [...changedFieldSet].filter(
        (field) =>
          JSON.stringify(before[field]) !== JSON.stringify(after[field]),
      );

      const consumed = await tx.maintenanceLogEditUnlock.updateMany({
        where: {
          id: unlock.id,
          consumedAt: null,
          createdAt: { gte: new Date(now.getTime() - 15 * 60 * 1000) },
        },
        data: { consumedAt: now },
      });
      if (consumed.count !== 1)
        throw new ConflictException(
          'The Admin unlock expired or was already consumed. Request a new unlock.',
        );

      if (changedFields.length) {
        const nextProgress = {
          ...progress,
          maintenanceClass: nextClass,
          maintenanceRemarks: nextRemarks,
          serviceOdometerReading: nextOdometer,
          laborCost: labor,
          partDetails: nextPartDetails,
          ...(schedule.status === MaintenanceStatus.CANCELLED
            ? { maintenanceLogLocked: true }
            : {}),
        } as Prisma.InputJsonObject;
        const changed = await tx.maintenanceSchedule.updateMany({
          where: {
            id,
            status: schedule.status,
            updatedAt: schedule.updatedAt,
            deletedAt: null,
          },
          data: {
            workOrderProgress: nextProgress,
            odometerReading: Number(nextOdometer),
            partsCost,
            laborCost: labor,
            totalCost,
          },
        });
        if (changed.count !== 1)
          throw new ConflictException(
            'The maintenance log changed while saving. Request a new unlock and try again.',
          );
        await tx.maintenanceLogEditAudit.createMany({
          data: changedFields.map((fieldName) => ({
            scheduleId: id,
            unlockId: unlock.id,
            actorId: actor.sub,
            actorName: actor.name,
            actorEmail: actor.email,
            unlockReason: unlock.reason,
            fieldName,
            previousValue:
              before[fieldName] == null
                ? null
                : JSON.stringify(before[fieldName]),
            newValue:
              after[fieldName] == null
                ? null
                : JSON.stringify(after[fieldName]),
          })),
        });
      }

      const updated = await tx.maintenanceSchedule.findFirst({
        where: { id, deletedAt: null },
      });
      if (!updated)
        throw new NotFoundException('Maintenance log not found after save.');
      return {
        id: updated.id,
        status: updated.status,
        workOrderProgress: progressForClient(updated),
        partsCost,
        laborCost: labor,
        totalCost,
        relocked: true,
      };
    });
  }

  private assertMaintenanceLogClosed(
    schedule: Pick<MaintenanceSchedule, 'status' | 'workOrderProgress'>,
  ) {
    const progress = this.asProgressRecord(schedule.workOrderProgress);
    if (
      schedule.status !== MaintenanceStatus.COMPLETED &&
      !(
        schedule.status === MaintenanceStatus.CANCELLED &&
        progress.maintenanceLogLocked === true
      )
    ) {
      throw new BadRequestException(
        'Only Completed or Admin-cancelled maintenance logs can be unlocked and edited.',
      );
    }
  }

  private calculateItemizedPartsCost(partDetails: unknown): number {
    if (
      !partDetails ||
      typeof partDetails !== 'object' ||
      Array.isArray(partDetails)
    )
      return 0;
    return Number(
      Object.values(
        partDetails as Record<
          string,
          { partsUsed?: unknown; materialCost?: unknown }
        >,
      )
        .reduce((sum, part) => {
          if (typeof part.partsUsed !== 'string' || !part.partsUsed.trim())
            return sum;
          const amount = this.normalizeCostValue(part.materialCost);
          if (amount == null || amount < 0)
            throw new BadRequestException(
              'Every recorded part needs a valid non-negative material cost.',
            );
          return sum + amount;
        }, 0)
        .toFixed(2),
    );
  }

  async updateProgress(id: string, progress: unknown, actor: ScheduleActor) {
    const requestRecord = isRecord(progress) ? progress : {};
    const scope = scheduleScope(actor);
    const accessible = await this.prisma.maintenanceSchedule.findFirst({
      where: { id, deletedAt: null, ...scope },
    });
    if (!accessible)
      throw new ForbiddenException('This work order is not assigned to you.');
    let input = this.getUpdateProgressPayload(progress);
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new BadRequestException(
        'A work order progress object is required.',
      );
    const storedProgress = this.asProgressRecord(accessible.workOrderProgress);
    const storedParts =
      storedProgress.partDetails &&
      typeof storedProgress.partDetails === 'object'
        ? (storedProgress.partDetails as Record<string, unknown>)
        : {};
    const requestedProgress = input as Record<string, unknown>;
    const requestedParts =
      requestedProgress.partDetails &&
      typeof requestedProgress.partDetails === 'object'
        ? (requestedProgress.partDetails as Record<string, unknown>)
        : {};
    let preserveAttachmentState = false;
    const mergedParts = { ...requestedParts };
    for (const [itemId, storedValue] of Object.entries(storedParts)) {
      const storedEntry =
        storedValue && typeof storedValue === 'object'
          ? (storedValue as Record<string, unknown>)
          : {};
      if (!Array.isArray(storedEntry.attachments)) continue;
      preserveAttachmentState = true;
      const requestedValue = requestedParts[itemId];
      const requestedEntry =
        requestedValue && typeof requestedValue === 'object'
          ? (requestedValue as Record<string, unknown>)
          : {};
      mergedParts[itemId] = {
        ...storedEntry,
        ...requestedEntry,
        attachments: storedEntry.attachments,
      };
    }
    if (preserveAttachmentState) {
      input = {
        ...requestedProgress,
        partDetails: mergedParts,
      } as Prisma.InputJsonObject;
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
    for (const source of [requestRecord, input]) {
      if (!isRecord(source)) continue;
      for (const [field, current] of Object.entries(assignments)) {
        if (!(field in source)) continue;
        // Older mobile clients send an empty inspector display name. Ignore it;
        // it must never clear the assignment saved by Operations.
        if (field === 'chiefMechanic' && source[field] === '') continue;
        if (source[field] !== current) {
          throw new ForbiddenException(
            'Only Operations can change mechanic assignments through schedule editing.',
          );
        }
      }
    }
    let assignedItems: AssignedChecklistItem[] | undefined;
    const action = requestRecord.action;
    if (action === 'SUBMIT') {
      if (!accessible.checklistTemplateId) {
        throw new BadRequestException(
          'No checklist is assigned. Ask Operations to assign a checklist before submitting.',
        );
      }
      assignedItems = await this.prisma.checklistItem.findMany({
        where: {
          checklistTemplateId: accessible.checklistTemplateId,
          deletedAt: null,
        },
        select: { id: true, text: true },
        orderBy: { order: 'asc' },
      });
    }
    const workflow = applyWorkOrderWorkflow(
      accessible,
      requestedProgress,
      action,
      actor,
      assignedItems,
    );
    const workCompletedAt =
      action === 'SUBMIT' ? new Date() : undefined;
    const recordedWorkCompletedAt = this.asProgressRecord(
      accessible.workOrderProgress,
    ).workCompletedAt;
    const progressToPersist = workCompletedAt
      ? {
          ...workflow.progress,
          workCompletedAt: workCompletedAt.toISOString(),
        }
      : typeof recordedWorkCompletedAt === 'string'
        ? { ...workflow.progress, workCompletedAt: recordedWorkCompletedAt }
        : workflow.progress;
    const normalizedProgress = progressToPersist as Prisma.InputJsonObject;
    const progressRecord = workflow.progress;
    const serviceOdometer = progressRecord.serviceOdometerReading;
    if (action === 'SUBMIT') {
      if (
        typeof accessible.vehicleId !== 'string' ||
        !accessible.vehicleId.trim()
      )
        throw new BadRequestException(
          'A truck plate is required before submitting the maintenance log.',
        );
      if (
        typeof serviceOdometer !== 'number' ||
        !Number.isSafeInteger(serviceOdometer) ||
        serviceOdometer <= 0
      )
        throw new BadRequestException(
          'Enter a valid odometer reading at time of service.',
        );
      if (
        typeof accessible.assignedMechanic !== 'string' ||
        !accessible.assignedMechanic.trim()
      )
        throw new BadRequestException(
          'An assigned mechanic is required before submitting the maintenance log.',
        );
      if (
        typeof progressRecord.maintenanceClass !== 'string' ||
        !['REPAIR', 'PREVENTIVE'].includes(progressRecord.maintenanceClass)
      )
        throw new BadRequestException(
          'Select Repair or Preventive as the maintenance type.',
        );
      if (
        typeof progressRecord.maintenanceRemarks !== 'string' ||
        !progressRecord.maintenanceRemarks.trim()
      )
        throw new BadRequestException(
          'Describe the work performed before submitting the maintenance log.',
        );
      const labor = progressRecord.laborCost;
      if (
        labor == null ||
        labor === '' ||
        !Number.isFinite(Number(labor)) ||
        Number(labor) < 0
      )
        throw new BadRequestException(
          'Enter a valid labor cost of zero or more before submitting the maintenance log.',
        );
    }
    const laborCost = this.normalizeCostValue(
      progressRecord.laborCost ?? accessible.laborCost,
    );
    const partDetails =
      progressRecord.partDetails &&
      typeof progressRecord.partDetails === 'object'
        ? Object.values(
            progressRecord.partDetails as Record<
              string,
              { partsUsed?: unknown; materialCost?: unknown }
            >,
          )
        : [];
    const partsCost = partDetails.reduce((sum, part) => {
      if (typeof part.partsUsed !== 'string' || !part.partsUsed.trim())
        return sum;
      const amount = this.normalizeCostValue(part.materialCost);
      return amount != null && amount >= 0 ? sum + amount : sum;
    }, 0);
    const normalizedCosts = {
      partsCost:
        action === 'SUBMIT' || partDetails.length
          ? Number(partsCost.toFixed(2))
          : this.normalizeCostValue(accessible.partsCost),
      laborCost,
      totalCost:
        laborCost == null
          ? this.normalizeCostValue(accessible.totalCost)
          : Number((partsCost + laborCost).toFixed(2)),
    };

    const payload: Record<string, any> = {
      status: workflow.status,
      ...stateForStorage(progressToPersist, workflow.status),
      ...(workflow.status === MaintenanceStatus.COMPLETED
        ? { completedAt: new Date() }
        : {}),
      ...(action === 'SUBMIT' ? { odometerReading: serviceOdometer } : {}),
      partsCost: normalizedCosts.partsCost ?? undefined,
      laborCost: normalizedCosts.laborCost ?? undefined,
      totalCost: normalizedCosts.totalCost ?? undefined,
    };

    if (action === 'SUBMIT' && !accessible.logNumber) {
      const [generatedLog] = await this.prisma.$queryRaw<
        Array<{ logNumber: string }>
      >`
        SELECT 'MLG-' || TO_CHAR(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila', 'YYYYMMDD') || '-' ||
          LPAD(NEXTVAL('maintenance_log_number_seq')::TEXT, 4, '0') AS "logNumber"
      `;
      if (!generatedLog?.logNumber)
        throw new BadRequestException(
          'Could not generate the maintenance log number. Please retry.',
        );
      payload.logNumber = generatedLog.logNumber;
    }

    if (normalizedProgress !== undefined) {
      payload.workOrderProgress = {
        ...stateForStorage(progressToPersist, workflow.status)
          .workOrderProgress,
        chiefMechanic: accessible.chiefMechanic ?? '',
      };
    }

    const { schedule, nextSchedule } = await this.prisma
      .$transaction(async (tx) => {
        if (action === 'SUBMIT') {
          const odometerToRecord = serviceOdometer;
          if (typeof odometerToRecord !== 'number') {
            throw new BadRequestException(
              'Enter a valid odometer reading at time of service.',
            );
          }
          const vehicles = await tx.$queryRaw<
            Array<{ id: string; odometer: number }>
          >`
          SELECT id, odometer
          FROM vehicles
          WHERE plate_number = ${accessible.vehicleId}
          FOR UPDATE
        `;
          const vehicle = vehicles[0];
          if (!vehicle)
            throw new BadRequestException(
              'The assigned truck could not be found.',
            );
          if (odometerToRecord < vehicle.odometer) {
            throw new BadRequestException(
              `Odometer reading cannot be lower than the last recorded reading (${vehicle.odometer}).`,
            );
          }
        }

        const updated = await tx.maintenanceSchedule.update({
          where: {
            id,
            deletedAt: null,
            updatedAt: accessible.updatedAt,
            AND: scope,
          },
          data: payload,
        });
        let nextSchedule: MaintenanceSchedule | null = null;
        if (workflow.status === MaintenanceStatus.COMPLETED) {
          nextSchedule = await this.createNextRecurringSchedule(tx, updated);
        }
        return { schedule: updated, nextSchedule };
      })
      .catch((error: unknown) =>
        this.handleScheduleWriteConflict(
          error,
          {
            vehicleId: accessible.vehicleId,
            title: accessible.title,
            status: MaintenanceStatus.PENDING,
          },
          id,
        ),
      );
    await this.syncVehicleStatus(schedule.vehicleId, schedule.status);

    const costs = this.normalizeCostPayload({
      partsCost: schedule.partsCost,
      laborCost: schedule.laborCost,
      totalCost: schedule.totalCost,
    });
    const canonical = this.canonicalScheduleFields(schedule);
    const nextCanonical = nextSchedule
      ? this.canonicalScheduleFields(nextSchedule)
      : null;

    return {
      id: schedule.id,
      logNumber: schedule.logNumber,
      status: schedule.status,
      computedStatus: canonical.computedStatus,
      targetDueDate: this.formatDateOnly(schedule.targetDueDate),
      dueDate: canonical.dueDate,
      dueOdometer: canonical.dueOdometer,
      nextSchedule: nextSchedule
        ? {
            id: nextSchedule.id,
            status: nextSchedule.status,
            computedStatus: nextCanonical?.computedStatus,
            targetDueDate: this.formatDateOnly(nextSchedule.targetDueDate),
            dueDate: nextCanonical?.dueDate ?? null,
            dueOdometer: nextCanonical?.dueOdometer ?? null,
          }
        : null,
      approvalStatus: schedule.approvalStatus,
      workOrderProgress: progressForClient(schedule),
      ...(this.canViewMaintenanceCosts(actor)
        ? {
            partsCost: costs.partsCost,
            laborCost: costs.laborCost,
            totalCost: costs.totalCost,
          }
        : {}),
    };
  }

  private getUpdateProgressPayload(
    progress: unknown,
  ): Prisma.InputJsonValue | undefined {
    if (progress == null) return undefined;

    const progressRecord = isRecord(progress) ? progress : undefined;
    const explicitProgress = progressRecord
      ? (progressRecord.workOrderProgress ?? progressRecord.work_order_progress)
      : undefined;

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
      progressRecord !== undefined &&
      Object.keys(progressRecord).length > 0 &&
      Object.keys(progressRecord).every((key) => costKeys.includes(key));

    if (Array.isArray(progress) || !hasOnlyCostKeys) {
      return this.normalizeWorkOrderProgress(progress);
    }

    return undefined;
  }

  async remove(id: string, actor: ScheduleActor) {
    const schedule = await this.prisma.maintenanceSchedule.findFirst({
      where: { id, deletedAt: null },
    });
    if (!schedule)
      throw new NotFoundException('Maintenance schedule not found.');
    const progress = this.asProgressRecord(schedule.workOrderProgress);
    const isMaintenanceLog =
      Boolean(schedule.logNumber) ||
      schedule.status === MaintenanceStatus.COMPLETED ||
      progress.maintenanceLogLocked === true;
    if (
      !actor?.sub ||
      !actor.roles?.some(
        (role) => role.system === 'VMMS' && role.role === 'ADMIN',
      )
    ) {
      throw new ForbiddenException(
        isMaintenanceLog
          ? 'Deletion is restricted to Admin only. You may void this record instead.'
          : 'Only Admin can deactivate a schedule. Operations must submit a cancellation request.',
      );
    }
    await this.prisma.maintenanceSchedule.update({
      where: { id, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    return { success: true };
  }

  async voidMaintenanceLog(id: string, reason: unknown, actor: ScheduleActor) {
    if (
      !actor?.sub ||
      !actor.roles?.some(
        (role) => role.system === 'VMMS' && role.role === 'OPERATIONS',
      )
    ) {
      throw new ForbiddenException(
        'Only Operations can void a maintenance log.',
      );
    }
    if (
      typeof reason !== 'string' ||
      !reason.trim() ||
      reason.trim().length > 2000
    ) {
      throw new BadRequestException(
        'A void reason of 1 to 2000 characters is required.',
      );
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM maintenance_schedules WHERE id = ${id}::uuid FOR UPDATE`;
        const schedule = await tx.maintenanceSchedule.findFirst({
          where: { id, deletedAt: null },
        });
        if (!schedule)
          throw new NotFoundException('Maintenance log not found.');
        if (!schedule.logNumber)
          throw new BadRequestException(
            'Only a persisted maintenance log can be voided.',
          );
        if (schedule.status !== MaintenanceStatus.COMPLETED) {
          throw new BadRequestException(
            'Only a completed maintenance log can be submitted for void approval.',
          );
        }
        const pendingRequest =
          await tx.maintenanceScheduleCancellation.findFirst({
            where: {
              scheduleId: id,
              reviewStatus: MaintenanceCancellationReviewStatus.PENDING,
            },
            select: { id: true },
          });
        if (pendingRequest)
          throw new ConflictException(
            'A cancellation or void request is already awaiting Admin review.',
          );

        // Prevent any previously authorized edit from being used while the Admin
        // decides whether this completed log should be voided.
        await tx.maintenanceLogEditUnlock.updateMany({
          where: { scheduleId: id, consumedAt: null },
          data: { consumedAt: new Date() },
        });
        // The log remains Completed until the Admin approves this request.
        await tx.maintenanceScheduleCancellation.create({
          data: {
            scheduleId: id,
            actorId: actor.sub,
            actorName: actor.name,
            actorEmail: actor.email,
            reason: reason.trim(),
            previousStatus: schedule.status,
            reviewStatus: MaintenanceCancellationReviewStatus.PENDING,
          },
        });
        return {
          id,
          status: schedule.status,
          cancellations: await tx.maintenanceScheduleCancellation.findMany({
            where: { scheduleId: id },
            orderBy: { createdAt: 'desc' },
          }),
        };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'A cancellation or void request is already awaiting Admin review.',
        );
      }
      throw error;
    }
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

  private toDateOrNull(value: Date | string | null | undefined): Date | null {
    if (value == null) return null;
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const parsed = new Date(`${value}T00:00:00.000Z`);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private manilaDateString(now = new Date()): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Manila',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  }

  private canonicalScheduleFields(schedule: CanonicalScheduleLike) {
    const normalized = {
      triggerType: (schedule.triggerType ?? null) as MaintenanceTriggerType | null,
      intervalType: (schedule.intervalType ?? null) as string | null,
      targetDueDate: this.toDateOrNull(schedule.targetDueDate),
      startReferenceDate: this.toDateOrNull(schedule.startReferenceDate),
      timeIntervalValue: schedule.timeIntervalValue ?? null,
      timeIntervalUnit: schedule.timeIntervalUnit ?? null,
      startingReferenceReadingKm: schedule.startingReferenceReadingKm ?? null,
      odometerReading: schedule.odometerReading ?? null,
      intervalKm: schedule.intervalKm ?? null,
      bufferDistanceKm: schedule.bufferDistanceKm ?? null,
    };

    const due = scheduleDue(normalized as any);
    const status = (schedule.status ?? MaintenanceStatus.PENDING) as MaintenanceStatus;
    let computedStatus: MaintenanceStatus = status;

    if (
      status === MaintenanceStatus.PENDING ||
      status === MaintenanceStatus.DUE ||
      status === MaintenanceStatus.OVERDUE
    ) {
      if (normalized.triggerType === MaintenanceTriggerType.TIME && due.dueDate) {
        const today = this.manilaDateString();
        if (today < due.dueDate) computedStatus = MaintenanceStatus.PENDING;
        else if (today === due.dueDate) computedStatus = MaintenanceStatus.DUE;
        else computedStatus = MaintenanceStatus.OVERDUE;
      }
      // Odometer-derived PENDING/DUE/OVERDUE requires current vehicle odometer; preserve stored status when unavailable.
    }

    return {
      dueDate: due.dueDate,
      dueOdometer: due.dueOdometer,
      computedStatus,
    };
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
  }): {
    partsCost: number | null;
    laborCost: number | null;
    totalCost: number | null;
  } {
    const partsCost = this.normalizeCostValue(values.partsCost);
    const laborCost = this.normalizeCostValue(values.laborCost);
    // Total is derived exclusively from its components. Never accept a client
    // supplied/stale total as authoritative.
    const totalCost =
      partsCost != null && laborCost != null
        ? Number((partsCost + laborCost).toFixed(2))
        : null;

    return { partsCost, laborCost, totalCost };
  }

  private normalizeWorkOrderProgress(
    progress: unknown,
  ): Prisma.InputJsonValue | undefined {
    if (progress == null) {
      return undefined;
    }

    const normalize = (
      value: unknown,
    ): Prisma.InputJsonValue | null | undefined => {
      if (Array.isArray(value)) {
        return value.map((item) => normalize(item) ?? null);
      }
      if (isRecord(value)) {
        const entries = Object.entries(value).flatMap(([key, entry]) => {
          const normalized = normalize(entry);
          if (normalized === undefined) return [];
          return [
            [
              key,
              key.match(/^(note|notes)$/i) && normalized === null
                ? ''
                : normalized,
            ] as const,
          ];
        });
        return Object.fromEntries(entries);
      }
      if (
        value === null ||
        typeof value === 'string' ||
        typeof value === 'boolean' ||
        typeof value === 'number'
      ) {
        return value;
      }
      return undefined;
    };

    const normalized = normalize(progress);
    return normalized ?? undefined;
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
    const users = await this.prisma.mechanic.findMany({
      where: {
        ...(data.assignedMechanicId
          ? { userId: data.assignedMechanicId }
          : { name: { equals: name, mode: 'insensitive' as const } }),
        isOutsourced: false,
        isActive: true,
        role: 'MECHANIC',
      },
      select: { userId: true, name: true, temporaryRoles: true },
      take: 2,
    });
    const eligible = users.filter(
      (user) => !user.temporaryRoles.includes('MECHANIC'),
    );
    if (eligible.length !== 1 || !eligible[0].userId)
      throw new BadRequestException(
        'Choose one active VMMS mechanic using assignedMechanicId; the name is missing or ambiguous.',
      );
    return {
      assignedMechanic: eligible[0].name,
      assignedMechanicId: eligible[0].userId,
    };
  }

  private async resolveOutsourcedProvider(
    client: PrismaService | Prisma.TransactionClient,
    data: CreateMaintenanceScheduleDto,
    previous?: {
      accountType: AccountType | null;
      outsourcedProvider: string | null;
    },
  ): Promise<string | null> {
    const accountType =
      data.accountType ?? data.account_type ?? previous?.accountType;
    if (accountType !== AccountType.OUTSOURCED) return null;
    const requested =
      data.outsourcedProvider?.trim() ?? previous?.outsourcedProvider?.trim();
    if (!requested)
      throw new BadRequestException(
        'Choose a registered outsourced service provider.',
      );
    const isExistingProvider =
      previous?.outsourcedProvider?.trim().toLowerCase() ===
      requested.toLowerCase();
    const provider = await client.outsourcedProvider.findFirst({
      where: {
        name: { equals: requested, mode: 'insensitive' },
        ...(!isExistingProvider ? { isActive: true } : {}),
      },
      select: { name: true },
    });
    if (!provider)
      throw new BadRequestException(
        'Choose an active provider from the registered list.',
      );
    return provider.name;
  }

  private getAssignedMechanic(data: CreateMaintenanceScheduleDto): string {
    const assignedMechanic = data.assignedMechanic ?? data.assignedDriver;

    if (!assignedMechanic?.trim()) {
      throw new BadRequestException('assignedMechanic is required');
    }

    return assignedMechanic;
  }

  private async createNextRecurringSchedule(
    tx: Prisma.TransactionClient,
    schedule: MaintenanceSchedule,
  ): Promise<MaintenanceSchedule | null> {
    if (schedule.status !== MaintenanceStatus.COMPLETED || schedule.deletedAt)
      return null;

    const odometerRecurring =
      schedule.triggerType === MaintenanceTriggerType.ODOMETER;
    const timeRecurring = schedule.triggerType === MaintenanceTriggerType.TIME;

    if (!odometerRecurring && !timeRecurring) return null;

    const existing = await tx.maintenanceSchedule.findUnique({
      where: { previousScheduleId: schedule.id },
    });
    if (existing) return existing;
    await this.assertNoPendingDuplicate(tx, {
      vehicleId: schedule.vehicleId,
      title: schedule.title,
    });

    if (
      odometerRecurring &&
      (!Number.isInteger(schedule.intervalKm) || schedule.intervalKm! <= 0)
    ) {
      throw new BadRequestException(
        'Configure a positive odometer interval before approving recurring maintenance.',
      );
    }
    const vehicle = await tx.vehicle.findFirst({
      where: {
        plateNumber: schedule.vehicleId,
        isActive: true,
        deletedAt: null,
      },
      select: { odometer: true, garageId: true },
    });
    if (!vehicle || !vehicle.garageId) {
      throw new BadRequestException(
        'The assigned truck must be active and have a registered garage before approving recurring maintenance.',
      );
    }
    if (
      !Number.isInteger(vehicle.odometer) ||
      vehicle.odometer < 0 ||
      vehicle.odometer > 2147483647
    ) {
      throw new BadRequestException(
        'Record a valid current odometer reading before approving recurring maintenance.',
      );
    }

    const progress = this.asProgressRecord(schedule.workOrderProgress);
    const completionOdometer =
      progress.serviceOdometerReading ?? schedule.odometerReading;
    if (
      odometerRecurring &&
      (typeof completionOdometer !== 'number' ||
        !Number.isSafeInteger(completionOdometer) ||
        completionOdometer <= 0 ||
        completionOdometer > 2147483647)
    ) {
      throw new BadRequestException(
        'Record a valid odometer reading at service submission before approving recurring maintenance.',
      );
    }
    if (
      odometerRecurring &&
      vehicle.odometer < (completionOdometer as number)
    ) {
      throw new BadRequestException(
        'The truck master odometer is behind the recorded service odometer; reconcile the reading before approving recurring maintenance.',
      );
    }
    if (
      odometerRecurring &&
      (completionOdometer as number) + schedule.intervalKm! > 2147483647
    ) {
      throw new BadRequestException(
        'The next odometer threshold exceeds the supported mileage range.',
      );
    }

    const rawWorkCompletedAt = progress.workCompletedAt;
    const workCompletedAt =
      typeof rawWorkCompletedAt === 'string' &&
      Number.isFinite(Date.parse(rawWorkCompletedAt))
        ? new Date(rawWorkCompletedAt)
        : (schedule.completedAt ?? schedule.updatedAt);
    // Older completed records lack a submission timestamp; their approval time is the best available anchor.
    const completionDay = this.formatDateOnly(workCompletedAt);
    if (!completionDay) {
      throw new BadRequestException(
        'A valid work-completion date is required before approving recurring maintenance.',
      );
    }
    const referenceDate = new Date(`${completionDay}T00:00:00.000Z`);
    const timeInterval = getTimeInterval(schedule) ?? {
      value: 3,
      unit: 'MONTHS' as const,
    };
    const timeFields = timeRecurring
      ? validateTimeSchedule({
          vehicleId: schedule.vehicleId,
          title: schedule.title,
          triggerType: MaintenanceTriggerType.TIME,
          timeIntervalValue: timeInterval.value,
          timeIntervalUnit: timeInterval.unit,
          startReferenceDate: completionDay,
        })
      : {};

    return tx.maintenanceSchedule.upsert({
      where: { previousScheduleId: schedule.id },
      update: {},
      create: {
        vehicleId: schedule.vehicleId,
        title: schedule.title,
        status: MaintenanceStatus.PENDING,
        priority: schedule.priority,
        assignedMechanic: schedule.assignedMechanic,
        assignedMechanicId: schedule.assignedMechanicId,
        chiefMechanicId: schedule.chiefMechanicId,
        chiefMechanic: schedule.chiefMechanic,
        accountType: schedule.accountType,
        outsourcedProvider: schedule.outsourcedProvider,
        checklistTemplateId: schedule.checklistTemplateId,
        garageId: vehicle.garageId,
        odometerReading: vehicle.odometer,
        triggerType: schedule.triggerType,
        intervalKm: schedule.intervalKm,
        bufferDistanceKm: odometerRecurring
          ? (schedule.bufferDistanceKm ?? 0)
          : schedule.bufferDistanceKm,
        startingReferenceReadingKm: odometerRecurring
          ? (completionOdometer as number)
          : null,
        intervalType: schedule.intervalType,
        startReferenceDate: timeRecurring ? referenceDate : null,
        previousScheduleId: schedule.id,
        startDate: referenceDate,
        ...timeFields,
      },
    });
  }

  private async resolveChiefMechanic(
    data: CreateMaintenanceScheduleDto,
  ): Promise<{
    chiefMechanicId: string | null;
    chiefMechanic: string | null;
  }> {
    const rawId = data.chiefMechanicId ?? data.chief_mechanic_id;
    const rawName = data.chiefMechanic ?? data.chief_mechanic;

    if (rawId && rawId.trim()) {
      const user = await this.prisma.mechanic.findFirst({
        where: { userId: rawId, isOutsourced: false },
        select: {
          userId: true,
          name: true,
          isActive: true,
          role: true,
          temporaryRoles: true,
        },
      });

      if (!user) {
        throw new BadRequestException(
          `Chief Mechanic with ID ${rawId} was not found.`,
        );
      }

      if (!user.isActive) {
        throw new BadRequestException(
          `Selected Chief Mechanic (${user.name}) is inactive.`,
        );
      }

      const hasChiefMechanicRole =
        user.role === 'CHIEF_MECHANIC' &&
        !user.temporaryRoles.includes('CHIEF_MECHANIC');

      if (!hasChiefMechanicRole) {
        throw new BadRequestException(
          `Selected user (${user.name}) does not have the Chief Mechanic role.`,
        );
      }

      return {
        chiefMechanicId: user.userId!,
        chiefMechanic: user.name,
      };
    }

    if (rawName && rawName.trim()) {
      const user = await this.prisma.mechanic.findFirst({
        where: {
          isOutsourced: false,
          OR: [{ name: rawName.trim() }, { email: rawName.trim() }],
        },
        select: {
          userId: true,
          name: true,
          role: true,
          temporaryRoles: true,
          isActive: true,
        },
      });

      if (
        user &&
        user.userId &&
        user.isActive &&
        user.role === 'CHIEF_MECHANIC' &&
        !user.temporaryRoles.includes('CHIEF_MECHANIC')
      ) {
        return {
          chiefMechanicId: user.userId,
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
