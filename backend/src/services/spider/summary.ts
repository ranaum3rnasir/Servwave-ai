/**
 * Spider's starting summary (#2794).
 *
 * When Spider starts watching something new - it is switched on, a stage is switched on, a limit is
 * shortened, or more leads come under watch - the leads already past their limit are not alerted one
 * by one. Each recipient gets ONE starting summary of exactly the leads they would have been alerted
 * about, and from then on every lead alerts normally the moment it crosses its limit.
 *
 * - The trigger: the switch route and the settings save record the moment (and kind) on the settings
 *   row (`summaryTriggerOf`, `mergeTriggerKind`).
 * - The quiet period: the sweep acts on a trigger only once it is a sweep interval old, so several
 *   quick saves give one summary. Until then it alerts nothing for that company.
 * - The claims: every summarized lead stay gets its alert-log row (kind SUMMARIZED, linked to the
 *   summary) with the same unique claim key and recipient list as an alert (the list is stored once in a
 *   recipient set the row points at, recipientSets.ts), so the per-lead path skips it for the rest of the switched-on
 *   period. Lead stays already alerted in this period are already claimed, so only the new backlog is left: no list of
 *   "what is new" is needed. Switching back on starts a new period, so a lead still stuck is in that switch-on's summary (D5).
 * - Recipients: Spider's one recipient rule per lead (recipients.ts), asked for all the summary's
 *   leads in one batched lookup. A person's summary is the summarized leads whose recipient list
 *   includes them.
 * - Delivery: the bell (one notification per person, no toast and no red frame), the email and the
 *   text, through Spider's delivery module. Nothing overdue means no summary and no message.
 * - Only the latest summary of a company is current. An older one is marked SUPERSEDED, never deleted: its leads keep
 *   their claim and their link to it, and not one of their rows is rewritten (#3108). Switching Spider on with nothing
 *   overdue supersedes the old one too (each turn-on replaces it); other triggers with nothing overdue leave it.
 *
 * Written in small saved pieces (#3108, summaryRuns.ts), with no interactive transaction anywhere:
 *   1. A run row is made with the summary (status BUILDING: nobody can read it, History leaves its claims out), and the
 *      attempt is counted and saved BEFORE anything is read or written for it, so a run killed while it plans still counts.
 *   2. The leads, their people and the company's time zone are read; a failure from here on is the attempt's, not the sweep's.
 *   3. The claims go in statements of at most SUMMARY_CLAIMS_PER_STATEMENT, each saved on its own and followed by the run's
 *      cursor (the last lead saved). A run that stops, or fails, resumes after the cursor: what was saved is not written
 *      again (the unique claim key skips it).
 *   4. After the last claim the delivery is read back from what is saved, the summary is made READY in ONE statement and that
 *      statement is the claim on the delivery: only the run that flipped it delivers (bell, email, text) and records the
 *      outcome once on the summary row. A READY summary is never superseded by a stop: the next run finishes the bell for
 *      whoever has not got it and starts no email or text channel that was already started (at most one of each per person).
 *   5. An attempt that fails, or is killed, waits 2, 8, then 30 minutes. After 3 attempts the run is ABANDONED: the claims it
 *      saved are released (so the per-lead path can reach those leads), the summary is SUPERSEDED, it is logged once, and the
 *      company falls back to the capped per-lead alerts (runCaps.ts).
 *
 * Logs carry ids only.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { env } from '../../config/env';
import { DEFAULT_TIMEZONE } from '../../lib/timezone';
import { LEAD_STATUS_LABEL } from '../lead-stage.service';
import { emit } from '../notifications/notificationService';
import { SWEEP_PAGE_SIZE, allKeysetPages, inChunks, inChunksOfBytes } from './pages';
import {
  SPIDER_LEAD_TIMES_SELECT,
  customerName,
  limitMs,
  readStatusLimits,
  spiderStageOf,
  type SpiderChannels,
  type SpiderRecipients,
  type SpiderStatus,
  type SpiderUnit,
} from './config';
import { resolveSpiderRecipientsForLeads, type SpiderRecipient } from './recipients';
import { recipientSetIds } from './recipientSets';
import { countSentTexts, recordDeliveries } from './alertLog';
import {
  EMAIL_OUTCOME,
  EMAIL_REASON,
  SPIDER_EMAIL_FROM_LINE,
  TEXT_OUTCOME,
  TEXT_REASON,
  channelRecord,
  deliverSpiderEmailsTo,
  deliverSpiderTextsTo,
  type ChannelDelivery,
  type RecipientResult,
  type SpiderContact,
} from './delivery';
import {
  READABLE_SUMMARY,
  SUMMARY_CLAIMS_PER_STATEMENT,
  SUMMARY_MAX_ATTEMPTS,
  createRun,
  deliveryProgress,
  endEmptySummary,
  errorName,
  findOpenRun,
  finishRun,
  giveUp,
  logGaveUp,
  markChannelDone,
  markChannelStarted,
  markReady,
  readySummaryOfTrigger,
  recordDelivery,
  recordFailure,
  saveCursor,
  startAttempt,
  supersedeCurrentSummary,
  type DeliveryProgress,
  type OpenRun,
} from './summaryRuns';
import { SPIDER_STAGE_NAME, resolveServiceAddress } from './messages';
import {
  SUMMARY_BELL_BODY,
  isTriggerKind,
  mostOverdueFirst,
  overByMs,
  summaryBellTitle,
  summaryDuration,
  summaryEmailHtml,
  summaryEmailSubject,
  summaryEmailText,
  summaryTextEmailed,
  summaryTextWithLink,
  triggerWhen,
  type SpiderTriggerKind,
  type SummaryLead,
} from './summaryMessages';

export const SPIDER_SUMMARY_VERB = 'spider.starting_summary';
/** The sweep's interval: a trigger is acted on once the settings have been quiet this long. */
export const SUMMARY_QUIET_MS = 2 * 60_000;
/**
 * The longest a trigger waits from when it first started waiting: the sweep acts then even if saves
 * keep coming, and stops retrying a summary that keeps failing (the per-lead path takes over).
 */
