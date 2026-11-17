import { getWorkOrderStartDateError } from './work-order-start-date';

describe('Work order start date', () => {
  const now = new Date('2026-10-01T04:00:00.000Z'); // October 1 in the Philippines

  it('blocks work before its scheduled date', () => {
    expect(
      getWorkOrderStartDateError(new Date('2026-10-02T00:00:00.000Z'), now),
    ).toBe('This work order can be started on or after 2026-10-02.');
  });

  it('allows work on or after the scheduled date', () => {
    expect(
      getWorkOrderStartDateError(new Date('2026-10-01T00:00:00.000Z'), now),
    ).toBeNull();
    expect(
      getWorkOrderStartDateError(new Date('2026-09-30T00:00:00.000Z'), now),
    ).toBeNull();
  });

  it('blocks work when no scheduled start date exists', () => {
    expect(getWorkOrderStartDateError(null, now)).toMatch(
      /no scheduled start date/i,
    );
  });

  it('uses Philippine calendar dates for the start check', () => {
    const beforePhilippineMidnight = new Date('2026-09-30T15:59:59.000Z');
    expect(
      getWorkOrderStartDateError(
        new Date('2026-10-01T00:00:00.000Z'),
        beforePhilippineMidnight,
      ),
    ).toBe('This work order can be started on or after 2026-10-01.');
  });
});
