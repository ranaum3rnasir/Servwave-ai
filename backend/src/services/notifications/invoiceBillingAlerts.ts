/**
 * invoiceBillingAlerts.ts - the one place the billing alerts are sent from (Roles & Permissions, PRD 6, S06.28).
 *
 * Payment received, Partial payment received, Invoice overdue, Invoice due soon, Refund issued, Payment disputed, Chargeback
 * received, Card payment could not be applied, Invoice voided and Credit applied go out through M6's two lanes (alertChain.ts),
 * and so do the sibling money alerts the PRD table is silent on (a bank payment started, cleared or failed; a dispute closed;
 * a refund that failed): the record's people are always told; whoever must act is the record's Dispatcher, else the holders of
 * Access Billing who can open the invoice, else the Admins; holders of "Alert me about every invoice
 * and payment" get a copy. Nobody comes from a role name, and the person who did it is never told.
 *
 *   An invoice's record is its job when it has one, else its estimate's job, else its estimate's lead (recordTie, the one rule for
 *   it), else nothing at all: a standalone invoice has no people and starts at step 2 ("This invoice has no job or lead"). Its
 *   people are the job's stored Sold By, crew and Dispatcher, or the lead's Owner, walkthrough crew and Dispatcher. The old
 *   "customer owner" recipient is gone: it was the Owner of the lead the job came from, who is the job's Sold By already.
 *
 *   These alerts name an invoice and usually an amount, so everyone who is told must be able to open the INVOICE (View invoices and
 *   its scope) as well as the job or lead: the chain asks both, in one batched read each, and a
 *   person who can open one but not the other is not "someone", so the chain goes on to the next step. An alert never says more to
 *   a person than the screens show them.
 *
 *   Money that no invoice of the company carries (a refund or a dispute the processor reports against nothing the company
 *   recorded) has no record at all: the chain starts at step 2 and tells the Access Billing holders, else the managers.
 *
 * The people who reached an alert as a fallback are told why and the others are not, so an event goes out as up to two alerts (one
 * without the line, one with it). A retried event (the processor retries) keeps its key on the first and suffixes the second, so a
 * replay produces neither.
 *
 * Sent AFTER the change committed and, for a request, AFTER the response (reviewAttentionQueue): the request only queues it and
 * gains no statement. Where there is no request (the processor's webhook and reconciler, the nightly sweep) the alert is sent
 * directly after their own commit, on the global client and never inside a transaction. Fire-and-forget: a failure is logged and
 * never reaches the change that already landed (a webhook still acknowledges).
 *
 * Cost of one alert, the same however large the company: one read of the invoice and its people (none when the sweep hands them in),
 * one read to see whether it was sent already, the chain's reads (the switch holders of the step, the copies and the manager
 * fallback, each followed by the batched access check of the invoice and of its job or lead) and one write pair per alert sent.
 */

import type { Prisma } from '@prisma/client';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { jobCrewIds } from '../../lib/job-crew';
import { tieOf } from '../../lib/communication/recordTie';
import type { EntityRef } from '../../lib/tasks/entityAccess';
import { sendByWhyLine, twoLaneRecipients, WHY_KEY, type TwoLaneInput } from './alertChain';
import { INVOICE_WITHOUT_JOB_OR_LEAD_STEM } from './whyLines';
import { emit } from './notificationService';
import { queueAlertAfterResponse } from './reviewAttentionQueue';

/**
 * What each billing verb is called in a log line. All of them are told through Access Billing, with a copy to every invoice and
 * payment. Which verbs are priced as a plain feed item, which ask for a reminder and which interrupt is resolveRecipients' business.
 */
const BILLING_ALERT_NAME = {
  'billing.payment_received': 'payment received alert',
  'billing.partial_payment': 'partial payment alert',
  'billing.invoice_overdue': 'invoice overdue alert',
  'billing.invoice_due_soon': 'invoice due soon alert',
  'billing.refunded': 'refund issued alert',
  'billing.disputed': 'payment disputed alert',
  'billing.chargeback': 'chargeback alert',
  'billing.payment_unrecorded': 'card payment could not be applied alert',
  'billing.voided': 'invoice voided alert',
  'billing.credit_applied': 'credit applied alert',
  // The table has no row for these; each is told like its nearest sibling (see resolveRecipients).
  'billing.bank_payment_started': 'bank payment started alert',
  'billing.bank_payment_cleared': 'bank payment cleared alert',
  'billing.bank_payment_failed': 'bank payment failed alert',
  'billing.dispute_closed': 'dispute closed alert',
  'billing.refund_failed': 'refund failed alert',
} as const;

export type BillingAlertVerb = keyof typeof BILLING_ALERT_NAME;

export const BILLING_ALERT_VERBS: readonly BillingAlertVerb[] = Object.keys(BILLING_ALERT_NAME) as BillingAlertVerb[];

export const isBillingAlertVerb = (verb: string): verb is BillingAlertVerb => verb in BILLING_ALERT_NAME;

const STEP_SWITCH = 'access_billing';
const STEP_WORDS = 'access billing';
const COPY_SWITCH = 'alert_every_invoice';

const crew = { visits: { select: { assignees: { select: { user_id: true } } } } } as const;