export const SUMMARY_MAX_WAIT_MS = 10 * 60_000;
/**
 * The most JSON text of claim rows one insert carries (#3107, #3108): under 1 MB, and no more than the largest statement
 * the sweep already sends (the delivery records' update, about 805 KB for 60 people), so no statement of a summary for
 * thousands of leads and dozens of people grows with the leads. A claim row is about 3 KB for 60 people, so this carries
 * about 260 of them (SUMMARY_CLAIMS_PER_STATEMENT, 500, bounds a company with fewer people).
 */
export const SUMMARY_CLAIMS_INSERT_BYTES = 800_000;
/** Where the bell, the email button and the text link lead. */
export const SPIDER_SUMMARY_PATH = '/spider/summary';

export const spiderSummaryUrl = () => `${env.FRONTEND_URL.replace(/\/+$/, '')}${SPIDER_SUMMARY_PATH}`;
const leadUrl = (leadId: string) => `${env.FRONTEND_URL.replace(/\/+$/, '')}/leads/${leadId}`;

// ─── Triggers ────────────────────────────────────────────────────────────────

/** What a settings save compares, before and after. */
export interface WatchedScope {
  status_limits: Prisma.JsonValue;
  /** The leads Spider does not watch (#3434): every other open lead is watched. */
  excluded_lead_ids: readonly string[];
}

/**
 * Whether a settings save starts watching something new, and how: a stage switched on, a limit
 * shortened, or more leads under watch (a lead included again: taken off the exclusion list, #3434).
 * A save that only narrows what is watched (excluding leads), or changes recipients or channels, is
 * not a trigger. Several at once read as SETTINGS_CHANGED.
 */
export function settingsTriggerKind(before: WatchedScope, after: WatchedScope): SpiderTriggerKind | null {
  const was = readStatusLimits(before.status_limits);
  const now = readStatusLimits(after.status_limits);
  const kinds = new Set<SpiderTriggerKind>();
  for (const stage of Object.keys(now) as SpiderStatus[]) {
    const a = was[stage];
    const b = now[stage];
    if (!b.enabled) continue;
    if (!a.enabled) kinds.add('STAGE_ADDED');
    else if (limitMs(b.value, b.unit) < limitMs(a.value, a.unit)) kinds.add('LIMIT_SHORTENED');
  }
  const stillExcluded = new Set(after.excluded_lead_ids);
  if (before.excluded_lead_ids.some((id) => !stillExcluded.has(id))) kinds.add('SCOPE_WIDENED');
  if (kinds.size === 0) return null;
  return kinds.size === 1 ? [...kinds][0]! : 'SETTINGS_CHANGED';
}

/**
 * The kind a new trigger records over one still waiting: switching on names the summary whatever
 * else changed in the quiet period; two different setting changes read as SETTINGS_CHANGED.
 */
export function mergeTriggerKind(pending: string | null | undefined, next: SpiderTriggerKind): SpiderTriggerKind {
  if (!isTriggerKind(pending) || pending === next) return next;
  if (pending === 'SWITCHED_ON' || next === 'SWITCHED_ON') return 'SWITCHED_ON';
  return 'SETTINGS_CHANGED';
}

// ─── The sweep step ──────────────────────────────────────────────────────────

/** A lead stay past its limit and not yet claimed, as the sweep found it. */
export interface OverdueVisit {
  id: string;
  status: SpiderStatus;
  entered_at: Date;
  /** The claim key's switched-on period: the later of entered_at and activated_at (sweep.ts). */
  counted_from: Date;
  limit: { value: number; unit: SpiderUnit };
}

const LEAD_SELECT = {
  id: true,
  lead_number: true,
  customer_id: true,
  service_request: true,
  commission_owner_id: true,
  commission_owner: { select: { first_name: true, last_name: true } },
  customer: {
    select: {
      first_name: true,
      last_name: true,
      company_name: true,
      service_locations: {
        select: { address_line1: true, address_line2: true, city: true, state: true, zip: true, is_primary: true },
        orderBy: [{ is_primary: 'desc' as const }, { created_at: 'asc' as const }],
        take: 1,
      },
    },
  },
  service_location: { select: { address_line1: true, address_line2: true, city: true, state: true, zip: true } },
} as const satisfies Prisma.LeadSelect;

