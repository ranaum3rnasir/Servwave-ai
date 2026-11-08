import { describe, it, expect } from 'vitest';

import { visitDenominator } from './visits';

/**
 * The "m" of "Visit n of m" - ONE rule shared by the scheduler board (eventAdapters.jobToEvents)
 * and the customer page's Schedule tab (lib/customers/customerSchedule.ts), so the two never print
 * different totals for the same parent.
 */
describe('visitDenominator', () => {
  const v = (visit_seq: number | null, status = 'SCHEDULED') => ({ visit_seq, status });

  it('is the highest visit_seq among the non-cancelled visits', () => {
    expect(visitDenominator([v(1), v(2), v(3)])).toBe(3);
  });

  it('ignores a cancelled LAST visit: two live trips read "of 2"', () => {
    expect(visitDenominator([v(1), v(2), v(3, 'CANCELLED')])).toBe(2);
  });

  it('keeps the seq axis when an EARLIER visit is cancelled: survivors 2 and 3 read "of 3", never "3 of 2"', () => {
    expect(visitDenominator([v(1, 'CANCELLED'), v(2), v(3)])).toBe(3);
  });

  it('counts completed visits (only cancelled ones drop out)', () => {
    expect(visitDenominator([v(1, 'COMPLETED'), v(2)])).toBe(2);
  });

  it('falls back to the live row count when a seq is missing', () => {
    expect(visitDenominator([v(null), v(null)])).toBe(2);
  });

  it('is 0 when every visit was called off', () => {
    expect(visitDenominator([v(1, 'CANCELLED')])).toBe(0);
  });
});
