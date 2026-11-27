import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import { Prisma } from '@prisma/client';
import { PrismaService as DatabaseService } from '../shared/prisma.service';
import {
  NotificationsInboxQueryDto,
  NotificationCategory,
  NotificationReadState,
} from './notifications-inbox.dto';

type CursorPosition = { createdAt: string; id: string };
type InboxCursor = {
  version: 1;
  category: NotificationCategory | null;
  readState: NotificationReadState;
  general?: CursorPosition;
  maintenance?: CursorPosition;
};

const maintenanceKinds = {
  CREATED: 'New maintenance assignment',
  DUE: 'Maintenance due',
  OVERDUE: 'Maintenance overdue',
  ODOMETER_BUFFER: 'Odometer reminder',
} as const;

const maintenanceNotificationSelect = {
  id: true,
  scheduleId: true,
  kind: true,
  message: true,
  createdAt: true,
  readAt: true,
} satisfies Prisma.MaintenanceNotificationSelect;

type MaintenanceInboxRow = Prisma.MaintenanceNotificationGetPayload<{
  select: typeof maintenanceNotificationSelect;
}>;

function encodeCursor(cursor: InboxCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(
  value: string | undefined,
  category: NotificationCategory | undefined,
  readState: NotificationReadState,
): InboxCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    );
    if (!parsed || typeof parsed !== 'object') throw new Error();
    const cursor = parsed as Partial<InboxCursor>;
    if (
      cursor.version !== 1 ||
      cursor.category !== (category ?? null) ||
      cursor.readState !== readState
    ) {
      throw new Error();
    }
    for (const position of [cursor.general, cursor.maintenance]) {
      if (
        position &&
        (!isUUID(position.id, 'all') ||
          !Number.isFinite(Date.parse(position.createdAt)) ||
          new Date(position.createdAt).toISOString() !== position.createdAt)
      ) {
        throw new Error();
      }
    }
    if (!cursor.general && !cursor.maintenance) throw new Error();
    return cursor as InboxCursor;
  } catch {
    throw new BadRequestException('Invalid notification cursor.');
  }
}

function afterPosition(position?: CursorPosition) {
  if (!position) return undefined;
  const createdAt = new Date(position.createdAt);
  return {
    OR: [
      { createdAt: { lt: createdAt } },
      { createdAt, id: { lt: position.id } },
    ],
  };
}

@Injectable()
export class NotificationsService {
  constructor(
    @Inject(DatabaseService)
    private readonly prisma: DatabaseService,
  ) {}

