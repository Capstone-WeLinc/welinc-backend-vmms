import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../shared/prisma.service';
import { SystemType } from '@prisma/client';

@Injectable()
export class LocationsService {
  constructor(private readonly prisma: PrismaService) {}

  async getGarages() {
    const garages = await this.prisma.garage.findMany({
      where: { deletedAt: null },
      orderBy: { name: 'asc' },
    });
    return garages.map((g) => ({ id: g.id, name: g.name, isActive: g.isActive }));
  }

  async createGarage(dto: { name: string }) {
    return this.prisma.garage.create({
      data: {
        name: dto.name.trim(),
      },
    });
  }

  async updateGarage(id: string, dto: { name?: string; isActive?: boolean }) {
    return this.prisma.garage.update({
      where: { id },
      data: {
        ...(dto.name ? { name: dto.name.trim() } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });
  }

  async deleteGarage(id: string) {
    return this.prisma.garage.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        isActive: false,
      },
    });
  }

  async getSystems() {
    const systems = Object.values(SystemType) as string[];
    return systems.map((s, idx) => ({ id: s, name: s }));
  }
}
