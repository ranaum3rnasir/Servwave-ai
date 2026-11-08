import type { Request } from 'express';
import { subject } from '@casl/ability';
import { prisma } from '../prisma';
import { tenantWhere } from '../tenant';
import type { Action, Subject } from './catalog';
import { defineAbilityFor, type AppAbility, type Grant, type PermissionOverride } from './defineAbility';
import { getCachedGrants, setCachedGrants } from './permissionCache';
import { loadUserOverrides } from './loadUserOverrides';
import { getManagedCapability, capabilityAllowsRole } from './userCapabilities';
import { scopeWhereFor, MATCH_NOTHING, type ScopeResource } from './scopeWhereFor';
import { grantRoleKey, isSuperUser } from './effectiveRole';

/**
 * Minimal slice of a Prisma model delegate — just the visibility probe we need.
 * The `findFirst` argument is intentionally `any`: a concrete Prisma delegate types its
 * `where` as the model-specific `…WhereInput`, and function parameters are contravariant,
 * so a stricter `where` is NOT assignable to a narrower `{ where: unknown }`. `any` lets any
 * real delegate (`prisma.lead`, `prisma.invoice`, …) be passed bare — the canonical call
 * shape — while the call below always supplies `{ where, select: { id: true } }`.
 */
type RowDelegate = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  findFirst(args: any): Promise<{ id: string } | null>;
  // #2042 (R1): canCreateOnAnchor probes existence with `count`, not `findFirst` - see the
  // function's doc comment for why `findFirst` defeats the frozen test's create-path case.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  count(args: any): Promise<number>;
};

/**
 * Canonical per-instance permission check for controllers (#106 security spine).
 *
 * Mirrors the lifecycle-verb owner check that already lives in the controllers:
 *   if (!req.ability!.can(action, subject('Lead', row))) { res.status(403)…; return; }
 *
 * Returns a boolean — it does NOT touch `res`. The caller keeps the SAME
 * early-return 403 mechanism the lifecycle verbs use:
 *
 *   if (!can(req, 'update', 'Job', existing)) {
 *     res.status(403).json({ error: 'Insufficient permissions' });
 *     return;
 *   }
 *
 * FAIL-CLOSED: a request with no `ability` attached (un-hydrated) denies.
 *
 * `row` is the loaded entity; for the CASL conditions to bind it must include the
 * ownership join the role's grant references — e.g. Lead → `lead_assignees`,
 * Job → `assignees`. Load those relations on the `findUnique` that fetches the row.
 */
export function can(
  req: Request,
  action: Action,
  subjectName: Subject,
  row: Record<string, unknown>,
): boolean {
  if (!req.ability) return false;
  return req.ability.can(action, subject(subjectName, row) as unknown as Subject);
}

/**
 * The slice of a user every permission derivation in this module needs. `req.user` satisfies it,
 * and so does a plain `users` row selected with `custom_role` - which is what lets the `*ForUser`
 * entry points below answer for someone who is NOT the caller.
 */
export interface PermissionUser {
  id: string;
  role: string;
  organization_id: string;
  custom_role_id?: string | null;
  custom_role?: { key: string } | null;
  department_id?: string | null;
  location_id?: string | null;
}

/**
 * Resolve the role's persisted grants the SAME way `attachAbility` does
 * (60s request cache, falling back to a `rolePermission` read). Kept here so a
 * list handler can derive its row-scope without the raw grants being plumbed
 * onto `req`. ADMIN short-circuits with no DB read.
 */
async function grantsForUser(user: PermissionUser): Promise<Grant[]> {
  const orgId = user.organization_id;
  // SRVW-138: grants live under the CUSTOM role's key when the user has one, else the
  // base role name. Same key for the lookup and the cache, so the two cannot diverge.
  const role = grantRoleKey(user);
  let grants = getCachedGrants(orgId, role);
  if (!grants) {
    const rows = await prisma.rolePermission.findMany({
      where: { organization_id: orgId, role },
      select: { action: true, subject: true, conditions: true },
    });
    grants = rows.map((r) => ({
      action: r.action,
      subject: r.subject,
      conditions: r.conditions as Record<string, unknown> | null,
    }));
    setCachedGrants(orgId, role, grants);
  }
  return grants;
}

