import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../shared/prisma.service';
import { SystemType } from '@prisma/client';
import { BmsFleetChangesService } from '../integrations/bms/bms-fleet-changes.service';

@Injectable()
export class LocationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fleetChanges: BmsFleetChangesService,
  ) {}

  async getGarages() {
    const garages = await this.prisma.garage.findMany({
      where: { deletedAt: null },
      orderBy: { name: 'asc' },
    });
    return garages.map((g) => ({
      id: g.id,
      name: g.name,
      isActive: g.isActive,
    }));
  }

  async createGarage(dto: { name: string }) {
    return this.prisma.$transaction(async (tx) => {
      const garage = await tx.garage.create({
        data: { name: dto.name.trim() },
      });
      await this.fleetChanges.recordChange(tx, {
        entityType: 'GARAGE',
        entityId: garage.id,
        changeType: 'GARAGE_CREATED',
      });
      return garage;
    });
  }

  async updateGarage(id: string, dto: { name?: string; isActive?: boolean }) {
    return this.prisma.$transaction(async (tx) => {
      const previous = await tx.garage.findUnique({ where: { id } });
      if (!previous) throw new NotFoundException('Garage not found.');

      const data = {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      };
      const changed =
        (data.name !== undefined && data.name !== previous.name) ||
        (data.isActive !== undefined && data.isActive !== previous.isActive);
      if (!changed) return previous;

      const garage = await tx.garage.update({ where: { id }, data });
      await this.fleetChanges.recordChange(tx, {
        entityType: 'GARAGE',
        entityId: id,
        changeType: 'GARAGE_UPDATED',
      });
      return garage;
    });
  }

  async deleteGarage(id: string) {
    return this.prisma.$transaction(async (tx) => {
      const previous = await tx.garage.findUnique({ where: { id } });
      if (!previous) throw new NotFoundException('Garage not found.');
      if (previous.deletedAt && !previous.isActive) return previous;

      const garage = await tx.garage.update({
        where: { id },
        data: {
          deletedAt: new Date(),
          isActive: false,
        },
      });
      await this.fleetChanges.recordChange(tx, {
        entityType: 'GARAGE',
        entityId: id,
        changeType: 'GARAGE_DELETED',
      });
      return garage;
    });
  }

  getSystems() {
    const systems = Object.values(SystemType) as string[];
    return systems.map((s) => ({ id: s, name: s }));
  }
}
