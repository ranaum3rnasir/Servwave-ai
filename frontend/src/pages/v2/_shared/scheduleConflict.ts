/**
 * The item shape a scheduling 409 carries: the bookings that already own the slot.
 *
 * Q6 (RATIFIED): this shape was copy-pasted in FIVE places with no shared type - the
 * conflict-toast state in SchedulePage.tsx, its three axios-error casts, and walkthroughTab's
 * own `ScheduleConflict`. That is exactly how BE-routes's additive `crew` / `customer_name`
 * fields would land in four of the five copies and be forgotten in the fifth. One export, five
 * imports.
 *
 * Lives in `_shared/`, not in `schedule/`, even though the schedule board is its main reader:
 * `walkthroughTab.tsx` (module `leads/`) needs the same type, and the v2 module-isolation guard
 * (`pages/v2/__tests__/moduleIsolation.test.ts`) forbids one module importing from another's
 * folder - `_shared/` is the one exempt directory for exactly this case.
 *
 * `crew` and `customer_name` are NEW and ADDITIVE. BE-routes is widening the 409 body to carry
 * them, but a body from before that backend PR merges - or from any caller that has not picked
 * it up - carries neither. Every reader of this type must treat both as optional and render
 * without them rather than assume the wider shape.
 */
export interface ScheduleConflictItem {
  type: 'job' | 'walkthrough';
  id: string;
  number: string;
  start: string | Date;
  end: string | Date;
  /**
   * The CLASHING crew member(s) only - the intersection of the queried users and that visit's
   * assignees - not the visit's whole roster. Additive; absent on an old-shaped body.
   */
  crew?: { id: string; name: string }[];
  /** Additive; absent on an old-shaped body, and legitimately null when the record has no customer. */
  customer_name?: string | null;
}
