import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { MaintenanceSchedulesService } from './maintenance-schedules.service';
import { PrismaService } from '../../../shared/prisma.service';

describe('MaintenanceSchedulesService', () => {
  let service: MaintenanceSchedulesService;
  let prisma: {
    maintenanceSchedule: {
      findMany: jest.MockedFunction<any>;
    };
  };

  beforeEach(() => {
    prisma = {
      maintenanceSchedule: {
        findMany: jest.fn() as jest.MockedFunction<any>,
      },
    };

    service = new MaintenanceSchedulesService(
      prisma as unknown as PrismaService,
    );
  });

  it('normalizes maintenance costs to numbers for API responses', async () => {
    prisma.maintenanceSchedule.findMany.mockResolvedValue([
      {
        id: 'schedule-1',
        workOrderNumber: 'WO-20261001-000042',
        vehicleId: 'ABC123',
        title: 'Oil Change',
        status: 'PENDING',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        assignedMechanic: 'Mechanic One',
        accountType: null,
        checklistTemplateId: null,
        garageId: null,
        odometerReading: null,
        triggerType: null,
        intervalKm: null,
        bufferDistanceKm: null,
        startingReferenceReadingKm: null,
        intervalType: null,
        startReferenceDate: null,
        previousScheduleId: null,
        workOrderProgress: null,
        partsCost: {
          toNumber: () => 125.5,
          toJSON: () => '125.50',
          toString: () => '125.50',
        },
        laborCost: {
          toNumber: () => 45.25,
          toJSON: () => '45.25',
          toString: () => '45.25',
        },
        totalCost: {
          toNumber: () => 170.75,
          toJSON: () => '170.75',
          toString: () => '170.75',
        },
        deletedAt: null,
      },
    ]);

    const result = await service.findAll();

    expect(result[0].partsCost).toBe(125.5);
    expect(result[0].laborCost).toBe(45.25);
    expect(result[0].totalCost).toBe(170.75);
    expect(result[0].workOrderNumber).toBe('WO-20261001-000042');
  });

  it('includes individual maintenance costs for Chiefs and omits them for Mechanics', async () => {
    prisma.maintenanceSchedule.findMany.mockResolvedValue([
      {
        id: 'schedule-cost-access',
        workOrderNumber: 'WO-20261001-000043',
        vehicleId: 'ABC123',
        title: 'Oil Change',
        status: 'DONE',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        assignedMechanic: 'Mechanic One',
        assignedMechanicId: 'mechanic-1',
        chiefMechanicId: 'chief-1',
        accountType: null,
        checklistTemplateId: null,
        garageId: null,
        odometerReading: null,
        triggerType: null,
        intervalKm: null,
        bufferDistanceKm: null,
        startingReferenceReadingKm: null,
        intervalType: null,
        startReferenceDate: null,
        previousScheduleId: null,
        approvalStatus: 'UNVERIFIED',
        workOrderProgress: null,
        partsCost: 125.5,
        laborCost: 45.25,
        totalCost: 170.75,
        deletedAt: null,
        cancellations: [],
      },
    ]);

    const mechanicResult = await service.findAll({
      sub: 'mechanic-1',
      system: 'VMMS',
      roles: [{ role: 'MECHANIC', system: 'VMMS' }],
    });
    expect(mechanicResult[0]).not.toHaveProperty('partsCost');
    expect(mechanicResult[0]).not.toHaveProperty('laborCost');
    expect(mechanicResult[0]).not.toHaveProperty('totalCost');

    const chiefResult = await service.findAll({
      sub: 'chief-1',
      system: 'VMMS',
      roles: [{ role: 'CHIEF_MECHANIC', system: 'VMMS' }],
    });
    expect(chiefResult[0].partsCost).toBe(125.5);
    expect(chiefResult[0].laborCost).toBe(45.25);
    expect(chiefResult[0].totalCost).toBe(170.75);
  });

  it('formats created dates using the Philippine calendar day', async () => {
    prisma.maintenanceSchedule.findMany.mockResolvedValue([
      {
        id: 'schedule-date-boundary',
        vehicleId: 'ABC123',
        title: 'Inspection',
        status: 'PENDING',
        createdAt: new Date('2026-09-30T16:05:00.000Z'),
        startDate: null,
        cancellations: [],
        partsCost: null,
        laborCost: null,
        totalCost: null,
      },
    ]);

    const result = await service.findAll();

    expect(result[0].date).toBe('2026-10-01');
  });

  it('does not create a recurring schedule before Chief Mechanic approval', async () => {
    const tx = {
      maintenanceSchedule: {
        upsert: jest.fn(),
      },
    } as any;

    await (service as any).createNextRecurringSchedule(tx, {
      id: 'schedule-1',
      vehicleId: 'ABC123',
      title: 'Oil Change',
      status: 'DONE',
      triggerType: 'ODOMETER',
      intervalKm: 5000,
      startReferenceDate: new Date('2026-01-01T00:00:00.000Z'),
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      assignedMechanic: 'Mechanic One',
      assignedMechanicId: 'mechanic-1',
      chiefMechanicId: 'chief-1',
      chiefMechanic: 'Chief Mechanic',
      accountType: null,
      checklistTemplateId: null,
      garageId: null,
      odometerReading: 25000,
      bufferDistanceKm: null,
      startingReferenceReadingKm: null,
      intervalType: null,
      previousScheduleId: null,
      workOrderProgress: null,
      partsCost: null,
      laborCost: null,
      totalCost: null,
      deletedAt: null,
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      created_at: new Date('2026-01-01T00:00:00.000Z'),
      updated_at: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(tx.maintenanceSchedule.upsert).not.toHaveBeenCalled();
  });
});
