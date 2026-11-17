import { BadRequestException } from '@nestjs/common';

export function validateStartDate(
  value: unknown,
  previous?: Date | null,
  now = new Date(),
): Date {
  if (value === undefined && previous) return previous;
  if (value == null || (typeof value === 'string' && !value.trim()))
    throw new BadRequestException('Schedule start date is required.');
  if (
    typeof value !== 'string' ||
    !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) ||
    value.startsWith('0000-')
  ) {
    throw new BadRequestException(
      'Enter a valid schedule start date (YYYY-MM-DD).',
    );
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new BadRequestException(
      'Enter a valid schedule start date (YYYY-MM-DD).',
    );
  }
  if (previous?.toISOString().slice(0, 10) === value) return parsed;
  const today = new Date(now.getTime() + 8 * 3600_000)
    .toISOString()
    .slice(0, 10);
  if (value < today)
    throw new BadRequestException('Schedule date cannot be in the past.');
  return parsed;
}
