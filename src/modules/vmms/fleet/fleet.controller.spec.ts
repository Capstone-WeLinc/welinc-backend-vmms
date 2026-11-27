import type { Response } from 'express';
import { PrismaService } from '../../../shared/prisma.service';
import { FleetController } from './fleet.controller';

describe('FleetController outsourced provider read', () => {
  const prisma = {
    outsourcedProvider: { findMany: jest.fn() },
  };
  const controller = new FleetController(prisma as unknown as PrismaService);
  const response = { setHeader: jest.fn() } as unknown as Response;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns only active providers in name order without cacheable responses', async () => {
    const providers = [
      { id: 'provider-1', name: 'Northside Service' },
      { id: 'provider-2', name: 'Westside Service' },
    ];
    prisma.outsourcedProvider.findMany.mockResolvedValue(providers);

    await expect(controller.outsourcedProviders(response)).resolves.toEqual({
      providers,
    });

    expect(prisma.outsourcedProvider.findMany).toHaveBeenCalledWith({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
    expect(response.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'no-store',
    );
  });
});
