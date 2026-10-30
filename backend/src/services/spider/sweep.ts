/**
 * The Spider sweep (#2619): the server - not anyone's browser - watches each open lead's status
 * and alerts the right staff once a lead has stayed in a watched status longer than the limit its
 * company set. Registered in index.ts next to the other sweeps, every 2 minutes.
 *
 * - Which companies: those with a Spider settings row that pass the Spider gate (the `spider`
 *   feature and, while the launch is limited, a demo company or a company on the Spider pilot list,
 *   `SPIDER_PILOT_ORG_IDS`). Alerts go out only while Spider is switched on. Ending finished alerts
 *   runs for every company with a settings row, so alerts already raised still end after Spider is
 *   switched off or the gate is revoked. A company that is switched off, or no longer passes the
 *   gate, has every open alert ended by every run (D4: off means none open; SPEC-5 R10: losing
 *   access behaves like off).
 * - Which leads: every open lead (no row cap) in a stage the company switched on, or only the
 *   selected leads when "Auto-select new leads" (watch_all_leads) is off. Won, Lost and Cancelled
 *   never.
 * - Stage and time in it: the lead's stage and the instant it entered it come from the lead's own
 *   timestamps, by the contractor's rules (config.ts `spiderStageOf`, Ran 15 Oct). Time is now minus
 *   that instant - never floored at when Spider was switched on (#2794): the starting summary is what
 *   keeps switching on from alerting every old lead at once. Ran, 27 Oct: switching back on reports
 *   the leads already past their limit at once, in the summary, rather than after a full limit
 *   counted from the switch-on.
 * - Starting summary (#2794, summary.ts): while a starting trigger is waiting, the company alerts
 *   nothing; once the settings have been quiet for a sweep interval - or at the latest 10 minutes
 *   after the trigger first started waiting, however many saves follow - the backlog past its limit
 *   and not yet claimed in this switched-on period becomes one summary per recipient instead of one
 *   alert per lead, and the trigger is cleared (only if no newer one landed meanwhile; that one waits
 *   afresh). A summary that fails keeps the trigger and is tried again on the next run, until the
 *   same 10 minutes are up: then the trigger is dropped, logged, and the per-lead path takes over.
 * - Once per lead per stage visit per switched-on period: the alert-log row (an alert or a summary's
 *   claim) is inserted first; its unique key (company, lead, stage, entered-stage instant,
 *   counted-from) is the claim. Counted-from is the later of the entered-stage instant and
 *   activated_at: it names the switched-on period, and no longer sets when the limit is reached. Only
 *   a successful claim sends. A unique-key collision is "already alerted in this switched-on period";
 *   any other failure sends nothing and is logged. Switching back on moves counted-from, so a lead
 *   still in the same stage is reported once more (D5), in the switch-on's summary. A per-lead
 *   re-alert ends any earlier card still open for the lead, so it never shows two.
 *   An alert in flight re-checks the switch before it claims and before it sends (stillOn), so a
 *   switch-off during a run raises nothing more and ends the alert it was raising.
 * - Ending: an unread spider.alert whose lead has left the alerted stage visit (another stage or
 *   none, or the same stage entered again later) is marked read for every recipient.
 *
 * One instance across servers (a transaction-scoped advisory lock held for the run) and never two
 * overlapping runs in one process. One company's failure never stops the others. Logs carry ids
 * only.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { env } from '../../config/env';
import { runUnscoped, runWithOrg } from '../../lib/tenant-context';
import { LEAD_STATUS_LABEL } from '../lead-stage.service';
import { emit } from '../notifications/notificationService';
import { SPIDER_ALERT_VERB, SPIDER_FRAME_VERB } from '../notifications/bellHiddenVerbs';
import {
  SPIDER_LEAD_TIMES_SELECT,
  SPIDER_WATCHED_STATUSES,
  customerName,
  limitMs,
  readChannels,
  readRecipients,
  readStatusLimits,
  spiderStageOf,
  type SpiderChannels,
  type SpiderRecipients,
  type SpiderStatus,
  type SpiderUnit,
} from './config';
import { spiderAvailableForOrg } from './gate';
import { SUMMARY_MAX_WAIT_MS, SUMMARY_QUIET_MS, runStartingSummary } from './summary';
import { isTriggerKind } from './summaryMessages';
import { resolveSpiderRecipients } from './recipients';
import {
  EMAIL_OUTCOME,
  SPIDER_EMAIL_FROM_LINE,
  SPIDER_OFF_REASON,
  TEXT_OUTCOME,
  channelRecord,
  deliverSpiderEmails,
  deliverSpiderTexts,
  type ChannelDelivery,
  type ChannelRecord,
} from './delivery';
import {
  SPIDER_STAGE_NAME,
  formatHumanReadableDuration,
  resolveServiceAddress,
  spiderAlertHeader,
  spiderAssignedUserName,
  spiderFullTextMessage,
  spiderStageSentence,
  type SpiderMessageContent,
} from './messages';

export { SPIDER_ALERT_VERB };
/** Both per-person Spider records, both bell-hidden: the in-app alert, and the red-frame-only record. */
export const SPIDER_RECORD_VERBS = [SPIDER_ALERT_VERB, SPIDER_FRAME_VERB] as const;
const SWEEP_LOCK_KEY = 'spider.sweep';
const LOCATION_SELECT = {
  address_line1: true,
  address_line2: true,
  city: true,
  state: true,
  zip: true,
  is_primary: true,
} as const;
// The lock lives as long as the transaction holding it, so this bounds a run. Far beyond any real
// run (seconds), and if one ever overran, the alert log's unique claim still prevents double sends.
const SWEEP_LOCK_TIMEOUT_MS = 55 * 60_000;

