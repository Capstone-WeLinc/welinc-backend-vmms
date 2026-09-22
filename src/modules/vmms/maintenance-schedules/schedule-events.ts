import type { MaintenanceSchedule } from '@prisma/client';

export type ScheduleEvent = 'CREATED' | 'DUE' | 'OVERDUE' | 'ODOMETER_BUFFER';

export function scheduleEvents(schedule: MaintenanceSchedule, odometer: number | null, now = new Date()): ScheduleEvent[] {
  if (schedule.deletedAt || ['COMPLETED', 'CANCELLED'].includes(schedule.status)) return [];
  const events: ScheduleEvent[] = ['CREATED'];
  if (['IN_PROGRESS', 'DONE'].includes(schedule.status)) return events;
  if (schedule.status === 'OVERDUE') return [...events, 'DUE', 'OVERDUE'];
  if (schedule.status === 'DUE') events.push('DUE');
  if (schedule.triggerType === 'ODOMETER' && schedule.intervalKm != null && schedule.intervalKm > 0 && odometer != null) {
    const reference = schedule.startingReferenceReadingKm ?? schedule.odometerReading;
    if (reference == null) return events;
    const target = reference + schedule.intervalKm;
    if (odometer > target) events.push('DUE', 'OVERDUE');
    else if (odometer === target) events.push('DUE');
    else if (odometer >= target - Math.max(0, schedule.bufferDistanceKm ?? 0)) events.push('ODOMETER_BUFFER');
  }
  if (schedule.triggerType === 'TIME' && schedule.startReferenceDate && schedule.intervalType) {
    const due = new Date(schedule.startReferenceDate);
    const months = { MONTHLY: 1, QUARTERLY: 3, SEMI_ANNUALLY: 6, ANNUALLY: 12 };
    if (schedule.intervalType === 'DAILY' || schedule.intervalType === 'WEEKLY') {
      due.setUTCDate(due.getUTCDate() + (schedule.intervalType === 'DAILY' ? 1 : 7));
    } else {
      const day = due.getUTCDate();
      due.setUTCDate(1);
      due.setUTCMonth(due.getUTCMonth() + months[schedule.intervalType]);
      const lastDay = new Date(Date.UTC(due.getUTCFullYear(), due.getUTCMonth() + 1, 0)).getUTCDate();
      due.setUTCDate(Math.min(day, lastDay));
    }
    // Calendar due dates follow Philippine business days, independent of server TZ.
    const today = new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
    const dueDay = due.toISOString().slice(0, 10);
    if (today >= dueDay) events.push('DUE');
    if (today > dueDay) events.push('OVERDUE');
  }
  return [...new Set(events)];
}
