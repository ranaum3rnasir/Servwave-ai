import type { Request } from 'express';
import type { Action, Subject } from './catalog';
import type { AppAbility } from './defineAbility';

/**
 * WHO MAY THIS PERSON NAME ON A PIECE OF WORK?
 *
 * Scoped assignee pool, slice 2 (plan: md_files/plans/permissions/2026-08-31-assignee-pool/).
 * One module answers that question so a future door cannot forget to ask it (PRD story 30).
 *
 * ── DECISION RECORD ──────────────────────────────────────────────────────────────────────
 *
 * READS THE ABILITY, NEVER A ROLE NAME. `resolveAssigneePool` takes the built CASL ability,
 * not a user's role. That is not a style preference, it is the whole reason custom roles and
 * per-user overrides work here with no extra code in this file: a custom sales-manager role
 * holding `assign User` resolves to org scope, a per-user allow override resolves to org
 * scope, a per-user deny resolves to self-only, and ADMIN resolves to org through the
 * manage-all short-circuit without holding an explicit row — all of it a CONSEQUENCE of
 * asking the ability. Rewriting this as `role === 'DISPATCHER' || role === 'TECHNICIAN'`
 * would look equivalent against the seeded defaults and be wrong for every org that has
 * customised anything. Custom roles are already in production (PRD story 31). Do not
 * "optimise" the ability lookup into a role check.
 *
 * PURPOSE-AWARE, VIA ONE EXHAUSTIVE MAP. The grant read is chosen by the caller's PURPOSE,
 * and the purpose→grant mapping is the single `PURPOSE_GRANT` constant below rather than a
 * conditional at each call site. Tasks keep asking the long-shipped `assign Task` grant;
 * job crew and walkthrough performers ask slice 1's `assign User`. Collapsing the two onto
 * one grant was considered and REJECTED: a custom role that today holds `assign Task` and
 * nothing else would silently lose task assignment the moment this shipped. `Record<Purpose,
 * …>` makes a new purpose that forgets to declare its grant a compile error.
 *
 * NO DATABASE, NO `Request` IN THE CORE. `resolveAssigneePool` is pure — an ability, an id
 * and a purpose in, a scope out — which is what makes the rule a unit-testable seam instead
 * of another integration surface. `resolveAssigneePoolForRequest` is the thin Express
 * convenience for controllers and is deliberately the only part that knows what a `req` is.
 *
 * FAIL-CLOSED. No ability attached (an un-hydrated request) resolves to self-only, matching
 * `enforce.ts`'s `can()`. The narrow answer is the safe one here.
 *
 * WHAT THIS DOES NOT ANSWER. Not "which work may they re-crew at all" — that is the work's
 * own grant (`assign Job`, `schedule_walkthrough Lead`) with its own row scope, checked
 * separately and before this. Not "is that person an active, eligible member of this org" —
 * that stays in each validator's existing per-member eligibility check, which keeps its 400.
 * This module only ever answers "whose names".
 */

/**
 * The picker asking. NOT the subject being assigned and NOT the route — two purposes may map
 * to the same grant (crew and performers deliberately do, per Ran's one-grant ruling) while
 * still reading as distinct call sites.
 */
export type AssigneePurpose = 'task' | 'jobCrew' | 'walkthroughPerformer';

/**
 * Where a requester may draw names from.
 *   `org`  — every assignable member of the organization; the pool is not narrowed here.
 *   `self` — exactly one name, `userId`. Carried on the scope (rather than left for the
 *            caller to re-read off `req.user`) so a consumer cannot narrow the pool to the
 *            wrong person's id.
 */
export type AssigneePool = { scope: 'org' } | { scope: 'self'; userId: string };

/**
 * Purpose → the grant that widens it past self. The ONE place this mapping exists.
 * Typed as a total `Record`, so adding an `AssigneePurpose` without deciding its grant does
 * not compile.
 */
