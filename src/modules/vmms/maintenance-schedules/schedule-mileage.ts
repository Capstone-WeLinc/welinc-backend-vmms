import { BadRequestException } from '@nestjs/common';
import type { MaintenanceSchedule } from '@prisma/client';
import type { CreateMaintenanceScheduleDto } from './dto/create-maintenance-schedule.dto';

const MAX_KM = 2147483647; // Existing PostgreSQL integer storage uses whole kilometres.
function parseKm(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) {
    throw new BadRequestException(`${label} must be a non-negative whole number of kilometres.`);
  }
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed > MAX_KM) throw new BadRequestException(`${label} exceeds the supported mileage range.`);
  return parsed;
}

export function validateScheduleMileage(data: CreateMaintenanceScheduleDto, previous?: MaintenanceSchedule, vehicleOdometer?: number | null) {
  const supplied = {
    odometerReading: parseKm(data.odometerReading, 'Odometer reading'),
    intervalKm: parseKm(data.intervalKm, 'Maintenance interval'),
    bufferDistanceKm: parseKm(data.bufferDistanceKm, 'Buffer distance'),
    startingReferenceReadingKm: parseKm(data.startingReferenceReadingKm, 'Starting reference reading'),
  };
  const trigger = data.triggerType ?? previous?.triggerType;
  if (trigger !== 'ODOMETER') return supplied;
  const interval = data.intervalKm === undefined ? previous?.intervalKm : supplied.intervalKm;
  const reference = data.startingReferenceReadingKm === undefined ? previous?.startingReferenceReadingKm : supplied.startingReferenceReadingKm;
  if (interval == null || interval <= 0) throw new BadRequestException('Maintenance interval must be greater than zero.');
  if (reference == null || reference < 0) throw new BadRequestException('A non-negative starting reference reading is required for odometer scheduling.');
  if (vehicleOdometer == null || !Number.isInteger(vehicleOdometer) || vehicleOdometer < 0) {
    throw new BadRequestException('Select an active truck with a recorded odometer reading.');
  }
  const sameTruck = previous?.vehicleId.trim().toLowerCase() === data.vehicleId.trim().toLowerCase();
  const current = Math.max(vehicleOdometer, supplied.odometerReading ?? 0, sameTruck ? previous?.odometerReading ?? 0 : 0);
  const threshold = reference + interval;
  if (!Number.isSafeInteger(threshold) || threshold <= 0 || threshold > MAX_KM) {
    throw new BadRequestException('Odometer threshold must be positive and within the supported mileage range.');
  }
  const changesThreshold = !previous || !sameTruck || previous.triggerType !== 'ODOMETER' ||
    previous.title.trim().toLowerCase() !== data.title.trim().toLowerCase() ||
    previous.intervalKm !== interval || previous.startingReferenceReadingKm !== reference || previous.status === 'CANCELLED';
  // Recording that an existing threshold has been reached is valid. Only new or
  // reconfigured thresholds must be ahead of the current recorded reading.
  if (changesThreshold && threshold <= current) {
    throw new BadRequestException("Odometer threshold must be greater than the truck's current odometer reading.");
  }
  return { ...supplied, odometerReading: current, intervalKm: interval, startingReferenceReadingKm: reference,
    bufferDistanceKm: supplied.bufferDistanceKm ?? previous?.bufferDistanceKm ?? 0 };
}
