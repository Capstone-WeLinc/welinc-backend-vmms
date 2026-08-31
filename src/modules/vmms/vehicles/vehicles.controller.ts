import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { Roles } from '../../../auth/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { VehiclesService } from './vehicles.service';

@Controller('vehicles')
@UseGuards(JwtAuthGuard, RolesGuard)
export class VehiclesController {
  constructor(private readonly vehiclesService: VehiclesService) {}

  @Roles(
    UserRole.ADMIN,
    UserRole.OPERATIONS,
    UserRole.CHIEF_MECHANIC,
    UserRole.MECHANIC,
  )
  @Get()
  async list() {
    return this.vehiclesService.findAll();
  }

  @Roles(UserRole.ADMIN, UserRole.OPERATIONS)
  @Post()
  async create(@Body() dto: { plateNumber: string; model: string; capacity?: number; odometer?: number; status?: any }) {
    return this.vehiclesService.create(dto);
  }

  @Roles(UserRole.ADMIN, UserRole.OPERATIONS)
  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: { plateNumber?: string; model?: string; capacity?: number; odometer?: number; status?: any; isActive?: boolean },
  ) {
    return this.vehiclesService.update(id, dto);
  }

  @Roles(UserRole.ADMIN, UserRole.OPERATIONS)
  @Delete(':id')
  async delete(@Param('id', ParseUUIDPipe) id: string) {
    return this.vehiclesService.delete(id);
  }
}
