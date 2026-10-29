/**
 * #2053 slice 1 — `countsTowardTotals` (frontend/src/components/jobs/items/money.ts) is the ONE
 * frontend expression of the selection predicate, mirroring the backend's `countsTowardTotals`
 * (backend/src/lib/invoice-totals.ts). This pins the full truth table so the two can never drift
 * apart silently.
 */
import { describe, it, expect } from 'vitest';
import { countsTowardTotals } from '@/components/jobs/items/money';

describe('countsTowardTotals', () => {
  it('the full truth table: counted unless is_optional === true AND is_selected === false', () => {
    expect(countsTowardTotals({ is_optional: false, is_selected: true })).toBe(true);
    expect(countsTowardTotals({ is_optional: false, is_selected: false })).toBe(true);
    expect(countsTowardTotals({ is_optional: true, is_selected: true })).toBe(true);
    expect(countsTowardTotals({ is_optional: true, is_selected: false })).toBe(false);
  });

  it('both keys absent counts — a Job/Invoice line, or any pre-migration row, sums unconditionally', () => {
    expect(countsTowardTotals({})).toBe(true);
    expect(countsTowardTotals({ is_optional: null, is_selected: null })).toBe(true);
    expect(countsTowardTotals({ is_optional: undefined, is_selected: undefined })).toBe(true);
  });
});