function grantsForReq(req: Request): Promise<Grant[]> {
  return grantsForUser(req.user!);
}

/**
 * The CASL ability for an arbitrary user - `attachAbility`'s body, lifted so a background or
 * batched path can ask a subject-level question ("may this person read Customer at all?") about
 * someone who is not the requester. attachAbility delegates to it, so there is one build.
 */
export async function abilityForUser(user: PermissionUser): Promise<AppAbility> {
  // An ADMIN-DERIVED custom role is NOT a superuser: it must load and apply its grants.
  if (isSuperUser(user)) return defineAbilityFor(user, []);
  const grants = await grantsForUser(user);
  const overrides = await loadUserOverrides(user.id);
  return defineAbilityFor(user, grants, overrides);
}

/**
 * Synthesize the own-scoped `read` grants implied by a user's per-user ALLOW overrides — the SQL
 * mirror of the paired own-scoped `read <subject>` that `defineAbility` materializes into the CASL
 * ability for an allow override (so SQL scope == CASL grant). For each ALLOW override that is a
 * managed capability with `impliesRead`, emit `{ action:'read', subject, conditions }` using the
 * SAME `userCapabilities` ownCondition when the capability declares one (unsubstituted —
 * `scopeWhereFor` substitutes `{{userId}}`). Per-USER, not per-role, so these are loaded
 * separately and NOT cached in the role-grants cache. DENY overrides synthesize nothing (they
 * only block writes via CASL `cannot`).
 *
 * `role` gates role-restricted capabilities (userCapabilities' `roles` allow-list): an allow row
 * for a role that may not hold the capability synthesizes NOTHING.
 *
 * #2042 security fix round 1 (F2). A capability with NO `ownCondition` (an org-wide authority,
 * e.g. `approve LogisticOrder`) used to always synthesize a condition-less read — makes
 * `scopeWhereFor` return {} — every row in the org, REGARDLESS of the role's own read scope on
 * that subject. That was correct only while the role's own `read <subject>` grant was itself
 * unconditional; #2042 conditioned SALES's `read LogisticOrder` to the rep's own job, so an
 * admin flipping the unrelated "Approve logistic orders" toggle on a SALES user silently undid
 * that scoping. `roleGrants` (the role's OWN persisted grants, already loaded by every caller) is
 * how the synthesized read now inherits the role's own condition instead: if the role's own
 * `read <subject>` grant is conditioned, the synthesized read carries THAT condition; if it is
 * unconditional (DISPATCHER) or absent, the synthesized read stays condition-less exactly as
 * before. A capability WITH an `ownCondition` is unaffected — its own condition always wins.
 * defineAbility.ts's per-user-override loop applies the identical rule, so the CASL ability and
 * this SQL scope stay in agreement.
 *
 * Exported for direct unit testing of that filter (the request-level path is `scopeWhereForReq`).
 */
export function overrideReadGrants(
  overrides: { action: string; subject: string; effect: 'allow' | 'deny' }[],
  role: string,
  roleGrants: Grant[] = [],
): Grant[] {
  const reads: Grant[] = [];
  for (const ov of overrides) {
    if (ov.effect !== 'allow') continue;
    const cap = getManagedCapability(ov.action, ov.subject);
    if (!cap || !cap.impliesRead) continue;
    if (!capabilityAllowsRole(cap, role)) continue;
    const roleOwnRead = roleGrants.find((g) => g.action === 'read' && g.subject === ov.subject);
    const conditions = cap.ownCondition ?? roleOwnRead?.conditions ?? undefined;
    reads.push({ action: 'read', subject: ov.subject, conditions });
  }
  return reads;
}

