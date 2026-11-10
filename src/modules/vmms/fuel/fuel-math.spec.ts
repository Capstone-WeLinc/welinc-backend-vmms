import { computeFuelEfficiency, isFuelEfficiencyAnomaly } from './fuel-math';

describe('fuel calculations', () => {
  it('computes mileage only for a positive full-tank cycle', () => {
    expect(computeFuelEfficiency(1000, 1450, 50)).toBe(9);
    expect(computeFuelEfficiency(1000, 1000, 50)).toBeNull();
    expect(computeFuelEfficiency(1000, 1450, 0)).toBeNull();
  });

  it('flags efficiency 20 percent or more below the rolling baseline', () => {
    expect(isFuelEfficiencyAnomaly(7.9, 10)).toBe(true);
    expect(isFuelEfficiencyAnomaly(8, 10)).toBe(false);
    expect(isFuelEfficiencyAnomaly(1, 0)).toBe(false);
  });
});
