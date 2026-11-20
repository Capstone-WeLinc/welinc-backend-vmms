import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  PayloadTooLargeException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Readable } from 'node:stream';
import { extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../../shared/prisma.service';
import {
  BlobStorageService,
  StorageUnavailableException,
} from '../../../shared/blob-storage.service';
import type { FuelFillUpDto } from './fuel.dto';
import { computeFuelEfficiency, isFuelEfficiencyAnomaly } from './fuel-math';
import { MAX_FUEL_ANOMALY_ATTACHMENT_BYTES } from './fuel.constants';
import {
  type FuelReceiptFile,
  validateFuelReceiptFile,
} from './fuel-receipt-file';

export type FuelActor = {
  sub: string;
  email: string;
  roles: Array<{ system: string; role: string }>;
};
const includeFuel = {
  vehicle: { select: { id: true, plateNumber: true, model: true } },
  station: true,
  anomaly: true,
  receipt: true,
} as const;
type FuelTransaction = Prisma.TransactionClient | PrismaService;
type FuelEntry = Prisma.FuelFillUpGetPayload<{ include: typeof includeFuel }>;
type FuelOdometerEntry = Pick<
  Prisma.FuelFillUpGetPayload<object>,
  'odometer' | 'createdAt'
>;
const money = (value: unknown) => Number(value ?? 0);
const currentFuelDate = () => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values['year']}-${values['month']}-${values['day']}`;
};

@Injectable()
export class FuelService {
  private readonly logger = new Logger(FuelService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly storage?: BlobStorageService,
  ) {}

  private fileStorage(): BlobStorageService {
    if (!this.storage) throw new StorageUnavailableException();
    return this.storage;
  }

  private has(actor: FuelActor, ...roles: string[]) {
    return (
      actor.roles?.some((r) => r.system === 'VMMS' && roles.includes(r.role)) ??
      false
    );
  }
  private require(actor: FuelActor, ...roles: string[]) {
    if (!this.has(actor, ...roles))
      throw new ForbiddenException(
        'You do not have access to this fuel action.',
      );
  }

  private async currentAnomalyThreshold(
    db: FuelTransaction = this.prisma,
  ): Promise<number> {
    const setting = await db.fuelAnomalySetting.findUnique({
      where: { id: 'default' },
    });
    return setting ? money(setting.thresholdPercent) : 20;
  }

  async getAnomalyThreshold(actor: FuelActor) {
    this.require(actor, 'ADMIN', 'OPERATIONS');
    const setting = await this.prisma.fuelAnomalySetting.findUnique({
      where: { id: 'default' },
    });
    return {
      thresholdPercent: setting ? money(setting.thresholdPercent) : 20,
      updatedAt: setting?.updatedAt ?? null,
      updatedByEmail: setting?.updatedByEmail ?? null,
    };
  }

  async updateAnomalyThreshold(thresholdPercent: number, actor: FuelActor) {
    this.require(actor, 'ADMIN');
    if (
      !Number.isFinite(thresholdPercent) ||
      thresholdPercent < 1 ||
      thresholdPercent > 99 ||
      Math.abs(thresholdPercent * 100 - Math.round(thresholdPercent * 100)) >
        1e-8
    ) {
      throw new BadRequestException(
        'Fuel anomaly threshold must be 1 to 99 percent with at most two decimal places.',
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const previous = await tx.fuelAnomalySetting.findUnique({
        where: { id: 'default' },
      });
      const saved = await tx.fuelAnomalySetting.upsert({
        where: { id: 'default' },
        create: {
          id: 'default',
          thresholdPercent,
          updatedById: actor.sub,
          updatedByEmail: actor.email,
        },
        update: {
          thresholdPercent,
          updatedById: actor.sub,
          updatedByEmail: actor.email,
        },
      });
      await tx.fuelAnomalyThresholdAudit.create({
        data: {
          actorId: actor.sub,
          actorEmail: actor.email,
          previousThreshold: previous?.thresholdPercent ?? null,
          newThreshold: thresholdPercent,
        },
      });
      return {
        thresholdPercent: money(saved.thresholdPercent),
        updatedAt: saved.updatedAt,
        updatedByEmail: saved.updatedByEmail,
      };
    });
  }

  async listStations() {
    return this.prisma.fuelStation.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
    });
  }
  async createStation(name: string) {
    const clean = name.trim();
    if (!clean || clean.length > 100)
      throw new BadRequestException(
        'Station name must be 1 to 100 characters.',
      );
    return this.prisma.fuelStation.create({ data: { name: clean } });
  }
  async setStationActive(id: string, isActive: boolean) {
    const result = await this.prisma.fuelStation.updateMany({
      where: { id },
      data: { isActive },
    });
    if (!result.count) throw new NotFoundException('Fuel station not found.');
    return this.prisma.fuelStation.findUniqueOrThrow({ where: { id } });
  }

  async list(actor: FuelActor, from?: string, to?: string) {
    this.require(actor, 'ADMIN', 'OPERATIONS');
    const dateWhere =
      from || to
        ? {
            entryDate: {
              ...(from ? { gte: new Date(`${from}T00:00:00.000Z`) } : {}),
              ...(to ? { lte: new Date(`${to}T00:00:00.000Z`) } : {}),
            },
          }
        : {};
    const entries = await this.prisma.fuelFillUp.findMany({
      where: dateWhere,
      include: includeFuel,
      orderBy: [{ entryDate: 'desc' }, { createdAt: 'desc' }],
    });
    return Promise.all(entries.map((entry) => this.toResponse(entry)));
  }

  async create(
    dto: FuelFillUpDto,
    actor: FuelActor,
    receiptFile?: FuelReceiptFile,
  ) {
    this.require(actor, 'OPERATIONS');
    const receiptImage = receiptFile
      ? validateFuelReceiptFile(receiptFile)
      : undefined;
    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id: dto.vehicleId, deletedAt: null, isActive: true },
    });
    if (!vehicle)
      throw new BadRequestException('Select an active registered vehicle.');
    const station = await this.prisma.fuelStation.findFirst({
      where: { id: dto.stationId, isActive: true },
    });
    if (!station)
      throw new BadRequestException(
        'Select an active registered fuel station.',
      );
    const latest = await this.prisma.fuelFillUp.findFirst({
      where: { vehicleId: vehicle.id, isVoided: false },
      orderBy: [{ odometer: 'desc' }, { createdAt: 'desc' }],
    });
    const lastOdometer = Math.max(vehicle.odometer, latest?.odometer ?? 0);
    if (dto.odometer < lastOdometer)
      throw new BadRequestException(
        `Odometer cannot be lower than the latest reading (${lastOdometer} km).`,
      );
    if (dto.date > currentFuelDate())
      throw new BadRequestException('Fuel-up date cannot be in the future.');
    const fillUpId = randomUUID();
    const receiptId = receiptFile ? randomUUID() : null;
    const storageName =
      receiptFile && receiptImage && receiptId
        ? `fuel-receipts/${fillUpId}/${receiptId}${receiptImage.extension}`
        : null;
    const fileStorage = receiptFile ? this.fileStorage() : undefined;

    if (receiptFile && receiptImage && storageName && fileStorage) {
      try {
        await fileStorage.put(
          storageName,
          receiptFile.buffer,
          receiptImage.contentType,
        );
      } catch (error) {
        await this.cleanupReceiptStorage(fileStorage, storageName);
        throw error;
      }
    }

    let entry: { id: string };
    try {
      entry = await this.prisma.$transaction(async (tx) => {
        const deviation = await this.currentAnomalyThreshold(tx);
        const created = await tx.fuelFillUp.create({
          data: {
            id: fillUpId,
            vehicleId: vehicle.id,
            stationId: station.id,
            enteredById: actor.sub,
            entryDate: new Date(`${dto.date}T00:00:00.000Z`),
            liters: dto.liters,
            pricePerLiter: dto.pricePerLiter,
            totalCost: Math.round(dto.liters * dto.pricePerLiter * 100) / 100,
            odometer: dto.odometer,
            isFullTank: dto.isFullTank,
            filledBy: dto.filledBy.trim(),
          },
          include: includeFuel,
        });
        if (receiptFile && receiptImage && receiptId && storageName) {
          await tx.fuelReceiptAttachment.create({
            data: {
              id: receiptId,
              fillUpId: created.id,
              name: `fuel-receipt${receiptImage.extension}`,
              storageName,
              contentType: receiptImage.contentType,
              uploadedById: actor.sub,
            },
          });
        }
        await tx.fuelAuditLog.create({
          data: {
            fillUpId: created.id,
            actorId: actor.sub,
            actorEmail: actor.email,
            action: 'CREATED',
            ...(receiptId
              ? { details: { receiptAttachmentId: receiptId } }
              : {}),
          },
        });
        const efficiency = await this.efficiencyFor(tx, created);
        if (dto.isFullTank && efficiency != null) {
          const previousCycles = await tx.fuelFillUp.findMany({
            where: {
              vehicleId: vehicle.id,
              id: { not: created.id },
              isVoided: false,
              isFullTank: true,
              OR: [
                { odometer: { lt: created.odometer } },
                {
                  odometer: created.odometer,
                  createdAt: { lt: created.createdAt },
                },
              ],
            },
            orderBy: [{ odometer: 'desc' }, { createdAt: 'desc' }],
            take: 2,
          });
          if (previousCycles.length >= 2) {
            const rollingEfficiencies = await this.priorEfficiencies(
              tx,
              vehicle.id,
              created,
            );
            const average = rollingEfficiencies.length
              ? rollingEfficiencies.reduce((a, b) => a + b, 0) /
                rollingEfficiencies.length
              : null;
            if (
              average != null &&
              isFuelEfficiencyAnomaly(efficiency, average, deviation)
            ) {
              await tx.fuelAnomaly.create({
                data: {
                  fillUpId: created.id,
                  vehicleId: vehicle.id,
                  efficiency,
                  rollingAverage: average,
                },
              });
              const recipients = await tx.vmmsPerson.findMany({
                where: {
                  isActive: true,
                  deleted: false,
                  erased: false,
                  roles: { hasSome: ['ADMIN', 'OPERATIONS'] },
                },
                select: { authUserId: true, roles: true, temporaryRoles: true },
              });
              const eligible = recipients.filter((person) =>
                person.roles.some(
                  (role) =>
                    ['ADMIN', 'OPERATIONS'].includes(role) &&
                    !person.temporaryRoles.includes(role),
                ),
              );
              if (eligible.length)
                await tx.notification.createMany({
                  data: eligible.map((person) => ({
                    userId: person.authUserId,
                    title: 'Fuel efficiency anomaly',
                    message: `${vehicle.plateNumber} recorded ${efficiency.toFixed(1)} km/L versus its ${average.toFixed(1)} km/L rolling average.`,
                    type: 'warning',
                  })),
                });
            }
          }
        }
        return created;
      });
    } catch (error) {
      if (fileStorage && storageName)
        await this.cleanupReceiptStorage(fileStorage, storageName);
      throw error;
    }
    return this.toResponse(
      await this.prisma.fuelFillUp.findUniqueOrThrow({
        where: { id: entry.id },
        include: includeFuel,
      }),
    );
  }

  async getReceiptAttachment(fillUpId: string, actor: FuelActor) {
    this.require(actor, 'OPERATIONS');
    const attachment = await this.prisma.fuelReceiptAttachment.findUnique({
      where: { fillUpId },
    });
    if (!attachment)
      throw new NotFoundException('Fuel receipt attachment not found.');
    const extension = extname(attachment.storageName).toLowerCase();
    const contentType = extension === '.png' ? 'image/png' : 'image/jpeg';
    if (
      attachment.storageName !==
        `fuel-receipts/${fillUpId}/${attachment.id}${extension}` ||
      !['.jpg', '.jpeg', '.png'].includes(extension) ||
      attachment.contentType !== contentType
    )
      throw new NotFoundException('Fuel receipt attachment not found.');
    return {
      name: attachment.name,
      contentType,
      stream: Readable.from([
        await this.fileStorage().get(attachment.storageName),
      ]),
    };
  }

  private async cleanupReceiptStorage(
    storage: BlobStorageService,
    storageName: string,
  ) {
    try {
      await storage.delete(storageName);
    } catch {
      this.logger.error(
        'Unable to remove an orphaned fuel receipt object after a failed save.',
      );
    }
  }

  async void(id: string, reason: string, actor: FuelActor) {
    this.require(actor, 'OPERATIONS');
    const cleanReason = reason.trim();
    if (!cleanReason)
      throw new BadRequestException(
        'A reason is required to void a fuel entry.',
      );
    const entry = await this.prisma.fuelFillUp.findUnique({ where: { id } });
    if (!entry) throw new NotFoundException('Fuel entry not found.');
    if (entry.isVoided) return { ...entry, isVoided: true };
    await this.prisma.$transaction(async (tx) => {
      await tx.fuelFillUp.update({
        where: { id },
        data: {
          isVoided: true,
          voidReason: cleanReason,
          voidedById: actor.sub,
          voidedAt: new Date(),
        },
      });
      await tx.fuelAuditLog.create({
        data: {
          fillUpId: id,
          actorId: actor.sub,
          actorEmail: actor.email,
          action: 'VOIDED',
          reason: cleanReason,
        },
      });
      await tx.fuelAnomaly.updateMany({
        where: { fillUpId: id, status: 'OPEN' },
        data: {
          status: 'RESOLVED',
          resolvedAt: new Date(),
          resolvedById: actor.sub,
        },
      });
    });
    return this.prisma.fuelFillUp.findUniqueOrThrow({
      where: { id },
      include: includeFuel,
    });
  }

  async anomalies(actor: FuelActor) {
    this.require(actor, 'ADMIN', 'OPERATIONS', 'CHIEF_MECHANIC');
    const rows = await this.prisma.fuelAnomaly.findMany({
      include: {
        vehicle: true,
        attachments: {
          select: { id: true, name: true, contentType: true, createdAt: true },
        },
        fillUp: { include: { station: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    const now = Date.now();
    return rows.map((a) => ({
      ...a,
      efficiency: money(a.efficiency),
      rollingAverage: money(a.rollingAverage),
      severity:
        a.status === 'RESOLVED'
          ? 'RESOLVED'
          : now - a.createdAt.getTime() >= 7 * 86400000
            ? 'CRITICAL'
            : now - a.createdAt.getTime() >= 3 * 86400000
              ? 'ESCALATED'
              : now - a.createdAt.getTime() >= 86400000
                ? 'DUE'
                : 'OPEN',
    }));
  }

  async updateAnomaly(id: string, input: { note?: string }, actor: FuelActor) {
    this.require(actor, 'OPERATIONS');
    const anomaly = await this.prisma.fuelAnomaly.findUnique({
      where: { id },
      include: { fillUp: true },
    });
    if (!anomaly || anomaly.status !== 'OPEN')
      throw new NotFoundException('Open fuel anomaly not found.');
    const critical = Date.now() - anomaly.createdAt.getTime() >= 7 * 86400000;
    if (input.note !== undefined) {
      const note = input.note.trim();
      return this.prisma.$transaction(async (tx) => {
        const saved = await tx.fuelAnomaly.updateMany({
          where: { id, status: 'OPEN' },
          data: { note, notedAt: new Date(), notedById: actor.sub },
        });
        if (!saved.count)
          throw new NotFoundException('Open fuel anomaly not found.');
        await tx.fuelAuditLog.create({
          data: {
            fillUpId: anomaly.fillUpId,
            actorId: actor.sub,
            actorEmail: actor.email,
            action: 'ANOMALY_NOTE',
            details: { anomalyId: id, note },
          },
        });
        return tx.fuelAnomaly.findUniqueOrThrow({ where: { id } });
      });
    }
    if (critical && !anomaly.acknowledgedAt)
      throw new BadRequestException(
        'Critical anomalies require Chief Mechanic or Admin acknowledgment before resolution.',
      );
    return this.prisma.$transaction(async (tx) => {
      const resolved = await tx.fuelAnomaly.updateMany({
        where: {
          id,
          status: 'OPEN',
          ...(critical ? { acknowledgedAt: { not: null } } : {}),
        },
        data: {
          status: 'RESOLVED',
          resolvedAt: new Date(),
          resolvedById: actor.sub,
        },
      });
      if (!resolved.count) {
        const current = await tx.fuelAnomaly.findUnique({ where: { id } });
        if (!current || current.status !== 'OPEN')
          throw new NotFoundException('Open fuel anomaly not found.');
        throw new BadRequestException(
          'Critical anomalies require Chief Mechanic or Admin acknowledgment before resolution.',
        );
      }
      await tx.fuelAuditLog.create({
        data: {
          fillUpId: anomaly.fillUpId,
          actorId: actor.sub,
          actorEmail: actor.email,
          action: 'ANOMALY_RESOLVED',
        },
      });
      return tx.fuelAnomaly.findUniqueOrThrow({ where: { id } });
    });
  }

  async acknowledgeAnomaly(
    id: string,
    remark: string | undefined,
    actor: FuelActor,
  ) {
    this.require(actor, 'CHIEF_MECHANIC', 'ADMIN');
    const anomaly = await this.prisma.fuelAnomaly.findUnique({ where: { id } });
    if (
      !anomaly ||
      anomaly.status !== 'OPEN' ||
      anomaly.acknowledgedAt ||
      Date.now() - anomaly.createdAt.getTime() < 7 * 86400000
    )
      throw new BadRequestException(
        'Only an unacknowledged open Critical anomaly can be acknowledged.',
      );
    const acknowledgment = remark?.trim() || null;
    return this.prisma.$transaction(async (tx) => {
      const acknowledged = await tx.fuelAnomaly.updateMany({
        where: {
          id,
          status: 'OPEN',
          acknowledgedAt: null,
          createdAt: { lte: new Date(Date.now() - 7 * 86400000) },
        },
        data: {
          acknowledgedAt: new Date(),
          acknowledgedById: actor.sub,
          acknowledgment,
        },
      });
      if (!acknowledged.count)
        throw new BadRequestException(
          'Only an unacknowledged open Critical anomaly can be acknowledged.',
        );
      await tx.fuelAuditLog.create({
        data: {
          fillUpId: anomaly.fillUpId,
          actorId: actor.sub,
          actorEmail: actor.email,
          action: 'ANOMALY_ACKNOWLEDGED',
          details: { anomalyId: id, remark: acknowledgment ?? '' },
        },
      });
      return tx.fuelAnomaly.findUniqueOrThrow({ where: { id } });
    });
  }

  async uploadAnomalyAttachment(
    id: string,
    file:
      { originalname: string; mimetype: string; buffer: Buffer } | undefined,
    actor: FuelActor,
  ) {
    this.require(actor, 'OPERATIONS');
    if (!file) throw new BadRequestException('Select a file to attach.');
    if (file.buffer.length > MAX_FUEL_ANOMALY_ATTACHMENT_BYTES)
      throw new PayloadTooLargeException(
        'Fuel anomaly reports cannot exceed 10 MB.',
      );
    const anomaly = await this.prisma.fuelAnomaly.findUnique({ where: { id } });
    if (!anomaly || anomaly.status !== 'OPEN')
      throw new NotFoundException('Open fuel anomaly not found.');
    if (Date.now() - anomaly.createdAt.getTime() < 3 * 86400000)
      throw new BadRequestException(
        'Formal report attachments are available from Day 3.',
      );
    const extension = extname(file.originalname).toLowerCase();
    const allowed: Record<string, string> = {
      '.pdf': 'application/pdf',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
    };
    if (!allowed[extension] || allowed[extension] !== file.mimetype)
      throw new BadRequestException(
        'Only PDF, JPG, and PNG files are allowed.',
      );
    const attachmentId = randomUUID();
    const storageName = `fuel-anomalies/${id}/${attachmentId}${extension}`;
    const fileStorage = this.fileStorage();
    await fileStorage.put(storageName, file.buffer, file.mimetype);
    try {
      const saved = await this.prisma.$transaction(async (tx) => {
        const attachment = await tx.fuelAnomalyAttachment.create({
          data: {
            id: attachmentId,
            anomalyId: id,
            name: file.originalname.replace(/[\\/\r\n]/g, '_').slice(0, 255),
            storageName,
            contentType: file.mimetype,
            uploadedById: actor.sub,
          },
        });
        await tx.fuelAuditLog.create({
          data: {
            fillUpId: anomaly.fillUpId,
            actorId: actor.sub,
            actorEmail: actor.email,
            action: 'ANOMALY_ATTACHMENT',
            details: { anomalyId: id, attachmentId },
          },
        });
        return attachment;
      });
      return saved;
    } catch (error) {
      await fileStorage.delete(storageName).catch(() => undefined);
      throw error;
    }
  }

  async getAnomalyAttachment(
    anomalyId: string,
    attachmentId: string,
    actor: FuelActor,
  ) {
    this.require(actor, 'ADMIN', 'OPERATIONS', 'CHIEF_MECHANIC');
    const attachment = await this.prisma.fuelAnomalyAttachment.findFirst({
      where: { id: attachmentId, anomalyId },
      include: { anomaly: true },
    });
    if (!attachment)
      throw new NotFoundException('Fuel anomaly attachment not found.');
    const extension = extname(attachment.storageName).toLowerCase();
    if (
      attachment.storageName !==
        `fuel-anomalies/${anomalyId}/${attachment.id}${extension}` ||
      !['.pdf', '.jpg', '.jpeg', '.png'].includes(extension)
    )
      throw new NotFoundException('Fuel anomaly attachment not found.');
    return {
      name: attachment.name,
      contentType: attachment.contentType,
      stream: Readable.from([
        await this.fileStorage().get(attachment.storageName),
      ]),
    };
  }

  async report(from?: string, to?: string, actor?: FuelActor) {
    if (actor) this.require(actor, 'ADMIN', 'OPERATIONS');
    const dateWhere =
      from || to
        ? {
            entryDate: {
              ...(from ? { gte: new Date(`${from}T00:00:00.000Z`) } : {}),
              ...(to ? { lte: new Date(`${to}T00:00:00.000Z`) } : {}),
            },
          }
        : {};
    const rows = await this.prisma.fuelFillUp.findMany({
      where: { isVoided: false, ...dateWhere },
      include: includeFuel,
      orderBy: { entryDate: 'desc' },
    });
    const entries = await Promise.all(rows.map((r) => this.toResponse(r)));
    const active = entries.filter((r) => !r.isVoided);
    const summaries = [...new Set(active.map((r) => r.vehicleId))].map(
      (vehicleId) => {
        const fillUps = active.filter((r) => r.vehicleId === vehicleId);
        const efficiencies = fillUps
          .map((r) => r.efficiency)
          .filter((n): n is number => n != null);
        return {
          vehicleId,
          vehicleName: fillUps[0].vehicleName,
          model: fillUps[0].vehicleModel,
          totalFillUps: fillUps.length,
          totalLiters: fillUps.reduce((s, r) => s + r.liters, 0),
          totalCost: fillUps.reduce((s, r) => s + r.totalCost, 0),
          averageEfficiency: efficiencies.length
            ? efficiencies.reduce((a, b) => a + b, 0) / efficiencies.length
            : null,
          anomalyCount: fillUps.filter((r) => Boolean(r.anomaly)).length,
        };
      },
    );
    return {
      entries,
      summaries,
      totals: {
        totalFillUps: active.length,
        totalLiters: active.reduce((s, r) => s + r.liters, 0),
        totalCost: active.reduce((s, r) => s + r.totalCost, 0),
        anomalyCount: summaries.reduce((s, r) => s + r.anomalyCount, 0),
      },
    };
  }

  async recordReportExport(
    format: string,
    from: string | undefined,
    to: string | undefined,
    actor: FuelActor,
  ) {
    this.require(actor, 'ADMIN', 'OPERATIONS');
    const normalizedFormat = format.trim().toLowerCase();
    if (!['csv', 'excel', 'pdf', 'print'].includes(normalizedFormat))
      throw new BadRequestException('Unsupported fuel report export format.');
    return this.prisma.fuelAuditLog.create({
      data: {
        fillUpId: null,
        actorId: actor.sub,
        actorEmail: actor.email,
        action: 'REPORT_EXPORTED',
        details: {
          format: normalizedFormat,
          from: from ?? null,
          to: to ?? null,
        },
      },
    });
  }

  private async priorEfficiencies(
    tx: FuelTransaction,
    vehicleId: string,
    entry: FuelOdometerEntry,
  ): Promise<number[]> {
    const fullTanks = await tx.fuelFillUp.findMany({
      where: {
        vehicleId,
        isVoided: false,
        isFullTank: true,
        OR: [
          { odometer: { lt: entry.odometer } },
          { odometer: entry.odometer, createdAt: { lt: entry.createdAt } },
        ],
      },
      orderBy: [{ odometer: 'desc' }, { createdAt: 'desc' }],
      take: 5,
    });
    const values: number[] = [];
    for (let i = 0; i < fullTanks.length - 1; i++) {
      const km = fullTanks[i].odometer - fullTanks[i + 1].odometer;
      if (km > 0 && money(fullTanks[i].liters) > 0)
        values.push(km / money(fullTanks[i].liters));
    }
    return values;
  }
  private async efficiencyFor(
    tx: FuelTransaction,
    entry: FuelEntry,
  ): Promise<number | null> {
    if (!entry.isFullTank || entry.isVoided) return null;
    const previous = await tx.fuelFillUp.findFirst({
      where: {
        vehicleId: entry.vehicleId,
        isVoided: false,
        isFullTank: true,
        id: { not: entry.id },
        OR: [
          { odometer: { lt: entry.odometer } },
          { odometer: entry.odometer, createdAt: { lt: entry.createdAt } },
        ],
      },
      orderBy: [{ odometer: 'desc' }, { createdAt: 'desc' }],
    });
    if (!previous) return null;
    return computeFuelEfficiency(
      previous.odometer,
      entry.odometer,
      money(entry.liters),
    );
  }
  private async toResponse(entry: FuelEntry) {
    const efficiency = await this.efficiencyFor(this.prisma, entry);
    const fullTankCount = await this.prisma.fuelFillUp.count({
      where: {
        vehicleId: entry.vehicleId,
        isVoided: false,
        isFullTank: true,
        odometer: { lte: entry.odometer },
      },
    });
    const previous = await this.priorEfficiencies(
      this.prisma,
      entry.vehicleId,
      entry,
    );
    const rollingAverage = previous.length
      ? previous.reduce((a, b) => a + b, 0) / previous.length
      : null;
    const deviation = await this.currentAnomalyThreshold();
    const fuelClassification =
      fullTankCount < 3
        ? 'Insufficient Data'
        : entry.anomaly?.status === 'OPEN'
          ? 'Anomaly'
          : efficiency == null || rollingAverage == null
            ? 'N/A'
            : isFuelEfficiencyAnomaly(efficiency, rollingAverage, deviation)
              ? 'Anomaly'
              : efficiency < rollingAverage
                ? 'Below Average'
                : 'Normal';
    return {
      id: entry.id,
      vehicleId: entry.vehicleId,
      vehicleName: entry.vehicle?.plateNumber ?? '',
      vehicleModel: entry.vehicle?.model ?? '',
      date: entry.entryDate.toISOString().slice(0, 10),
      liters: money(entry.liters),
      pricePerLiter: money(entry.pricePerLiter),
      totalCost: money(entry.totalCost),
      odometer: entry.odometer,
      station: entry.station?.name ?? '',
      stationId: entry.stationId,
      filledBy: entry.filledBy,
      isFullTank: entry.isFullTank,
      isVoided: entry.isVoided,
      voidReason: entry.voidReason,
      efficiency,
      fuelClassification,
      trend:
        fuelClassification === 'Anomaly' ||
        fuelClassification === 'Below Average'
          ? 'below'
          : 'normal',
      receipt: entry.receipt
        ? {
            id: entry.receipt.id,
            name: entry.receipt.name,
            contentType: entry.receipt.contentType,
            createdAt: entry.receipt.createdAt.toISOString(),
          }
        : null,
      anomaly: entry.anomaly
        ? {
            ...entry.anomaly,
            efficiency: money(entry.anomaly.efficiency),
            rollingAverage: money(entry.anomaly.rollingAverage),
          }
        : null,
    };
  }
}
