import type { Request } from 'express';
import { subject } from '@casl/ability';
import { prisma } from '../prisma';
import { tenantWhere } from '../tenant';
import type { Action, Subject } from './catalog';
import { defineAbilityFor, type AppAbility, type Grant } from './defineAbility';
import { scopeWhereFor, MATCH_NOTHING, type ScopeResource } from './scopeWhereFor';
import { isSuperUser } from './effectiveRole';
import { grantsForPerson } from './switches/store';
import { noteRowRefusal } from './refusalNote';

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
  /** The Admin flag (P15): the only thing that makes a person an Admin. */
  is_admin: boolean;
  organization_id: string;
  custom_role_id?: string | null;
  custom_role?: { key: string } | null;
  department_id?: string | null;
  location_id?: string | null;
}

/**
 * Resolve the person's grants the SAME way `attachAbility` does: what their switches compile into, plus the fixed
 * reads every signed-in person holds (see `grantsForPerson`). The role-permission and per-person override tables are
 * not read. Kept here so a list handler can derive its row-scope without the raw grants being plumbed onto `req`.
 * The Admin box short-circuits with no DB read.
 */
async function grantsForUser(user: PermissionUser): Promise<Grant[]> {
  return grantsForPerson(user);
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
  return defineAbilityFor(user, await grantsForUser(user));
}

/**
 * Controller-facing wrapper over the pure `scopeWhereFor`: the grant-driven
 * Prisma `where` fragment for the requesting user's row-scope on a resource.
 * Built from the same grants as the CASL ability, so the SQL scope and the ability agree. Spread it into the
 * list `where` alongside `tenantWhere(req)`:
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
 * behaviour. Split out so a batched check can ask the row-scope
 * question about an arbitrary user without fabricating a Request.
 */
export async function scopeWhereForUser(
  user: PermissionUser,
  resource: ScopeResource,
): Promise<Record<string, unknown>> {
  // SRVW-138: only an unrestricted ADMIN is unscoped; an ADMIN-derived custom role
  // resolves through its grants like any other role.
  if (isSuperUser(user)) return {};
  return scopeTemplateForProfile(user, resource, user.id);
}

/**
 * `scopeWhereForUser` with `{{userId}}` left as a caller-supplied PLACEHOLDER instead of a real id.
 *
 * The transpose of the usual question. `scopeWhereForUser` asks "one reader, which rows?"; a caller
 * asking "one row, which of these readers?" would derive the same fragment once per candidate, and
 * every derivation but the substitution is identical for everyone who shares a permission profile
 * (super-user-ness, switch values, department, location). Deriving the
 * template once per PROFILE and substituting afterwards is what removes the per-candidate work.
 *
 * Same body as the per-user path - `scopeWhereForUser` delegates to it - so the two cannot drift.
 */
