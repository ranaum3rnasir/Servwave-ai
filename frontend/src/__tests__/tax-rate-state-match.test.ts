/**
 * #985 - the tax dropdown labelled an Austin TX job "Illinois (6.25%)". Only the numeric tax_rate
 * is persisted, so the reverse-map to a jurisdiction matched on the rate and took whichever
 * colliding state came first in the list. The tax AMOUNT was always right; the label lied.
 */
import { describe, it, expect } from 'vitest';
import { matchTaxRateState } from '@/lib/tax/matchTaxRateState';

/** Rows arrive ordered by state_name (state-tax-rate.controller.ts), so IL precedes MA and TX. */
const RATES = [
  { state_code: 'CA', tax_rate: '0.07250' },
  { state_code: 'IL', tax_rate: '0.06250' },
  { state_code: 'MA', tax_rate: '0.06250' },
  { state_code: 'TX', tax_rate: '0.06250' },
  { state_code: 'FL', tax_rate: '0.06000' },
];

describe('matchTaxRateState', () => {
  it('picks the service-location state when several jurisdictions share the rate', () => {
    // The #985 reproduction: pre-fix this returned IL for a Texas service location.
    expect(matchTaxRateState(RATES, 0.0625, 'TX')?.state_code).toBe('TX');
    expect(matchTaxRateState(RATES, 0.0625, 'MA')?.state_code).toBe('MA');
    expect(matchTaxRateState(RATES, 0.0625, 'IL')?.state_code).toBe('IL');
  });

  it('is case- and whitespace-insensitive on the preferred code', () => {
    expect(matchTaxRateState(RATES, 0.0625, 'tx')?.state_code).toBe('TX');
    expect(matchTaxRateState(RATES, 0.0625, ' TX ')?.state_code).toBe('TX');
  });

  it('ignores a preferred state whose own rate does not match', () => {
    // A CA service location on a 6.25% record: CA is 7.25%, so it must not be promoted.
    expect(matchTaxRateState(RATES, 0.0625, 'CA')?.state_code).toBe('IL');
  });

  it('resolves an unambiguous rate without needing a preferred state', () => {
    expect(matchTaxRateState(RATES, 0.0725)?.state_code).toBe('CA');
    expect(matchTaxRateState(RATES, 0.06)?.state_code).toBe('FL');
  });

  it('falls back to first match when the state is unknown, rather than showing nothing', () => {
    // Deliberate: a colliding single-state org keeps a state name instead of degrading to "Custom".
    expect(matchTaxRateState(RATES, 0.0625)?.state_code).toBe('IL');
    expect(matchTaxRateState(RATES, 0.0625, null)?.state_code).toBe('IL');
    expect(matchTaxRateState(RATES, 0.0625, '')?.state_code).toBe('IL');
  });

  it('returns undefined for a rate no jurisdiction carries, so the caller shows the raw percent', () => {
    expect(matchTaxRateState(RATES, 0.0837, 'TX')).toBeUndefined();
    expect(matchTaxRateState([], 0.0625, 'TX')).toBeUndefined();
  });

  it('does not conflate two rates that differ below display precision', () => {
    const near = [
      { state_code: 'AA', tax_rate: '0.06250' },
      { state_code: 'BB', tax_rate: '0.06251' },
    ];
    expect(matchTaxRateState(near, 0.06251, 'BB')?.state_code).toBe('BB');
    expect(matchTaxRateState(near, 0.0625, 'BB')?.state_code).toBe('AA');
  });

  it('accepts numeric as well as string rates', () => {
    const numeric = [
      { state_code: 'IL', tax_rate: 0.0625 },
      { state_code: 'TX', tax_rate: 0.0625 },
    ];
    expect(matchTaxRateState(numeric, 0.0625, 'TX')?.state_code).toBe('TX');
  });
});
