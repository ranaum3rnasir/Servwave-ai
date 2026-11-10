/**
 * SMS Reply Router: the one rule that ties an incoming text to a lead or a job (#3020, parent #3013; it extends the
 * Communication ↔ Jobs spec §7 job rule to leads).
 *
 * SMS has no thread id, only the pair of numbers, so a tie can never be exact. The policy is "act + cheap undo", never
 * "ask first": the text is tied silently and a person re-ties it with one click when the guess is wrong. In order:
 *   1. the lead or job of the latest text we sent in the text's conversation, from a person or an automation, within 30
 *      days before it, while that lead or job is open. A text that did not go out (skipped, failed, or still queued) was
 *      not sent, so it is not a candidate. A text carrying no lead or job is not a candidate, so the texts the
 *      phone system sends by itself (an opt-in confirmation, reported to us carrying no lead or job) never count as the
 *      latest text we sent. A text carrying a lead and a job ties the reply to each of the two that is still open;
 *   2. else the one open lead or job carrying the number as its own, when exactly one does (#3015's fixed order, step 1:
 *      the same carriers and the same OPEN-only count an incoming call is filed by, `matchCallerByPhone`);
 *   3. else nothing: the text stays untied, readable through the customers carrying its number (#3013 decision 4).
 *
 * Open (Ran, 2026-11-05): a lead until it is converted (Won) or Lost; a job until it is Done or Cancelled, so a
 * Completed, Office review or Ready to close job still takes a reply.
 *
 * `pickReplyTie` is the pure decision over the candidate texts; `tieIncomingText` reads them (and the number's own record)
 * for the two doors that store an incoming text: the phone system's webhook (lib/ctm/ingest.ts) and a text recorded as
 * received from the composer (comm-threads.controller.ts). The own-number step resolves the number for the whole company,
 * so only the webhook (nobody signed in) passes a number; the signed-in composer door passes none (re-audit P2-1).
 */

import type { Prisma } from '@prisma/client';
import { DONE_OR_CANCELLED_JOB_STATUSES } from './job-status-order';
import { TERMINAL_LEAD_STATUSES } from '../services/lead-stage.service';
import { matchCallerByPhone, type OwnRecord } from './comms-identity';
import { UNSENT_REPLY_STATUSES } from './ctm/smsThread';

/** Only a text we sent within this many days before the reply ties it. */
export const SMS_ROUTER_RECENCY_WINDOW_DAYS = 30;

/** JobStatus values that are closed to a reply: Done and Cancelled (Ran, 2026-11-05). */
export const CLOSED_JOB_STATUSES: readonly string[] = DONE_OR_CANCELLED_JOB_STATUSES;

/** LeadStatus values that are closed to a reply: converted (Won) and Lost. */
export const CLOSED_LEAD_STATUSES: readonly string[] = TERMINAL_LEAD_STATUSES;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A text we sent in the conversation, with the lead and the job it carries. */
export interface ReplyTextCandidate {
  sentAt: Date;
  lead: { id: string; status: string } | null;
  job: { id: string; label: string | null; status: string } | null;
}

/** What an incoming text is tied to. Both null: untied. */
export interface ReplyTie {
  leadId: string | null;
  jobId: string | null;
  jobLabel: string | null;
}

export const UNTIED: ReplyTie = { leadId: null, jobId: null, jobLabel: null };

const leadIsOpen = (lead: ReplyTextCandidate['lead']) => lead != null && !CLOSED_LEAD_STATUSES.includes(lead.status);
const jobIsOpen = (job: ReplyTextCandidate['job']) => job != null && !CLOSED_JOB_STATUSES.includes(job.status);

/**
 * Step 1, pure: the lead and job of the latest text we sent, within the window before the reply (its edge counts as
 * inside), carrying a lead or a job that is still open. Null when no text qualifies.
 */
export function pickReplyTie(args: { at: Date; sentTexts: readonly ReplyTextCandidate[] }): ReplyTie | null {
  const { at, sentTexts } = args;
  const windowMs = SMS_ROUTER_RECENCY_WINDOW_DAYS * DAY_MS;
  const eligible = sentTexts.filter((t) => {
    const age = at.getTime() - t.sentAt.getTime();
    return age >= 0 && age <= windowMs && (leadIsOpen(t.lead) || jobIsOpen(t.job));
  });
  if (eligible.length === 0) return null;
  const latest = eligible.reduce((best, t) => (t.sentAt.getTime() > best.sentAt.getTime() ? t : best));
  const job = jobIsOpen(latest.job) ? latest.job : null;
  return { leadId: leadIsOpen(latest.lead) ? latest.lead!.id : null, jobId: job?.id ?? null, jobLabel: job?.label ?? null };
}

/** Step 2, pure: the one open lead or job carrying the number as its own, or nothing. */
function ownRecordTie(own: OwnRecord | null): ReplyTie {
  if (!own) return UNTIED;
  return own.kind === 'lead' ? { ...UNTIED, leadId: own.id } : { leadId: null, jobId: own.id, jobLabel: own.jobNumber };
}

type TieDb = Pick<Prisma.TransactionClient, 'message' | 'customer' | 'lead' | 'vendor' | 'vendorContact' | '$queryRaw'>;

/**
 * How many leads and jobs the conversation's texts are read for, in step 1: the latest text per lead and job (`distinct`),
 * so a chatty record cannot push an older open one out of the window read.
 */
const CANDIDATE_RECORDS = 20;

/**
 * The lead or job an incoming text is tied to (the steps above), judged when it is received (`at`, now), as the job rule
 * always was: a text is a candidate when it went out in the 30 days before that. `from` is the number the text came from,
 * in E.164; null when it is one of our own numbers, which no record carries.
 */
export async function tieIncomingText(
  db: TieDb,
  orgId: string,
  text: { threadId: string; at: Date; from: string | null },
): Promise<ReplyTie> {
  const windowStart = new Date(text.at.getTime() - SMS_ROUTER_RECENCY_WINDOW_DAYS * DAY_MS);
  const sent = await db.message.findMany({
    where: {
      organization_id: orgId,
      thread_id: text.threadId,
      direction: 'out',
      ts: { gte: windowStart, lte: text.at },
      AND: [
        { OR: [{ lead_id: { not: null } }, { job_id: { not: null } }] },
        // A text that did not go out (skipped, failed, or still queued) is not a text we sent.
        { OR: [{ status: null }, { status: { notIn: [...UNSENT_REPLY_STATUSES] } }] },
      ],
    },
    orderBy: [{ ts: 'desc' }, { created_at: 'desc' }],
    distinct: ['lead_id', 'job_id'],
    take: CANDIDATE_RECORDS,
    select: {
      ts: true,
      job_label: true,
      lead: { select: { id: true, status: true } },
      job: { select: { id: true, status: true } },
    },
  });
  const fromConversation = pickReplyTie({
    at: text.at,
    sentTexts: sent.map((m) => ({
      sentAt: m.ts,
      lead: m.lead,
      job: m.job ? { id: m.job.id, label: m.job_label, status: m.job.status } : null,
    })),
  });
  if (fromConversation) return fromConversation;
  if (!text.from) return UNTIED;
  return ownRecordTie((await matchCallerByPhone(db, orgId, text.from)).ownRecord);
}
