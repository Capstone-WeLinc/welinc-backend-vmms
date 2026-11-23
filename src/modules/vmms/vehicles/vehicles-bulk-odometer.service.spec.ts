import { BadRequestException } from '@nestjs/common';
import { VehiclesService } from './vehicles.service';

describe('VehiclesService.bulkUpdateOdometer', () => {
  const prisma = {
    $transaction: jest.fn(),
    vehicle: {
      findUnique: jest.fn(),
    },
  } as any;

  const service = new VehiclesService(prisma);
  const actor = { sub: 'ops-1', system: 'VMMS' } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.vehicle.findUnique.mockResolvedValue(null);
  });

  it('returns per-item results for updated, unchanged, duplicate, and domain errors', async () => {
    prisma.$transaction.mockImplementation(async (cb: any) => cb({}));

    const updateSpy = jest
      .spyOn(service as any, 'updateOdometerInTransaction')
      .mockImplementation(async (_tx: any, vehicleId: string, odometer: number) => {
        if (vehicleId === 'v-updated') {
          return { changed: true, vehicle: { id: vehicleId, odometer } };
        }
        if (vehicleId === 'v-unchanged') {
          return { changed: false, vehicle: { id: vehicleId, odometer } };
        }
        throw new BadRequestException(
          'Odometer cannot be lower than the current reading (1000).',
        );
      });

    const result = await service.bulkUpdateOdometer(
      [
        { vehicleId: 'v-updated', odometer: 1200 },
        { vehicleId: 'v-unchanged', odometer: 1000 },
        { vehicleId: 'v-error', odometer: 900 },
        { vehicleId: 'v-updated', odometer: 1300 },
      ],
      actor,
    );

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(updateSpy).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      updated: 0,
      unchanged: 1,
      failed: 3,
      results: [
        {
          vehicleId: 'v-updated',
          odometer: 1200,
          currentOdometer: null,
          status: 'ERROR',
          message: 'Vehicle is duplicated in this request.',
        },
        {
          vehicleId: 'v-unchanged',
          odometer: 1000,
          currentOdometer: 1000,
          status: 'UNCHANGED',
        },
        {
          vehicleId: 'v-error',
          odometer: 900,
          currentOdometer: null,
          status: 'ERROR',
          message: 'Odometer cannot be lower than the current reading (1000).',
        },
        {
          vehicleId: 'v-updated',
          odometer: 1300,
          currentOdometer: null,
          status: 'ERROR',
          message: 'Vehicle is duplicated in this request.',
        },
      ],
    });
  });

  it('rejects an empty bulk request', async () => {
    await expect(service.bulkUpdateOdometer([], actor)).rejects.toThrow(
      'Submit between 1 and 1,000 odometer updates to save.',
    );
  });
});
