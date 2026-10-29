import { JobStatus } from '@prisma/client';
import { equalsOrIn, FacetDef } from '../filterEngine';

/**
 * Job list facet registry (Task 10). Exported as a plain static array, NOT a
 * function of scopeWhere — unlike Leads (lead.filters.ts) — because none of
 * these facets are scope-sensitive.
 *
 * The crew filters (`assigned_to` / `department_id`) are deliberately NOT
 * here. They target the same `assignees` relation that
 * `scopeWhereForReq(req, 'Job')` uses to enforce row-scope (e.g. a
 * TECHNICIAN's OWN_JOB read grant sets `where.assignees.some.user_id =
 * <self>`). Routing them through the generic `relationSome` helper would
 * merge attacker-supplied query values into that SAME `.some` clause,
 * OVERWRITING `user_id: <self>` — an RBAC bypass / cross-user data leak. The
 * pre-existing hand-rolled code in `buildJobListWhere`
 * (job.controller.ts) already composes them safely (AND-append a SEPARATE
 * `{ assignees: { some: ... } }` clause whenever a role-scoped
 * `where.assignees` already exists); Task 10 keeps that block, hand-rolled,
 * in the controller — only made array-capable — rather than porting it into
 * this registry. This mirrors how Leads kept its scope-sensitive
 * `assigned_to` facet out of the shared engine's blind spot via a
 * `leadFacets(scopeWhere)` factory; Jobs' safest equivalent is simply not
 * making it a facet at all.
 *
 * `param` names here are the wire contract the frontend registry (Task 11)
 * must match.
 */
export const jobFacets: FacetDef[] = [
  // `status` is a strict Prisma enum column: passing an invalid literal through
  // `{ in: [...] }` unguarded throws a Prisma validation error (500) instead of the
  // desired "silently ignore garbage" behavior — mirrors leadFacets' `status` facet.
  {
    key: 'status',
    kind: 'multi',
    param: 'status',
    apply: (where, values) => {
      const validStatuses = values.filter((v) => Object.values(JobStatus).includes(v as JobStatus));
      equalsOrIn('status')(where, validStatuses);
    },
  },
  // Plain direct Job column, scalar today — made array-capable per the audit.
  { key: 'customer_id', kind: 'multi', param: 'customer_id', apply: equalsOrIn('customer_id') },
  // WP2 (job sub-statuses filter axis) — sub_status_id is a plain scalar column on Job
  // (unlike assigned_to/department_id, it does not touch the assignees relation), so it
  // carries none of the RBAC hazard documented above for the crew filters.
  { key: 'sub_status_id', kind: 'multi', param: 'sub_status_id', apply: equalsOrIn('sub_status_id') },
  // Multi-visit S6: `scheduled_after`/`scheduled_before` are NOT a facet any more. They ask a
  // question about the job's VISIT set ("does this job have a trip in this window?"), not about
  // the `Job.scheduled_start` mirror, which by D14 only ever holds the NEXT upcoming visit - so a
  // job whose second trip lands in the window was invisible to the board. The window is
  // hand-rolled in `buildJobListWhere` (job.controller.ts) alongside the crew filters, for the
  // same clobber-safety reason those are hand-rolled: it has to compose under AND, never assign
  // `where.visits`, because S8 repoints the stored OWN_JOB row scope at that same relation path.
  // Not present in the pre-Task-10 hand-rolled code; added to match the Leads convention
  // (created_after/created_before -> created_at). The Job model has a created_at column, so
  // this is a safe, additive facet.
  { key: 'created', kind: 'dateRange', afterParam: 'created_after', beforeParam: 'created_before', column: 'created_at' },
  // SRVW-58 - polymorphic TagAssignment rows resolved to job ids by the shared `tags`
  // facet kind; TagAssignment has no Prisma back-relation to Job, so this cannot be a
  // relationSome.
  { key: 'tags', kind: 'tags', param: 'tags', entityType: 'JOB' },
];
