/**
 * lead-reopen.service.ts - where a reopened lead lands (Roles & Permissions, PRD 5, S05.19).
 *
 * Reopen lead brings a Won or Lost lead back. The status it comes back to is the one it had just before it closed:
 *
 *   1. The lead's status ledger (the `STATUS_CHANGE` rows `transitionLeadStatus` writes, each with a `from` and a `to`)
 *      is read newest first, and the most recent row into the lead's current closed status gives the `from`.
 *   2. When that `from` is itself a closed status, the row is a closed-to-closed one: the migration that retired the
 *      Cancelled lead status wrote one (Cancelled to Lost) 1 ms after the lead's last row, and a Won lead marked Lost
 *      by the old status menu left a Won-to-Lost one. The search goes on past it, to the older row INTO that closed
 *      status, and takes its `from`; and so on until a status that is open turns up.
 *   3. If the lead's data still supports that status (the status menu's own data rule, asked as if the lead were open),
 *      the lead goes there.
 *   4. Otherwise, and when no row is found, the furthest status the data supports: Estimate Sent, else Walkthrough
 *      Scheduled, else Walkthrough Completed, else Contacted.
 *
 * The ledger's `from` and `to` are read as TEXT, never cast to the Prisma enum: a migrated lead's row says 'CANCELLED',
 * a status the enum no longer has.
 */
import type { LeadStatus, Prisma, PrismaClient } from '@prisma/client';

import { dataLockReason, loadLeadStatusFacts, OPEN_LEAD_STATUSES, type LeadStatusFacts } from './lead-status-options';

type Db = PrismaClient | Prisma.TransactionClient;

/** The furthest status first. The last one is the floor: a lead that has been reached has been contacted. */
const FURTHEST_FIRST: readonly LeadStatus[] = ['ESTIMATED', 'WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED', 'CONTACTED'];

interface LedgerRow {
  from: string | null;
  to: string | null;
}

/** The ledger rows of one lead, newest first, with `from` and `to` as the text they were written as. */
async function statusLedger(db: Db, orgId: string, leadId: string): Promise<LedgerRow[]> {
  const rows = await db.timelineEvent.findMany({
    where: { organization_id: orgId, entity_type: 'LEAD', entity_id: leadId, event_type: 'STATUS_CHANGE' },
    select: { metadata: true },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
  });
  return rows.map(({ metadata }) => {
    const m = (metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}) as Record<string, unknown>;
    return {
      from: typeof m.from === 'string' ? m.from : null,
      to: typeof m.to === 'string' ? m.to : null,
    };
  });
}

const isOpen = (status: string | null): status is LeadStatus => OPEN_LEAD_STATUSES.includes(status as LeadStatus);

/**
 * The open status the lead had before it closed, read from the ledger, or null when no row says. `closedStatus` is the
 * closed status the lead holds now.
 */
export function statusBeforeClose(ledger: readonly LedgerRow[], closedStatus: string): LeadStatus | null {
  let into = closedStatus;
  let searchFrom = 0;
  // Each pass moves one row further back, so it ends when the ledger does.
  while (searchFrom < ledger.length) {
    const at = ledger.findIndex((row, i) => i >= searchFrom && row.to === into);
    if (at === -1) return null;
    const before = ledger[at]!.from;
    if (isOpen(before)) return before;
    if (!before) return null;
    into = before;
    searchFrom = at + 1;
  }
  return null;
}

/** Where the lead lands, given the status it had before it closed (if the ledger knows) and what its data says. */
export function reopenLandingStatus(before: LeadStatus | null, facts: LeadStatusFacts): LeadStatus {
  if (before && dataLockReason(before, facts) === null) return before;
  return FURTHEST_FIRST.find((status) => dataLockReason(status, facts) === null) ?? 'CONTACTED';
}

/** Read the lead's ledger and data, and say which status Reopen puts it on. */
export async function reopenTarget(db: Db, lead: { id: string; organization_id: string; status: LeadStatus }): Promise<LeadStatus> {
  const [ledger, facts] = await Promise.all([
    statusLedger(db, lead.organization_id, lead.id),
    loadLeadStatusFacts(db, lead),
  ]);
  return reopenLandingStatus(statusBeforeClose(ledger, lead.status), facts);
}
