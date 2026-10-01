import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards, ParseUUIDPipe, Req } from '@nestjs/common';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { Roles, RoleSystem } from '../../../auth/decorators/roles.decorator';
import { SystemType, UserRole } from '@prisma/client';
import { VehiclesService, type VehicleAuditActor } from './vehicles.service';
import { CreateVehicleDto } from './dto/create-vehicle.dto';
import { UpdateVehicleDto } from './dto/update-vehicle.dto';

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

  @Roles(UserRole.ADMIN, UserRole.OPERATIONS)
  @Get(':id/audit')
  async auditHistory(@Param('id', ParseUUIDPipe) id: string) {
    return this.vehiclesService.findAuditHistory(id);
  }

  @Post()
  async create(@Body() dto: CreateVehicleDto) {
    return this.vehiclesService.create(dto);
  }

  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateVehicleDto,
    @Req() req: { user: VehicleAuditActor },
  ) {
    return this.vehiclesService.update(id, dto, req.user);
  }

  @Delete(':id')
  async delete(@Param('id', ParseUUIDPipe) id: string) {
    return this.vehiclesService.delete(id);
  }
}
