import { HttpException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { FuelActor } from './fuel.service';
import { FuelController } from './fuel.controller';
import { FuelReceiptScannerService } from './fuel-receipt-scanner.service';
import { FuelService } from './fuel.service';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';

const file = {
  originalname: 'receipt.jpg',
  mimetype: 'image/jpeg',
  buffer: Buffer.from('receipt bytes'),
};
const dto = {
  vehicleId: '00000000-0000-4000-8000-000000000001',
  stationId: '00000000-0000-4000-8000-000000000002',
  date: '2026-11-27',
  liters: 1,
  pricePerLiter: 1,
  odometer: 0,
  isFullTank: true,
  filledBy: 'Operations',
};

function actor(sub: string): FuelActor {
  return {
    sub,
    email: `${sub}@example.test`,
    roles: [{ system: 'VMMS', role: 'OPERATIONS' }],
  };
}

describe('FuelController receipt upload rate limit', () => {
  async function createController() {
    const fuel = { create: jest.fn().mockResolvedValue({}) };
    const moduleBuilder = Test.createTestingModule({
      controllers: [FuelController],
      providers: [
        { provide: FuelService, useValue: fuel },
        { provide: FuelReceiptScannerService, useValue: {} },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true });
    const module = await moduleBuilder.compile();
    return { controller: module.get(FuelController), fuel, module };
  }

  it('rejects the sixth upload attempt before calling the fuel service', async () => {
    const { controller, fuel, module } = await createController();
    try {
      const req = { user: actor('operations-a') };

      for (let attempt = 0; attempt < 5; attempt += 1)
        await controller.createWithReceipt(dto, file, req);

      let rejection: unknown;
      try {
        await controller.createWithReceipt(dto, file, req);
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(HttpException);
      expect(
        rejection instanceof HttpException ? rejection.getStatus() : null,
      ).toBe(429);
      expect(fuel.create).toHaveBeenCalledTimes(5);
    } finally {
      await module.close();
    }
  });

  it('keeps upload limits isolated by actor and expires attempts after one minute', async () => {
    const { controller, fuel, module } = await createController();
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);

    try {
      for (let attempt = 0; attempt < 5; attempt += 1)
        await controller.createWithReceipt(dto, file, {
          user: actor('operations-a'),
        });

      await expect(
        controller.createWithReceipt(dto, file, {
          user: actor('operations-b'),
        }),
      ).resolves.toEqual({});
      expect(() =>
        controller.createWithReceipt(dto, file, {
          user: actor('operations-a'),
        }),
      ).toThrow(HttpException);

      now.mockReturnValue(61_000);
      await expect(
        controller.createWithReceipt(dto, file, {
          user: actor('operations-a'),
        }),
      ).resolves.toEqual({});
      expect(fuel.create).toHaveBeenCalledTimes(7);
    } finally {
      now.mockRestore();
      await module.close();
    }
  });
});