const personName = (p: { first_name: string | null; last_name: string | null } | null) =>
  p ? `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim() || null : null;

export interface StartingSummaryResult {
  summaryId: string | null;
  leads: number;
  recipients: number;
  /**
   * How the run stands: `done` (finished - or nothing to report), `waiting` (an earlier attempt failed or was stopped and
   * its next try is not due yet), `retry` (this attempt failed; the next is due after its wait) or `abandoned` (every
   * attempt is used: the claims saved were released and the company alerts per lead from the next run).
   */
  state: 'done' | 'waiting' | 'retry' | 'abandoned';
}

const NONE: StartingSummaryResult = { summaryId: null, leads: 0, recipients: 0, state: 'done' };

/** What one run of the summary reads before it writes anything: the claims still to write, and the company's time zone. */
interface Plan {
  planned: { visit: OverdueVisit; lead: Prisma.LeadGetPayload<{ select: typeof LEAD_SELECT }>; recipients: SpiderRecipient[] }[];
  timezone: string;
}

/**
 * Makes the company's starting summary of these overdue, unclaimed lead stays and delivers it. Returns how it stands (see
 * `StartingSummaryResult.state`), and how many leads and people it covered once done (none: nothing was sent and no summary
 * was made).
 *
 * A summary is a run (summaryRuns.ts): its claims go in small saved pieces and the run resumes after the last lead
 * saved. A failure BEFORE the run exists (the reads that plan it, the writes that start it) throws and writes nothing the
 * sweep cannot repeat; from the run's first attempt on, a failure never throws: it is recorded on the run and the sweep
 * retries when the attempt's wait is up (summaryRuns.ts), up to three attempts.
 */
export async function runStartingSummary(a: {
  orgId: string;
  now: Date;
  triggeredAt: Date;
  triggerKind: SpiderTriggerKind;
  /** The switched-on period the sweep read: a run from an earlier period is replaced, not resumed. */
  activatedAt: Date;
  overdue: readonly OverdueVisit[];
  channels: SpiderChannels;
  recipientsConfig: SpiderRecipients;
}): Promise<StartingSummaryResult> {
  let run = await findOpenRun(a.orgId);
  // A run whose summary is already READY was stopped after its claims were all saved, during the delivery (or just after it).
  // The summary stays: a stop never takes back what people were told. The delivery is finished (finishDelivery) and the run
  // closed; the trigger that made this summary is then spent. A different, newer trigger goes on to its own summary below.
  if (run?.summary.status === 'READY') {
    const sameTrigger = run.summary.triggered_at.getTime() === a.triggeredAt.getTime();
    // A summary of an earlier switched-on period is not finished any more: Spider was switched off and on since.
    const finished = run.summary.triggered_at < a.activatedAt ? await closeReadyRun(run, a.now) : await finishDelivery(run, a);
    if (!finished) return { summaryId: run.summary_id, leads: 0, recipients: 0, state: 'retry' };
    if (sameTrigger) return { summaryId: run.summary_id, leads: run.summary.lead_count, recipients: 0, state: 'done' };
    run = null;
  }
  // A run whose summary was replaced meanwhile (only two sweeps at once can do that) has nothing left to do.
  if (run?.summary.status === 'SUPERSEDED') {
    await closeReadyRun(run, a.now);
    run = null;
  }
  // A run from an earlier switched-on period (Spider was switched off and on while it waited): its claims belong to that
  // period. It is replaced, not resumed; the claims it saved are released.
  if (run && run.summary.triggered_at < a.activatedAt) {
    const released = await giveUp(run, a.now, 'replaced by a newer switch-on');
    logger.info('[spider] an unfinished starting summary was replaced by a newer switch-on', { orgId: a.orgId, summaryId: run.summary_id, released });
    run = null;
  }
  if (run) return attemptRun(run, a, []);

  // A trigger gets ONE summary. A summary that went out for this very trigger is never replaced by it, however a stop or a
  // failed statement fell between the run being closed and the sweep clearing the trigger: the sweep only clears it.
  const done = await readySummaryOfTrigger(a.orgId, a.triggeredAt);
  if (done) return { summaryId: done.id, leads: done.lead_count, recipients: 0, state: 'done' };

  // Nothing to report. Switching on replaces the last summary even then (its card goes); any other trigger leaves it.
  if (a.overdue.length === 0) {
    if (a.triggerKind === 'SWITCHED_ON') await supersedeCurrentSummary(a.orgId);
    return NONE;
  }
  // From here the work is counted: the run (and its BUILDING summary) exist before anything is read for it.
  const { run: created, replaced } = await createRun({ orgId: a.orgId, now: a.now, triggeredAt: a.triggeredAt, triggerKind: a.triggerKind });
  return attemptRun(created, a, replaced);
}

/** Whether the company has a summary run in progress (the sweep asks before it drops a trigger). */
export async function hasOpenSummaryRun(orgId: string): Promise<boolean> {
  return (await findOpenRun(orgId)) !== null;
}

type RunArgs = Parameters<typeof runStartingSummary>[0];

/**
 * One attempt of a run. It is counted and saved FIRST, before anything is read or written for it; then the claims, then the
 * delivery. `replaced` is the READY summaries this run's creation superseded: if the attempt finds nothing to summarize, any
 * trigger but a switch-on gives them back.
 */
async function attemptRun(run: OpenRun, a: RunArgs, replaced: readonly string[]): Promise<StartingSummaryResult> {
  if (run.next_attempt_at && run.next_attempt_at.getTime() > a.now.getTime()) {
    return { summaryId: run.summary_id, leads: 0, recipients: 0, state: 'waiting' };
  }
  // Every attempt the run was allowed has been used (a killed attempt counts): no further one starts.
  if (run.attempts >= SUMMARY_MAX_ATTEMPTS) return abandon(run, a, run.attempts);

  let attempt: number;
  try {
    attempt = await startAttempt(run, a.now);
  } catch (err) {
    logger.error(`[spider] could not start an attempt of the starting summary for org ${a.orgId}: ${errorName(err)}`);
    return { summaryId: run.summary_id, leads: 0, recipients: 0, state: 'retry' };
  }

  // Past the point of no return: once the summary is READY its delivery has begun, and nothing below may fail the run.
  let ready = false;
  try {
    const plan = await planClaims(a, run.cursor);
    if (plan.planned.length > 0) await writeClaims(run, plan, a);

    // What delivery needs, read back from the saved claims in pages (#2992): never from what this attempt happened to hold.
    const data = await readDelivery(run, a, plan.timezone);
    const claimed = data.claims.length;
    if (claimed === 0) {
      // Nobody could be told, or every stay was claimed meanwhile by someone else: no summary. A switch-on still replaces the
      // last one; any other trigger leaves it.
      await endEmptySummary(a.orgId, run.summary_id, a.triggerKind === 'SWITCHED_ON' ? [] : replaced);
      await finishRun(run.id, a.now);
      return NONE;
    }

    // The run that makes it READY delivers; nobody else ever does (a resumed or retried run finds it READY and goes no further).
    const delivers = await markReady(run.summary_id, claimed);
    ready = true;
    if (!delivers) {
      // Someone else made it READY (or it was replaced): this run has nothing left to do.
      await closeReadyRun(run, a.now);
      return { summaryId: run.summary_id, leads: claimed, recipients: 0, state: 'done' };
    }

    const told = await deliver(a, run, data, deliveryProgress({ state: 'SENDING' }));
    await closeReadyRun(run, a.now);
    logger.info('[spider] starting summary sent', { orgId: a.orgId, summaryId: run.summary_id, leads: claimed, recipients: told });
    return { summaryId: run.summary_id, leads: claimed, recipients: told, state: 'done' };
  } catch (err) {
    if (ready) {
      logger.error(`[spider] starting summary ${run.summary_id} could not be closed after its delivery began: ${errorName(err)}`);
      return { summaryId: run.summary_id, leads: 0, recipients: 0, state: 'done' };
    }
    logger.error(`[spider] starting summary attempt ${attempt} failed for org ${a.orgId}: ${errorName(err)}`);
    try {
      await recordFailure(run.id, err);
    } catch {
      // The run keeps the time its next attempt was given when this one began.
    }
    if (attempt >= SUMMARY_MAX_ATTEMPTS) return abandon(run, a, attempt, errorName(err));
    return { summaryId: run.summary_id, leads: 0, recipients: 0, state: 'retry' };
  }
}

/** The run ran out of attempts: its saved claims are released, the summary superseded, the run abandoned; logged once. */
async function abandon(run: OpenRun, a: RunArgs, attempts: number, lastError?: string): Promise<StartingSummaryResult> {
  try {
    const released = await giveUp(run, a.now, lastError ?? null);
    logGaveUp(a.orgId, run.summary_id, attempts, released);
    return { summaryId: null, leads: 0, recipients: 0, state: 'abandoned' };
  } catch (err) {
    // The release stopped part way: the run stays RUNNING, and the next sweep after its wait finishes the release.
    logger.error(`[spider] could not give up on the starting summary for org ${a.orgId}: ${errorName(err)}`);
    return { summaryId: run.summary_id, leads: 0, recipients: 0, state: 'retry' };
  }
}

/**
 * Finishes what a stop left of a READY summary's delivery: the bell for everyone it has not reached, and each channel that
 * was never started (a channel that was started is not started again: no second email or text). Records the outcome once on
 * the summary row, then closes the run. False when it could not (the run stays open; the next sweep tries again).
 */
async function finishDelivery(run: OpenRun, a: RunArgs): Promise<boolean> {
  const progress = deliveryProgress(run.summary.delivery);
  if (!progress.unfinished) return closeReadyRun(run, a.now);
  try {
    const org = await prisma.organization.findUnique({ where: { id: a.orgId }, select: { timezone: true } });
    const data = await readDelivery(run, a, org?.timezone || DEFAULT_TIMEZONE);
    const told = await deliver(a, run, data, progress);
    logger.info('[spider] an interrupted starting summary delivery was finished', { orgId: a.orgId, summaryId: run.summary_id, recipients: told });
  } catch (err) {
    logger.error(`[spider] could not finish the delivery of starting summary ${run.summary_id}: ${errorName(err)}`);
    return false;
  }
  return closeReadyRun(run, a.now);
}

/** Closes a run whose summary is READY (or replaced). True when it is closed; never throws. */
async function closeReadyRun(run: OpenRun, now: Date): Promise<boolean> {
  try {
    await finishRun(run.id, now);
    return true;
  } catch (err) {
    logger.error(`[spider] could not close the run of starting summary ${run.summary_id}: ${errorName(err)}`);
    return false;
  }
}

/**
 * Reads what writing the claims needs: the leads still to claim (after the run's cursor, by lead id), the people each
 * would tell and the company's time zone. Writes nothing.
 */
async function planClaims(a: RunArgs, cursor: string | null): Promise<Plan> {
  const visits = a.overdue.filter((o) => cursor === null || o.id > cursor).sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const org = await prisma.organization.findUnique({ where: { id: a.orgId }, select: { timezone: true } });
  if (visits.length === 0) return { planned: [], timezone: org?.timezone || DEFAULT_TIMEZONE };
  // In chunks of SWEEP_PAGE_SIZE leads (#2992, pages.ts): never every overdue lead of the company in one read.
  const leads: Prisma.LeadGetPayload<{ select: typeof LEAD_SELECT }>[] = [];
  for (const ids of inChunks(visits.map((o) => o.id))) {
    leads.push(...(await prisma.lead.findMany({ where: { organization_id: a.orgId, id: { in: ids } }, select: LEAD_SELECT })));
  }
  const leadById = new Map(leads.map((l) => [l.id, l]));

  // Each lead's people by Spider's one rule, for all the leads in one batched lookup. A lead nobody can
  // be told about is left unclaimed, as the per-lead path leaves it, so it can still alert once someone
  // it would reach exists.
  const recipientsByLead = await resolveSpiderRecipientsForLeads(prisma, {
    orgId: a.orgId,
    leads: leads.map((l) => ({ id: l.id, ownerId: l.commission_owner_id })),
    recipients: a.recipientsConfig,
  });
  const planned: Plan['planned'] = [];
  for (const visit of visits) {
    const lead = leadById.get(visit.id);
    if (!lead) continue;
    const recipients = recipientsByLead.get(lead.id) ?? [];
    if (recipients.length > 0) planned.push({ visit, lead, recipients });
  }
  return { planned, timezone: org?.timezone || DEFAULT_TIMEZONE };
}

/**
 * Saves the claims, a statement at a time in lead id order, each statement saved on its own and followed by the run's
 * cursor: a run that stops resumes after the last lead whose claim is saved, and what it already saved is skipped by the
 * unique claim key (a stay claimed meanwhile, or a statement repeated after a stop, adds nothing). Each statement carries
 * at most SUMMARY_CLAIMS_PER_STATEMENT claims and SUMMARY_CLAIMS_INSERT_BYTES of JSON text (#3107).
 */
async function writeClaims(run: OpenRun, plan: Plan, a: RunArgs): Promise<void> {
  // Each lead's list is stored once however many leads were told it (a 60-person list is the same set for all 5,000).
  const setIds = await recipientSetIds(prisma, a.orgId, plan.planned.map((p) => p.recipients));
  const rows = plan.planned.map(({ visit, lead, recipients }, i) => ({
    organization_id: a.orgId,
    lead_id: lead.id,
    status: visit.status,
    entered_status_at: visit.entered_at,
    counted_from: visit.counted_from,
    limit_value: visit.limit.value,
    limit_unit: visit.limit.unit,
    alerted_at: a.now,
    recipient_ids: recipients.map((r) => r.id),
    kind: 'SUMMARIZED',
    summary_id: run.summary_id,
    lead_number: lead.lead_number || `Lead #${lead.id.slice(0, 6)}`,
    customer_id: lead.customer_id,
    customer_name: customerName(lead.customer),
    company_name: lead.customer.company_name?.trim() || null,
    service_request: lead.service_request || null,
    service_location: resolveServiceAddress(lead, lead.customer),
    stage_name: SPIDER_STAGE_NAME[visit.status],
    elapsed_value: Math.max(1, Math.floor((a.now.getTime() - visit.entered_at.getTime()) / limitMs(1, visit.limit.unit))),
    elapsed_unit: visit.limit.unit,
    // The people are stored once per distinct list (recipientSets.ts): the row points at its set, and holds no copy of the
    // list and no message (the summary's messages are built per person, never stored per lead).
    recipient_set_id: setIds[i]!,
  }));
  for (const chunk of inChunksOfBytes(rows, SUMMARY_CLAIMS_INSERT_BYTES, SUMMARY_CLAIMS_PER_STATEMENT)) {
    await prisma.spiderAlert.createMany({ skipDuplicates: true, data: chunk });
    await saveCursor(run.id, chunk[chunk.length - 1]!.lead_id);
  }
}

