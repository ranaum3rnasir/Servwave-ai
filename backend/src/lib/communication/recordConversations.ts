import type { Request } from 'express';
import { invoiceOpenerFor, type InvoiceOpener } from '../permissions/invoiceAccess';
import { estimateOpenerFor, type EstimateOpener } from '../permissions/estimateAccess';
import { tieOf, showsOnJob, showsOnLead, isGuardedRecordType, type RecordTie } from './recordTie';

/**
 * The record conversations on a job's or lead's Communication tab (Roles & Permissions PRD 10, S10.5).
 *
 * A record conversation is an `email_threads` row with origin "record" and the record it is about (S10.4). Which job or
 * lead it is tied to is worked out here from that record, on every read (`recordTie.ts` holds the rule): the rows are
 * loaded fresh and nothing is stored. A conversation about an estimate or an invoice goes onto the tab only when the
 * person can also open that estimate or invoice, asked of the two openers.
 *
 * Bounded by design, because the hosted database allows one connection and a tab can hold dozens of conversations: the
 * record is read in one query, the estimates and the invoices that could be tied to it in one each, and the openers in
 * at most one each. The cost does not grow with the number of conversations, and no query is made per conversation.
 */

type Where = Record<string, unknown>;

/** The narrow part of the database client this reads, so the query count can be tested with a stub. */
export interface TieDb {
  job: { findUnique(args: any): Promise<any> };
  lead: { findUnique(args: any): Promise<any> };
  estimate: { findMany(args: any): Promise<any[]> };
  invoice: { findMany(args: any): Promise<any[]> };
}

export interface RecordOpeners {
  estimate: EstimateOpener;
  invoice: InvoiceOpener;
}

/** The person's two openers, worked out from their request. */
export async function recordOpenersForReq(req: Request): Promise<RecordOpeners> {
  const [estimate, invoice] = await Promise.all([estimateOpenerFor(req), invoiceOpenerFor(req)]);
  return { estimate, invoice };
}

export type TabAnchor = { kind: 'job' | 'lead'; id: string };

/** What a row of the tab shows about the job or lead a conversation is tied to, when the row names neither itself. */
interface TieDisplay {
  job_id: string | null;
  job_label: string | null;
  lead_id: string | null;
  lead: { id: string; lead_number: string } | null;
}

/** An email row as the tab reads it: its conversation's record rides along. */
interface TabEmailRow {
  id?: string;
  job_id?: string | null;
  lead_id?: string | null;
  thread?: { origin?: string | null; record_type: string | null; record_id: string | null } | null;
}

export interface TiedConversations {
  /**
   * The messages of the record conversations tied to the tab's record that the person may see, or null when there are
   * none. Read beside the rows the tab lists by their own job or lead column.
   */
  tiedEmailWhere: Where | null;
  /**
   * Is this message part of a conversation about an estimate or an invoice? Those never come through the tab's own
   * job or lead column: only through `tiedEmailWhere`, and only when the person can open the estimate or invoice.
   */
  isAboutAnEstimateOrInvoice(row: TabEmailRow): boolean;
  /** Fills in the job or lead a reply is tied to, for a row that names neither (a customer's reply is saved on the customer alone). */
  withTie<T extends TabEmailRow>(row: T): T;
}

const aboutAnEstimateOrInvoice = (row: TabEmailRow): boolean =>
  row.thread?.origin === 'record' && isGuardedRecordType(row.thread.record_type);

const NOTHING_TIED: TiedConversations = {
  tiedEmailWhere: null,
  isAboutAnEstimateOrInvoice: aboutAnEstimateOrInvoice,
  withTie: (row) => row,
};

const keyOf = (type: string, id: string) => `${type}:${id}`;

