import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../shared/prisma.service';

export type NotificationType = 'info' | 'success' | 'warning' | 'error';

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async listForUser(userId: string) {
    const prisma = this.prisma as any;

    return prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        title: true,
        message: true,
        type: true,
        isRead: true,
        createdAt: true,
      },
    });
  }

  async createForUser(userId: string, input: { title: string; message: string; type?: NotificationType }) {
    const prisma = this.prisma as any;

    return prisma.notification.create({
      data: {
        userId,
        title: input.title,
        message: input.message,
        type: input.type ?? 'info',
      },
      select: {
        id: true,
        title: true,
        message: true,
        type: true,
        isRead: true,
        createdAt: true,
      },
    });
  }

  async markAsRead(userId: string, notificationId: string) {
    const prisma = this.prisma as any;
    const notification = await prisma.notification.findFirst({
      where: { id: notificationId, userId },
    });

    if (!notification) {
      throw new NotFoundException('Notification not found.');
    }

    return prisma.notification.update({
      where: { id: notificationId },
      data: { isRead: true },
      select: {
        id: true,
        title: true,
        message: true,
        type: true,
        isRead: true,
        createdAt: true,
      },
    });
  }
}
