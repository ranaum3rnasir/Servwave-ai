/**
 * The Spider sweep (#2619): the server - not anyone's browser - watches each open lead's status
 * and alerts the right staff once a lead has stayed in a watched status longer than the limit its
 * company set. Registered in index.ts next to the other sweeps: every 2 minutes while it is the only alerter, every 10 minutes
 * once the check (tick.ts, #3469) runs beside it and the sweep is the safety net (#3471, spiderSweepIntervalMs).
 *
 * The check on or off (spiderTickEnabled: SPIDER_WATCH_LIST=check, `spider-tick` not paused). OFF - the code release before the
 * watch list is complete - the sweep is exactly the alerter described below. ON, it is the safety net: it still ends what is
 * left open and alerts what the check missed, logging how many (`safetyCaught`, expected 0; a warning above 0), and it never acts
 * on a starting trigger (summaryStart.ts does, within seconds): a company with a trigger waiting has only the stays that crossed
 * AFTER the trigger's moment alerted by it, as by the check; the flood guard (100 per company in any 2 minutes) counts the
 * check's alerts too. Its lease lasts one interval.
 *
 * - Which companies: those with a Spider settings row that pass the Spider gate (the `spider`
 *   feature and, while the launch is limited, a demo company or a company on the Spider pilot list,
 *   `SPIDER_PILOT_ORG_IDS`). Alerts go out only while Spider is switched on. Ending finished alerts
 *   runs for every company with a settings row, so alerts already raised still end after Spider is
 *   switched off or the gate is revoked. A company that is switched off, or no longer passes the
 *   gate, has every open alert ended by every run (D4: off means none open; SPEC-5 R10: losing
 *   access behaves like off).
 * - Which leads: every open lead (no row cap; read in pages of 500, pages.ts) in a stage the company switched on, except
 *   the leads it excluded (spider_settings.excluded_lead_ids, #3434; Ran 3 Nov: every open lead is watched by default, new
 *   ones included). The exclusion list is left out in memory, so the reads do not grow with it. Won, Lost and Cancelled
 *   never; a lead that closes drops out by itself, and an excluded lead that is reopened stays excluded.
 * - Stage and time in it: the lead's stage and the instant it entered it come from the lead's own
 *   timestamps, by the contractor's rules (config.ts `spiderStageOf`, Ran 15 Oct). Time is now minus
 *   that instant - never floored at when Spider was switched on (#2794): the starting summary is what
 *   keeps switching on from alerting every old lead at once. Ran, 27 Oct: switching back on reports
 *   the leads already past their limit at once, in the summary, rather than after a full limit
 *   counted from the switch-on.
 * - Starting summary (#2794, summary.ts), while the check is off: while a starting trigger is waiting, the company alerts
 *   nothing; once the settings have been quiet for a sweep interval (2 minutes) - or at the latest 10 minutes
 *   after the trigger first started waiting, however many saves follow - the backlog past its limit
 *   and not yet claimed in this switched-on period becomes one summary per recipient instead of one
 *   alert per lead, and the trigger is cleared (only if no newer one landed meanwhile; that one waits
 *   afresh). The summary is written in small saved pieces by a run that resumes after a stop and gives up after 3
 *   attempts, waiting 2, 8, then 30 minutes between them (#3108, summaryRuns.ts); until it is finished or given up on, the
 *   trigger stays and the company alerts nothing per lead. A failure BEFORE the run exists (finding or starting it) is
 *   retried on the next run until the same 10 minutes are up: then the trigger is dropped, logged, and the per-lead
 *   path takes over - unless a run is open, whose claims only its own attempts may release. A run given up on releases the claims it saved, so the per-lead path (capped, #2991) reaches those
 *   leads too.
 * - Once per lead per stage visit per switched-on period: the alert-log row (an alert or a summary's
 *   claim) is inserted first; its unique key (company, lead, stage, entered-stage instant,
 *   counted-from) is the claim. Counted-from is the later of the entered-stage instant and
 *   activated_at: it names the switched-on period, and no longer sets when the limit is reached. Only
 *   a successful claim sends. A run's claims go in with one insert that skips a taken key (#2990,
 *   alertLog.ts): a collision is "already alerted in this switched-on period", and any other failure
 *   sends nothing and is logged. Claims a run never acts on are released again; its delivery records
 *   go in with one update at the end. Switching back on moves counted-from, so a lead
 *   still in the same stage is reported once more (D5), in the switch-on's summary. A per-lead
 *   re-alert ends any earlier card still open for the lead, so it never shows two.
 *   The switch is read when the company's turn starts and checked once more just before the claims (stillOn), so a
 *   company switched off before the run sends nothing. A change made while the run is sending - Spider switched off,
 *   the company's email or texting switched off, an address suppressed, the outbound number or plan changed - takes
 *   effect from the next run (Ran, 2026-11-04, "Next run"): at most about 45 s, up to 100 alerts already in that run
 *   may still go out. Their bell and frame records are ended at once by the end step's switch check.
 * - Ending: an unread spider.alert whose lead has left the alerted stage visit (another stage or
 *   none, or the same stage entered again later), or that the saved settings no longer alert (the lead excluded, its
 *   stage's limit off, or a longer limit it is not past; #3450), is marked read for every recipient (alertStillOpen).
 *
 * - How much per run (#2991, runCaps.ts): at most 100 per-lead alerts per company, the ones overdue
 *   longest first (with the check on, less what the check alerted in the last 2 minutes: floodGuardRoom), and at most
 *   about 45 s per company, stopping between two alerts. The rest stay unclaimed for the next run. The starting summary is
 *   never capped or split.
 *
 * One instance across servers (a lease row the run claims, renews and gives up, sweepLease.ts; no
 * transaction is held for the run) and never two overlapping runs in one process. A run that loses
 * its lease, or whose server is stopping (lib/graceful-stop.ts), stops before its next company,
 * per-lead alert or starting summary, and still finishes the end step of the alerts it sent. One
 * company's failure never stops the others. Logs carry ids only.
 */
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { env } from '../../config/env';
import { runUnscoped, runWithOrg } from '../../lib/tenant-context';
import { LEAD_STATUS_LABEL } from '../lead-stage.service';
import { emitMany, type EmitArgs, type EmitManyResult } from '../notifications/notificationService';
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
  type SpiderStatusLimit,
  type SpiderUnit,
} from './config';
import { spiderAvailableForOrg } from './gate';
import { claimSweepLease } from './sweepLease';
import { spiderTickEnabled } from './watchList';
import { stopRequested } from '../../lib/graceful-stop';
import { FLOOD_WINDOW_MS, SPIDER_ALERTS_PER_COMPANY_RUN, SPIDER_COMPANY_RUN_MS, spiderRunClock } from './runCaps';
import { hasOpenSummaryRun, reapOrphanedRuns, runStartingSummary } from './summary';
import { isTriggerKind } from './summaryMessages';
import { resolveSpiderRecipientsForLeads, type SpiderRecipient } from './recipients';
import { recipientSetIds } from './recipientSets';
import { claimVisits, countSentTexts, recordDeliveries, releaseClaims, type DeliveryRecord } from './alertLog';
import {
  EMAIL_OUTCOME,
  EMAIL_REASON,
  SPIDER_EMAIL_FROM_LINE,
  TEXT_OUTCOME,
  TEXT_REASON,
  channelRecord,
  deliverSpiderEmails,
  deliverSpiderTexts,
  runTogether,
  spiderSendCompany,
  summariseEmail,
  summariseText,
  type ChannelDelivery,
  type ChannelRecord,
  type PersonDelivery,
  type RecipientOutcome,
  type RecipientResult,
  type SpiderSendCompany,
} from './delivery';
import { SWEEP_PAGE_SIZE, allKeysetPages, forEachKeysetPage, inChunks } from './pages';
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
import { entryCovers, storedChosenAs, type CoverageReader } from './recipientCoverage';
import { publishSpiderLive, type SpiderAddedAlertRow, type SpiderRecordRow } from './liveMessages';

export { SPIDER_ALERT_VERB };
/** Both per-person Spider records, both bell-hidden: the in-app alert, and the red-frame-only record. */
export const SPIDER_RECORD_VERBS = [SPIDER_ALERT_VERB, SPIDER_FRAME_VERB] as const;
/** A lead's own service location: the address parts the message joins. */
const LOCATION_SELECT = {
  address_line1: true,
  address_line2: true,
  city: true,
  state: true,
  zip: true,
} as const;
/** A customer's locations: the same, and which is primary (the fallback picks it). */
const CUSTOMER_LOCATION_SELECT = { ...LOCATION_SELECT, is_primary: true } as const;

export interface SpiderSweepResult {
  ran: boolean;
  companies: number;
  leadsChecked: number;
  alertsSent: number;
  alertsEnded: number;
  /** Leads reported in starting summaries this run. */
  leadsSummarized: number;
  /**
   * With the check running (spiderTickEnabled), the alerts this run had to send itself because the check had not: 0 is what
   * it should always be, and above 0 is logged as a warning (#3471). Always 0 while the check is off (the sweep is then the
   * only alerter).
   */
  safetyCaught: number;
}

const NOT_RUN: SpiderSweepResult = { ran: false, companies: 0, leadsChecked: 0, alertsSent: 0, alertsEnded: 0, leadsSummarized: 0, safetyCaught: 0 };

/** The sweep's interval while it is the only alerter (the check is off): every 2 minutes. */
export const SWEEP_INTERVAL_MS = 2 * 60_000;
/** The sweep's interval as the safety net beside the check (#3471): every 10 minutes. */
export const SWEEP_SAFETY_NET_INTERVAL_MS = 10 * 60_000;
/**
 * How often the sweep runs in this deployment: every 10 minutes while the check runs beside it (SPIDER_WATCH_LIST=check and the
 * check not paused), else today's 2 minutes - the code release before the backfill keeps the sweep as the one alerter, still
 * acting on starting triggers as before. Its lease timing follows (sweepLease.ts).
 */
export function spiderSweepIntervalMs(): number {
  return spiderTickEnabled() ? SWEEP_SAFETY_NET_INTERVAL_MS : SWEEP_INTERVAL_MS;
}
/** The cron expression of the sweep's schedule (index.ts), by spiderSweepIntervalMs. */
export function spiderSweepCron(): string {
  return spiderSweepIntervalMs() === SWEEP_SAFETY_NET_INTERVAL_MS ? '*/10 * * * *' : '*/2 * * * *';
}

/**
 * Starting triggers, while the check is OFF: the sweep acts on them as it always did - after a quiet time of one sweep interval
 * (2 minutes), at the latest 10 minutes after the trigger first started waiting. With the check on, summaryStart.ts owns triggers
 * (30 seconds of quiet, at most 2 minutes) and the sweep never acts on one.
 */
