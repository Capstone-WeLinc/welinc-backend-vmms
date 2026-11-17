import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma.service';
import * as XLSX from 'xlsx';
import { CreateVehicleDto } from './dto/create-vehicle.dto';
import { UpdateVehicleDto } from './dto/update-vehicle.dto';

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
  constructor(private readonly prisma: PrismaService) {}

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
  async create(dto: CreateVehicleDto) {
    await this.assertActiveGarage(dto.garageId);
    try {
      return await this.prisma.vehicle.create({
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
    } catch (error) {
      this.throwPlateConflict(error);
    }
  }

  async previewExcel(buffer: Buffer): Promise<VehicleImportResult> {
    let rows: unknown[][];
    try {
      const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
      const firstSheet = workbook.SheetNames[0];
      if (!firstSheet) throw new Error('The workbook has no worksheets.');
      rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[firstSheet], {
        header: 1,
        raw: false,
        defval: '',
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
        await this.prisma.vehicle.create({
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
        ...(dto.odometer !== undefined ? { odometer: dto.odometer } : {}),
        ...(dto.garageId !== undefined ? { garageId: dto.garageId } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      };

      return await this.prisma.$transaction(async (tx) => {
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
            odometer: true,
            garageId: true,
            status: true,
            isActive: true,
          },
        });
        if (!previous) throw new NotFoundException('Vehicle not found.');

        const updated = await tx.vehicle.update({
          where: { id },
          data,
          include: { garage: { select: { id: true, name: true } } },
        });
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

        return updated;
      });
    } catch (error) {
      this.throwPlateConflict(error);
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
    return this.prisma.vehicle.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        isActive: false,
      },
    });
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
