import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../shared/prisma.service';

@Injectable()
export class NotificationsService {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
  ) {}

  listForUser(userId: string) {
    return this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        title: true,
        message: true,
        type: true,
        maintenanceScheduleId: true,
        isRead: true,
        createdAt: true,
      },
    });
  }

  async markAsRead(userId: string, notificationId: string) {
    const notification = await this.prisma.notification.findFirst({
      where: { id: notificationId, userId },
    });

    if (!notification) {
      throw new NotFoundException('Notification not found.');
    }

    return this.prisma.notification.update({
      where: { id: notificationId },
      data: { isRead: true },
      select: {
        id: true,
        title: true,
        message: true,
        type: true,
        maintenanceScheduleId: true,
        isRead: true,
        createdAt: true,
      },
    });
  }
}
