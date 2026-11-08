/**
 * Why an estimate was lost - the wording, in one place.
 *
 * THIS MODULE WAS THE SEAM FOR SLICE 2, AND SLICE C HAS NOW GONE THROUGH IT. The reason list is
 * PER-ORGANISATION: built-in options plus "Other" with free text, curated by admins from
 * Settings -> Estimate Decline Reasons, so a cabinet business can add "designer" and "quality" -
 * categories the five-value `LostReason` enum had no home for.
 *
 * So what is below is no longer THE list. It is the FALLBACK, and it is still exactly the answer
 * the backend gives for an organisation that has never saved one (decision D3: "the org's rows if
 * it has any, else these five"). Both pickers now read the fetched list and fall back here while
 * it is in flight or if it cannot be had - see `lib/api/lostReasonOptions.ts` for the staff side
 * and `lib/api/publicLostReasons.ts` for the customer's. The point of the fallback is that a
 * decline is never blocked on a settings fetch: a picker that renders empty for a second costs
 * the reason, and a customer who finds nothing to choose may abandon the decline entirely.
 *
 * THESE FIVE ARE MIRRORED FROM THE BACKEND, NOT SHARED WITH IT. `backend/src/lib/
 * lostReasonOptions.ts` states the same five code -> label pairs; the two builds share no module,
 * so the wording is written once per side and pinned equal by a test rather than by a comment.
 * A drift is a real defect - decision D7 says staff and customers must read the SAME words, or
 * the conversion report measures the wording rather than the loss.
 *
 * THE CODES ARE LOAD-BEARING AND MUST NOT BE RENAMED: `estimates.lost_reason` stores the CODE,
 * the conversion report groups on it, and every estimate already declined holds one. The LABEL is
 * the renameable half.
 */

/** The five ServWave ships with, in the order they are offered before an admin reorders them. */
export const LOST_REASON_LABELS: Record<string, string> = {
  PRICE: 'Price',
  TIMING: 'Timing',
  COMPETITOR: 'Went with a competitor',
  NO_RESPONSE: 'Customer stopped responding',
  OTHER: 'Other',
};

/**
 * The fallback array, in the shape `SelectField` takes. Derived from the labels above so the
 * wording has exactly one source on this side.
 *
 * Read it through `useOfferedLostReasonOptions()` (staff) or `usePublicLostReasons()` (customer)
 * rather than importing it into a picker directly - those are what prefer the organisation's own
 * list when there is one. A call site that imports this array straight is pinned to the built-ins
 * and silently ignores every reason the admin added, which is the one regression slice C exists
 * to prevent.
 */
export const LOST_REASON_OPTIONS = Object.entries(LOST_REASON_LABELS).map(([value, label]) => ({
  value,
  label,
}));

/**
 * Ceiling on the free-text comment a customer may leave when declining.
 *
 * Mirrors `LOST_REASON_NOTE_MAX` in `backend/src/controllers/estimate.controller.ts`, the same
 * way `LINE_DESCRIPTION_MAX` is mirrored across `lib/lineItems.ts` and `lib/line-items.ts` - the
 * two builds share no module, so the number is written once per side and cross-referenced. The
 * server TRUNCATES at this length rather than rejecting, so a drift here costs a few silently
 * dropped characters, never a failed decline.
 */
export const LOST_REASON_NOTE_MAX = 2000;
