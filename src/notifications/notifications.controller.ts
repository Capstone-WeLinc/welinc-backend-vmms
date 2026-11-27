import {
  Controller,
  Get,
  Param,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { NotificationsService } from './notifications.service';
import { NotificationsInboxQueryDto } from './notifications-inbox.dto';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @UseGuards(JwtAuthGuard)
  @Get('inbox')
  inbox(
    @Req() req: { user: { sub: string } },
    @Query() query: NotificationsInboxQueryDto,
  ) {
    return this.notificationsService.inbox(req.user.sub, query);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('inbox/read-all')
  markAllRead(@Req() req: { user: { sub: string } }) {
    return this.notificationsService.markAllRead(req.user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('inbox/:source/:id/read')
  markInboxItemRead(
    @Req() req: { user: { sub: string } },
    @Param('source') source: string,
    @Param('id') notificationId: string,
  ) {
    return this.notificationsService.markInboxItemRead(
      req.user.sub,
      source,
      notificationId,
    );
  }

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
