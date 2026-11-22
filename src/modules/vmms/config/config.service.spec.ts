import { ConflictException } from '@nestjs/common';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PrismaService } from '../../../shared/prisma.service';
import { VmmsConfigService } from './config.service';

describe('VmmsConfigService outsourced providers', () => {
  const provider = {
    id: 'provider-1',
    name: 'Northside Service',
    isActive: true,
  };
  const prisma = {
    outsourcedProvider: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    maintenanceSchedule: {
      groupBy: jest.fn(),
      count: jest.fn(),
    },
  };
  const service = new VmmsConfigService(prisma as unknown as PrismaService);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lists provider usage case-insensitively across schedule history', async () => {
    prisma.outsourcedProvider.findMany.mockResolvedValue([provider]);
    prisma.maintenanceSchedule.groupBy.mockResolvedValue([
      { outsourcedProvider: 'Northside Service', _count: { _all: 2 } },
      { outsourcedProvider: 'NORTHSIDE SERVICE', _count: { _all: 1 } },
    ]);

    await expect(service.listOutsourcedProviders()).resolves.toEqual([
      { ...provider, usageCount: 3 },
    ]);
    expect(prisma.maintenanceSchedule.groupBy).toHaveBeenCalledWith({
      by: ['outsourcedProvider'],
      where: { outsourcedProvider: { not: null } },
      _count: { _all: true },
    });
  });

  it('rejects renaming a provider referenced by schedule history', async () => {
    prisma.outsourcedProvider.findUnique.mockResolvedValue(provider);
    prisma.maintenanceSchedule.count.mockResolvedValue(1);

    await expect(
      service.updateOutsourcedProvider(provider.id, { name: 'New Name' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.outsourcedProvider.update).not.toHaveBeenCalled();
  });

  it('allows renaming a provider without schedule history', async () => {
    prisma.outsourcedProvider.findUnique.mockResolvedValue(provider);
    prisma.maintenanceSchedule.count.mockResolvedValue(0);
    prisma.outsourcedProvider.findFirst.mockResolvedValue(null);
    prisma.outsourcedProvider.update.mockResolvedValue({
      ...provider,
      name: 'Southside Service',
    });

    await expect(
      service.updateOutsourcedProvider(provider.id, {
        name: 'Southside Service',
      }),
    ).resolves.toEqual({ ...provider, name: 'Southside Service' });
    expect(prisma.outsourcedProvider.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: provider.id },
        data: { name: 'Southside Service' },
      }),
    );
  });

  it('keeps provider names unique without regard to case', async () => {
    prisma.outsourcedProvider.findUnique.mockResolvedValue(provider);
    prisma.maintenanceSchedule.count.mockResolvedValue(0);
    prisma.outsourcedProvider.findFirst.mockResolvedValue({ id: 'provider-2' });

    await expect(
      service.updateOutsourcedProvider(provider.id, {
        name: 'NORTHSIDE SERVICE',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.outsourcedProvider.update).not.toHaveBeenCalled();
  });

  it('allows status changes and blocks deletion for a used provider', async () => {
    prisma.outsourcedProvider.findUnique.mockResolvedValue(provider);
    prisma.maintenanceSchedule.count.mockResolvedValue(1);
    prisma.outsourcedProvider.update.mockResolvedValue({
      ...provider,
      isActive: false,
    });

    await expect(
      service.updateOutsourcedProvider(provider.id, { isActive: false }),
    ).resolves.toEqual({ ...provider, isActive: false });
    await expect(
      service.deleteOutsourcedProvider(provider.id),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.outsourcedProvider.delete).not.toHaveBeenCalled();
  });

  it('allows deleting an unused provider', async () => {
    prisma.outsourcedProvider.findUnique.mockResolvedValue(provider);
    prisma.maintenanceSchedule.count.mockResolvedValue(0);
    prisma.outsourcedProvider.delete.mockResolvedValue(provider);

    await expect(
      service.deleteOutsourcedProvider(provider.id),
    ).resolves.toEqual(provider);
    expect(prisma.outsourcedProvider.delete).toHaveBeenCalledWith({
      where: { id: provider.id },
      select: { id: true, name: true, isActive: true },
    });
  });
});