export async function scopeTemplateForProfile(
  user: PermissionUser,
  resource: ScopeResource,
  placeholderUserId: string,
): Promise<Record<string, unknown>> {
  if (isSuperUser(user)) return {};
  const grants = await grantsForUser(user);
  return scopeWhereFor(
    {
      id: placeholderUserId,
      role: user.role,
      is_admin: user.is_admin,
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
  const reached = !!(await delegate.findFirst({ where, select: { id: true } }));
  if (!reached) noteRowRefusal(req, subjectName, id, null, () => rowExists(req, delegate, id));
  return reached;
}

/** Does the record exist in the person's company at all? Asked only to tell a hidden row from one that is not there. */
async function rowExists(req: Request, delegate: RowDelegate, id: string): Promise<boolean> {
  return !!(await delegate.findFirst({ where: { id, ...tenantWhere(req) }, select: { id: true } }));
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
  const allowed = !!(await delegate.findFirst({ where, select: { id: true } }));
  if (!allowed) noteRowRefusal(req, subjectName, id, action, () => rowExists(req, delegate, id));
  return allowed;
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
 * Same union rules and the same fail-closed behaviour, over the person's grants for that action, so the SQL
 * scope and the CASL ability stay in agreement.
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
  // Only the Admin box is unscoped; a custom role copied from Admin is held to its switches like any other.
  if (isSuperUser(req.user)) return {};
  const grants = await grantsForReq(req);
  return scopeWhereFor(
    {
      id: req.user.id,
      role: req.user.role,
      is_admin: req.user.is_admin,
      department_id: req.user.department_id ?? null,
      location_id: req.user.location_id ?? null,
    },
    resource,
    grants,
    action,
  );
}

/**
 * Cost visibility predicate (S01.15; first the "Pricing" predicate of Phase B §E, repointed by SRVW-140).
 *
 * COSTS - estimate/invoice/job line unit_cost and markup_percent, the labor_hours/overhead cost model on
 * estimates, invoices and jobs, scope internal_cost, the org labor rate and overhead, price-book and
 * inventory cost, movement cost, purchase-order line cost and the vendor account number - are visible to
 * a requester holding the dedicated `read Pricing` grant. That grant has exactly ONE writer: the
 * "See costs" switch (`see_costs` in switches/catalog.ts). ADMIN still passes via manage-all.
 *
 * It covers costs ONLY (P11, the second of the three money classes). A price (line unit_price and line_total, totals, tax,
 * balance, deposit, the price book's list and sell price, a scope's flat price) is the first class and follows See prices
 * (`canSeePrices`), which this switch needs on: a person cannot hold costs without prices.
 *
 * It used to key on `read Invoice`, a DIFFERENT control ("may this user open an invoice RECORD"). The two
 * came apart in practice. Opening invoices confers no cost visibility; an admin's remedy is the switch.
 *
 * The non-test consumers, so the next reader does not have to grep:
 *   price-book.controller.ts        (stripItemCost: unit_cost)
 *   inv-catalog.controller.ts       (stripMappedItemCost: unitCost)
 *   inv-stock.controller.ts         (movement unit_cost)
 *   inv-po.controller.ts            (PO line cost, low-stock proposal cost, job material cost)
 *   inv-vendors.controller.ts       (vendor account number)
 *   organization.controller.ts      (labor_rate/overhead_mode/overhead_value select merge)
 *   job.controller.ts               (job-detail cost model, cost-model write guard)
 *   job-lines.controller.ts         (line unit_cost/markup_percent, scope internal_cost)
 *   estimate.controller.ts          (stripEstimateCost, cost-model write guard)
 *   estimate-lines.controller.ts    (line + scope internal_cost)
 *   invoice.controller.ts           (stripInvoiceCost on every detail-shaped response, cost-model write guard)
 *   invoice-lines.controller.ts     (line + scope cost on the manage_lines routes)
 *   report.controller.ts            (inventory-usage cost / unpricedUnits; the jobs report's profit and cost keys)
 */
export function canSeeCosts(req: Request): boolean {
  return !!req.ability?.can('read', 'Pricing' as Subject);
}

/**
 * Price visibility predicate (P11, the root of the three money classes): may this requester see a price - a line's unit
 * price and total, a subtotal, a document total, tax, a discount, a balance, a deposit, a payment amount, the price
 * book's sell price, and every customer-level figure built from them?
 *
 * It reads only the requester's own switches: the `read Prices` grant the "See prices" switch (`see_prices` in
 * switches/catalog.ts) compiles into, which is that switch's one writer. ADMIN passes via manage-all. Nothing else
 * counts: not a role's name, not View on the record, not who made the record. The omission itself is in prices.ts, which
 * runs over every answer a signed-in person gets, so a new endpoint that carries a known price key is covered without
 * a call to this at its own site.
 */
export function canSeePrices(req: Request): boolean {
  return !!req.ability?.can('read', 'Prices' as Subject);
}

/**
 * Vendor-fields predicate (S07.18): may this requester see which vendor supplies what - the vendor name on a
 * stock item, the vendor id on a price book item, the default vendor id on a brand? It is View vendors ("read
 * Vendor"), the same switch that opens the Vendors page, so a role that holds View stock and View price book
 * but not View vendors gets neither. The key is left off the answer, never sent empty.
 */
export function canSeeVendors(req: Request): boolean {
  return !!req.ability?.can('read', 'Vendor');
}

/**
 * Company-figures predicate (S01.16): may this requester see company-wide money - dashboard money tiles, chart
 * amounts, revenue on the scoreboards, report totals, and (PRD 8) call and agent revenue. The activity feed is not
 * one of them: it names no figure in its words.
 *
 * It reads only the requester's own switches: the `read CompanyFigures` grant the "See company figures" switch
 * (`see_company_figures` in switches/catalog.ts) compiles into, which is that switch's one writer. ADMIN passes via
 * manage-all (the Admin box has no switches), so an admin always sees them. Nothing else counts: not a role's name,
 * not Reports access, not a Data Scope. A price on a record is the other class (`canSeePrices`), which this switch needs on,
 * and never goes through here. The redaction itself is in companyFigures.ts.
 *
 * The non-test consumers: dashboard.controller.ts (getDashboard), report.controller.ts (revenue, payment-fees,
 * estimate-conversion, ar-aging, activity) and estimate.controller.ts (getStats' pending deposits). PRD 8's call-revenue endpoints and PRD 9's dashboard tiles call this too.
 */
export function canSeeCompanyFigures(req: Request): boolean {
  return !!req.ability?.can('read', 'CompanyFigures' as Subject);
}

/**
 * Call-insights predicate (S08.13): may this requester see the sentiment and the "needs review" flag on a call, and the
 * scorecard metrics of a phone agent. It reads only the `see_call_insights` grant the "See call insights" switch compiles
 * into (ADMIN passes via manage-all), never a role's name. Who answered a call, the call score and the call details do not
 * go through here: everyone who can see a call keeps them. Call revenue and agent revenue are company figures and also
 * need `canSeeCompanyFigures`, whatever this returns.
 */
export function canSeeCallInsights(req: Request): boolean {
  return !!req.ability?.can('see_call_insights', 'Communication' as Subject);
}

/**
 * Phone numbers tab predicate (S08.15): may this requester see how a company number is routed (where it rings, which
 * call flow answers it)? It reads only the `phone_numbers_tab` grant the "Phone numbers tab" switch compiles into (ADMIN
 * passes via manage-all), never a role's name. The numbers list itself is not behind it: the number, its label, its type
 * and whether it can text stay with everyone who may see the number.
 */
export function canSeePhoneNumberRouting(req: Request): boolean {
  return !!req.ability?.can('phone_numbers_tab', 'Communication' as Subject);
}
