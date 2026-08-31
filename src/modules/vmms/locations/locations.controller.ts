import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { Roles } from '../../../auth/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { LocationsService } from './locations.service';

@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class LocationsController {
  constructor(private readonly locationsService: LocationsService) {}

  @Roles(UserRole.ADMIN, UserRole.OPERATIONS, UserRole.CHIEF_MECHANIC, UserRole.MECHANIC)
  @Get('garages')
  async garages() {
    return this.locationsService.getGarages();
  }

  @Roles(UserRole.ADMIN, UserRole.OPERATIONS)
  @Post('garages')
  async createGarage(@Body() dto: { name: string }) {
    return this.locationsService.createGarage(dto);
  }

  @Roles(UserRole.ADMIN, UserRole.OPERATIONS)
  @Patch('garages/:id')
  async updateGarage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: { name?: string; isActive?: boolean },
  ) {
    return this.locationsService.updateGarage(id, dto);
  }

  @Roles(UserRole.ADMIN, UserRole.OPERATIONS)
  @Delete('garages/:id')
  async deleteGarage(@Param('id', ParseUUIDPipe) id: string) {
    return this.locationsService.deleteGarage(id);
  }

  @Roles(UserRole.ADMIN, UserRole.OPERATIONS, UserRole.CHIEF_MECHANIC, UserRole.MECHANIC)
  @Get('systems')
  async systems() {
    return this.locationsService.getSystems();
  }
}
