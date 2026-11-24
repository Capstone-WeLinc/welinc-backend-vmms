import { describe, expect, it, jest } from '@jest/globals';
import { MaintenanceSchedulesService } from './maintenance-schedules.service';
import { PrismaService } from '../../../shared/prisma.service';

describe('MaintenanceSchedulesService canonical response fields', () => {
  const createService = () => {
    const prisma = {
      maintenanceSchedule: {
        findMany: jest.fn() as jest.MockedFunction<any>,
      },
    };
    return {
      prisma,
      service: new MaintenanceSchedulesService(
        prisma as unknown as PrismaService,
      ),
    };
  };

  it('exposes canonical dueDate and computedStatus for TIME schedules with targetDueDate', async () => {
    const { prisma, service } = createService();
    prisma.maintenanceSchedule.findMany.mockResolvedValue([
      {
        id: 'time-future',
        workOrderNumber: 'WO-1',
        vehicleId: 'ABC123',
        title: 'PM',
        status: 'PENDING',
        priority: 'MEDIUM',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        targetDueDate: new Date('2099-12-31T00:00:00.000Z'),
        startDate: null,
        triggerType: 'TIME',
        intervalType: 'TIME',
        timeIntervalValue: 1,
        timeIntervalUnit: 'MONTHS',
        startReferenceDate: new Date('2026-01-01T00:00:00.000Z'),
        workOrderProgress: null,
        vrmsRepairReferrals: [],
        partsCost: null,
        laborCost: null,
        totalCost: null,
        deletedAt: null,
      },
    ]);

    const result = await service.findAll();

    expect(result[0].targetDueDate).toBe('2099-12-31');
    expect(result[0].dueDate).toBe('2099-12-31');
    expect(result[0].computedStatus).toBe('PENDING');
  });

  it('preserves workflow status in computedStatus for closed/completed schedules', async () => {
    const { prisma, service } = createService();
    prisma.maintenanceSchedule.findMany.mockResolvedValue([
      {
        id: 'done-past',
        workOrderNumber: 'WO-2',
        vehicleId: 'ABC123',
        title: 'PM',
        status: 'COMPLETED',
        priority: 'MEDIUM',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        targetDueDate: new Date('2000-01-01T00:00:00.000Z'),
        startDate: null,
        triggerType: 'TIME',
        intervalType: 'TIME',
        timeIntervalValue: 1,
        timeIntervalUnit: 'MONTHS',
        startReferenceDate: new Date('1999-01-01T00:00:00.000Z'),
        workOrderProgress: null,
        vrmsRepairReferrals: [],
        partsCost: null,
        laborCost: null,
        totalCost: null,
        deletedAt: null,
      },
    ]);

    const result = await service.findAll();

    expect(result[0].status).toBe('COMPLETED');
    expect(result[0].computedStatus).toBe('COMPLETED');
    expect(result[0].dueDate).toBe('2000-01-01');
  });

  it('exposes canonical dueOdometer for odometer schedules without recomputing stored derived status', async () => {
    const { prisma, service } = createService();
    prisma.maintenanceSchedule.findMany.mockResolvedValue([
      {
        id: 'odo-pending',
        workOrderNumber: 'WO-3',
        vehicleId: 'ABC123',
        title: 'Odo PM',
        status: 'PENDING',
        priority: 'MEDIUM',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        targetDueDate: null,
        startDate: null,
        triggerType: 'ODOMETER',
        intervalKm: 5000,
        startingReferenceReadingKm: 10000,
        intervalType: 'ODOMETER',
        workOrderProgress: null,
        vrmsRepairReferrals: [],
        partsCost: null,
        laborCost: null,
        totalCost: null,
        deletedAt: null,
      },
    ]);

    const result = await service.findAll();

    expect(result[0].dueOdometer).toBe(15000);
    expect(result[0].computedStatus).toBe('PENDING');
  });
});