/**
 * Controller-facing wrapper over the pure `scopeWhereFor`: the grant-driven
 * Prisma `where` fragment for the requesting user's row-scope on a resource.
 * Folds the role's persisted read grants TOGETHER WITH the own-scoped reads synthesized from the
 * user's per-user ALLOW overrides (so the SQL scope agrees with the CASL ability, which materializes
 * the same paired read). Spread it into the list `where` alongside `tenantWhere(req)`:
 *
 *   const scopeWhere = { ...tenantWhere(req), ...(await scopeWhereForReq(req, 'Job')) };
 *   const rows = await prisma.job.findMany({ where: scopeWhere, … });
 *
 * Returns:
 *   ADMIN / unconditional read → {}            (no restriction)
 *   conditional read(s)        → owner/team/location condition (or { OR: [...] } if several)
 *   no read grant / no user    → MATCH_NOTHING (fail-closed)
 */
export async function scopeWhereForReq(
  req: Request,
  resource: ScopeResource,
): Promise<Record<string, unknown>> {
  if (!req.user) return { ...MATCH_NOTHING };
  return scopeWhereForUser(req.user, resource);
}

/**
 * `scopeWhereForReq` for a reader who is not the requester - same union rules, same fail-closed
 * behaviour, same per-user override path. Split out so a batched check can ask the row-scope
 * question about an arbitrary user without fabricating a Request.
 */
export async function scopeWhereForUser(
  user: PermissionUser,
  resource: ScopeResource,
): Promise<Record<string, unknown>> {
  // SRVW-138: only an unrestricted ADMIN is unscoped; an ADMIN-derived custom role
  // resolves through its grants like any other role.
  if (isSuperUser(user)) return {};
  // Per-user overrides are per-USER (separate cache) — never merged into the role-grants cache.
  const overrides = await loadUserOverrides(user.id);
  return scopeTemplateForProfile(user, resource, user.id, overrides);
}

/**
 * `scopeWhereForUser` with `{{userId}}` left as a caller-supplied PLACEHOLDER instead of a real id.
 *
 * The transpose of the usual question. `scopeWhereForUser` asks "one reader, which rows?"; a caller
 * asking "one row, which of these readers?" would derive the same fragment once per candidate, and
 * every derivation but the substitution is identical for everyone who shares a permission profile
 * (super-user-ness, grant role key, base role, department, location, override set). Deriving the
 * template once per PROFILE and substituting afterwards is what removes the per-candidate work.
 *
 * `overrides` is passed in rather than loaded here for the same reason: a cohort loads them for
 * everyone in one query (`loadUserOverridesMany`).
 *
 * Same body as the per-user path - `scopeWhereForUser` delegates to it - so the two cannot drift.
 * Capability role-gating compares the BASE role, consistent with the bridge rule everywhere else:
 * a custom role with base_role SALES qualifies wherever SALES does.
 */
export async function scopeTemplateForProfile(
  user: PermissionUser,
  resource: ScopeResource,
  placeholderUserId: string,
  overrides: PermissionOverride[],
): Promise<Record<string, unknown>> {
  if (isSuperUser(user)) return {};
  const roleGrants = await grantsForUser(user);
  const grants = [...roleGrants, ...overrideReadGrants(overrides, user.role, roleGrants)];
  return scopeWhereFor(
    {
      id: placeholderUserId,
      role: user.role,
      custom_role_id: user.custom_role_id ?? null,
      department_id: user.department_id ?? null,
      location_id: user.location_id ?? null,
    },
    resource,
    grants,
  );
}

