/**
 * leadEstimateAlerts.ts - the one place the lead and estimate alerts are sent from (Roles & Permissions, PRD 6, S06.26).
 *
 * "New lead with no owner", "Walkthrough scheduled" and the estimate alerts (won, declined, archived, deposit paid, deposit
 * waived, approval voided, status corrected) go out through M6's two lanes (alertChain.ts), the same rule as the job alerts:
 * the record's people are always told; whoever must act is the record's Dispatcher, else the holders of the verb's step switch
 * who can open it, else the Admins; holders of the area's "Alert me about every ..." switch get a
 * copy. Nobody comes from a role name, and the person who did it is never told.
 *
 *   A lead's record is the lead: its Owner, the people on its walkthroughs, its Dispatcher.
 *   An estimate's record is its job when it has one, else its lead (recordTie, the one rule for it), else nothing at all: a
 *   standalone estimate starts at step 2 ("This estimate has no lead or job"). Its Owner (the Owner of its lead) is in lane 1
 *   whichever it is. The alert names the estimate, so everyone who is told must be able to open the estimate as well as the
 *   lead or job (the chain asks both): an alert never says more to a person than the screens would.
 *
 * The people who reached an alert as a fallback are told why and the others are not, so an action goes out as up to two alerts
 * (one without the line, one with it). A deduplicated alert (several doors report one approval) keeps its key on the first and
 * suffixes the second, so neither is mistaken for the other.
 *
 * Sent AFTER the change committed and, for a request, AFTER the response (reviewAttentionQueue): the request only queues it and
 * gains no statement. Cost of one alert, the same however large the company: one read of the record, the chain's reads (the
 * switch holders of the step, the copies and the manager fallback, each followed by the batched access check) and one write
 * pair per alert sent. Where there is no request (the website form's own background work after its acknowledgement, a payment
 * webhook's own work) the alert is sent directly, after the change committed and never inside a transaction. Fire-and-forget: a
 * failure is logged and never reaches the change that already landed.
 */

import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { jobCrewIds } from '../../lib/job-crew';
import { missingLeadOwnerWhereIn } from '../../lib/missingLeadOwner';
import { tieOf } from '../../lib/communication/recordTie';
import type { EntityRef } from '../../lib/tasks/entityAccess';
import { sendByWhyLine, twoLaneRecipients, WHY_KEY } from './alertChain';
import { ESTIMATE_WITHOUT_LEAD_OR_JOB_STEM } from './whyLines';
import { emit } from './notificationService';
import { queueAlertAfterResponse } from './reviewAttentionQueue';

// ─── Leads ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type LeadAlertVerb = 'lead.unassigned_created' | 'lead.walkthrough_scheduled';

/** What each lead verb is called in a log line. Both are told through Assign people to leads, with a copy to every lead. */
const LEAD_ALERT_NAME: Record<LeadAlertVerb, string> = {
  'lead.unassigned_created': 'new lead with no owner alert',
  'lead.walkthrough_scheduled': 'walkthrough scheduled alert',
};

export interface LeadAlertArgs {
  verb: LeadAlertVerb;
  organizationId: string;
  /** The person who did it; null when nobody signed in did (the website form), so there is nobody to leave out. */
  actorId: string | null;
  leadId: string;
  /** The people the walkthrough was just booked with: the ones the alert interrupts. */
  performerIds?: string[];
}

