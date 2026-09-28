import { MaintenanceSchedulesService } from './maintenance-schedules.service';

describe('Audited cancellation', () => {
  const actor = { sub: 'ops', roles: [{ system: 'VMMS', role: 'OPERATIONS' }] };
  let prisma: any;
  let service: MaintenanceSchedulesService;
  beforeEach(() => {
    prisma = {
      user: { findFirst: jest.fn().mockResolvedValue({ id: 'ops', name: 'Operations User', email: 'ops@example.invalid' }) },
      maintenanceSchedule: {
        findFirst: jest.fn().mockResolvedValue({ id: 'schedule', status: 'PENDING', updatedAt: new Date(0) }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      maintenanceScheduleCancellation: {
        create: jest.fn().mockResolvedValue({ id: 'audit' }),
        findMany: jest.fn().mockResolvedValue([{ id: 'audit', reason: 'Duplicate' }]),
      },
      $transaction: jest.fn().mockImplementation((callback) => callback(prisma)),
    };
    service = new MaintenanceSchedulesService(prisma);
  });
  it.each(['PENDING', 'DUE', 'OVERDUE'])('cancels unstarted %s work and records authenticated identity in the same transaction', async (status) => {
    prisma.maintenanceSchedule.findFirst.mockResolvedValue({ id: 'schedule', status, updatedAt: new Date(0) });
    const result = await service.cancel('schedule', '  Duplicate  ', actor);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.maintenanceSchedule.updateMany).toHaveBeenCalledWith({
      where: { id: 'schedule', status, updatedAt: new Date(0), deletedAt: null }, data: { status: 'CANCELLED' },
    });
    expect(prisma.maintenanceScheduleCancellation.create).toHaveBeenCalledWith({ data: {
      scheduleId: 'schedule', actorId: 'ops', actorName: 'Operations User', actorEmail: 'ops@example.invalid', reason: 'Duplicate', previousStatus: status,
    } });
    expect(result).toMatchObject({ status: 'CANCELLED', cancellations: [{ id: 'audit' }] });
  });
  it.each([undefined, null, '', '   ', 123, 'a'.repeat(2001)])('rejects invalid reason %# without writing', async (reason) => {
    await expect(service.cancel('schedule', reason, actor)).rejects.toThrow('cancellation reason');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it.each(['IN_PROGRESS', 'DONE', 'COMPLETED'])('rejects cancellation after work has started (%s)', async (status) => {
    prisma.maintenanceSchedule.findFirst.mockResolvedValue({ status });
    await expect(service.cancel('schedule', 'Duplicate', actor)).rejects.toThrow('Schedule cannot be cancelled once work has started. Use ‘Extension’ instead.');
    expect(prisma.maintenanceSchedule.updateMany).not.toHaveBeenCalled();
  });
  it('does not append another audit for repeated cancellation', async () => {
    prisma.maintenanceSchedule.findFirst.mockResolvedValue({ status: 'CANCELLED' });
    await expect(service.cancel('schedule', 'Duplicate', actor)).rejects.toThrow('already been cancelled');
    expect(prisma.maintenanceScheduleCancellation.create).not.toHaveBeenCalled();
  });
  it('returns not found for a missing or archived schedule', async () => {
    prisma.maintenanceSchedule.findFirst.mockResolvedValue(null);
    await expect(service.cancel('schedule', 'Duplicate', actor)).rejects.toMatchObject({ status: 404 });
  });
  it('rejects an invalid role before writing', async () => {
    await expect(service.cancel('schedule', 'Duplicate', { sub: 'admin', roles: [{ system: 'VMMS', role: 'ADMIN' }] })).rejects.toMatchObject({ status: 403 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('rechecks the active Operations account', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    await expect(service.cancel('schedule', 'Duplicate', actor)).rejects.toMatchObject({ status: 403 });
    expect(prisma.maintenanceSchedule.updateMany).not.toHaveBeenCalled();
  });
  it('rejects a racing start/update without an audit entry', async () => {
    prisma.maintenanceSchedule.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.cancel('schedule', 'Duplicate', actor)).rejects.toMatchObject({ status: 409 });
    expect(prisma.maintenanceScheduleCancellation.create).not.toHaveBeenCalled();
  });
  it('propagates an audit failure so the transaction rolls back', async () => {
    prisma.maintenanceScheduleCancellation.create.mockRejectedValue(new Error('audit write failed'));
    await expect(service.cancel('schedule', 'Duplicate', actor)).rejects.toThrow('audit write failed');
  });
  it('rejects unaudited cancelled creation and updates', async () => {
    const input = { vehicleId: 'ABC', title: 'PMS', status: 'CANCELLED' as const };
    await expect(service.create(input)).rejects.toThrow('reason');
    await expect(service.update('schedule', input)).rejects.toThrow('cancellation endpoint');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
