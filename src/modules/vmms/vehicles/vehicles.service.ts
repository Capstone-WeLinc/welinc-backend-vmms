import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma.service';
import { CreateVehicleDto } from './dto/create-vehicle.dto';
import { UpdateVehicleDto } from './dto/update-vehicle.dto';

export type VehicleAuditActor = { sub: string; email: string };

function auditValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

@Injectable()
export class VehiclesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    const vehicles = await this.prisma.vehicle.findMany({
      where: { deletedAt: null },
      orderBy: { plateNumber: 'asc' },
      include: { garage: { select: { id: true, name: true } } },
    });

    const completedSchedules = vehicles.length === 0
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
        lastMaintenanceByPlate.set(schedule.vehicleId, schedule.completedAt ?? schedule.createdAt);
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
      lastMaintenanceDate: lastMaintenanceByPlate.get(vehicle.plateNumber) ?? null,
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

  async update(id: string, dto: UpdateVehicleDto, actor: VehicleAuditActor) {
    if (dto.garageId !== undefined) await this.assertActiveGarage(dto.garageId);
    try {
      const data: Prisma.VehicleUncheckedUpdateInput = {
        ...(dto.plateNumber !== undefined ? { plateNumber: dto.plateNumber.trim() } : {}),
        ...(dto.make !== undefined ? { make: dto.make.trim() } : {}),
        ...(dto.model !== undefined ? { model: dto.model.trim() } : {}),
        ...(dto.year !== undefined ? { year: dto.year } : {}),
        ...(dto.engineType !== undefined ? { engineType: dto.engineType.trim() } : {}),
        ...(dto.truckSizeCategory !== undefined ? { truckSizeCategory: dto.truckSizeCategory.trim() } : {}),
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
        const changedFields = Object.keys(data).filter((field) =>
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
              previousValue: auditValue(previous[field as keyof typeof previous]),
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
      throw new BadRequestException('Select an active registered garage branch.');
    }
  }

  private throwPlateConflict(error: unknown): never {
    if (
      typeof error === 'object' && error !== null &&
      'code' in error && error.code === 'P2002'
    ) {
      throw new BadRequestException('Plate number is already registered.');
    }
    throw error;
  }
}