export async function tiedRecordConversations(
  db: TieDb,
  args: { organizationId: string; anchor: TabAnchor; openers: RecordOpeners },
): Promise<TiedConversations> {
  const { organizationId, anchor, openers } = args;
  const displays = new Map<string, TieDisplay>();
  const records: Array<{ type: string; id: string }> = [];

  // The record itself, with the other end of its lead-to-job link: a job knows its lead, a lead knows its jobs.
  let leadId: string | null;
  let jobs: Array<{ id: string; job_number: string }>;
  let lead: { id: string; lead_number: string } | null;
  let shows: (tie: RecordTie) => boolean;
  if (anchor.kind === 'job') {
    const job = await db.job.findUnique({
      where: { id: anchor.id, organization_id: organizationId },
      select: { id: true, job_number: true, lead: { select: { id: true, lead_number: true } } },
    });
    if (!job) return NOTHING_TIED;
    jobs = [{ id: job.id, job_number: job.job_number }];
    lead = job.lead ?? null;
    leadId = lead?.id ?? null;
    shows = (tie) => showsOnJob(tie, { id: job.id, leadId });
  } else {
    const found = await db.lead.findUnique({
      where: { id: anchor.id, organization_id: organizationId },
      select: { id: true, lead_number: true, jobs: { select: { id: true, job_number: true } } },
    });
    if (!found) return NOTHING_TIED;
    jobs = found.jobs ?? [];
    lead = { id: found.id, lead_number: found.lead_number };
    leadId = found.id;
    const jobIds = jobs.map((j) => j.id);
    shows = (tie) => showsOnLead(tie, { id: found.id, jobIds });
  }
  const jobIds = jobs.map((j) => j.id);
  const jobNumberOf = new Map(jobs.map((j) => [j.id, j.job_number]));

  const displayOf = (tie: RecordTie): TieDisplay => ({
    job_id: tie.jobId,
    job_label: tie.jobId ? jobNumberOf.get(tie.jobId) ?? null : null,
    lead_id: tie.leadId,
    lead: tie.leadId && lead && lead.id === tie.leadId ? lead : null,
  });

  // The job and lead notices: the record itself, and the lead it came from or the jobs made from it.
  const noticeRecords: Array<{ type: string; id: string; tie: RecordTie }> = [
    ...jobs.map((j) => ({ type: 'job', id: j.id, tie: tieOf({ type: 'job', id: j.id }) })),
    ...(lead ? [{ type: 'lead', id: lead.id, tie: tieOf({ type: 'lead', id: lead.id }) }] : []),
  ];
  for (const n of noticeRecords) {
    if (!shows(n.tie)) continue;
    records.push({ type: n.type, id: n.id });
    displays.set(keyOf(n.type, n.id), displayOf(n.tie));
  }

  // The estimates and invoices that could be tied here: those on this job or lead (or the lead's jobs), loaded once each.
  const estimateReach: Where = {
    OR: [
      ...(leadId ? [{ lead_id: leadId }] : []),
      ...(jobIds.length > 0 ? [{ job_id: { in: jobIds } }] : []),
    ],
  };
  const estimates = (estimateReach.OR as unknown[]).length === 0 ? [] : (await db.estimate.findMany({
    where: { organization_id: organizationId, ...estimateReach },
    select: { id: true, job_id: true, lead_id: true },
  })) ?? [];
  const invoices = (await db.invoice.findMany({
    where: {
      organization_id: organizationId,
      OR: [
        ...(jobIds.length > 0 ? [{ job_id: { in: jobIds } }] : []),
        ...((estimateReach.OR as unknown[]).length > 0 ? [{ estimate: estimateReach }] : []),
      ],
    },
    select: { id: true, job_id: true, estimate: { select: { job_id: true, lead_id: true } } },
  })) ?? [];

  const estimateTies = estimates
    .map((e) => ({ id: e.id, tie: tieOf({ type: 'estimate', jobId: e.job_id, leadId: e.lead_id }) }))
    .filter((e) => shows(e.tie));
  const invoiceTies = invoices
    .map((i) => ({
      id: i.id,
      tie: tieOf({ type: 'invoice', jobId: i.job_id, estimate: i.estimate ? { jobId: i.estimate.job_id, leadId: i.estimate.lead_id } : null }),
    }))
    .filter((i) => shows(i.tie));

  // Only the estimates and invoices the person can open bring their conversation along.
  const [openEstimates, openInvoices] = await Promise.all([
    openers.estimate(estimateTies.map((e) => e.id)),
    openers.invoice(invoiceTies.map((i) => i.id)),
  ]);
  for (const e of estimateTies) {
    if (!openEstimates.has(e.id)) continue;
    records.push({ type: 'estimate', id: e.id });
    displays.set(keyOf('estimate', e.id), displayOf(e.tie));
  }
  for (const i of invoiceTies) {
    if (!openInvoices.has(i.id)) continue;
    records.push({ type: 'invoice', id: i.id });
    displays.set(keyOf('invoice', i.id), displayOf(i.tie));
  }

  const byType = new Map<string, string[]>();
  for (const r of records) byType.set(r.type, [...(byType.get(r.type) ?? []), r.id]);
  const tiedEmailWhere: Where | null = records.length === 0 ? null : {
    thread: {
      origin: 'record',
      OR: [...byType].map(([record_type, ids]) => ({ record_type, record_id: { in: ids } })),
    },
  };

  return {
    tiedEmailWhere,
    isAboutAnEstimateOrInvoice: aboutAnEstimateOrInvoice,
    withTie: (row) => {
      if (row.job_id || row.lead_id || !row.thread?.record_type || !row.thread.record_id) return row;
      const shown = displays.get(keyOf(row.thread.record_type, row.thread.record_id));
      return shown ? { ...row, ...shown } : row;
    },
  };
}

// ─── The job or lead a row of the Email page is about (S10.9) ───────────────────────────────────────────────────────────────

