/**
 * Guard against the decimal slip that turns 6.6% into 66%, without nagging an admin who is
 * correcting a rate to its real local value.
 *
 * Two triggers, both in PERCENT units (6.625, not 0.06625):
 *  - the new rate is above 15%. Louisiana is the national high at 10.11%, so nothing legitimate
 *    reaches here.
 *  - the rate moves by more than 3 percentage points. 6.60 -> 6.625 is a correction and passes
 *    silently; 6.60 -> 66.0 is a typo and does not.
 *
 * `previousPct` is undefined when adding a new rate, where only the ceiling applies.
 */
export const IMPLAUSIBLE_RATE_PCT = 15;
export const IMPLAUSIBLE_SWING_PCT = 3;

export function isImplausibleRateChange(nextPct: number, previousPct?: number): boolean {
  if (!Number.isFinite(nextPct)) return false;
  if (nextPct > IMPLAUSIBLE_RATE_PCT) return true;
  if (previousPct === undefined || !Number.isFinite(previousPct)) return false;
  return Math.abs(nextPct - previousPct) > IMPLAUSIBLE_SWING_PCT;
}
