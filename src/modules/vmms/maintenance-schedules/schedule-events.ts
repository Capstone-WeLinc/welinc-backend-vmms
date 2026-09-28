import type { MaintenanceSchedule } from '@prisma/client';
import { advanceScheduleDate } from './schedule-due';

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
    const due = advanceScheduleDate(schedule.startReferenceDate, schedule.intervalType);
    // Calendar due dates follow Philippine business days, independent of server TZ.
    const today = new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
    const dueDay = due.toISOString().slice(0, 10);
    if (today >= dueDay) events.push('DUE');
    if (today > dueDay) events.push('OVERDUE');
  }
  return [...new Set(events)];
}
