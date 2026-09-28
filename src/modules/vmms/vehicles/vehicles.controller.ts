import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { Roles, RoleSystem } from '../../../auth/decorators/roles.decorator';
import { SystemType, UserRole } from '@prisma/client';
import { VehiclesService } from './vehicles.service';

@Controller('vehicles')
@UseGuards(JwtAuthGuard, RolesGuard)
@RoleSystem(SystemType.VMMS)
@Roles(UserRole.OPERATIONS)
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

  @Post()
  async create(@Body() dto: { plateNumber: string; model: string; capacity?: number; odometer?: number; status?: any }) {
    return this.vehiclesService.create(dto);
  }

  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: { plateNumber?: string; model?: string; capacity?: number; odometer?: number; status?: any; isActive?: boolean },
  ) {
    return this.vehiclesService.update(id, dto);
  }

  @Delete(':id')
  async delete(@Param('id', ParseUUIDPipe) id: string) {
    return this.vehiclesService.delete(id);
  }
}
