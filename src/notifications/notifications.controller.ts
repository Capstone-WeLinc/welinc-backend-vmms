import { Controller, Get, Param, Patch, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @UseGuards(JwtAuthGuard)
  @Get()
  list(@Req() req: { user: { sub: string } }) {
    return this.notificationsService.listForUser(req.user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id/read')
  markAsRead(
    @Req() req: { user: { sub: string } },
    @Param('id') notificationId: string,
  ) {
    return this.notificationsService.markAsRead(req.user.sub, notificationId);
  }
}
