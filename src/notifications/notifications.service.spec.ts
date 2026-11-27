import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../shared/prisma.service';
import { NotificationsService } from './notifications.service';
import { NotificationsInboxQueryDto } from './notifications-inbox.dto';

const userId = 'c70e7c84-5c0c-4c79-8b10-8f66a44d9f85';

describe('NotificationsService inbox', () => {
  const make = () => {
    const prisma = {
      notification: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
      maintenanceNotification: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      $transaction: jest.fn(async (queries: Promise<unknown>[]) =>
        Promise.all(queries),
      ),
    };
    return {
      prisma,
      service: new NotificationsService(prisma as unknown as PrismaService),
    };
  };

  it('merges both sources in stable order and paginates without skipping either source', async () => {
    const { prisma, service } = make();
    const general = [
      {
        id: '9fa11fb0-8d63-4d51-96cd-18d0bbb5b41d',
        title: 'Fuel efficiency anomaly',
        message: 'Fuel warning',
        type: 'warning',
        category: 'FUEL',
        actionType: 'FUEL_MANAGEMENT',
        actionTargetId: '4c08f60c-0c44-4c0c-b345-47f0b5b69a52',
        maintenanceScheduleId: null,
        isRead: false,
        createdAt: new Date('2026-11-28T00:00:00.000Z'),
      },
      {
        id: '29b22fc1-9e74-4e62-a7dd-29e1ccc6c52e',
        title: 'Daily fleet report',
        message: 'Report ready',
        type: 'info',
        category: 'REPORT',
        actionType: 'REPORTS',
        actionTargetId: null,
        maintenanceScheduleId: null,
        isRead: true,
        createdAt: new Date('2026-11-28T00:00:00.000Z'),
      },
    ];
    const maintenance = [
      {
        id: '8ac330d2-af85-4f73-b8ee-3af2ddd7d63f',
        scheduleId: '5de552f4-d0a7-405f-9f23-5ff4fff9f74f',
        kind: 'OVERDUE',
        message: 'Work order overdue',
        createdAt: new Date('2026-11-28T00:00:00.000Z'),
        readAt: null,
      },
      {
        id: '1bd441e3-b096-4084-c9ff-40b3eee8e740',
        scheduleId: '6ef66305-e1b8-4160-a034-6005000a0850',
        kind: 'DUE',
        message: 'Work order due',
        createdAt: new Date('2026-11-28T00:00:00.000Z'),
        readAt: new Date('2026-11-28T00:00:00.000Z'),
      },
    ];
    prisma.notification.findMany
      .mockResolvedValueOnce(general)
      .mockResolvedValueOnce([general[1]]);
    prisma.maintenanceNotification.findMany
      .mockResolvedValueOnce(maintenance)
      .mockResolvedValueOnce([maintenance[1]]);
    prisma.notification.count
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1);
    prisma.maintenanceNotification.count
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1);

    const first = await service.inbox(userId, {
      limit: 2,
      readState: 'ALL',
    } as NotificationsInboxQueryDto);

    expect(first.items.map((item) => item.source)).toEqual([
      'general',
      'maintenance',
    ]);
    expect(first.items.map((item) => item.id)).toEqual([
      general[0].id,
      maintenance[0].id,
    ]);
    expect(first.counts).toEqual({ total: 4, unread: 2 });
    expect(first.nextCursor).toBeTruthy();
    expect(prisma.notification.findMany.mock.calls[0][0].where).toEqual(
      expect.objectContaining({ userId }),
    );
    expect(prisma.maintenanceNotification.findMany.mock.calls[0][0].where).toEqual(
      expect.objectContaining({
        userId,
        schedule: { deletedAt: null, assignedMechanicId: userId },
      }),
    );
    expect(prisma.notification.count).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ where: { userId } }),
    );
    expect(prisma.maintenanceNotification.count).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          userId,
          schedule: { deletedAt: null, assignedMechanicId: userId },
        },
      }),
    );

    const second = await service.inbox(userId, {
      limit: 2,
      readState: 'ALL',
      cursor: first.nextCursor!,
    } as NotificationsInboxQueryDto);

    expect(second.items.map((item) => item.source)).toEqual([
      'general',
      'maintenance',
    ]);
    expect(second.items[0].actionTarget).toEqual({
      type: 'REPORTS',
      id: null,
    });
    expect(second.nextCursor).toBeNull();
    expect(prisma.notification.findMany.mock.calls[1][0].where.OR).toEqual([
      { createdAt: { lt: general[0].createdAt } },
      { createdAt: general[0].createdAt, id: { lt: general[0].id } },
    ]);
    expect(
      prisma.maintenanceNotification.findMany.mock.calls[1][0].where.OR,
    ).toEqual([
      { createdAt: { lt: maintenance[0].createdAt } },
      {
        createdAt: maintenance[0].createdAt,
        id: { lt: maintenance[0].id },
      },
    ]);
  });

  it('does not advance an unconsumed source when one source dominates a page', async () => {
    const { prisma, service } = make();
    const generalRows = [
      {
        id: '9fa11fb0-8d63-4d51-96cd-18d0bbb5b41d',
        title: 'Newest fuel alert',
        message: 'Newest',
        type: 'warning',
        category: 'FUEL',
        actionType: 'FUEL_MANAGEMENT',
        actionTargetId: null,
        maintenanceScheduleId: null,
        isRead: false,
        createdAt: new Date('2026-11-28T02:00:00.000Z'),
      },
      {
        id: '8fa11fb0-8d63-4d51-96cd-18d0bbb5b41d',
        title: 'Second fuel alert',
        message: 'Second',
        type: 'warning',
        category: 'FUEL',
        actionType: 'FUEL_MANAGEMENT',
        actionTargetId: null,
        maintenanceScheduleId: null,
        isRead: false,
        createdAt: new Date('2026-11-28T01:00:00.000Z'),
      },
      {
        id: '7fa11fb0-8d63-4d51-96cd-18d0bbb5b41d',
        title: 'Third fuel alert',
        message: 'Third',
        type: 'warning',
        category: 'FUEL',
        actionType: 'FUEL_MANAGEMENT',
        actionTargetId: null,
        maintenanceScheduleId: null,
        isRead: false,
        createdAt: new Date('2026-11-28T00:30:00.000Z'),
      },
    ];
    const maintenanceRows = [
      {
        id: '6fa11fb0-8d63-4d51-96cd-18d0bbb5b41d',
        scheduleId: '5de552f4-d0a7-405f-9f23-5ff4fff9f74f',
        kind: 'DUE',
        message: 'Maintenance due',
        createdAt: new Date('2026-11-28T00:00:00.000Z'),
        readAt: null,
      },
    ];
    prisma.notification.findMany
      .mockResolvedValueOnce(generalRows)
      .mockResolvedValueOnce([generalRows[2]]);
    prisma.maintenanceNotification.findMany
      .mockResolvedValueOnce(maintenanceRows)
      .mockResolvedValueOnce(maintenanceRows);

    const first = await service.inbox(userId, {
      limit: 2,
      readState: 'ALL',
    } as NotificationsInboxQueryDto);
    const cursor = JSON.parse(
      Buffer.from(first.nextCursor!, 'base64url').toString('utf8'),
    );

    expect(first.items.map((item) => item.id)).toEqual([
      generalRows[0].id,
      generalRows[1].id,
    ]);
    expect(cursor.general.id).toBe(generalRows[1].id);
    expect(cursor.maintenance).toBeUndefined();

    const second = await service.inbox(userId, {
      limit: 2,
      readState: 'ALL',
      cursor: first.nextCursor!,
    } as NotificationsInboxQueryDto);

    expect(second.items.map((item) => item.id)).toEqual([
      generalRows[2].id,
      maintenanceRows[0].id,
    ]);
    expect(second.nextCursor).toBeNull();
    expect(
      prisma.maintenanceNotification.findMany.mock.calls[1][0].where.OR,
    ).toBeUndefined();
  });

  it('rejects a cursor reused with different filters', async () => {
    const { service } = make();
    await expect(
      service.inbox(userId, {
        cursor: 'eyJ2ZXJzaW9uIjoxfQ',
        limit: 20,
        category: 'FUEL',
        readState: 'UNREAD',
      } as NotificationsInboxQueryDto),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('applies category and read filters only to eligible inbox sources', async () => {
    const { prisma, service } = make();

    await service.inbox(userId, {
      category: 'FUEL',
      readState: 'UNREAD',
    } as NotificationsInboxQueryDto);

    expect(prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId,
          category: 'FUEL',
          isRead: false,
        }),
      }),
    );
    expect(prisma.maintenanceNotification.findMany).not.toHaveBeenCalled();
  });

  it('marks a general notification read idempotently within the authenticated user scope', async () => {
    const { prisma, service } = make();
    const notificationId = 'c70e7c84-5c0c-4c79-8b10-8f66a44d9f86';
    prisma.notification.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    prisma.notification.findFirst.mockResolvedValueOnce({ id: notificationId });

    await expect(
      service.markInboxItemRead(userId, 'general', notificationId),
    ).resolves.toEqual({ updated: 1 });
    await expect(
      service.markInboxItemRead(userId, 'general', notificationId),
    ).resolves.toEqual({ updated: 0 });
    expect(prisma.notification.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { id: notificationId, userId, isRead: false },
      }),
    );
    expect(prisma.notification.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: notificationId, userId, isRead: true },
      }),
    );
  });

  it('rejects an inaccessible maintenance notification after a reassignment', async () => {
    const { prisma, service } = make();
    const notificationId = 'c70e7c84-5c0c-4c79-8b10-8f66a44d9f86';
    prisma.maintenanceNotification.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.markInboxItemRead(userId, 'maintenance', notificationId),
    ).rejects.toThrow('Notification not found.');
    expect(prisma.maintenanceNotification.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: notificationId,
          userId,
          readAt: null,
          schedule: { deletedAt: null, assignedMechanicId: userId },
        },
      }),
    );
  });

  it('rejects unsupported read sources and invalid notification IDs', async () => {
    const { prisma, service } = make();
    const notificationId = 'c70e7c84-5c0c-4c79-8b10-8f66a44d9f86';

    await expect(
      service.markInboxItemRead(userId, 'unknown', notificationId),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.markInboxItemRead(userId, 'general', 'invalid-id'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.notification.updateMany).not.toHaveBeenCalled();
    expect(prisma.maintenanceNotification.updateMany).not.toHaveBeenCalled();
  });

  it('rejects malformed notification cursors', async () => {
    const { service } = make();
    const cursor = Buffer.from(
      JSON.stringify({
        version: 1,
        category: null,
        readState: 'ALL',
        general: {
          createdAt: '2026-11-28T00:00:00.000Z',
          id: 'not-a-uuid',
        },
      }),
    ).toString('base64url');

    await expect(
      service.inbox(userId, {
        cursor,
        readState: 'ALL',
      } as NotificationsInboxQueryDto),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('marks all inbox sources read only for the authenticated user', async () => {
    const { prisma, service } = make();
    prisma.notification.updateMany.mockResolvedValue({ count: 2 });
    prisma.maintenanceNotification.updateMany.mockResolvedValue({ count: 3 });

    await expect(service.markAllRead(userId)).resolves.toEqual({ updated: 5 });
    expect(prisma.notification.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId, isRead: false } }),
    );
    expect(prisma.maintenanceNotification.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId,
          readAt: null,
          schedule: { deletedAt: null, assignedMechanicId: userId },
        },
      }),
    );
  });
});