/** What the chain needs to know about an invoice's people. The nightly sweep selects this with its invoices. */
export const INVOICE_PEOPLE_SELECT = {
  job_id: true,
  job: { select: { salesperson_id: true, dispatcher_id: true, ...crew } },
  estimate: {
    select: {
      job_id: true, lead_id: true,
      job_link: { select: { salesperson_id: true, dispatcher_id: true, ...crew } },
      lead: { select: { commission_owner_id: true, dispatcher_id: true, ...crew } },
    },
  },
} satisfies Prisma.InvoiceSelect;

export type InvoicePeopleSource = Prisma.InvoiceGetPayload<{ select: typeof INVOICE_PEOPLE_SELECT }>;

/** The invoice's record and the people on it, worked out from the rows above. */
export function invoicePeople(invoice: InvoicePeopleSource) {
  const tie = tieOf({
    type: 'invoice',
    jobId: invoice.job_id,
    estimate: invoice.estimate ? { jobId: invoice.estimate.job_id, leadId: invoice.estimate.lead_id } : null,
  });
  const job = tie.jobId ? (invoice.job_id ? invoice.job : invoice.estimate?.job_link) ?? null : null;
  const lead = !tie.jobId && tie.leadId ? invoice.estimate?.lead ?? null : null;
  const place: EntityRef | null = tie.jobId ? { type: 'JOB', id: tie.jobId } : tie.leadId ? { type: 'LEAD', id: tie.leadId } : null;
  const recordPeople = job
    ? [...(job.salesperson_id ? [job.salesperson_id] : []), ...jobCrewIds(job)]
    : lead
      ? [...(lead.commission_owner_id ? [lead.commission_owner_id] : []), ...jobCrewIds(lead)]
      : [];
  return { place, recordPeople, dispatcherId: job?.dispatcher_id ?? lead?.dispatcher_id ?? null, onAJob: Boolean(job) };
}

export interface InvoiceAlertArgs {
  verb: BillingAlertVerb;
  organizationId: string;
  /** The person who did it; null for the processor's own report and for the nightly sweep. */
  actorId: string | null;
  /** What the alert is about: the invoice, or the company itself when the money has no invoice of the company's to carry it. */
  object: { type: 'INVOICE' | 'ORGANIZATION'; id: string; label: string };
  /** Display data kept on the alert (the amount, the customer's name, the reason). */
  data?: Record<string, unknown>;
  /** Doors that report one event (the processor retries) share a key, so the alert goes out once. */
  dedupKey?: string;
  /** A sweep that already holds the invoice's people hands them in, so the alert reads nothing about the invoice. */
  known?: InvoicePeopleSource;
  /** A sweep that already asked whether this was sent today. */
  dedupChecked?: boolean;
  /** A sweep that remembers the company's switch holders between invoices. */
  holdersOf?: TwoLaneInput['holdersOf'];
}

/**
 * Send one billing alert. Returns the people it reached (every alert it went out as), [] when nobody was told, the event was
 * already sent, or it could not be sent: it never throws.
 */
export async function alertInvoice(args: InvoiceAlertArgs): Promise<string[]> {
  try {
    const { organizationId, object } = args;
    if (args.dedupKey && !args.dedupChecked) {
      const sent = await prisma.notification.findFirst({
        where: { organization_id: organizationId, dedup_key: { in: [args.dedupKey, args.dedupKey + WHY_KEY] } },
        select: { id: true },
      });
      if (sent) return [];
    }

    let people: ReturnType<typeof invoicePeople> | null = null;
    if (object.type === 'INVOICE') {
      const invoice = args.known ?? await prisma.invoice.findFirst({
        where: { id: object.id, organization_id: organizationId },
        select: INVOICE_PEOPLE_SELECT,
      });
      if (!invoice) return [];
      people = invoicePeople(invoice);
    }

    const alertName = BILLING_ALERT_NAME[args.verb];
    const answer = await twoLaneRecipients({
      organizationId,
      record: people ? { type: 'INVOICE', id: object.id } : null,
      alsoOpen: people?.place ?? undefined,
      actorId: args.actorId,
      recordPeople: people?.recordPeople ?? [],
      dispatcherId: people?.dispatcherId ?? null,
      stepSwitch: STEP_SWITCH,
      copySwitch: COPY_SWITCH,
      holdersOf: args.holdersOf,
      noDispatcherReason: people && !people.place ? INVOICE_WITHOUT_JOB_OR_LEAD_STEM : undefined,
      words: { record: people?.onAJob ? 'job' : people?.place ? 'lead' : 'invoice', step: STEP_WORDS, alert: alertName },
    });

    const told: string[] = [];
    await sendByWhyLine(answer, async (entity, whyLine) => {
      told.push(...await emit({
        verb: args.verb,
        organizationId,
        actorId: args.actorId,
        object,
        entity,
        data: { ...(args.data ?? {}), object_label: object.label, fallback_reason: whyLine ?? '' },
        ...(args.dedupKey ? { dedupKey: whyLine ? args.dedupKey + WHY_KEY : args.dedupKey } : {}),
      }));
    });
    return told;
  } catch (err) {
    logger.warn('[invoiceBillingAlerts] could not send a billing alert', {
      verb: args.verb, organizationId: args.organizationId, error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/** Leave a billing alert for after the response (or send it now where there is no request to wait for). */
export function queueInvoiceAlert(args: InvoiceAlertArgs): void {
  queueAlertAfterResponse({
    orgId: args.organizationId,
    actorId: args.actorId,
    send: async () => {
      await alertInvoice(args);
    },
  });
}
