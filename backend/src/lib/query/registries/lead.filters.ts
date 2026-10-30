import { LeadStatus } from '@prisma/client';
import { equalsOrIn, relationSome, FacetDef } from '../filterEngine';
import { LIVE_VISIT_STATUSES } from '../../../services/walkthrough.service';
import { TERMINAL_LEAD_STATUSES } from '../../../services/lead-stage.service';
import { addAndClause } from '../../permissions/whereCompose';
import { MISSING_LEAD_OWNER_WHERE } from '../../missingLeadOwner';

/** The Owner filter's "No owner" choice, and the value it went by before the rename. */
const NO_OWNER = 'NO_OWNER';
const LEGACY_NO_OWNER = 'UNASSIGNED';
/** The lead status that no longer exists; a filter that still names it means Lost. */
const RETIRED_CANCELLED = 'CANCELLED';
/** The Dispatcher filter's "No dispatcher" choice. */
const NO_DISPATCHER = 'NO_DISPATCHER';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Lead list facet registry (Task 4 — first entity wired to the shared filter
 * engine). Exported as a FUNCTION of `scopeWhere`, not a static array, solely
 * because of the `assigned_to` facet below — see its comment for why.
 *
 * `param` names here are the wire contract the frontend registry (Task 9)
 * must match.
 */
