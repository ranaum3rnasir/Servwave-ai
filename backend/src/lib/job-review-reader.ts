import type { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { readJobMoneyOwed } from './job-money-owed';
import { fromCents } from './payment-ledger';
import { computeJobBilling } from './jobBilling';
import { asScopeArray, toScopeForTotals } from './scopes';
import { OPEN_VISIT_CANCEL_REASON } from './job-open-visits';
import {
  buildReviewChangeSet,
  reviewVersion,
  invoiceIdsNamedBy,
  mayShowInvoiceEntry,
  REVIEW_EVENT_TYPES,
  CLOSE_OUT_OWN_EVENT_TYPES,
  type ReviewChangeSet,
  type ReviewHistoryEntry,
  type ReviewJobDetails,
  type ReviewSummaryLine,
  type ReviewVisit,
} from './job-review-changeset';

/**
 * Reads what the office review panel shows for one job (Roles & Permissions, PRD 6, S06.8): the round, the job's
 * history since the round's window start, and the job's current details, then hands them to M8 to build the change-set.
 *
 * The caller has already opened the job for this person (existence in their company, the row scope, the Office review
 * switch). What the two money switches take out is decided here, once, before M8 sees anything:
 *  - `mayCosts` (See costs): unit and scope costs are not even read when it is off, so a cost cannot reach the
 *    answer by a missed strip. Prices are never withheld.
 *  - `openInvoices` (View invoices, with the person's invoice scope): told which of the named invoices the person can
 *    open. The job's invoices they cannot open, their payments and the history entries about them stay out, the same
 *    rule the job's activity feed follows. The job's own total and balance stay.
 *
 * The round's checks are read from their own table (S06.10) and handed to M8, which counts an item as checked only while
 * the check is against the item's latest history entry. The round's customer decisions (S06.11) are read from theirs the
 * same way and tick the customer items, which a plain check never does.
 */

export interface ReadReviewArgs {
  orgId: string;
  jobId: string;
  mayCosts: boolean;
  /**
   * Which of these invoice ids the person can open (lib/permissions/invoiceAccess.ts); asked once per read, on `db` when
   * the read runs inside a transaction (a second connection would wait for the one the transaction holds).
   */
  openInvoices: (invoiceIds: string[], db?: Prisma.TransactionClient) => Promise<ReadonlySet<string>>;
  /** The transaction to read inside, when the caller needs the answer to be the one its own write sees (Finish review). */
  db?: Prisma.TransactionClient;
}

export interface ReviewAnswer extends ReviewChangeSet {
  /** The round this answer is for; null when the job has no round row (a job moved into review before rounds existed). */
  round: { id: string; state: string; started_at: string; window_start: string } | null;
  /**
   * The review's version (M8 `reviewVersion`): the client sends it back with Finish review, and the server refuses a
   * review that has moved since. It is defined once, here, from the answer itself.
   */
  version: string;
}

const fullName = (p: { first_name: string; last_name: string } | null | undefined): string | null =>
  p ? `${p.first_name} ${p.last_name}`.trim() : null;

const numberOf = (v: unknown): number => Number(v ?? 0);

function addressOf(loc: { address_line1: string; address_line2: string | null; city: string; state: string; zip: string } | null): string | null {
  if (!loc) return null;
  const street = [loc.address_line1, loc.address_line2].filter(Boolean).join(' ');
  return `${street}, ${loc.city}, ${loc.state} ${loc.zip}`.trim();
}

export async function readJobReview(args: ReadReviewArgs): Promise<ReviewAnswer | null> {
  const { orgId, jobId, mayCosts, openInvoices } = args;
  const db = args.db ?? prisma;
  const job = await db.job.findFirst({
    where: { id: jobId, organization_id: orgId },
    select: {
      id: true,
      job_number: true,
      job_type: true,
      status: true,
      created_at: true,
      tax_rate: true,
      discount_amount: true,
      scopes: true,
      customer: { select: { first_name: true, last_name: true, company_name: true, tax_exempt: true } },
      service_location: { select: { address_line1: true, address_line2: true, city: true, state: true, zip: true } },
      job_line_items: {
        orderBy: { sequence: 'asc' },
        select: { description: true, quantity: true, unit_price: true, line_total: true, is_taxable: true, ...(mayCosts ? { unit_cost: true } : {}) },
      },
      visits: {
        orderBy: { visit_seq: 'asc' },
        select: {
          id: true, visit_seq: true, status: true, scheduled_at: true, cancelled_reason: true,
          assignees: { select: { user: { select: { first_name: true, last_name: true } } } },
        },
      },
    },
  });
  if (!job) return null;

  const round = await db.jobReview.findFirst({
    where: { organization_id: orgId, job_id: jobId },
    orderBy: { created_at: 'desc' },
    select: { id: true, state: true, started_at: true, window_start: true, finished_at: true },
  });
  const windowStart = round?.window_start ?? job.created_at;

  const [allEvents, latestChange, invoices, fileCount, noteCount, finishers, checkRows, decisionRows] = await Promise.all([
    db.timelineEvent.findMany({
      where: {
        organization_id: orgId,
        entity_type: 'JOB',
        entity_id: jobId,
        created_at: { gt: windowStart },
        event_type: { in: [...REVIEW_EVENT_TYPES] },
      },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      select: {
        id: true, event_type: true, description: true, metadata: true, created_at: true,
        creator: { select: { first_name: true, last_name: true } },
      },
    }),
    db.timelineEvent.findFirst({
      // The job summary is checked against the latest change to the job; the close-out's own entries are not one (below).
      where: { organization_id: orgId, entity_type: 'JOB', entity_id: jobId, event_type: { notIn: [...CLOSE_OUT_OWN_EVENT_TYPES] } },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      select: { id: true },
    }),
    db.invoice.findMany({
      where: { organization_id: orgId, job_id: jobId },
      orderBy: { invoice_number: 'asc' },
      select: {
        id: true, invoice_number: true, status: true, total_amount: true, amount_due: true, voided_at: true,
      },
    }),
    db.attachment.count({ where: { organization_id: orgId, entity_type: 'JOB', entity_id: jobId } }),
    db.note.count({ where: { organization_id: orgId, entity_type: 'JOB', entity_id: jobId } }),
    db.visitMilestoneLog.findMany({
      where: { organization_id: orgId, visit_id: { in: job.visits.map((v) => v.id) }, milestone: 'completed', kind: 'tapped' },
      orderBy: { occurred_at: 'desc' },
      select: { visit_id: true, actor: { select: { first_name: true, last_name: true } } },
    }),
    round
      ? db.jobReviewItemCheck.findMany({
          where: { organization_id: orgId, review_id: round.id },
          select: { item_key: true, entry_id: true, checked_at: true, checked_by: { select: { first_name: true, last_name: true } } },
        })
      : Promise.resolve([]),
    round
      ? db.jobReviewCustomerDecision.findMany({
          where: { organization_id: orgId, review_id: round.id },
          select: { entry_id: true, event_id: true, choice: true, decided_at: true, decided_by: { select: { first_name: true, last_name: true } } },
        })
      : Promise.resolve([]),
  ]);

  // A job whose whole history is the close-out's own entries (an imported one) has no change to check the summary against,
  // so it falls back to its FIRST entry of any kind: that one never moves (the finish adds entries after it), so the summary
  // can be checked and stays checked, and a real change after it still takes over and un-checks it.
  const latest = latestChange ?? await db.timelineEvent.findFirst({
    where: { organization_id: orgId, entity_type: 'JOB', entity_id: jobId },
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    select: { id: true },
  });

  // An entry about an invoice stays only when the person can open every invoice it names (a deposit applied names two).
  const named = new Set([...invoices.map((i) => i.id), ...allEvents.flatMap(invoiceIdsNamedBy)]);
  const openable = await openInvoices([...named], args.db);
  const events = allEvents.filter((e) => mayShowInvoiceEntry(e, openable));

  // A note added is recorded by id; the panel shows what it said.
  const noteIds = events
    .filter((e) => e.event_type === 'JOB_NOTE_ADDED')
    .map((e) => (e.metadata as { note_id?: string } | null)?.note_id)
    .filter((id): id is string => typeof id === 'string');
  const notes = noteIds.length
    ? await db.note.findMany({ where: { organization_id: orgId, id: { in: noteIds } }, select: { id: true, content: true } })
    : [];
  const noteText = new Map(notes.map((n) => [n.id, n.content]));

  const entries: ReviewHistoryEntry[] = events.map((e) => {
    const m = e.metadata && typeof e.metadata === 'object' && !Array.isArray(e.metadata) ? (e.metadata as Record<string, unknown>) : null;
    const withText = e.event_type === 'JOB_NOTE_ADDED' && m && typeof m.note_id === 'string' && noteText.has(m.note_id)
      ? { ...m, note_content: noteText.get(m.note_id) }
      : m;
    return {
      id: e.id,
      event_type: e.event_type,
      description: e.description,
      metadata: withText,
      created_at: e.created_at,
      actor_name: fullName(e.creator),
    };
  });

  const finishedBy = new Map<string, string | null>();
  for (const f of finishers) if (!finishedBy.has(f.visit_id)) finishedBy.set(f.visit_id, fullName(f.actor));

  const visits: ReviewVisit[] = job.visits.map((v) => ({
    seq: v.visit_seq,
    scheduled_at: v.scheduled_at,
    outcome: v.status === 'COMPLETED' ? 'finished' : v.status === 'CANCELLED' ? 'cancelled' : 'open',
    finished_by: v.status === 'COMPLETED' ? finishedBy.get(v.id) ?? null : null,
    crew: v.assignees.map((a) => fullName(a.user)!).filter(Boolean),
    cancelled_by_complete: v.status === 'CANCELLED' && v.cancelled_reason === OPEN_VISIT_CANCEL_REASON,
  }));

  const scopes = asScopeArray(job.scopes);
  const lines: ReviewSummaryLine[] = [
    ...job.job_line_items.map((l) => ({
      name: l.description,
      quantity: numberOf(l.quantity),
      unit_price: numberOf(l.unit_price),
      line_total: numberOf(l.line_total),
      ...(mayCosts ? { unit_cost: 'unit_cost' in l && l.unit_cost != null ? numberOf(l.unit_cost) : null } : {}),
    })),
    // A scope of work is a flat-priced block; it reads as one line of quantity one.
    ...scopes.map((s) => ({
      name: s.title,
      quantity: 1,
      unit_price: numberOf(s.flat_price),
      line_total: numberOf(s.flat_price),
      ...(mayCosts ? { unit_cost: s.internal_cost ?? null } : {}),
    })),
  ];
  const totalCost = mayCosts
    ? job.job_line_items.reduce((sum, l) => sum + ('unit_cost' in l && l.unit_cost != null ? numberOf(l.unit_cost) * numberOf(l.quantity) : 0), 0) +
      scopes.reduce((sum, s) => sum + (s.internal_cost ?? 0), 0)
    : null;

  const billing = computeJobBilling({
    lines: job.job_line_items.map((l) => ({ quantity: numberOf(l.quantity), unit_price: numberOf(l.unit_price), is_taxable: l.is_taxable })),
    scopes: toScopeForTotals(scopes),
    taxRate: numberOf(job.tax_rate),
    taxExempt: job.customer.tax_exempt,
    discountAmount: numberOf(job.discount_amount),
    invoices: invoices.map((i) => ({ total_amount: numberOf(i.total_amount), voided_at: i.voided_at })),
  });

  // The balance is the figure Mark Done, the job page's Balance card and the Ready to close banner use: asked of the same
  // function, over every invoice the job's money comes from (a deposit made on its estimate included), never a sum of
  // its own and never narrowed by what this reader may open.
  const { owedCents } = await readJobMoneyOwed({ orgId, jobId, db });

  const details: ReviewJobDetails = {
    job_number: job.job_number,
    job_type: job.job_type,
    customer: {
      name: `${job.customer.first_name} ${job.customer.last_name}`.trim(),
      company_name: job.customer.company_name,
    },
    service_address: addressOf(job.service_location),
    visits,
    lines,
    discount_amount: numberOf(job.discount_amount),
    total: billing.total,
    total_cost: totalCost,
    invoices: invoices
      .filter((i) => !i.voided_at && openable.has(i.id))
      .map((i) => ({ invoice_number: i.invoice_number, status: i.status, total: numberOf(i.total_amount), amount_due: numberOf(i.amount_due) })),
    balance: fromCents(owedCents),
    file_count: fileCount,
    note_count: noteCount,
  };

  const set = buildReviewChangeSet({
    entries,
    windowStart,
    details,
    jobLatestEntryId: latest?.id ?? null,
    checks: checkRows.map((c) => ({ item_key: c.item_key, entry_id: c.entry_id, checked_by: fullName(c.checked_by), checked_at: c.checked_at })),
    decisions: decisionRows.map((d) => ({ entry_id: d.entry_id, event_id: d.event_id, choice: d.choice, decided_by: fullName(d.decided_by), decided_at: d.decided_at })),
    // "Since the review" exists only for a job waiting to be closed: an unusual change re-opens the round (S06.20), so what is
    // listed there after the finish is ordinary by M8's own rule.
    finishedAt: job.status === 'READY_TO_CLOSE' && round?.state === 'FINISHED' ? round.finished_at : null,
    customerNow: { first_name: job.customer.first_name ?? '', last_name: job.customer.last_name ?? '', company_name: job.customer.company_name },
    mayCosts,
  });

  return {
    ...set,
    version: reviewVersion(set),
    round: round
      ? { id: round.id, state: round.state, started_at: round.started_at.toISOString(), window_start: round.window_start.toISOString() }
      : null,
  };
}
