export function computeFuelEfficiency(
  previousOdometer: number,
  odometer: number,
  liters: number,
): number | null {
  const distance = odometer - previousOdometer;
  if (
    !Number.isFinite(distance) ||
    distance <= 0 ||
    !Number.isFinite(liters) ||
    liters <= 0
  )
    return null;
  return Math.round((distance / liters) * 100) / 100;
}

export function isFuelEfficiencyAnomaly(
  efficiency: number,
  rollingAverage: number,
  deviationPercent = 20,
): boolean {
  return (
    Number.isFinite(efficiency) &&
    Number.isFinite(rollingAverage) &&
    rollingAverage > 0 &&
    efficiency < rollingAverage * (1 - deviationPercent / 100)
  );
}
