import type { MaintenanceIntervalType, MaintenanceSchedule } from '@prisma/client';

export function advanceScheduleDate(date: Date, interval: MaintenanceIntervalType): Date {
  const next = new Date(date);
  if (interval === 'DAILY' || interval === 'WEEKLY') {
    next.setUTCDate(next.getUTCDate() + (interval === 'DAILY' ? 1 : 7));
  } else {
    const months = { MONTHLY: 1, QUARTERLY: 3, SEMI_ANNUALLY: 6, ANNUALLY: 12 };
    const day = next.getUTCDate();
    next.setUTCDate(1);
    next.setUTCMonth(next.getUTCMonth() + months[interval]);
    const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
    next.setUTCDate(Math.min(day, lastDay));
  }
  return next;
}

export function scheduleDue(schedule: Pick<MaintenanceSchedule, 'triggerType' | 'intervalType' | 'startReferenceDate' | 'startingReferenceReadingKm' | 'odometerReading' | 'intervalKm'>) {
  const reference = schedule.startingReferenceReadingKm ?? schedule.odometerReading;
  return {
    dueDate: schedule.triggerType === 'TIME' && schedule.startReferenceDate && schedule.intervalType
      ? advanceScheduleDate(schedule.startReferenceDate, schedule.intervalType).toISOString().slice(0, 10) : null,
    dueOdometer: schedule.triggerType === 'ODOMETER' && reference != null && schedule.intervalKm != null && schedule.intervalKm > 0
      ? reference + schedule.intervalKm : null,
  };
}
