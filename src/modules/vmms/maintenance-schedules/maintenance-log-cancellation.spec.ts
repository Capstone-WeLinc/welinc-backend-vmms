import { MaintenanceStatus } from '@prisma/client';
import { MaintenanceSchedulesService } from './maintenance-schedules.service';

describe('Admin maintenance-log cancellation', () => {
  const admin = { sub: 'admin-1', system: 'VMMS', roles: [{ system: 'VMMS', role: 'ADMIN' }] };
  let prisma: any;
  let service: MaintenanceSchedulesService;

  beforeEach(() => {
    prisma = {
      user: { findFirst: jest.fn().mockResolvedValue({ id: 'admin-1', name: 'Admin User', email: 'admin@example.invalid' }) },
      maintenanceSchedule: {
        findFirst: jest.fn().mockResolvedValue({ id: 'schedule-1', vehicleId: 'ABC123', status: MaintenanceStatus.IN_PROGRESS, updatedAt: new Date(0) }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      maintenanceScheduleCancellation: {
        create: jest.fn().mockResolvedValue({ id: 'cancellation-1' }),
        findMany: jest.fn().mockResolvedValue([{ id: 'cancellation-1', reason: 'Duplicate sample log' }]),
      },
      maintenanceLogEditUnlock: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      vehicle: {
        findFirst: jest.fn().mockResolvedValue({ id: 'vehicle-1', status: 'UNDER_MAINTENANCE' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn().mockImplementation((callback) => callback(prisma)),
    };
    service = new MaintenanceSchedulesService(prisma);
  });

  it.each([
    MaintenanceStatus.PENDING,
    MaintenanceStatus.DUE,
    MaintenanceStatus.OVERDUE,
    MaintenanceStatus.IN_PROGRESS,
    MaintenanceStatus.DONE,
    MaintenanceStatus.COMPLETED,
  ])('allows Admin to cancel %s with a reason and stores the previous stage', async (status) => {
    prisma.maintenanceSchedule.findFirst.mockResolvedValue({ id: 'schedule-1', vehicleId: 'ABC123', status, updatedAt: new Date(0) });
    const result = await service.cancelMaintenanceLog('schedule-1', '  Duplicate sample log  ', admin);

    expect(prisma.maintenanceSchedule.updateMany).toHaveBeenCalledWith({
      where: { id: 'schedule-1', status, updatedAt: new Date(0), deletedAt: null },
      data: expect.objectContaining({
        status: MaintenanceStatus.CANCELLED,
        workOrderProgress: expect.objectContaining({ maintenanceLogLocked: true }),
      }),
    });
    expect(prisma.maintenanceScheduleCancellation.create).toHaveBeenCalledWith({ data: {
      scheduleId: 'schedule-1', actorId: 'admin-1', actorName: 'Admin User', actorEmail: 'admin@example.invalid',
      reason: 'Duplicate sample log', previousStatus: status,
    } });
    expect(result).toMatchObject({ id: 'schedule-1', status: MaintenanceStatus.CANCELLED });
    expect(prisma.vehicle.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'AVAILABLE' } }));
  });

  it.each([undefined, null, '', '  ', 123, 'x'.repeat(2001)])('requires a valid reason (%p)', async (reason) => {
    await expect(service.cancelMaintenanceLog('schedule-1', reason, admin)).rejects.toThrow('cancellation reason');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects Operations and does not write', async () => {
    const operations = { sub: 'ops-1', roles: [{ system: 'VMMS', role: 'OPERATIONS' }] };
    await expect(service.cancelMaintenanceLog('schedule-1', 'Duplicate', operations)).rejects.toMatchObject({ status: 403 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rechecks active Admin status inside the transaction', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    await expect(service.cancelMaintenanceLog('schedule-1', 'Duplicate', admin)).rejects.toMatchObject({ status: 403 });
    expect(prisma.maintenanceSchedule.updateMany).not.toHaveBeenCalled();
  });

  it('rejects duplicate cancellation and optimistic concurrency conflicts', async () => {
    prisma.maintenanceSchedule.findFirst.mockResolvedValue({ id: 'schedule-1', status: MaintenanceStatus.CANCELLED, updatedAt: new Date(0) });
    await expect(service.cancelMaintenanceLog('schedule-1', 'Duplicate', admin)).rejects.toThrow('already been cancelled');

    prisma.maintenanceSchedule.findFirst.mockResolvedValue({ id: 'schedule-1', status: MaintenanceStatus.COMPLETED, updatedAt: new Date(0) });
    prisma.maintenanceSchedule.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.cancelMaintenanceLog('schedule-1', 'Duplicate', admin)).rejects.toMatchObject({ status: 409 });
    expect(prisma.maintenanceScheduleCancellation.create).not.toHaveBeenCalled();
  });
});