/**
 * Canonical per-instance ownership check for update/delete controllers (#106b).
 *
 * Enforces visibility through SQL — the SAME `scopeWhereForReq` fragment that
 * powers the (now-correct) lists — instead of CASL's in-memory matcher. This is
 * the uniform fix for the two Wave 2 holes:
 *   - P0: invoice update/delete used `canAccessInvoice()`, which hardcoded
 *     `role===ADMIN||DISPATCHER → true` and IGNORED the persisted grant condition.
 *   - P1: `req.ability.can()` THROWS "equals does not supports comparison of
 *     arrays and objects" on NESTED to-one→to-many conditions (Estimate via
 *     `lead.lead_assignees`; Job/Lead Team via `assignees.some.user.department_id`).
 * A `where`-fragment compiles to SQL, so it is nested-safe and grant-driven.
 *
 * Usage in a controller (keeps the SAME early-return 403 the lifecycle verbs use):
 *
 *   if (!(await canAccessRow(req, 'Invoice', prisma.invoice, id))) {
 *     res.status(403).json({ error: 'Insufficient permissions' });
 *     return;
 *   }
 *
 * Returns whether `id` is visible under the user's per-subject scope:
 *   ADMIN / unconditional read → scope is {} → visible (fast-path, no query)
 *   conditional read grant     → owner/team/location condition must match the row
 *   no read grant / no user    → MATCH_NOTHING (`id: { in: [] }`) → never matches → false
 *
 * ⚠️ THIS IS NOT A TENANCY CHECK. On the unconditional-read fast-path it returns `true` WITHOUT
 * QUERYING AT ALL, so `tenantWhere` is never applied and a row id belonging to ANOTHER
 * ORGANIZATION passes. The `tenantWhere(req)` on the second branch is incidental — it only ever
 * runs when the subject happens to carry a conditional read grant.
 *
 * That fast-path is the DEFAULT for LogisticOrder today: every role that reads LOs holds a
 * condition-less `read LogisticOrder` (defaultGrants.ts), so `canAccessRow(req, 'LogisticOrder',
 * …)` short-circuits to `true` for SALES and DISPATCHER as well as ADMIN. It is equally reachable
 * for any other subject whose read grant is unconditional.
 *
 * So a controller MUST spread `tenantWhere(req)` into its OWN `where` — canAccessRow does not
 * substitute for it and never has:
 *
 *   if (!(await canAccessRow(req, 'LogisticOrder', prisma.logisticOrder, id))) { … 403 … }
 *   const row = await prisma.logisticOrder.findFirst({ where: { id, ...tenantWhere(req) } });
 *   if (!row) { res.status(404)…; return; }   // ← the cross-org guard lives HERE
 */
export async function canAccessRow(
  req: Request,
  subjectName: ScopeResource,
  delegate: RowDelegate,
  id: string,
): Promise<boolean> {
  if (!req.user) return false;
  const scope = await scopeWhereForReq(req, subjectName);
  // ADMIN / unconditional read: empty fragment means no restriction — skip the query.
  if (Object.keys(scope).length === 0) return true;
  const where = { id, ...tenantWhere(req), ...scope };
  return !!(await delegate.findFirst({ where, select: { id: true } }));
}

/**
 * Per-instance check for a verb whose grant condition DIFFERS from the subject's read condition
 * (technician-ownership spec, Part C).
 *
 * `canAccessRow` above answers one question - "can you see this row" - and every controller used
 * it for every verb, which was correct only while a role's write conditions matched its read
 * condition. They no longer do: TECHNICIAN reads a job it is assigned to OR created, but may only
 * delete / assign / unassign / manage the lines of one it CREATED. Asking the read fragment for a
 * delete decision hands the whole creator surface to every assignee.
 *
 *   if (!(await canActOnRow(req, 'Job', prisma.job, id, 'delete'))) { … 403 … }
 *
 * INTERSECTION, not substitution: the row must satisfy the read scope AND the verb's own scope.
 * Both halves matter - the read half keeps a row the requester cannot even see out of reach, and
 * the verb half is the authority. Either being unconditional simply drops out of the AND.
 *
 * A role with no grant for `action` resolves to MATCH_NOTHING and is refused here, which is
 * belt-and-braces: `canDo(action, subject)` on the route already rejected it. ADMIN short-circuits
 * on both halves, exactly as it does in `canAccessRow`.
 *
 * ⚠️ Inherits `canAccessRow`'s caveat: on the all-unconditional fast path this returns true WITHOUT
 * QUERYING, so it is NOT a tenancy check. Spread `tenantWhere(req)` into your own where clause.
 */