const SWEEP_SUMMARY_QUIET_MS = 2 * 60_000;
const SWEEP_SUMMARY_MAX_WAIT_MS = 10 * 60_000;

let inFlight = false;
/** The run in progress in this process, if any (whenSpiderSweepIdle). */
let running: Promise<SpiderSweepResult> | null = null;

/** Never throws. `now` is injectable so tests can run the sweep at chosen clock times. */
export async function runSpiderSweep(now: Date = new Date()): Promise<SpiderSweepResult> {
  if (inFlight) {
    logger.warn('[spider] previous sweep still running - skipping this run');
    return NOT_RUN;
  }
  // The server is stopping (lib/graceful-stop.ts): no new run starts; the next server's first run picks up.
  if (stopRequested()) {
    logger.info('[spider] the server is stopping - skipping this run');
    return NOT_RUN;
  }
  inFlight = true;
  const run = (async () => {
    try {
      return await runUnscoped(() => withSweepLease(now));
    } catch (err) {
      logger.error(`[spider] sweep failed: ${errorName(err)}`);
      return NOT_RUN;
    } finally {
      inFlight = false;
      running = null;
    }
  })();
  running = run;
  return run;
}

/** Test-only: true while a sweep is running in this process. */
export function _spiderSweepInFlight(): boolean {
  return inFlight;
}

/**
 * Settles once no sweep is running in this process (at once when none is). The stop handler waits on it (index.ts),
 * so a run told to stop can finish its current alert and its end step before the process ends. Never rejects.
 */
export async function whenSpiderSweepIdle(): Promise<void> {
  if (running) await running;
}

/**
 * One run at a time across servers: the run claims the sweep's lease (sweepLease.ts) or, while another
 * server's live run holds it, does nothing. The claim, the renewals and the release are single
 * statements on the app's shared client, so the run holds no transaction and needs no connection of
 * its own (the deployed pool holds one). The lease is given up however the run ends.
 */
async function withSweepLease(now: Date): Promise<SpiderSweepResult> {
  const lease = await claimSweepLease(spiderSweepIntervalMs());
  if (!lease) {
    logger.info('[spider] another server is running the sweep - skipping this run');
    return NOT_RUN;
  }
  try {
    // Stops like a lost lease when the server is stopping: before the next company, per-lead alert or summary.
    return await sweepAllCompanies(now, () => lease.held() && !stopRequested());
  } finally {
    await lease.release();
  }
}

/** `stillHeld` is false once the run has lost its lease or its server is stopping: no further company is started. */
async function sweepAllCompanies(now: Date, stillHeld: () => boolean): Promise<SpiderSweepResult> {
  const result: SpiderSweepResult = { ran: true, companies: 0, leadsChecked: 0, alertsSent: 0, alertsEnded: 0, leadsSummarized: 0, safetyCaught: 0 };
  // Read once for the run: with the check on, this run is the safety net (never acts on a trigger, shares the flood guard).
  const tickOn = spiderTickEnabled();
  const runStarted = Date.now();
  const rows = await prisma.spiderSettings.findMany({
    select: {
      organization_id: true,
      organization: { select: { id: true, is_demo: true, plan: true, trial_ends_at: true, feature_overrides: true } },
    },
    orderBy: { organization_id: 'asc' },
  });
  const skipped: Partial<Record<SkipReason, number>> = {};
  // Runs a failed release left behind (no trigger waits for them): closed here, whichever alerter the company has (#3471).
  await reapOrphanedRuns(now);
  for (const row of rows) {
    if (!stillHeld()) break;
    const orgId = row.organization_id;
    const available = spiderAvailableForOrg(row.organization);
    if (available) result.companies += 1;
    const startedAt = Date.now();
    // The company's time limit (runCaps.ts) counts from the start of its turn.
    const turnStarted = spiderRunClock();
    const timeUp = () => spiderRunClock() - turnStarted >= SPIDER_COMPANY_RUN_MS;
    const progress = newProgress();
    try {
      const r = await runWithOrg(orgId, () => sweepCompany(orgId, now, available, stillHeld, timeUp, progress, tickOn));
      result.leadsChecked += r.leadsChecked;
      result.alertsSent += r.alertsSent;
      result.alertsEnded += r.alertsEnded;
      result.leadsSummarized += r.leadsSummarized;
      // After the company's alerts and summary, so the check never waits ahead of them: the people the saved recipients no
      // longer cover lose their rows (#3462). Skipped when the company's alerts were all just ended (off, outside the gate).
      if (!['outside_gate', 'switched_off', 'not_activated'].includes(r.skipped ?? '')) {
        result.alertsEnded += await runWithOrg(orgId, () => endUncoveredAfterRun(orgId, now));
      }
      if (r.skipped) skipped[r.skipped] = (skipped[r.skipped] ?? 0) + 1;
      else logCompanySwept(orgId, progress, Date.now() - startedAt);
    } catch (err) {
      // The company's line is still written, with the counts reached so far: a slow or failing company is
      // the case this line exists to show. `outcome` is the error class or code only, never a message.
      logCompanySwept(orgId, progress, Date.now() - startedAt, errorName(err));
      logger.error(`[spider] sweep failed for org ${orgId}: ${errorName(err)}`);
    }
  }
  if (Object.keys(skipped).length > 0) logger.info('[spider] companies skipped this run', { skipped });
  if (tickOn) {
    // What the safety net had to do itself (#3471): the check alerts within seconds, so this is 0. Above 0 the check missed alerts.
    result.safetyCaught = result.alertsSent;
    const line = { safetyCaught: result.safetyCaught, companies: result.companies, leadsChecked: result.leadsChecked, alertsEnded: result.alertsEnded, durationMs: Date.now() - runStarted };
    if (result.safetyCaught > 0) logger.warn('[spider] safety sweep alerted leads the check should have: the check missed alerts', line);
    else logger.info('[spider] safety sweep ran', line);
  }
  return result;
}

/** What a company's run had reached, for its log line (kept outside sweepCompany's result so a failure still has it). */
interface CompanyProgress {
  leadsChecked: number;
  /** Visits past their limit. */
  overdue: number;
  /** Of those, already claimed by an earlier run's alert or summary in this switched-on period. */
  alreadyClaimed: number;
  /** Visits THIS run claimed: per-lead claims plus the starting summary's. */
  claimed: number;
  alertsSent: number;
  /**
   * Why the run's per-lead alerts stopped before every overdue lead was alerted, when they did (#2991): more were
   * overdue than one run alerts (`alert_cap`), the company's time ran out (`time_cap`), or the server is stopping
   * (`shutdown`). The rest wait for the next run.
   */
  stoppedBy?: 'alert_cap' | 'time_cap' | 'shutdown';
}

function newProgress(): CompanyProgress {
  return { leadsChecked: 0, overdue: 0, alreadyClaimed: 0, claimed: 0, alertsSent: 0 };
}

/**
 * The run's one line per company it processed. Ids and counts only: never a name, a contact or lead
 * content (a test pins the exact key set). `outcome` appears only when the company's sweep threw, `stoppedBy` only
 * when its per-lead alerts stopped early (#2991).
 * Later sweep work adds its counters here.
 */
function logCompanySwept(orgId: string, p: CompanyProgress, durationMs: number, outcome?: string): void {
  logger.info('[spider] company swept', {
    orgId,
    leadsChecked: p.leadsChecked,
    overdue: p.overdue,
    claimed: p.claimed,
    alreadyClaimed: p.alreadyClaimed,
    alertsSent: p.alertsSent,
    durationMs,
    ...(p.stoppedBy ? { stoppedBy: p.stoppedBy } : {}),
    ...(outcome ? { outcome } : {}),
  });
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
  /** The lead's owner now: a recipient when the company chose the lead owner (recipients.ts). */
  owner_id: string | null;
}

/**
 * Each lead's current stage visit: its Spider stage and the instant it entered it (spiderStageOf).
 * Leads in no stage are left out. No row cap, but never all of a company's leads in one read (#2992, pages.ts): every
 * open lead in keyset pages of SWEEP_PAGE_SIZE by lead id, or the given leads in chunks of SWEEP_PAGE_SIZE ids. `open`
 * leaves out the leads that are Won, Lost or Cancelled before reading them, which spiderStageOf would leave out anyway,
 * and then the company's excluded leads (#3434), in memory: the number of reads never depends on how many are excluded.
 */
async function currentStageVisits(
  orgId: string,
  filter: { leadIds: readonly string[] } | { open: true; excludedLeadIds: readonly string[] },
): Promise<StageVisit[]> {
  let leads: Prisma.LeadGetPayload<{ select: typeof STAGE_VISIT_SELECT }>[];
  if ('leadIds' in filter) {
    if (filter.leadIds.length === 0) return [];
    leads = await leadsInChunks([...new Set(filter.leadIds)], (ids) =>
      prisma.lead.findMany({ where: { organization_id: orgId, id: { in: ids } }, select: STAGE_VISIT_SELECT }),
    );
  } else {
    const excluded = new Set(filter.excludedLeadIds);
    leads = (await allOpenLeads(orgId)).filter((l) => !excluded.has(l.id));
  }
  return leads.flatMap((l) => {
    const visit = spiderStageOf(l);
    return visit
      ? [{ id: l.id, status: visit.stage, entered_at: visit.enteredAt, lead_status: l.status, created_at: l.created_at, owner_id: l.commission_owner_id ?? null }]
      : [];
  });
}

const STAGE_VISIT_SELECT = { id: true, commission_owner_id: true, ...SPIDER_LEAD_TIMES_SELECT } as const;

/**
 * A company's open leads, as the sweep counts them: not Won or Lost, and no won, lost or cancelled stamp. The migration
 * that filled spider_settings.excluded_lead_ids (20261110090000) uses the same condition.
 */
export function openLeadsWhere(orgId: string): Prisma.LeadWhereInput {
  return { organization_id: orgId, status: { notIn: ['WON', 'LOST'] }, won_at: null, lost_at: null, cancelled_at: null };
}

/** Every open lead of the company, in keyset pages of SWEEP_PAGE_SIZE by lead id (#2992, #3058): the one paged read of them. */
function allOpenLeads(orgId: string) {
  const where = openLeadsWhere(orgId);
  return allKeysetPages(
    (after) =>
      prisma.lead.findMany({
        where: { ...where, ...(after ? { id: { gt: after } } : {}) },
        select: STAGE_VISIT_SELECT,
        orderBy: { id: 'asc' },
        take: SWEEP_PAGE_SIZE,
      }),
    (l) => l.id,
  );
}

/** The settings that say which leads Spider watches. */
export interface WatchedSettings {
  status_limits: Prisma.JsonValue;
  excluded_lead_ids: string[];
  /**
   * The stays already past their limit when Spider was activated with "Skip them" (#3431, skippedStayKey): never
   * reported, neither per lead nor in a later starting summary. Empty otherwise.
   */
  backlog_skipped_stays: string[];
}

