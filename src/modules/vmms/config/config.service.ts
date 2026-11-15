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

  async listMechanics() {
    const rows = await this.prisma.mechanic.findMany({
      where: { isActive: true, isOutsourced: false, userId: { not: null }, role: { in: ['MECHANIC', 'CHIEF_MECHANIC'] } },
      orderBy: { name: 'asc' },
      select: { userId: true, name: true, email: true, role: true, temporaryRoles: true },
    });
    return rows.filter((row) => row.userId && row.role && !row.temporaryRoles.includes(row.role)).map((row) => ({
      id: row.userId!, userId: row.userId!, name: row.name, email: row.email,
      role: row.role, roles: [{ role: row.role!, system: 'VMMS' }], temporaryRoles: row.temporaryRoles,
    }));
  }
}
