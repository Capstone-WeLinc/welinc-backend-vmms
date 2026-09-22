import type { MaintenanceSchedule } from '@prisma/client';
import { scheduleEvents } from './schedule-events';

const schedule = (values: Partial<MaintenanceSchedule> = {}) => ({
  status: 'PENDING', deletedAt: null, triggerType: 'ODOMETER',
  startingReferenceReadingKm: 10000, intervalKm: 5000, bufferDistanceKm: 500,
  ...values,
} as MaintenanceSchedule);

describe('maintenance event thresholds', () => {
  it.each([
    [14499, ['CREATED']], [14500, ['CREATED', 'ODOMETER_BUFFER']],
    [14999, ['CREATED', 'ODOMETER_BUFFER']], [15000, ['CREATED', 'DUE']],
    [15001, ['CREATED', 'DUE', 'OVERDUE']],
  ])('evaluates odometer %s', (reading, expected) => {
    expect(scheduleEvents(schedule(), reading as number)).toEqual(expected);
  });
  it('does not invent readings or notify completed schedules', () => {
    expect(scheduleEvents(schedule(), null)).toEqual(['CREATED']);
    expect(scheduleEvents(schedule({ status: 'COMPLETED' }), 16000)).toEqual([]);
    expect(scheduleEvents(schedule({ status: 'CANCELLED' }), 16000)).toEqual([]);
  });
  it('clamps a month-end due date and uses Philippine calendar days', () => {
    const monthly = schedule({ triggerType: 'TIME', startReferenceDate: new Date('2026-01-31T00:00:00Z'), intervalType: 'MONTHLY' });
    expect(scheduleEvents(monthly, null, new Date('2026-02-27T15:59:00Z'))).toEqual(['CREATED']);
    expect(scheduleEvents(monthly, null, new Date('2026-02-27T16:00:00Z'))).toEqual(['CREATED', 'DUE']);
    expect(scheduleEvents(monthly, null, new Date('2026-02-28T16:00:00Z'))).toEqual(['CREATED', 'DUE', 'OVERDUE']);
  });
});
