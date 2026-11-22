import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../shared/prisma.service.js';
import { SystemType } from '@prisma/client';

@Injectable()
export class VmmsConfigService {
  constructor(private readonly prisma: PrismaService) {}

  async listGarages() {
    const garages = await this.prisma.garage.findMany({
      where: { isActive: true, deletedAt: null },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });

    return garages;
  }

  async listVehicles() {
    const vehicles = await this.prisma.vehicle.findMany({
      where: { isActive: true, deletedAt: null },
      select: {
        id: true,
        plateNumber: true,
        model: true,
        status: true,
        odometer: true,
      },
      orderBy: { plateNumber: 'asc' },
    });

    return vehicles;
  }

  listSystems() {
    return Object.values(SystemType).map((value) => ({
      id: value,
      name: value,
    }));
  }

  async listOutsourcedProviders() {
    const providers = await this.prisma.outsourcedProvider.findMany({
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      select: { id: true, name: true, isActive: true },
    });
    const usageRows = await this.prisma.maintenanceSchedule.groupBy({
      by: ['outsourcedProvider'],
      where: { outsourcedProvider: { not: null } },
      _count: { _all: true },
    });
    const usageCounts = new Map<string, number>();
    for (const row of usageRows) {
      if (row.outsourcedProvider) {
        const key = row.outsourcedProvider.toLowerCase();
        usageCounts.set(key, (usageCounts.get(key) ?? 0) + row._count._all);
      }
    }

    return providers.map((provider) => ({
      ...provider,
      usageCount: usageCounts.get(provider.name.toLowerCase()) ?? 0,
    }));
  }

  async createOutsourcedProvider(rawName: string) {
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (!name || name.length > 150) {
      throw new BadRequestException(
        'Provider name must contain 1 to 150 characters.',
      );
    }
    const duplicate = await this.prisma.outsourcedProvider.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
      select: { id: true },
    });
    if (duplicate)
      throw new ConflictException('This provider is already registered.');
    return this.prisma.outsourcedProvider.create({ data: { name } });
  }

  async updateOutsourcedProvider(
    id: string,
    input: { name?: string; isActive?: boolean },
  ) {
    const current = await this.prisma.outsourcedProvider.findUnique({
      where: { id },
    });
    if (!current) throw new NotFoundException('Outsourced provider not found.');
    if (
      input.name !== undefined &&
      (typeof input.name !== 'string' ||
        !input.name.trim() ||
        input.name.trim().length > 150)
    ) {
      throw new BadRequestException(
        'Provider name must contain 1 to 150 characters.',
      );
    }
    if (input.isActive !== undefined && typeof input.isActive !== 'boolean') {
      throw new BadRequestException(
        'Provider active status must be true or false.',
      );
    }

    const name = input.name?.trim();
    if (name && name !== current.name) {
      const usageCount = await this.countOutsourcedProviderUsage(current.name);
      if (usageCount > 0) {
        throw new ConflictException(
          'A provider used by maintenance schedules cannot be renamed. Change its active status instead.',
        );
      }
      const duplicate = await this.prisma.outsourcedProvider.findFirst({
        where: { id: { not: id }, name: { equals: name, mode: 'insensitive' } },
        select: { id: true },
      });
      if (duplicate)
        throw new ConflictException('This provider is already registered.');
    }
    return this.prisma.outsourcedProvider.update({
      where: { id },
      data: {
        ...(name ? { name } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
      select: { id: true, name: true, isActive: true },
    });
  }

  async deleteOutsourcedProvider(id: string) {
    const current = await this.prisma.outsourcedProvider.findUnique({
      where: { id },
      select: { id: true, name: true },
    });
    if (!current) throw new NotFoundException('Outsourced provider not found.');

    const usageCount = await this.countOutsourcedProviderUsage(current.name);
    if (usageCount > 0) {
      throw new ConflictException(
        'A provider used by maintenance schedules cannot be deleted. Change its active status instead.',
      );
    }

    return this.prisma.outsourcedProvider.delete({
      where: { id },
      select: { id: true, name: true, isActive: true },
    });
  }

  private countOutsourcedProviderUsage(name: string) {
    return this.prisma.maintenanceSchedule.count({
      where: {
        outsourcedProvider: { equals: name, mode: 'insensitive' },
      },
    });
  }

  async listMechanics() {
    const rows = await this.prisma.mechanic.findMany({
      where: {
        isActive: true,
        isOutsourced: false,
        userId: { not: null },
        role: { in: ['MECHANIC', 'CHIEF_MECHANIC'] },
      },
      orderBy: { name: 'asc' },
      select: {
        userId: true,
        name: true,
        email: true,
        role: true,
        temporaryRoles: true,
      },
    });
    return rows
      .filter(
        (row) =>
          row.userId && row.role && !row.temporaryRoles.includes(row.role),
      )
      .map((row) => ({
        id: row.userId!,
        userId: row.userId!,
        name: row.name,
        email: row.email,
        role: row.role,
        roles: [{ role: row.role!, system: 'VMMS' }],
        temporaryRoles: row.temporaryRoles,
      }));
  }
}
