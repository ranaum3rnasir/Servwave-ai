import type { Prisma, Role } from '@prisma/client';
import type { Request } from 'express';
import type { AppAbility } from './defineAbility';

/**
 * WHO MAY THIS PERSON PUT ON A TASK AS AN OBSERVER?
 *
 * Task watcher pool (issue #1956). Sibling of `assigneePool.ts`, and deliberately a SEPARATE
 * module rather than a fourth `AssigneePurpose`, because watching is not assigning: no grant
 * governs it, so it has no entry in that module's purpose→grant map and would have had to be
 * special-cased inside it.
 *
 * ── DECISION RECORD ──────────────────────────────────────────────────────────────────────
 *
 * ONE DEFINITION, BOTH DIRECTIONS. The defect this module fixes is precisely a read and a
 * write that disagreed about who was eligible: the Watchers picker asked `purpose=task`
 * (gated by `assign Task`, a grant in NO default role, so the field offered exactly one
 * name) while the write side checked only active org membership and would happily accept
 * anyone. `poolClauses` below is the single place the rule exists; `watcherPoolWhere` and
 * `isWatcherPermitted` are both DERIVED from it. Do not add a clause to one without the
 * other — that is the bug, re-introduced.
 *
 * READS THE ABILITY, NEVER A ROLE NAME. The org-wide answer is `manage all`, the same
 * short-circuit `assigneePool` uses, and deliberately NOT `role === 'ADMIN'`. Custom roles
 * and per-user overrides are already in production: an ADMIN-DERIVED custom role ("full
 * access minus payroll") carries base_role ADMIN but does NOT hold `manage all`, so it
 * correctly falls through to the department rule rather than silently being a superuser.
 * A role-name check would look equivalent against the seeded defaults and be wrong for
 * every customised org.
 *
 * NO DATABASE. The rule needs the actor's own `department_id`, which the session already
 * carries (`authenticate.ts` selects it onto `req.user`), and the CANDIDATES' role and
 * department, which the caller already has in hand — the roster because it is running the
 * query, the write guard because it fetches the rows it is about to validate. So this stays
 * a pure, unit-testable seam, matching the decision recorded in `assigneePool`.
 *
 * A NULL DEPARTMENT IS NOT A DEPARTMENT. When the actor has no `department_id` the third
 * clause is OMITTED rather than matching other null-department users. "Nobody has set a
 * department" is not a shared department, and treating it as one would silently group
 * unrelated people. Such an actor still gets themselves plus every admin, which is a usable
 * list rather than an empty one.
 *
 * AN INTERSECTION, NEVER A SHORT-CIRCUIT. `watcherPoolWhere` returns a fragment to be ANDed
 * with the roster's existing tenant scope, `is_active` filter and `eligible_for` rules. It
 * must never replace them, or the picker would offer a row the write side refuses.
 *
 * WHAT THIS DOES NOT ANSWER. Not "is that id an active member of this org" — that stays in
 * `task.controller`'s existing membership check, which keeps its 400 because it answers a
 * different question. This module only ever answers "may THIS actor watch-add THAT person",
 * and answers 403.
 */

/** The candidate fields the rule reads. Structurally satisfied by a Prisma user row. */
export type WatcherCandidate = {
  id: string;
  role: Role;
  department_id: string | null;
};

/**
 * Where a requester may draw watchers from.
 *   `org`  — everyone in the organization; the pool is not narrowed here.
 *   `cohort` — themselves, every ADMIN, and (when set) their own department.
 *
 * `userId` and `departmentId` are carried ON the scope rather than left for the caller to
 * re-read off `req.user`, so a consumer cannot narrow the pool around the wrong person.
 */
export type WatcherPool =
  | { scope: 'org' }
  | { scope: 'cohort'; userId: string; departmentId: string | null };

