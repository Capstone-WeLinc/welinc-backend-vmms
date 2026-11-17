import { validateStartDate } from './schedule-start-date';
import { MaintenanceSchedulesService } from './maintenance-schedules.service';

describe('Schedule start date', () => {
  const now = new Date('2026-09-28T16:00:00Z'); // Sept 29 in the Philippines
  it.each([undefined, null, '', '   '])('requires a date (%s)', (value) => {
    expect(() => validateStartDate(value, null, now)).toThrow(
      'Schedule start date is required.',
    );
  });
  it.each([
    '2026-02-30',
    '2026-02-29',
    '2026-13-01',
    '2026-9-29',
    '2026-09-29T00:00:00Z',
    '0000-01-01',
    'not-a-date',
    123,
  ])('rejects invalid date %s', (value) => {
    expect(() => validateStartDate(value, null, now)).toThrow(
      'valid schedule start date',
    );
  });
  it.each(['2026-09-29', '2026-09-30', '2028-02-29'])(
    'accepts today or a valid future date %s',
    (value) => {
      expect(validateStartDate(value, null, now).toISOString()).toBe(
        `${value}T00:00:00.000Z`,
      );
    },
  );
  it('uses Philippine midnight, independent of the server timezone', () => {
    expect(
      validateStartDate('2026-09-28', null, new Date('2026-09-28T15:59:59Z')),
    ).toBeInstanceOf(Date);
    expect(() => validateStartDate('2026-09-28', null, now)).toThrow(
      'Schedule date cannot be in the past.',
    );
  });
  it('preserves unchanged historical dates but rejects changing to another past date', () => {
    const previous = new Date('2026-06-01T00:00:00Z');
    expect(validateStartDate(undefined, previous, now)).toBe(previous);
    expect(validateStartDate('2026-06-01', previous, now)).toEqual(previous);
    expect(() => validateStartDate('2026-06-02', previous, now)).toThrow(
      'Schedule date cannot be in the past.',
    );
    expect(() => validateStartDate('', previous, now)).toThrow('required');
  });
  it.each(['MANUAL', 'TIME', 'ODOMETER'] as const)(
    'blocks %s creation without a date before writing',
    async (triggerType) => {
      const db = { maintenanceSchedule: { create: jest.fn() } };
      const service = new MaintenanceSchedulesService(db as any);
      await expect(
        service.create({ vehicleId: 'ABC123', title: 'PMS', triggerType }),
      ).rejects.toThrow('Schedule start date is required.');
      expect(db.maintenanceSchedule.create).not.toHaveBeenCalled();
    },
  );
});