/**
 * One lead stay: the lead, its Spider stage and the instant it entered it. A lead that leaves the stage and comes back
 * has a new stay with a new key.
 */
export function skippedStayKey(v: { id: string; status: string; entered_at: Date }): string {
  return `${v.id}|${v.status}|${v.entered_at.getTime()}`;
}

/**
 * What Spider watches for a company with these settings, at `now`, in the active period that started at `activatedAt`:
 * the ONE rule, used by the sweep and by the activation preview (#3431), so the review's numbers are the sweep's.
 *
 * - `visits`: every open lead that is not excluded (#3434) whose current stage has its time limit switched on. None
 *   while no stage has one (`noLimits`).
 * - `overdue`: of those, the stays already past their limit. Time in the stage counts from when the lead entered it
 *   (#2794); `countedFrom`, the later of that and `activatedAt`, only names the active period in the claim key (D5).
 *   The stays skipped by an Activate with "Skip them" (`backlog_skipped_stays`) are left out; nothing else is.
 */
export async function watchedVisits(orgId: string, settings: WatchedSettings, now: Date, activatedAt: Date) {
  const limits = readStatusLimits(settings.status_limits);
  const noLimits = !SPIDER_WATCHED_STATUSES.some((s) => limits[s].enabled);
  const visits = !noLimits
    ? (await currentStageVisits(orgId, { open: true, excludedLeadIds: settings.excluded_lead_ids })).filter(
        (v) => limits[v.status].enabled,
      )
    : [];
  const skipped = new Set(settings.backlog_skipped_stays);
  const overdue = visits.flatMap((v) => {
    const limit = limits[v.status];
    if (!isPastLimit(v.entered_at, limit, now)) return [];
    if (skipped.has(skippedStayKey(v))) return [];
    const countedFrom = v.entered_at > activatedAt ? v.entered_at : activatedAt;
    return [{ ...v, countedFrom, limit }];
  });
  return { noLimits, visits, overdue };
}

/**
 * Whether a stay entered at `enteredAt` is past this stage's limit at `now`: the limit is switched on and the time in the
 * stage has reached it. The one rule for "overdue": the sweep alerts by it (watchedVisits) and an open alert stays open
 * only while it still holds (alertStillOpen, #3450).
 */
export function isPastLimit(enteredAt: Date, limit: SpiderStatusLimit, now: Date): boolean {
  return limit.enabled && now.getTime() - enteredAt.getTime() >= limitMs(limit.value, limit.unit);
}

/** One read per chunk of ids, one after another (the sweep's one connection), in order. */
async function leadsInChunks<T>(ids: readonly string[], read: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (const chunk of inChunks(ids)) out.push(...(await read(chunk)));
  return out;
}

/** Why a company was not swept (told apart from a quiet one in the logs). */
export type SkipReason = 'outside_gate' | 'switched_off' | 'not_activated' | 'summary_waiting' | 'no_limits_set';

interface CompanyResult {
  leadsChecked: number;
  /** Set when the company was skipped rather than swept. */
  skipped?: SkipReason;
  alertsSent: number;
  alertsEnded: number;
  leadsSummarized: number;
}

