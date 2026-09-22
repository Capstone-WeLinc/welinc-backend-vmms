import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
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
  @Post()
  create(
    @Req() req: { user: { sub: string } },
    @Body() body: { title: string; message: string; type?: 'info' | 'success' | 'warning' | 'error' },
  ) {
    return this.notificationsService.createForUser(req.user.sub, body);
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
