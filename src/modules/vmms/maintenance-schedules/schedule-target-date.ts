import { BadRequestException } from '@nestjs/common';

export function validateTargetDueDate(
  value: unknown,
  startDate: Date,
  previous?: Date | null,
): Date | null {
  if (value === undefined) return previous ?? null;
  if (value === null || value === '') return null;
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    value.startsWith('0000-')
  ) {
    throw new BadRequestException(
      'Enter a valid target due date (YYYY-MM-DD).',
    );
  }
  const dueDate = new Date(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(dueDate.getTime()) ||
    dueDate.toISOString().slice(0, 10) !== value
  ) {
    throw new BadRequestException(
      'Enter a valid target due date (YYYY-MM-DD).',
    );
  }
  if (
    dueDate < new Date(`${startDate.toISOString().slice(0, 10)}T00:00:00.000Z`)
  ) {
    throw new BadRequestException(
      'Target due date cannot be earlier than the schedule start date.',
    );
  }
  return dueDate;
}
