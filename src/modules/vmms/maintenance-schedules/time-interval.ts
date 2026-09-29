import { BadRequestException } from '@nestjs/common';
import type { MaintenanceIntervalType, MaintenanceSchedule } from '@prisma/client';
import type { CreateMaintenanceScheduleDto } from './dto/create-maintenance-schedule.dto';

export type TimeInterval = { value: number; unit: 'DAYS' | 'MONTHS' };
const presets: Record<MaintenanceIntervalType, TimeInterval> = {
  DAILY: { value: 1, unit: 'DAYS' }, WEEKLY: { value: 7, unit: 'DAYS' },
  MONTHLY: { value: 1, unit: 'MONTHS' }, QUARTERLY: { value: 3, unit: 'MONTHS' },
  SEMI_ANNUALLY: { value: 6, unit: 'MONTHS' }, ANNUALLY: { value: 12, unit: 'MONTHS' },
};
export function getTimeInterval(schedule: { timeIntervalValue?: number | null; timeIntervalUnit?: string | null; intervalType?: string | null }): TimeInterval | null {
  if (schedule.timeIntervalValue != null || schedule.timeIntervalUnit != null) {
    if (!Number.isInteger(schedule.timeIntervalValue) || schedule.timeIntervalValue! <= 0 || !['DAYS','MONTHS'].includes(schedule.timeIntervalUnit ?? '')) return null;
    return { value: schedule.timeIntervalValue!, unit: schedule.timeIntervalUnit as TimeInterval['unit'] };
  }
  return presets[schedule.intervalType as MaintenanceIntervalType] ?? null;
}
export function addTimeInterval(date: Date, interval: TimeInterval): Date {
  const next = new Date(date);
  if (interval.unit === 'DAYS') next.setUTCDate(next.getUTCDate() + interval.value);
  else {
    const day = next.getUTCDate();
    next.setUTCDate(1);
    next.setUTCMonth(next.getUTCMonth() + interval.value);
    const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
    next.setUTCDate(Math.min(day, lastDay));
  }
  if (!Number.isFinite(next.getTime()) || next.getUTCFullYear() > 9999) throw new BadRequestException('Time interval produces a due date outside the supported calendar range.');
  return next;
}
export function validateTimeSchedule(data: CreateMaintenanceScheduleDto, previous?: MaintenanceSchedule) {
  if ((data.triggerType ?? previous?.triggerType) !== 'TIME') return {};
  const hasNumeric = data.timeIntervalValue !== undefined || data.timeIntervalUnit !== undefined;
  let interval: TimeInterval | null;
  if (hasNumeric) {
    if (typeof data.timeIntervalValue !== 'number' || !Number.isInteger(data.timeIntervalValue) || data.timeIntervalValue <= 0 || data.timeIntervalValue > 2147483647 || !['DAYS', 'MONTHS'].includes(data.timeIntervalUnit ?? '')) {
      throw new BadRequestException('Time interval must be a positive whole number of DAYS or MONTHS.');
    }
    interval = { value: data.timeIntervalValue, unit: data.timeIntervalUnit as TimeInterval['unit'] };
  } else {
    interval = data.intervalType ? getTimeInterval({ intervalType: data.intervalType })
      : previous?.triggerType === 'TIME' ? getTimeInterval(previous) : null;
    interval ??= presets.QUARTERLY;
  }
  const reference = data.startReferenceDate === undefined ? previous?.startReferenceDate?.toISOString().slice(0, 10) : data.startReferenceDate;
  if (typeof reference !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(reference) || reference.startsWith('0000-')) throw new BadRequestException('A valid time-interval reference date is required.');
  const startReferenceDate = new Date(`${reference}T00:00:00.000Z`);
  if (!Number.isFinite(startReferenceDate.getTime()) || startReferenceDate.toISOString().slice(0, 10) !== reference) throw new BadRequestException('A valid time-interval reference date is required.');
  addTimeInterval(startReferenceDate, interval);
  if (previous && ['IN_PROGRESS','DONE'].includes(previous.status)) {
    const old = getTimeInterval(previous);
    if (old?.value !== interval.value || old.unit !== interval.unit || previous.startReferenceDate?.getTime() !== startReferenceDate.getTime()) throw new BadRequestException('Time scheduling cannot change after work has started.');
  }
  const intervalType = (Object.keys(presets) as MaintenanceIntervalType[]).find((key) => presets[key].value === interval.value && presets[key].unit === interval.unit) ?? null;
  return { timeIntervalValue: interval.value, timeIntervalUnit: interval.unit, intervalType, startReferenceDate };
}