const PURPOSE_GRANT: Readonly<Record<AssigneePurpose, { action: Action; subject: Subject }>> = {
  // Multi-assignee design §3, shipped long before this plan. Left exactly where it was.
  task: { action: 'assign', subject: 'Task' },
  // Slice 1's grant. Subject is the PEOPLE being named, not the work, because one grant spans
  // two kinds of work.
  jobCrew: { action: 'assign', subject: 'User' },
  walkthroughPerformer: { action: 'assign', subject: 'User' },
};

/**
 * The resolver. Pure: no database, no `Request`, no clock.
 *
 * `ability` is the built CASL ability the session already carries (`req.ability`);
 * `undefined` fails closed to self-only.
 */
export function resolveAssigneePool(
  ability: AppAbility | undefined,
  requesterId: string,
  purpose: AssigneePurpose,
): AssigneePool {
  const grant = PURPOSE_GRANT[purpose];
  const mayNameOthers = ability?.can(grant.action, grant.subject) ?? false;
  return mayNameOthers ? { scope: 'org' } : { scope: 'self', userId: requesterId };
}

/**
 * Express convenience for controllers and validators: `resolveAssigneePool` over `req`.
 *
 * An absent `req.user` yields a self-only pool keyed on the empty string, which permits the
 * empty set and refuses every named id — fail-closed, and unreachable in practice since every
 * door that calls this sits behind `authenticate`.
 */
export function resolveAssigneePoolForRequest(req: Request, purpose: AssigneePurpose): AssigneePool {
  return resolveAssigneePool(req.ability, req.user?.id ?? '', purpose);
}

/**
 * Is this requested set of ids permitted under this pool? The companion predicate, so the crew
 * validator and the performer validator do not each re-derive the rule (and cannot drift apart).
 *
 * An EMPTY set is permitted. Ran's call, recorded in the PRD: "they cannot take themselves off"
 * is enforced by the form, not by a minimum-length check on the API. This is a deliberate
 * divergence from the task validator, which does reject an empty roster — do not "restore
 * symmetry" here without re-opening that decision.
 *
 * Duplicates are harmless: the check is per-id, so `[me, me]` is permitted for the same reason
 * `[me]` is.
 */
export function isAssigneeSetPermitted(pool: AssigneePool, requestedIds: readonly string[]): boolean {
  if (pool.scope === 'org') return true;
  return requestedIds.every((id) => id === pool.userId);
}

/**
 * Did the incoming roster actually DIFFER from the one already on the record? Order- and
 * duplicate-insensitive: an `assignee_ids` / `performer_ids` array is a restated SET, so `[B, A]`
 * restating `[A, B]` is not a change and neither is `[A, A]` restating `[A]`.
 *
 * SHARED, THOUGH THE TWINS' MESSAGES ARE NOT. "Do not merge the twins" is a ruling about the
 * REFUSAL STRINGS - the crew door has to say "job crew" and the walkthrough door has to say
 * "walkthrough", so this module deliberately exports no error text. It is not a ruling about the
 * comparison: both validators must agree on what "unchanged" MEANS, or the same restatement is
 * exempt on one door and refused on the other. `isAssigneeSetPermitted` above is already shared
 * for exactly that reason; this is the other half of the same rule.
 *
 * Also the gate that decides whether naming a crew on a reschedule-shaped door requires `assign
 * Job`. Two defects lived on the old `assignee_ids.length > 0` test, in opposite directions:
 * `assignee_ids: []` on a crewed visit skipped the gate and wiped the crew (length is 0), and a
 * reschedule-only grantee restating the visit's UNCHANGED crew was false-403'd (length is > 0) -
 * VisitScheduleDialog sends `assignee_ids` whenever the picker is shown, on every save, whether or
 * not the user touched it. Comparing SETS fixes both: an empty restatement over a crewed visit IS
 * a change (gated), and an identical restatement is NOT (ungated).
 */
export function assigneeSetChanged(currentIds: readonly string[], incomingIds: readonly string[]): boolean {
  const current = new Set(currentIds);
  const incoming = new Set(incomingIds);
  if (current.size !== incoming.size) return true;
  for (const id of current) if (!incoming.has(id)) return true;
  return false;
}
