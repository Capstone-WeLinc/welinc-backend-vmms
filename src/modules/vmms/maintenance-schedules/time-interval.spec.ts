import { validateTimeSchedule, addTimeInterval, getTimeInterval } from './time-interval';
import { scheduleDue } from './schedule-due';
import { scheduleEvents } from './schedule-events';

describe('Numeric time intervals', () => {
  const input = { vehicleId: 'ABC', title: 'PMS', triggerType: 'TIME' as const, startReferenceDate: '2026-01-31' };
  it('defaults omitted configuration to three months', () => {
    expect(validateTimeSchedule(input)).toMatchObject({ timeIntervalValue: 3, timeIntervalUnit: 'MONTHS', intervalType: 'QUARTERLY' });
  });
  it.each([[10, 'DAYS', '2026-02-10'], [2, 'MONTHS', '2026-03-31'], [1, 'MONTHS', '2026-02-28']])(
    'computes %s %s as %s', (value, unit, expected) => {
      const configuration = validateTimeSchedule({ ...input, timeIntervalValue: value, timeIntervalUnit: unit } as any);
      const schedule = { ...configuration, triggerType: 'TIME', status: 'PENDING', deletedAt: null } as any;
      expect(scheduleDue(schedule).dueDate).toBe(expected);
      const dueMidnight = new Date(`${expected}T00:00:00+08:00`);
      expect(scheduleEvents(schedule, null, new Date(dueMidnight.getTime() - 1))).toEqual(['CREATED']);
      expect(scheduleEvents(schedule, null, dueMidnight)).toEqual(['CREATED', 'DUE']);
    },
  );
  it.each([0, -1, 1.5, NaN, Infinity, '3', null, 2147483648])('rejects invalid interval value %s', (value) => {
    expect(() => validateTimeSchedule({ ...input, timeIntervalValue: value, timeIntervalUnit: 'MONTHS' } as any)).toThrow('positive whole number');
  });
  it.each(['YEARS', 'months', '', null, undefined])('rejects invalid or incomplete unit %s', (unit) => {
    expect(() => validateTimeSchedule({ ...input, timeIntervalValue: 3, timeIntervalUnit: unit } as any)).toThrow('positive whole number');
  });
  it.each([undefined, '', '2026-02-30', '2026-01-31T00:00:00Z'])('requires a valid reference date %s', (reference) => {
    expect(() => validateTimeSchedule({ ...input, startReferenceDate: reference })).toThrow('reference date is required');
  });
  it('accepts a historical service reference independently of the new schedule start date', () => {
    expect(validateTimeSchedule({ ...input, startDate: '2099-01-01' }).startReferenceDate).toEqual(new Date('2026-01-31T00:00:00Z'));
  });
  it('retains custom configuration on partial edits', () => {
    const previous = { ...input, timeIntervalValue: 45, timeIntervalUnit: 'DAYS', intervalType: null, startReferenceDate: new Date('2026-01-31T00:00:00Z') } as any;
    expect(validateTimeSchedule({ vehicleId: 'ABC', title: 'PMS' }, previous)).toMatchObject({ timeIntervalValue: 45, timeIntervalUnit: 'DAYS', intervalType: null });
    expect(() => validateTimeSchedule({ ...input, timeIntervalValue: 2, timeIntervalUnit: 'MONTHS' }, { ...previous, status: 'IN_PROGRESS' })).toThrow('cannot change after work');
  });
  it.each([['DAILY', 1, 'DAYS'], ['WEEKLY', 7, 'DAYS'], ['MONTHLY', 1, 'MONTHS'], ['QUARTERLY', 3, 'MONTHS'], ['SEMI_ANNUALLY', 6, 'MONTHS'], ['ANNUALLY', 12, 'MONTHS']])('preserves legacy %s', (intervalType, value, unit) => {
    expect(getTimeInterval({ intervalType })).toEqual({ value, unit });
  });
  it('does not round custom intervals into an incorrect legacy preset', () => {
    expect(validateTimeSchedule({ ...input, timeIntervalValue: 45, timeIntervalUnit: 'DAYS' }).intervalType).toBeNull();
  });
  it('clamps leap-year anniversaries and rejects calendar overflow', () => {
    expect(addTimeInterval(new Date('2028-02-29T00:00:00Z'), { value: 12, unit: 'MONTHS' }).toISOString().slice(0, 10)).toBe('2029-02-28');
    expect(() => validateTimeSchedule({ ...input, timeIntervalValue: 2147483647, timeIntervalUnit: 'MONTHS' })).toThrow('calendar range');
  });
});
