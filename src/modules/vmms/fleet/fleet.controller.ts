import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PrismaService } from '../../../shared/prisma.service';
import { ServiceRoute } from '../../../auth/verify/guards';

@Controller('fleet')
@ServiceRoute('fleet.read')
export class FleetController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('vehicles')
  async vehicles(@Query('garageId', new ParseUUIDPipe({ optional: true })) garageId: string | undefined, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const rows = await this.prisma.vehicle.findMany({
      where: { isActive: true, deletedAt: null, ...(garageId ? { garageId } : {}) },
      orderBy: { plateNumber: 'asc' },
      select: { id: true, plateNumber: true, make: true, model: true, year: true, truckSizeCategory: true, capacity: true, odometer: true, status: true, garageId: true, updatedAt: true },
    });
    return { vehicles: rows };
  }

  @Get('vehicles/:id')
  async vehicle(@Param('id', new ParseUUIDPipe()) id: string, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id, isActive: true, deletedAt: null },
      select: { id: true, plateNumber: true, make: true, model: true, year: true, truckSizeCategory: true, capacity: true, odometer: true, status: true, garageId: true, updatedAt: true },
    });
    if (!vehicle) throw new NotFoundException({ code: 'VEHICLE_NOT_FOUND', message: 'Vehicle not found.' });
    return vehicle;
  }

  @Get('garages')
  async garages(@Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const garages = await this.prisma.garage.findMany({ where: { isActive: true, deletedAt: null }, orderBy: { name: 'asc' }, select: { id: true, name: true } });
    return { garages };
  }
}
