import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { SystemType, UserRole } from '@prisma/client';
import type { Response } from 'express';
import { RoleSystem, Roles } from '../../../../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../../auth/guards/roles.guard';
import { VrmsRepeatRepairAlertsService } from './vrms-repeat-repair-alerts.service';

@Controller('integrations/vrms/repeat-repairs')
@UseGuards(JwtAuthGuard, RolesGuard)
@RoleSystem(SystemType.VMMS)
export class VrmsRepeatRepairAlertsQueryController {
  constructor(
    private readonly repeatRepairAlerts: VrmsRepeatRepairAlertsService,
  ) {}

  @Roles(UserRole.ADMIN, UserRole.OPERATIONS)
  @Get()
  list(
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.repeatRepairAlerts.list(cursor, limit);
  }
}
