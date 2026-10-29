/**
 * loDelta — the PROCESSED-edit delta hint (spec §12 rec 7 / plan §3 line 158).
 *
 * When a user edits an already-PROCESSED Logistic Order, saving re-posts stock movements
 * (M5 line-ops table): add line → consume, remove line → return, qty up → consume the delta,
 * qty down → return the delta, location change → return the old + consume the new. We show the
 * NET stock effect per location BEFORE commit so the change is never a surprise:
 *
 *   "Saving returns 2 to Main Warehouse and consumes 3 from Van."
 *
 * Why net-by-location (not per-line): the physical on-hand outcome per location is identical
 * whether the server posts one movement or several, and a netted summary is the clearest honest
 * preview. A location that both gains and loses in the same edit collapses to its net (a location
 * that returns 2 and consumes 4 shows as "consumes 2"); a net of zero is omitted entirely. Line
 * identity is irrelevant to the net, so this needs no id-matching — just per-location totals.
 *
 * Pure: no React, no I/O. `resolveLocationName` maps a location id to its display name (the editor
 * backs it with `useLocations()`); an unknown id falls back to a neutral label so the hint never
 * renders a raw UUID. Unplaced lines (from_location_id null — a half-added draft line) are skipped:
 * they aren't deductable and would fail validation before any movement.
 */

/** The only fields the delta needs — LOLineDraft (and any write line) satisfies this structurally. */
export interface LoDeltaLine {
  qty: number;
  from_location_id: string | null;
}

/** One location's net movement. `qty` is always positive; the side (returns/consumes) carries the sign. */
export interface LoLocationMovement {
  locationId: string;
  locationName: string;
  qty: number;
}

/** The netted stock effect of a PROCESSED edit, split by direction. Empty arrays ⇒ no-op. */
export interface LoProcessedDelta {
  /** Stock flowing BACK to these locations (qty reduced / lines removed / moved away). */
  returns: LoLocationMovement[];
  /** Stock pulled FROM these locations (qty raised / lines added / moved in). */
  consumes: LoLocationMovement[];
}

const UNKNOWN_LOCATION = 'another location';

const qtyOf = (line: LoDeltaLine): number => (Number.isFinite(line.qty) ? line.qty : 0);
const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Net stock effect per location of moving from `current` (the persisted PROCESSED lines) to
 * `edited` (the about-to-save draft). Positive net at a location ⇒ consume; negative ⇒ return.
 */
export function computeLoProcessedDelta(
  current: readonly LoDeltaLine[],
  edited: readonly LoDeltaLine[],
  resolveLocationName: (locationId: string) => string | undefined,
): LoProcessedDelta {
  // net[loc] = editedTotal[loc] − currentTotal[loc]: how much MORE (or less) must leave that location.
  const net = new Map<string, number>();
  const add = (locationId: string | null, delta: number) => {
    if (!locationId) return; // unplaced line — nothing to move yet
    net.set(locationId, (net.get(locationId) ?? 0) + delta);
  };
  for (const line of current) add(line.from_location_id, -qtyOf(line));
  for (const line of edited) add(line.from_location_id, qtyOf(line));

  const returns: LoLocationMovement[] = [];
  const consumes: LoLocationMovement[] = [];
  for (const [locationId, raw] of net) {
    const q = round2(raw);
    if (q === 0) continue;
    const movement: LoLocationMovement = {
      locationId,
      locationName: resolveLocationName(locationId) || UNKNOWN_LOCATION,
      qty: Math.abs(q),
    };
    (q > 0 ? consumes : returns).push(movement);
  }
  const byName = (a: LoLocationMovement, b: LoLocationMovement) =>
    a.locationName.localeCompare(b.locationName);
  returns.sort(byName);
  consumes.sort(byName);
  return { returns, consumes };
}

const fmtQty = (q: number): string =>
  new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(q);

/**
 * Render a delta as one human sentence, or null when nothing moves (no-op edit — hide the hint).
 * "Saving returns 2 to Main Warehouse and consumes 3 from Van."
 */
export function describeLoProcessedDelta(delta: LoProcessedDelta): string | null {
  const returnsClause = delta.returns.length
    ? `returns ${delta.returns.map((m) => `${fmtQty(m.qty)} to ${m.locationName}`).join(', ')}`
    : null;
  const consumesClause = delta.consumes.length
    ? `consumes ${delta.consumes.map((m) => `${fmtQty(m.qty)} from ${m.locationName}`).join(', ')}`
    : null;
  const clauses = [returnsClause, consumesClause].filter(Boolean);
  if (clauses.length === 0) return null;
  return `Saving ${clauses.join(' and ')}.`;
}

/** compute + describe in one call — what LODetailSheet renders under the line editor. */
export function loProcessedDeltaHint(
  current: readonly LoDeltaLine[],
  edited: readonly LoDeltaLine[],
  resolveLocationName: (locationId: string) => string | undefined,
): string | null {
  return describeLoProcessedDelta(computeLoProcessedDelta(current, edited, resolveLocationName));
}