/** The job or lead a record conversation is tied to, as the Inbox row names it and links to it. */
export interface RecordLabel {
  kind: 'job' | 'lead';
  id: string;
  /** The job number or the lead number, as the record tabs show it. */
  label: string;
}

/** The narrow part of the database client this reads, so the query count can be tested with a stub. */
export interface LabelDb {
  job: { findMany(args: any): Promise<any[]> };
  lead: { findMany(args: any): Promise<any[]> };
  estimate: { findMany(args: any): Promise<any[]> };
  invoice: { findMany(args: any): Promise<any[]> };
}

/** The conversations of a page of rows, as far as their record goes (an `email_threads` row's own columns). */
export interface LabelledThread {
  id: string;
  origin?: string | null;
  record_type: string | null;
  record_id: string | null;
}

/**
 * The job or lead each of these record conversations is tied to (`tieOf`, the one rule), named for the Inbox row. A
 * conversation about no job or lead (a customer's, a calendar entry's, an invoice made for the customer alone), and a job
 * or lead the person cannot open (`reach`, their row scope on each), has no label: a label never names a record the person
 * cannot open. A bounded number of reads however many rows there are: one for the estimates and one for the invoices the
 * page names, then one for the jobs and one for the leads they tie to (each only when the page names any). Nothing is
 * asked per conversation.
 */
export async function recordLabelsFor(
  db: LabelDb,
  args: { organizationId: string; threads: readonly LabelledThread[]; reach: { job: Where; lead: Where } },
): Promise<Map<string, RecordLabel>> {
  const { organizationId, reach } = args;
  const threads = args.threads.filter((t) => t.origin === 'record' && t.record_id && t.record_type);
  const idsOf = (type: string) => [...new Set(threads.filter((t) => t.record_type === type).map((t) => t.record_id as string))];

  const estimateIds = idsOf('estimate');
  const invoiceIds = idsOf('invoice');
  const [estimates, invoices] = await Promise.all([
    estimateIds.length === 0 ? [] : db.estimate.findMany({
      where: { id: { in: estimateIds }, organization_id: organizationId }, select: { id: true, job_id: true, lead_id: true },
    }),
    invoiceIds.length === 0 ? [] : db.invoice.findMany({
      where: { id: { in: invoiceIds }, organization_id: organizationId },
      select: { id: true, job_id: true, estimate: { select: { job_id: true, lead_id: true } } },
    }),
  ]);
  const estimateTie = new Map(estimates.map((e) => [e.id as string, tieOf({ type: 'estimate', jobId: e.job_id, leadId: e.lead_id })]));
  const invoiceTie = new Map(invoices.map((i) => [
    i.id as string,
    tieOf({ type: 'invoice', jobId: i.job_id, estimate: i.estimate ? { jobId: i.estimate.job_id, leadId: i.estimate.lead_id } : null }),
  ]));

  const tieOfThread = (t: LabelledThread): RecordTie | null => {
    switch (t.record_type) {
      case 'job': return tieOf({ type: 'job', id: t.record_id as string });
      case 'lead': return tieOf({ type: 'lead', id: t.record_id as string });
      case 'estimate': return estimateTie.get(t.record_id as string) ?? null;
      case 'invoice': return invoiceTie.get(t.record_id as string) ?? null;
      default: return null;
    }
  };
  const ties = new Map<string, RecordTie>();
  for (const t of threads) {
    const tie = tieOfThread(t);
    if (tie && (tie.jobId || tie.leadId)) ties.set(t.id, tie);
  }
  const jobIds = [...new Set([...ties.values()].flatMap((t) => (t.jobId ? [t.jobId] : [])))];
  const leadIds = [...new Set([...ties.values()].flatMap((t) => (t.leadId ? [t.leadId] : [])))];
  const [jobs, leads] = await Promise.all([
    jobIds.length === 0 ? [] : db.job.findMany({
      where: { id: { in: jobIds }, organization_id: organizationId, ...reach.job }, select: { id: true, job_number: true },
    }),
    leadIds.length === 0 ? [] : db.lead.findMany({
      where: { id: { in: leadIds }, organization_id: organizationId, ...reach.lead }, select: { id: true, lead_number: true },
    }),
  ]);
  const jobNumber = new Map(jobs.map((j) => [j.id as string, j.job_number as string]));
  const leadNumber = new Map(leads.map((l) => [l.id as string, l.lead_number as string]));

  const labels = new Map<string, RecordLabel>();
  for (const [threadId, tie] of ties) {
    if (tie.jobId && jobNumber.has(tie.jobId)) labels.set(threadId, { kind: 'job', id: tie.jobId, label: jobNumber.get(tie.jobId)! });
    else if (tie.leadId && leadNumber.has(tie.leadId)) labels.set(threadId, { kind: 'lead', id: tie.leadId, label: leadNumber.get(tie.leadId)! });
  }
  return labels;
}
