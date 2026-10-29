/**
 * Reverse-map a stored numeric tax rate back to the jurisdiction that produced it, for the tax
 * dropdown's selected value.
 *
 * WHY THIS IS AMBIGUOUS: only the resulting `tax_rate` is persisted on an Estimate/Invoice/Job.
 * The state that produced it is discarded (backend `deriveTaxRateFromLead` / `taxRateForState`
 * look up `stateTaxRate.findFirst({ state_code })` and keep just the number). US state base rates
 * collide heavily - 6.25% is IL, MA and TX; 6% is held by a dozen states - so a rate ALONE cannot
 * identify a jurisdiction.
 *
 * Matching on rate alone therefore named whichever colliding state happened to sort first, which is
 * how an Austin TX job rendered "Illinois (6.25%)" (#985). The tax AMOUNT was always correct; only
 * the label misattributed it.
 *
 * The tiebreak is the record's own service-location state, because that is exactly what the backend
 * used to choose the rate (destination-based tax). When it is absent or does not match the rate, we
 * fall back to the first rate match rather than showing nothing: the caller renders a plain
 * percentage for an unmatched rate, and silently downgrading every colliding single-state org to
 * "Custom" would be a worse regression than the mislabel this fixes.
 */

/** Structural shape of a jurisdiction row. Kept local so this stays a pure, import-free helper. */
export interface TaxRateOption {
  state_code: string;
  tax_rate: string | number;
}

/**
 * tax_rate carries 5 decimal places (R5c). Tighter than storage precision so two genuinely
 * distinct nearby rates are never conflated, loose enough to absorb float round-trip noise.
 */
const RATE_EPSILON = 0.000001;

const toNum = (v: string | number): number => (typeof v === 'number' ? v : Number(v) || 0);

/**
 * The jurisdiction row to show as selected for `rate`, or undefined when no row carries that rate
 * (the caller renders the raw percentage instead).
 *
 * `preferredStateCode` is the record's service-location state. When several jurisdictions share the
 * rate, it decides between them; it never promotes a row whose rate does not match.
 */
export function matchTaxRateState<T extends TaxRateOption>(
  taxRates: T[],
  rate: number,
  preferredStateCode?: string | null,
): T | undefined {
  const sameRate = taxRates.filter((r) => Math.abs(toNum(r.tax_rate) - rate) < RATE_EPSILON);
  if (sameRate.length === 0) return undefined;
  if (sameRate.length === 1) return sameRate[0];

  if (preferredStateCode) {
    const wanted = preferredStateCode.trim().toUpperCase();
    const preferred = sameRate.find((r) => r.state_code.toUpperCase() === wanted);
    if (preferred) return preferred;
  }

  // Genuinely undecidable: no service-location state, or it is not one of the colliding
  // jurisdictions. Keep the pre-existing first-match behaviour so nothing regresses.
  return sameRate[0];
}