/** Everything delivery needs, read back from the saved summary: its claims, its people and its leads' owners. */
interface DeliveryData {
  claims: { id: string; lead_id: string; recipient_ids: string[] }[];
  recipients: SpiderContact[];
  leadsOf: (userId: string) => SummaryLead[];
  showOwnerFor: (userId: string) => boolean;
  when: string;
}

/**
 * Reads the saved claims (in keyset pages of SWEEP_PAGE_SIZE by alert id, #2992), the people they name and their leads'
 * owners, and builds each person's list of leads. The same whether the run wrote every claim itself or resumed an earlier
 * one's: delivery is built from what is saved, never from what one attempt happened to hold in memory.
 */
async function readDelivery(run: OpenRun, a: RunArgs, timezone: string): Promise<DeliveryData> {
  const claims = await allKeysetPages(
    (after) =>
      prisma.spiderAlert.findMany({
        where: { organization_id: a.orgId, summary_id: run.summary_id, ...(after ? { id: { gt: after } } : {}) },
        select: {
          id: true, lead_id: true, status: true, entered_status_at: true, limit_value: true, limit_unit: true, alerted_at: true,
          lead_number: true, customer_name: true, service_location: true, recipient_ids: true,
        },
        orderBy: { id: 'asc' },
        take: SWEEP_PAGE_SIZE,
      }),
    (r) => r.id,
  );
  const leadIds = [...new Set(claims.map((c) => c.lead_id))];
  const owners = new Map<string, { ownerId: string | null; name: string | null }>();
  for (const ids of inChunks(leadIds)) {
    for (const l of await prisma.lead.findMany({
      where: { organization_id: a.orgId, id: { in: ids } },
      select: { id: true, commission_owner_id: true, commission_owner: { select: { first_name: true, last_name: true } } },
    })) {
      owners.set(l.id, { ownerId: l.commission_owner_id, name: personName(l.commission_owner) });
    }
  }
  const personIds = [...new Set(claims.flatMap((c) => c.recipient_ids))];
  const contacts = new Map<string, SpiderContact>();
  for (const ids of inChunks(personIds)) {
    for (const u of await prisma.user.findMany({
      where: { organization_id: a.orgId, id: { in: ids } },
      select: { id: true, first_name: true, last_name: true, email: true, phone: true },
    })) {
      contacts.set(u.id, u);
    }
  }

  const org = a.orgId;
  const people = new Map<string, { person: SpiderContact; leads: SummaryLead[]; ownerIds: (string | null)[] }>();
  for (const c of claims) {
    const owner = owners.get(c.lead_id);
    const lead: SummaryLead = {
      leadId: c.lead_id,
      leadNumber: c.lead_number ?? `Lead #${c.lead_id.slice(0, 6)}`,
      customerName: c.customer_name ?? 'Customer',
      address: c.service_location ?? 'Service location on file',
      stageName: SPIDER_STAGE_NAME[c.status as SpiderStatus],
      inStageMs: c.alerted_at.getTime() - c.entered_status_at.getTime(),
      limitMs: limitMs(c.limit_value, c.limit_unit as SpiderUnit),
      ownerName: owner?.name ?? null,
    };
    for (const id of c.recipient_ids) {
      const person = contacts.get(id);
      if (!person) {
        logger.warn('[spider] a person told by a starting summary no longer exists', { orgId: org, summaryId: run.summary_id, userId: id });
        continue;
      }
      const entry = people.get(id) ?? { person, leads: [], ownerIds: [] };
      entry.leads.push(lead);
      entry.ownerIds.push(owner?.ownerId ?? null);
      people.set(id, entry);
    }
  }
  const sorted = new Map([...people].map(([id, e]) => [id, mostOverdueFirst(e.leads)]));
  return {
    claims: claims.map((c) => ({ id: c.id, lead_id: c.lead_id, recipient_ids: c.recipient_ids })),
    recipients: [...people.values()].map((e) => e.person),
    leadsOf: (userId) => sorted.get(userId) ?? [],
    // The Owner column shows unless every lead in the person's list is their own.
    showOwnerFor: (userId) => !(people.get(userId)?.ownerIds ?? []).every((o) => o === userId),
    when: triggerWhen(run.summary.triggered_at, a.now, timezone),
  };
}