async function sweepCompany(
  orgId: string,
  now: Date,
  available: boolean,
  stillHeld: () => boolean,
  timeUp: () => boolean,
  progress: CompanyProgress = newProgress(),
  tickOn = false,
): Promise<CompanyResult> {
  // Read once for the whole company run: the end step checks open alerts against them (#3450), the rest alerts by them.
  const settings = await prisma.spiderSettings.findUnique({ where: { organization_id: orgId } });
  const alertsEnded = await endFinishedAlerts(orgId, now, openAlertRulesOf(settings));
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
    return { ...done({ skipped: 'outside_gate' }), alertsEnded: alertsEnded + (await endOpenSpiderRecords(orgId, now)) };
  }
  // Switched off: no open alert may remain (D4). The switch ends them itself; this repairs anything
  // it missed, within one run.
  if (settings && !settings.is_active) {
    return { ...done({ skipped: 'switched_off' }), alertsEnded: alertsEnded + (await endOpenSpiderRecords(orgId, now)) };
  }
  if (!settings?.is_active || !settings.activated_at) return done({ skipped: 'not_activated' });
  // The switched-on period this run read: alertLeads re-checks it before claiming and sending, so a
  // run that began before a switch-off never alerts into it (D4).
  const activatedAt = settings.activated_at;

  // A starting trigger still in its quiet period: alert nothing yet, so the backlog it brings under
  // watch arrives as one summary rather than one alert per lead, and several quick saves give one.
  // Never longer than SUMMARY_MAX_WAIT_MS from when it first started waiting, so saves that keep
  // coming cannot hold every alert back.
  // With the check on (tickOn) none of this is the sweep's: the check starts the summary within seconds (summaryStart.ts) and
  // the sweep only alerts what the check has not, leaving the stays that crossed before the trigger's moment to the summary.
  const trigger = settings.summary_trigger_at;
  const waitingSince = settings.summary_trigger_since ?? trigger;
  const waitedOut = !!waitingSince && now.getTime() - waitingSince.getTime() >= SWEEP_SUMMARY_MAX_WAIT_MS;
  if (!tickOn && trigger && now.getTime() - trigger.getTime() < SWEEP_SUMMARY_QUIET_MS && !waitedOut) return done({ skipped: 'summary_waiting' });

  const { noLimits, visits, overdue } = await watchedVisits(orgId, settings, now, activatedAt);

  // Skip visits already alerted (or summarized) in this switched-on period before doing any work for
  // them, by the same five parts as the unique key. The insert is still the authoritative claim; this
  // only keeps a long-overdue lead from costing a recipient lookup on every run.
  // In pages (#2992): at most SWEEP_PAGE_SIZE leads per read, and at most SWEEP_PAGE_SIZE rows, by alert id.
  const existing = await alertLogRowsOf(orgId, overdue.map((o) => o.id));
  const claimed = new Set(existing.map((e) => visitKey(e.lead_id, e.status, e.entered_status_at, e.counted_from)));
  progress.leadsChecked = visits.length;
  progress.overdue = overdue.length;
  const unclaimed = overdue.filter((o) => !claimed.has(visitKey(o.id, o.status, o.entered_at, o.countedFrom)));
  // Visits alerted in any switched-on period: an alert for one of these is a re-alert (D5).
  progress.alreadyClaimed = overdue.length - unclaimed.length;
  const visitedBefore = new Set(existing.map((e) => stageVisitKey(e.lead_id, e.status, e.entered_status_at)));

  const channels = readChannels(settings.channels);
  const recipientsConfig = readRecipients(settings.recipients);

  // Lost the lease (sweepLease.ts): no summary; the trigger stays and the next run sends it.
  if (!tickOn && trigger && !stillHeld()) return done({ leadsChecked: visits.length });
  if (!tickOn && trigger) {
    let leadsSummarized = 0;
    let failed = false;
    try {
      const r = await runStartingSummary({
        orgId,
        now,
        triggeredAt: trigger,
        triggerKind: isTriggerKind(settings.summary_trigger_kind) ? settings.summary_trigger_kind : 'SETTINGS_CHANGED',
        activatedAt,
        overdue: unclaimed.map((o) => ({ id: o.id, status: o.status, entered_at: o.entered_at, counted_from: o.countedFrom, limit: o.limit })),
        channels,
        recipientsConfig,
      });
      // The summary is a run of attempts (summaryRuns.ts): one that failed, or is waiting for its next try, keeps the trigger
      // and the company alerts nothing per lead meanwhile (the backlog would flood). It ends in a finished summary or, after
      // 3 attempts, in the per-lead alerts taking over; both clear the trigger below.
      if (r.state === 'waiting' || r.state === 'retry') return done({ leadsChecked: visits.length });
      leadsSummarized = r.leads;
      progress.claimed += r.leads;
    } catch (err) {
      failed = true;
      logger.error(`[spider] starting summary failed for org ${orgId}: ${errorName(err)}`);
    }
    if (failed && !waitedOut) {
      // The failure came before the summary's run could count an attempt: keep the trigger and try again on the next
      // run. No per-lead alert meanwhile, or the backlog would flood.
      return done({ leadsChecked: visits.length });
    }
    if (failed) {
      // Waiting for 10 minutes already. Drop the trigger only when no summary run is open: a run holds claims, and only its
      // own attempts (or giving up) may release them. If that cannot be told, the trigger stays.
      const open = await hasOpenSummaryRun(orgId).catch(() => true);
      if (open) return done({ leadsChecked: visits.length });
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

  // With the check on and a starting trigger waiting or being built, the stays that crossed by the trigger's moment belong to the
  // summary (the check starts it): only the ones that crossed after it are alerted on their own, exactly the check's cut-off.
  const tickTrigger = tickOn ? trigger : null;
  const perLead = tickTrigger ? unclaimed.filter((o) => o.entered_at.getTime() + limitMs(o.limit.value, o.limit.unit) > tickTrigger.getTime()) : unclaimed;

  // Who each lead's alert goes to, for every lead this run may alert, in one batched lookup (recipients.ts):
  // the people and their access are read once for the company, never once per lead.
  const recipientsByLead = perLead.length
    ? await resolveSpiderRecipientsForLeads(prisma, {
        orgId,
        leads: perLead.map((o) => ({ id: o.id, ownerId: o.owner_id })),
        recipients: recipientsConfig,
      })
    : new Map<string, SpiderRecipient[]>();

  // The flood guard counts the check and the sweep together (#3471): 100 per company in any 2 minutes across both, so what the
  // check alerted lately comes off this run's share. While the check is off the sweep alone alerts: its share is 100 per run.
  const cap = tickOn && perLead.length > 0 ? await floodGuardRoom(orgId, now) : SPIDER_ALERTS_PER_COMPANY_RUN;

  const alertsSent = await alertLeads({
    orgId,
    now,
    cap,
    visits: perLead.map((o) => ({
      leadId: o.id,
      status: o.status,
      enteredAt: o.entered_at,
      createdAt: o.created_at,
      countedFrom: o.countedFrom,
      limit: o.limit,
      recipients: recipientsByLead.get(o.id) ?? [],
      priorAlertForVisit: visitedBefore.has(stageVisitKey(o.id, o.status, o.entered_at)),
      leadStatus: o.lead_status,
    })),
    channels,
    activatedAt,
    stillHeld,
    timeUp,
    progress,
  });
  return done({ leadsChecked: visits.length, alertsSent, ...(noLimits ? { skipped: 'no_limits_set' as const } : {}) });
}

/**
 * How many more per-lead alerts the company may have now: SPIDER_ALERTS_PER_COMPANY_RUN less the alerts raised in the last
 * FLOOD_WINDOW_MS, whoever raised them (the check or the sweep). One count. The check's own statement counts the same rows
 * (tick.ts findDueStays).
 */
async function floodGuardRoom(orgId: string, now: Date): Promise<number> {
  const recent = await prisma.spiderAlert.count({
    where: { organization_id: orgId, kind: 'ALERTED', alerted_at: { gt: new Date(now.getTime() - FLOOD_WINDOW_MS) } },
  });
  return Math.max(0, SPIDER_ALERTS_PER_COMPANY_RUN - recent);
}

/**
 * The alert-log rows (alerts and summary claims) of these leads, with the parts of the claim key: chunks of
 * SWEEP_PAGE_SIZE leads, each read in keyset pages of SWEEP_PAGE_SIZE rows by alert id.
 */
async function alertLogRowsOf(orgId: string, leadIds: readonly string[]) {
  const rows: { id: string; lead_id: string; status: string; entered_status_at: Date; counted_from: Date }[] = [];
  for (const ids of inChunks(leadIds)) {
    rows.push(
      ...(await allKeysetPages(
        (after) =>
          prisma.spiderAlert.findMany({
            where: { organization_id: orgId, lead_id: { in: ids }, ...(after ? { id: { gt: after } } : {}) },
            select: { id: true, lead_id: true, status: true, entered_status_at: true, counted_from: true },
            orderBy: { id: 'asc' },
            take: SWEEP_PAGE_SIZE,
          }),
        (r) => r.id,
      )),
    );
  }
  return rows;
}

/** The claim's identity: the stage visit and the switched-on period (its counted-from instant). */
function visitKey(leadId: string, status: string, enteredAt: Date, countedFrom: Date): string {
  return `${stageVisitKey(leadId, status, enteredAt)}|${countedFrom.getTime()}`;
}

/** The stage visit alone, whichever switched-on period alerted it. */
function stageVisitKey(leadId: string, status: string, enteredAt: Date): string {
  return `${leadId}|${status}|${enteredAt.getTime()}`;
}

// ─── The run's per-lead alerts ───────────────────────────────────────────────

/** One overdue, unclaimed stage visit this run (or the check, tick.ts) may alert. */
export interface AlertVisit {
  leadId: string;
  status: SpiderStatus;
  enteredAt: Date;
  /** When the lead was created, for the New sentence (SPEC-4 D7). */
  createdAt: Date;
  countedFrom: Date;
  limit: { value: number; unit: SpiderUnit };
  /** The lead's people by Spider's rule, already checked to be able to open the lead (recipients.ts). */
  recipients: SpiderRecipient[];
  /** This stage visit was alerted in an earlier switched-on period: this alert is a re-alert (D5). */
  priorAlertForVisit: boolean;
  /** The lead's own status now: the card a live message carries routes on it, as the unread read's does (#3472). */
  leadStatus: string;
}

/**
 * What an alert's messages and History copy need from the lead, and what the check (tick.ts) needs before it plans: the
 * lead's owner (a recipient when the company chose the owner), its creation (the New sentence) and its status.
 */
const ALERT_LEAD_SELECT = {
  id: true,
  lead_number: true,
  commission_owner_id: true,
  created_at: true,
  status: true,
  customer_id: true,
  service_request: true,
  commission_owner: { select: { first_name: true, last_name: true } },
  lead_assignees: {
    select: { user: { select: { first_name: true, last_name: true } } },
    orderBy: { created_at: 'asc' as const },
    take: 1,
  },
  customer: {
    select: {
      first_name: true,
      last_name: true,
      company_name: true,
      // His fallback is the primary location, else the first: one row, primary first.
      service_locations: { select: CUSTOMER_LOCATION_SELECT, orderBy: [{ is_primary: 'desc' as const }, { created_at: 'asc' as const }], take: 1 },
    },
  },
  service_location: { select: LOCATION_SELECT },
} as const satisfies Prisma.LeadSelect;

export type AlertLead = Prisma.LeadGetPayload<{ select: typeof ALERT_LEAD_SELECT }>;

/** One alert, built before anything is written: its claim, its messages and the lead they came from. */
export interface PlannedAlert {
  visit: AlertVisit;
  lead: AlertLead;
  content: SpiderMessageContent;
  stageSentence: string;
  timeInStage: string;
  claim: Prisma.SpiderAlertCreateManyInput;
}

/**
 * What a company's per-lead alerts leave for the run's one end step (#2990): every write that would otherwise be one
 * per lead or per text. Filled while the alerts go out, written by finishAlerts.
 */
export interface RunWrites {
  /** Each in-app alert (emit's arguments) and the delivery record whose in-app outcome its write decides. */
  inApp: { args: EmitArgs; delivery: Record<string, ChannelDelivery>; channels: AlertChannels; leadStatus: string }[];
  /** The red-frame-only records (in-app alerts off). */
  frames: FrameRecord[];
  /** Leads re-alerted (D5): their earlier open cards are ended before the new ones are written. */
  realertedLeads: string[];
  /** Texts that went out, per alert, counted the moment each went out (comm-usage.ts reads the column). */
  textsSent: Map<string, number>;
  /** The delivery records, written last. */
  records: DeliveryRecord[];
}

export type AlertChannels = { email?: ChannelRecord; sms?: ChannelRecord; in_app?: { enabled: boolean; status: 'SENT' | 'SKIPPED' } };

/** A run's writes, before any is made. */
export function newRunWrites(): RunWrites {
  return { inApp: [], frames: [], realertedLeads: [], textsSent: new Map(), records: [] };
}

/**
 * The run's per-lead alerts for one company. The claims go in with one insert; everything that used to be written
 * once per lead or per text - the bell and red-frame records, the earlier cards a re-alert ends, the texting-usage
 * count and the delivery records - goes in with one write of each kind at the end (#2990, alertLog.ts, emitMany).
 * Between the two, each alert in turn, the leads overdue longest first.
 *
 * 0. This run's share (#2991, pickThisRun): at most SPIDER_ALERTS_PER_COMPANY_RUN of the visits, the ones overdue
 *    longest, among the leads someone can be told about. Only those are planned and claimed; the rest are left
 *    unclaimed for the next run, so a run never holds a claim it will not reach.
 * 1. Every chosen lead's content is read at once and each alert is built. A lead that is gone, or that nobody at all - not
 *    even an Admin - can sign in and open, is not claimed, so it can still alert once someone it would reach exists.
 * 2. The switch check (D4): Spider is still on in the switched-on period this run read; else nothing is claimed. It is
 *    not read again per alert: a switch-off from here on takes effect from the next run (Ran, 2026-11-04).
 * 3. One insert claims them all, as the alert-log rows: they carry the History tab's copy of the lead, the people
 *    and the messages as they are now (S3, the contractor's alert log), so what the tab shows never changes when the
 *    lead or a person does. A visit claimed meanwhile by an earlier or a parallel run is skipped by the unique key
 *    and is not returned: this run sends only for the claims it wrote itself. If the insert fails it throws:
 *    nothing was claimed, the company's log line carries the failure, and the next run tries again.
 * 4. Each claimed alert in turn: the lease (and the server's stop signal) and, from the second alert on, the company's
 *    time limit (runCaps.ts) come first, so an alert whose turn comes after a lost lease, a stop request or the time
 *    limit is not raised. Then it is emailed and texted (sendAlert). An alert already under way always finishes:
 *    nothing stops a run halfway through a lead.
 * 5. However the loop ends (finishAlerts): the claims it never acted on are released, so those visits are left
 *    unclaimed as they were when each claim was written in its own turn; the texts that went out are counted; the
 *    bell and frame records are written, the switch is checked once more after them (switched off meanwhile: they are
 *    ended at once, so no card stays open in a switched-off company); the delivery records last.
 *    A failed bell or frame write is thrown after everything else is written, so the company's line carries it;
 *    nothing is ever sent again for it.
 */
async function alertLeads(a: {
  orgId: string;
  now: Date;
  visits: AlertVisit[];
  /** The most alerts this run may raise: the company's share (SPIDER_ALERTS_PER_COMPANY_RUN, less what the check raised lately). */
  cap: number;
  channels: SpiderChannels;
  /** The switched-on period this run read (settings.activated_at); see stillOn. */
  activatedAt: Date;
  stillHeld: () => boolean;
  /** True once the company's time limit for this run has passed (runCaps.ts). */
  timeUp: () => boolean;
  progress: CompanyProgress;
}): Promise<number> {
  const { chosen, capped } = pickThisRun(a.visits, a.cap);
  const planned = await planAlerts(a.orgId, a.now, chosen, a.channels);
  if (planned.length === 0) return 0;
  // Lost the lease, or the server is stopping: no alert; every visit is still unclaimed for the next run.
  if (!a.stillHeld()) {
    if (stopRequested()) a.progress.stoppedBy = 'shutdown';
    return 0;
  }
  // The switch check (D4): switched off since this run read the settings - claim nothing, send nothing. The run's one
  // check before sending; a switch-off after it takes effect from the next run (Ran, 2026-11-04, "Next run").
  if (!(await stillOn(a.orgId, a.activatedAt))) return 0;

  let alertIds: Map<string, string>;
  try {
    // Each alert's list is stored once however many alerts told it, before the claims that point at it.
    const setIds = await recipientSetIds(prisma, a.orgId, planned.map((p) => p.visit.recipients));
    alertIds = await claimVisits(planned.map((p, i) => ({ ...p.claim, recipient_set_id: setIds[i]! })));
  } catch (err) {
    logger.error(`[spider] could not record the alerts for org ${a.orgId} - nothing sent: ${errorName(err)}`);
    throw err;
  }
  const mine = planned.flatMap((p) => {
    const alertId = alertIds.get(p.visit.leadId);
    return alertId ? [{ ...p, alertId }] : [];
  });
  a.progress.claimed += mine.length;
  if (capped) a.progress.stoppedBy = 'alert_cap';

  const writes = newRunWrites();
  // What every email and text of the run shares - the company row, the outbound number and which of the run's people
  // are suppressed - read once for the run by the first send that needs each (#2992, delivery.ts spiderSendCompany).
  const company = spiderSendCompany(
    a.orgId,
    mine.flatMap((p) => p.visit.recipients.flatMap((r) => (r.email?.trim() ? [r.email.trim()] : []))),
  );
  const unsent: string[] = [];
  let alertsSent = 0;
  let stopped: unknown = null;
  try {
    for (const [i, p] of mine.entries()) {
      // Lost the lease, or the server is stopping: no further alert; this one and the rest are released below.
      if (!a.stillHeld()) {
        if (stopRequested()) a.progress.stoppedBy = 'shutdown';
        unsent.push(...mine.slice(i).map((x) => x.alertId));
        break;
      }
      // The company's time for this run is up (runCaps.ts): stop here, between two alerts; the rest wait for the next
      // run. The first alert always goes, so a company whose reads alone take long still moves forward.
      if (i > 0 && a.timeUp()) {
        a.progress.stoppedBy = 'time_cap';
        unsent.push(...mine.slice(i).map((x) => x.alertId));
        break;
      }
      try {
        const sent = await sendAlert({
          orgId: a.orgId,
          now: a.now,
          alert: p,
          alertId: p.alertId,
          channels: a.channels,
          activatedAt: a.activatedAt,
          writes,
          company,
        });
        if (sent) {
          alertsSent += 1;
          a.progress.alertsSent += 1;
        }
      } catch (err) {
        logger.error(`[spider] alert failed for org ${a.orgId} lead ${p.visit.leadId}: ${errorName(err)}`);
      }
    }
  } catch (err) {
    // Nothing in the loop is expected to throw (each alert has its own catch); if something does, what already went
    // out is still counted and recorded below before the failure goes on to the company's line.
    stopped = err;
  }
  const failed = await finishAlerts({ orgId: a.orgId, now: a.now, activatedAt: a.activatedAt, unsent, writes, progress: a.progress });
  if (stopped ?? failed) throw stopped ?? failed;
  return alertsSent;
}

/**
 * The run's end step for its per-lead alerts: one write of each kind, in this order. Returns the bell or frame write's
 * failure (after everything else is written), or null. Every other failure is logged here by id and never thrown.
 */
async function finishAlerts(a: {
  orgId: string;
  now: Date;
  activatedAt: Date;
  unsent: string[];
  writes: RunWrites;
  progress: CompanyProgress;
}): Promise<unknown> {
  const { orgId, now, writes } = a;
  if (a.unsent.length > 0) {
    try {
      await releaseClaims(orgId, a.unsent);
      a.progress.claimed -= a.unsent.length;
    } catch (err) {
      // Those visits stay claimed with nothing sent, so they never alert in this switched-on period: say so, by id.
      logger.error(`[spider] could not release ${a.unsent.length} unsent claims for org ${orgId} (alerts ${a.unsent.join(', ')}): ${errorName(err)}`);
    }
  }

  // The texts that went out, first: they count toward the company's texting usage whatever fails after.
  await countSentTexts(orgId, writes.textsSent);

  const failed = await writeAlertRecords({ orgId, now, activatedAt: a.activatedAt, writes });

  await recordDeliveries(orgId, writes.records);
  return failed;
}

/**
 * The bell and red-frame records of a batch of claimed per-lead alerts, in this order: the earlier cards a re-alert
 * replaces are ended (D5), the in-app records are written (emitMany) and fill in each alert's in-app outcome, the
 * red-frame-only records are written, and the switch is checked once more after them (switched off meanwhile: they are
 * ended at once, so no card stays open in a switched-off company). The sweep calls it at the end of its run, after the
 * emails and texts (finishAlerts); the check (tick.ts) calls it right after its claims, before any email or text starts
 * (#3469: the pop-up exists before the email is handed over). Returns the bell or frame write's failure, or null; every
 * other failure is logged here by id and never thrown.
 */
export async function writeAlertRecords(a: { orgId: string; now: Date; activatedAt: Date; writes: RunWrites }): Promise<unknown> {
  const { orgId, now, writes } = a;
  // A re-alert replaces any card still open for its lead (D5): the lead never shows two. Any open record for it is an
  // earlier period's alert for this same visit, or an older visit's that endFinishedAlerts already ended at the start of
  // this run. Only ends records, and never fails the new alerts over what is only a duplicate on screen.
  if (writes.realertedLeads.length > 0) {
    try {
      await endOpenSpiderRecords(orgId, now, { leadIds: writes.realertedLeads });
    } catch (err) {
      logger.error(`[spider] could not end the earlier alerts for org ${orgId} leads ${writes.realertedLeads.join(', ')}: ${errorName(err)}`);
    }
  }

  let failed: unknown = null;
  // What the live line tells each person once the switch check below has passed (#3472): their new cards and frames.
  const added: SpiderAddedAlertRow[] = [];
  let frames: SpiderRecordRow[] = [];
  // The in-app alerts: emit's rows for every one of them, in one step (emitMany). Their people were checked to be able
  // to open each lead by Spider's rule (recipients.ts, the bell's own row check asked for all the run's leads at once).
  if (writes.inApp.length > 0) {
    let result: EmitManyResult;
    try {
      result = await emitMany(writes.inApp.map((x) => x.args));
    } catch (err) {
      failed = err;
      logger.error(`[spider] could not show ${writes.inApp.length} alerts in the app for org ${orgId}: ${errorName(err)}`);
      result = { told: writes.inApp.map(() => []), written: writes.inApp.map(() => null) };
    }
    for (const [i, x] of writes.inApp.entries()) {
      const shown = result.told[i]!.length > 0;
      x.delivery.in_app = { outcome: shown ? 'Shown in the app' : 'No one to alert in the app' };
      x.channels.in_app = { enabled: true, status: shown ? 'SENT' : 'SKIPPED' };
      const w = result.written[i];
      for (const r of w?.rows ?? []) {
        added.push({ ...r, notification: { object_id: w!.objectId, data: w!.data }, leadStatus: x.leadStatus });
      }
    }
  }
  if (writes.frames.length > 0) {
    try {
      frames = await recordFramesOnly(orgId, writes.frames);
    } catch (err) {
      failed ??= err;
      logger.error(`[spider] could not record the red frame for ${writes.frames.length} alerts for org ${orgId}: ${errorName(err)}`);
    }
  }

  // The switch check (D4) for the records just written: the switch writes the flag and then ends the open records, this
  // wrote the records and now checks. So either the switch's clear saw them, or this check sees the switch, and ends them.
  const shownIds = [...writes.inApp.map((x) => String(x.args.data?.spider_alert_id)), ...writes.frames.map((f) => f.alertId)];
  if (shownIds.length > 0 && !(await stillOnAfterClaim(orgId, a.activatedAt, shownIds.join(', ')))) {
    try {
      await endOpenSpiderRecords(orgId, now, { alertIds: shownIds });
    } catch (err) {
      logger.error(`[spider] could not end alerts ${shownIds.join(', ')} after a switch-off: ${errorName(err)}`);
    }
  } else {
    // Written and still on: each person's screen shows them now (after the rows above are committed, and after any
    // earlier card a re-alert ended, so a lead never shows two).
    publishSpiderLive(orgId, { type: 'alerts_added', alerts: added, frames });
  }
  return failed;
}

/**
 * This run's share of a company's overdue visits (#2991): the leads someone can be told about (planAlerts leaves the
 * others unclaimed anyway, and they must not take a place in the batch), oldest overdue first - the instant each
 * crossed its limit, then the lead id, so the order is the same on every run - and at most
 * SPIDER_ALERTS_PER_COMPANY_RUN of them. A lead left out is never overtaken by one that became overdue after it, so
 * every lead waits at most as many runs as there are batches of leads overdue before it.
 */
export function pickThisRun(
  visits: readonly AlertVisit[],
  /** The share: never more than SPIDER_ALERTS_PER_COMPANY_RUN (less when the check has raised alerts in the flood window). */
  limit: number = SPIDER_ALERTS_PER_COMPANY_RUN,
): { chosen: AlertVisit[]; capped: boolean } {
  const overdueAt = (v: AlertVisit) => v.enteredAt.getTime() + limitMs(v.limit.value, v.limit.unit);
  const eligible = visits
    .filter((v) => v.recipients.length > 0)
    .sort((x, y) => overdueAt(x) - overdueAt(y) || (x.leadId < y.leadId ? -1 : x.leadId > y.leadId ? 1 : 0));
  return { chosen: eligible.slice(0, limit), capped: eligible.length > limit };
}

/** Reads every lead's content in one query and builds each alert's claim and messages, in the visits' order. */
async function planAlerts(orgId: string, now: Date, visits: readonly AlertVisit[], channels: SpiderChannels): Promise<PlannedAlert[]> {
  if (visits.length === 0) return [];
  const leads = await readAlertLeads(orgId, visits.map((v) => v.leadId));
  return buildAlertPlans(orgId, now, visits, channels, new Map(leads.map((l) => [l.id, l])));
}

/** These leads of this company, with what their alerts need (ALERT_LEAD_SELECT), in one query. */
export async function readAlertLeads(orgId: string, leadIds: readonly string[]): Promise<AlertLead[]> {
  if (leadIds.length === 0) return [];
  return prisma.lead.findMany({ where: { organization_id: orgId, id: { in: [...new Set(leadIds)] } }, select: ALERT_LEAD_SELECT });
}

/**
 * Builds each alert's claim and messages from leads already read, in the visits' order. A lead that is gone, or that
 * nobody at all can be told about, is left out (never claimed).
 */
export function buildAlertPlans(
  orgId: string,
  now: Date,
  visits: readonly AlertVisit[],
  channels: SpiderChannels,
  leadById: ReadonlyMap<string, AlertLead>,
): PlannedAlert[] {
  return visits.flatMap((v) => {
    const lead = leadById.get(v.leadId);
    if (!lead || v.recipients.length === 0) return [];
    // The contractor's message content (services/spider/messages.ts). Time in the stage is counted
    // from the instant the lead entered it, as his sentence says ("This lead was created 2 days ago").
    const timeInStage = formatHumanReadableDuration(Math.floor((now.getTime() - v.enteredAt.getTime()) / 1000));
    // The New sentence says "This lead was created X ago": X counts from the lead's creation. For a
    // first New stay that is the stage's own entry instant; for a lead moved back to New (SPEC-4 D7)
    // the stay is younger than the lead, and the sentence must stay true.
    const sentenceTime =
      v.status === 'NEW'
        ? formatHumanReadableDuration(Math.floor((now.getTime() - v.createdAt.getTime()) / 1000))
        : timeInStage;
    const content: SpiderMessageContent = {
      leadNumber: lead.lead_number || `Lead #${lead.id.slice(0, 6)}`,
      customerName: customerName(lead.customer),
      stage: v.status,
      timeInStage,
      sentenceTime,
      assignedTo: spiderAssignedUserName(lead),
      serviceLocation: resolveServiceAddress(lead, lead.customer),
      leadUrl: `${env.FRONTEND_URL.replace(/\/+$/, '')}/leads/${lead.id}`,
    };
    const claim: Prisma.SpiderAlertCreateManyInput = {
      organization_id: orgId,
      lead_id: lead.id,
      status: v.status,
      entered_status_at: v.enteredAt,
      counted_from: v.countedFrom,
      limit_value: v.limit.value,
      limit_unit: v.limit.unit,
      alerted_at: now,
      recipient_ids: v.recipients.map((r) => r.id),
      lead_number: content.leadNumber,
      customer_id: lead.customer_id,
      customer_name: content.customerName,
      company_name: lead.customer.company_name?.trim() || null,
      service_request: lead.service_request || null,
      service_location: content.serviceLocation,
      stage_name: SPIDER_STAGE_NAME[v.status],
      // His elapsedValue: whole units of the limit's unit, never less than 1.
      elapsed_value: Math.max(1, Math.floor((now.getTime() - v.enteredAt.getTime()) / limitMs(1, v.limit.unit))),
      elapsed_unit: v.limit.unit,
      // The people (name, email, role and how each was chosen - never a phone number) are stored once per distinct
      // list (recipientSets.ts); alertLeads sets recipient_set_id just before the claims go in. The row keeps no copy.
      email_subject: spiderAlertHeader(content),
      email_body: spiderFullTextMessage(content),
      sms_message: spiderFullTextMessage(content),
      in_app_message: spiderStageSentence(v.status, sentenceTime),
      channels: {
        email: { enabled: channels.email },
        sms: { enabled: channels.text },
        in_app: { enabled: channels.in_app },
      },
    };
    return [{ visit: v, lead, content, stageSentence: spiderStageSentence(v.status, sentenceTime), timeInStage, claim }];
  });
}

/**
 * One claimed alert: its email and its text go out now; its bell or frame record, the ending of an earlier card, its
 * texting-usage count and its delivery record are left in `writes` for the run's end step (finishAlerts). Returns
 * true: once claimed, an alert goes out in full (a switch-off during the run takes effect from the next run).
 */
async function sendAlert(a: {
  orgId: string;
  now: Date;
  alert: PlannedAlert;
  alertId: string;
  channels: SpiderChannels;
  /** The switched-on period this run read (settings.activated_at); see stillOn. */
  activatedAt: Date;
  writes: RunWrites;
  /** The run's shared company reads for its emails and texts (delivery.ts spiderSendCompany). */
  company: SpiderSendCompany;
}): Promise<boolean> {
  const outcome = queueAlertRecord(a);
  // No switch read here: the run checked the switch before its claims, and a switch-off since then takes effect from the
  // next run (Ran, 2026-11-04, "Next run"). The bell or frame record is written at the end step, which checks the
  // switch once more after writing them (finishAlerts) and ends them if Spider was switched off meanwhile.
  await sendAlertMessages({ ...a, outcome });
  return true;
}

/** One claimed alert's outcome so far: its delivery record and the History tab's per-channel record. */
export interface AlertOutcome {
  delivery: Record<string, ChannelDelivery>;
  channels: AlertChannels;
}

/**
 * Who of an alert's people has had their email or text answered so far, by user id (#3469): filled while its sends are on
 * their way, read when a stop no longer waits for them, so a person who got their email or text is recorded as sent and
 * only the rest as interrupted.
 */
export interface SendProgress {
  email: Map<string, PersonDelivery>;
  text: Map<string, PersonDelivery>;
}

export function newSendProgress(): SendProgress {
  return { email: new Map(), text: new Map() };
}

/**
 * A channel's record when its sends were interrupted: each person whose answer `done` holds keeps it, everyone else is
 * recorded interrupted (not sent again).
 */
function interruptedChannel(
  recipients: readonly SpiderRecipient[],
  done: ReadonlyMap<string, PersonDelivery> | undefined,
  interrupted: { outcome: string; reason: string },
  summary: (outcomes: RecipientOutcome[]) => string,
): { delivery: ChannelDelivery; results: RecipientResult[] } {
  const people = recipients.map(
    (r): PersonDelivery =>
      done?.get(r.id) ?? {
        outcome: { user_id: r.id, outcome: interrupted.outcome },
        result: { user_id: r.id, result: 'skipped', reason: interrupted.reason },
      },
  );
  const outcomes = people.map((p) => p.outcome);
  // Nobody answered yet (or nobody to tell): the channel's line stays the interrupted line it always was.
  const answered = outcomes.some((o) => o.outcome !== interrupted.outcome);
  return {
    delivery: { outcome: answered ? summary(outcomes) : interrupted.outcome, recipients: outcomes },
    results: people.map((p) => p.result),
  };
}

/**
 * One claimed alert's bell record (or its red-frame-only record, in-app alerts off), and the ending of the lead's earlier
 * card when it is a re-alert (D5), queued in `writes` for writeAlertRecords. Writes nothing itself. Returns the alert's
 * outcome so far; writeAlertRecords fills in its in-app part and sendAlertMessages the rest.
 */
export function queueAlertRecord(a: {
  orgId: string;
  alert: PlannedAlert;
  alertId: string;
  channels: SpiderChannels;
  writes: RunWrites;
}): AlertOutcome {
  const { visit, lead, content, stageSentence, timeInStage } = a.alert;
  const { alertId, writes } = a;
  const recipients = visit.recipients;
  const statusLabel = LEAD_STATUS_LABEL[visit.status];
  const ownerName = lead.commission_owner
    ? `${lead.commission_owner.first_name} ${lead.commission_owner.last_name}`.trim() || null
    : null;

  // A re-alert replaces any card still open for this lead (D5), at the end step, before the new card is written.
  if (visit.priorAlertForVisit) writes.realertedLeads.push(lead.id);

  const delivery: Record<string, ChannelDelivery> = {};
  // The History tab's per-channel outcome (his alert log's `channels`): email, sms, in_app.
  const channels: AlertChannels = { in_app: { enabled: false, status: 'SKIPPED' } };

  // Stored at alert time, as the contractor's in-app data was: the popup card reads these, and the
  // ending rule reads `status` and `entered_status_at`.
  const notificationData = {
    object_label: content.leadNumber,
    spider_alert_id: alertId,
    lead_id: lead.id,
    lead_number: content.leadNumber,
    customer_name: content.customerName,
    company_name: lead.customer.company_name?.trim() || null,
    status: visit.status,
    status_label: statusLabel,
    stage_name: SPIDER_STAGE_NAME[visit.status],
    service_location: content.serviceLocation,
    service_request: lead.service_request || null,
    assigned_to: content.assignedTo,
    address: content.serviceLocation,
    owner_name: ownerName,
    entered_status_at: visit.enteredAt.toISOString(),
    stage_entered_at: visit.enteredAt.toISOString(),
    // The pop-up rebuilds the New sentence ("created X ago") live from this, not from the stay (SPEC-4 D7).
    lead_created_at: visit.createdAt.toISOString(),
    counted_from: visit.countedFrom.toISOString(),
    time_in_status: timeInStage,
    time_in_stage: timeInStage,
    title: spiderAlertHeader(content),
    body: stageSentence,
    full_message: spiderFullTextMessage(content),
    lead_url: content.leadUrl,
  };

  if (a.channels.in_app) {
    // Written by writeAlertRecords with every other alert of the batch (emitMany), which then fills in the in-app outcome.
    writes.inApp.push({
      args: {
        verb: SPIDER_ALERT_VERB,
        organizationId: a.orgId,
        actorId: null,
        object: { type: 'LEAD', id: lead.id, label: content.leadNumber },
        entity: { recipient_ids: recipients.map((r) => r.id) },
        data: notificationData,
        dedupKey: `${SPIDER_ALERT_VERB}:${alertId}`,
        // Every one of them was checked to be able to open this lead by Spider's rule (recipients.ts, the bell's own
        // row check asked for all the run's leads at once), so the row-scope filter is not asked again per lead.
        readersChecked: true,
      },
      delivery,
      channels,
      leadStatus: visit.leadStatus,
    });
  } else {
    // His Red Frame works on its own: with in-app alerts off, each recipient still gets a record so
    // the frame shows (and ends when the lead leaves the stage), and the bell never lists it.
    if (a.channels.red_frame && recipients.length > 0) {
      writes.frames.push({ leadId: lead.id, alertId, recipientIds: recipients.map((r) => r.id), content, stageSentence, data: notificationData });
    }
    delivery.in_app = { outcome: 'In-app alerts are switched off' };
  }
  return { delivery, channels };
}

/**
 * One claimed alert's email and text, started together (#3470), then its delivery record queued in `writes` (recordDeliveries
 * writes it). The only caller of deliverSpiderEmails and deliverSpiderTexts: the sweep's sendAlert, and the check
 * (tick.ts) once the alert's bell or frame record is written. With `interrupted`, nothing goes out: the server is
 * stopping after the alert's record was written, and its email and text say they were interrupted, as a starting
 * summary's do (summary.ts), except for each person whose email or text already answered (`sendProgress`), who keeps
 * that answer; they are never sent later.
 */
export async function sendAlertMessages(a: {
  orgId: string;
  alert: PlannedAlert;
  alertId: string;
  channels: SpiderChannels;
  writes: RunWrites;
  /** The run's shared company reads for its emails and texts (delivery.ts spiderSendCompany). */
  company: SpiderSendCompany;
  outcome: AlertOutcome;
  interrupted?: boolean;
  /**
   * Sending, filled person by person as each answers; with `interrupted`, what already answered, kept as it is (the people
   * of an alert in flight when the stop's wait ran short, tick.ts).
   */
  sendProgress?: SendProgress;
}): Promise<void> {
  const { visit, lead, content } = a.alert;
  const { alertId, writes } = a;
  const { delivery, channels } = a.outcome;
  const recipients = visit.recipients;

  // The email and the text start at the same moment (#3470): the emails as one batch request, the texts side by side.
  // Each logs how long it took (ids and counts only, never an address or a number).
  let emailMs = 0;
  let textMs = 0;
  await runTogether(
    async () => {
      if (!a.channels.email) {
        delivery.email = { outcome: EMAIL_OUTCOME.channelOff };
        channels.email = { ...channelRecord(false, []), from: SPIDER_EMAIL_FROM_LINE };
      } else if (a.interrupted) {
        const kept = interruptedChannel(recipients, a.sendProgress?.email, { outcome: EMAIL_OUTCOME.interrupted, reason: EMAIL_REASON.interrupted }, summariseEmail);
        delivery.email = kept.delivery;
        channels.email = { ...channelRecord(true, kept.results), from: SPIDER_EMAIL_FROM_LINE };
      } else {
        const t0 = Date.now();
        try {
          const sent = await deliverSpiderEmails({
            orgId: a.orgId,
            alertId,
            recipients,
            content,
            company: a.company,
            onPerson: (p) => a.sendProgress?.email.set(p.outcome.user_id, p),
          });
          delivery.email = { outcome: sent.outcome, recipients: sent.recipients };
          channels.email = { ...channelRecord(true, sent.results), from: SPIDER_EMAIL_FROM_LINE };
        } finally {
          emailMs = Date.now() - t0;
        }
      }
    },
    async () => {
      if (!a.channels.text) {
        delivery.text = { outcome: TEXT_OUTCOME.channelOff };
        channels.sms = channelRecord(false, []);
      } else if (a.interrupted) {
        const kept = interruptedChannel(recipients, a.sendProgress?.text, { outcome: TEXT_OUTCOME.interrupted, reason: TEXT_REASON.interrupted }, summariseText);
        delivery.text = kept.delivery;
        channels.sms = channelRecord(true, kept.results);
      } else {
        const t0 = Date.now();
        try {
          const sent = await deliverSpiderTexts({
            orgId: a.orgId,
            alertId,
            recipients,
            content,
            // Counted the moment it goes out, toward the batch's one usage write (countSentTexts), so a later failure in this
            // alert or the run cannot leave a sent text outside the company's texting usage.
            onSent: () => writes.textsSent.set(alertId, (writes.textsSent.get(alertId) ?? 0) + 1),
            company: a.company,
            onPerson: (p) => a.sendProgress?.text.set(p.outcome.user_id, p),
          });
          delivery.text = { outcome: sent.outcome, recipients: sent.recipients };
          channels.sms = channelRecord(true, sent.results);
        } finally {
          textMs = Date.now() - t0;
        }
      }
    },
  );

  writes.records.push({ id: alertId, delivery, channels });
  logger.info(a.interrupted ? '[spider] alert interrupted' : '[spider] alert sent', { orgId: a.orgId, leadId: lead.id, alertId, recipients: recipients.length, emailMs, textMs });
}

/**
 * Spider is still on for this company, in the same switched-on period this run read. One
 * primary-key read. Read before the run's claims and after its bell and frame records are written: a switch-off, or an
 * off-then-on (a new activated_at), before the claims sends nothing; one later ends the run's records at once. No lock: the sweep's single
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
 * The end step's switch check, once the run's records are written. A failed read counts as still on: an unreadable
 * switch is not a switch-off, and counting it as one would end live alerts. If Spider really was off, the next run
 * ends its open records (sweepCompany). Never throws, so the delivery records are always written.
 */
async function stillOnAfterClaim(orgId: string, activatedAt: Date, alertId: string): Promise<boolean> {
  try {
    return await stillOn(orgId, activatedAt);
  } catch (err) {
    logger.error(`[spider] could not check the switch for org ${orgId} alert ${alertId} - carrying on: ${errorName(err)}`);
    return true;
  }
}

/** One alert's red-frame-only record (in-app alerts off): who it reaches and what its card shows. */
interface FrameRecord {
  leadId: string;
  alertId: string;
  recipientIds: string[];
  content: SpiderMessageContent;
  stageSentence: string;
  data: Record<string, unknown>;
}

/**
 * The red-frame-only records of a run: one bell-hidden `spider.frame` notification per alert, one unread row per
 * recipient (the same people the email and text reach, already access-checked). Written directly rather than through
 * emit, so no bell template, toast or realtime ping is involved; every alert's rows in two statements (#2990). Throws
 * when the write fails (the run's end step records it). Returns each person's row (its id is made here, so the live line
 * can name it, #3472).
 */
async function recordFramesOnly(orgId: string, frames: readonly FrameRecord[]): Promise<SpiderRecordRow[]> {
  const withPeople = frames.filter((f) => f.recipientIds.length > 0);
  if (withPeople.length === 0) return [];
  const ids = withPeople.map(() => randomUUID());
  const rows = withPeople.flatMap((r, i) => r.recipientIds.map((recipientId) => ({ id: randomUUID(), notificationId: ids[i]!, recipientId })));
  await prisma.notification.createMany({
    data: withPeople.map((r, i) => ({
      id: ids[i]!,
      organization_id: orgId,
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
    })),
  });
  await prisma.notificationRecipient.createMany({
    data: rows.map((r) => ({
      id: r.id,
      notification_id: r.notificationId,
      organization_id: orgId,
      recipient_id: r.recipientId,
      priority: 'FEED' as const,
    })),
  });
  return rows.map((r) => ({ id: r.id, recipient_id: r.recipientId }));
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

/** A lead's stage visit now, as the ending rule reads it: from the lead (currentVisitsByLead) or its watch row (tick.ts). */
export type VisitNow = Pick<StageVisit, 'status' | 'entered_at'>;

/** Each lead's current stage visit, for these leads of this company (leads in no stage are absent). */
export async function currentVisitsByLead(orgId: string, leadIds: readonly string[]): Promise<Map<string, StageVisit>> {
  const visits = await currentStageVisits(orgId, { leadIds: [...new Set(leadIds)] });
  return new Map(visits.map((v) => [v.id, v]));
}

/**
 * Whether the lead has left the alerted stage visit: a different stage now or none, the same stage
 * entered again at a later instant, or the lead is gone. Half of the ending rule (alertStillOpen); the other half is the
 * saved settings (#3450).
 */
export function hasLeftAlertedVisit(alerted: AlertedVisit, visit: VisitNow | undefined): boolean {
  return !visit || visit.status !== alerted.status || visit.entered_at.toISOString() !== alerted.enteredAt;
}

/**
 * The saved settings an open alert is checked against (#3450, Ran 11 Nov: an open alert follows the settings saved now).
 * `null` when the company has no settings row: then only the stage visit decides.
 */
export interface OpenAlertRules {
  limits: Record<SpiderStatus, SpiderStatusLimit>;
  /** Whether the company excluded this lead (spider_settings.excluded_lead_ids, #3434). */
  isExcluded: (leadId: string) => boolean;
}

/** The rules from a settings row the caller already read (the exclusion list in memory: the sweep has the whole row). */
export function openAlertRulesOf(
  settings: { status_limits: Prisma.JsonValue; excluded_lead_ids: readonly string[] } | null,
): OpenAlertRules | null {
  if (!settings) return null;
  const excluded = new Set(settings.excluded_lead_ids);
  return { limits: readStatusLimits(settings.status_limits), isExcluded: (id) => excluded.has(id) };
}

/**
 * Which of these leads the company excluded: only those ids, never the whole list (it can hold thousands, and the
 * unread-alerts read runs every 30 s per person). One query, whatever the number of leads.
 */
export async function excludedAmong(orgId: string, leadIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(leadIds)];
  if (ids.length === 0) return new Set();
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT x::text AS id FROM (
      SELECT unnest(excluded_lead_ids) AS x FROM spider_settings WHERE organization_id = ${orgId}::uuid
      INTERSECT
      SELECT unnest(${ids}::uuid[])
    ) t`;
  return new Set(rows.map((r) => r.id));
}

/**
 * Whether an alert is still open: the ONE rule both the unread-alerts read and the sweep's end step use. Open while the
 * lead is still in the alerted stage visit (hasLeftAlertedVisit) and, under the settings saved now, the lead would still
 * be alerted: not excluded, its stage's limit switched on, and still past that limit (isPastLimit). So excluding the lead,
 * switching the stage off or lengthening the limit past where the lead is ends it; a shorter limit or more recipients
 * never does (an alerted lead is already past the old, longer limit).
 */
export function alertStillOpen(alerted: AlertedVisit, visit: VisitNow | undefined, rules: OpenAlertRules | null, now: Date): boolean {
  if (!visit || hasLeftAlertedVisit(alerted, visit)) return false;
  if (!rules) return true;
  return !rules.isExcluded(alerted.leadId) && isPastLimit(visit.entered_at, rules.limits[visit.status], now);
}

/** One unread Spider record, with only what the ending rule reads from its data (alertedVisitOf). */
interface OpenSpiderRecord {
  id: string;
  object_id: string;
  /** data.status when it is a string, else null. */
  status: string | null;
  /** data.entered_status_at when it is a string, else null. */
  entered_status_at: string | null;
}

/**
 * One page of this company's unread Spider records: the records (not their recipient rows) with at least one unread
 * recipient row, by record id after `after`, at most SWEEP_PAGE_SIZE. It reads the two fields of `data` the ending rule
 * uses, never the whole JSON, and a field that is not a string reads as none, as alertedVisitOf treats it. Driven by the
 * company's unread recipient rows (notification_recipients_unread_org_notification_idx, #2994).
 */
function openSpiderRecordsPage(orgId: string, after: string | undefined): Promise<OpenSpiderRecord[]> {
  return prisma.$queryRaw<OpenSpiderRecord[]>`
    SELECT DISTINCT r.notification_id AS id, n.object_id,
      CASE WHEN jsonb_typeof(n.data->'status') = 'string' THEN n.data->>'status' END AS status,
      CASE WHEN jsonb_typeof(n.data->'entered_status_at') = 'string' THEN n.data->>'entered_status_at' END AS entered_status_at
    FROM notification_recipients r
    JOIN notifications n ON n.id = r.notification_id
    WHERE r.organization_id = ${orgId}::uuid
      AND r.read_at IS NULL
      AND n.verb IN (${Prisma.join([...SPIDER_RECORD_VERBS])})
      ${after ? Prisma.sql`AND r.notification_id > ${after}::uuid` : Prisma.empty}
    ORDER BY r.notification_id
    LIMIT ${SWEEP_PAGE_SIZE}`;
}

/**
 * Marks read every unread Spider record (in-app alert or red-frame-only) in this company that is no
 * longer open (alertStillOpen): its lead has left the alerted stage visit, or the saved settings no longer alert it
 * (#3450). `rules` is read once per company run. Touches Spider rows only, and only
 * this company's. Page by page (#2992): each page of records, its leads' current visits, and the end of the page's
 * finished records, before the next page; a record ended on one page is behind the next page's start, so none is read
 * twice or skipped.
 */
async function endFinishedAlerts(orgId: string, now: Date, rules: OpenAlertRules | null): Promise<number> {
  let ended = 0;
  await forEachKeysetPage(
    (after) => openSpiderRecordsPage(orgId, after),
    (r) => r.id,
    async (page) => {
      const alerted = new Map<string, AlertedVisit>();
      for (const n of page) alerted.set(n.id, alertedVisitOf(n.object_id, { status: n.status, entered_status_at: n.entered_status_at }));

      const current = await currentVisitsByLead(orgId, [...alerted.values()].map((v) => v.leadId));
      const finished = [...alerted.entries()]
        .filter(([, a]) => !alertStillOpen(a, current.get(a.leadId), rules, now))
        .map(([notificationId]) => notificationId);
      if (finished.length === 0) return;

      const rows = await prisma.notificationRecipient.updateManyAndReturn({
        where: { organization_id: orgId, notification_id: { in: finished }, read_at: null },
        data: { read_at: now },
        select: { id: true, recipient_id: true },
      });
      ended += rows.length;
      // Each person's screen drops what ended now (#3472), after the update above is committed.
      publishSpiderLive(orgId, { type: 'alerts_ended', rows });
    },
  );
  return ended;
}

/** The run's last step for a company; a failure is logged (ids only) and never fails the company's run. Reads the settings now. */
async function endUncoveredAfterRun(orgId: string, now: Date): Promise<number> {
  try {
    // Raw, so it is not one of the run's on/off checks of the switch (sweepCompany reads the row through findUnique).
    const [settings] = await prisma.$queryRaw<{ recipients: Prisma.JsonValue }[]>`
      SELECT recipients FROM spider_settings WHERE organization_id = ${orgId}::uuid`;
    if (!settings) return 0;
    return await endUncoveredRecipientRows(orgId, now, readRecipients(settings.recipients));
  } catch (err) {
    logger.error(`[spider] could not end the rows of people no longer chosen for org ${orgId}: ${errorName(err)}`);
    return 0;
  }
}

/**
 * The save-time ending's whole step for one company: the alerts no longer open (endFinishedAlerts), then, for the people the
 * saved recipients no longer cover, their own rows of the alerts still open (endUncoveredRecipientRows, #3462). `before` is
 * the recipients the save replaced.
 */
async function endClosedAlerts(
  orgId: string,
  now: Date,
  settings: { status_limits: Prisma.JsonValue; excluded_lead_ids: readonly string[]; recipients: Prisma.JsonValue } | null,
  before?: SpiderRecipients,
): Promise<number> {
  const ended = await endFinishedAlerts(orgId, now, openAlertRulesOf(settings));
  if (!settings) return ended;
  return ended + (await endUncoveredRecipientRows(orgId, now, readRecipients(settings.recipients), before));
}

/** One unread Spider recipient row whose person no role or name chooses (the lead's owner is asked after). */
interface UncoveredCandidate {
  id: string;
  recipient_id: string;
  object_id: string;
  role: string;
  is_admin: boolean;
  /** The alert this row belongs to (data.spider_alert_id); the stored reason is read for a page, apart from this read. */
  alert_id: string | null;
}

/**
 * Marks read, for the people the saved recipients no longer cover, their own unread Spider rows, and only theirs: everyone
 * still covered keeps theirs, the alert's other rows and its alert-log claim are untouched ("Once is enough": nothing
 * re-alerts in the same stage visit). Ran, 12 Nov: adding never takes an alert away, a reassigned lead's old owner loses
 * theirs, a removal ends only what nothing left still covers (recipientCoverage.ts).
 *
 * Reads the company's unread rows whose person neither role nor name chooses, page by page (the lead's owner in memory
 * from one read of the page's leads). Per row: the lead's owner covers the person while "lead owner" is on; a person who
 * is not an Admin and is covered by nothing loses the row. An Admin loses it when the alert's stored list says they were
 * alerted as the lead's owner and they no longer are (any run), or in the save that removed what chose them (`before`
 * given: an entry of `before` named them, no entry of `recipients` does), and only when recipients.ts, asked for the
 * page's leads with the NEW recipients, no longer alerts them either (the Admins fallback, #2619). Then each page's ended rows
 * in one statement, and exactly those people's screens are told (`alerts_ended`). No per-alert query.
 */
export async function endUncoveredRecipientRows(
  orgId: string,
  now: Date,
  recipients: SpiderRecipients,
  before?: SpiderRecipients,
): Promise<number> {
  let ended = 0;
  // The candidate read is the plain one (the partial index on the unread rows). The stored reason is read apart, for each
  // page, by alert id (storedChosenAs), never joined in: under the production role such a join scans every company's alerts.
  // A sweep ends an Admin only when the stored reason is 'owner'; the others (role, name, fallback) only the removing save.
  await forEachKeysetPage(
    (after) => prisma.$queryRaw<UncoveredCandidate[]>`
      SELECT r.id, r.recipient_id, n.object_id, u.role::text AS role, u.is_admin, n.data->>'spider_alert_id' AS alert_id
      FROM notification_recipients r
      JOIN notifications n ON n.id = r.notification_id
      JOIN users u ON u.id = r.recipient_id
      WHERE r.organization_id = ${orgId}::uuid
        AND r.read_at IS NULL
        AND n.verb IN (${Prisma.join([...SPIDER_RECORD_VERBS])})
        AND u.role::text <> ALL(${recipients.roles}::text[])
        AND u.id <> ALL(${recipients.user_ids}::uuid[])
        ${after ? Prisma.sql`AND r.id > ${after}::uuid` : Prisma.empty}
      ORDER BY r.id
      LIMIT ${SWEEP_PAGE_SIZE}`,
    (r) => r.id,
    async (page) => {
      const person = (r: UncoveredCandidate): CoverageReader => ({ id: r.recipient_id, role: r.role, is_admin: r.is_admin });
      // The Admins' reasons, one read for the page (nothing when the page holds none).
      const adminRows = page.filter((r) => r.is_admin);
      const reasons = adminRows.length > 0
        ? await storedChosenAs(orgId, adminRows.map((r) => ({ alertId: r.alert_id, personId: r.recipient_id })))
        : new Map<string, string>();
      const chosenAs = (r: UncoveredCandidate) => reasons.get(`${r.alert_id}|${r.recipient_id}`);
      // Only rows that can still be ended are looked at further: anyone who is not an Admin, an Admin alerted as the lead's
      // owner, and (in a removing save) an Admin an entry of the old recipients named.
      const live = page.filter((r) => !r.is_admin || chosenAs(r) === 'owner' || !!before);
      // The leads' owners: wanted for "lead owner" now, and for the Admins an earlier "lead owner" named.
      const owners = new Map<string, string | null>();
      const ownerLeads = live.filter((r) => recipients.lead_owner || (!!before && before.lead_owner && r.is_admin));
      if (ownerLeads.length > 0) {
        for (const chunk of inChunks([...new Set(ownerLeads.map((r) => r.object_id))])) {
          const leads = await prisma.lead.findMany({
            where: { organization_id: orgId, id: { in: chunk } },
            select: { id: true, commission_owner_id: true },
          });
          for (const l of leads) owners.set(l.id, l.commission_owner_id);
        }
      }
      const open = live.filter((r) => !entryCovers(recipients, person(r), owners.get(r.object_id)));
      const uncovered = new Set(open.filter((r) => !r.is_admin).map((r) => r.id));
      // An Admin: when they were alerted as the lead's owner and no longer are (stored reason, Ran's ruling 3), or when the
      // save removed what chose them; and only if the fallback does not alert them now either.
      const admins = open.filter(
        (r) => r.is_admin && (chosenAs(r) === 'owner' || (!!before && entryCovers(before, person(r), owners.get(r.object_id)))),
      );
      if (admins.length > 0) {
        const leads = [...new Set(admins.map((r) => r.object_id))].map((id) => ({ id, ownerId: owners.get(id) ?? null }));
        const alerted = new Map<string, Set<string>>();
        for (const chunk of inChunks(leads)) {
          const byLead = await resolveSpiderRecipientsForLeads(prisma, { orgId, leads: chunk, recipients });
          for (const [leadId, people] of byLead) alerted.set(leadId, new Set(people.map((p) => p.id)));
        }
        for (const r of admins) if (!alerted.get(r.object_id)?.has(r.recipient_id)) uncovered.add(r.id);
      }
      if (uncovered.size === 0) return;
      const rows = await prisma.notificationRecipient.updateManyAndReturn({
        where: { organization_id: orgId, id: { in: [...uncovered] }, read_at: null },
        data: { read_at: now },
        select: { id: true, recipient_id: true },
      });
      ended += rows.length;
      // Each removed person's screen drops what ended now (#3472), after the update above is committed.
      publishSpiderLive(orgId, { type: 'alerts_ended', rows });
    },
  );
  return ended;
}

/**
 * Whether saving the limits `after` over `before` narrows what is watched: a stage whose limit was on is switched off or
 * lengthened. Only such a save can leave an open alert no longer open (alertStillOpen); a shorter limit or a stage
 * switched on never does.
 */
export function limitsNarrowed(before: Prisma.JsonValue, after: Prisma.JsonValue): boolean {
  const was = readStatusLimits(before);
  const now = readStatusLimits(after);
  return SPIDER_WATCHED_STATUSES.some(
    (s) => was[s].enabled && (!now[s].enabled || limitMs(now[s].value, now[s].unit) > limitMs(was[s].value, was[s].unit)),
  );
}

/**
 * The save-time ending (#3456): ends, now, every open Spider record of this company that the settings saved now no
 * longer alert (alertStillOpen: the lead excluded, its stage's limit switched off or lengthened past where it is), so
 * reversing the save cannot bring a card back, and its stay is never alerted again in this visit and switched-on period
 * ("Once is enough", #3450: the claim stays). Called by every save that can narrow what is watched, in the same request,
 * once the save is written; a save that narrows nothing ends nothing. The one reusable step: the recipients' save
 * (#3462) calls it too. Reads the saved settings once, then the company's open records page by page (endFinishedAlerts).
 */
export async function endAlertsNoLongerOpen(orgId: string, now: Date = new Date(), before?: SpiderRecipients): Promise<number> {
  const settings = await prisma.spiderSettings.findUnique({
    where: { organization_id: orgId },
    select: { status_limits: true, excluded_lead_ids: true, recipients: true },
  });
  if (!settings) return 0;
  return endClosedAlerts(orgId, now, settings, before);
}

/**
 * Marks read every unread Spider record (both verbs) of this company; or, with scope.alertIds, only
 * those alerts' records; or, with scope.leadIds, only those leads' (re-alerts replacing their cards, D5); or, with
 * scope.notificationIds, only those records (the check's ending, tick.ts).
 * An empty list ends nothing.
 * The one way Spider ends records whatever the lead is doing (Ran, 20 Oct, D4: switching Spider off
 * ends every open alert). Read is the same "ended" marker endFinishedAlerts writes and the unread
 * list filters on. Never deletes a row, never touches the alert log (History) or any other verb, and
 * never another company's rows.
 */
export async function endOpenSpiderRecords(
  orgId: string,
  now: Date,
  scope: { alertIds?: readonly string[]; leadIds?: readonly string[]; notificationIds?: readonly string[] } = {},
): Promise<number> {
  const { alertIds, leadIds, notificationIds } = scope;
  if (alertIds?.length === 0 || leadIds?.length === 0 || notificationIds?.length === 0) return 0;
  const rows = await prisma.notificationRecipient.updateManyAndReturn({
    where: {
      organization_id: orgId,
      read_at: null,
      ...(notificationIds ? { notification_id: { in: [...notificationIds] } } : {}),
      notification: {
        verb: { in: [...SPIDER_RECORD_VERBS] },
        ...(alertIds ? { dedup_key: { in: alertIds.flatMap((id) => SPIDER_RECORD_VERBS.map((verb) => `${verb}:${id}`)) } } : {}),
        ...(leadIds ? { object_id: { in: [...leadIds] } } : {}),
      },
    },
    data: { read_at: now },
    select: { id: true, recipient_id: true },
  });
  // Each person's screen drops what ended now (#3472), after the update above is committed.
  publishSpiderLive(orgId, { type: 'alerts_ended', rows });
  return rows.length;
}

// ─── Formatting ──────────────────────────────────────────────────────────────

/** An error's class name only - never its message, which can carry the values it failed on. */
function errorName(err: unknown): string {
  if (err instanceof Prisma.PrismaClientKnownRequestError) return `${err.name} ${err.code}`;
  return err instanceof Error ? err.name : 'unknown error';
}
