import type { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { scopeWhereForUser, type PermissionUser } from './permissions/enforce';
import { addAndClause } from './permissions/whereCompose';
import { OPEN_LEAD_STATUSES } from '../services/lead-status-options';

/**
 * The Missing lead owner predicate (Roles & Permissions, PRD 3).
 *
 * Open leads - New, Contacted, Walkthrough Scheduled, Walkthrough Completed or Estimate Sent - with
 * no Owner, whatever else is on them: a Dispatcher or a walkthrough crew is not an Owner. Won and Lost
 * leads are never counted; a lead reopened from Won or Lost is open again and counts again.
 * The Owner is the lead's one owner, stored as `commission_owner_id` and mirrored into one
 * `lead_assignees` row, so a lead has none only when neither is there.
 *
 * This is the one place that says what Missing lead owner means. The Leads page's "No owner" card, its
 * Owner filter's "No owner" option and its export read it today; the dashboard tile, the Needs Attention
 * item and the Open Leads line read it next. None of them may count it differently.
 *
 * The fragment names `lead_assignees`, which a row-scope may also use, so it is always composed under
 * `AND` (`withMissingLeadOwner`), never spread into a `where`.
 */
export const MISSING_LEAD_OWNER_WHERE: Prisma.LeadWhereInput = {
  status: { in: [...OPEN_LEAD_STATUSES] },
  commission_owner_id: null,
  lead_assignees: { none: {} },
};

/** Narrow a lead `where` (tenant and row-scope already in it) to the leads with no Owner. */
export function withMissingLeadOwner(where: Record<string, unknown>): Record<string, unknown> {
  const narrowed = { ...where };
  addAndClause(narrowed, MISSING_LEAD_OWNER_WHERE as Record<string, unknown>);
  return narrowed;
}

/**
 * The `where` for the Missing lead owner leads over a row scope: the company, narrowed to the leads that scope reaches.
 * The one builder every reading of the test goes through (the Leads page's card and stats, the dashboard's tile,
 * Needs Attention item and Open Leads line), so the four numbers are the same query and cannot disagree.
 */
export function missingLeadOwnerWhereIn(org: { organization_id: string }, scope: Record<string, unknown>): Prisma.LeadWhereInput {
  return withMissingLeadOwner({ ...org, ...scope }) as Prisma.LeadWhereInput;
}

/** The `where` for the viewer's Missing lead owner leads: only the leads they can open. */
export async function missingLeadOwnerWhere(viewer: PermissionUser): Promise<Prisma.LeadWhereInput> {
  return missingLeadOwnerWhereIn({ organization_id: viewer.organization_id }, await scopeWhereForUser(viewer, 'Lead'));
}

/** The viewer's Missing lead owner leads, oldest first. */
export async function findMissingLeadOwner(viewer: PermissionUser, opts: { take?: number } = {}) {
  return prisma.lead.findMany({
    where: await missingLeadOwnerWhere(viewer),
    select: { id: true, lead_number: true, created_at: true, customer_id: true },
    orderBy: { created_at: 'asc' },
    take: opts.take,
  });
}

/** How many Missing lead owner leads the viewer has. */
export async function countMissingLeadOwner(viewer: PermissionUser): Promise<number> {
  return prisma.lead.count({ where: await missingLeadOwnerWhere(viewer) });
}
