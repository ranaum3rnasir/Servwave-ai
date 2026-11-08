/**
 * Which lead statuses a person may pick by hand, and why a locked one is locked (walkthrough
 * lead-statuses PRD sections 7.1 to 7.3).
 *
 * ONE source of truth. `GET /api/leads/:id` returns this list as `status_options`, the status menu
 * renders from it without copying a single rule, and `PATCH /api/leads/:id { status }` runs it
 * before writing anything, so no request can set a status that contradicts the lead's data. The
 * refusal text is the lock text, word for word, because it reaches the user through
 * `extractApiError`.
 */
import type { LeadStatus, Prisma, PrismaClient } from '@prisma/client';

import { LIVE_VISIT_STATUSES } from '../lib/visit-status';

/** The order the menu, the filters and the sort all use (PRD section 5). */
export const LEAD_STATUS_ORDER: readonly LeadStatus[] = [
  'NEW',
  'CONTACTED',
  'WALKTHROUGH_SCHEDULED',
  'WALKTHROUGH_COMPLETED',
  'ESTIMATED',
  'WON',
  'LOST',
  'CANCELLED',
] as const;

export interface LeadStatusFacts {
  /** The lead's status now. It is always offered as picked, never locked. */
  current: LeadStatus;
  /** Visits on the lead with a live status (scheduled, en route, on site, in progress). */
  openVisits: number;
  /** Visits on the lead with status COMPLETED. */
  finishedVisits: number;
  /** See `loadLeadStatusFacts` for the definition. */
  estimateSent: boolean;
}

export interface LeadStatusOption {
  status: LeadStatus;
  available: boolean;
  /** The hover text that says why the status is locked; null when it can be picked. */
  reason: string | null;
}

export const ESTIMATE_ALREADY_SENT_REASON =
  "An estimate was already sent to this lead, so it can't go back to this step.";

/** The status's own lock text, after the estimate rule. PRD section 7.2. */
const PAST_NEW = "This lead already has a walkthrough or an estimate, so it's past New.";
const PAST_CONTACTED = "This lead already has a walkthrough or an estimate, so it's past Contacted.";
const NO_WALKTHROUGH_BOOKED = "There's no walkthrough booked on this lead right now.";
const WALKTHROUGH_STILL_BOOKED = 'A walkthrough visit is still booked on this lead.';
const NO_WALKTHROUGH_DONE = 'No walkthrough on this lead is done yet.';
const NO_ESTIMATE_SENT = 'No estimate has been sent to this lead yet.';

/** The statuses an estimate that went out rules out (PRD 7.2 rule 1). */
const BEFORE_ESTIMATE: readonly LeadStatus[] = ['NEW', 'CONTACTED', 'WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED'];

/** The lock reason for `status` given the facts, or null when it can be picked. */
function lockReason(status: LeadStatus, facts: LeadStatusFacts): string | null {
  const { openVisits, finishedVisits, estimateSent } = facts;

  if (estimateSent && BEFORE_ESTIMATE.includes(status)) return ESTIMATE_ALREADY_SENT_REASON;

  switch (status) {
    case 'NEW':
      return openVisits + finishedVisits > 0 ? PAST_NEW : null;
    case 'CONTACTED':
      return openVisits + finishedVisits > 0 ? PAST_CONTACTED : null;
    case 'WALKTHROUGH_SCHEDULED':
      return openVisits === 0 ? NO_WALKTHROUGH_BOOKED : null;
    case 'WALKTHROUGH_COMPLETED':
      if (openVisits > 0) return WALKTHROUGH_STILL_BOOKED;
      return finishedVisits === 0 ? NO_WALKTHROUGH_DONE : null;
    case 'ESTIMATED':
      return estimateSent ? null : NO_ESTIMATE_SENT;
    // Won needs no estimate (D9); Lost and Cancelled ask for a reason instead (D11).
    default:
      return null;
  }
}

/** All eight statuses, in PRD section 5 order, each with `available` and the lock text. */
export function leadStatusOptions(facts: LeadStatusFacts): LeadStatusOption[] {
  return LEAD_STATUS_ORDER.map((status) => {
    // The status the lead is in is shown as the selected item, not as locked (PRD 7.1).
    const reason = status === facts.current ? null : lockReason(status, facts);
    return { status, available: reason === null, reason };
  });
}

/**
 * The estimate statuses that mean an estimate went out to the customer. DRAFT never did and
 * ARCHIVED is what closing a lead does to the open ones, so neither counts. SUPERSEDED counts only
 * when it was sent first (`sent_at` set), because a revision supersedes drafts too.
 */
const SENT_ESTIMATE_STATUSES = ['SENT', 'PENDING', 'WON', 'DECLINED', 'EXPIRED'] as const;

/** Read the facts for one lead. Takes a client or a transaction. */
export async function loadLeadStatusFacts(
  db: PrismaClient | Prisma.TransactionClient,
  lead: { id: string; organization_id: string; status: LeadStatus },
): Promise<LeadStatusFacts> {
  const where = { lead_id: lead.id, organization_id: lead.organization_id };
  const [openVisits, finishedVisits, sentEstimates] = await Promise.all([
    db.visit.count({ where: { ...where, purpose: 'WALKTHROUGH', status: { in: [...LIVE_VISIT_STATUSES] } } }),
    db.visit.count({ where: { ...where, purpose: 'WALKTHROUGH', status: 'COMPLETED' } }),
    db.estimate.count({
      where: {
        ...where,
        OR: [
          { status: { in: [...SENT_ESTIMATE_STATUSES] } },
          { status: 'SUPERSEDED', sent_at: { not: null } },
        ],
      },
    }),
  ]);
  return { current: lead.status, openVisits, finishedVisits, estimateSent: sentEstimates > 0 };
}