  async inbox(userId: string, query: NotificationsInboxQueryDto) {
    const limit = query.limit ?? 30;
    const readState = query.readState ?? 'ALL';
    const cursor = decodeCursor(query.cursor, query.category, readState);
    const generalWhere: Prisma.NotificationWhereInput = {
      userId,
      ...(query.category ? { category: query.category } : {}),
      ...(readState === 'UNREAD' ? { isRead: false } : {}),
      ...(readState === 'READ' ? { isRead: true } : {}),
      ...afterPosition(cursor?.general),
    };
    const maintenanceWhere: Prisma.MaintenanceNotificationWhereInput = {
      userId,
      schedule: { deletedAt: null, assignedMechanicId: userId },
      ...(readState === 'UNREAD' ? { readAt: null } : {}),
      ...(readState === 'READ' ? { readAt: { not: null } } : {}),
      ...afterPosition(cursor?.maintenance),
    };

    const [
      generalRows,
      maintenanceRows,
      generalTotal,
      generalUnread,
      maintenanceTotal,
      maintenanceUnread,
    ] = await Promise.all([
      this.prisma.notification.findMany({
        where: generalWhere,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        select: {
          id: true,
          title: true,
          message: true,
          type: true,
          category: true,
          actionType: true,
          actionTargetId: true,
          maintenanceScheduleId: true,
          isRead: true,
          createdAt: true,
        },
      }),
      query.category && query.category !== 'MAINTENANCE'
        ? Promise.resolve<MaintenanceInboxRow[]>([])
        : this.prisma.maintenanceNotification.findMany({
            where: maintenanceWhere,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: limit + 1,
            select: maintenanceNotificationSelect,
          }),
      this.prisma.notification.count({ where: { userId } }),
      this.prisma.notification.count({ where: { userId, isRead: false } }),
      this.prisma.maintenanceNotification.count({
        where: {
          userId,
          schedule: { deletedAt: null, assignedMechanicId: userId },
        },
      }),
      this.prisma.maintenanceNotification.count({
        where: {
          userId,
          readAt: null,
          schedule: { deletedAt: null, assignedMechanicId: userId },
        },
      }),
    ]);

    const combined = [
      ...generalRows.map((item) => {
        const actionId = item.actionTargetId ?? item.maintenanceScheduleId;
        return {
          id: item.id,
          source: 'general' as const,
          category: item.category,
          title: item.title,
          message: item.message,
          severity: item.type,
          isRead: item.isRead,
          createdAt: item.createdAt,
          actionTarget:
            item.actionType && item.actionType !== 'NONE'
              ? { type: item.actionType, id: actionId }
              : null,
        };
      }),
      ...maintenanceRows.map((item) => ({
        id: item.id,
        source: 'maintenance' as const,
        category: 'MAINTENANCE',
        title:
          maintenanceKinds[item.kind as keyof typeof maintenanceKinds] ??
          'Maintenance update',
        message: item.message,
        severity: item.kind === 'OVERDUE' ? 'warning' : 'info',
        isRead: item.readAt !== null,
        createdAt: item.createdAt,
        actionTarget: { type: 'MAINTENANCE_SCHEDULE', id: item.scheduleId },
      })),
    ].sort(
      (left, right) =>
        right.createdAt.getTime() - left.createdAt.getTime() ||
        right.id.localeCompare(left.id) ||
        left.source.localeCompare(right.source),
    );

    const hasMore = combined.length > limit;
    const items = combined.slice(0, limit);
    const nextPosition: InboxCursor = {
      version: 1,
      category: query.category ?? null,
      readState,
      general: cursor?.general,
      maintenance: cursor?.maintenance,
    };
    for (const item of items) {
      nextPosition[item.source] = {
        createdAt: item.createdAt.toISOString(),
        id: item.id,
      };
    }

    return {
      items,
      nextCursor: hasMore ? encodeCursor(nextPosition) : null,
      counts: {
        total: generalTotal + maintenanceTotal,
        unread: generalUnread + maintenanceUnread,
      },
    };
  }

  async markInboxItemRead(
    userId: string,
    source: string,
    notificationId: string,
  ) {
    if (!isUUID(notificationId, 'all')) {
      throw new BadRequestException('A valid notification ID is required.');
    }
    if (source !== 'general' && source !== 'maintenance') {
      throw new BadRequestException('Invalid notification source.');
    }

    const result =
      source === 'general'
        ? await this.prisma.notification.updateMany({
            where: { id: notificationId, userId, isRead: false },
            data: { isRead: true },
          })
        : await this.prisma.maintenanceNotification.updateMany({
            where: {
              id: notificationId,
              userId,
              readAt: null,
              schedule: { deletedAt: null, assignedMechanicId: userId },
            },
            data: { readAt: new Date() },
          });
    if (!result.count) {
      const exists =
        source === 'general'
          ? await this.prisma.notification.findFirst({
              where: { id: notificationId, userId, isRead: true },
              select: { id: true },
            })
          : await this.prisma.maintenanceNotification.findFirst({
              where: {
                id: notificationId,
                userId,
                readAt: { not: null },
                schedule: { deletedAt: null, assignedMechanicId: userId },
              },
              select: { id: true },
            });
      if (!exists) throw new NotFoundException('Notification not found.');
    }
    return { updated: result.count };
  }

  async markAllRead(userId: string) {
    const [general, maintenance] = await this.prisma.$transaction([
      this.prisma.notification.updateMany({
        where: { userId, isRead: false },
        data: { isRead: true },
      }),
      this.prisma.maintenanceNotification.updateMany({
        where: {
          userId,
          readAt: null,
          schedule: { deletedAt: null, assignedMechanicId: userId },
        },
        data: { readAt: new Date() },
      }),
    ]);
    return { updated: general.count + maintenance.count };
  }

  listForUser(userId: string) {
    return this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        title: true,
        message: true,
        type: true,
        category: true,
        actionType: true,
        actionTargetId: true,
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
        category: true,
        actionType: true,
        actionTargetId: true,
        maintenanceScheduleId: true,
        isRead: true,
        createdAt: true,
      },
    });
  }
}
