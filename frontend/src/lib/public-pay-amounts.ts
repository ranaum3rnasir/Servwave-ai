// Payments go-live slice 26 - the money arithmetic of the public invoice's pay panel, in whole
// cents so a figure never drifts by a fraction of a cent. The server re-validates every figure
// (backend lib/checkout-pricing.ts); these exist so the homeowner sees the same answer first.

/** The smallest partial payment: $1.00. Mirrors the backend's MIN_PARTIAL_PAYMENT_CENTS. */
export const MIN_PARTIAL_CENTS = 100;

/**
 * Whole cents from what a person typed ("40", "$1,250.5", "7.25"), or null when it is not a
 * non-negative dollar figure with at most two decimals.
 */
export function parseDollarsToCents(text: string): number | null {
  const cleaned = text.trim().replace(/^\$/, '').replace(/,/g, '').trim();
  if (!/^(\d+\.?\d{0,2}|\.\d{1,2})$/.test(cleaned)) return null;
  const [whole = '0', fraction = ''] = cleaned.split('.');
  return Number(whole || '0') * 100 + Number(fraction.padEnd(2, '0') || '0');
}

/**
 * The tip each preset stands for, in cents: a percentage of the PRE-TAX share of the amount being
 * paid, so a homeowner is never nudged into tipping on tax. One rounding, at the end. Mirrors the
 * backend's tipPresetAmountsCents.
 */
export function tipPresetCents(input: { presets: number[]; payingCents: number; totalCents: number; taxCents: number }): number[] {
  const { presets, payingCents, totalCents, taxCents } = input;
  if (totalCents <= 0) return presets.map(() => 0);
  const preTaxCents = Math.max(0, totalCents - taxCents);
  return presets.map((pct) => Math.round((payingCents * preTaxCents * pct) / (totalCents * 100)));
}

export const centsToDollars = (cents: number): number => cents / 100;
