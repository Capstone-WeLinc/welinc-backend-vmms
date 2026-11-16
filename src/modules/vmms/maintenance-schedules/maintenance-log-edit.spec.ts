import { MaintenanceStatus } from '@prisma/client';
import { MaintenanceSchedulesService } from './maintenance-schedules.service';

const admin = { sub: 'admin-1', name: 'Admin User', email: 'admin@example.invalid', system: 'VMMS', roles: [{ system: 'VMMS', role: 'ADMIN' }] };
const operations = { sub: 'ops-1', name: 'Operations User', email: 'ops@example.invalid', system: 'VMMS', roles: [{ system: 'VMMS', role: 'OPERATIONS' }] };
const currentSchedule = {
  id: 'schedule-1', vehicleId: 'ABC123', title: 'Sample service', status: MaintenanceStatus.COMPLETED,
  assignedMechanic: 'Mechanic One', assignedMechanicId: 'mechanic-1', chiefMechanicId: 'chief-1',
  odometerReading: 1500, partsCost: 50, laborCost: 100, totalCost: 150,
  updatedAt: new Date('2026-11-10T00:00:00.000Z'),
  workOrderProgress: {
    maintenanceClass: 'PREVENTIVE', maintenanceRemarks: 'Old description',
    serviceOdometerReading: 1500, laborCost: 100,
    partDetails: { filter: { partsUsed: 'Oil filter', quantity: 1, materialCost: 50 } },
  },
};

