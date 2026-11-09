import { MaintenanceStatus, MaintenanceTriggerType } from '@prisma/client';
import { MaintenanceSchedulesService } from './maintenance-schedules.service';

describe('Admin odometer-threshold adjustment', () => {
  const admin = { sub: 'admin-1', roles: [{ system: 'VMMS', role: 'ADMIN' }] };
  const operations = { sub: 'ops-1', roles: [{ system: 'VMMS', role: 'OPERATIONS' }] };
  const schedule = {
    id: 'schedule-1', workOrderNumber: 'WO-20261110-000001', vehicleId: 'ABC123',
    status: MaintenanceStatus.PENDING, triggerType: MaintenanceTriggerType.ODOMETER,
    odometerReading: 10000, startingReferenceReadingKm: 10000, intervalKm: 5000,
    bufferDistanceKm: 500, updatedAt: new Date(0), deletedAt: null,
  };
  let prisma: any;
  let service: MaintenanceSchedulesService;

  beforeEach(() => {
    prisma = {
      user: { findFirst: jest.fn().mockResolvedValue({ id: admin.sub, email: 'admin@example.invalid' }) },
      maintenanceSchedule: {
        findFirst: jest.fn().mockResolvedValue(schedule),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      maintenanceScheduleCancellation: { findFirst: jest.fn().mockResolvedValue(null) },
      maintenanceLogEditUnlock: { updateMany: jest.fn() },
      vehicle: { findFirst: jest.fn().mockResolvedValue({ id: 'vehicle-1', odometer: 12000 }) },
      vehicleAuditLog: { createMany: jest.fn().mockResolvedValue({ count: 2 }) },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $transaction: jest.fn().mockImplementation((callback) => callback(prisma)),
    };
    service = new MaintenanceSchedulesService(prisma);
  });

  it('allows Admin to set a future target, resets the interval baseline, and audits old/new values and reason', async () => {
    const result = await service.updateOdometerThreshold('schedule-1', 20000, 'Adjust service interval', admin);

    expect(result).toMatchObject({
      id: 'schedule-1', status: MaintenanceStatus.PENDING, odometerReading: '12000',
      startingReferenceReadingKm: '12000', intervalKm: '8000', dueOdometer: 20000,
    });
    expect(prisma.maintenanceSchedule.updateMany).toHaveBeenCalledWith({
      where: { id: 'schedule-1', status: MaintenanceStatus.PENDING, updatedAt: new Date(0), deletedAt: null },
      data: {
        odometerReading: 12000, startingReferenceReadingKm: 12000,
        intervalKm: 8000, status: MaintenanceStatus.PENDING,
      },
    });
    expect(prisma.vehicleAuditLog.createMany).toHaveBeenCalledWith({ data: [
      expect.objectContaining({
        vehicleId: 'vehicle-1', userId: admin.sub, action: 'SCHEDULE_ODOMETER_THRESHOLD_UPDATED',
        previousValue: '15000', newValue: '20000',
      }),
      expect.objectContaining({
        vehicleId: 'vehicle-1', userId: admin.sub, fieldName: 'WO-20261110-000001:reason',
        newValue: 'Adjust service interval',
      }),
    ] });
  });

  it('rejects Operations and inactive Admin accounts', async () => {
    await expect(service.updateOdometerThreshold('schedule-1', 20000, 'Adjustment', operations))
      .rejects.toMatchObject({ status: 403 });
    prisma.user.findFirst.mockResolvedValue(null);
    await expect(service.updateOdometerThreshold('schedule-1', 20000, 'Adjustment', admin))
      .rejects.toMatchObject({ status: 403 });
    expect(prisma.maintenanceSchedule.updateMany).not.toHaveBeenCalled();
  });

  it.each([12000, 11000])('rejects a threshold at or below the truck reading (%s)', async (threshold) => {
    await expect(service.updateOdometerThreshold('schedule-1', threshold, 'Adjustment', admin))
      .rejects.toThrow("The target must be in the future. This truck is at 12,000 km; choose a higher odometer threshold or schedule its maintenance immediately.");
    expect(prisma.maintenanceSchedule.updateMany).not.toHaveBeenCalled();
  });

  it('requires an odometer schedule, an active truck, a reason, and an eligible schedule state', async () => {
    await expect(service.updateOdometerThreshold('schedule-1', 20000, ' ', admin)).rejects.toThrow('reason');
    prisma.maintenanceSchedule.findFirst.mockResolvedValue({ ...schedule, triggerType: MaintenanceTriggerType.TIME });
    await expect(service.updateOdometerThreshold('schedule-1', 20000, 'Adjustment', admin)).rejects.toThrow('Only odometer-based');
    prisma.maintenanceSchedule.findFirst.mockResolvedValue({ ...schedule, status: MaintenanceStatus.IN_PROGRESS });
    await expect(service.updateOdometerThreshold('schedule-1', 20000, 'Adjustment', admin)).rejects.toThrow('after work has started');
    prisma.maintenanceSchedule.findFirst.mockResolvedValue(schedule);
    prisma.vehicle.findFirst.mockResolvedValue(null);
    await expect(service.updateOdometerThreshold('schedule-1', 20000, 'Adjustment', admin)).rejects.toThrow('active truck');
  });

  it('blocks edits while a cancellation or void request is awaiting review', async () => {
    prisma.maintenanceScheduleCancellation.findFirst.mockResolvedValue({ id: 'request-1' });
    await expect(service.updateOdometerThreshold('schedule-1', 20000, 'Adjustment', admin))
      .rejects.toMatchObject({ status: 409 });
    expect(prisma.maintenanceSchedule.updateMany).not.toHaveBeenCalled();
  });
});
