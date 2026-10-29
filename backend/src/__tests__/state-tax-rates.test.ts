import { describe, it, expect } from 'vitest';
import { STATE_TAX_RATES } from '../seed-tax-rates';

// The seed is the source of truth for the state_tax_rates reference table, and it is a
// re-runnable upsert whose `update` clause overwrites tax_rate. That makes any rounding in
// here permanent the next time someone runs `npm run seed:tax-rates`: it silently reverts
// whatever a migration corrected. It has happened once already - the column started as
// DECIMAL(5,4), which physically could not hold 6.625%, so MN/MO/NJ/NM were authored rounded;
// migration 20260722020000 widened to DECIMAL(6,5) and corrected those four rows, but the seed
// was never updated to match, leaving a correction that any seed run undoes.
//
// These tests pin the precision contract rather than just the known values, so the next
// three-decimal rate cannot be rounded in unnoticed.
//
// 2026-08-04: the column this file guards changed meaning - from the bare state rate to the Tax
// Foundation's "Combined State & Average Local Sales Tax Rate" (see seed-tax-rates.ts for why).
// The precision contract above is untouched by that; the value assertions below were re-authored
// around the new column and now also guard the reverse direction - a silent revert to state-only
// rates fails just as loudly as a rounding-in.

// Mirrors the Prisma schema: StateTaxRate.tax_rate is Decimal(6,5).
const COLUMN_SCALE = 5;

/** Decimal places actually present in a JS number literal, e.g. 0.06875 -> 5. */
function decimalPlaces(value: number): number {
  const text = value.toString();
  if (text.includes('e') || text.includes('E')) {
    throw new Error(`rate ${text} is in exponent form - author it as a plain decimal`);
  }
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

describe('STATE_TAX_RATES seed data', () => {
  it('covers all 50 states plus DC exactly once', () => {
    expect(STATE_TAX_RATES).toHaveLength(51);
    const codes = STATE_TAX_RATES.map((r) => r.state_code);
    expect(new Set(codes).size).toBe(51);
  });

  it('stores every rate at a precision the DECIMAL(6,5) column can hold', () => {
    const tooPrecise = STATE_TAX_RATES.filter((r) => decimalPlaces(r.tax_rate) > COLUMN_SCALE);
    expect(tooPrecise).toEqual([]);
  });

  it('reproduces its source percentage exactly, with no rounding', () => {
    // The rounding hazard this file was written for is unchanged; only the column it guards moved.
    // The source publishes combined rates to two decimals as a percent (8.54%), so every rate is
    // an exact multiple of 0.0001 as a fraction. A rate that is not says someone hand-computed or
    // truncated it. Asserted in integer basis points because 0.0854 * 10000 is not exactly 854 in
    // binary floating point.
    for (const row of STATE_TAX_RATES) {
      const basisPoints = Math.round(row.tax_rate * 10000);
      expect(
        Math.abs(row.tax_rate * 10000 - basisPoints),
        `${row.state_code} carries precision its source column does not publish - it was computed, not copied`,
      ).toBeLessThan(1e-6);
      expect(decimalPlaces(row.tax_rate)).toBeLessThanOrEqual(COLUMN_SCALE);
    }
  });

  it('holds the COMBINED state + average local rate, not the bare state rate', () => {
    // 2026-08-04: this table was the state-only column (#1208). It is now the Tax Foundation's
    // "Combined State & Average Local Sales Tax Rate" - a contractor billing in Brooklyn charges
    // 8.54%, not New York's 4.00% state slice. These anchors are the states where the two columns
    // diverge most, so a silent revert to state-only rates cannot pass.
    const combined: Record<string, number> = {
      NY: 0.0854, // state-only would be 0.0400
      LA: 0.1011, // state-only would be 0.0500 - highest combined rate in the country
      TN: 0.0961, // state-only would be 0.0700
      AL: 0.0946, // state-only would be 0.0400
      AK: 0.0182, // no state sales tax at all, yet local rates are real money
      TX: 0.082, // state-only would be 0.0625
    };

    for (const [code, expected] of Object.entries(combined)) {
      const row = STATE_TAX_RATES.find((r) => r.state_code === code);
      expect(row, `${code} missing from the seed`).toBeDefined();
      expect(row!.tax_rate, `${code} looks like the state-only rate, not the combined one`).toBe(expected);
    }
  });

  it('keeps New Jersey below its own state rate, where the source table puts it', () => {
    // The one row where "combined" is LOWER than the state rate: NJ's Urban Enterprise Zones
    // charge half rate, dragging the local average negative. It reads like a typo, so it is
    // pinned - both against a well-meaning "fix" up to 6.625% and against a blanket recompute.
    const nj = STATE_TAX_RATES.find((r) => r.state_code === 'NJ');
    expect(nj!.tax_rate).toBe(0.066);
    expect(nj!.tax_rate).toBeLessThan(0.06625);
  });

  it('has no rate outside a plausible range for a US combined sales tax rate', () => {
    // Ceiling raised from 12% with the move to combined rates: LA is 10.11% and several states
    // clear 9%, so the state-only headroom no longer says anything useful.
    for (const row of STATE_TAX_RATES) {
      expect(row.tax_rate, `${row.state_code} out of range`).toBeGreaterThanOrEqual(0);
      expect(row.tax_rate, `${row.state_code} out of range`).toBeLessThan(0.15);
    }
  });
});
