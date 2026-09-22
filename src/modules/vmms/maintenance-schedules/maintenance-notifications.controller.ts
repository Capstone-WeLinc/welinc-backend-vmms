import { Controller, Get, Patch, Param, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { Roles } from '../../../auth/decorators/roles.decorator';
import { MaintenanceNotificationsService } from './maintenance-notifications.service';
import type { ScheduleActor } from './schedule-access';

@Controller('maintenance-schedules/notifications')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.MECHANIC, UserRole.CHIEF_MECHANIC)
export class MaintenanceNotificationsController {
  constructor(private readonly notifications: MaintenanceNotificationsService) {}
  @Get()
  list(@Req() req: { user: ScheduleActor }) { return this.notifications.list(req.user.sub); }
  @Patch(':id/read')
  read(@Param('id') id: string, @Req() req: { user: ScheduleActor }) { return this.notifications.markRead(req.user.sub, id); }
}
