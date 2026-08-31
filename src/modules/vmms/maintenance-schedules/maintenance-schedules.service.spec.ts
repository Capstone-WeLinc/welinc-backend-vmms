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
  });
});
