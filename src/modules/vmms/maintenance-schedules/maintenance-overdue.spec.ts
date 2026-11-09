import { MaintenanceIntervalType, MaintenanceStatus, MaintenanceTriggerType } from '@prisma/client';
import { MaintenanceOverdueService } from './maintenance-overdue.service';

describe('daily maintenance overdue marking', () => {
  let prisma: any;
  let service: MaintenanceOverdueService;

  beforeEach(() => {
    prisma = {
      maintenanceSchedule: {
        findMany: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    service = new MaintenanceOverdueService(prisma);
  });

  it('marks only pending, due, or in-progress schedules whose Manila due date has passed', async () => {
    const updatedAt = new Date('2026-01-01T00:00:00.000Z');
    prisma.maintenanceSchedule.findMany.mockResolvedValue([
      { id: 'pending-expired', status: MaintenanceStatus.PENDING, updatedAt, deletedAt: null, triggerType: MaintenanceTriggerType.TIME, startReferenceDate: new Date('2026-01-01T00:00:00.000Z'), intervalType: MaintenanceIntervalType.MONTHLY },
      { id: 'due-expired', status: MaintenanceStatus.DUE, updatedAt, deletedAt: null, triggerType: MaintenanceTriggerType.TIME, startReferenceDate: new Date('2026-01-01T00:00:00.000Z'), intervalType: MaintenanceIntervalType.MONTHLY },
      { id: 'active-expired', status: MaintenanceStatus.IN_PROGRESS, updatedAt, deletedAt: null, triggerType: MaintenanceTriggerType.TIME, startReferenceDate: new Date('2026-01-01T00:00:00.000Z'), intervalType: MaintenanceIntervalType.MONTHLY },
      { id: 'due-today', status: MaintenanceStatus.PENDING, updatedAt, deletedAt: null, triggerType: MaintenanceTriggerType.TIME, startReferenceDate: new Date('2026-02-04T00:00:00.000Z'), intervalType: MaintenanceIntervalType.MONTHLY },
      { id: 'manual-target-expired', status: MaintenanceStatus.PENDING, updatedAt, deletedAt: null, triggerType: MaintenanceTriggerType.MANUAL, targetDueDate: new Date('2026-03-01T00:00:00.000Z') },
      { id: 'without-calendar-due-date', status: MaintenanceStatus.PENDING, updatedAt, deletedAt: null, triggerType: MaintenanceTriggerType.MANUAL },
    ]);

    const count = await service.markOverdue(new Date('2026-03-04T00:00:00.000Z'));

    expect(prisma.maintenanceSchedule.findMany).toHaveBeenCalledWith({
      where: { deletedAt: null, status: { in: [MaintenanceStatus.PENDING, MaintenanceStatus.DUE, MaintenanceStatus.IN_PROGRESS] } },
    });
    expect(count).toBe(4);
    expect(prisma.maintenanceSchedule.updateMany).toHaveBeenCalledTimes(4);
    expect(prisma.maintenanceSchedule.updateMany).toHaveBeenCalledWith({
      where: { id: 'pending-expired', status: MaintenanceStatus.PENDING, updatedAt, deletedAt: null },
      data: expect.objectContaining({ status: MaintenanceStatus.OVERDUE, workOrderProgress: { overdueFromStatus: MaintenanceStatus.PENDING } }),
    });
    expect(prisma.maintenanceSchedule.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'due-today' }) }));
    expect(prisma.maintenanceSchedule.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'manual-target-expired' }) }));
  });

  it('uses Manila date boundaries and counts only successful conditional updates', async () => {
    const updatedAt = new Date('2026-01-01T00:00:00.000Z');
    prisma.maintenanceSchedule.findMany.mockResolvedValue([
      { id: 'schedule', status: MaintenanceStatus.PENDING, updatedAt, deletedAt: null, triggerType: MaintenanceTriggerType.TIME, startReferenceDate: new Date('2026-02-04T00:00:00.000Z'), intervalType: MaintenanceIntervalType.MONTHLY },
    ]);
    prisma.maintenanceSchedule.updateMany.mockResolvedValue({ count: 0 });

    const count = await service.markOverdue(new Date('2026-03-04T15:59:00.000Z'));
    expect(count).toBe(0);
    await service.markOverdue(new Date('2026-03-04T16:00:00.000Z'));
    expect(prisma.maintenanceSchedule.updateMany).toHaveBeenCalledTimes(1);
  });
});
