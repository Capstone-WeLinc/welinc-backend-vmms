import { PrismaService } from '../../../shared/prisma.service';
import { MaintenanceNotificationsService } from './maintenance-notifications.service';

describe('maintenance notifications', () => {
  const make = () => {
    const prisma = {
      maintenanceSchedule: { findMany: jest.fn().mockResolvedValue([]) },
      mechanic: { findUnique: jest.fn() },
      vehicle: { findMany: jest.fn().mockResolvedValue([]) },
      maintenanceNotification: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn(),
        upsert: jest.fn(),
      },
    };
    const service = new MaintenanceNotificationsService(
      prisma as unknown as PrismaService,
    );
    return { service, prisma };
  };
  afterEach(() => jest.restoreAllMocks());
  it('persists each event with a unique recipient/schedule/kind key', async () => {
    const { service, prisma } = make();
    prisma.maintenanceSchedule.findMany.mockResolvedValue([
      {
        id: 's',
        title: 'Oil',
        vehicleId: 'ABC',
        status: 'PENDING',
        assignedMechanicId: 'a',
      },
    ]);
    prisma.mechanic.findUnique.mockResolvedValue({
      userId: 'a',
      isActive: true,
      role: 'MECHANIC',
    });
    await service.evaluate();
    await service.evaluate();
    expect(prisma.maintenanceNotification.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.maintenanceNotification.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          userId_scheduleId_kind: {
            userId: 'a',
            scheduleId: 's',
            kind: 'CREATED',
          },
        },
        update: {},
      }),
    );
  });
  it('scopes inbox reads and read acknowledgements', async () => {
    const { service, prisma } = make();
    await service.list('a');
    await service.markRead('a', 'other-notification');
    expect(prisma.maintenanceNotification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: 'a',
          schedule: { deletedAt: null, assignedMechanicId: 'a' },
        },
      }),
    );
    expect(prisma.maintenanceNotification.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'other-notification',
          userId: 'a',
          readAt: null,
          schedule: { deletedAt: null, assignedMechanicId: 'a' },
        },
      }),
    );
  });
});
