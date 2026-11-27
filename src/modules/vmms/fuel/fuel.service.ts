import {
  BadRequestException,
  ConflictException,
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
import type { UpdateFuelStationDto } from './fuel.dto';
import { computeFuelEfficiency, isFuelEfficiencyAnomaly } from './fuel-math';
import { MAX_FUEL_ANOMALY_ATTACHMENT_BYTES } from './fuel.constants';
import {
  type FuelReceiptFile,
  validateFuelReceiptFile,
} from './fuel-receipt-file';
import {
  parseFuelImportWorkbook,
  type ParsedFuelImportRow,
} from './fuel-import';

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
const normalizedPlate = (value: string) =>
  value.toUpperCase().replace(/[^A-Z0-9]/g, '');
const isoDate = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value;
};

type FuelImportSaveRow = {
  key: string;
  sheetName: string;
  worksheetRow: number;
  plateNumber: string;
  stationId: string;
  date: string;
  odometer: number | null;
  liters: number | null;
  pricePerLiter: number | null;
  filledBy: string;
  isFullTank: boolean | null;
  poNumber: string;
  siNumber: string;
  product: string;
  vehicleId: string | null;
  errors: string[];
  status: 'READY' | 'SAVED' | 'ERROR';
  fillUpId?: string;
  totalCost?: number;
};

function importText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function importNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim().replace(/[₱,\s]/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeImportDraftRows(rawRows: unknown[]): Prisma.InputJsonValue[] {
  return rawRows.map((raw, index) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
      throw new BadRequestException('Each draft row must be an object.');
    const row = raw as Record<string, unknown>;
    const errors = Array.isArray(row.errors)
      ? row.errors
          .filter((message): message is string => typeof message === 'string')
          .slice(0, 20)
          .map((message) => message.slice(0, 500))
      : [];
    const status =
      row.status === 'SAVED' || row.status === 'ERROR'
        ? row.status
        : 'READY';
    return {
      key: importText(row.key).slice(0, 200) || `row-${index + 1}`,
      sheetName: importText(row.sheetName).slice(0, 100),
      worksheetRow:
        Number.isInteger(row.worksheetRow) && Number(row.worksheetRow) > 0
          ? Number(row.worksheetRow)
          : index + 1,
      plateNumber: importText(row.plateNumber).slice(0, 50),
      date: importText(row.date).slice(0, 20),
      odometer: importNumber(row.odometer),
      poNumber: importText(row.poNumber).slice(0, 100),
      siNumber: importText(row.siNumber).slice(0, 100),
      product: importText(row.product).slice(0, 100),
      liters: importNumber(row.liters),
      pricePerLiter: importNumber(row.pricePerLiter),
      vehicleId: importText(row.vehicleId).slice(0, 36) || null,
      stationId: importText(row.stationId).slice(0, 36),
      filledBy: importText(row.filledBy).slice(0, 100),
      isFullTank:
        typeof row.isFullTank === 'boolean' ? row.isFullTank : null,
      errors,
      status,
    };
  });
}

function importDraftSheetNames(rows: Prisma.JsonValue[]): string[] {
  return [
    ...new Set(
      rows.flatMap((row) =>
        typeof row === 'object' &&
        row !== null &&
        !Array.isArray(row) &&
        typeof row['sheetName'] === 'string'
          ? [row['sheetName']]
          : [],
      ),
    ),
  ];
}