/** Saves how a channel went as soon as it is done (never throws: the final record below still has it). */
async function saveChannel(summaryId: string, channel: 'email' | 'text', done: ChannelDelivery, results: RecipientResult[]): Promise<void> {
  try {
    await markChannelDone(summaryId, channel, { outcome: done.outcome, recipients: done.recipients, results });
  } catch {
    logger.error(`[spider] could not save the ${channel} outcome of summary ${summaryId}`);
  }
}

/**
 * Delivers the summary and records how each channel went, once, on the summary and on each claim's History row. Runs for the
 * run that made the summary READY and, after a stop, for the run that finishes it (finishDelivery): both read the same saved
 * `progress`, so a stop never sends anything twice.
 * - The bell: one notice per person, skipped for whoever already has theirs (its dedup key names the summary and the person),
 *   so it can be finished for the rest.
 * - Email and text: each channel's start is saved before its first send, and a channel that was started is not started again,
 *   whoever it had reached (at most one email and one text per person; the people it did not reach are not told that way).
 * Nothing in it throws: a channel that fails is recorded as not delivered, as a per-lead alert records it, and never retried.
 * Returns how many people it covered.
 */
async function deliver(a: RunArgs, run: OpenRun, data: DeliveryData, progress: DeliveryProgress): Promise<number> {
  const summary = { id: run.summary_id };
  const { recipients, leadsOf, showOwnerFor, when } = data;
  const delivery: Record<string, ChannelDelivery> = {};
  const results: { in_app: Set<string>; email: RecipientResult[]; text: RecipientResult[] } = {
    in_app: new Set(),
    email: [],
    text: [],
  };
  const channelFailed = (channel: string, err: unknown) =>
    logger.error(`[spider] summary ${channel} failed for summary ${summary.id}: ${err instanceof Error ? err.name : 'unknown error'}`);
  const inAppOutcomes = () =>
    recipients.map((r) => ({ user_id: r.id, outcome: results.in_app.has(r.id) ? 'Shown in the app' : 'Not shown in the app' }));

  // In the app: one notification per person, about them alone (their own count), no toast and no
  // red frame. Its link opens their summary. A person who already has theirs (a stop left the bell half done) is not given another.
  if (a.channels.in_app) {
    try {
      const keyOf = (id: string) => `${SPIDER_SUMMARY_VERB}:${summary.id}:${id}`;
      // Who already has their notice: a notice counts once the person's row for it is written (a stop can fall between the two).
      const told = new Set<string>();
      for (const chunk of inChunks(recipients.map((r) => r.id))) {
        const rows = await prisma.notificationRecipient.findMany({
          where: { organization_id: a.orgId, recipient_id: { in: chunk }, notification: { verb: SPIDER_SUMMARY_VERB, dedup_key: { in: chunk.map(keyOf) } } },
          select: { recipient_id: true },
        });
        for (const row of rows) told.add(row.recipient_id);
      }
      // A notice a stop left with no person on it shows to nobody and would stop the new one (its key is taken): remove it.
      for (const chunk of inChunks(recipients.filter((r) => !told.has(r.id)).map((r) => keyOf(r.id)))) {
        await prisma.notification.deleteMany({ where: { organization_id: a.orgId, verb: SPIDER_SUMMARY_VERB, dedup_key: { in: chunk } } });
      }
      for (const r of recipients) {
        if (told.has(r.id)) {
          results.in_app.add(r.id);
          continue;
        }
        const n = leadsOf(r.id).length;
        const shown = await emit({
          verb: SPIDER_SUMMARY_VERB,
          organizationId: a.orgId,
          actorId: null,
          object: { type: 'SPIDER_SUMMARY', id: summary.id, label: 'Starting summary' },
          entity: { recipient_ids: [r.id] },
          data: { title: summaryBellTitle(n), body: SUMMARY_BELL_BODY, lead_count: n, link_path: SPIDER_SUMMARY_PATH },
          dedupKey: keyOf(r.id),
          personal: true,
        });
        if (shown.length > 0) results.in_app.add(r.id);
      }
      delivery.in_app = {
        outcome: results.in_app.size > 0 ? 'Shown in the app' : 'No one to alert in the app',
        recipients: inAppOutcomes(),
      };
    } catch (err) {
      channelFailed('in-app', err);
      delivery.in_app = { outcome: 'Could not be shown in the app', recipients: inAppOutcomes() };
    }
  } else {
    delivery.in_app = { outcome: 'In-app alerts are switched off' };
  }

  if (!a.channels.email) {
    delivery.email = { outcome: EMAIL_OUTCOME.channelOff };
  } else if (progress.email.done) {
    // The emails finished before a stop: their outcome was saved, and is the one recorded.
    results.email = progress.email.done.results;
    delivery.email = { outcome: progress.email.done.outcome, recipients: progress.email.done.recipients };
  } else if (progress.email.started) {
    // A stop cut the emails short: whoever got one is not emailed again, and who did not is not told which.
    results.email = recipients.map((r) => ({ user_id: r.id, result: 'skipped' as const, reason: EMAIL_REASON.interrupted }));
    delivery.email = { outcome: EMAIL_OUTCOME.interrupted, recipients: recipients.map((r) => ({ user_id: r.id, outcome: EMAIL_OUTCOME.interrupted })) };
  } else {
    try {
      await markChannelStarted(summary.id, 'email');
      const sent = await deliverSpiderEmailsTo({
        orgId: a.orgId,
        logKey: { summaryId: summary.id },
        recipients,
        messageFor: (r) => {
          const own = leadsOf(r.id);
          const input = {
            recipientFirstName: r.first_name?.trim() || 'Team Member',
            leads: own,
            showOwner: showOwnerFor(r.id),
            triggerKind: isTriggerKind(run.summary.trigger_kind) ? run.summary.trigger_kind : 'SETTINGS_CHANGED',
            when,
            summaryUrl: spiderSummaryUrl(),
            leadUrl,
          };
          return { subject: summaryEmailSubject(own.length), text: summaryEmailText(input), html: summaryEmailHtml(input) };
        },
      });
      results.email = sent.results;
      delivery.email = { outcome: sent.outcome, recipients: sent.recipients };
    } catch (err) {
      channelFailed('email', err);
      results.email = recipients.map((r) => ({ user_id: r.id, result: 'failed' as const, reason: EMAIL_REASON.failed }));
      delivery.email = { outcome: EMAIL_OUTCOME.failed, recipients: recipients.map((r) => ({ user_id: r.id, outcome: EMAIL_OUTCOME.failed })) };
    }
    await saveChannel(summary.id, 'email', delivery.email, results.email);
  }

  if (!a.channels.text) {
    delivery.text = { outcome: TEXT_OUTCOME.channelOff };
  } else if (progress.text.done) {
    results.text = progress.text.done.results;
    delivery.text = { outcome: progress.text.done.outcome, recipients: progress.text.done.recipients };
  } else if (progress.text.started) {
    results.text = recipients.map((r) => ({ user_id: r.id, result: 'skipped' as const, reason: TEXT_REASON.interrupted }));
    delivery.text = { outcome: TEXT_OUTCOME.interrupted, recipients: recipients.map((r) => ({ user_id: r.id, outcome: TEXT_OUTCOME.interrupted })) };
  } else {
    const emailed = new Set(results.email.filter((e) => e.result === 'sent').map((e) => e.user_id));
    // A summary text counts toward texting usage like any Spider text: on the alert-log row of the
    // person's most overdue lead in it (comm-usage.ts sums that column), which is kept for good.
    const claimOf = new Map(data.claims.map((c) => [c.lead_id, c.id]));
    const textsSent = new Map<string, number>();
    try {
      await markChannelStarted(summary.id, 'text');
      const sent = await deliverSpiderTextsTo({
        orgId: a.orgId,
        sendKey: `summary:${summary.id}`,
        logKey: { summaryId: summary.id },
        recipients,
        bodyFor: (r) => {
          const n = leadsOf(r.id).length;
          // It only mentions an email that actually went out to this person.
          return emailed.has(r.id) ? summaryTextEmailed(n) : summaryTextWithLink(n, spiderSummaryUrl());
        },
        // Counted the moment it goes out, toward the summary's one usage write below (#2990).
        onSent: async (r) => {
          const first = leadsOf(r.id)[0];
          const claimId = first ? claimOf.get(first.leadId) : undefined;
          if (claimId) textsSent.set(claimId, (textsSent.get(claimId) ?? 0) + 1);
        },
      });
      results.text = sent.results;
      delivery.text = { outcome: sent.outcome, recipients: sent.recipients };
    } catch (err) {
      channelFailed('text', err);
      results.text = recipients.map((r) => ({ user_id: r.id, result: 'failed' as const, reason: TEXT_REASON.failed }));
      delivery.text = { outcome: TEXT_OUTCOME.failed, recipients: recipients.map((r) => ({ user_id: r.id, outcome: TEXT_OUTCOME.failed })) };
    }
    // Every text that went out, even if the channel failed after it, in one write (never throws).
    await countSentTexts(a.orgId, textsSent);
    await saveChannel(summary.id, 'text', delivery.text, results.text);
  }

  // Each summarized lead's History row: how its people were told, through the summary. All of them in
  // one write (#2990, alertLog.ts), which never throws.
  await recordDeliveries(
    a.orgId,
    data.claims.map((c) => {
      const ids = c.recipient_ids;
      const mine = (list: RecipientResult[]) => list.filter((x) => ids.includes(x.user_id));
      const inAppSent = ids.some((id) => results.in_app.has(id));
      return {
        id: c.id,
        channels: {
          in_app: { enabled: a.channels.in_app, status: a.channels.in_app && inAppSent ? 'SENT' : 'SKIPPED' },
          email: { ...channelRecord(a.channels.email, mine(results.email)), from: SPIDER_EMAIL_FROM_LINE },
          sms: channelRecord(a.channels.text, mine(results.text)),
        },
      };
    }),
    'summarized alert',
  );

  try {
    await recordDelivery(summary.id, {
      leadCount: data.claims.length,
      recipientCount: recipients.length,
      delivery: delivery as unknown as Prisma.InputJsonValue,
    });
  } catch {
    logger.error(`[spider] could not record delivery for summary ${summary.id}`);
  }
  return recipients.length;
}

