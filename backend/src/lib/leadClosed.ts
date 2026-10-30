import type { Prisma } from '@prisma/client';
import { addAndClause } from './permissions/whereCompose';

/**
 * Which leads closed as Won or as Lost in a window (Roles & Permissions, PRD 9, Close Rate).
 *
 * This is the one place that says what "closed" means for a count of Won and Lost leads. The dashboard's Close Rate (and
 * the Smart Insights card that quotes it) and the Leads page's Won and Lost this month read it, so they cannot count
 * differently; the Leads report lists the same leads by the same status.
 *
 *  - A lead counts by its CURRENT status. A lead reopened from Won or Lost is open again and in neither count, even though
 *    its won or lost date stays on it; it counts again only when it closes again.
 *  - Every Lost lead counts, whatever its typed reason: spam and duplicates included.
 *  - A lead counts at the day it closed: `won_at` for a Won lead, `lost_at` for a Lost one. Lost leads that PRD 5's
 *    migration moved from Cancelled carry the day they were cancelled there, so an old cancelled lead lands in the
 *    window it was cancelled in and not in the one the release happened in. `updated_at` (any edit moves it) is the
 *    date only for a lead closed before the close date was recorded, which has none.
 *  - Walkthrough Scheduled, Walkthrough Completed and every other open status never count.
 */
export type LeadOutcome = 'WON' | 'LOST';

/** The window a close date falls in. The edges follow Prisma's DateTime filter: `gte` / `gt` from, `lt` / `lte` to. */
export interface ClosedWindow {
  gte?: Date;
  lt?: Date;
}

const CLOSE_DATE: Record<LeadOutcome, 'won_at' | 'lost_at'> = { WON: 'won_at', LOST: 'lost_at' };

/** One outcome closed in the window: the status, and the day it closed on. */
function closedAsIn(outcome: LeadOutcome, window: ClosedWindow): Prisma.LeadWhereInput {
  const closedOn = CLOSE_DATE[outcome];
  return { status: outcome, OR: [{ [closedOn]: window }, { [closedOn]: null, updated_at: window }] };
}

/**
 * The `where` for the leads that closed in a window, over a row scope: the company, narrowed to the leads that scope
 * reaches. Pass an outcome for Won only or Lost only; leave it out for both. The date test goes under `AND` because a
 * row scope may carry an `OR` of its own.
 */
export function leadClosedWhereIn(
  org: { organization_id: string },
  scope: Record<string, unknown>,
  window: ClosedWindow,
  outcome?: LeadOutcome,
): Prisma.LeadWhereInput {
  const outcomes: LeadOutcome[] = outcome ? [outcome] : ['WON', 'LOST'];
  const where: Record<string, unknown> = { ...org, ...scope, status: outcome ?? { in: outcomes } };
  addAndClause(where, { OR: outcomes.map((o) => closedAsIn(o, window)) });
  return where as Prisma.LeadWhereInput;
}
