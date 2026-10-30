/**
 * jobReviewAlerts.ts - the close-out alerts that follow a review (Roles & Permissions, PRD 6, S06.24), both sent through
 * M6's two lanes (alertChain.ts):
 *
 *   Ready to close  "J00123 is ready to close": Finish review moved the job on. Lane 1 is the job's people (stored Sold By,
 *                   crew, Dispatcher); lane 2 is EVERY Close jobs holder who can open the job, whether or not the job has
 *                   a Dispatcher, else the Manage roles and permissions holders; copies to "Alert me about every job". Its
 *                   link opens the job itself, where the banner offers Mark Done. A job that goes back and is finished
 *                   again alerts again. There is no alert for Done.
 *   Review attention  one alert for a landing, listing what changed in the panel's own words. High priority. Lane 1 the
 *                   job's people; lane 2 the Dispatcher, else the Office review holders, else the Manage roles and
 *                   permissions holders; copies to "Alert me about every job". Its link opens the review panel. It never says more
 *                   to a person than the review panel would show them: an item about an invoice the person cannot open is left
 *                   out of their copy, and a person left with nothing to list is sent nothing (see peopleSeeingEachItem).
 *
 * Both are sent AFTER the change committed, on the global client, never from inside a transaction: an alert emitted
 * inside one can be lost (its reads cannot see the uncommitted state) or fire for a write that rolls back, and on the
 * hosted pool a query on the global client from inside a transaction waits for a connection that never comes. Both are
 * fire-and-forget: a failure is logged and never reaches the change that already landed. Neither puts customer content in a
 * log line.
 */

import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { jobCrewIds } from '../../lib/job-crew';
import { sendByWhyLine, twoLaneRecipients } from './alertChain';
import { alertSomeone } from '../../lib/permissions/alertSomeone';
import { emit } from './notificationService';
import { alertJobLifecycle } from './jobLifecycleAlerts';
import { REVIEW_PANEL } from './jobCompletedAlert';
import { jobsHoldingInvoice } from '../../lib/job-money-owed';
import { unusualItemsInWindow } from '../../lib/job-review-return';
import type { AttentionItem, PendingAttention } from './reviewAttentionQueue';

/** What the chain needs to know of a job: its number and its people. Null when the job is not in the company. */
export interface JobPeople {
  jobNumber: string;
  recordPeople: string[];
  dispatcherId: string | null;
}

async function readJobPeople(organizationId: string, jobId: string): Promise<(JobPeople & { status: string }) | null> {
  const job = await prisma.job.findFirst({
    where: { id: jobId, organization_id: organizationId },
    select: {
      job_number: true, status: true, salesperson_id: true, dispatcher_id: true,
      visits: { select: { assignees: { select: { user_id: true } } } },
    },
  });
  if (!job) return null;
  return {
    jobNumber: job.job_number,
    status: job.status,
    recordPeople: [...(job.salesperson_id ? [job.salesperson_id] : []), ...jobCrewIds(job)],
    dispatcherId: job.dispatcher_id,
  };
}

export async function alertJobReadyToClose(args: {
  organizationId: string;
  /** The person who finished the review; never someone for the alert. */
  actorId: string;
  jobId: string;
}): Promise<void> {
  try {
    const job = await readJobPeople(args.organizationId, args.jobId);
    if (!job) return;
    const people = await twoLaneRecipients({
      organizationId: args.organizationId,
      record: { type: 'JOB', id: args.jobId },
      actorId: args.actorId,
      recordPeople: job.recordPeople,
      dispatcherId: job.dispatcherId,
      stepSwitch: 'close_jobs',
      stepHoldersAlways: true,
      copySwitch: 'alert_every_job',
      words: { record: 'job', step: 'close jobs', alert: 'ready to close alert' },
    });
    await sendByWhyLine(people, (entity, whyLine) =>
      emit({
        verb: 'job.ready_to_close',
        organizationId: args.organizationId,
        actorId: args.actorId,
        object: { type: 'JOB', id: args.jobId, label: job.jobNumber },
        entity,
        data: { object_label: job.jobNumber, fallback_reason: whyLine ?? '' },
      }));
  } catch (err) {
    logger.warn('[jobReviewAlerts] could not send the ready to close alert', {
      jobId: args.jobId, error: err instanceof Error ? err.message : String(err),
    });
  }
}


