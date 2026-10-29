import { describe, it, expect } from 'vitest';
import { describeRecurrence } from '../service-plans';

describe('describeRecurrence', () => {
  it('describes legacy cadences (no structured fields)', () => {
    expect(describeRecurrence({ visit_cadence: 'WEEKLY' })).toBe('Weekly');
    expect(describeRecurrence({ visit_cadence: 'BIWEEKLY' })).toBe('Every 2 weeks');
    expect(describeRecurrence({ visit_cadence: 'MONTHLY' })).toBe('Monthly');
    expect(describeRecurrence({ visit_cadence: 'QUARTERLY' })).toBe('Every 3 months');
    expect(describeRecurrence({ visit_cadence: 'SEMIANNUAL' })).toBe('Every 6 months');
    expect(describeRecurrence({ visit_cadence: 'ANNUAL' })).toBe('Annually');
  });

  it('describes structured rules, including weekly weekday sets (sorted, abbreviated)', () => {
    expect(describeRecurrence({ visit_cadence: 'WEEKLY', interval_unit: 'WEEK', interval_count: 1 })).toBe('Weekly');
    expect(
      describeRecurrence({ visit_cadence: 'BIWEEKLY', interval_unit: 'WEEK', interval_count: 2, byweekday: [4, 1] }),
    ).toBe('Every 2 weeks on Mon, Thu');
    expect(describeRecurrence({ visit_cadence: 'WEEKLY', interval_unit: 'DAY', interval_count: 3 })).toBe('Every 3 days');
    expect(describeRecurrence({ visit_cadence: 'ANNUAL', interval_unit: 'YEAR', interval_count: 1 })).toBe('Annually');
  });

  it('ignores byweekday for non-weekly structured rules', () => {
    expect(
      describeRecurrence({ visit_cadence: 'MONTHLY', interval_unit: 'MONTH', interval_count: 1, byweekday: [1] }),
    ).toBe('Monthly');
  });
});