// ─── Reading a summary ───────────────────────────────────────────────────────

export interface SummaryRow {
  lead_id: string;
  lead_number: string;
  customer_name: string;
  address: string;
  stage: SpiderStatus;
  /** The stage name, as the alerts name it. */
  stage_name: string;
  entered_stage_at: string;
  in_stage: string;
  limit: string;
  over_by: string;
  over_by_ms: number;
  owner_name: string | null;
  /** Whether the lead has left that stage visit since. */
  moved_on: boolean;
  /** Where it is now, when it has moved on: a stage name, else the lead's status. */
  moved_to: string | null;
}

export interface SummaryView {
  id: string;
  created_at: string;
  triggered_at: string;
  trigger_kind: SpiderTriggerKind;
  scope: 'mine' | 'company';
  show_owner: boolean;
  total: number;
  still_waiting: number;
  moved_on: number;
  leads: SummaryRow[];
}

/**
 * The company's latest summary as one person may read it: `forUser` set reads only the leads that
 * person was told about and can still open (`leadScope` is their row scope on leads); unset reads the
 * whole company (Admins). Null when there is no summary, or none of it is this person's.
 */
export async function readSpiderSummary(a: {
  orgId: string;
  forUser: { id: string; leadScope: Prisma.LeadWhereInput } | null;
  now?: Date;
}): Promise<SummaryView | null> {
  // READY only: a summary still being written (BUILDING), or one replaced (SUPERSEDED), is never shown (#3108). At most one
  // summary of a company is current, so this is at most one row.
  const summary = await prisma.spiderSummary.findFirst({ where: { organization_id: a.orgId, ...READABLE_SUMMARY } });
  if (!summary) return null;
  const claims = await prisma.spiderAlert.findMany({
    where: {
      organization_id: a.orgId,
      summary_id: summary.id,
      ...(a.forUser ? { recipient_ids: { has: a.forUser.id } } : {}),
    },
    select: {
      lead_id: true,
      status: true,
      entered_status_at: true,
      limit_value: true,
      limit_unit: true,
      alerted_at: true,
      lead_number: true,
      customer_name: true,
      service_location: true,
    },
  });
  if (claims.length === 0) return null;
  const leads = await prisma.lead.findMany({
    where: {
      AND: [
        { organization_id: a.orgId, id: { in: claims.map((c) => c.lead_id) } },
        ...(a.forUser ? [a.forUser.leadScope] : []),
      ],
    },
    select: {
      id: true,
      commission_owner_id: true,
      commission_owner: { select: { first_name: true, last_name: true } },
      ...SPIDER_LEAD_TIMES_SELECT,
    },
  });
  const leadById = new Map(leads.map((l) => [l.id, l]));
  const rows: (SummaryRow & { owner_id: string | null })[] = claims.flatMap((c) => {
    const lead = leadById.get(c.lead_id);
    if (!lead) return [];
    const stage = c.status as SpiderStatus;
    const inStageMs = c.alerted_at.getTime() - c.entered_status_at.getTime();
    const limit = limitMs(c.limit_value, c.limit_unit as SpiderUnit);
    const visit = spiderStageOf(lead);
    const movedOn = !visit || visit.stage !== stage || visit.enteredAt.getTime() !== c.entered_status_at.getTime();
    const movedTo = !movedOn ? null : visit ? SPIDER_STAGE_NAME[visit.stage] : LEAD_STATUS_LABEL[lead.status];
    return [
      {
        lead_id: c.lead_id,
        lead_number: c.lead_number ?? `Lead #${c.lead_id.slice(0, 6)}`,
        customer_name: c.customer_name ?? 'Customer',
        address: c.service_location ?? 'Service location on file',
        stage,
        stage_name: SPIDER_STAGE_NAME[stage] ?? LEAD_STATUS_LABEL[stage],
        entered_stage_at: c.entered_status_at.toISOString(),
        in_stage: summaryDuration(inStageMs),
        limit: summaryDuration(limit),
        over_by: summaryDuration(overByMs({ inStageMs, limitMs: limit })),
        over_by_ms: inStageMs - limit,
        owner_name: personName(lead.commission_owner),
        owner_id: lead.commission_owner_id,
        moved_on: movedOn,
        moved_to: movedTo,
      },
    ];
  });
  if (rows.length === 0) return null;
  rows.sort((x, y) => y.over_by_ms - x.over_by_ms || x.lead_number.localeCompare(y.lead_number));
  const movedOn = rows.filter((r) => r.moved_on).length;
  const forUser = a.forUser;
  return {
    id: summary.id,
    created_at: summary.created_at.toISOString(),
    triggered_at: summary.triggered_at.toISOString(),
    trigger_kind: isTriggerKind(summary.trigger_kind) ? summary.trigger_kind : 'SETTINGS_CHANGED',
    scope: forUser ? 'mine' : 'company',
    show_owner: !forUser || !rows.every((r) => r.owner_id === forUser.id),
    total: rows.length,
    still_waiting: rows.length - movedOn,
    moved_on: movedOn,
    leads: rows.map(({ owner_id: _owner, ...r }) => r),
  };
}
