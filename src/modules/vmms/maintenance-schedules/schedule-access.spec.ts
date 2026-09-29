import { describe, expect, it, jest } from '@jest/globals';
import { scheduleScope, ScheduleActor } from './schedule-access';
import { MaintenanceSchedulesService } from './maintenance-schedules.service';
import { PrismaService } from '../../../shared/prisma.service';

const actor = (role = 'MECHANIC', system = 'VMMS'): ScheduleActor => ({ sub: 'mechanic-a', system, roles: [{ role, system }] });
describe('work order ownership', () => {
  it('uses immutable IDs and only VMMS roles', () => {
    expect(scheduleScope(actor())).toEqual({ assignedMechanicId: 'mechanic-a' });
    expect(scheduleScope(actor('CHIEF_MECHANIC'))).toEqual({ chiefMechanicId: 'mechanic-a' });
    expect(scheduleScope(actor('OPERATIONS'))).toEqual({});
    expect(() => scheduleScope(actor('ADMIN', 'VRMS'))).toThrow();
  });
  it('scopes list queries and fails closed if the schema query fails', async () => {
    const prisma = {
      maintenanceSchedule: {
        findMany: jest.fn(async (..._args: any[]) => { throw new Error('missing column'); }),
      },
      $queryRawUnsafe: jest.fn(async () => []),
    };
    const service = new MaintenanceSchedulesService(prisma as unknown as PrismaService);
    await expect(service.findAll(actor())).rejects.toThrow('missing column');
    expect(prisma.maintenanceSchedule.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { deletedAt: null, assignedMechanicId: 'mechanic-a' } }));
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });
  it('rejects progress writes to another mechanic order', async () => {
    const prisma = {
      maintenanceSchedule: {
        findFirst: jest.fn(async () => null),
        update: jest.fn(),
      },
    };
    const service = new MaintenanceSchedulesService(prisma as unknown as PrismaService);
    await expect(service.updateProgress('other-order', {}, actor())).rejects.toThrow('not assigned');
    expect(prisma.maintenanceSchedule.update).not.toHaveBeenCalled();
  });
  it('retains ownership in the write predicate to handle concurrent reassignment', async () => {
    const updatedAt = new Date('2026-01-01T00:00:00Z');
    const prisma: any = {};
    prisma.maintenanceSchedule = {
      findFirst: jest.fn(async () => ({ id: 'own-order', assignedMechanicId: 'mechanic-a', status: 'IN_PROGRESS', updatedAt })),
      update: jest.fn(async () => ({ id: 'own-order', status: 'IN_PROGRESS', workOrderProgress: {} })),
    };
    prisma.$transaction = jest.fn((callback: (transaction: any) => any) => callback(prisma));
    const service = new MaintenanceSchedulesService(prisma as unknown as PrismaService);
    jest.spyOn(service as any, 'syncVehicleStatus').mockResolvedValue(undefined);
    await service.updateProgress('own-order', { notes: 'Checked' }, actor());
    expect(prisma.maintenanceSchedule.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'own-order', deletedAt: null, updatedAt, AND: { assignedMechanicId: 'mechanic-a' } } }));
  });
});
