import { MaintenanceStatus } from '@prisma/client';
import { MaintenanceSchedulesService } from './maintenance-schedules.service';

const operations = {
  sub: 'ops-1',
  system: 'VMMS',
  roles: [{ system: 'VMMS', role: 'OPERATIONS' }],
};
const admin = {
  sub: 'admin-1',
  system: 'VMMS',
  roles: [{ system: 'VMMS', role: 'ADMIN' }],
};

describe('Maintenance-log void and delete permissions', () => {
  let prisma: any;
  let service: MaintenanceSchedulesService;

  beforeEach(() => {
    prisma = {
      user: {
        findFirst: jest.fn().mockImplementation(({ where }) =>
          Promise.resolve({
            id: where.id,
            name: 'Sample User',
            email: 'sample@example.invalid',
          }),
        ),
      },
      maintenanceSchedule: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'log-1',
          logNumber: 'MLG-20261110-0001',
          vehicleId: 'ABC123',
          status: MaintenanceStatus.COMPLETED,
          updatedAt: new Date(0),
          workOrderProgress: {},
        }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      maintenanceLogEditUnlock: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      maintenanceScheduleCancellation: {
        create: jest.fn().mockResolvedValue({ id: 'void-request' }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'void-request', reviewStatus: 'PENDING' }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      vehicle: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'vehicle-1', status: 'AVAILABLE' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $transaction: jest
        .fn()
        .mockImplementation((callback) => callback(prisma)),
    };
    service = new MaintenanceSchedulesService(prisma);
  });

  it('denies Operations log deletion with the required guidance message', async () => {
    await expect(service.remove('log-1', operations)).rejects.toThrow(
      'Deletion is restricted to Admin only. You may void this record instead.',
    );
    expect(prisma.maintenanceSchedule.update).not.toHaveBeenCalled();
  });

  it('allows active Admin to soft-delete a maintenance log', async () => {
    await expect(service.remove('log-1', admin)).resolves.toEqual({
      success: true,
    });
    expect(prisma.maintenanceSchedule.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'log-1', deletedAt: null },
        data: { deletedAt: expect.any(Date) },
      }),
    );
  });

  it('denies Operations schedule deactivation and directs them to the cancellation request flow', async () => {
    prisma.maintenanceSchedule.findFirst.mockResolvedValue({
      id: 'schedule-1',
      status: MaintenanceStatus.PENDING,
      logNumber: null,
      workOrderProgress: {},
    });
    await expect(service.remove('schedule-1', operations)).rejects.toThrow(
      'Operations must submit a cancellation request.',
    );
    expect(prisma.maintenanceSchedule.update).not.toHaveBeenCalled();
  });

  it('allows only active Admin to deactivate a non-log schedule', async () => {
    prisma.maintenanceSchedule.findFirst.mockResolvedValue({
      id: 'schedule-1',
      status: MaintenanceStatus.PENDING,
      logNumber: null,
      workOrderProgress: {},
    });
    await expect(service.remove('schedule-1', admin)).resolves.toEqual({
      success: true,
    });
    expect(prisma.maintenanceSchedule.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'schedule-1', deletedAt: null },
        data: { deletedAt: expect.any(Date) },
      }),
    );
  });

  it('submits a persisted log void request without cancelling the log before Admin approval', async () => {
    await expect(
      service.voidMaintenanceLog(
        'log-1',
        '  Duplicate sample entry  ',
        operations,
      ),
    ).resolves.toMatchObject({
      id: 'log-1',
      status: MaintenanceStatus.COMPLETED,
    });
    expect(prisma.maintenanceSchedule.updateMany).not.toHaveBeenCalled();
    expect(prisma.maintenanceLogEditUnlock.updateMany).toHaveBeenCalledWith({
      where: { scheduleId: 'log-1', consumedAt: null },
      data: { consumedAt: expect.any(Date) },
    });
    expect(prisma.maintenanceScheduleCancellation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        scheduleId: 'log-1',
        actorId: operations.sub,
        reason: 'Duplicate sample entry',
        previousStatus: MaintenanceStatus.COMPLETED,
        reviewStatus: 'PENDING',
      }),
    });
  });

  it('cancels and locks a completed log only after Admin approves the pending void request', async () => {
    prisma.maintenanceScheduleCancellation.findFirst.mockResolvedValue({
      id: 'void-request',
    });
    await expect(
      service.reviewCancellationRequest(
        'log-1',
        'void-request',
        'APPROVE',
        undefined,
        admin,
      ),
    ).resolves.toMatchObject({
      id: 'log-1',
      status: MaintenanceStatus.CANCELLED,
    });
    expect(prisma.maintenanceSchedule.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'log-1',
          status: MaintenanceStatus.COMPLETED,
          updatedAt: new Date(0),
          deletedAt: null,
        },
        data: expect.objectContaining({
          status: MaintenanceStatus.CANCELLED,
          workOrderProgress: { maintenanceLogLocked: true },
        }),
      }),
    );
    expect(
      prisma.maintenanceScheduleCancellation.updateMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'void-request',
          scheduleId: 'log-1',
          reviewStatus: 'PENDING',
        },
        data: expect.objectContaining({
          reviewStatus: 'APPROVED',
          reviewedById: admin.sub,
        }),
      }),
    );
  });

  it('leaves the completed log intact when Admin rejects the void request', async () => {
    prisma.maintenanceScheduleCancellation.findFirst.mockResolvedValue({
      id: 'void-request',
    });
    await expect(
      service.reviewCancellationRequest(
        'log-1',
        'void-request',
        'REJECT',
        'Keep this valid log',
        admin,
      ),
    ).resolves.toMatchObject({
      id: 'log-1',
      status: MaintenanceStatus.COMPLETED,
    });
    expect(prisma.maintenanceSchedule.updateMany).not.toHaveBeenCalled();
    expect(
      prisma.maintenanceScheduleCancellation.updateMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'void-request',
          scheduleId: 'log-1',
          reviewStatus: 'PENDING',
        },
        data: expect.objectContaining({
          reviewStatus: 'REJECTED',
          reviewReason: 'Keep this valid log',
        }),
      }),
    );
  });

  it.each([undefined, null, '', '   ', 123, 'x'.repeat(2001)])(
    'requires an Operations void reason (%p)',
    async (reason) => {
      await expect(
        service.voidMaintenanceLog('log-1', reason, operations),
      ).rejects.toThrow('void reason');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it('does not let Admin use Operations void and refuses schedules without a persisted log number', async () => {
    await expect(
      service.voidMaintenanceLog('log-1', 'Duplicate', admin),
    ).rejects.toMatchObject({ status: 403 });
    prisma.maintenanceSchedule.findFirst.mockResolvedValue({
      id: 'schedule-1',
      status: MaintenanceStatus.PENDING,
      logNumber: null,
      vehicleId: 'ABC123',
      updatedAt: new Date(0),
      workOrderProgress: {},
    });
    await expect(
      service.voidMaintenanceLog('schedule-1', 'Duplicate', operations),
    ).rejects.toThrow('Only a persisted maintenance log can be voided');
  });
});
