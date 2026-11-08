/**
 * The built-in estimate decline reasons, and the rules that govern the per-org list.
 *
 * WHY THESE FIVE, AND WHY THEY ARE NOT IN THE DATABASE. Decision D3 of the decline-reasons plan:
 * the list resolves as "the organisation's rows if it has any, else the five below". No migration
 * writes rows into every organisation, so an org that has never opened the settings screen has
 * zero rows and reads these; its first save materialises all five at once. That is the only
 * reason the migration is a single CREATE TABLE with no backfill, and the reason a newly created
 * organisation needs no seeding step of its own.
 *
 * THE LABELS ARE MIRRORED, NOT SHARED. `frontend/src/constants/lostReasons.ts` carries the same
 * five code -> label pairs, the same way LOST_REASON_NOTE_MAX is written once per side: the two
 * builds share no module, so the wording is stated on each side and cross-referenced here. A
 * drift between them is a real defect - decision D7 says staff and customers must read the SAME
 * words, or the conversion report measures the wording rather than the loss - so the two lists
 * are pinned equal by a test rather than by a comment alone.
 *
 * THE CODES ARE LOAD-BEARING AND MUST NOT BE RENAMED. `estimates.lost_reason` stores this CODE
 * STRING (they are the `LostReason` enum's five members, character for character), the
 * conversion report groups on it, and every estimate already declined holds one. A rename here
 * would silently re-bucket history. The LABEL is the renameable half, and renaming it rewrites
 * no estimate.
 */

import { prisma } from './prisma';

export interface BuiltInLostReason {
  code: string;
  label: string;
}

/** The five built-ins, in the order both pickers offer them. */
export const BUILT_IN_LOST_REASONS: readonly BuiltInLostReason[] = [
  { code: 'PRICE', label: 'Price' },
  { code: 'TIMING', label: 'Timing' },
  { code: 'COMPETITOR', label: 'Went with a competitor' },
  { code: 'NO_RESPONSE', label: 'Customer stopped responding' },
  { code: 'OTHER', label: 'Other' },
] as const;

export const BUILT_IN_LOST_REASON_CODES: ReadonlySet<string> = new Set(
  BUILT_IN_LOST_REASONS.map((r) => r.code),
);

/**
 * The one code that must always be offered (decision D5).
 *
 * "Other" is where the free-text comment belongs. A list with no escape hatch pushes a customer
 * into a category that is wrong for them or out of answering at all, and the comment box -
 * `lost_reason_note`, already live - has nothing to hang off. So it may be RENAMED like any
 * other built-in, but never deactivated.
 */
export const UNDEACTIVATABLE_LOST_REASON_CODE = 'OTHER';

/**
 * Ceiling on how many reasons one organisation may keep.
 *
 * Not a storage concern - it is the picker. Both surfaces render this list as a flat set of
 * choices, and a customer scrolling past fifty of them will pick the first plausible one rather
 * than the true one, which costs exactly the signal the feature exists to capture. Fifty is
 * already far beyond any real vocabulary (the five built-ins plus a trade's own handful); it is
 * set where it is to stop a scripted or mistaken client filling the table, not to ration a real
 * admin.
 */
export const MAX_LOST_REASON_OPTIONS = 50;

/** Longest label an admin may give a reason. Matches the job sub-status catalog's own cap. */
export const LOST_REASON_LABEL_MAX = 60;

/**
 * Longest generated code. Codes are derived from the label (see `deriveLostReasonCode`) and are
 * stored into `estimates.lost_reason`, so the cap is about that column's readability in a report,
 * not about the label - a 60-character label truncates to a 40-character code and is still
 * unique in every realistic case, because the unique key catches the rest.
 */
export const LOST_REASON_CODE_MAX = 40;

/** The shape a code must have to be addressable in a URL and legible in the conversion report. */
export const LOST_REASON_CODE_PATTERN = /^[A-Z0-9_]{1,40}$/;

/**
 * Derive the stored code from the label an admin typed.
 *
 * Upper snake case, so a hand-added reason reads in the conversion report exactly like the five
 * built-ins do ("Went with a designer" -> WENT_WITH_A_DESIGNER) instead of standing out as the
 * one lower-case value in the column. Case-folding also means "Designer" and "designer" collide
 * on the unique key rather than becoming two indistinguishable rows in the same dropdown - the
 * same reason `upsertUomOption` upper-cases a unit code.
 *
 * Returns null when the label has no letters or digits at all ("---", "???"), because there is
 * no code to derive and an empty one would be unaddressable. The caller turns that into a 400.
 */
export function deriveLostReasonCode(label: string): string | null {
  const code = label
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, LOST_REASON_CODE_MAX)
    // A trailing underscore can reappear after the slice cut a word in half.
    .replace(/_+$/, '');
  return code.length > 0 ? code : null;
}

// ─── Slice C: what an organisation actually offers right now ────────────────

/**
 * One option as the two pickers need it: the stored value and the words to show. Nothing else.
 *
 * Deliberately NOT the settings screen's DTO. `is_active` and `sort_order` are how an admin
 * curates the list; a picker has no use for either (an inactive option is simply absent, and the
 * order is the array's), and the public surface must not leak them at all (decision D6).
 */
export interface OfferedLostReason {
  code: string;
  label: string;
}

/**
 * The reasons an organisation offers a chooser today - the single source both pickers read.
 *
 * D3's resolve rule, applied once here rather than re-derived per call site: the org's OWN rows
 * if it has any, else the five built-ins. Note the fallback is keyed on whether the org has ANY
 * rows, NOT on whether it has any ACTIVE ones. An org that has materialised its list and then
 * switched most of it off has curated it, and answering that with the five built-ins would undo
 * the curation and re-offer words the admin deliberately retired. (D5 keeps "Other" un-
 * deactivatable, so a materialised org always has at least one option left; the count check is
 * what makes that a safety net rather than the load-bearing rule.)
 *
 * Ordering matches `list`'s exactly - sort_order then code - so the picker offers the reasons in
 * the order the admin dragged them into, and two rows that tie never swap between renders.
 */
export async function resolveOfferedLostReasons(organizationId: string): Promise<OfferedLostReason[]> {
  const rows = await prisma.lostReasonOption.findMany({
    where: { organization_id: organizationId },
    orderBy: [{ sort_order: 'asc' }, { code: 'asc' }],
  });
  if (rows.length === 0) {
    return BUILT_IN_LOST_REASONS.map((r) => ({ code: r.code, label: r.label }));
  }
  return rows.filter((r) => r.is_active).map((r) => ({ code: r.code, label: r.label }));
}

/**
 * Is this code one the organisation currently offers?
 *
 * Decision D10: until slice A the database's own enum refused anything outside the five whatever
 * the application did, and TEXT retired that. The membership checks are now the only guard, so
 * slice C replaces WHAT they check against - this list instead of `LostReason` - and never
 * WHETHER they check. Every one of the three write paths (D9) runs it.
 *
 * Checked against the OFFERED list, so a retired reason cannot be newly assigned by a client
 * holding a stale picker. Estimates already carrying that code keep it and still report under it
 * (D4) - this governs new writes only.
 */
export async function isOfferedLostReason(organizationId: string, code: string): Promise<boolean> {
  const offered = await resolveOfferedLostReasons(organizationId);
  return offered.some((o) => o.code === code);
}
