import { MaintenanceSchedulesService } from './maintenance-schedules.service';
import { advanceScheduleDate, scheduleDue } from './schedule-due';
import { Prisma } from '@prisma/client';

describe('Next maintenance cycle after approval', () => {
  const completed = {
    id: 'completed', vehicleId: 'ABC123', title: 'PMS', status: 'COMPLETED', deletedAt: null,
    triggerType: 'TIME', intervalType: 'MONTHLY', intervalKm: 5000,
    odometerReading: 25000, startingReferenceReadingKm: 20000, bufferDistanceKm: 500,
    startReferenceDate: new Date('2025-01-01T00:00:00Z'), updatedAt: new Date('2026-01-30T16:00:00Z'),
    assignedMechanic: 'Mechanic', assignedMechanicId: 'mechanic', chiefMechanic: 'Chief', chiefMechanicId: 'chief',
    checklistTemplateId: 'template', garageId: 'garage', accountType: 'IN_HOUSE',
    workOrderProgress: { mechanicSubmitted: true, executionItems: [{ id: 'item', label: 'Oil', status: 'checked' }] },
    partsCost: 100, laborCost: 200, totalCost: 300,
  };
  let service: MaintenanceSchedulesService;
  let tx: any;
  beforeEach(() => {
    tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      maintenanceSchedule: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue({ ...completed, status: 'DONE' }),
        update: jest.fn().mockImplementation(async ({ data }) => ({ ...completed, ...data })),
        upsert: jest.fn().mockImplementation(async ({ create }) => ({ id: 'next', ...create })),
      },
      vehicle: { findFirst: jest.fn().mockResolvedValue({ odometer: 26000 }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      $transaction: jest.fn().mockImplementation(async (callback) => callback(tx)),
    };
    service = new MaintenanceSchedulesService(tx);
    jest.spyOn(service as any, 'syncVehicleStatus').mockResolvedValue(undefined);
  });
  const recur = (service: MaintenanceSchedulesService, tx: any, values = {}) =>
    (service as any).createNextRecurringSchedule(tx, { ...completed, ...values });

  it('uses the Philippine completion day as the reference and adds one interval', async () => {
    const next = await recur(service, tx);
    expect(next.startReferenceDate.toISOString()).toBe('2026-01-31T00:00:00.000Z');
    expect(scheduleDue(next).dueDate).toBe('2026-02-28');
    expect(next).toMatchObject({ status: 'PENDING', previousScheduleId: completed.id, assignedMechanicId: 'mechanic', chiefMechanicId: 'chief', checklistTemplateId: 'template', garageId: 'garage' });
    for (const key of ['workOrderProgress', 'partsCost', 'laborCost', 'totalCost']) expect(tx.maintenanceSchedule.upsert.mock.calls[0][0].create).not.toHaveProperty(key);
  });
  it('defaults unconfigured time recurrence to the required three months', async () => {
    const next = await recur(service, tx, { intervalType: null });
    expect(next.intervalType).toBe('QUARTERLY');
    expect(scheduleDue(next).dueDate).toBe('2026-04-30');
  });
  it.each([[26000, 25000, 26000], [24000, 25000, 25000], [0, null, 0], [null, 25000, 25000]])(
    'uses available recorded mileage without moving backwards (%s, %s)', async (vehicle, recorded, expected) => {
      tx.vehicle.findFirst.mockResolvedValue(vehicle === null ? null : { odometer: vehicle });
      const next = await recur(service, tx, { triggerType: 'ODOMETER', odometerReading: recorded });
      expect(next.startingReferenceReadingKm).toBe(expected);
      expect(next.odometerReading).toBe(expected);
      expect(scheduleDue(next).dueOdometer).toBe(expected! + 5000);
    },
  );
  it('refuses to invent a missing odometer reading', async () => {
    tx.vehicle.findFirst.mockResolvedValue(null);
    await expect(recur(service, tx, { triggerType: 'ODOMETER', odometerReading: null })).rejects.toThrow('current odometer reading');
    expect(tx.maintenanceSchedule.upsert).not.toHaveBeenCalled();
  });
  it.each([null, 0, -100])('rejects an invalid odometer interval (%s)', async (intervalKm) => {
    await expect(recur(service, tx, { triggerType: 'ODOMETER', intervalKm })).rejects.toThrow('positive odometer interval');
  });
  it.each(['PENDING', 'IN_PROGRESS', 'DONE', 'CANCELLED'])('never recurs from %s', async (status) => {
    expect(await recur(service, tx, { status })).toBeNull();
    expect(tx.maintenanceSchedule.upsert).not.toHaveBeenCalled();
  });
  it('does not recur manual or archived schedules', async () => {
    expect(await recur(service, tx, { triggerType: 'MANUAL' })).toBeNull();
    expect(await recur(service, tx, { deletedAt: new Date() })).toBeNull();
  });
  it('returns an already linked successor without resetting it', async () => {
    const existing = { id: 'next', status: 'IN_PROGRESS' };
    tx.maintenanceSchedule.findUnique.mockResolvedValue(existing);
    expect(await recur(service, tx)).toBe(existing);
    expect(tx.maintenanceSchedule.upsert).not.toHaveBeenCalled();
  });
  it('blocks a conflicting Pending schedule without replacing or linking it', async () => {
    tx.$queryRaw.mockResolvedValue([{ id: 'unrelated' }]);
    await expect(recur(service, tx)).rejects.toMatchObject({ status: 409 });
    expect(tx.maintenanceSchedule.upsert).not.toHaveBeenCalled();
  });
  const chief = { sub: 'chief', roles: [{ role: 'CHIEF_MECHANIC', system: 'VMMS' }] };
  const inspectionItems = [{ id: 'item', status: 'pass' }];
  it('approval saves completion and the next cycle in one transaction and returns the due date', async () => {
    const result = await service.updateProgress('completed', { action: 'APPROVE', inspectionItems }, chief);
    expect(result).toMatchObject({ status: 'COMPLETED', nextSchedule: { id: 'next', dueDate: '2026-02-28', dueOdometer: null } });
    expect(tx.maintenanceSchedule.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ completedAt: expect.any(Date) }),
    }));
    expect(tx.$transaction).toHaveBeenCalledTimes(1);
  });
  it('rejection returns work to the mechanic without creating another cycle', async () => {
    const result = await service.updateProgress('completed', { action: 'REJECT', inspectionItems, inspectorRemarks: 'Redo inspection' }, chief);
    expect(result.status).toBe('IN_PROGRESS');
    expect(result.nextSchedule).toBeNull();
    expect(tx.maintenanceSchedule.upsert).not.toHaveBeenCalled();
  });
  it('translates a race with another Pending insert into a conflict', async () => {
    tx.maintenanceSchedule.upsert.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: '7' }));
    tx.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'competing' }]);
    await expect(service.updateProgress('completed', { action: 'APPROVE', inspectionItems }, chief)).rejects.toMatchObject({ status: 409 });
  });
});

describe('Calendar interval calculation', () => {
  it.each([
    ['2026-01-31', 'DAILY', '2026-02-01'], ['2026-01-31', 'WEEKLY', '2026-02-07'],
    ['2026-01-31', 'MONTHLY', '2026-02-28'], ['2028-01-31', 'MONTHLY', '2028-02-29'],
    ['2026-01-31', 'QUARTERLY', '2026-04-30'], ['2026-08-31', 'SEMI_ANNUALLY', '2027-02-28'],
    ['2028-02-29', 'ANNUALLY', '2029-02-28'], ['2026-12-31', 'MONTHLY', '2027-01-31'],
  ])('%s plus %s is %s', (reference, interval, expected) => {
    expect(advanceScheduleDate(new Date(`${reference}T00:00:00Z`), interval as any).toISOString().slice(0, 10)).toBe(expected);
  });
});
