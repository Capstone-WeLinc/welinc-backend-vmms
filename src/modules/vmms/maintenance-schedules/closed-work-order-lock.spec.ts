import { MaintenanceStatus } from '@prisma/client';
import { MaintenanceSchedulesService } from './maintenance-schedules.service';

describe('Completed and Cancelled maintenance-log locks', () => {
  const mechanic = {
    sub: 'mechanic-1',
    system: 'VMMS',
    roles: [{ system: 'VMMS', role: 'MECHANIC' }],
  };
  let prisma: any;
  let service: MaintenanceSchedulesService;

  beforeEach(() => {
    prisma = {
      maintenanceSchedule: {
        findFirst: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        update: jest.fn(),
      },
      $transaction: jest
        .fn()
        .mockImplementation((callback) => callback(prisma)),
    };
    service = new MaintenanceSchedulesService(prisma);
  });

  it.each([MaintenanceStatus.COMPLETED, MaintenanceStatus.CANCELLED])(
    'blocks progress and schedule edits for %s records',
    async (status) => {
      const schedule = {
        id: 'schedule-1',
        vehicleId: 'ABC123',
        title: 'Sample maintenance',
        status,
        assignedMechanic: 'Mechanic One',
        assignedMechanicId: mechanic.sub,
        chiefMechanicId: 'chief-1',
        updatedAt: new Date(0),
        workOrderProgress: {
          maintenanceLogLocked: status === MaintenanceStatus.CANCELLED,
        },
      };
      prisma.maintenanceSchedule.findFirst.mockResolvedValue(schedule);
      prisma.maintenanceSchedule.findUniqueOrThrow.mockResolvedValue(schedule);

      await expect(
        service.updateProgress('schedule-1', { action: 'SAVE' }, mechanic),
      ).rejects.toThrow('This work order is closed.');
      await expect(
        service.update('schedule-1', {
          vehicleId: 'ABC123',
          title: 'Changed sample',
        } as any),
      ).rejects.toThrow('Completed and Cancelled work orders are locked');
      expect(prisma.maintenanceSchedule.update).not.toHaveBeenCalled();
    },
  );

  it.each([MaintenanceStatus.COMPLETED, MaintenanceStatus.CANCELLED])(
    'blocks attachment changes for %s records',
    async (status) => {
      prisma.maintenanceSchedule.findFirst.mockResolvedValue({
        id: 'schedule-1',
        status,
        assignedMechanicId: mechanic.sub,
        workOrderProgress: {},
      });

      await expect(
        service.uploadAttachment(
          'schedule-1',
          'item-1',
          {
            originalname: 'sample.jpg',
            mimetype: 'image/jpeg',
            size: 10,
            buffer: Buffer.from('sample'),
          },
          mechanic,
        ),
      ).rejects.toThrow('Completed and Cancelled work orders are locked');
      await expect(
        service.deleteAttachment('schedule-1', 'attachment-1', mechanic),
      ).rejects.toThrow('Completed and Cancelled work orders are locked');
      expect(prisma.maintenanceSchedule.update).not.toHaveBeenCalled();
    },
  );
});
