import { MaintenanceSchedulesService } from './maintenance-schedules.service';

describe('Admin-approved schedule cancellation requests', () => {
  const operations = { sub: 'ops', roles: [{ system: 'VMMS', role: 'OPERATIONS' }] };
  const admin = { sub: 'admin', roles: [{ system: 'VMMS', role: 'ADMIN' }] };
  let prisma: any;
  let service: MaintenanceSchedulesService;

  beforeEach(() => {
    prisma = {
      user: { findFirst: jest.fn().mockImplementation(({ where }) => ({
        id: where.id,
        name: where.id === 'admin' ? 'Admin User' : 'Operations User',
        email: where.id === 'admin' ? 'admin@example.invalid' : 'ops@example.invalid',
      })) },
      maintenanceSchedule: {
        findFirst: jest.fn().mockResolvedValue({ id: 'schedule', status: 'PENDING', updatedAt: new Date(0) }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      maintenanceScheduleCancellation: {
        create: jest.fn().mockResolvedValue({ id: 'request' }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([{ id: 'request', reason: 'Duplicate' }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn().mockImplementation((callback) => callback(prisma)),
    };
    service = new MaintenanceSchedulesService(prisma);
  });

  it.each(['PENDING', 'DUE', 'OVERDUE'])('%s schedule remains active until Admin approval', async (status) => {
    prisma.maintenanceSchedule.findFirst.mockResolvedValue({ id: 'schedule', status, updatedAt: new Date(0) });
    const result = await service.cancel('schedule', '  Duplicate  ', operations);

    expect(prisma.maintenanceSchedule.updateMany).not.toHaveBeenCalled();
    expect(prisma.maintenanceScheduleCancellation.create).toHaveBeenCalledWith({ data: {
      scheduleId: 'schedule', actorId: 'ops', actorName: 'Operations User', actorEmail: 'ops@example.invalid',
      reason: 'Duplicate', previousStatus: status, reviewStatus: 'PENDING',
    } });
    expect(result).toMatchObject({ status, cancellations: [{ id: 'request' }] });
  });

  it.each([undefined, null, '', '   ', 123, 'a'.repeat(2001)])('rejects invalid request reason %# without writing', async (reason) => {
    await expect(service.cancel('schedule', reason, operations)).rejects.toThrow('cancellation reason');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each(['IN_PROGRESS', 'DONE', 'COMPLETED'])('rejects a cancellation request after work has started (%s)', async (status) => {
    prisma.maintenanceSchedule.findFirst.mockResolvedValue({ status });
    await expect(service.cancel('schedule', 'Duplicate', operations)).rejects.toThrow('Schedule cannot be cancelled once work has started.');
    expect(prisma.maintenanceScheduleCancellation.create).not.toHaveBeenCalled();
  });

  it('does not allow duplicate pending requests', async () => {
    prisma.maintenanceScheduleCancellation.findFirst.mockResolvedValue({ id: 'existing-request' });
    await expect(service.cancel('schedule', 'Duplicate', operations)).rejects.toMatchObject({ status: 409 });
    expect(prisma.maintenanceScheduleCancellation.create).not.toHaveBeenCalled();
  });

  it('returns not found for a missing or archived schedule', async () => {
    prisma.maintenanceSchedule.findFirst.mockResolvedValue(null);
    await expect(service.cancel('schedule', 'Duplicate', operations)).rejects.toMatchObject({ status: 404 });
  });

  it('accepts requests only from an active Operations account', async () => {
    await expect(service.cancel('schedule', 'Duplicate', admin)).rejects.toMatchObject({ status: 403 });
    prisma.user.findFirst.mockResolvedValue(null);
    await expect(service.cancel('schedule', 'Duplicate', operations)).rejects.toMatchObject({ status: 403 });
    expect(prisma.maintenanceScheduleCancellation.create).not.toHaveBeenCalled();
  });

  it('approves a pending request and only then marks the schedule cancelled', async () => {
    prisma.maintenanceScheduleCancellation.findFirst.mockResolvedValue({ id: 'request' });
    const result = await service.reviewCancellationRequest('schedule', 'request', 'APPROVE', undefined, admin);

    expect(prisma.maintenanceSchedule.updateMany).toHaveBeenCalledWith({
      where: { id: 'schedule', status: { in: ['PENDING', 'DUE', 'OVERDUE'] }, deletedAt: null },
      data: { status: 'CANCELLED' },
    });
    expect(prisma.maintenanceScheduleCancellation.updateMany).toHaveBeenCalledWith({
      where: { id: 'request', scheduleId: 'schedule', reviewStatus: 'PENDING' },
      data: expect.objectContaining({
        reviewStatus: 'APPROVED', reviewedById: 'admin', reviewedByName: 'Admin User',
        reviewedByEmail: 'admin@example.invalid', reviewedAt: expect.any(Date),
      }),
    });
    expect(result).toMatchObject({ status: 'CANCELLED' });
  });

  it('rejects a request with an Admin reason and leaves the schedule active', async () => {
    prisma.maintenanceScheduleCancellation.findFirst.mockResolvedValue({ id: 'request' });
    const result = await service.reviewCancellationRequest('schedule', 'request', 'REJECT', 'Not approved', admin);

    expect(prisma.maintenanceSchedule.updateMany).not.toHaveBeenCalled();
    expect(prisma.maintenanceScheduleCancellation.updateMany).toHaveBeenCalledWith({
      where: { id: 'request', scheduleId: 'schedule', reviewStatus: 'PENDING' },
      data: expect.objectContaining({ reviewStatus: 'REJECTED', reviewReason: 'Not approved', reviewedById: 'admin' }),
    });
    expect(result).toMatchObject({ status: 'PENDING' });
  });

  it('requires an Admin and a reason to reject a request', async () => {
    await expect(service.reviewCancellationRequest('schedule', 'request', 'APPROVE', undefined, operations))
      .rejects.toMatchObject({ status: 403 });
    await expect(service.reviewCancellationRequest('schedule', 'request', 'REJECT', '  ', admin))
      .rejects.toThrow('rejection reason');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('does not approve a request if the schedule has started or changed state', async () => {
    prisma.maintenanceScheduleCancellation.findFirst.mockResolvedValue({ id: 'request' });
    prisma.maintenanceSchedule.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.reviewCancellationRequest('schedule', 'request', 'APPROVE', undefined, admin))
      .rejects.toMatchObject({ status: 409 });
    expect(prisma.maintenanceScheduleCancellation.updateMany).not.toHaveBeenCalled();
  });
});
