import { ConflictException } from '@nestjs/common';
import { MaintenanceStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma.service';
import { MaintenanceSchedulesService } from './maintenance-schedules.service';

describe('Pending schedule uniqueness', () => {
  const input = { vehicleId: ' ABC123 ', title: ' Engine Oil Change ', assignedMechanic: 'Mechanic' };
  const previous = { ...input, id: '00000000-0000-4000-8000-000000000001', status: 'PENDING', createdAt: new Date(), deletedAt: null };
  let prisma: any;
  let service: MaintenanceSchedulesService;
  const uniqueError = () => new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: '7' });
  beforeEach(() => {
    prisma = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      maintenanceSchedule: {
        create: jest.fn().mockImplementation(async ({ data }) => ({ ...previous, ...data })),
        findUniqueOrThrow: jest.fn().mockResolvedValue(previous),
        update: jest.fn().mockImplementation(async ({ data }) => ({ ...previous, ...data })),
      },
      user: { findMany: jest.fn().mockResolvedValue([{ id: 'mechanic', name: 'Mechanic' }]) },
      $transaction: jest.fn().mockImplementation(async (callback) => callback(prisma)),
    };
    service = new MaintenanceSchedulesService(prisma as PrismaService);
    jest.spyOn(service as any, 'syncVehicleStatus').mockResolvedValue(undefined);
  });

  it.each(['create', 'update'] as const)('blocks a duplicate %s before writing with the required warning', async (method) => {
    prisma.$queryRaw.mockResolvedValue([{ id: 'existing' }]);
    const result = method === 'create' ? service.create(input) : service.update(previous.id, input);
    await expect(result).rejects.toThrow('A pending schedule of this type already exists for this truck');
    expect(prisma.maintenanceSchedule.create).not.toHaveBeenCalled();
    expect(prisma.maintenanceSchedule.update).not.toHaveBeenCalled();
  });

  it('checks normalized keys, only active Pending rows, with bound parameters', async () => {
    await service.create(input);
    const query = prisma.$queryRaw.mock.calls[0][0] as Prisma.Sql;
    expect(query.sql).toContain("status = 'PENDING' AND deleted_at IS NULL");
    expect(query.sql).toContain('LOWER(BTRIM("vehicleId")) = LOWER(BTRIM(?))');
    expect(query.sql).toContain('LOWER(BTRIM(title)) = LOWER(BTRIM(?))');
    expect(query.values).toEqual([input.vehicleId, input.title]);
    expect(prisma.maintenanceSchedule.create).toHaveBeenCalledTimes(1);
  });

  it('allows editing the same Pending schedule by excluding its own ID', async () => {
    await service.update(previous.id, input);
    expect(prisma.$queryRaw.mock.calls[0][0].values).toEqual([input.vehicleId, input.title, previous.id]);
    expect(prisma.maintenanceSchedule.update).toHaveBeenCalledTimes(1);
  });

  it('requires the audited cancellation endpoint instead of a general update', async () => {
    prisma.$queryRaw.mockResolvedValue([{ id: 'other' }]);
    await expect(service.update(previous.id, { ...input, status: MaintenanceStatus.CANCELLED })).rejects.toThrow('Use the cancellation endpoint');
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.maintenanceSchedule.update).not.toHaveBeenCalled();
  });

  it('blocks reactivation of cancelled work when a Pending schedule already exists', async () => {
    prisma.maintenanceSchedule.findUniqueOrThrow.mockResolvedValue({ ...previous, status: 'CANCELLED' });
    prisma.$queryRaw.mockResolvedValue([{ id: 'other' }]);
    await expect(service.update(previous.id, { ...input, status: MaintenanceStatus.PENDING })).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.maintenanceSchedule.update).not.toHaveBeenCalled();
  });

  it.each(['create', 'update'] as const)('translates a competing %s unique violation to HTTP 409', async (method) => {
    prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'winner' }]);
    prisma.maintenanceSchedule[method].mockRejectedValue(uniqueError());
    const result = method === 'create' ? service.create(input) : service.update(previous.id, input);
    await expect(result).rejects.toMatchObject({ status: 409, message: 'A pending schedule of this type already exists for this truck' });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('does not mislabel unrelated unique errors', async () => {
    const error = uniqueError();
    prisma.maintenanceSchedule.create.mockRejectedValue(error);
    await expect(service.create(input)).rejects.toBe(error);
  });

  it('preserves unexpected database failures', async () => {
    const error = new Error('connection lost');
    prisma.maintenanceSchedule.create.mockRejectedValue(error);
    await expect(service.create(input)).rejects.toBe(error);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });
});
