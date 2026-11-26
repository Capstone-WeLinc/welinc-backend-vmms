import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  MaintenanceStatus,
  Prisma,
  VrmsRepairIntegrationStatus,
  VrmsRepairOdometerReviewStatus,
} from '@prisma/client';
import { PrismaService } from '../../../shared/prisma.service';
import { BmsAvailabilityService } from '../integrations/bms/bms-availability.service';
import { BmsFleetChangesService } from '../integrations/bms/bms-fleet-changes.service';
import * as ExcelJS from 'exceljs';
import { odometerScheduleStatus } from '../maintenance-schedules/schedule-due';
import { CreateVehicleDto } from './dto/create-vehicle.dto';
import { UpdateVehicleDto } from './dto/update-vehicle.dto';
import { UpdateVehicleMaintenanceDefaultsDto } from './dto/update-vehicle-maintenance-defaults.dto';

export type VehicleAuditActor = { sub: string; email: string };

export type VehicleImportRow = {
  row: number;
  plateNumber: string;
  make: string;
  model: string;
  year: string;
  engineType: string;
  truckSizeCategory: string;
  garageBranch: string;
  odometerBaseline: string;
  errors: string[];
};
export type VehicleImportResult = {
  imported: number;
  rows: VehicleImportRow[];
};

export type OdometerImportStatus = 'READY' | 'UPDATED' | 'UNCHANGED' | 'ERROR';
export type OdometerImportRow = {
  row: number;
  plateNumber: string;
  odometerReading: string;
  currentOdometer: number | null;
  status: OdometerImportStatus;
  errors: string[];
};
export type OdometerImportInput = Pick<
  OdometerImportRow,
  'row' | 'plateNumber' | 'odometerReading'
>;
export type OdometerImportResult = {
  updated: number;
  unchanged: number;
  rows: OdometerImportRow[];
};

const importColumns = [
  'plate number',
  'make',
  'model',
  'year',
  'engine type',
  'truck size/category',
  'garage branch',
  'odometer baseline',
] as const;
const odometerImportColumns = [
  'plate number',
  'odometer reading (km)',
] as const;
const MAX_MAINTENANCE_KM = 2147483647;

function parseMaintenanceDefault(
  value: string,
  label: string,
  allowZero: boolean,
): number | null {
  if (value === '') return null;
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed > MAX_MAINTENANCE_KM ||
    (allowZero ? parsed < 0 : parsed < 1)
  ) {
    throw new BadRequestException(
      `${label} must be a ${allowZero ? 'non-negative' : 'positive'} whole number no greater than ${MAX_MAINTENANCE_KM}.`,
    );
  }
  return parsed;
}

function normalizeImportHeader(value: unknown): string {
  return importCellText(value).trim().toLowerCase().replace(/\s+/g, ' ');
}

function importCellText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  if (value instanceof Date) return value.toISOString();
  return '';
}

function normalizePlate(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeBranch(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^sta\.?\s+/, 'santa ');
}

function auditValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value) ?? null;
}