/** How many lines the bell body lists before it says how many more there are. */
const MOST_LISTED = 5;

/** The alert's body: the items in the panel's words, one per line ("A price was lowered: Line: Faucet"). */
function itemsText(items: AttentionItem[]): string {
  const lines = items.slice(0, MOST_LISTED).map((i) => `${i.reason}: ${i.title}`);
  if (items.length > MOST_LISTED) lines.push(`and ${items.length - MOST_LISTED} more`);
  return lines.join('\n');
}

/**
 * The alert never says more to a person than the review panel would show them. The panel leaves an item about an invoice out
 * for a person who cannot open that invoice (View invoices off, or Invoices scope Attached and not on it, the creator rule
 * letting a creator in), so an item that names an invoice is left out of that person's copy, and a person left with nothing to
 * list is sent nothing: the PRD asks for no bare line, and a generic one would still tell them an invoice was touched.
 *
 * `groupOf` sorts the people the chain found into groups that share one list (for a given set of invoices, those who can open
 * them and those who cannot), so the alert goes out once per group, never once per person. It asks "who can open this invoice"
 * once per invoice named, over all the people together (alertSomeone is batched), so the reads grow with the invoices named
 * and not with the company. It is undefined when no item names an invoice: then nothing is asked and everyone gets the list.
 */
function peopleSeeingEachItem(organizationId: string, items: AttentionItem[]) {
  const invoiceIds = [...new Set(items.flatMap((i) => i.invoiceIds ?? []))];
  const listed = new Map<string, AttentionItem[]>();
  const groupOf = invoiceIds.length === 0
    ? undefined
    : async (personIds: string[]): Promise<Map<string, string | null>> => {
      const openers = new Map<string, Set<string>>();
      for (const invoiceId of invoiceIds) {
        // The actor was left out of the chain already, so nobody is left out here.
        openers.set(invoiceId, new Set(await alertSomeone({ organizationId, candidateIds: personIds, record: { type: 'INVOICE', id: invoiceId }, actorId: null })));
      }
      const groups = new Map<string, string | null>();
      for (const person of personIds) {
        const shown = items.filter((i) => (i.invoiceIds ?? []).every((id) => openers.get(id)!.has(person)));
        const key = shown.length ? shown.map((i) => items.indexOf(i)).join(',') : null;
        if (key !== null) listed.set(key, shown);
        groups.set(person, key);
      }
      return groups;
    };
  return { groupOf, itemsFor: (group: string | null) => (group === null ? items : listed.get(group)!) };
}

/**
 * The Office review attention alert: ONE alert for a landing, listing its items. `job` is given by a caller that already
 * holds the job's people (Complete does), else the job is read once. The people are the job's own, whoever must act on the
 * review (the Dispatcher, else the Office review holders, else the Manage roles and permissions holders) and the copies.
 * `itemsIfDone` are listed only when the job turns out to be Done: a delete or detail change on a Done job alerts whatever it was.
 */
