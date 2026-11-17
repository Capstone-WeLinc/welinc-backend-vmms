import { MaintenanceStatus, VehicleStatus } from '@prisma/client';
import { MaintenanceSchedulesService } from './maintenance-schedules.service';
import { PrismaService } from '../../../shared/prisma.service';

describe('maintenance vehicle status synchronization', () => {
  let vehicle: { id: string; status: VehicleStatus; deletedAt: Date | null };
  let beforeWrite: (() => void) | undefined;
  let service: MaintenanceSchedulesService;
  let prisma: {
    vehicle: { findFirst: jest.Mock; updateMany: jest.Mock; update: jest.Mock };
    maintenanceSchedule: { findFirst: jest.Mock; update: jest.Mock };
    $transaction: jest.Mock;
  };
  const transitions: [MaintenanceStatus, VehicleStatus, VehicleStatus][] = [
    [
      MaintenanceStatus.IN_PROGRESS,
      VehicleStatus.AVAILABLE,
      VehicleStatus.UNDER_MAINTENANCE,
    ],
    [
      MaintenanceStatus.DONE,
      VehicleStatus.AVAILABLE,
      VehicleStatus.UNDER_MAINTENANCE,
    ],
    [
      MaintenanceStatus.COMPLETED,
      VehicleStatus.UNDER_MAINTENANCE,
      VehicleStatus.AVAILABLE,
    ],
    [
      MaintenanceStatus.CANCELLED,
      VehicleStatus.UNDER_MAINTENANCE,
      VehicleStatus.AVAILABLE,
    ],
  ];
  const sync = (status: MaintenanceStatus) =>
    (
      service as unknown as {
        syncVehicleStatus(
          plate: string,
          status: MaintenanceStatus,
        ): Promise<void>;
      }
    ).syncVehicleStatus('ABC123', status);

  beforeEach(() => {
    vehicle = {
      id: 'vehicle-1',
      status: VehicleStatus.AVAILABLE,
      deletedAt: null,
    };
    beforeWrite = undefined;
    prisma = {
      vehicle: {
        findFirst: jest.fn(async () =>
          vehicle.deletedAt ? null : { ...vehicle },
        ),
        update: jest.fn(),
        // Model the database's conditional write against the *current* row,
        // not the snapshot returned by findFirst. beforeWrite simulates VRMS.
        updateMany: jest.fn(async ({ where, data }) => {
          beforeWrite?.();
          if (
            where.id !== vehicle.id ||
            ('deletedAt' in where && where.deletedAt !== vehicle.deletedAt) ||
            where.status?.not === vehicle.status
          )
            return { count: 0 };
          vehicle.status = data.status;
          return { count: 1 };
        }),
      },
      maintenanceSchedule: { findFirst: jest.fn(), update: jest.fn() },
      $transaction: jest.fn(async (action) => action(prisma)),
    };
    service = new MaintenanceSchedulesService(
      prisma as unknown as PrismaService,
    );
  });

  it.each(transitions)(
    '%s preserves an existing UNDER_REPAIR status',
    async (status) => {
      vehicle.status = VehicleStatus.UNDER_REPAIR;
      await sync(status);
      expect(vehicle.status).toBe(VehicleStatus.UNDER_REPAIR);
      expect(prisma.vehicle.update).not.toHaveBeenCalled();
    },
  );

  it.each(transitions)(
    '%s preserves repair status set between read and write',
    async (status, initial) => {
      vehicle.status = initial;
      beforeWrite = () => {
        vehicle.status = VehicleStatus.UNDER_REPAIR;
      };
      await sync(status);
      expect(prisma.vehicle.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'vehicle-1',
          deletedAt: null,
          status: { not: VehicleStatus.UNDER_REPAIR },
        },
        data: {
          status:
            status === MaintenanceStatus.IN_PROGRESS ||
            status === MaintenanceStatus.DONE
              ? VehicleStatus.UNDER_MAINTENANCE
              : VehicleStatus.AVAILABLE,
        },
      });
      expect(vehicle.status).toBe(VehicleStatus.UNDER_REPAIR);
      expect(prisma.vehicle.update).not.toHaveBeenCalled();
    },
  );

  it.each(transitions)(
    '%s still updates an ordinary vehicle',
    async (status, initial, expected) => {
      vehicle.status = initial;
      await sync(status);
      expect(vehicle.status).toBe(expected);
      expect(prisma.vehicle.updateMany).toHaveBeenCalledTimes(1);
    },
  );

  it('does not write to a vehicle archived between read and write', async () => {
    vehicle.status = VehicleStatus.UNDER_MAINTENANCE;
    beforeWrite = () => {
      vehicle.deletedAt = new Date();
    };
    await sync(MaintenanceStatus.COMPLETED);
    expect(vehicle.status).toBe(VehicleStatus.UNDER_MAINTENANCE);
  });

  it.each([
    MaintenanceStatus.PENDING,
    MaintenanceStatus.DUE,
    MaintenanceStatus.OVERDUE,
  ])('%s does not change the vehicle status', async (status) => {
    await sync(status);
    expect(prisma.vehicle.updateMany).not.toHaveBeenCalled();
  });

  it('does not write when the vehicle already has the target status', async () => {
    vehicle.status = VehicleStatus.UNDER_MAINTENANCE;
    await sync(MaintenanceStatus.IN_PROGRESS);
    expect(prisma.vehicle.updateMany).not.toHaveBeenCalled();
  });

  it('does not write when the vehicle is missing', async () => {
    prisma.vehicle.findFirst.mockResolvedValue(null);
    await sync(MaintenanceStatus.COMPLETED);
    expect(prisma.vehicle.updateMany).not.toHaveBeenCalled();
  });

  it.each(['START', 'APPROVE'] as const)(
    'persists the %s workflow action without overriding repair status',
    async (action) => {
      vehicle.status = VehicleStatus.UNDER_REPAIR;
      const schedule = {
        id: 'schedule-1',
        vehicleId: 'ABC123',
        assignedMechanicId: 'mechanic-1',
        chiefMechanicId: 'chief-1',
        updatedAt: new Date(),
        odometerReading: null,
        startDate: new Date('2020-01-01T00:00:00.000Z'),
        status:
          action === 'START'
            ? MaintenanceStatus.PENDING
            : MaintenanceStatus.DONE,
        workOrderProgress:
          action === 'START'
            ? {}
            : {
                mechanicSubmitted: true,
                executionItems: [{ id: 'item-1', status: 'checked' }],
              },
      };
      prisma.maintenanceSchedule.findFirst.mockResolvedValue(schedule);
      prisma.maintenanceSchedule.update.mockImplementation(
        async ({ data }) => ({ ...schedule, ...data }),
      );
      const result = await service.updateProgress(
        'schedule-1',
        {
          action,
          inspectionItems: [{ id: 'item-1', status: 'pass' }],
        },
        {
          sub: action === 'START' ? 'mechanic-1' : 'chief-1',
          system: 'VMMS',
          roles: [
            {
              role: action === 'START' ? 'MECHANIC' : 'CHIEF_MECHANIC',
              system: 'VMMS',
            },
          ],
        },
      );
      expect(result.status).toBe(
        action === 'START'
          ? MaintenanceStatus.IN_PROGRESS
          : MaintenanceStatus.COMPLETED,
      );
      expect(vehicle.status).toBe(VehicleStatus.UNDER_REPAIR);
      expect(prisma.vehicle.update).not.toHaveBeenCalled();
    },
  );
});