function importHttpError(error: unknown): string {
  if (error instanceof BadRequestException) {
    const response = error.getResponse();
    if (typeof response === 'string') return response;
    if (
      typeof response === 'object' &&
      response !== null &&
      'message' in response
    ) {
      const message = (response as { message?: unknown }).message;
      if (typeof message === 'string') return message;
      if (Array.isArray(message))
        return message.filter((item) => typeof item === 'string').join(' ');
    }
  }
  return 'Unable to save this fill-up due to a server error.';
}

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
  async listStationsForManagement() {
    return this.prisma.fuelStation.findMany({
      select: { id: true, name: true, isActive: true },
      orderBy: { name: 'asc' },
    });
  }
  async createStation(name: string) {
    const clean = name.trim();
    if (!clean || clean.length > 100)
      throw new BadRequestException(
        'Station name must be 1 to 100 characters.',
      );
    try {
      return await this.prisma.fuelStation.create({ data: { name: clean } });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        throw new ConflictException(
          'A fuel station with this name already exists.',
        );
      throw error;
    }
  }
  async updateStation(id: string, input: UpdateFuelStationDto) {
    const data: Prisma.FuelStationUpdateInput = {};
    if (input.name !== undefined) {
      const clean = input.name.trim();
      if (!clean || clean.length > 100)
        throw new BadRequestException(
          'Station name must be 1 to 100 characters.',
        );
      data.name = clean;
    }
    if (input.isActive !== undefined) data.isActive = input.isActive;
    if (!Object.keys(data).length)
      throw new BadRequestException(
        'Provide a station name or active status to update.',
      );

    try {
      return await this.prisma.fuelStation.update({
        where: { id },
        data,
        select: { id: true, name: true, isActive: true },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2025')
          throw new NotFoundException('Fuel station not found.');
        if (error.code === 'P2002')
          throw new ConflictException(
            'A fuel station with this name already exists.',
          );
      }
      throw error;
    }
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
    allowHistoricalOdometer = false,
  ) {
    this.require(actor, 'OPERATIONS');
    const receiptImage = receiptFile
      ? await validateFuelReceiptFile(receiptFile)
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
    if (allowHistoricalOdometer) {
      await this.validateHistoricalOdometer(
        vehicle.id,
        dto,
        latest,
        vehicle.odometer,
      );
    } else if (dto.odometer < lastOdometer)
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
            stationNameSnapshot: station.name,
            enteredById: actor.sub,
            entryDate: new Date(`${dto.date}T00:00:00.000Z`),
            liters: dto.liters,
            pricePerLiter: dto.pricePerLiter,
            totalCost: Math.round(dto.liters * dto.pricePerLiter * 100) / 100,
            poNumber: dto.poNumber?.trim() || null,
            siNumber: dto.siNumber?.trim() || null,
            product: dto.product?.trim() || null,
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
              const anomaly = await tx.fuelAnomaly.create({
                data: {
                  fillUpId: created.id,
                  vehicleId: vehicle.id,
                  efficiency,
                  rollingAverage: average,
                },
                select: { id: true },
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
                    category: 'FUEL',
                    actionType: 'FUEL_MANAGEMENT',
                    actionTargetId: anomaly.id,
                    dedupeKey: `fuel-anomaly:${anomaly.id}:${person.authUserId}`,
                  })),
                  skipDuplicates: true,
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

  async previewImport(buffer: Buffer) {
    const workbook = await parseFuelImportWorkbook(buffer);
    const parsedRows = workbook.rows;
    const vehicles = await this.prisma.vehicle.findMany({
      where: { deletedAt: null, isActive: true },
      select: { id: true, plateNumber: true, odometer: true },
    });
    const byPlate = new Map(
      vehicles.map((vehicle) => [normalizedPlate(vehicle.plateNumber), vehicle]),
    );
    const rows = parsedRows.map((row) => {
      const vehicle = byPlate.get(normalizedPlate(row.plateNumber));
      const errors = this.importRowErrors(row, vehicle?.id ?? null);
      return {
        ...row,
        vehicleId: vehicle?.id ?? null,
        stationId: '',
        filledBy: '',
        isFullTank: null,
        errors,
        status: errors.length ? 'ERROR' : 'READY',
      };
    });

    const addPreviewError = (row: (typeof rows)[number], message: string) => {
      if (!row.errors.includes(message)) row.errors.push(message);
      row.status = 'ERROR';
    };
    const vehicleById = new Map(vehicles.map((vehicle) => [vehicle.id, vehicle]));
    const duplicateCandidates = new Map<string, (typeof rows)[number][]>();
    for (const row of rows) {
      if (
        !row.vehicleId ||
        !isoDate(row.date) ||
        row.odometer === null ||
        row.liters === null ||
        row.pricePerLiter === null
      )
        continue;
      const identity = [
        row.sheetName,
        row.vehicleId,
        row.date,
        row.odometer,
        row.liters,
        row.pricePerLiter,
        row.poNumber.toLowerCase(),
        row.siNumber.toLowerCase(),
      ].join('|');
      duplicateCandidates.set(identity, [
        ...(duplicateCandidates.get(identity) ?? []),
        row,
      ]);
    }
    for (const duplicates of duplicateCandidates.values()) {
      if (duplicates.length > 1)
        duplicates.forEach((row) =>
          addPreviewError(row, 'Duplicate transaction in this workbook.'),
        );
    }

    const vehicleIds = [...new Set(rows.flatMap((row) =>
      row.vehicleId ? [row.vehicleId] : [],
    ))];
    const history = vehicleIds.length
      ? await this.prisma.fuelFillUp.findMany({
          where: { vehicleId: { in: vehicleIds }, isVoided: false },
          select: { vehicleId: true, entryDate: true, odometer: true },
        })
      : [];
    type OdometerPoint = {
      date: string;
      odometer: number;
      row?: (typeof rows)[number];
    };
    const odometerPoints = new Map<string, OdometerPoint[]>();
    for (const entry of history) {
      const points = odometerPoints.get(entry.vehicleId) ?? [];
      points.push({
        date: entry.entryDate.toISOString().slice(0, 10),
        odometer: entry.odometer,
      });
      odometerPoints.set(entry.vehicleId, points);
    }
    for (const row of rows) {
      if (!row.vehicleId || !isoDate(row.date) || row.odometer === null)
        continue;
      const vehicle = vehicleById.get(row.vehicleId);
      if (!vehicle) continue;
      if (row.date === currentFuelDate()) {
        const latestOdometer = (odometerPoints.get(row.vehicleId) ?? [])
          .reduce((latest, point) => Math.max(latest, point.odometer), 0);
        if (row.odometer < Math.max(vehicle.odometer, latestOdometer))
          addPreviewError(
            row,
            `Odometer cannot be lower than the current reading (${Math.max(vehicle.odometer, latestOdometer)} km).`,
          );
      }
      const points = odometerPoints.get(row.vehicleId) ?? [];
      points.push({ date: row.date, odometer: row.odometer, row });
      odometerPoints.set(row.vehicleId, points);
    }
    for (const points of odometerPoints.values()) {
      points.sort((a, b) => a.date.localeCompare(b.date) || a.odometer - b.odometer);
      for (let index = 1; index < points.length; index++) {
        const previous = points[index - 1];
        const current = points[index];
        if (current.date > previous.date && current.odometer < previous.odometer) {
          if (previous.row)
            addPreviewError(
              previous.row,
              'Odometer conflicts with the vehicle fuel history or another workbook row.',
            );
          if (current.row)
            addPreviewError(
              current.row,
              'Odometer conflicts with the vehicle fuel history or another workbook row.',
            );
        }
      }
    }
    return {
      rows,
      sheets: [...new Set(rows.map((row) => row.sheetName))],
      skippedSheets: workbook.skippedSheets,
    };
  }

  async listImportDrafts(actor: FuelActor) {
    this.require(actor, 'OPERATIONS');
    const drafts = await this.prisma.fuelImportDraft.findMany({
      where: { ownerAuthUserId: actor.sub },
      select: {
        id: true,
        sourceName: true,
        rows: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: 1000,
    });
    return drafts.map((draft) => {
      const rows = Array.isArray(draft.rows) ? draft.rows : [];
      return {
        id: draft.id,
        sourceName: draft.sourceName,
        rowCount: rows.length,
        sheetNames: importDraftSheetNames(rows),
        updatedAt: draft.updatedAt.toISOString(),
      };
    });
  }

  async getImportDraft(id: string, actor: FuelActor) {
    this.require(actor, 'OPERATIONS');
    const draft = await this.prisma.fuelImportDraft.findFirst({
      where: { id, ownerAuthUserId: actor.sub },
    });
    if (!draft) throw new NotFoundException('Fuel import draft not found.');
    return {
      id: draft.id,
      sourceName: draft.sourceName,
      rows: Array.isArray(draft.rows) ? draft.rows : [],
      createdAt: draft.createdAt.toISOString(),
      updatedAt: draft.updatedAt.toISOString(),
    };
  }

  async createImportDraft(
    sourceName: string,
    rawRows: unknown[],
    actor: FuelActor,
  ) {
    this.require(actor, 'OPERATIONS');
    const name = sourceName.trim().slice(0, 255);
    if (!name)
      throw new BadRequestException('Enter a name for the fuel import draft.');
    const draft = await this.prisma.fuelImportDraft.create({
      data: {
        ownerAuthUserId: actor.sub,
        sourceName: name,
        rows: normalizeImportDraftRows(rawRows),
      },
    });
    return this.getImportDraft(draft.id, actor);
  }

  async updateImportDraft(
    id: string,
    sourceName: string,
    rawRows: unknown[],
    actor: FuelActor,
  ) {
    this.require(actor, 'OPERATIONS');
    const name = sourceName.trim().slice(0, 255);
    if (!name)
      throw new BadRequestException('Enter a name for the fuel import draft.');
    const result = await this.prisma.fuelImportDraft.updateMany({
      where: { id, ownerAuthUserId: actor.sub },
      data: {
        sourceName: name,
        rows: normalizeImportDraftRows(rawRows),
      },
    });
    if (!result.count)
      throw new NotFoundException('Fuel import draft not found.');
    return this.getImportDraft(id, actor);
  }

  async deleteImportDraft(id: string, actor: FuelActor) {
    this.require(actor, 'OPERATIONS');
    const result = await this.prisma.fuelImportDraft.deleteMany({
      where: { id, ownerAuthUserId: actor.sub },
    });
    if (!result.count)
      throw new NotFoundException('Fuel import draft not found.');
    return { deleted: true };
  }

  async saveImportRows(rawRows: unknown[], actor: FuelActor) {
    this.require(actor, 'OPERATIONS');
    if (!Array.isArray(rawRows) || rawRows.length < 1 || rawRows.length > 1000)
      throw new BadRequestException(
        'Submit between 1 and 1,000 fuel rows to save.',
      );

    const vehicles = await this.prisma.vehicle.findMany({
      where: { deletedAt: null, isActive: true },
      select: { id: true, plateNumber: true },
    });
    const vehicleByPlate = new Map(
      vehicles.map((vehicle) => [normalizedPlate(vehicle.plateNumber), vehicle]),
    );
    const stations = await this.prisma.fuelStation.findMany({
      where: { isActive: true },
      select: { id: true },
    });
    const activeStationIds = new Set(stations.map((station) => station.id));

    const rows: FuelImportSaveRow[] = rawRows.map((raw, index) => {
      const row =
        typeof raw === 'object' && raw !== null
          ? (raw as Record<string, unknown>)
          : {};
      const plateNumber = importText(row.plateNumber);
      const vehicle = vehicleByPlate.get(normalizedPlate(plateNumber));
      const candidate: FuelImportSaveRow = {
        key: importText(row.key).slice(0, 200) || `row-${index + 1}`,
        sheetName: importText(row.sheetName).slice(0, 100),
        worksheetRow:
          Number.isInteger(row.worksheetRow) && Number(row.worksheetRow) > 0
            ? Number(row.worksheetRow)
            : index + 1,
        plateNumber,
        stationId: importText(row.stationId),
        date: importText(row.date),
        odometer: importNumber(row.odometer),
        liters: importNumber(row.liters),
        pricePerLiter: importNumber(row.pricePerLiter),
        filledBy: importText(row.filledBy),
        isFullTank: typeof row.isFullTank === 'boolean' ? row.isFullTank : null,
        poNumber: importText(row.poNumber),
        siNumber: importText(row.siNumber),
        product: importText(row.product),
        vehicleId: vehicle?.id ?? null,
        errors: [],
        status: 'READY',
      };
      candidate.errors.push(
        ...this.importRowErrors(candidate, candidate.vehicleId),
      );
      if (!candidate.stationId || !activeStationIds.has(candidate.stationId))
        candidate.errors.push('Select an active registered fuel station.');
      if (candidate.odometer === null ||
          !Number.isInteger(candidate.odometer) ||
          candidate.odometer < 0 ||
          candidate.odometer > 2147483647)
        candidate.errors.push('Enter a valid whole-number odometer reading.');
      if (candidate.liters === null ||
          candidate.liters <= 0 ||
          candidate.liters > 99_999_999.99 ||
          Math.abs(candidate.liters * 100 - Math.round(candidate.liters * 100)) > 1e-8)
        candidate.errors.push('Liters must be between 0.01 and 99,999,999.99 with at most two decimal places.');
      if (candidate.pricePerLiter === null ||
          candidate.pricePerLiter <= 0 ||
          candidate.pricePerLiter > 99_999_999.99 ||
          Math.abs(candidate.pricePerLiter * 100 - Math.round(candidate.pricePerLiter * 100)) > 1e-8)
        candidate.errors.push('Unit price must be between 0.01 and 99,999,999.99 with at most two decimal places.');
      if (candidate.liters !== null && candidate.pricePerLiter !== null &&
          Math.round(candidate.liters * candidate.pricePerLiter * 100) / 100 >
            9_999_999_999.99)
        candidate.errors.push('Calculated total cost exceeds the supported limit.');
      if (candidate.filledBy.length > 100)
        candidate.errors.push('Filled-by name must be 100 characters or fewer.');
      if (candidate.isFullTank === null)
        candidate.errors.push('Confirm whether this was a full or partial tank.');
      for (const [label, value] of [
        ['PO number', candidate.poNumber],
        ['SI number', candidate.siNumber],
        ['Product', candidate.product],
      ] as const) {
        if (value.length > 100)
          candidate.errors.push(`${label} must be 100 characters or fewer.`);
      }
      if (candidate.errors.length) candidate.status = 'ERROR';
      return candidate;
    });

    const duplicateKeys = new Map<string, FuelImportSaveRow[]>();
    for (const row of rows) {
      if (!row.vehicleId || !row.stationId || !row.date ||
          row.odometer === null || row.liters === null ||
          row.pricePerLiter === null) continue;
      const key = [
        row.vehicleId,
        row.stationId,
        row.date,
        row.odometer,
        row.liters,
        row.pricePerLiter,
        row.poNumber.toLowerCase(),
        row.siNumber.toLowerCase(),
      ].join('|');
      duplicateKeys.set(key, [...(duplicateKeys.get(key) ?? []), row]);
    }
    for (const duplicates of duplicateKeys.values()) {
      if (duplicates.length > 1) {
        for (const row of duplicates) {
          row.errors.push('This transaction is duplicated in the submitted workbook.');
          row.status = 'ERROR';
        }
      }
    }

    const saveOrder = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.status === 'READY')
      .sort((a, b) =>
        a.row.date.localeCompare(b.row.date) ||
        (a.row.odometer ?? 0) - (b.row.odometer ?? 0) ||
        a.index - b.index,
      );
    for (const { row } of saveOrder) {
      try {
        const duplicate = await this.findDuplicateImportRow(row);
        if (duplicate) {
          row.errors.push('A matching fuel fill-up is already recorded.');
          row.status = 'ERROR';
          continue;
        }
        const entry = await this.create(
          {
            vehicleId: row.vehicleId!,
            stationId: row.stationId,
            date: row.date,
            liters: row.liters!,
            pricePerLiter: row.pricePerLiter!,
            odometer: row.odometer!,
            filledBy: row.filledBy,
            isFullTank: row.isFullTank!,
            poNumber: row.poNumber || undefined,
            siNumber: row.siNumber || undefined,
            product: row.product || undefined,
          },
          actor,
          undefined,
          true,
        );
        row.status = 'SAVED';
        row.fillUpId = entry.id;
        row.totalCost = entry.totalCost;
      } catch (error) {
        row.status = 'ERROR';
        row.errors.push(importHttpError(error));
        if (!(error instanceof BadRequestException))
          this.logger.error(
            'Fuel statement import row failed.',
            error instanceof Error ? error.stack : undefined,
          );
      }
    }
    return {
      saved: rows.filter((row) => row.status === 'SAVED').length,
      failed: rows.filter((row) => row.status === 'ERROR').length,
      rows,
    };
  }

  private importRowErrors(
    row: Pick<ParsedFuelImportRow, 'plateNumber' | 'date' | 'liters' | 'pricePerLiter'>,
    vehicleId: string | null,
  ): string[] {
    const errors: string[] = [];
    if (!row.plateNumber || !vehicleId)
      errors.push('Select an active registered vehicle by plate number.');
    if (!isoDate(row.date))
      errors.push('Enter a valid transaction date.');
    else if (row.date > currentFuelDate())
      errors.push('Fuel-up date cannot be in the future.');
    if (row.liters === null || row.liters <= 0)
      errors.push('Enter positive liters.');
    if (row.pricePerLiter === null || row.pricePerLiter <= 0)
      errors.push('Enter a positive unit price.');
    return errors;
  }

  private async findDuplicateImportRow(row: FuelImportSaveRow) {
    const identity: Prisma.FuelFillUpWhereInput[] = [];
    if (row.siNumber)
      identity.push({
        siNumber: row.siNumber,
        entryDate: new Date(`${row.date}T00:00:00.000Z`),
        odometer: row.odometer!,
        liters: row.liters!,
        pricePerLiter: row.pricePerLiter!,
        stationId: row.stationId,
      });
    if (row.poNumber)
      identity.push({
        poNumber: row.poNumber,
        entryDate: new Date(`${row.date}T00:00:00.000Z`),
        odometer: row.odometer!,
        liters: row.liters!,
        pricePerLiter: row.pricePerLiter!,
        stationId: row.stationId,
      });
    identity.push({
      entryDate: new Date(`${row.date}T00:00:00.000Z`),
      odometer: row.odometer!,
      liters: row.liters!,
      pricePerLiter: row.pricePerLiter!,
      stationId: row.stationId,
    });
    return this.prisma.fuelFillUp.findFirst({
      where: {
        vehicleId: row.vehicleId!,
        isVoided: false,
        OR: identity,
      },
      select: { id: true },
    });
  }

  private async validateHistoricalOdometer(
    vehicleId: string,
    dto: FuelFillUpDto,
    latestByOdometer: { odometer: number } | null,
    masterOdometer: number,
  ) {
    const date = new Date(`${dto.date}T00:00:00.000Z`);
    if (dto.date === currentFuelDate()) {
      const minimum = Math.max(masterOdometer, latestByOdometer?.odometer ?? 0);
      if (dto.odometer < minimum)
        throw new BadRequestException(
          `Odometer cannot be lower than the current reading (${minimum} km).`,
        );
      return;
    }
    const [previous, next] = await Promise.all([
      this.prisma.fuelFillUp.findFirst({
        where: { vehicleId, isVoided: false, entryDate: { lt: date } },
        orderBy: [{ entryDate: 'desc' }, { odometer: 'desc' }],
        select: { odometer: true },
      }),
      this.prisma.fuelFillUp.findFirst({
        where: { vehicleId, isVoided: false, entryDate: { gt: date } },
        orderBy: [{ entryDate: 'asc' }, { odometer: 'asc' }],
        select: { odometer: true },
      }),
    ]);
    if (previous && dto.odometer < previous.odometer)
      throw new BadRequestException(
        `Odometer must be at least ${previous.odometer} km to follow the earlier fill-up.`,
      );
    if (next && dto.odometer > next.odometer)
      throw new BadRequestException(
        `Odometer must be no greater than ${next.odometer} km to precede the later fill-up.`,
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
      select: {
        id: true,
        fillUpId: true,
        vehicleId: true,
        efficiency: true,
        rollingAverage: true,
        status: true,
        note: true,
        acknowledgedAt: true,
        createdAt: true,
        fillUp: {
          select: {
            id: true,
            entryDate: true,
            odometer: true,
            isVoided: true,
            stationNameSnapshot: true,
            station: { select: { name: true } },
            repairReferral: {
              select: {
                id: true,
                status: true,
                repairTicketNumber: true,
                repairStatus: true,
                outcomeReason: true,
                lastErrorCode: true,
                createdAt: true,
              },
            },
          },
        },
        vehicle: true,
        attachments: {
          select: { id: true, name: true, contentType: true, createdAt: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    const now = Date.now();
    return rows.map((a) => ({
      ...a,
      repairReferral: a.fillUp?.repairReferral ?? null,
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
      poNumber: entry.poNumber,
      siNumber: entry.siNumber,
      product: entry.product,
      odometer: entry.odometer,
      station: entry.stationNameSnapshot,
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
