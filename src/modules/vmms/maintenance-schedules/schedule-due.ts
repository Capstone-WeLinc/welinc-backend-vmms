import type {
  MaintenanceIntervalType,
  MaintenanceSchedule,
} from '@prisma/client';
import { addTimeInterval, getTimeInterval } from './time-interval';

export function advanceScheduleDate(
  date: Date,
  interval: MaintenanceIntervalType,
): Date {
  return addTimeInterval(date, getTimeInterval({ intervalType: interval })!);
}

export function scheduleDue(
  schedule: Pick<
    MaintenanceSchedule,
    | 'triggerType'
    | 'intervalType'
    | 'startReferenceDate'
    | 'startingReferenceReadingKm'
    | 'odometerReading'
    | 'intervalKm'
  > & {
    targetDueDate?: Date | null;
    timeIntervalValue?: number | null;
    timeIntervalUnit?: string | null;
  },
) {
  const reference =
    schedule.startingReferenceReadingKm ?? schedule.odometerReading;
  const interval = getTimeInterval(schedule);
  return {
    dueDate: schedule.targetDueDate
      ? schedule.targetDueDate.toISOString().slice(0, 10)
      : schedule.triggerType === 'TIME' &&
          schedule.startReferenceDate &&
          interval
        ? addTimeInterval(schedule.startReferenceDate, interval)
            .toISOString()
            .slice(0, 10)
        : null,
    dueOdometer:
      schedule.triggerType === 'ODOMETER' &&
      reference != null &&
      schedule.intervalKm != null &&
      schedule.intervalKm > 0
        ? reference + schedule.intervalKm
        : null,
  };
}
