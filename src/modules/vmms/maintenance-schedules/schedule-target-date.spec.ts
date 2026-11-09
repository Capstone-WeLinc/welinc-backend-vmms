import { BadRequestException } from '@nestjs/common';
import { validateTargetDueDate } from './schedule-target-date';
import { scheduleDue } from './schedule-due';
import { MaintenanceTriggerType, MaintenanceIntervalType } from '@prisma/client';

describe('maintenance schedule target due date', () => {
  const start = new Date('2026-11-10T00:00:00.000Z');

  it('validates an explicit calendar target date and allows preserving an existing date', () => {
    expect(validateTargetDueDate('2026-12-01', start)?.toISOString().slice(0, 10)).toBe('2026-12-01');
    expect(validateTargetDueDate(undefined, start, new Date('2026-12-01T00:00:00.000Z'))?.toISOString().slice(0, 10)).toBe('2026-12-01');
  });

  it.each(['2026-02-30', 'not-a-date'])('rejects invalid target date %s', (value) => {
    expect(() => validateTargetDueDate(value, start)).toThrow(BadRequestException);
  });

  it('rejects a target date earlier than the schedule start', () => {
    expect(() => validateTargetDueDate('2026-11-09', start)).toThrow('earlier than the schedule start date');
  });

  it('uses an explicit due date for manual schedules and retains computed time-interval fallback', () => {
    expect(scheduleDue({
      triggerType: MaintenanceTriggerType.MANUAL,
      targetDueDate: new Date('2026-12-01T00:00:00.000Z'),
      startReferenceDate: null, intervalType: null, startingReferenceReadingKm: null, odometerReading: null, intervalKm: null,
    }).dueDate).toBe('2026-12-01');
    expect(scheduleDue({
      triggerType: MaintenanceTriggerType.TIME,
      targetDueDate: null,
      startReferenceDate: start, intervalType: MaintenanceIntervalType.MONTHLY,
      startingReferenceReadingKm: null, odometerReading: null, intervalKm: null,
    }).dueDate).toBe('2026-12-10');
  });
});