export interface SpiderSweepResult {
  ran: boolean;
  companies: number;
  leadsChecked: number;
  alertsSent: number;
  alertsEnded: number;
  /** Leads reported in starting summaries this run. */
  leadsSummarized: number;
}

const NOT_RUN: SpiderSweepResult = { ran: false, companies: 0, leadsChecked: 0, alertsSent: 0, alertsEnded: 0, leadsSummarized: 0 };

let inFlight = false;

/** Never throws. `now` is injectable so tests can run the sweep at chosen clock times. */
export async function runSpiderSweep(now: Date = new Date()): Promise<SpiderSweepResult> {
  if (inFlight) {
    logger.warn('[spider] previous sweep still running - skipping this run');
    return NOT_RUN;
  }
  inFlight = true;
  try {
    return await runUnscoped(() => withSweepLock(() => sweepAllCompanies(now)));
  } catch (err) {
    logger.error(`[spider] sweep failed: ${errorName(err)}`);
    return NOT_RUN;
  } finally {
    inFlight = false;
  }
}

/** Test-only: true while a sweep is running in this process. */
export function _spiderSweepInFlight(): boolean {
  return inFlight;
}

/**
 * The lock is held by a transaction on a connection of its OWN, not by one of the app client's. The deployed database
 * pool holds a single connection: a lock transaction on the app's client would pin it for the whole run, and the work
 * below (which runs on that client) would wait for a second one that never comes, fail after the pool timeout, and
 * keep every other request waiting too. The extra connection lives only for the run.
 */
function openLockClient(): PrismaClient {
  const url = new URL(env.DATABASE_URL);
  url.searchParams.set('connection_limit', '1');
  // The cast is type-only. Returning the options-typed client as the default PrismaClient makes tsc relate two
  // instantiations of the whole generated client, which alone cost ~570k types / ~4M instantiations and put
  // `tsc -p tsconfig.build.json` within ~2% of the 2 GB heap CI gives it (every new model tipped it over).
  return new PrismaClient({ datasources: { db: { url: url.toString() } } }) as unknown as PrismaClient;
}