describe('Operations-requested, Admin-approved unlocks and audited maintenance-log edits', () => {
  let prisma: any;
  let service: MaintenanceSchedulesService;

  beforeEach(() => {
    const unlock = {
      id: 'unlock-1', scheduleId: currentSchedule.id, reason: 'Correct sample record',
      createdAt: new Date(), consumedAt: null, reviewStatus: 'PENDING',
    };
    prisma = {
      user: { findFirst: jest.fn().mockImplementation(({ where }) => Promise.resolve({
        id: where.id, name: where.id === admin.sub ? 'Admin User' : 'Operations User',
        email: where.id === admin.sub ? 'admin@example.invalid' : 'ops@example.invalid',
      })) },
      maintenanceSchedule: {
        findFirst: jest.fn().mockResolvedValue(currentSchedule),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      maintenanceLogEditUnlock: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(unlock),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      maintenanceLogEditAudit: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $transaction: jest.fn().mockImplementation((callback) => callback(prisma)),
    };
    service = new MaintenanceSchedulesService(prisma);
  });

  it('allows active Operations to request an unlock with a mandatory reason, without activating it', async () => {
    const result = await service.unlockMaintenanceLog(currentSchedule.id, '  Correct sample record  ', operations);
    expect(prisma.maintenanceLogEditUnlock.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      scheduleId: currentSchedule.id, actorId: operations.sub, actorName: 'Operations User', reviewStatus: 'PENDING',
      actorEmail: 'ops@example.invalid', reason: 'Correct sample record',
    }) });
    expect(result.scheduleId).toBe(currentSchedule.id);
    expect(result.reviewStatus).toBe('PENDING');
  });

  it('requires Admin review before activating an Operations unlock request', async () => {
    prisma.maintenanceLogEditUnlock.findFirst.mockResolvedValue({ id: 'unlock-request-1', reviewStatus: 'PENDING' });
    const result = await service.reviewMaintenanceLogUnlock(currentSchedule.id, 'unlock-request-1', 'APPROVE', undefined, admin);
    expect(prisma.maintenanceLogEditUnlock.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'unlock-request-1', scheduleId: currentSchedule.id, reviewStatus: 'PENDING', consumedAt: null },
      data: expect.objectContaining({ reviewStatus: 'APPROVED', activatedAt: expect.any(Date), reviewedById: admin.sub }),
    }));
    expect(result.reviewStatus).toBe('APPROVED');
  });

  it('denies Admin from requesting an unlock and refuses missing Operations reasons', async () => {
    await expect(service.unlockMaintenanceLog(currentSchedule.id, 'reason', admin)).rejects.toMatchObject({ status: 403 });
    await expect(service.unlockMaintenanceLog(currentSchedule.id, '   ', operations)).rejects.toThrow('unlock reason');
    expect(prisma.maintenanceLogEditUnlock.create).not.toHaveBeenCalled();
  });

  it('rejects active duplicate unlocks and does not unlock an open schedule', async () => {
    prisma.maintenanceLogEditUnlock.findFirst.mockResolvedValue({ id: 'active-unlock' });
    await expect(service.unlockMaintenanceLog(currentSchedule.id, 'reason', operations)).rejects.toMatchObject({ status: 409 });
    prisma.maintenanceLogEditUnlock.findFirst.mockResolvedValue(null);
    prisma.maintenanceSchedule.findFirst.mockResolvedValue({ ...currentSchedule, status: MaintenanceStatus.IN_PROGRESS });
    await expect(service.unlockMaintenanceLog(currentSchedule.id, 'reason', operations)).rejects.toThrow('Only Completed or Admin-cancelled');
  });

  it('Operations consumes the Admin unlock, relocks immediately, derives costs, and audits each changed field', async () => {
    const saved = {
      ...currentSchedule,
      workOrderProgress: {
        ...currentSchedule.workOrderProgress,
        maintenanceClass: 'REPAIR', maintenanceRemarks: 'Replaced a damaged hose.', serviceOdometerReading: 1750, laborCost: 125,
      },
      odometerReading: 1750, partsCost: 50, laborCost: 125, totalCost: 175,
    };
    prisma.maintenanceLogEditUnlock.findFirst.mockResolvedValue({
      id: 'unlock-1', scheduleId: currentSchedule.id, reason: 'Correct sample record',
      createdAt: new Date(), consumedAt: null,
    });
    prisma.maintenanceSchedule.findFirst.mockResolvedValueOnce(currentSchedule).mockResolvedValueOnce(saved);

    const result = await service.updateMaintenanceLog(currentSchedule.id, {
      maintenanceClass: 'REPAIR', maintenanceRemarks: 'Replaced a damaged hose.',
      serviceOdometerReading: 1750, laborCost: 125,
    }, operations);

    expect(prisma.maintenanceLogEditUnlock.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'unlock-1', consumedAt: null }),
      data: { consumedAt: expect.any(Date) },
    }));
    expect(prisma.maintenanceSchedule.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: currentSchedule.id, status: MaintenanceStatus.COMPLETED }),
      data: expect.objectContaining({ odometerReading: 1750, partsCost: 50, laborCost: 125, totalCost: 175 }),
    }));
    expect(prisma.maintenanceLogEditAudit.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ fieldName: 'maintenanceClass', previousValue: '"PREVENTIVE"', newValue: '"REPAIR"', unlockReason: 'Correct sample record' }),
        expect.objectContaining({ fieldName: 'maintenanceRemarks', actorId: operations.sub, actorEmail: 'ops@example.invalid' }),
        expect.objectContaining({ fieldName: 'serviceOdometerReading', previousValue: '1500', newValue: '1750' }),
        expect.objectContaining({ fieldName: 'laborCost', previousValue: '100', newValue: '125' }),
        expect.objectContaining({ fieldName: 'totalCost', previousValue: '150', newValue: '175' }),
      ]),
    });
    expect(result).toMatchObject({ id: currentSchedule.id, status: MaintenanceStatus.COMPLETED, totalCost: 175, relocked: true });
  });

  it('rejects edits without an active unexpired Admin unlock', async () => {
    prisma.maintenanceLogEditUnlock.findFirst.mockResolvedValue(null);
    await expect(service.updateMaintenanceLog(currentSchedule.id, { maintenanceRemarks: 'Changed' }, operations))
      .rejects.toThrow('An active Admin unlock');
    expect(prisma.maintenanceSchedule.updateMany).not.toHaveBeenCalled();
    expect(prisma.maintenanceLogEditAudit.createMany).not.toHaveBeenCalled();
  });

  it('rejects non-Operations save attempts and invalid log values', async () => {
    await expect(service.updateMaintenanceLog(currentSchedule.id, { maintenanceRemarks: 'Changed' }, admin)).rejects.toMatchObject({ status: 403 });
    prisma.maintenanceLogEditUnlock.findFirst.mockResolvedValue({
      id: 'unlock-1', scheduleId: currentSchedule.id, reason: 'Correct sample record', createdAt: new Date(), consumedAt: null,
    });
    await expect(service.updateMaintenanceLog(currentSchedule.id, { maintenanceRemarks: ' ' }, operations)).rejects.toThrow('Work description cannot be empty');
    await expect(service.updateMaintenanceLog(currentSchedule.id, { maintenanceClass: 'MAINTENANCE' as any }, operations)).rejects.toThrow('Maintenance type must be');
  });
});