export function leadFacets(scopeWhere: Record<string, unknown>): FacetDef[] {
  return [
    // `status` is a strict Prisma enum column: passing an invalid literal
    // through `{ in: [...] }` unguarded throws a Prisma validation error
    // (500) instead of the desired "silently ignore garbage" behavior.
    {
      key: 'status',
      kind: 'multi',
      param: 'status',
      apply: (where, values) => {
        // A saved link or bookmark from before Cancelled was retired for leads (S05.18) reads as Lost: every lead that was
        // Cancelled is Lost now. Said once even when both are asked for.
        const asked = values.map((v) => (v === RETIRED_CANCELLED ? LeadStatus.LOST : v));
        const validStatuses = [...new Set(asked)].filter((v) => Object.values(LeadStatus).includes(v as LeadStatus));
        equalsOrIn('status')(where, validStatuses);
      },
    },
    // Plain direct Lead column — the shared engine's equalsOrIn is correct as-is.
    { key: 'job_type', kind: 'multi', param: 'job_type', apply: equalsOrIn('job_type') },
    // ad_source lives on the Customer relation, NOT a direct Lead column.
    // Merges into any existing `where.customer` rather than overwriting it
    // (defensive — nothing else currently sets `where.customer`, but this
    // mirrors relationSome's merge-safety pattern in case that changes).
    {
      key: 'ad_source',
      kind: 'multi',
      param: 'ad_source',
      apply: (where, values) => {
        if (values.length === 0) return;
        where.customer = {
          ...((where.customer as Record<string, unknown> | undefined) ?? {}),
          ad_source: values.length === 1 ? values[0] : { in: values },
        };
      },
    },
    // Synthetic/derived facet — NOT a real column. Today the only valid value in the system is
    // 'needs_scheduling' (confirmed via grep of both this controller and the frontend's
    // WALKTHROUGH_FILTERS list).
    //
    // S04.10: a live visit with people on it and NO time ("To be scheduled", S03.19) is a walkthrough that still
    // needs a time, so it does not take its lead out of the bucket: the bucket is the absence of a live visit
    // that has a time, and the lead's card carries that visit's crew.
    //
    // Multi-visit D22a: the bucket is the ABSENCE of a live visit, not the presence of a
    // REQUESTED placeholder. REQUESTED described a lead that NEEDS a visit, which is not a state
    // of a visit at all, and it cannot survive multi-visit - with several live visits per lead
    // there is no single row for the placeholder to be. No lead status is involved either way,
    // which is what structurally deletes the originally-reported bug (the three previously
    // divergent "needs scheduling" definitions collapse to this one).
    //
    // SECURITY: `where.visits` may ALREADY carry a TECHNICIAN's OWN_WALKTHROUGH row-scope
    // (defaultGrants.ts) as a `some` clause. The `none` condition is spread ALONGSIDE whatever is
    // there rather than replacing the key: Prisma ANDs `some` and `none` on the same relation, so
    // the row-scope survives. Overwriting `where.visits` outright would drop it - an RBAC bypass,
    // which is the same hazard buildLeadListWhere's date window avoids by composing under AND.
    //
    // Visits slice 03: a CLOSED lead (WON/LOST) holds no live visit either, but nobody
    // is going to schedule it - it filled the scheduler's Unscheduled bucket and the leads list's
    // "Needs Scheduling" filter with finished work. The exclusion is APPENDED to `where.AND`, never
    // written onto `where.status`: the `status` facet above may already hold an explicit choice
    // there, and row-scope/search clauses compose under AND too, so neither may be overwritten.
    {
      key: 'walkthrough_status',
      kind: 'multi',
      param: 'walkthrough_status',
      apply: (where, values) => {
        if (!values.includes('needs_scheduling')) return;
        const existing = (where.visits as Record<string, unknown> | undefined) ?? {};
        where.visits = { ...existing, none: { status: { in: [...LIVE_VISIT_STATUSES] }, scheduled_at: { not: null } } };
        addAndClause(where, { status: { notIn: [...TERMINAL_LEAD_STATUSES] } });
      },
    },
    // SECURITY-CRITICAL: `scopeWhereForReq(req, 'Lead')` already narrows
    // `where.lead_assignees` for row-scoped roles (e.g. SALES/TECHNICIAN, who
    // may only see their OWN assigned leads). If this facet applied
    // unconditionally, a row-scoped user could pass `?assigned_to=<someone-
    // else>` and have the filter engine SET `where.lead_assignees` to
    // something that widens or replaces their row-scope restriction — an
    // RBAC bypass / cross-user data leak. Must be a no-op whenever
    // `scopeWhere.lead_assignees` is already defined, exactly as the
    // pre-engine hand-rolled code enforced. This is why `leadFacets` is a
    // function of `scopeWhere` rather than a static array: it lets this
    // `apply` closure see the per-request scope without any change to the
    // shared `filterEngine.ts` (which has no concept of scopeWhere at all).
    //
    // "No owner" is the Missing lead owner predicate (lib/missingLeadOwner.ts), so the option and the
    // Leads page's card return the same leads. It is composed under AND and writes no key the row-scope
    // may own, so it narrows a viewer's scope and can never widen it, which is why only the choice of
    // WHICH owners (the part that writes `lead_assignees`) is held back for a scope that owns that key.
    // `UNASSIGNED` is the value saved views and bookmarks from before the rename carry; it means the same.
    {
      key: 'assigned_to',
      kind: 'multi',
      param: 'assigned_to',
      apply: (where, values) => {
        const noOwner = values.some((v) => v === NO_OWNER || v === LEGACY_NO_OWNER);
        const owners = values.filter((v) => v !== NO_OWNER && v !== LEGACY_NO_OWNER);
        const ownedBy: Record<string, unknown> | null =
          owners.length > 0 && scopeWhere.lead_assignees === undefined
            ? { lead_assignees: { some: { user_id: owners.length === 1 ? owners[0] : { in: owners } } } }
            : null;
        if (noOwner && ownedBy) {
          addAndClause(where, { OR: [MISSING_LEAD_OWNER_WHERE as Record<string, unknown>, ownedBy] });
        } else if (noOwner) {
          addAndClause(where, MISSING_LEAD_OWNER_WHERE as Record<string, unknown>);
        } else if (ownedBy) {
          relationSome('lead_assignees', 'user_id')(where, owners);
        }
      },
    },
    // The lead's Dispatcher: a person, or `NO_DISPATCHER` for a lead with none. A direct column, composed
    // under AND like the owner choice so it can only narrow what the row-scope already allows. A value that
    // is not a person is dropped, as the other id facets do, instead of reaching the database.
    {
      key: 'dispatcher',
      kind: 'multi',
      param: 'dispatcher',
      apply: (where, values) => {
        const people = values.filter((v) => UUID_PATTERN.test(v));
        const none = values.includes(NO_DISPATCHER);
        const choices: Record<string, unknown>[] = [
          ...(people.length > 0 ? [{ dispatcher_id: { in: people } }] : []),
          ...(none ? [{ dispatcher_id: null }] : []),
        ];
        if (choices.length === 0) return;
        addAndClause(where, choices.length === 1 ? choices[0]! : { OR: choices });
      },
    },
    // Plain direct Lead column, scalar today — made array-capable per the audit.
    { key: 'customer_id', kind: 'multi', param: 'customer_id', apply: equalsOrIn('customer_id') },
    { key: 'created', kind: 'dateRange', afterParam: 'created_after', beforeParam: 'created_before', column: 'created_at' },
    { key: 'estimates', kind: 'countRange', minParam: 'estimates_min', maxParam: 'estimates_max', countOn: { model: 'estimate', groupField: 'lead_id' } },
    // SRVW-58. Deliberately NOT `relationSome('lead_tags', 'tag_id')`: that legacy
    // LeadTag join is the only real Prisma tag relation on Lead, so it compiles - but
    // nothing writes it any more (report.controller.ts is its last reader) and it holds
    // zero rows, so the filter would silently narrow to nothing off dead data. Live tags
    // are polymorphic TagAssignment rows, which the `tags` facet kind resolves.
    { key: 'tags', kind: 'tags', param: 'tags', entityType: 'LEAD' },
  ];
}
