import { ForbiddenException } from '@nestjs/common';
import { MaintenancePriority, MaintenanceStatus } from '@prisma/client';
import { MaintenanceSchedulesService } from './maintenance-schedules.service';

describe('maintenance work-order priority', () => {
  const makeService = (status = MaintenanceStatus.PENDING) => {
    const prisma = {
      maintenanceSchedule: {
        findUnique: jest.fn().mockResolvedValue({ id: 'schedule-1', status }),
        update: jest.fn().mockImplementation(async ({ data, select }) => ({
          id: 'schedule-1',
          ...(select.priority ? { priority: data.priority } : {}),
        })),
      },
    } as any;
    return { service: new MaintenanceSchedulesService(prisma), prisma };
  };

  it.each(['ADMIN', 'OPERATIONS'])('%s can change priority', async (role) => {
    const { service, prisma } = makeService();
    const actor = { sub: 'user-1', roles: [{ system: 'VMMS', role }] };

    await expect(
      service.updatePriority('schedule-1', MaintenancePriority.HIGH, actor),
    ).resolves.toEqual({
      id: 'schedule-1',
      priority: MaintenancePriority.HIGH,
    });
    expect(prisma.maintenanceSchedule.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'schedule-1' },
        data: { priority: MaintenancePriority.HIGH },
      }),
    );
  });

  it.each(['MECHANIC', 'CHIEF_MECHANIC'])(
    '%s cannot change priority',
    async (role) => {
      const { service, prisma } = makeService();
      const actor = { sub: 'user-1', roles: [{ system: 'VMMS', role }] };

      await expect(
        service.updatePriority('schedule-1', MaintenancePriority.LOW, actor),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.maintenanceSchedule.update).not.toHaveBeenCalled();
    },
  );

  it('does not allow priority edits on completed or cancelled work orders', async () => {
    for (const status of [
      MaintenanceStatus.COMPLETED,
      MaintenanceStatus.CANCELLED,
    ]) {
      const { service, prisma } = makeService(status);
      await expect(
        service.updatePriority('schedule-1', MaintenancePriority.MEDIUM, {
          sub: 'user-1',
          roles: [{ system: 'VMMS', role: 'OPERATIONS' }],
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.maintenanceSchedule.update).not.toHaveBeenCalled();
    }
  });
});
