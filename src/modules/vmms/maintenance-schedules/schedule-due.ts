import type {
  MaintenanceIntervalType,
  MaintenanceSchedule,
} from '@prisma/client';
import { MaintenanceStatus } from '@prisma/client';
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

export function odometerScheduleStatus(
  schedule: Pick<
    MaintenanceSchedule,
    | 'status'
    | 'triggerType'
    | 'startingReferenceReadingKm'
    | 'odometerReading'
    | 'intervalKm'
    | 'bufferDistanceKm'
  >,
  currentOdometer: number,
): MaintenanceStatus | null {
  if (
    schedule.triggerType !== 'ODOMETER' ||
    (schedule.status !== MaintenanceStatus.PENDING &&
      schedule.status !== MaintenanceStatus.DUE &&
      schedule.status !== MaintenanceStatus.OVERDUE)
  ) {
    return null;
  }

  const dueOdometer = scheduleDue({
    ...schedule,
    intervalType: null,
    startReferenceDate: null,
  }).dueOdometer;
  if (dueOdometer === null) return null;

  const activationOdometer =
    dueOdometer - Math.max(0, schedule.bufferDistanceKm ?? 0);
  if (currentOdometer < activationOdometer) return MaintenanceStatus.PENDING;
  if (currentOdometer <= dueOdometer) return MaintenanceStatus.DUE;
  return MaintenanceStatus.OVERDUE;
}
