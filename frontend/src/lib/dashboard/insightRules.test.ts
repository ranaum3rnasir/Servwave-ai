import { describe, it, expect } from 'vitest';
import { computeInsights } from './insightRules';
import { dashboardSeed } from '@/lib/api/_mock/dashboard';

describe('computeInsights', () => {
  it('returns at most 3 insights', () => {
    expect(computeInsights(dashboardSeed).length).toBeLessThanOrEqual(3);
  });

  it('flags past-due AR as the highest-weight insight when 60+ exists', () => {
    const first = computeInsights(dashboardSeed)[0];
    expect(first?.id).toBe('past_due_ar');
    expect(first?.link).toBe('/invoices');
  });

  it('emits no past-due insight when AR aging buckets are zero', () => {
    const clean = {
      ...dashboardSeed,
      kpis: { ...dashboardSeed.kpis, ar: { total: 0, current: 0, over_30: 0, over_60: 0 } },
    };
    expect(computeInsights(clean).some((i) => i.id === 'past_due_ar')).toBe(false);
  });
});