export async function canActOnRow(
  req: Request,
  subjectName: ScopeResource,
  delegate: RowDelegate,
  id: string,
  action: string,
): Promise<boolean> {
  if (!req.user) return false;
  const fragments = [
    await scopeWhereForReq(req, subjectName),
    await actionScopeWhereForReq(req, subjectName, action),
  ].filter((f) => Object.keys(f).length > 0);
  if (fragments.length === 0) return true;
  const where = { id, ...tenantWhere(req), AND: fragments };
  return !!(await delegate.findFirst({ where, select: { id: true } }));
}

/**
 * Per-anchor create check for a subject that does not exist yet (#2042 / spec §3): the caller's
 * OWN row does not exist to intersect against, so the authority fragment for `action` is applied
 * to the CANDIDATE ANCHOR instead - "would this row, if it existed with this anchor, satisfy the
 * caller's condition?" - via `delegate`, the anchor's OWN Prisma model (e.g. `prisma.job` for a
 * LogisticOrder anchored by `job_id`), not the subject being created.
 *
 * Steps (spec §3, exact):
 *   1. `fragment = actionScopeWhereForReq(req, subject, action)`.
 *   2. Empty fragment (unconditional caller, e.g. ADMIN/DISPATCHER) -> `true`, unchanged behaviour.
 *   3. No `anchorId` -> `false` - a conditioned caller has nothing to satisfy the condition with.
 *   4. `fragment[relation]` missing (the condition is shaped on some other relation path) ->
 *      `false`, fail-closed.
 *   5. Otherwise resolve `anchorId` against `delegate` under `tenantWhere(req)` AND the condition
 *      nested at `fragment[relation]`.
 *
 * R1 (spec §6): step 5 probes with `delegate.count(...) > 0`, NOT `findFirst`. The frozen test
 * (`repro-2042.test.ts`) stubs the job delegate's `findFirst` PERMISSIVELY (`Promise.resolve({ id:
 * where.id })` for ANY `where`), so a `findFirst`-based probe would silently short-circuit the
 * refusal it is meant to prove. That file never stubs `count`, so a `count`-based probe is not
 * short-circuited by it - it genuinely exercises the caller's condition. The two probes are
 * otherwise identical SQL semantics (both a bounded existence check under the same `where`).
 *
 * ⚠️ Same caveat as `canAccessRow`/`canActOnRow`: an unconditional caller returns `true` WITHOUT
 * querying at all, so this is not itself a tenancy or existence check on the anchor - the caller
 * still needs its own in-org anchor validation afterwards (e.g. `assertAnchorsInOrg`).
 */
export async function canCreateOnAnchor(
  req: Request,
  subject: ScopeResource,
  action: string,
  relation: string,
  delegate: RowDelegate,
  anchorId: string | null | undefined,
): Promise<boolean> {
  if (!req.user) return false;
  const fragment = await actionScopeWhereForReq(req, subject, action);
  if (Object.keys(fragment).length === 0) return true; // unconditional caller - unchanged behaviour
  if (!anchorId) return false; // conditioned caller, nothing to satisfy the condition with
  const relationCondition = (fragment as Record<string, unknown>)[relation];
  if (relationCondition === undefined) return false; // condition shaped on a different path - fail-closed
  const where = { id: anchorId, ...tenantWhere(req), ...(relationCondition as Record<string, unknown>) };
  return (await delegate.count({ where })) > 0;
}

/**
 * The AUTHORITY fragment for one verb - `scopeWhereForReq`'s sibling for a non-`read` action.
 *
 * Same union rules, same fail-closed behaviour and the same per-user override path, except that an
 * ALLOW override synthesizes the capability under ITS OWN action rather than the paired read
 * (`overrideReadGrants` does the read half). So a user handed "Edit own job line items" as a
 * per-user toggle resolves to that capability's own-condition here, exactly as `defineAbility`
 * materializes it into the CASL ability - the SQL scope and the ability stay in agreement.
 *
 * Deliberately NOT exported: `canActOnRow` is the only correct consumer, because an authority
 * fragment on its own is not a visibility check.
 */
