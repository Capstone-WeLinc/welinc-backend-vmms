import { Injectable } from '@nestjs/common';
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

  async listSystems() {
    return Object.values(SystemType).map((value) => ({ id: value, name: value }));
  }

  async listUsers() {
    const users = await this.prisma.user.findMany({
      where: { isActive: true, deletedAt: null },
      select: {
        id: true,
        name: true,
        email: true,
        roles: { select: { role: true, system: true } },
      },
      orderBy: { name: 'asc' },
    });

    return users.map((user) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      roles: user.roles,
    }));
  }
}
