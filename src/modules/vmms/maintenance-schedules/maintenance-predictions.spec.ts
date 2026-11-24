import { MaintenancePredictionsService } from './maintenance-predictions.service';

describe('MaintenancePredictionsService', () => {
  const vehicleId = '00000000-0000-4000-8000-000000000101';
  const scheduleId = '00000000-0000-4000-8000-000000000102';

  const createService = (auditRows: unknown[]) => {
    const prisma = {
      vehicle: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: vehicleId,
            plateNumber: 'ABC123',
            odometer: 1200,
          },
        ]),
      },
      maintenanceSchedule: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: scheduleId,
            workOrderNumber: 'WO-20261124-0001',
            vehicleId: 'ABC123',
            title: 'Oil change',
            status: 'PENDING',
            triggerType: 'ODOMETER',
            startingReferenceReadingKm: 800,
            odometerReading: null,
            intervalKm: 500,
            bufferDistanceKm: 0,
            intervalType: 'ODOMETER',
            startReferenceDate: null,
            targetDueDate: null,
            timeIntervalValue: null,
            timeIntervalUnit: null,
          },
        ]),
      },
      vehicleAuditLog: {
        findMany: jest.fn().mockResolvedValue(auditRows),
      },
    };
    return new MaintenancePredictionsService(prisma as any);
  };

  it('returns a median-rate prediction within the 30-day horizon', async () => {
    const service = createService([
      {
        vehicleId,
        newValue: '800',
        createdAt: new Date('2026-09-15T08:00:00.000Z'),
      },
      {
        vehicleId,
        newValue: '1000',
        createdAt: new Date('2026-10-15T08:00:00.000Z'),
      },
      {
        vehicleId,
        newValue: '1200',
        createdAt: new Date('2026-11-24T08:00:00.000Z'),
      },
    ]);

    const result = await service.list();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      scheduleId,
      vehicleId: 'ABC123',
      currentOdometer: 1200,
      dueOdometer: 1300,
      remainingKm: 100,
      historyCount: 3,
    });
  });

  it('omits stale history whose latest reading differs from master odometer', async () => {
    const service = createService([
      { vehicleId, newValue: '700', createdAt: new Date('2026-10-01T08:00:00Z') },
      { vehicleId, newValue: '800', createdAt: new Date('2026-10-15T08:00:00Z') },
      { vehicleId, newValue: '900', createdAt: new Date('2026-11-01T08:00:00Z') },
    ]);

    await expect(service.list()).resolves.toEqual([]);
  });

  it('omits non-increasing audit history', async () => {
    const service = createService([
      { vehicleId, newValue: '1000', createdAt: new Date('2026-10-01T08:00:00Z') },
      { vehicleId, newValue: '900', createdAt: new Date('2026-10-15T08:00:00Z') },
      { vehicleId, newValue: '1000', createdAt: new Date('2026-11-01T08:00:00Z') },
    ]);

    await expect(service.list()).resolves.toEqual([]);
  });

  it('omits histories with fewer than three readings', async () => {
    const service = createService([
      { vehicleId, newValue: '900', createdAt: new Date('2026-10-15T08:00:00Z') },
      { vehicleId, newValue: '1000', createdAt: new Date('2026-11-24T08:00:00Z') },
    ]);

    await expect(service.list()).resolves.toEqual([]);
  });

  it('omits malformed odometer audit values', async () => {
    const service = createService([
      { vehicleId, newValue: 'invalid', createdAt: new Date('2026-10-01T08:00:00Z') },
      { vehicleId, newValue: '900', createdAt: new Date('2026-10-15T08:00:00Z') },
      { vehicleId, newValue: '1000', createdAt: new Date('2026-11-24T08:00:00Z') },
    ]);

    await expect(service.list()).resolves.toEqual([]);
  });
});