async function withSweepLock(fn: () => Promise<SpiderSweepResult>): Promise<SpiderSweepResult> {
  const lockClient = openLockClient();
  try {
    return await lockClient.$transaction(
      async (tx) => {
        const [row] = await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(hashtextextended(${SWEEP_LOCK_KEY}, 0)) AS locked`;
        if (!row?.locked) {
          logger.info('[spider] another server is running the sweep - skipping this run');
          return NOT_RUN;
        }
        // The work runs on the app's client, not `tx`: this transaction exists only to hold the lock.
        return fn();
      },
      { timeout: SWEEP_LOCK_TIMEOUT_MS, maxWait: 10_000 },
    );
  } finally {
    await lockClient.$disconnect().catch(() => undefined);
  }
}

async function sweepAllCompanies(now: Date): Promise<SpiderSweepResult> {
  const result: SpiderSweepResult = { ran: true, companies: 0, leadsChecked: 0, alertsSent: 0, alertsEnded: 0, leadsSummarized: 0 };
  const rows = await prisma.spiderSettings.findMany({
    select: {
      organization_id: true,
      organization: { select: { id: true, is_demo: true, plan: true, trial_ends_at: true, feature_overrides: true } },
    },
    orderBy: { organization_id: 'asc' },
  });
  for (const row of rows) {
    const orgId = row.organization_id;
    const available = spiderAvailableForOrg(row.organization);
    if (available) result.companies += 1;
    try {
      const r = await runWithOrg(orgId, () => sweepCompany(orgId, now, available));
      result.leadsChecked += r.leadsChecked;
      result.alertsSent += r.alertsSent;
      result.alertsEnded += r.alertsEnded;
      result.leadsSummarized += r.leadsSummarized;
    } catch (err) {
      logger.error(`[spider] sweep failed for org ${orgId}: ${errorName(err)}`);
    }
  }
  return result;
}

// ─── One company ─────────────────────────────────────────────────────────────

interface StageVisit {
  id: string;
  status: SpiderStatus;
  entered_at: Date;
  /** The lead's own status now (an alert card names "Estimate" for a lead whose status is Estimate Sent). */
  lead_status: string;
  /** When the lead was created: the New sentence's "created X ago" (SPEC-4 D7). */
  created_at: Date;
}

/**
 * Each lead's current stage visit: its Spider stage and the instant it entered it (spiderStageOf).
 * Leads in no stage are left out. One query, no row cap. `open` leaves out the leads that are Won,
 * Lost or Cancelled before reading them, which spiderStageOf would leave out anyway.
 */
async function currentStageVisits(
  orgId: string,
  filter: { leadIds?: readonly string[]; open?: boolean },
): Promise<StageVisit[]> {
  if (filter.leadIds && filter.leadIds.length === 0) return [];
  const leads = await prisma.lead.findMany({
    where: {
      organization_id: orgId,
      ...(filter.leadIds ? { id: { in: [...filter.leadIds] } } : {}),
      ...(filter.open ? { status: { notIn: ['WON', 'LOST'] }, won_at: null, lost_at: null, cancelled_at: null } : {}),
    },
    select: { id: true, ...SPIDER_LEAD_TIMES_SELECT },
  });
  return leads.flatMap((l) => {
    const visit = spiderStageOf(l);
    return visit ? [{ id: l.id, status: visit.stage, entered_at: visit.enteredAt, lead_status: l.status, created_at: l.created_at }] : [];
  });
}

interface CompanyResult {
  leadsChecked: number;
  alertsSent: number;
  alertsEnded: number;
  leadsSummarized: number;
}

async function sweepCompany(orgId: string, now: Date, available: boolean): Promise<CompanyResult> {
  const alertsEnded = await endFinishedAlerts(orgId, now);
  const done = (r: Partial<CompanyResult> = {}): CompanyResult => ({
    leadsChecked: 0,
    alertsSent: 0,
    leadsSummarized: 0,
    ...r,
    alertsEnded,
  });
  // Outside the gate (removed from the pilot list, or a demo company that lost the feature or its
  // demo status): behaves like Spider off (SPEC-5 R10, Ran 24 Oct) - nothing new, and every open
  // alert is cleared for every person. History is kept.
  if (!available) {
    return { ...done(), alertsEnded: alertsEnded + (await endOpenSpiderRecords(orgId, now)) };
  }
  const settings = await prisma.spiderSettings.findUnique({ where: { organization_id: orgId } });
  // Switched off: no open alert may remain (D4). The switch ends them itself; this repairs anything
  // it missed, within one run.
  if (settings && !settings.is_active) {
    return { ...done(), alertsEnded: alertsEnded + (await endOpenSpiderRecords(orgId, now)) };
  }
  if (!settings?.is_active || !settings.activated_at) return done();
  // The switched-on period this run read: alertLead re-checks it before claiming and sending, so a
  // run that began before a switch-off never alerts into it (D4).
  const activatedAt = settings.activated_at;

  // A starting trigger still in its quiet period: alert nothing yet, so the backlog it brings under
  // watch arrives as one summary rather than one alert per lead, and several quick saves give one.
  // Never longer than SUMMARY_MAX_WAIT_MS from when it first started waiting, so saves that keep
  // coming cannot hold every alert back.
  const trigger = settings.summary_trigger_at;
  const waitingSince = settings.summary_trigger_since ?? trigger;
  const waitedOut = !!waitingSince && now.getTime() - waitingSince.getTime() >= SUMMARY_MAX_WAIT_MS;
  if (trigger && now.getTime() - trigger.getTime() < SUMMARY_QUIET_MS && !waitedOut) return done();

  const limits = readStatusLimits(settings.status_limits);
  const visits = SPIDER_WATCHED_STATUSES.some((s) => limits[s].enabled)
    ? (
        await currentStageVisits(orgId, {
          leadIds: settings.watch_all_leads ? undefined : settings.selected_lead_ids,
          open: true,
        })
      ).filter((v) => limits[v.status].enabled)
    : [];

  // Time in the stage counts from when the lead entered it (#2794). countedFrom, the later of that and
  // activated_at, only names the switched-on period in the claim key (D5).
  const overdue = visits.flatMap((v) => {
    const limit = limits[v.status];
    const countedFrom = v.entered_at > activatedAt ? v.entered_at : activatedAt;
    return now.getTime() - v.entered_at.getTime() >= limitMs(limit.value, limit.unit) ? [{ ...v, countedFrom, limit }] : [];
  });

  // Skip visits already alerted (or summarized) in this switched-on period before doing any work for
  // them, by the same five parts as the unique key. The insert is still the authoritative claim; this
  // only keeps a long-overdue lead from costing a recipient lookup on every run.
  const existing = overdue.length
    ? await prisma.spiderAlert.findMany({
        where: { organization_id: orgId, lead_id: { in: overdue.map((o) => o.id) } },
        select: { lead_id: true, status: true, entered_status_at: true, counted_from: true },
      })
    : [];
  const claimed = new Set(existing.map((e) => visitKey(e.lead_id, e.status, e.entered_status_at, e.counted_from)));
  const unclaimed = overdue.filter((o) => !claimed.has(visitKey(o.id, o.status, o.entered_at, o.countedFrom)));
  // Visits alerted in any switched-on period: an alert for one of these is a re-alert (D5).
  const visitedBefore = new Set(existing.map((e) => stageVisitKey(e.lead_id, e.status, e.entered_status_at)));

  const channels = readChannels(settings.channels);
  const recipientsConfig = readRecipients(settings.recipients);

  if (trigger) {
    let leadsSummarized = 0;
    let failed = false;
    try {
      const r = await runStartingSummary({
        orgId,
        now,
        triggeredAt: trigger,
        triggerKind: isTriggerKind(settings.summary_trigger_kind) ? settings.summary_trigger_kind : 'SETTINGS_CHANGED',
        overdue: unclaimed.map((o) => ({ id: o.id, status: o.status, entered_at: o.entered_at, counted_from: o.countedFrom, limit: o.limit })),
        channels,
        recipientsConfig,
      });
      leadsSummarized = r.leads;
    } catch (err) {
      failed = true;
      logger.error(`[spider] starting summary failed for org ${orgId}: ${errorName(err)}`);
    }
    if (failed && !waitedOut) {
      // Nothing was written (summary.ts claims all-or-nothing): keep the trigger and try again on the
      // next run. No per-lead alert meanwhile, or the backlog would flood.
      return done({ leadsChecked: visits.length });
    }
    if (failed) {
      logger.error(`[spider] starting summary gave up for org ${orgId} after waiting since ${waitingSince!.toISOString()}: alerting per lead from the next run`);
    }
    // Cleared only if no newer trigger landed during this run; a newer one starts its own wait.
    const { count } = await prisma.spiderSettings.updateMany({
      where: { organization_id: orgId, summary_trigger_at: trigger },
      data: { summary_trigger_at: null, summary_trigger_kind: null, summary_trigger_since: null },
    });
    if (count === 0) {
      await prisma.spiderSettings.updateMany({
        where: { organization_id: orgId, summary_trigger_at: { not: null } },
        data: { summary_trigger_since: now },
      });
    }
    return done({ leadsChecked: visits.length, leadsSummarized });
  }

  let alertsSent = 0;
  for (const o of unclaimed) {
    try {
      const sent = await alertLead({
        orgId,
        now,
        leadId: o.id,
        status: o.status,
        enteredAt: o.entered_at,
        createdAt: o.created_at,
        countedFrom: o.countedFrom,
        limit: o.limit,
        channels,
        recipientsConfig,
        activatedAt,
        priorAlertForVisit: visitedBefore.has(stageVisitKey(o.id, o.status, o.entered_at)),
      });
      if (sent) alertsSent += 1;
    } catch (err) {
      logger.error(`[spider] alert failed for org ${orgId} lead ${o.id}: ${errorName(err)}`);
    }
  }
  return done({ leadsChecked: visits.length, alertsSent });
}

/** The claim's identity: the stage visit and the switched-on period (its counted-from instant). */
function visitKey(leadId: string, status: string, enteredAt: Date, countedFrom: Date): string {
  return `${stageVisitKey(leadId, status, enteredAt)}|${countedFrom.getTime()}`;
}

/** The stage visit alone, whichever switched-on period alerted it. */
function stageVisitKey(leadId: string, status: string, enteredAt: Date): string {
  return `${leadId}|${status}|${enteredAt.getTime()}`;
}

// ─── One alert ───────────────────────────────────────────────────────────────

async function alertLead(a: {
  orgId: string;
  now: Date;
  leadId: string;
  status: SpiderStatus;
  enteredAt: Date;
  /** When the lead was created, for the New sentence (SPEC-4 D7). */
  createdAt: Date;
  countedFrom: Date;
  limit: { value: number; unit: SpiderUnit };
  channels: SpiderChannels;
  recipientsConfig: SpiderRecipients;
  /** The switched-on period this run read (settings.activated_at); see stillOn. */
  activatedAt: Date;
  /** This stage visit was alerted in an earlier switched-on period: this alert is a re-alert (D5). */
  priorAlertForVisit: boolean;
}): Promise<boolean> {
  const lead = await prisma.lead.findFirst({
    where: { id: a.leadId, organization_id: a.orgId },
    select: {
      id: true,
      lead_number: true,
      customer_id: true,
      service_request: true,
      commission_owner_id: true,
      commission_owner: { select: { first_name: true, last_name: true } },
      lead_assignees: {
        select: { user: { select: { first_name: true, last_name: true } } },
        orderBy: { created_at: 'asc' },
        take: 1,
      },
      customer: {
        select: {
          first_name: true,
          last_name: true,
          company_name: true,
          // His fallback is the primary location, else the first: one row, primary first.
          service_locations: { select: LOCATION_SELECT, orderBy: [{ is_primary: 'desc' }, { created_at: 'asc' }], take: 1 },
        },
      },
      service_location: { select: LOCATION_SELECT },
    },
  });
  if (!lead) return false;

  const recipients = await resolveSpiderRecipients(prisma, {
    orgId: a.orgId,
    leadId: lead.id,
    ownerId: lead.commission_owner_id,
    recipients: a.recipientsConfig,
  });
  // Nobody at all - not even an Admin - can sign in and open this lead: claim nothing, so the
  // visit can still alert once someone it would reach exists.
  if (recipients.length === 0) return false;

  const statusLabel = LEAD_STATUS_LABEL[a.status];
  // The contractor's message content (services/spider/messages.ts). Time in the stage is counted
  // from the instant the lead entered it, as his sentence says ("This lead was created 2 days ago").
  const timeInStage = formatHumanReadableDuration(Math.floor((a.now.getTime() - a.enteredAt.getTime()) / 1000));
  // The New sentence says "This lead was created X ago": X counts from the lead's creation. For a
  // first New stay that is the stage's own entry instant; for a lead moved back to New (SPEC-4 D7)
  // the stay is younger than the lead, and the sentence must stay true.
  const sentenceTime =
    a.status === 'NEW'
      ? formatHumanReadableDuration(Math.floor((a.now.getTime() - a.createdAt.getTime()) / 1000))
      : timeInStage;
  const ownerName = lead.commission_owner
    ? `${lead.commission_owner.first_name} ${lead.commission_owner.last_name}`.trim() || null
    : null;
  const content: SpiderMessageContent = {
    leadNumber: lead.lead_number || `Lead #${lead.id.slice(0, 6)}`,
    customerName: customerName(lead.customer),
    stage: a.status,
    timeInStage,
    sentenceTime,
    assignedTo: spiderAssignedUserName(lead),
    serviceLocation: resolveServiceAddress(lead, lead.customer),
    leadUrl: `${env.FRONTEND_URL.replace(/\/+$/, '')}/leads/${lead.id}`,
  };
  const stageSentence = spiderStageSentence(a.status, sentenceTime);

  // Check 1 (D4): switched off since this run read the settings - claim nothing, send nothing.
  if (!(await stillOn(a.orgId, a.activatedAt))) return false;

  // The claim. Written before anything is sent; only a successful insert sends. It carries the
  // History tab's copy of the lead, the people and the messages as they are now (S3, the
  // contractor's alert log): what the tab shows never changes when the lead or a person does.
  let alertId: string;
  try {
    const row = await prisma.spiderAlert.create({
      data: {
        organization_id: a.orgId,
        lead_id: lead.id,
        status: a.status,
        entered_status_at: a.enteredAt,
        counted_from: a.countedFrom,
        limit_value: a.limit.value,
        limit_unit: a.limit.unit,
        alerted_at: a.now,
        recipient_ids: recipients.map((r) => r.id),
        lead_number: content.leadNumber,
        customer_id: lead.customer_id,
        customer_name: content.customerName,
        company_name: lead.customer.company_name?.trim() || null,
        service_request: lead.service_request || null,
        service_location: content.serviceLocation,
        stage_name: SPIDER_STAGE_NAME[a.status],
        // His elapsedValue: whole units of the limit's unit, never less than 1.
        elapsed_value: Math.max(1, Math.floor((a.now.getTime() - a.enteredAt.getTime()) / limitMs(1, a.limit.unit))),
        elapsed_unit: a.limit.unit,
        // Name, email, role and how each was chosen - never a phone number.
        recipients: recipients.map((r) => ({
          id: r.id,
          name: `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || r.email,
          email: r.email,
          role: r.role,
          type: r.chosen_as,
        })),
        email_subject: spiderAlertHeader(content),
        email_body: spiderFullTextMessage(content),
        sms_message: spiderFullTextMessage(content),
        in_app_message: stageSentence,
        channels: {
          email: { enabled: a.channels.email },
          sms: { enabled: a.channels.text },
          in_app: { enabled: a.channels.in_app },
        },
      },
      select: { id: true },
    });
    alertId = row.id;
  } catch (err) {
    // Already alerted for this visit in this switched-on period.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return false;
    logger.error(`[spider] could not record the alert for org ${a.orgId} lead ${lead.id} - nothing sent: ${errorName(err)}`);
    return false;
  }

  // A re-alert replaces any card still open for this lead (D5): the lead never shows two. Any open
  // record for it is an earlier period's alert for this same visit, or an older visit's that
  // endFinishedAlerts already ended at the start of this run. Only ends records, and never fails the
  // new alert over what is only a duplicate on screen.
  if (a.priorAlertForVisit) {
    try {
      await endOpenSpiderRecords(a.orgId, a.now, { leadId: lead.id });
    } catch (err) {
      logger.error(`[spider] could not end the earlier alert for org ${a.orgId} lead ${lead.id}: ${errorName(err)}`);
    }
  }

  const delivery: Record<string, ChannelDelivery> = {};
  // The History tab's per-channel outcome (his alert log's `channels`): email, sms, in_app.
  const channels: { email?: ChannelRecord; sms?: ChannelRecord; in_app?: { enabled: boolean; status: 'SENT' | 'SKIPPED' } } = {
    in_app: { enabled: false, status: 'SKIPPED' },
  };

  // Stored at alert time, as the contractor's in-app data was: the popup card reads these, and the
  // ending rule reads `status` and `entered_status_at`.
  const notificationData = {
    object_label: content.leadNumber,
    spider_alert_id: alertId,
    lead_id: lead.id,
    lead_number: content.leadNumber,
    customer_name: content.customerName,
    company_name: lead.customer.company_name?.trim() || null,
    status: a.status,
    status_label: statusLabel,
    stage_name: SPIDER_STAGE_NAME[a.status],
    service_location: content.serviceLocation,
    service_request: lead.service_request || null,
    assigned_to: content.assignedTo,
    address: content.serviceLocation,
    owner_name: ownerName,
    entered_status_at: a.enteredAt.toISOString(),
    stage_entered_at: a.enteredAt.toISOString(),
    // The pop-up rebuilds the New sentence ("created X ago") live from this, not from the stay (SPEC-4 D7).
    lead_created_at: a.createdAt.toISOString(),
    counted_from: a.countedFrom.toISOString(),
    time_in_status: timeInStage,
    time_in_stage: timeInStage,
    title: spiderAlertHeader(content),
    body: stageSentence,
    full_message: spiderFullTextMessage(content),
    lead_url: content.leadUrl,
  };

  if (a.channels.in_app) {
    const notified = await emit({
      verb: SPIDER_ALERT_VERB,
      organizationId: a.orgId,
      actorId: null,
      object: { type: 'LEAD', id: lead.id, label: content.leadNumber },
      entity: { recipient_ids: recipients.map((r) => r.id) },
      data: notificationData,
      dedupKey: `${SPIDER_ALERT_VERB}:${alertId}`,
    });
    delivery.in_app = { outcome: notified.length > 0 ? 'Shown in the app' : 'No one to alert in the app' };
    channels.in_app = { enabled: true, status: notified.length > 0 ? 'SENT' : 'SKIPPED' };
  } else {
    // His Red Frame works on its own: with in-app alerts off, each recipient still gets a record so
    // the frame shows (and ends when the lead leaves the stage), and the bell never lists it.
    if (a.channels.red_frame) {
      await recordFrameOnly({ orgId: a.orgId, leadId: lead.id, alertId, recipientIds: recipients.map((r) => r.id), content, stageSentence, data: notificationData });
    }
    delivery.in_app = { outcome: 'In-app alerts are switched off' };
  }

  // Check 2 (D4), after the in-app or frame record is written and before any email: the switch
  // writes the flag and then ends the open records, this writes the records and then checks. So
  // either the switch's clear sees these records, or this check sees the switch, and ends them.
  const wroteRecord = a.channels.in_app || a.channels.red_frame;
  let switchedOff = (wroteRecord || a.channels.email || a.channels.text) && !(await stillOnAfterClaim(a.orgId, a.activatedAt, alertId));
  const skippedAsOff = recipients.map((r) => ({ user_id: r.id, result: 'skipped' as const, reason: SPIDER_OFF_REASON }));

  if (a.channels.email && !switchedOff) {
    const sent = await deliverSpiderEmails({ orgId: a.orgId, alertId, recipients, content });
    delivery.email = { outcome: sent.outcome, recipients: sent.recipients };
    channels.email = { ...channelRecord(true, sent.results), from: SPIDER_EMAIL_FROM_LINE };
    // Check 3 (D4), after the email and before the text.
    if (a.channels.text) switchedOff = !(await stillOnAfterClaim(a.orgId, a.activatedAt, alertId));
  } else if (a.channels.email) {
    delivery.email = { outcome: EMAIL_OUTCOME.spiderOff };
    channels.email = { ...channelRecord(true, skippedAsOff), from: SPIDER_EMAIL_FROM_LINE };
  } else {
    delivery.email = { outcome: EMAIL_OUTCOME.channelOff };
    channels.email = { ...channelRecord(false, []), from: SPIDER_EMAIL_FROM_LINE };
  }

  if (a.channels.text && !switchedOff) {
    const sent = await deliverSpiderTexts({ orgId: a.orgId, alertId, recipients, content });
    delivery.text = { outcome: sent.outcome, recipients: sent.recipients };
    channels.sms = channelRecord(true, sent.results);
  } else if (a.channels.text) {
    delivery.text = { outcome: TEXT_OUTCOME.spiderOff };
    channels.sms = channelRecord(true, skippedAsOff);
  } else {
    delivery.text = { outcome: TEXT_OUTCOME.channelOff };
    channels.sms = channelRecord(false, []);
  }

  if (switchedOff) {
    try {
      await endOpenSpiderRecords(a.orgId, a.now, { alertId });
    } catch (err) {
      // The next run ends it: an off company's open records are ended by every run (sweepCompany).
      logger.error(`[spider] could not end alert ${alertId} after a switch-off: ${errorName(err)}`);
    }
  }

  try {
    await prisma.spiderAlert.update({
      where: { id: alertId },
      data: {
        delivery: delivery as unknown as Prisma.InputJsonValue,
        channels: channels as unknown as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    logger.error(`[spider] could not record delivery for alert ${alertId}: ${errorName(err)}`);
  }
  if (switchedOff) {
    logger.info('[spider] switched off during an alert', { orgId: a.orgId, leadId: lead.id, alertId });
    return false;
  }
  logger.info('[spider] alert sent', { orgId: a.orgId, leadId: lead.id, alertId, recipients: recipients.length });
  return true;
}

/**
 * Spider is still on for this company, in the same switched-on period this run read. One
 * primary-key read. A switch-off, or an off-then-on (a new activated_at), stops the rest of the run,
 * so a run from an earlier period never alerts into a later one. No lock: the sweep's single
 * connection must never wait on the switch, and no lock could recall a send already handed over.
 */
async function stillOn(orgId: string, activatedAt: Date): Promise<boolean> {
  const row = await prisma.spiderSettings.findUnique({
    where: { organization_id: orgId },
    select: { is_active: true, activated_at: true },
  });
  return row?.is_active === true && row.activated_at?.getTime() === activatedAt.getTime();
}

/**
 * Checks 2 and 3, once the visit is claimed. A failed read counts as still on: these checks exist
 * only to stop sends once Spider is off, and an unreadable switch is not a switch-off. Counting it
 * as off would end a live alert and write "Spider was switched off" into History when it may not
 * be, and the claim means that visit never alerts again. Carrying on is what the alert did before
 * the checks existed; if Spider really was off, the next run ends its open records (sweepCompany).
 * Never throws, so the rest of the alert, its delivery record included, always runs.
 */
async function stillOnAfterClaim(orgId: string, activatedAt: Date, alertId: string): Promise<boolean> {
  try {
    return await stillOn(orgId, activatedAt);
  } catch (err) {
    logger.error(`[spider] could not check the switch for org ${orgId} alert ${alertId} - carrying on: ${errorName(err)}`);
    return true;
  }
}

/**
 * The red-frame-only record: one bell-hidden `spider.frame` notification for the alert, one unread
 * row per recipient (the same people the email and text reach, already access-checked). Written
 * directly rather than through emit(), so no bell template, toast or realtime ping is involved.
 */
async function recordFrameOnly(r: {
  orgId: string;
  leadId: string;
  alertId: string;
  recipientIds: string[];
  content: SpiderMessageContent;
  stageSentence: string;
  data: Record<string, unknown>;
}): Promise<void> {
  if (r.recipientIds.length === 0) return;
  try {
    const n = await prisma.notification.create({
      data: {
        organization_id: r.orgId,
        actor_id: null,
        verb: SPIDER_FRAME_VERB,
        category: 'LEAD',
        priority: 'FEED',
        needs_action: false,
        object_type: 'LEAD',
        object_id: r.leadId,
        object_label: r.content.leadNumber,
        title: spiderAlertHeader(r.content),
        body: r.stageSentence,
        data: r.data as Prisma.InputJsonValue,
        dedup_key: `${SPIDER_FRAME_VERB}:${r.alertId}`,
      },
      select: { id: true },
    });
    await prisma.notificationRecipient.createMany({
      data: r.recipientIds.map((id) => ({
        notification_id: n.id,
        organization_id: r.orgId,
        recipient_id: id,
        priority: 'FEED' as const,
      })),
    });
  } catch (err) {
    logger.error(`[spider] could not record the red frame for alert ${r.alertId}: ${errorName(err)}`);
  }
}

// ─── Ending alerts ───────────────────────────────────────────────────────────

/** What an alert remembers about the stage visit it was raised for (its notification data). */
export interface AlertedVisit {
  leadId: string;
  status: string;
  enteredAt: string;
}

export function alertedVisitOf(objectId: string, data: unknown): AlertedVisit {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  return {
    leadId: objectId,
    status: typeof d.status === 'string' ? d.status : '',
    enteredAt: typeof d.entered_status_at === 'string' ? d.entered_status_at : '',
  };
}

/** Each lead's current stage visit, for these leads of this company (leads in no stage are absent). */
export async function currentVisitsByLead(orgId: string, leadIds: readonly string[]): Promise<Map<string, StageVisit>> {
  const visits = await currentStageVisits(orgId, { leadIds: [...new Set(leadIds)] });
  return new Map(visits.map((v) => [v.id, v]));
}

/**
 * Whether the lead has left the alerted stage visit: a different stage now or none, the same stage
 * entered again at a later instant, or the lead is gone. The one rule for ending an alert - the
 * sweep marks such alerts read, and the unread-alerts list leaves them out at once.
 */
export function hasLeftAlertedVisit(alerted: AlertedVisit, visit: StageVisit | undefined): boolean {
  return !visit || visit.status !== alerted.status || visit.entered_at.toISOString() !== alerted.enteredAt;
}

/**
 * Marks read every unread Spider record (in-app alert or red-frame-only) in this company whose
 * lead has left the alerted stage visit (hasLeftAlertedVisit). Touches Spider rows only, and only
 * this company's.
 */
async function endFinishedAlerts(orgId: string, now: Date): Promise<number> {
  const open = await prisma.notificationRecipient.findMany({
    where: { organization_id: orgId, read_at: null, notification: { verb: { in: [...SPIDER_RECORD_VERBS] } } },
    select: { notification: { select: { id: true, object_id: true, data: true } } },
  });
  if (open.length === 0) return 0;

  const alerted = new Map<string, AlertedVisit>();
  for (const { notification: n } of open) alerted.set(n.id, alertedVisitOf(n.object_id, n.data));

  const current = await currentVisitsByLead(orgId, [...alerted.values()].map((v) => v.leadId));
  const finished = [...alerted.entries()]
    .filter(([, a]) => hasLeftAlertedVisit(a, current.get(a.leadId)))
    .map(([notificationId]) => notificationId);
  if (finished.length === 0) return 0;

  const { count } = await prisma.notificationRecipient.updateMany({
    where: { organization_id: orgId, notification_id: { in: finished }, read_at: null },
    data: { read_at: now },
  });
  return count;
}

/**
 * Marks read every unread Spider record (both verbs) of this company; or, with scope.alertId, only
 * that alert's records; or, with scope.leadId, only that lead's (a re-alert replacing its card, D5).
 * The one way Spider ends records whatever the lead is doing (Ran, 20 Oct, D4: switching Spider off
 * ends every open alert). Read is the same "ended" marker endFinishedAlerts writes and the unread
 * list filters on. Never deletes a row, never touches the alert log (History) or any other verb, and
 * never another company's rows.
 */
export async function endOpenSpiderRecords(
  orgId: string,
  now: Date,
  scope: { alertId?: string; leadId?: string } = {},
): Promise<number> {
  const { alertId, leadId } = scope;
  const { count } = await prisma.notificationRecipient.updateMany({
    where: {
      organization_id: orgId,
      read_at: null,
      notification: {
        verb: { in: [...SPIDER_RECORD_VERBS] },
        ...(alertId ? { dedup_key: { in: SPIDER_RECORD_VERBS.map((verb) => `${verb}:${alertId}`) } } : {}),
        ...(leadId ? { object_id: leadId } : {}),
      },
    },
    data: { read_at: now },
  });
  return count;
}

// ─── Formatting ──────────────────────────────────────────────────────────────

/** An error's class name only - never its message, which can carry the values it failed on. */
function errorName(err: unknown): string {
  if (err instanceof Prisma.PrismaClientKnownRequestError) return `${err.name} ${err.code}`;
  return err instanceof Error ? err.name : 'unknown error';
}
