import { validateScheduleMileage } from './schedule-mileage';
import { MaintenanceSchedulesService } from './maintenance-schedules.service';

describe('Odometer schedule validation', () => {
  const input = {
    vehicleId: 'ABC123',
    title: 'PMS',
    triggerType: 'ODOMETER' as const,
    odometerReading: '12000',
    intervalKm: '5000',
    startingReferenceReadingKm: '10000',
    bufferDistanceKm: '500',
  };
  const previous = {
    ...input,
    status: 'PENDING',
    odometerReading: 12000,
    intervalKm: 5000,
    startingReferenceReadingKm: 10000,
    bufferDistanceKm: 500,
  } as any;
  it('accepts a threshold above the authoritative current reading', () => {
    expect(validateScheduleMileage(input, undefined, 14000)).toMatchObject({
      odometerReading: 14000,
      intervalKm: 5000,
      startingReferenceReadingKm: 10000,
    });
  });
  it.each([15000, 15001])(
    'rejects a threshold at or behind vehicle mileage %s despite a stale submitted reading',
    (reading) => {
      expect(() => validateScheduleMileage(input, undefined, reading)).toThrow(
        "Odometer threshold must be greater than the truck's current odometer reading. It is the next future service trigger; if service is due now, use the existing due work order instead.",
      );
    },
  );
  it('also compares against a newer submitted reading', () => {
    expect(() =>
      validateScheduleMileage(
        { ...input, odometerReading: '16000' },
        undefined,
        12000,
      ),
    ).toThrow('must be greater');
  });
  it.each(['0', '', undefined, null])(
    'requires a positive interval (%s)',
    (intervalKm) => {
      expect(() =>
        validateScheduleMileage(
          { ...input, intervalKm } as any,
          undefined,
          12000,
        ),
      ).toThrow('interval must be greater than zero');
    },
  );
  it.each(['-1', '12.5', '12abc', '1e4', 'NaN', 'Infinity', ' ', '2147483648'])(
    'rejects malformed or unsupported mileage %s',
    (value) => {
      for (const field of [
        'odometerReading',
        'intervalKm',
        'bufferDistanceKm',
        'startingReferenceReadingKm',
      ]) {
        expect(() =>
          validateScheduleMileage(
            { ...input, [field]: value },
            undefined,
            12000,
          ),
        ).toThrow();
      }
    },
  );
  it('rejects a threshold sum that exceeds integer storage', () => {
    expect(() =>
      validateScheduleMileage(
        {
          ...input,
          startingReferenceReadingKm: '2147483640',
          intervalKm: '10',
        },
        undefined,
        12000,
      ),
    ).toThrow('supported mileage range');
  });
  it('accepts zero current mileage and zero buffer', () => {
    expect(
      validateScheduleMileage(
        {
          ...input,
          startingReferenceReadingKm: '0',
          odometerReading: '0',
          bufferDistanceKm: '0',
        },
        undefined,
        0,
      ),
    ).toMatchObject({ odometerReading: 0, bufferDistanceKm: 0 });
  });
  it('requires a reference and a known active vehicle reading', () => {
    expect(() =>
      validateScheduleMileage(
        { ...input, startingReferenceReadingKm: '' },
        undefined,
        12000,
      ),
    ).toThrow('reference reading is required');
    expect(() => validateScheduleMileage(input, undefined, null)).toThrow(
      'active truck',
    );
  });
  it('allows recording an existing threshold being reached or exceeded', () => {
    expect(
      validateScheduleMileage(
        { ...input, odometerReading: '16000' },
        previous,
        16000,
      ).odometerReading,
    ).toBe(16000);
  });
  it('cannot lower a previously recorded reading on an ordinary update', () => {
    expect(
      validateScheduleMileage(
        input,
        { ...previous, odometerReading: 18000 },
        16000,
      ).odometerReading,
    ).toBe(18000);
  });
  it.each([
    { intervalKm: '4000' },
    { startingReferenceReadingKm: '9000' },
    { vehicleId: 'OTHER' },
    { title: 'Other type' },
  ])(
    'rechecks a changed threshold, truck, or maintenance type (%j)',
    (change) => {
      expect(() =>
        validateScheduleMileage({ ...input, ...change }, previous, 16000),
      ).toThrow('must be greater');
    },
  );
  it('rechecks reactivated schedules', () => {
    expect(() =>
      validateScheduleMileage(
        input,
        { ...previous, status: 'CANCELLED' },
        16000,
      ),
    ).toThrow('must be greater');
  });
  it('uses saved mileage configuration on partial edits', () => {
    expect(
      validateScheduleMileage(
        {
          vehicleId: input.vehicleId,
          title: input.title,
          odometerReading: '16000',
        },
        previous,
        16000,
      ),
    ).toMatchObject({ intervalKm: 5000, startingReferenceReadingKm: 10000 });
  });
  it('does not impose a mileage threshold on time or manual schedules, but never truncates supplied values', () => {
    expect(
      validateScheduleMileage({
        vehicleId: 'ABC',
        title: 'PMS',
        triggerType: 'TIME',
        intervalKm: '',
      }),
    ).toMatchObject({ intervalKm: undefined });
    expect(() =>
      validateScheduleMileage({
        vehicleId: 'ABC',
        title: 'PMS',
        odometerReading: '1.5',
      }),
    ).toThrow('whole number');
  });
  it('looks up an active vehicle rather than trusting the request reading', async () => {
    const db = {
      vehicle: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'vehicle-1',
          odometer: 16000,
          defaultMaintenanceIntervalKm: null,
          defaultMaintenanceBufferKm: null,
        }),
      },
      vehicleMaintenanceDefault: { findUnique: jest.fn() },
    };
    const service = new MaintenanceSchedulesService(db as any);
    await expect(
      (service as any).resolveMileage(db, input, 'template-1'),
    ).rejects.toThrow('must be greater');
    expect(db.vehicle.findFirst).toHaveBeenCalledWith({
      where: {
        plateNumber: { equals: input.vehicleId, mode: 'insensitive' },
        deletedAt: null,
        isActive: true,
      },
      select: {
        id: true,
        odometer: true,
        defaultMaintenanceIntervalKm: true,
        defaultMaintenanceBufferKm: true,
      },
    });
  });

  it('uses a vehicle/category default pair when selected', async () => {
    const db = {
      vehicle: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'vehicle-1',
          odometer: 12000,
          defaultMaintenanceIntervalKm: 5000,
          defaultMaintenanceBufferKm: 500,
        }),
      },
      vehicleMaintenanceDefault: {
        findUnique: jest.fn().mockResolvedValue({
          intervalKm: 8000,
          bufferDistanceKm: 800,
        }),
      },
    };
    const service = new MaintenanceSchedulesService(db as any);

    await expect(
      (service as any).resolveMileage(
        db,
        {
          ...input,
          startingReferenceReadingKm: '12000',
          useVehicleDefaults: true,
        },
        'template-1',
      ),
    ).resolves.toMatchObject({
      intervalKm: 8000,
      bufferDistanceKm: 800,
      startingReferenceReadingKm: 12000,
    });
  });

  it('falls back to vehicle base defaults when no category override exists', async () => {
    const db = {
      vehicle: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'vehicle-1',
          odometer: 12000,
          defaultMaintenanceIntervalKm: 5000,
          defaultMaintenanceBufferKm: 500,
        }),
      },
      vehicleMaintenanceDefault: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    const service = new MaintenanceSchedulesService(db as any);

    await expect(
      (service as any).resolveMileage(
        db,
        {
          ...input,
          startingReferenceReadingKm: '12000',
          useVehicleDefaults: true,
        },
        'template-1',
      ),
    ).resolves.toMatchObject({ intervalKm: 5000, bufferDistanceKm: 500 });
  });

  it('requires custom interval and buffer when no default is selected', async () => {
    const db = {
      vehicle: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'vehicle-1',
          odometer: 12000,
          defaultMaintenanceIntervalKm: 5000,
          defaultMaintenanceBufferKm: 500,
        }),
      },
      vehicleMaintenanceDefault: { findUnique: jest.fn() },
    };
    const service = new MaintenanceSchedulesService(db as any);

    await expect(
      (service as any).resolveMileage(
        db,
        { ...input, bufferDistanceKm: '' },
        'template-1',
      ),
    ).rejects.toThrow('require both an interval and buffer');
  });
});
