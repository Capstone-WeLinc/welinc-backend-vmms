import { Controller, Get, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { SystemType, UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { RoleSystem, Roles } from '../../../auth/decorators/roles.decorator';
import { ScheduledReportsService } from './scheduled-reports.service';

@Controller('reports')
@UseGuards(JwtAuthGuard, RolesGuard)
@RoleSystem(SystemType.VMMS)
@Roles(UserRole.ADMIN, UserRole.OPERATIONS)
export class ReportsController {
  constructor(private readonly reports: ScheduledReportsService) {}

  @Get('scheduled')
  listScheduledReports(@Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.reports.listScheduledReports();
  }
}