export async function alertReviewAttention(args: {
  organizationId: string;
  actorId: string | null;
  jobId: string;
  items: AttentionItem[];
  itemsIfDone?: AttentionItem[];
  job?: JobPeople;
}): Promise<void> {
  try {
    const ifDone = args.itemsIfDone ?? [];
    let job: JobPeople | null = args.job ?? null;
    let items = args.items;
    if (!job || ifDone.length > 0) {
      const read = await readJobPeople(args.organizationId, args.jobId);
      if (!read) return;
      if (read.status === 'DONE') items = [...items, ...ifDone];
      job = args.job ?? read;
    }
    items = items.reduce<AttentionItem[]>((kept, item) => {
      const same = kept.find((o) => o.reason === item.reason && o.title === item.title);
      if (!same) kept.push(item);
      else if (item.invoiceIds?.length) same.invoiceIds = [...new Set([...(same.invoiceIds ?? []), ...item.invoiceIds])];
      return kept;
    }, []);
    if (items.length === 0) return;
    const people = await twoLaneRecipients({
      organizationId: args.organizationId,
      record: { type: 'JOB', id: args.jobId },
      actorId: args.actorId,
      recordPeople: job.recordPeople,
      dispatcherId: job.dispatcherId,
      stepSwitch: 'office_review',
      copySwitch: 'alert_every_job',
      words: { record: 'job', step: 'review jobs', alert: 'office review attention alert' },
    });
    const { groupOf, itemsFor } = peopleSeeingEachItem(args.organizationId, items);
    await sendByWhyLine(people, (entity, whyLine, group) =>
      emit({
        verb: 'job.review_attention',
        organizationId: args.organizationId,
        actorId: args.actorId,
        object: { type: 'JOB', id: args.jobId, label: job!.jobNumber },
        entity,
        data: { object_label: job!.jobNumber, panel: REVIEW_PANEL, items_text: itemsText(itemsFor(group)), fallback_reason: whyLine ?? '' },
      }), groupOf);
  } catch (err) {
    logger.warn('[jobReviewAlerts] could not send the office review attention alert', {
      jobId: args.jobId, error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Send what a finished request queued (reviewAttentionQueue): one alert per job, listing every item the request landed on
 * it. An entry that waits for the job to be Done is resolved here, after the response, so it costs the request nothing; an
 * entry that names an invoice reaches the Done jobs that hold it.
 */
export async function alertQueuedReviewAttention(queue: PendingAttention[]): Promise<void> {
  const byJob = new Map<string, { organizationId: string; actorId: string | null; items: AttentionItem[]; itemsIfDone: AttentionItem[] }>();
  const add = (jobId: string, p: PendingAttention) => {
    const slot = byJob.get(jobId) ?? { organizationId: p.orgId, actorId: p.actorId, items: [], itemsIfDone: [] };
    (p.onlyIfDone ? slot.itemsIfDone : slot.items).push(...p.items);
    byJob.set(jobId, slot);
  };
  for (const p of queue) {
    if (p.later) {
      // One alert failing leaves the rest of the request's alerts to go out.
      await p.later().catch((err) => logger.warn('[jobReviewAlerts] a queued alert could not be sent', { error: err instanceof Error ? err.message : String(err) }));
    } else if (p.readyToClose && p.jobId) {
      await alertJobReadyToClose({ organizationId: p.orgId, actorId: p.actorId ?? '', jobId: p.jobId });
    } else if (p.lifecycle && p.jobId) {
      await alertJobLifecycle({ verb: p.lifecycle.verb, organizationId: p.orgId, actorId: p.actorId, jobId: p.jobId, job: p.lifecycle.job, data: p.lifecycle.data });
    } else if (p.entering && p.jobId) {
      // A job that just entered Office review: what is already unusual in its window is the alert's list.
      const found = await unusualItemsInWindow(prisma, p.orgId, p.jobId, p.entering.windowStart);
      await alertReviewAttention({
        organizationId: p.orgId, actorId: p.actorId, jobId: p.jobId, items: found.map((c) => ({ reason: c.reason, title: c.title, invoiceIds: c.invoice_ids })),
        job: { jobNumber: p.entering.jobNumber, recordPeople: p.entering.recordPeople, dispatcherId: p.entering.dispatcherId },
      });
    } else if (p.jobId) add(p.jobId, p);
    else if (p.invoiceId) {
      const holders = await prisma.job.findMany({
        where: { organization_id: p.orgId, status: 'DONE', ...jobsHoldingInvoice(p.invoiceId) },
        select: { id: true },
      });
      holders.forEach((j) => add(j.id, p));
    }
  }
  for (const [jobId, slot] of byJob) {
    await alertReviewAttention({ organizationId: slot.organizationId, actorId: slot.actorId, jobId, items: slot.items, itemsIfDone: slot.itemsIfDone });
  }
}
