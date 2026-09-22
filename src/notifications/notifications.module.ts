import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import SharedModule from '../shared/shared.module';
import { PrismaService } from '../shared/prisma.service';

@Module({
  imports: [SharedModule],
  controllers: [NotificationsController],
  providers: [PrismaService, NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
