import { MaintenanceStatus } from '@prisma/client';
import { odometerScheduleStatus } from './schedule-due';

const schedule = {
  status: MaintenanceStatus.PENDING,
  triggerType: 'ODOMETER',
  startingReferenceReadingKm: 10000,
  odometerReading: 10000,
  intervalKm: 5000,
  bufferDistanceKm: 500,
} as const;

describe('odometer schedule status', () => {
  it.each([
    [14499, MaintenanceStatus.PENDING],
    [14500, MaintenanceStatus.DUE],
    [15000, MaintenanceStatus.DUE],
    [15001, MaintenanceStatus.OVERDUE],
  ])('returns the status for master reading %s', (reading, expected) => {
    expect(odometerScheduleStatus(schedule, reading)).toBe(expected);
  });

  it.each([
    MaintenanceStatus.IN_PROGRESS,
    MaintenanceStatus.DONE,
    MaintenanceStatus.COMPLETED,
    MaintenanceStatus.CANCELLED,
  ])('preserves %s workflow state', (status) => {
    expect(odometerScheduleStatus({ ...schedule, status }, 20000)).toBeNull();
  });

  it('does not derive an odometer status without a valid target', () => {
    expect(
      odometerScheduleStatus({ ...schedule, intervalKm: null }, 15000),
    ).toBeNull();
  });
});
