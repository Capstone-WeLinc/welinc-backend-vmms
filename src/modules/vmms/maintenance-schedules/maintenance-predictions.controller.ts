import { Controller, Get, UseGuards } from '@nestjs/common';
import { SystemType, UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { RoleSystem, Roles } from '../../../auth/decorators/roles.decorator';
import { MaintenancePredictionsService } from './maintenance-predictions.service';

@Controller('maintenance-schedules')
@UseGuards(JwtAuthGuard, RolesGuard)
@RoleSystem(SystemType.VMMS)
export class MaintenancePredictionsController {
  constructor(
    private readonly predictions: MaintenancePredictionsService,
  ) {}

  @Roles(UserRole.OPERATIONS)
  @Get('predictions')
  async list() {
    return this.predictions.list();
  }
}
