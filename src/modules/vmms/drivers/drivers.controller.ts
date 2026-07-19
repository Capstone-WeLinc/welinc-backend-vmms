import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { Roles } from '../../../auth/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { DriversService } from './drivers.service';

@Controller('drivers')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DriversController {
  constructor(private readonly driversService: DriversService) {}

  @Get()
  async list() {
    return this.driversService.findAll();
  }

  @Roles(UserRole.ADMIN)
  @Post()
  async create(@Body() dto: { name: string; licenseNumber: string; isVerified?: boolean }) {
    return this.driversService.create(dto);
  }

  @Roles(UserRole.ADMIN)
  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: { name?: string; licenseNumber?: string; isVerified?: boolean; isActive?: boolean },
  ) {
    return this.driversService.update(id, dto);
  }

  @Roles(UserRole.ADMIN)
  @Delete(':id')
  async delete(@Param('id', ParseUUIDPipe) id: string) {
    return this.driversService.delete(id);
  }
}