async function actionScopeWhereForReq(
  req: Request,
  resource: ScopeResource,
  action: string,
): Promise<Record<string, unknown>> {
  if (!req.user) return { ...MATCH_NOTHING };
  if (req.user.role === 'ADMIN') return {};
  const roleGrants = await grantsForReq(req);
  const overrides = await loadUserOverrides(req.user.id);
  const grants = [...roleGrants, ...overrideActionGrants(overrides, req.user.role, action)];
  return scopeWhereFor(
    {
      id: req.user.id,
      role: req.user.role,
      department_id: req.user.department_id ?? null,
      location_id: req.user.location_id ?? null,
    },
    resource,
    grants,
    action,
  );
}

/**
 * The per-user ALLOW overrides for ONE action, expressed as grants under that action - the
 * write-side mirror of `overrideReadGrants`. Same role allow-list filter and the same
 * own-condition source, so a capability's meaning is defined in exactly one place
 * (userCapabilities.ts) no matter which layer asks. DENY overrides synthesize nothing: they block
 * through CASL's `cannot`, and the route guard runs before any of this.
 */
function overrideActionGrants(
  overrides: { action: string; subject: string; effect: 'allow' | 'deny' }[],
  role: string,
  action: string,
): Grant[] {
  const out: Grant[] = [];
  for (const ov of overrides) {
    if (ov.effect !== 'allow' || ov.action !== action) continue;
    const cap = getManagedCapability(ov.action, ov.subject);
    if (!cap || !capabilityAllowsRole(cap, role)) continue;
    out.push({ action: ov.action, subject: ov.subject, conditions: cap.ownCondition });
  }
  return out;
}

/**
 * Pricing visibility predicate (Phase B §E, repointed by SRVW-140).
 *
 * Pricing - estimate/invoice money, job-line unit_cost/markup_percent, price-book and inventory
 * cost/list price, the org labor rate and overhead model, scope internal_cost - is visible to a
 * requester holding the dedicated `read Pricing` grant. That grant has exactly ONE writer: the
 * Roles UI "See financial data" switch (SENSITIVE.seeFinancials in roleViewModel.ts). ADMIN still
 * passes via manage-all.
 *
 * It used to key on `read Invoice`, which is a DIFFERENT control (the Invoices "View" cell in the
 * CRUD matrix) and a different question - "may this user open an invoice RECORD". The two came
 * apart in practice: SALES held `read Invoice` and no `read Report`, so the switch rendered OFF in
 * every org while Sales saw every cost, and granting a technician a per-user Invoice capability
 * (create/send/update/record_payment, all impliesRead) silently unlocked org-wide cost data. A
 * per-user Invoice capability NO LONGER confers pricing; an admin's remedy is the switch.
 *
 * The 11 non-test consumers, so the next reader does not have to grep:
 *   price-book.controller.ts        (stripItemCost: unit_cost/list_price)
 *   inv-catalog.controller.ts       (stripMappedItemCost: unitCost/listPrice)
 *   inv-stock.controller.ts         (movement unit_cost)
 *   organization.controller.ts      (labor_rate/overhead_mode/overhead_value select merge)
 *   job.controller.ts               (job-detail strip, timeline money redaction,
 *                                    stripFinancialsForRequester, cancel-response money)
 *   job-lines.controller.ts         (line unit_cost/markup_percent/unit_price/line_total, billing)
 *   estimate.controller.ts          (stripEstimateCost)
 *   estimate-lines.controller.ts    (line + scope internal_cost)
 *   invoice.controller.ts           (stripInvoiceCost on every detail-shaped response)
 *   invoice-lines.controller.ts     (line + scope cost on the manage_lines routes)
 *   report.controller.ts            (inventory-usage cost / unpricedUnits)
 */
export function canSeePricing(req: Request): boolean {
  return !!req.ability?.can('read', 'Pricing' as Subject);
}
