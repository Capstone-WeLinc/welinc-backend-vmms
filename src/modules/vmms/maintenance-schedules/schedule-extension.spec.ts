import { ConflictException, BadRequestException } from '@nestjs/common';
import {
  MaintenanceScheduleExtensionAuditEventType,
  MaintenanceScheduleExtensionReviewStatus,
  MaintenanceScheduleRescheduleSource,
  MaintenanceStatus,
} from '@prisma/client';
import { PrismaService } from '../../../shared/prisma.service';
import { MaintenanceSchedulesService } from './maintenance-schedules.service';
import { ScheduleActor } from './schedule-access';

describe('Maintenance schedule extensions', () => {
  const scheduleId = '00000000-0000-4000-8000-000000000001';
  const mechanic: ScheduleActor = {
    sub: '00000000-0000-4000-8000-000000000002',
    name: 'Mechanic One',
    email: 'mechanic@example.test',
    system: 'VMMS',
    roles: [{ system: 'VMMS', role: 'MECHANIC' }],
  };
  const admin: ScheduleActor = {
    sub: '00000000-0000-4000-8000-000000000003',
    name: 'Admin One',
    email: 'admin@example.test',
    system: 'VMMS',
    roles: [{ system: 'VMMS', role: 'ADMIN' }],
  };
  const dueDate = new Date('2026-06-01T00:00:00.000Z');
  const requestedDueDate = new Date('2099-02-01T00:00:00.000Z');
  let service: MaintenanceSchedulesService;
  let prisma: any;
  let tx: any;

  beforeEach(() => {
    const schedule = {
      id: scheduleId,
      deletedAt: null,
      assignedMechanicId: mechanic.sub,
      status: MaintenanceStatus.IN_PROGRESS,
      workOrderProgress: { workflowStatus: 'In Progress' },
      targetDueDate: dueDate,
      startDate: new Date('2026-05-01T00:00:00.000Z'),
      updatedAt: new Date('2026-05-01T00:00:00.000Z'),
    };
    const request = {
      id: '00000000-0000-4000-8000-000000000004',
      scheduleId,
      actorId: mechanic.sub,
      actorName: mechanic.name,
      actorEmail: mechanic.email,
      requestedDueDate,
      reason: 'Part delivery delay',
      reviewStatus: MaintenanceScheduleExtensionReviewStatus.PENDING,
      createdAt: new Date('2026-05-20T12:00:00.000Z'),
    };
    tx = {
      maintenanceSchedule: {
        findFirst: jest.fn().mockResolvedValue(schedule),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      maintenanceScheduleExtension: {
        count: jest.fn().mockResolvedValue(0),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(request),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      maintenanceScheduleExtensionAudit: {
        create: jest.fn().mockResolvedValue({}),
      },
      maintenanceScheduleRescheduleAudit: {
        create: jest.fn().mockResolvedValue({}),
      },
    };
    prisma = {
      ...tx,
      $transaction: jest
        .fn()
        .mockImplementation((callback: (transaction: any) => unknown) =>
          callback(tx),
        ),
    };
    service = new MaintenanceSchedulesService(prisma as PrismaService);
  });

  it('creates a request and its audit event in one transaction', async () => {
    const result = await service.requestExtension(
      scheduleId,
      { requestedDueDate: '2099-02-01', reason: ' Part delivery delay ' },
      mechanic,
    );

    expect(result).toMatchObject({
      scheduleId,
      requestedDueDate: '2099-02-01',
      reason: 'Part delivery delay',
      reviewStatus: MaintenanceScheduleExtensionReviewStatus.PENDING,
    });
    expect(tx.maintenanceScheduleExtension.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          scheduleId,
          actorId: mechanic.sub,
          requestedDueDate,
          reason: 'Part delivery delay',
        }),
      }),
    );
    expect(tx.maintenanceScheduleExtensionAudit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: MaintenanceScheduleExtensionAuditEventType.REQUESTED,
          previousDueDate: dueDate,
          requestedDueDate,
        }),
      }),
    );
  });

  it('counts rejected submissions toward the two-request limit', async () => {
    tx.maintenanceScheduleExtension.count.mockResolvedValue(2);

    await expect(
      service.requestExtension(
        scheduleId,
        { requestedDueDate: '2099-02-01', reason: 'Part delay' },
        mechanic,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.maintenanceScheduleExtension.create).not.toHaveBeenCalled();
  });

  it('requires a valid date later than the current target due date', async () => {
    await expect(
      service.requestExtension(
        scheduleId,
        { requestedDueDate: '2026-06-01', reason: 'Part delay' },
        mechanic,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.maintenanceScheduleExtension.create).not.toHaveBeenCalled();
  });

  it('does not allow an unassigned mechanic to request an extension', async () => {
    tx.maintenanceSchedule.findFirst.mockResolvedValue({
      id: scheduleId,
      deletedAt: null,
      assignedMechanicId: '00000000-0000-4000-8000-000000000005',
      status: MaintenanceStatus.IN_PROGRESS,
      workOrderProgress: {},
      targetDueDate: dueDate,
    });

    await expect(
      service.requestExtension(
        scheduleId,
        { requestedDueDate: '2099-02-01', reason: 'Part delay' },
        mechanic,
      ),
    ).rejects.toThrow('Only the assigned mechanic');
    expect(tx.maintenanceScheduleExtension.create).not.toHaveBeenCalled();
  });

  it('does not treat other overdue states as in-progress work', async () => {
    tx.maintenanceSchedule.findFirst.mockResolvedValue({
      id: scheduleId,
      deletedAt: null,
      assignedMechanicId: mechanic.sub,
      status: MaintenanceStatus.OVERDUE,
      workOrderProgress: {
        overdueFromStatus: MaintenanceStatus.PENDING,
      },
      targetDueDate: dueDate,
    });

    await expect(
      service.requestExtension(
        scheduleId,
        { requestedDueDate: '2099-02-01', reason: 'Part delay' },
        mechanic,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.maintenanceScheduleExtension.create).not.toHaveBeenCalled();
  });

  it('restores overdue in-progress work when Admin approves a date not yet past', async () => {
    tx.maintenanceSchedule.findFirst.mockResolvedValue({
      id: scheduleId,
      deletedAt: null,
      status: MaintenanceStatus.OVERDUE,
      workOrderProgress: {
        workflowStatus: 'In Progress',
        overdueFromStatus: MaintenanceStatus.IN_PROGRESS,
      },
      targetDueDate: dueDate,
      startDate: new Date('2026-05-01T00:00:00.000Z'),
      updatedAt: new Date('2026-05-01T00:00:00.000Z'),
    });
    tx.maintenanceScheduleExtension.findFirst.mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000004',
      requestedDueDate,
      reviewStatus: MaintenanceScheduleExtensionReviewStatus.PENDING,
    });

    const result = await service.reviewExtensionRequest(
      scheduleId,
      '00000000-0000-4000-8000-000000000004',
      'APPROVE',
      undefined,
      admin,
    );

    expect(result.status).toBe(MaintenanceStatus.IN_PROGRESS);
    expect(tx.maintenanceSchedule.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          targetDueDate: requestedDueDate,
          status: MaintenanceStatus.IN_PROGRESS,
          workOrderProgress: { workflowStatus: 'In Progress' },
        }),
      }),
    );
    expect(tx.maintenanceScheduleRescheduleAudit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: MaintenanceScheduleRescheduleSource.EXTENSION_APPROVAL,
          newTargetDueDate: requestedDueDate,
        }),
      }),
    );
  });

  it('records an Admin rejection without changing the schedule', async () => {
    tx.maintenanceScheduleExtension.findFirst.mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000004',
      requestedDueDate,
      reviewStatus: MaintenanceScheduleExtensionReviewStatus.PENDING,
    });

    const result = await service.reviewExtensionRequest(
      scheduleId,
      '00000000-0000-4000-8000-000000000004',
      'REJECT',
      'Insufficient supporting details',
      admin,
    );

    expect(result.reviewStatus).toBe(
      MaintenanceScheduleExtensionReviewStatus.REJECTED,
    );
    expect(tx.maintenanceSchedule.updateMany).not.toHaveBeenCalled();
    expect(tx.maintenanceScheduleExtensionAudit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: MaintenanceScheduleExtensionAuditEventType.REJECTED,
          reason: 'Insufficient supporting details',
        }),
      }),
    );
  });

  it('requires an Admin rejection reason and leaves the schedule unchanged', async () => {
    await expect(
      service.reviewExtensionRequest(
        scheduleId,
        '00000000-0000-4000-8000-000000000004',
        'REJECT',
        '  ',
        admin,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns the current target due date with authorized extension history', async () => {
    prisma.maintenanceScheduleExtension.findMany = jest
      .fn()
      .mockResolvedValue([]);
    prisma.maintenanceScheduleExtensionAudit.findMany = jest
      .fn()
      .mockResolvedValue([]);
    prisma.maintenanceScheduleRescheduleAudit.findMany = jest
      .fn()
      .mockResolvedValue([]);

    await expect(
      service.getExtensionHistory(scheduleId, mechanic),
    ).resolves.toMatchObject({
      currentTargetDueDate: '2026-06-01',
      requests: [],
    });
    expect(prisma.maintenanceSchedule.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        select: { id: true, targetDueDate: true },
      }),
    );
  });
});