export async function alertLead(args: LeadAlertArgs): Promise<void> {
  try {
    const { organizationId } = args;
    // "No owner" is the dashboard's own definition (lib/missingLeadOwner), asked of the lead as it stands now: a lead that
    // has an Owner by the time this runs raises nothing, whatever source created it.
    const where = args.verb === 'lead.unassigned_created'
      ? missingLeadOwnerWhereIn({ organization_id: organizationId }, { id: args.leadId })
      : { id: args.leadId, organization_id: organizationId };
    const lead = await prisma.lead.findFirst({
      where,
      select: {
        lead_number: true, commission_owner_id: true, dispatcher_id: true,
        visits: { select: { assignees: { select: { user_id: true } } } },
      },
    });
    if (!lead) return;
    const performers = [...new Set([...jobCrewIds(lead), ...(args.performerIds ?? [])])];

    const people = await twoLaneRecipients({
      organizationId,
      record: { type: 'LEAD', id: args.leadId },
      actorId: args.actorId,
      recordPeople: [...(lead.commission_owner_id ? [lead.commission_owner_id] : []), ...performers],
      dispatcherId: lead.dispatcher_id,
      stepSwitch: 'assign_people_to_leads',
      copySwitch: 'alert_every_lead',
      words: { record: 'lead', step: 'assign people to leads', alert: LEAD_ALERT_NAME[args.verb] },
    });

    await sendByWhyLine(people, (entity, whyLine) =>
      emit({
        verb: args.verb,
        organizationId,
        actorId: args.actorId,
        object: { type: 'LEAD', id: args.leadId, label: lead.lead_number },
        // `performer_ids` is for the priority only: a walkthrough interrupts the people booked on it.
        entity: { ...entity, performer_ids: args.performerIds ?? [], commission_owner_id: lead.commission_owner_id },
        data: { object_label: lead.lead_number, fallback_reason: whyLine ?? '' },
      }));
  } catch (err) {
    logger.warn('[leadEstimateAlerts] could not send a lead alert', {
      verb: args.verb, leadId: args.leadId, error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Leave a lead alert for after the response (or send it now where there is no request to wait for). */
export function queueLeadAlert(args: LeadAlertArgs): void {
  queueAlertAfterResponse({ orgId: args.organizationId, actorId: args.actorId, send: () => alertLead(args) });
}

// ─── Estimates ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export type EstimateAlertVerb =
  | 'estimate.approved'
  | 'estimate.declined'
  | 'estimate.deposit_paid'
  | 'estimate.cancelled'
  | 'estimate.deposit_waived'
  | 'estimate.approval_voided'
  | 'estimate.status_corrected'
  | 'estimate.deposit_method_selected';

/**
 * What each estimate verb is called in a log line, and its step. Won and Deposit paid are "schedule the job": the holders of
 * Assign people to jobs. The rest follow the record: Assign people to jobs when the estimate is on a job, else Assign people
 * to leads. A Deposit paid is also a payment, so the holders of Alert me about every invoice and payment get a copy too.
 */
const ESTIMATE_ROWS: Record<EstimateAlertVerb, { alert: string; schedulesTheJob: boolean; copySwitch: string | string[] }> = {
  'estimate.approved': { alert: 'estimate won alert', schedulesTheJob: true, copySwitch: 'alert_every_estimate' },
  'estimate.declined': { alert: 'estimate declined alert', schedulesTheJob: false, copySwitch: 'alert_every_estimate' },
  'estimate.deposit_paid': { alert: 'deposit paid alert', schedulesTheJob: true, copySwitch: ['alert_every_estimate', 'alert_every_invoice'] },
  'estimate.cancelled': { alert: 'estimate archived alert', schedulesTheJob: false, copySwitch: 'alert_every_estimate' },
  'estimate.deposit_waived': { alert: 'deposit waived alert', schedulesTheJob: false, copySwitch: 'alert_every_estimate' },
  'estimate.approval_voided': { alert: 'approval voided alert', schedulesTheJob: false, copySwitch: 'alert_every_estimate' },
  'estimate.status_corrected': { alert: 'estimate status corrected alert', schedulesTheJob: false, copySwitch: 'alert_every_estimate' },
  // #2980 - the customer picked or changed the deposit method (Ran 2026-11-04: in-app, never an email).
  'estimate.deposit_method_selected': { alert: 'deposit method alert', schedulesTheJob: false, copySwitch: 'alert_every_estimate' },
};

export interface EstimateAlertArgs {
  verb: EstimateAlertVerb;
  organizationId: string;
  /** The person who did it; null for the customer on a public page and for a payment processor's own report. */
  actorId: string | null;
  estimateId: string;
  /** Extra display data kept on the alert (the add-ons the customer chose, the decline reason). */
  data?: Record<string, unknown>;
  /** Doors that report one event (an approval can come in four ways) share a key, so the alert goes out once. */
  dedupKey?: string;
}

export async function alertEstimate(args: EstimateAlertArgs): Promise<void> {
  try {
    const { organizationId } = args;
    const row = ESTIMATE_ROWS[args.verb];
    if (args.dedupKey) {
      const sent = await prisma.notification.findFirst({
        where: { organization_id: organizationId, dedup_key: { in: [args.dedupKey, args.dedupKey + WHY_KEY] } },
        select: { id: true },
      });
      if (sent) return;
    }

    const crew = { visits: { select: { assignees: { select: { user_id: true } } } } } as const;
    const estimate = await prisma.estimate.findFirst({
      where: { id: args.estimateId, organization_id: organizationId },
      select: {
        estimate_number: true, lead_id: true, job_id: true,
        lead: { select: { commission_owner_id: true, dispatcher_id: true, ...crew } },
        job_link: { select: { salesperson_id: true, dispatcher_id: true, ...crew } },
      },
    });
    if (!estimate) return;

    // The estimate's record: its job when it has one, else its lead, else nothing. Its Owner is the Owner of its lead.
    const tie = tieOf({ type: 'estimate', jobId: estimate.job_id, leadId: estimate.lead_id });
    const owner = estimate.lead?.commission_owner_id ?? null;
    const job = tie.jobId ? estimate.job_link : null;
    const lead = !tie.jobId && tie.leadId ? estimate.lead : null;
    const place: EntityRef | undefined = tie.jobId ? { type: 'JOB', id: tie.jobId } : tie.leadId ? { type: 'LEAD', id: tie.leadId } : undefined;
    const recordPeople = [
      ...(owner ? [owner] : []),
      ...(job ? [...(job.salesperson_id ? [job.salesperson_id] : []), ...jobCrewIds(job)] : []),
      ...(lead ? jobCrewIds(lead) : []),
    ];
    const onAJob = Boolean(tie.jobId);

    const people = await twoLaneRecipients({
      organizationId,
      record: { type: 'ESTIMATE', id: args.estimateId },
      alsoOpen: place,
      actorId: args.actorId,
      recordPeople,
      dispatcherId: job?.dispatcher_id ?? lead?.dispatcher_id ?? null,
      stepSwitch: row.schedulesTheJob || onAJob ? 'assign_people_to_jobs' : 'assign_people_to_leads',
      copySwitch: row.copySwitch,
      noDispatcherReason: place ? undefined : ESTIMATE_WITHOUT_LEAD_OR_JOB_STEM,
      words: {
        record: onAJob ? 'job' : 'lead',
        step: row.schedulesTheJob || onAJob ? 'assign people to jobs' : 'assign people to leads',
        alert: row.alert,
      },
    });

    await sendByWhyLine(people, (entity, whyLine) =>
      emit({
        verb: args.verb,
        organizationId,
        actorId: args.actorId,
        object: { type: 'ESTIMATE', id: args.estimateId, label: estimate.estimate_number },
        // `commission_owner_id` is for the priority only: the estimate's Owner is interrupted by a win, a decline or a deposit.
        entity: { ...entity, commission_owner_id: owner },
        data: { ...(args.data ?? {}), object_label: estimate.estimate_number, fallback_reason: whyLine ?? '' },
        ...(args.dedupKey ? { dedupKey: whyLine ? args.dedupKey + WHY_KEY : args.dedupKey } : {}),
      }));
  } catch (err) {
    logger.warn('[leadEstimateAlerts] could not send an estimate alert', {
      verb: args.verb, estimateId: args.estimateId, error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Leave an estimate alert for after the response (or send it now where there is no request to wait for). */
export function queueEstimateAlert(args: EstimateAlertArgs): void {
  queueAlertAfterResponse({ orgId: args.organizationId, actorId: args.actorId, send: () => alertEstimate(args) });
}