/**
 * THE RULE, and the only place it exists. Returns the disjunction of clauses a candidate must
 * satisfy, or `null` for "no narrowing at all" (the org scope).
 *
 * Both public entry points below are derived from this. A `Clause` is deliberately a shape
 * that reads as both a Prisma filter and an in-memory test, which is what lets one definition
 * serve the query and the predicate without either restating the rule.
 */
type Clause =
  | { id: string }
  | { role: 'ADMIN' }
  | { department_id: string };

function poolClauses(pool: WatcherPool): Clause[] | null {
  if (pool.scope === 'org') return null;
  return [
    // Always themselves — an actor is in their own pool even with no department and no admins.
    { id: pool.userId },
    // Escalation without a permission change: every admin is reachable by everyone.
    { role: 'ADMIN' },
    // Their own department, and ONLY when they have one. See A NULL DEPARTMENT above.
    ...(pool.departmentId ? [{ department_id: pool.departmentId } as const] : []),
  ];
}

/**
 * The resolver. Pure: no database, no `Request`, no clock.
 *
 * `ability` is the built CASL ability the session already carries (`req.ability`); `undefined`
 * fails closed to the cohort scope, matching `enforce.ts`'s `can()`. The narrow answer is the
 * safe one, and with an empty `departmentId` it still permits the actor themselves.
 */
export function resolveWatcherPool(
  ability: AppAbility | undefined,
  requesterId: string,
  departmentId: string | null | undefined,
): WatcherPool {
  const orgWide = ability?.can('manage', 'all') ?? false;
  return orgWide
    ? { scope: 'org' }
    : { scope: 'cohort', userId: requesterId, departmentId: departmentId ?? null };
}

/**
 * Express convenience for the roster and the write guard: `resolveWatcherPool` over `req`.
 *
 * An absent `req.user` yields a cohort keyed on the empty string with no department, which
 * permits the empty set and refuses every named id — fail-closed, and unreachable in practice
 * since every door that calls this sits behind `authenticate`.
 */
export function resolveWatcherPoolForRequest(req: Request): WatcherPool {
  return resolveWatcherPool(req.ability, req.user?.id ?? '', req.user?.department_id);
}

/**
 * THE READ SIDE. A Prisma fragment to AND with the roster's existing filters.
 *
 * Returns `{}` for the org scope — an empty fragment narrows nothing, so the caller can merge
 * it unconditionally. Deliberately returns a nested `AND: [{ OR: [...] }]` rather than a bare
 * `OR`, because the roster's `where` may ALREADY carry an `OR` (the `include_referenced_in`
 * union) and a second one would clobber it.
 */
export function watcherPoolWhere(pool: WatcherPool): Prisma.UserWhereInput {
  const clauses = poolClauses(pool);
  if (!clauses) return {};
  return { AND: [{ OR: clauses as Prisma.UserWhereInput[] }] };
}

/**
 * THE WRITE SIDE. Is this ONE candidate inside the pool? Derived from the same clauses the
 * query fragment is built from, so the picker and the save cannot drift apart.
 */
export function isWatcherPermitted(pool: WatcherPool, candidate: WatcherCandidate): boolean {
  const clauses = poolClauses(pool);
  if (!clauses) return true;
  return clauses.some((c) =>
    'id' in c ? candidate.id === c.id
    : 'role' in c ? candidate.role === c.role
    : candidate.department_id === c.department_id,
  );
}

/**
 * The set form the controllers call. Every candidate must be permitted.
 *
 * An EMPTY set is permitted — watchers default to nobody and removing them all is a legitimate
 * edit. Callers pass only the ids they are ADDING: an update deliberately does not re-check
 * watchers already on the task, or changing a title would fail (or silently strip a watcher)
 * whenever a previously-added watcher had since moved department.
 */
export function isWatcherSetPermitted(
  pool: WatcherPool,
  candidates: readonly WatcherCandidate[],
): boolean {
  return candidates.every((c) => isWatcherPermitted(pool, c));
}
