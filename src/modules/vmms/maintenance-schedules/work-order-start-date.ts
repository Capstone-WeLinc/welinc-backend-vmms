export function getWorkOrderStartDateError(
  startDate: Date | null | undefined,
  now = new Date(),
): string | null {
  if (!startDate || !Number.isFinite(startDate.getTime())) {
    return "This work order has no scheduled start date. Ask Operations to update its schedule.";
  }

  const scheduledDay = startDate.toISOString().slice(0, 10);
  const philippinesToday = new Date(now.getTime() + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  if (scheduledDay > philippinesToday) {
    return `This work order can be started on or after ${scheduledDay}.`;
  }

  return null;
}
