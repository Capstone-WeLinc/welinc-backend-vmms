import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../shared/prisma.service';

@Injectable()
export class VehiclesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    const vehicles = await this.prisma.vehicle.findMany({
      where: { deletedAt: null },
      orderBy: { plateNumber: 'asc' },
    });

    return vehicles.map((vehicle) => ({
      id: vehicle.id,
      plateNumber: vehicle.plateNumber,
      model: vehicle.model,
      capacity: vehicle.capacity,
      status: vehicle.status,
      odometer: vehicle.odometer,
      isActive: vehicle.isActive,
    }));
  }
  async create(dto: { plateNumber: string; model: string; capacity?: number; odometer?: number; status?: any }) {
    return this.prisma.vehicle.create({
      data: {
        plateNumber: dto.plateNumber.trim(),
        model: dto.model.trim(),
        capacity: dto.capacity ?? 0,
        odometer: dto.odometer ?? 0,
        status: dto.status ?? 'AVAILABLE',
      },
    });
  }

  async update(id: string, dto: { plateNumber?: string; model?: string; capacity?: number; odometer?: number; status?: any; isActive?: boolean }) {
    return this.prisma.vehicle.update({
      where: { id },
      data: {
        ...(dto.plateNumber ? { plateNumber: dto.plateNumber.trim() } : {}),
        ...(dto.model ? { model: dto.model.trim() } : {}),
        ...(dto.capacity !== undefined ? { capacity: dto.capacity } : {}),
        ...(dto.odometer !== undefined ? { odometer: dto.odometer } : {}),
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
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
}