@Injectable()
export class VehiclesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: BmsAvailabilityService,
    private readonly fleetChanges: BmsFleetChangesService,
  ) {}

  async findAll(activeOnly = false) {
    const vehicles = await this.prisma.vehicle.findMany({
      where: { deletedAt: null, ...(activeOnly ? { isActive: true } : {}) },
      orderBy: { plateNumber: 'asc' },
      include: { garage: { select: { id: true, name: true } } },
    });

    const completedSchedules =
      vehicles.length === 0
        ? []
        : await this.prisma.maintenanceSchedule.findMany({
            where: {
              vehicleId: { in: vehicles.map((vehicle) => vehicle.plateNumber) },
              status: 'COMPLETED',
              deletedAt: null,
            },
            orderBy: [
              { completedAt: { sort: 'desc', nulls: 'last' } },
              { createdAt: 'desc' },
            ],
            select: { vehicleId: true, completedAt: true, createdAt: true },
          });
    const lastMaintenanceByPlate = new Map<string, Date>();
    for (const schedule of completedSchedules) {
      if (!lastMaintenanceByPlate.has(schedule.vehicleId)) {
        lastMaintenanceByPlate.set(
          schedule.vehicleId,
          schedule.completedAt ?? schedule.createdAt,
        );
      }
    }

    return vehicles.map((vehicle) => ({
      id: vehicle.id,
      plateNumber: vehicle.plateNumber,
      make: vehicle.make,
      model: vehicle.model,
      year: vehicle.year,
      engineType: vehicle.engineType,
      truckSizeCategory: vehicle.truckSizeCategory,
      capacity: vehicle.capacity,
      status: vehicle.status,
      odometer: vehicle.odometer,
      garageId: vehicle.garageId,
      garageName: vehicle.garage?.name ?? null,
      lastMaintenanceDate:
        lastMaintenanceByPlate.get(vehicle.plateNumber) ?? null,
      isActive: vehicle.isActive,
    }));
  }

  async getMaintenanceDefaults(id: string) {
    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        plateNumber: true,
        defaultMaintenanceIntervalKm: true,
        defaultMaintenanceBufferKm: true,
      },
    });
    if (!vehicle) throw new NotFoundException('Vehicle not found.');

    const templates = await this.prisma.checklistTemplate.findMany({
      where: { deletedAt: null },
      orderBy: { type: 'asc' },
      select: {
        id: true,
        type: true,
        vehicleDefaults: {
          where: { vehicleId: id },
          select: { intervalKm: true, bufferDistanceKm: true },
        },
      },
    });

    return {
      vehicleId: vehicle.id,
      plateNumber: vehicle.plateNumber,
      baseIntervalKm: vehicle.defaultMaintenanceIntervalKm,
      baseBufferDistanceKm: vehicle.defaultMaintenanceBufferKm,
      categories: templates.map((template) => ({
        checklistTemplateId: template.id,
        type: template.type,
        intervalKm: template.vehicleDefaults[0]?.intervalKm ?? null,
        bufferDistanceKm: template.vehicleDefaults[0]?.bufferDistanceKm ?? null,
      })),
    };
  }

  async updateMaintenanceDefaults(
    id: string,
    dto: UpdateVehicleMaintenanceDefaultsDto,
  ) {
    const baseIntervalKm = parseMaintenanceDefault(
      dto.baseIntervalKm,
      'Base maintenance interval',
      false,
    );
    const baseBufferDistanceKm = parseMaintenanceDefault(
      dto.baseBufferDistanceKm,
      'Base maintenance buffer',
      true,
    );
    if ((baseIntervalKm === null) !== (baseBufferDistanceKm === null))
      throw new BadRequestException(
        'Set both base maintenance interval and buffer, or leave both blank.',
      );

    const overrides = dto.categoryOverrides.map((override) => ({
      checklistTemplateId: override.checklistTemplateId,
      intervalKm: parseMaintenanceDefault(
        override.intervalKm,
        'Category maintenance interval',
        false,
      ),
      bufferDistanceKm: parseMaintenanceDefault(
        override.bufferDistanceKm,
        'Category maintenance buffer',
        true,
      ),
    }));
    const validOverrides = overrides.map((override) => {
      if (override.intervalKm === null || override.bufferDistanceKm === null) {
        throw new BadRequestException(
          'Each category override requires both an interval and buffer.',
        );
      }
      return {
        ...override,
        intervalKm: override.intervalKm,
        bufferDistanceKm: override.bufferDistanceKm,
      };
    });

    await this.prisma.$transaction(async (tx) => {
      const vehicle = await tx.vehicle.findFirst({
        where: { id, deletedAt: null },
        select: { id: true, isActive: true },
      });
      if (!vehicle) throw new NotFoundException('Vehicle not found.');
      if (!vehicle.isActive)
        throw new BadRequestException(
          'Maintenance defaults can only be changed for active vehicles.',
        );

      const templateIds = validOverrides.map(
        (override) => override.checklistTemplateId,
      );
      if (templateIds.length) {
        const activeTemplates = await tx.checklistTemplate.findMany({
          where: { id: { in: templateIds }, deletedAt: null },
          select: { id: true },
        });
        if (activeTemplates.length !== templateIds.length)
          throw new BadRequestException(
            'Every category override must use an active checklist template.',
          );
      }

      await tx.vehicle.update({
        where: { id },
        data: {
          defaultMaintenanceIntervalKm: baseIntervalKm,
          defaultMaintenanceBufferKm: baseBufferDistanceKm,
        },
      });
      await tx.vehicleMaintenanceDefault.deleteMany({
        where: {
          vehicleId: id,
          ...(templateIds.length
            ? { checklistTemplateId: { notIn: templateIds } }
            : {}),
        },
      });
      for (const override of validOverrides) {
        await tx.vehicleMaintenanceDefault.upsert({
          where: {
            vehicleId_checklistTemplateId: {
              vehicleId: id,
              checklistTemplateId: override.checklistTemplateId,
            },
          },
          create: {
            vehicleId: id,
            checklistTemplateId: override.checklistTemplateId,
            intervalKm: override.intervalKm,
            bufferDistanceKm: override.bufferDistanceKm,
          },
          update: {
            intervalKm: override.intervalKm,
            bufferDistanceKm: override.bufferDistanceKm,
          },
        });
      }
    });

    return this.getMaintenanceDefaults(id);
  }

  async create(dto: CreateVehicleDto) {
    await this.assertActiveGarage(dto.garageId);
    try {
      const vehicle = await this.prisma.$transaction(async (tx) => {
        const created = await tx.vehicle.create({
          data: {
            plateNumber: dto.plateNumber.trim(),
            make: dto.make.trim(),
            model: dto.model.trim(),
            year: dto.year,
            engineType: dto.engineType.trim(),
            truckSizeCategory: dto.truckSizeCategory.trim(),
            capacity: 0,
            odometer: dto.odometer,
            garageId: dto.garageId,
            status: 'AVAILABLE',
          },
          include: { garage: { select: { id: true, name: true } } },
        });
        await this.fleetChanges.recordChange(tx, {
          entityType: 'VEHICLE',
          entityId: created.id,
          changeType: 'VEHICLE_CREATED',
        });
        return created;
      });
      const { availabilityVersion: _availabilityVersion, ...response } =
        vehicle;
      return response;
    } catch (error) {
      this.throwPlateConflict(error);
    }
  }

  async previewExcel(buffer: Buffer): Promise<VehicleImportResult> {
    let rows: unknown[][];
    try {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer as never);
      const firstSheet = workbook.worksheets[0];
      if (!firstSheet) throw new Error('The workbook has no worksheets.');
      rows = [];
      firstSheet.eachRow((row) => {
        rows.push(
          Array.from({ length: firstSheet.columnCount }, (_, index) =>
            row.getCell(index + 1).value,
          ),
        );
      });
    } catch {
      throw new BadRequestException(
        'The uploaded file is not a readable .xlsx workbook.',
      );
    }

    if (!rows.length) throw new BadRequestException('The workbook is empty.');
    const headerIndexes = new Map<string, number>();
    rows[0].forEach((value, index) =>
      headerIndexes.set(normalizeImportHeader(value), index),
    );
    const missingColumns = importColumns.filter(
      (column) => !headerIndexes.has(column),
    );
    if (missingColumns.length) {
      throw new BadRequestException(
        `Missing required columns: ${missingColumns.join(', ')}.`,
      );
    }
    if (rows.length - 1 > 1000)
      throw new BadRequestException(
        'Import at most 1,000 vehicle rows per workbook.',
      );

    const candidates = rows.slice(1).flatMap((row, index) => {
      if (row.every((value) => importCellText(value).trim() === '')) return [];
      const cell = (column: string) =>
        importCellText(row[headerIndexes.get(column)!]).trim();
      return [
        {
          row: index + 2,
          plateNumber: cell('plate number'),
          make: cell('make'),
          model: cell('model'),
          year: cell('year'),
          engineType: cell('engine type'),
          truckSizeCategory: cell('truck size/category'),
          garageBranch: cell('garage branch'),
          odometerBaseline: cell('odometer baseline'),
          errors: [],
        },
      ];
    });
    return this.processImportRows(candidates, false);
  }

  async saveImportRows(rows: VehicleImportRow[]): Promise<VehicleImportResult> {
    if (!Array.isArray(rows) || rows.length === 0 || rows.length > 1000) {
      throw new BadRequestException(
        'Submit between 1 and 1,000 vehicle rows to save.',
      );
    }
    return this.processImportRows(rows, true);
  }

  async previewOdometerExcel(buffer: Buffer): Promise<OdometerImportResult> {
    let rows: unknown[][];
    try {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer as never);
      const firstSheet = workbook.worksheets[0];
      if (!firstSheet) throw new Error('The workbook has no worksheets.');
      rows = [];
      firstSheet.eachRow((row) => {
        rows.push(
          Array.from({ length: firstSheet.columnCount }, (_, index) =>
            row.getCell(index + 1).value,
          ),
        );
      });
    } catch {
      throw new BadRequestException(
        'The uploaded file is not a readable .xlsx workbook.',
      );
    }

    if (!rows.length) throw new BadRequestException('The workbook is empty.');
    const headerIndexes = new Map<string, number>();
    rows[0].forEach((value, index) =>
      headerIndexes.set(normalizeImportHeader(value), index),
    );
    const missingColumns = odometerImportColumns.filter(
      (column) => !headerIndexes.has(column),
    );
    if (missingColumns.length) {
      throw new BadRequestException(
        `Missing required columns: ${missingColumns.join(', ')}.`,
      );
    }
    if (rows.length - 1 > 1000)
      throw new BadRequestException(
        'Import at most 1,000 odometer rows per workbook.',
      );

    const candidates = rows.slice(1).flatMap((row, index) => {
      if (row.every((value) => importCellText(value).trim() === '')) return [];
      const cell = (column: string) =>
        importCellText(row[headerIndexes.get(column)!]).trim();
      return [
        {
          row: index + 2,
          plateNumber: cell('plate number'),
          odometerReading: cell('odometer reading (km)'),
        },
      ];
    });
    if (!candidates.length)
      throw new BadRequestException('The workbook contains no odometer rows.');
    return this.processOdometerImportRows(candidates, false);
  }

  async saveOdometerImportRows(
    rows: unknown[],
    actor: VehicleAuditActor,
  ): Promise<OdometerImportResult> {
    if (!Array.isArray(rows) || rows.length === 0 || rows.length > 1000) {
      throw new BadRequestException(
        'Submit between 1 and 1,000 odometer rows to save.',
      );
    }
    return this.processOdometerImportRows(rows, true, actor);
  }

  private async processOdometerImportRows(
    rows: unknown[],
    save: boolean,
    actor?: VehicleAuditActor,
  ): Promise<OdometerImportResult> {
    const candidates: OdometerImportRow[] = rows.map((rawRow, index) => {
      const row =
        rawRow && typeof rawRow === 'object'
          ? (rawRow as Partial<OdometerImportInput>)
          : {};
      return {
        row:
          Number.isInteger(row.row) && Number(row.row) > 1
            ? Number(row.row)
            : index + 2,
        plateNumber: importCellText(row.plateNumber).trim(),
        odometerReading: importCellText(row.odometerReading).trim(),
        currentOdometer: null,
        status: 'READY',
        errors: [],
      };
    });
    const result: OdometerImportResult = {
      updated: 0,
      unchanged: 0,
      rows: candidates,
    };
    const error = (candidate: OdometerImportRow, message: string) => {
      candidate.status = 'ERROR';
      candidate.errors.push(message);
    };
    const duplicatePlates = new Set<string>();
    const plateCounts = new Map<string, number>();
    for (const candidate of candidates) {
      const plate = normalizePlate(candidate.plateNumber);
      if (plate) plateCounts.set(plate, (plateCounts.get(plate) ?? 0) + 1);
    }
    for (const [plate, count] of plateCounts) {
      if (count > 1) duplicatePlates.add(plate);
    }

    const plates = [...plateCounts.keys()];
    const matchingVehicles = plates.length
      ? await this.prisma.vehicle.findMany({
          where: {
            deletedAt: null,
            OR: plates.map((plateNumber) => ({
              plateNumber: { equals: plateNumber, mode: 'insensitive' },
            })),
          },
          select: {
            id: true,
            plateNumber: true,
            odometer: true,
            isActive: true,
          },
        })
      : [];
    const vehiclesByPlate = new Map<string, typeof matchingVehicles>();
    for (const vehicle of matchingVehicles) {
      const plate = normalizePlate(vehicle.plateNumber);
      vehiclesByPlate.set(plate, [
        ...(vehiclesByPlate.get(plate) ?? []),
        vehicle,
      ]);
    }

    const validRows: Array<{
      candidate: OdometerImportRow;
      vehicleId: string;
      odometer: number;
    }> = [];
    for (const candidate of candidates) {
      const plate = normalizePlate(candidate.plateNumber);
      if (!plate) error(candidate, 'Plate number is required.');
      else if (candidate.plateNumber.length > 20)
        error(candidate, 'Plate number must be 20 characters or fewer.');
      if (!candidate.odometerReading)
        error(candidate, 'Odometer reading is required.');
      else if (!/^\d+$/.test(candidate.odometerReading))
        error(candidate, 'Odometer reading must be a positive whole number.');
      else {
        const odometer = Number(candidate.odometerReading);
        if (
          !Number.isSafeInteger(odometer) ||
          odometer < 1 ||
          odometer > 2147483647
        )
          error(
            candidate,
            'Odometer reading must be between 1 and 2,147,483,647.',
          );
      }

      if (plate && duplicatePlates.has(plate))
        error(candidate, 'Plate number is duplicated in this workbook.');
      if (candidate.status === 'ERROR') continue;

      const matched = vehiclesByPlate.get(plate) ?? [];
      if (matched.length > 1) {
        error(candidate, 'Plate number matches multiple vehicles.');
        continue;
      }
      const vehicle = matched[0];
      if (!vehicle) {
        error(candidate, 'No active vehicle found for this plate number.');
        continue;
      }
      candidate.currentOdometer = vehicle.odometer;
      if (!vehicle.isActive) {
        error(
          candidate,
          'Odometer updates are only allowed for active vehicles.',
        );
        continue;
      }

      const odometer = Number(candidate.odometerReading);
      if (odometer < vehicle.odometer) {
        error(
          candidate,
          `Odometer cannot be lower than the current reading (${vehicle.odometer}).`,
        );
        continue;
      }
      candidate.status = odometer === vehicle.odometer ? 'UNCHANGED' : 'READY';
      validRows.push({ candidate, vehicleId: vehicle.id, odometer });
    }

    if (!save) return result;
    if (!actor)
      throw new Error('An audit actor is required to save odometer rows.');

    for (const { candidate, vehicleId, odometer } of validRows) {
      try {
        const outcome = await this.prisma.$transaction((tx) =>
          this.updateOdometerInTransaction(tx, vehicleId, odometer, actor),
        );
        candidate.currentOdometer = outcome.vehicle.odometer;
        candidate.status = outcome.changed ? 'UPDATED' : 'UNCHANGED';
        if (outcome.changed) result.updated += 1;
        else result.unchanged += 1;
      } catch (saveError) {
        if (
          saveError instanceof BadRequestException ||
          saveError instanceof NotFoundException ||
          saveError instanceof ConflictException
        ) {
          error(candidate, saveError.message);
          const current = await this.prisma.vehicle.findUnique({
            where: { id: vehicleId },
            select: { odometer: true, deletedAt: true },
          });
          candidate.currentOdometer =
            current && !current.deletedAt ? current.odometer : null;
          continue;
        }
        throw saveError;
      }
    }
    return result;
  }

  private async processImportRows(
    rows: VehicleImportRow[],
    save: boolean,
  ): Promise<VehicleImportResult> {
    const [garages, existingVehicles] = await Promise.all([
      this.prisma.garage.findMany({
        where: { isActive: true, deletedAt: null },
        select: { id: true, name: true },
      }),
      this.prisma.vehicle.findMany({ select: { plateNumber: true } }),
    ]);
    const garagesByName = new Map(
      garages.map((garage) => [normalizeBranch(garage.name), garage]),
    );
    const seenPlates = new Set<string>(
      existingVehicles.map((vehicle) => normalizePlate(vehicle.plateNumber)),
    );
    const result: VehicleImportResult = { imported: 0, rows: [] };

    for (const [index, rawRow] of rows.entries()) {
      const row =
        rawRow && typeof rawRow === 'object'
          ? rawRow
          : ({} as VehicleImportRow);
      const candidate: VehicleImportRow = {
        ...row,
        row: Number.isInteger(row.row) && row.row > 1 ? row.row : index + 2,
        plateNumber: String(row.plateNumber ?? '').trim(),
        make: String(row.make ?? '').trim(),
        model: String(row.model ?? '').trim(),
        year: String(row.year ?? '').trim(),
        engineType: String(row.engineType ?? '').trim(),
        truckSizeCategory: String(row.truckSizeCategory ?? '').trim(),
        garageBranch: String(row.garageBranch ?? '').trim(),
        odometerBaseline: String(row.odometerBaseline ?? '').trim(),
        errors: [],
      };
      const error = (message: string) => candidate.errors.push(message);
      const required = [
        ['plate number', candidate.plateNumber],
        ['make', candidate.make],
        ['model', candidate.model],
        ['year', candidate.year],
        ['engine type', candidate.engineType],
        ['truck size/category', candidate.truckSizeCategory],
        ['garage branch', candidate.garageBranch],
        ['odometer baseline', candidate.odometerBaseline],
      ]
        .filter(([, value]) => !value)
        .map(([column]) => column);
      if (required.length) {
        error(
          `Missing required value${required.length > 1 ? 's' : ''}: ${required.join(', ')}.`,
        );
        result.rows.push(candidate);
        continue;
      }
      const maxLengths: Array<[string, string, number]> = [
        ['plate number', candidate.plateNumber, 20],
        ['make', candidate.make, 80],
        ['model', candidate.model, 100],
        ['engine type', candidate.engineType, 50],
        ['truck size/category', candidate.truckSizeCategory, 50],
      ];
      const tooLong = maxLengths
        .filter(([, value, max]) => value.length > max)
        .map(([name, , max]) => `${name} must be ${max} characters or fewer`);
      if (tooLong.length) {
        tooLong.forEach(error);
        result.rows.push(candidate);
        continue;
      }

      const normalizedPlate = normalizePlate(candidate.plateNumber);
      if (seenPlates.has(normalizedPlate)) {
        error(
          'Plate number is already registered or duplicated in this workbook.',
        );
        result.rows.push(candidate);
        continue;
      }

      const year = Number(candidate.year);
      const odometer = Number(candidate.odometerBaseline);
      if (
        !/^\d{4}$/.test(candidate.year) ||
        !Number.isInteger(year) ||
        year < 1
      ) {
        error('Year must be a valid four-digit year.');
        result.rows.push(candidate);
        continue;
      }
      if (
        !/^\d+$/.test(candidate.odometerBaseline) ||
        !Number.isSafeInteger(odometer) ||
        odometer < 0
      ) {
        error('Odometer baseline must be a non-negative whole number.');
        result.rows.push(candidate);
        continue;
      }

      const garage = garagesByName.get(normalizeBranch(candidate.garageBranch));
      if (!garage) {
        error('Garage branch must match an active registered branch.');
        result.rows.push(candidate);
        continue;
      }

      if (!save) {
        seenPlates.add(normalizedPlate);
        result.rows.push(candidate);
        continue;
      }

      try {
        await this.prisma.$transaction(async (tx) => {
          const created = await tx.vehicle.create({
            data: {
              plateNumber: normalizedPlate,
              make: candidate.make,
              model: candidate.model,
              year,
              engineType: candidate.engineType,
              truckSizeCategory: candidate.truckSizeCategory,
              capacity: 0,
              odometer,
              garageId: garage.id,
              status: 'AVAILABLE',
            },
          });
          await this.fleetChanges.recordChange(tx, {
            entityType: 'VEHICLE',
            entityId: created.id,
            changeType: 'VEHICLE_IMPORTED',
          });
        });
      } catch (createError) {
        if (
          createError instanceof Prisma.PrismaClientKnownRequestError &&
          createError.code === 'P2002'
        ) {
          error(
            'Plate number is already registered or duplicated in this workbook.',
          );
          seenPlates.add(normalizedPlate);
          result.rows.push(candidate);
          continue;
        }
        throw createError;
      }
      seenPlates.add(normalizedPlate);
      result.imported += 1;
    }
    return result;
  }

  async update(id: string, dto: UpdateVehicleDto, actor: VehicleAuditActor) {
    if (dto.garageId !== undefined) await this.assertActiveGarage(dto.garageId);
    try {
      const data: Prisma.VehicleUncheckedUpdateInput = {
        ...(dto.plateNumber !== undefined
          ? { plateNumber: dto.plateNumber.trim() }
          : {}),
        ...(dto.make !== undefined ? { make: dto.make.trim() } : {}),
        ...(dto.model !== undefined ? { model: dto.model.trim() } : {}),
        ...(dto.year !== undefined ? { year: dto.year } : {}),
        ...(dto.engineType !== undefined
          ? { engineType: dto.engineType.trim() }
          : {}),
        ...(dto.truckSizeCategory !== undefined
          ? { truckSizeCategory: dto.truckSizeCategory.trim() }
          : {}),
        ...(dto.capacity !== undefined ? { capacity: dto.capacity } : {}),
        ...(dto.garageId !== undefined ? { garageId: dto.garageId } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      };

      return await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          SELECT pg_advisory_xact_lock(hashtextextended(${`vehicle:${id}`}, 0))
        `;
        await tx.$queryRaw`
          SELECT id FROM vehicles WHERE id = ${id}::uuid FOR UPDATE
        `;
        const previous = await tx.vehicle.findUnique({
          where: { id },
          select: {
            plateNumber: true,
            make: true,
            model: true,
            year: true,
            engineType: true,
            truckSizeCategory: true,
            capacity: true,
            garageId: true,
            status: true,
            isActive: true,
          },
        });
        if (!previous) throw new NotFoundException('Vehicle not found.');
        if (dto.isActive === false && previous.isActive) {
          await this.assertNoOpenVrmsRepair(tx, id);
        }

        const updated = await tx.vehicle.update({
          where: { id },
          data: {
            ...data,
            ...(previous.status !== (dto.status ?? previous.status)
              ? { availabilityVersion: { increment: 1 } }
              : {}),
          },
          include: { garage: { select: { id: true, name: true } } },
        });
        if (previous.status !== updated.status) {
          await this.availability.recordStatusChange(tx, updated);
        }
        const changedFields = Object.keys(data).filter(
          (field) =>
            !Object.is(
              previous[field as keyof typeof previous],
              updated[field as keyof typeof previous],
            ),
        );

        if (changedFields.length) {
          await tx.vehicleAuditLog.createMany({
            data: changedFields.map((field) => ({
              vehicleId: id,
              userId: actor.sub,
              email: actor.email,
              action: 'VEHICLE_UPDATED',
              fieldName: field,
              previousValue: auditValue(
                previous[field as keyof typeof previous],
              ),
              newValue: auditValue(updated[field as keyof typeof previous]),
            })),
          });
        }
        if (changedFields.some((field) => field !== 'status')) {
          await this.fleetChanges.recordChange(tx, {
            entityType: 'VEHICLE',
            entityId: id,
            changeType: 'VEHICLE_UPDATED',
          });
        }

        const { availabilityVersion: _availabilityVersion, ...response } =
          updated;
        return response;
      });
    } catch (error) {
      this.throwPlateConflict(error);
    }
  }

  async updateOdometer(id: string, odometer: number, actor: VehicleAuditActor) {
    if (
      !Number.isSafeInteger(odometer) ||
      odometer < 1 ||
      odometer > 2147483647
    )
      throw new BadRequestException(
        'Enter a positive whole-number odometer reading.',
      );

    const outcome = await this.prisma.$transaction((tx) =>
      this.updateOdometerInTransaction(tx, id, odometer, actor),
    );
    return outcome.vehicle;
  }

  async findPendingVrmsOdometerReviews(cursor?: string) {
    const pageSize = 50;
    const reviews = await this.prisma.vrmsRepairOdometerReview.findMany({
      where: { status: VrmsRepairOdometerReviewStatus.PENDING },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: pageSize + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        serviceOdometerReading: true,
        occurredAt: true,
        event: {
          select: {
            repairTicketId: true,
            repairTicketNumber: true,
            outsideShopName: true,
          },
        },
        vehicle: {
          select: {
            id: true,
            plateNumber: true,
            odometer: true,
            isActive: true,
          },
        },
      },
    });
    const hasMore = reviews.length > pageSize;
    const page = hasMore ? reviews.slice(0, pageSize) : reviews;

    return {
      items: page.map((review) => ({
        id: review.id,
        repairTicketId: review.event.repairTicketId,
        repairTicketNumber: review.event.repairTicketNumber,
        outsideShopName: review.event.outsideShopName,
        vehicleId: review.vehicle.id,
        plateNumber: review.vehicle.plateNumber,
        currentOdometer: review.vehicle.odometer,
        isActive: review.vehicle.isActive,
        serviceOdometerReading: review.serviceOdometerReading,
        occurredAt: review.occurredAt.toISOString(),
      })),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  async confirmVrmsOdometerReview(id: string, actor: VehicleAuditActor) {
    return this.decideVrmsOdometerReview(
      id,
      VrmsRepairOdometerReviewStatus.CONFIRMED,
      actor,
    );
  }

  async dismissVrmsOdometerReview(id: string, actor: VehicleAuditActor) {
    return this.decideVrmsOdometerReview(
      id,
      VrmsRepairOdometerReviewStatus.DISMISSED,
      actor,
    );
  }

  private async decideVrmsOdometerReview(
    id: string,
    decision: Exclude<VrmsRepairOdometerReviewStatus, 'PENDING'>,
    actor: VehicleAuditActor,
  ) {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const review = await tx.vrmsRepairOdometerReview.findUnique({
            where: { id },
            select: {
              id: true,
              vehicleId: true,
              serviceOdometerReading: true,
              status: true,
            },
          });
          if (!review) {
            throw new NotFoundException('Odometer review not found.');
          }
          if (review.status !== VrmsRepairOdometerReviewStatus.PENDING) {
            throw new ConflictException(
              'This service reading has already been reviewed.',
            );
          }

          if (decision === VrmsRepairOdometerReviewStatus.CONFIRMED) {
            await this.updateOdometerInTransaction(
              tx,
              review.vehicleId,
              review.serviceOdometerReading,
              actor,
            );
          }

          const result = await tx.vrmsRepairOdometerReview.updateMany({
            where: {
              id,
              status: VrmsRepairOdometerReviewStatus.PENDING,
            },
            data: {
              status: decision,
              reviewedAt: new Date(),
              reviewedById: actor.sub,
            },
          });
          if (result.count !== 1) {
            throw new ConflictException(
              'This service reading was reviewed by another user. Refresh and try again.',
            );
          }

          return { id, status: decision };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2034'
      ) {
        throw new ConflictException(
          'This service reading was reviewed by another user. Refresh and try again.',
        );
      }
      throw error;
    }
  }

  async bulkUpdateOdometer(
    items: Array<{ vehicleId: string; odometer: number }>,
    actor: VehicleAuditActor,
  ) {
    if (!Array.isArray(items) || items.length === 0 || items.length > 1000) {
      throw new BadRequestException(
        'Submit between 1 and 1,000 odometer updates to save.',
      );
    }

    const seenVehicleIds = new Set<string>();
    const duplicateVehicleIds = new Set<string>();
    for (const item of items) {
      if (seenVehicleIds.has(item.vehicleId)) duplicateVehicleIds.add(item.vehicleId);
      seenVehicleIds.add(item.vehicleId);
    }

    const results: Array<{
      vehicleId: string;
      odometer: number;
      currentOdometer: number | null;
      status: 'UPDATED' | 'UNCHANGED' | 'ERROR';
      message?: string;
    }> = [];
    let updated = 0;
    let unchanged = 0;
    let failed = 0;

    for (const item of items) {
      if (duplicateVehicleIds.has(item.vehicleId)) {
        results.push({
          vehicleId: item.vehicleId,
          odometer: item.odometer,
          currentOdometer: null,
          status: 'ERROR',
          message: 'Vehicle is duplicated in this request.',
        });
        failed += 1;
        continue;
      }

      if (
        !Number.isSafeInteger(item.odometer) ||
        item.odometer < 1 ||
        item.odometer > 2147483647
      ) {
        results.push({
          vehicleId: item.vehicleId,
          odometer: item.odometer,
          currentOdometer: null,
          status: 'ERROR',
          message: 'Enter a positive whole-number odometer reading.',
        });
        failed += 1;
        continue;
      }

      try {
        const outcome = await this.prisma.$transaction((tx) =>
          this.updateOdometerInTransaction(tx, item.vehicleId, item.odometer, actor),
        );
        const status = outcome.changed ? 'UPDATED' : 'UNCHANGED';
        results.push({
          vehicleId: item.vehicleId,
          odometer: item.odometer,
          currentOdometer: outcome.vehicle.odometer,
          status,
        });
        if (outcome.changed) updated += 1;
        else unchanged += 1;
      } catch (error) {
        if (
          error instanceof BadRequestException ||
          error instanceof NotFoundException ||
          error instanceof ConflictException
        ) {
          const current = await this.prisma.vehicle.findUnique({
            where: { id: item.vehicleId },
            select: { odometer: true, deletedAt: true },
          });
          results.push({
            vehicleId: item.vehicleId,
            odometer: item.odometer,
            currentOdometer:
              current && !current.deletedAt ? current.odometer : null,
            status: 'ERROR',
            message: error.message,
          });
          failed += 1;
          continue;
        }
        throw error;
      }
    }

    return { updated, unchanged, failed, results };
  }

  private async updateOdometerInTransaction(
    tx: Prisma.TransactionClient,
    id: string,
    odometer: number,
    actor: VehicleAuditActor,
  ) {
    let previous = await tx.vehicle.findUnique({
      where: { id },
      select: { odometer: true, isActive: true, deletedAt: true },
    });

    if (!previous || previous.deletedAt)
      throw new NotFoundException('Vehicle not found.');
    if (!previous.isActive)
      throw new BadRequestException(
        'Odometer updates are only allowed for active vehicles.',
      );
    if (odometer < previous.odometer)
      throw new BadRequestException(
        `Odometer cannot be lower than the current reading (${previous.odometer}).`,
      );

    let changed = false;
    while (odometer > previous.odometer) {
      const result = await tx.vehicle.updateMany({
        where: {
          id,
          odometer: previous.odometer,
          isActive: true,
          deletedAt: null,
        },
        data: { odometer },
      });

      if (result.count === 1) {
        await tx.vehicleAuditLog.createMany({
          data: [
            {
              vehicleId: id,
              userId: actor.sub,
              email: actor.email,
              action: 'ODOMETER_UPDATED',
              fieldName: 'odometer',
              previousValue: String(previous.odometer),
              newValue: String(odometer),
            },
          ],
        });
        changed = true;
        break;
      }

      previous = await tx.vehicle.findUnique({
        where: { id },
        select: { odometer: true, isActive: true, deletedAt: true },
      });
      if (!previous || previous.deletedAt)
        throw new NotFoundException('Vehicle not found.');
      if (!previous.isActive)
        throw new BadRequestException(
          'Odometer updates are only allowed for active vehicles.',
        );
      if (odometer < previous.odometer)
        throw new BadRequestException(
          `Odometer cannot be lower than the current reading (${previous.odometer}).`,
        );
    }

    const updated = await tx.vehicle.findUnique({
      where: { id },
      include: { garage: { select: { id: true, name: true } } },
    });
    if (!updated || updated.deletedAt)
      throw new NotFoundException('Vehicle not found.');
    if (!updated.isActive)
      throw new BadRequestException(
        'Odometer updates are only allowed for active vehicles.',
      );

    if (changed) {
      await this.fleetChanges.recordChange(tx, {
        entityType: 'VEHICLE',
        entityId: id,
        changeType: 'ODOMETER_UPDATED',
      });
      await this.refreshOdometerScheduleStatuses(
        tx,
        updated.plateNumber,
        updated.odometer,
      );
    }
    return { vehicle: updated, changed };
  }

  private async refreshOdometerScheduleStatuses(
    tx: Prisma.TransactionClient,
    plateNumber: string,
    currentOdometer: number,
  ): Promise<void> {
    const schedules = await tx.maintenanceSchedule.findMany({
      where: {
        vehicleId: plateNumber,
        triggerType: 'ODOMETER',
        status: {
          in: [
            MaintenanceStatus.PENDING,
            MaintenanceStatus.DUE,
            MaintenanceStatus.OVERDUE,
          ],
        },
        deletedAt: null,
      },
      select: {
        id: true,
        status: true,
        triggerType: true,
        startingReferenceReadingKm: true,
        odometerReading: true,
        intervalKm: true,
        bufferDistanceKm: true,
        updatedAt: true,
      },
    });

    for (const schedule of schedules) {
      const status = odometerScheduleStatus(schedule, currentOdometer);
      if (!status || status === schedule.status) continue;

      const result = await tx.maintenanceSchedule.updateMany({
        where: {
          id: schedule.id,
          status: schedule.status,
          updatedAt: schedule.updatedAt,
          deletedAt: null,
        },
        data: { status },
      });
      if (result.count !== 1)
        throw new ConflictException(
          'A maintenance schedule changed during the odometer update. Retry the operation.',
        );
    }
  }

  async findAuditHistory(id: string) {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!vehicle) throw new NotFoundException('Vehicle not found.');

    return this.prisma.vehicleAuditLog.findMany({
      where: { vehicleId: id },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        email: true,
        action: true,
        fieldName: true,
        previousValue: true,
        newValue: true,
        createdAt: true,
      },
    });
  }

  async delete(id: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`vehicle:${id}`}, 0))
      `;
      await tx.$queryRaw`
        SELECT id FROM vehicles WHERE id = ${id}::uuid FOR UPDATE
      `;
      const previous = await tx.vehicle.findUnique({ where: { id } });
      if (!previous) throw new NotFoundException('Vehicle not found.');
      if (previous.deletedAt && !previous.isActive) return previous;
      if (previous.isActive) await this.assertNoOpenVrmsRepair(tx, id);

      const deleted = await tx.vehicle.update({
        where: { id },
        data: {
          deletedAt: new Date(),
          isActive: false,
        },
      });
      await this.fleetChanges.recordChange(tx, {
        entityType: 'VEHICLE',
        entityId: id,
        changeType: 'VEHICLE_DELETED',
      });
      return deleted;
    });
  }

  private async assertNoOpenVrmsRepair(
    tx: Prisma.TransactionClient,
    vehicleId: string,
  ): Promise<void> {
    const openRepair = await tx.vrmsRepairIntegrationState.findFirst({
      where: {
        vehicleId,
        status: VrmsRepairIntegrationStatus.OPEN,
      },
      select: { repairTicketId: true, repairTicketNumber: true },
    });
    if (openRepair) {
      throw new ConflictException(
        `Cannot deactivate this truck while VRMS repair ticket ${openRepair.repairTicketNumber ?? openRepair.repairTicketId} is open.`,
      );
    }
  }

  private async assertActiveGarage(garageId?: string): Promise<void> {
    if (!garageId?.trim()) {
      throw new BadRequestException('Garage branch is required.');
    }
    const garage = await this.prisma.garage.findFirst({
      where: { id: garageId, isActive: true, deletedAt: null },
      select: { id: true },
    });
    if (!garage) {
      throw new BadRequestException(
        'Select an active registered garage branch.',
      );
    }
  }

  private throwPlateConflict(error: unknown): never {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'P2002'
    ) {
      throw new BadRequestException('Plate number is already registered.');
    }
    throw error;
  }
}
