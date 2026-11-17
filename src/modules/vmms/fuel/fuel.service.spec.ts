import { BadRequestException } from '@nestjs/common';
import { FuelService, type FuelActor } from './fuel.service';

const operations: FuelActor = {
  sub: 'ops-id',
  email: 'ops@example.test',
  roles: [{ system: 'VMMS', role: 'OPERATIONS' }],
};
const admin: FuelActor = {
  sub: 'admin-id',
  email: 'admin@example.test',
  roles: [{ system: 'VMMS', role: 'ADMIN' }],
};

describe('FuelService', () => {
  it('voids entries with a reason, keeps the record, writes audit, and resolves its open anomaly', async () => {
    const entry = { id: 'entry-id', isVoided: false, vehicleId: 'vehicle-id' };
    const tx = {
      fuelFillUp: {
        update: jest.fn().mockResolvedValue({ ...entry, isVoided: true }),
      },
      fuelAuditLog: { create: jest.fn().mockResolvedValue({}) },
      fuelAnomaly: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const prisma = {
      fuelFillUp: {
        findUnique: jest.fn().mockResolvedValue(entry),
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ ...entry, isVoided: true }),
      },
      $transaction: jest.fn((callback) => callback(tx)),
    };
    const service = new FuelService(prisma as any);

    await service.void('entry-id', 'Duplicate receipt', operations);

    expect(tx.fuelFillUp.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'entry-id' },
        data: expect.objectContaining({
          isVoided: true,
          voidReason: 'Duplicate receipt',
          voidedById: 'ops-id',
        }),
      }),
    );
    expect(tx.fuelAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'VOIDED',
          reason: 'Duplicate receipt',
          actorId: 'ops-id',
        }),
      }),
    );
    expect(tx.fuelAnomaly.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { fillUpId: 'entry-id', status: 'OPEN' },
        data: expect.objectContaining({ status: 'RESOLVED' }),
      }),
    );
  });

  it('requires a reason before voiding', async () => {
    const prisma = { fuelFillUp: { findUnique: jest.fn() } };
    const service = new FuelService(prisma as any);
    await expect(
      service.void('entry-id', '  ', operations),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.fuelFillUp.findUnique).not.toHaveBeenCalled();
  });

  it('blocks Operations from resolving a Critical anomaly until acknowledged', async () => {
    const anomaly = {
      id: 'anomaly-id',
      status: 'OPEN',
      createdAt: new Date(Date.now() - 8 * 86400000),
      acknowledgedAt: null,
      fillUpId: 'entry-id',
    };
    const prisma = {
      fuelAnomaly: {
        findUnique: jest.fn().mockResolvedValue(anomaly),
        update: jest.fn(),
      },
    };
    const service = new FuelService(prisma as any);
    await expect(
      service.updateAnomaly('anomaly-id', {}, operations),
    ).rejects.toThrow('require Chief Mechanic or Admin acknowledgment');
    expect(prisma.fuelAnomaly.update).not.toHaveBeenCalled();
  });

  it('lets Admin update the persisted threshold and writes its audit record', async () => {
    const tx = {
      fuelAnomalySetting: {
        findUnique: jest.fn().mockResolvedValue({ thresholdPercent: 20 }),
        upsert: jest.fn().mockResolvedValue({
          thresholdPercent: 15,
          updatedAt: new Date(),
          updatedByEmail: admin.email,
        }),
      },
      fuelAnomalyThresholdAudit: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = { $transaction: jest.fn((callback) => callback(tx)) };
    const service = new FuelService(prisma as any);
    await expect(
      service.updateAnomalyThreshold(15, admin),
    ).resolves.toMatchObject({
      thresholdPercent: 15,
      updatedByEmail: admin.email,
    });
    expect(tx.fuelAnomalySetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          thresholdPercent: 15,
          updatedById: admin.sub,
        }),
      }),
    );
    expect(tx.fuelAnomalyThresholdAudit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorId: admin.sub,
          previousThreshold: 20,
          newThreshold: 15,
        }),
      }),
    );
  });

  it('rejects Operations attempts to change the threshold before persistence', async () => {
    const prisma = { $transaction: jest.fn() };
    const service = new FuelService(prisma as any);
    await expect(
      service.updateAnomalyThreshold(15, operations),
    ).rejects.toThrow('do not have access');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
