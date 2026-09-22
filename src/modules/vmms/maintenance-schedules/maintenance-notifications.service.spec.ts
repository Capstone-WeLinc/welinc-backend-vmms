import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../shared/prisma.service';
import { MaintenanceNotificationsService } from './maintenance-notifications.service';

describe('maintenance notifications', () => {
  const make = (dryRun = 'true') => {
    const prisma = { maintenanceSchedule: { findMany: jest.fn().mockResolvedValue([]) }, vehicle: { findMany: jest.fn().mockResolvedValue([]) }, maintenanceNotification: {
      findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn().mockResolvedValue({ count: 1 }), update: jest.fn(), upsert: jest.fn(),
    } };
    const config = { get: (key: string) => ({ SEMAPHORE_DRY_RUN: dryRun, SEMAPHORE_API_KEY: 'fake-key' })[key] };
    const service = new MaintenanceNotificationsService(prisma as unknown as PrismaService, config as ConfigService);
    return { service, prisma };
  };
  afterEach(() => jest.restoreAllMocks());
  it('persists each event with a unique recipient/schedule/kind key', async () => {
    const { service, prisma } = make();
    prisma.maintenanceSchedule.findMany.mockResolvedValue([{ id: 's', title: 'Oil', vehicleId: 'ABC', status: 'PENDING', assignedMechanicUser: { id: 'a', isActive: true, roles: [{ role: 'MECHANIC', system: 'VMMS' }] } }]);
    await service.evaluate();
    await service.evaluate();
    expect(prisma.maintenanceNotification.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.maintenanceNotification.upsert).toHaveBeenLastCalledWith(expect.objectContaining({ where: { userId_scheduleId_kind: { userId: 'a', scheduleId: 's', kind: 'CREATED' } }, update: {} }));
  });
  it('scopes inbox reads and read acknowledgements', async () => {
    const { service, prisma } = make();
    await service.list('a');
    await service.markRead('a', 'other-notification');
    expect(prisma.maintenanceNotification.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'a', schedule: { deletedAt: null, assignedMechanicId: 'a' } } }));
    expect(prisma.maintenanceNotification.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'other-notification', userId: 'a', readAt: null, schedule: { deletedAt: null, assignedMechanicId: 'a' } } }));
  });
  it('never sends in dry-run mode', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    await make().service.deliverPending();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('claims SMS once and records provider acceptance, not handset delivery', async () => {
    const { service, prisma } = make('false');
    prisma.maintenanceNotification.findMany.mockResolvedValue([{ id: 'n', userId: 'a', message: 'Maintenance is due', user: { contact: '09171234567' }, schedule: { assignedMechanicId: 'a' } }]);
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => [{ message_id: 1, status: 'Queued' }] } as Response);
    await service.deliverPending();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(prisma.maintenanceNotification.update).toHaveBeenCalledWith({ where: { id: 'n' }, data: { smsStatus: 'ACCEPTED', smsProviderId: '1' } });
    prisma.maintenanceNotification.updateMany.mockResolvedValue({ count: 0 });
    await service.deliverPending();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
  it('does not send stale assignments to former owners', async () => {
    const { service, prisma } = make('false');
    prisma.maintenanceNotification.findMany.mockResolvedValue([{ id: 'n', userId: 'a', user: { contact: '09171234567' }, schedule: { assignedMechanicId: 'b' } }]);
    await service.deliverPending();
    expect(prisma.maintenanceNotification.updateMany).not.toHaveBeenCalled();
  });
});
