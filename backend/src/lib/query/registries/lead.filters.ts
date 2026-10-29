import { LeadStatus } from '@prisma/client';
import { equalsOrIn, relationSome, FacetDef } from '../filterEngine';
import { LIVE_VISIT_STATUSES } from '../../../services/walkthrough.service';
import { TERMINAL_LEAD_STATUSES } from '../../../services/lead-stage.service';
import { addAndClause } from '../../permissions/whereCompose';

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
        const validStatuses = values.filter((v) => Object.values(LeadStatus).includes(v as LeadStatus));
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
    // Visits slice 03: a CLOSED lead (WON/LOST/CANCELLED) holds no live visit either, but nobody
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
        where.visits = { ...existing, none: { status: { in: [...LIVE_VISIT_STATUSES] } } };
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
    {
      key: 'assigned_to',
      kind: 'multi',
      param: 'assigned_to',
      apply: (where, values) => {
        if (scopeWhere.lead_assignees !== undefined) return;
        if (values.length === 0) return;
        if (values.includes('UNASSIGNED')) {
          where.lead_assignees = { none: {} };
          return;
        }
        relationSome('lead_assignees', 'user_id')(where, values);
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
