import {
  Body,
  Controller,
  Get,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SystemType, UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { RoleSystem, Roles } from '../../../auth/decorators/roles.decorator';
import {
  MaintenanceCostingService,
  type MaintenanceCostingActor,
} from './maintenance-costing.service';
import { UpdateMaintenanceCostingThresholdDto } from './maintenance-costing.dto';

@Controller('maintenance-costing')
@UseGuards(JwtAuthGuard, RolesGuard)
@RoleSystem(SystemType.VMMS)
@Roles(UserRole.ADMIN, UserRole.OPERATIONS)
export class MaintenanceCostingController {
  constructor(private readonly costingService: MaintenanceCostingService) {}

  @Get()
  getDashboard(@Query('from') from?: string, @Query('to') to?: string) {
    return this.costingService.getDashboard(from, to);
  }

  @Patch('threshold')
  @Roles(UserRole.ADMIN)
  updateThreshold(
    @Body() body: UpdateMaintenanceCostingThresholdDto,
    @Req() req: { user: MaintenanceCostingActor },
  ) {
    return this.costingService.updateThreshold(body.threshold, req.user);
  }
}
