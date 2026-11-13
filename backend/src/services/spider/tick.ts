/**
 * The check, `spider-tick` (#3469): a lead alerts within about a second of crossing its limit, and its alert ends within
 * seconds of the lead leaving the stage. It reads the watch list the database keeps (spider_lead_watch, #3468), so it
 * runs ONLY once that list is complete: SPIDER_WATCH_LIST=check (watchList.ts). Otherwise it does nothing at all and the
 * 2-minute sweep (sweep.ts) alerts exactly as before. The sweep keeps running beside it either way - every 10 minutes, as the
 * safety net, while the check runs (#3471) - and both may find the same lead: the claim's unique key makes one of them win,
 * and the flood guard counts both. No lease for the alerts: claims are unique, so two servers (or a deploy overlap, #3079)
 * cannot alert a stay twice.
 *
 * The timer: one in-process setTimeout to the soonest known crossing among pending watch rows, never more than
 * MAX_WAIT_MS away, so a crossing is alerted within about a second and anything else (a lead saved, a save elsewhere)
 * within 5 s. A save in this process that may bring a crossing nearer (a limit shortened, a stage switched on, Activate,
 * a lead included again) wakes it at once (wakeSpiderTick). Its job name is `spider-tick` (JOBS_PAUSED); paused, it is
 * never started, and reads nothing.
 *
 * Each check, on the jobs client (lib/prismaJobs.ts), every statement its own short transaction, no row lock held across
 * a round trip:
 * 1. One read of the settings of every switched-on company; the gate (gate.ts) and the stages whose limit is on are
 *    applied here. Nothing switched on: the check ends here.
 * 2. ONE statement for every such company at once (findDueStays): the pending watch rows past their stage's limit, the
 *    limits passed in from step 1 (no copy of them is stored), by the sweep's rules: excluded leads left out, stays
 *    skipped by Activate + Skip never alerted (each company's own lists, never another company's), a stay claimed in
 *    this switched-on period never claimed again, and while a starting trigger waits or its summary is being built only
 *    stays that crossed AFTER the trigger's moment (earlier ones belong to the summary). At most
 *    SPIDER_ALERTS_PER_COMPANY_RUN per company in any FLOOD_WINDOW_MS, overdue longest first (#2991). The same statement
 *    clears `pending` on the stays already settled (claimed by the sweep or the summary, or skipped) and on an excluded
 *    lead's due stays (read once, not at every check; included again, the save watches them again: rearmIncludedLeads),
 *    and finds the next crossing for the timer.
 * 3. The ending (endChangedAlerts): the watch rows changed since the previous pass began that have an open Spider record
 *    get the ending rule (alertStillOpen); what is no longer open is ended now. Page by page (ENDING_PAGE_SIZE rows, at
 *    most ENDING_PAGES_PER_CHECK pages per check, each page two short reads): thousands of rows changed at once (an import,
 *    a mass status move) are ended over a few checks, and the next check goes on from where one stopped. A failed ending
 *    is logged and the check goes on with step 4; the ending's place moves only past the work that succeeded, so the next
 *    check reads those rows again.
 * 4. Per company with due stays: the leads read and their people resolved for the batch at once; a stay nobody can be
 *    told about takes no place and is not read again for UNREACHABLE_RECHECK_MS; then ONE statement claims them and
 *    clears their `pending` (alertLog.ts claimWatchedStays), stamped with the moment of the claim (`alerted_at`); then
 *    the pop-up / red-frame records are written (sweep.ts writeAlertRecords).
 * 5. The emails and texts are started, and the check ends: a pop-up never waits for an email or a text, and no email or
 *    text ever delays a check, a crossing or an ending. Each company's batches are sent one after another on the
 *    company's own chain, beside every other company's (startSends, drainCompany, sendBatch), alert by alert (sweep.ts
 *    sendAlertMessages), then its texting usage and delivery records are written; so one company's slow provider never
 *    delays another company's emails and texts. What waits on a chain is bounded by the flood guard (step 2: at most
 *    SPIDER_ALERTS_PER_COMPANY_RUN claims per company in any FLOOD_WINDOW_MS) and by the time limit on every send (an
 *    email batch request and its one retry, delivery.ts; a staff text, 10 s), so every alert's sends end in a bounded
 *    time and the chain drains. A stop (a deploy) claims nothing more; the alerts already shown still get their emails
 *    and texts while the stop's bounded wait has more than SEND_STOP_MARGIN_MS left (lib/graceful-stop.ts), and those
 *    that cannot fit are recorded interrupted (a company's whole waiting chain in one write). STOP_RECORD_MS before the wait ends, every alert not yet done is recorded
 *    interrupted at once, without waiting for a send still on its way (a person whose email or text already went out is
 *    recorded as sent), so the process never ends with a shown alert that has no record. A crash records nothing more:
 *    an alert whose sends never finished keeps no email or text outcome, never one that says sent (#3467). Nothing is
 *    sent twice: each claimed alert is sent once, here, and never by the next server.
 * 6. The starting summary (#3471, summaryStart.ts): a starting trigger that is ready - Activate (Send) at once, a widening Save 30
 *    s after the last one and at most 2 minutes after the first - starts its company's summary beside the check, never inside it,
 *    from the watch list: the stays past their limit AT THE TRIGGER'S MOMENT and not yet claimed. The stays that crossed after it
 *    are the due statement's (step 2), alerted on their own at their crossing during the wait and the build. A company whose
 *    summary run is waiting for its next try is not asked again before then.
 * 7. One log line per check, only when it did something (or its due statement was slow): ids and counts, never names.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { runOnJobsClient } from '../../lib/prismaJobs';
import { runUnscoped, runWithOrg } from '../../lib/tenant-context';
import { onStopTimeLeft, stopRequested, stopTimeLeftMs } from '../../lib/graceful-stop';
import { watchListMode } from './watchList';
import { spiderAvailableForOrg } from './gate';
import {
  SPIDER_WATCHED_STATUSES,
  limitMs,
  readChannels,
  readRecipients,
  readStatusLimits,
  type SpiderChannels,
  type SpiderStatus,
  type SpiderStatusLimit,
} from './config';
import { FLOOD_WINDOW_MS, SPIDER_ALERTS_PER_COMPANY_RUN } from './runCaps';
import { resolveSpiderRecipientsForLeads } from './recipients';
import { recipientSetIds } from './recipientSets';
import { claimWatchedStays, countSentTexts, recordDeliveries } from './alertLog';
import { _resetSummaryStart, startReadySummaries, summaryTriggerReadyAt, whenSummariesIdle } from './summaryStart';
import { spiderSendCompany, type SpiderSendCompany } from './delivery';
import { SPIDER_ALERT_VERB, SPIDER_FRAME_VERB } from '../notifications/bellHiddenVerbs';
import {
  alertStillOpen,
  alertedVisitOf,
  buildAlertPlans,
  endOpenSpiderRecords,
  newRunWrites,
  newSendProgress,
  pickThisRun,
  queueAlertRecord,
  readAlertLeads,
  sendAlertMessages,
  writeAlertRecords,
  type AlertOutcome,
  type AlertVisit,
  type OpenAlertRules,
  type PlannedAlert,
  type RunWrites,
  type SendProgress,
} from './sweep';

/** The longest the check sleeps: anything that is not a known crossing (a save elsewhere, a lead saved) waits at most this. */
export const MAX_WAIT_MS = 5_000;
/** The shortest pause between two checks, so a stream of wakes never turns into a busy loop. */
const MIN_GAP_MS = 50;
export { FLOOD_WINDOW_MS };
/**
 * How far before the previous pass began the ending looks for changed watch rows. A lead save's watch row is stamped with
 * its transaction's start, so a save that commits after a check can carry an earlier stamp; this covers any save shorter
 * than a minute (the users' statements stop at 30 s), however many checks a pass took.
 */
const ENDING_OVERLAP_MS = 60_000;
/** The ending reads the changed watch rows this many at a time, each page its own short statements. */
export const ENDING_PAGE_SIZE = 1_000;
/**
 * At most this many pages per check, so no check's claims wait long behind thousands of rows changed at once; the next
 * check goes on from where this one stopped.
 */
export const ENDING_PAGES_PER_CHECK = 5;
/** A stay nobody can be told about is asked about again after this (someone it would reach may have been added). */
const UNREACHABLE_RECHECK_MS = 2 * 60_000;
/** A due statement slower than this is logged even when the check did nothing else. */
const SLOW_DUE_MS = 50;
/**
 * Stopping, an alert's emails and texts start only while more than this is left of the stop's bounded wait: room for
 * that alert's own sends (a staff text is bounded at 10 s, a typical alert takes a few seconds) and the records after it.
 */
export const SEND_STOP_MARGIN_MS = 5_000;
/**
 * Stopping, this long before the stop's bounded wait ends, a send still on its way is no longer waited for: that alert
 * and every alert of the batch not yet done are recorded interrupted at once (one write per company), so the process
 * never ends with a shown alert that has no record.
 */
export const STOP_RECORD_MS = 2_000;

// ─── The loop ────────────────────────────────────────────────────────────────

let loop: Promise<void> | null = null;
let checking: Promise<unknown> | null = null;
/**
 * Each company's chain of emails and texts (startSends): its claimed batches waiting their turn, in claim order, and its
 * one sender, which sends them one after another (drainCompany) beside every other company's. A company leaves both once
 * its last batch is done. A sender never rejects.
 */
const queued = new Map<string, QueuedBatch[]>();
const senders = new Map<string, Promise<void>>();
/** Sends a stop stopped waiting on (their alerts already recorded interrupted), still running while the process lives. */
const lateAnswers = new Set<Promise<unknown>>();
/** Alerts whose emails and texts were handled since the check's last log line, which reports them. */
let sentSinceLine = 0;
/** Claimed alerts whose batch is not yet done (waiting on its company's chain, or being sent): the log line reports it. */
let waitingAlerts = 0;
let wakeNow: (() => void) | null = null;
let wakeRequested = false;
let halted = false;
/**
 * Where the ending reads (endChangedAlerts). A pass reads the watch rows changed after `endingSince`, in (changed_at,
 * lead_id) order; while a pass spans checks, `endingResume` is the last row it finished and the moment of the check that
 * began the pass. Both move only past work that succeeded. Null before the first check.
 */
let endingSince: Date | null = null;
let endingResume: (EndingCursor & { passAt: number }) | null = null;
/** Stays nobody could be told about: stay key -> when to ask again (ms). */
const unreachable = new Map<string, number>();

/**
 * Starts the check, once per process (index.ts, through runJobAtBoot, which skips it when JOBS_PAUSED names
 * `spider-tick`). Returns false, and does nothing, unless the watch list is complete (SPIDER_WATCH_LIST=check).
 */
export async function startSpiderTick(): Promise<boolean> {
  if (watchListMode() !== 'check') {
    logger.info('[spider-tick] off: the watch list is not marked complete (SPIDER_WATCH_LIST=check); the 2-minute sweep alerts as before');
    return false;
  }
  if (loop) return true;
  halted = false;
  logger.info('[spider-tick] started', { maxWaitMs: MAX_WAIT_MS });
  loop = runLoop();
  return true;
}

/** Whether the check runs in this process (the live line tells each screen, so it checks less often only then). */
export function spiderTickRunning(): boolean {
  return loop !== null && !halted;
}

/**
 * A save in this process may have brought a crossing nearer (a limit shortened, a stage switched on, Activate, a lead
 * included again): the check runs at once instead of at its next timer. Nothing when the check is not running.
 */
export function wakeSpiderTick(): void {
  if (!loop) return;
  wakeRequested = true;
  wakeNow?.();
}

/**
 * Settles once no check is running in this process and every batch of emails and texts it started is sent or recorded
 * (stopping, a send still on its way near the end of the stop's wait is recorded interrupted, not waited for). The stop
 * handler waits on it (index.ts). Never rejects.
 */
export async function whenSpiderTickIdle(): Promise<void> {
  if (checking) await checking.catch(() => undefined);
  while (senders.size > 0) await Promise.all(senders.values());
  // A starting summary under way (summaryStart.ts) is a run saved in pieces: it finishes its delivery here, or the next server resumes it.
  await whenSummariesIdle();
}

async function runLoop(): Promise<void> {
  while (!halted && !stopRequested()) {
    wakeRequested = false;
    let nextDueAt: number | null = null;
    try {
      // The claims and pop-ups only: the emails and texts go on while the loop moves on (startSends).
      const running = runCheck(new Date(), () => new Date());
      checking = running;
      nextDueAt = (await running).result.nextDueAt;
    } catch (err) {
      logger.error(`[spider-tick] check failed: ${errorName(err)}`);
    } finally {
      checking = null;
    }
    if (halted || stopRequested()) break;
    const wait = wakeRequested ? MIN_GAP_MS : nextDueAt === null ? MAX_WAIT_MS : nextDueAt - Date.now() + 5;
    await sleep(Math.min(MAX_WAIT_MS, Math.max(MIN_GAP_MS, wait)));
  }
}

/** Sleeps, or wakes early on wakeSpiderTick. The timer never keeps the process alive. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      wakeNow = null;
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref();
    wakeNow = done;
    if (wakeRequested) done();
  });
}

/**
 * Tests: stops the loop, waits for its sends (a late answer too), and forgets what the check remembered (where its ending
 * reads, the unreachable stays, the sends not yet logged).
 */
export async function _resetSpiderTick(): Promise<void> {
  halted = true;
  wakeNow?.();
  await loop;
  await whenSpiderTickIdle();
  await Promise.all(lateAnswers);
  loop = null;
  halted = false;
  wakeRequested = false;
  endingSince = null;
  endingResume = null;
  unreachable.clear();
  sentSinceLine = 0;
  await _resetSummaryStart();
}

/**
 * Activate starts a new switched-on period. A settled stay (claimed, skipped or excluded in an earlier period) is watched
 * again only when this period may still alert it on its own, by the sweep's rule: it is not yet past its stage's limit at
 * the Activate moment (a lengthened limit across an off/on: it alerts again when it crosses, D5), or its stage's limit is
 * off (it alerts once switched on). The rest, the stays already past their limit at Activate, belong to the starting
 * summary or to the skip, and stay settled: a company's whole watch list is never reset (#3468). An excluded lead's stay
 * past its limit stays settled too: the check would only settle it again; included again while Spider is on, the save
 * watches it again (rearmIncludedLeads). One read of the switch just written and one statement on the company's watch
 * rows; then the check is woken. The watch rows' `pending` is the check's own bookkeeping, nothing more.
 */
export async function rearmWatchedStays(orgId: string): Promise<number> {
  const settings = await prisma.spiderSettings.findUnique({
    where: { organization_id: orgId },
    select: { status_limits: true, activated_at: true },
  });
  if (!settings?.activated_at) return 0;
  const limits = readStatusLimits(settings.status_limits);
  const watched = SPIDER_WATCHED_STATUSES.filter((s) => limits[s].enabled).map((s) => ({
    stage: s,
    limit_ms: limitMs(limits[s].value, limits[s].unit),
  }));
  // Past its limit at Activate, compared in UTC wall time (as the due statement does), whatever the session's zone.
  const activated = settings.activated_at.toISOString();
  const count = await prisma.$executeRaw`
    UPDATE spider_lead_watch w
       SET pending = true
     WHERE w.organization_id = ${orgId}::uuid
       AND w.stage IS NOT NULL AND NOT w.pending
       AND NOT EXISTS (
         SELECT 1 FROM json_to_recordset(${JSON.stringify(watched)}::json) AS l(stage text, limit_ms bigint)
          WHERE l.stage = w.stage
            AND w.entered_at <= (${activated}::timestamptz AT TIME ZONE 'UTC') - l.limit_ms * interval '1 millisecond')`;
  wakeSpiderTick();
  return count;
}

/**
 * A save that includes leads again while Spider is on (the picker's exclusions save): their stays are watched again. The
 * check settles an excluded lead's due stay rather than read it at every check, so without this the check would never
 * alert an included lead. The usual rules then decide: a stay claimed in this switched-on period is not claimed again,
 * and one that crossed before the save's widening trigger goes to the starting summary. `changed_at` moves with it: a
 * check that read the lead as still excluded just before the save clears only a row it read unchanged, so it can never
 * settle the stay again after this. One statement on the watch rows of those leads; the caller wakes the check.
 */
export async function rearmIncludedLeads(orgId: string, leadIds: readonly string[]): Promise<number> {
  if (leadIds.length === 0) return 0;
  return prisma.$executeRaw`
    UPDATE spider_lead_watch
       SET pending = true, changed_at = (now() AT TIME ZONE 'UTC')
     WHERE organization_id = ${orgId}::uuid AND lead_id = ANY(${[...leadIds]}::uuid[]) AND stage IS NOT NULL`;
}

// ─── One check ───────────────────────────────────────────────────────────────

export interface TickResult {
  /** Switched-on companies inside the gate with a stage limit on. */
  companies: number;
  /** Stays the due statement handed over (at most the flood guard's share per company). */
  due: number;
  /** Stays claimed by this check. */
  claimed: number;
  /**
   * This check's alerts whose email and text were handled (sent, skipped or failed by their own outcome; not
   * interrupted). Filled by runSpiderTick, which waits for the check's sends; the loop does not wait for them (0 there;
   * its log line counts the sends finished since its previous line instead).
   */
  sent: number;
  /**
   * Claimed alerts (this check's and earlier ones') whose emails and texts were not yet done when the check ended: those
   * waiting on their company's chain and those being sent.
   */
  waiting: number;
  /** Starting summaries this check started (summaryStart.ts): each runs beside the check, never inside it. */
  summaries: number;
  /**
   * The leads those summaries covered. Filled by runSpiderTick, which waits for them; the loop does not (0 there: each
   * summary logs its own line when it is sent).
   */
  summarized: number;
  /** Person rows ended by the ending step. */
  ended: number;
  /** Watch rows whose `pending` the due statement cleared (claimed elsewhere, skipped, or an excluded lead's due stay). */
  settled: number;
  /** The soonest known crossing (ms), or null. */
  nextDueAt: number | null;
  dueMs: number;
}

/**
 * One check across every company, as the loop runs it, then waits for that check's emails and texts (the tests' seam,
 * where `now` is also the moment of every claim). The loop itself never waits for the sends (runLoop).
 */
export async function runSpiderTick(now: Date = new Date()): Promise<TickResult> {
  const { result, sends, summaries } = await runCheck(now, () => now);
  result.sent = await sends;
  result.summarized = await summaries;
  return result;
}

/** One check on the jobs client, unscoped at the top. `clock` tells the moment of each company's claim. */
function runCheck(now: Date, clock: () => Date): Promise<{ result: TickResult; sends: Promise<number>; summaries: Promise<number> }> {
  return runOnJobsClient(() => runUnscoped(() => check(now, clock)));
}

/** What the due statement needs of a company. */
export type DueCompany = Pick<TickCompany, 'orgId' | 'activatedAt' | 'limits' | 'triggerAt'>;

/** One switched-on company as the check reads it. */
interface TickCompany {
  orgId: string;
  activatedAt: Date;
  limits: Record<SpiderStatus, SpiderStatusLimit>;
  channels: SpiderChannels;
  recipients: Prisma.JsonValue;
  /** The waiting starting trigger's moment, when it first started waiting and its kind (summaryStart.ts decides when it is ready). */
  triggerAt: Date | null;
  triggerSince: Date | null;
  triggerKind: string | null;
}

async function check(
  now: Date,
  clock: () => Date,
): Promise<{ result: TickResult; sends: Promise<number>; summaries: Promise<number> }> {
  const started = Date.now();
  const result: TickResult = {
    companies: 0, due: 0, claimed: 0, sent: 0, waiting: 0, summaries: 0, summarized: 0, ended: 0, settled: 0, nextDueAt: null, dueMs: 0,
  };

  const companies = await readTickCompanies();
  const watched = companies.filter((c) => SPIDER_WATCHED_STATUSES.some((s) => c.limits[s].enabled));
  result.companies = watched.length;
  if (companies.length === 0) {
    // Nothing switched on, nothing to end: the next ending reads from a minute before now, as a first check's does.
    endingSince = new Date(now.getTime() - ENDING_OVERLAP_MS);
    endingResume = null;
    result.waiting = waitingAlerts;
    return { result, sends: Promise.resolve(0), summaries: Promise.resolve(0) };
  }

  for (const [key, until] of unreachable) if (until <= now.getTime()) unreachable.delete(key);
  const dueStarted = Date.now();
  const found = watched.length > 0 ? await findDueStays(prisma, { now, companies: watched, unreachable: [...unreachable.keys()] }) : null;
  result.dueMs = Date.now() - dueStarted;
  if (found) {
    result.due = found.due.length;
    result.settled = found.settled;
    result.nextDueAt = found.nextDueAt;
  }

  // A starting trigger not ready yet (a widening Save's quiet time) is a known moment too: the timer sleeps no longer than it.
  for (const c of companies) {
    if (!c.triggerAt) continue;
    const readyAt = summaryTriggerReadyAt({ ...c, triggerAt: c.triggerAt });
    if (readyAt > now.getTime() && (result.nextDueAt === null || readyAt < result.nextDueAt)) result.nextDueAt = readyAt;
  }

  // A failed ending holds nothing else up: the claims, pop-ups and summaries below go on, and the ending's place has not
  // moved past the rows it could not end, so the next check reads them again.
  try {
    await endChangedAlerts(companies, now, result);
  } catch (err) {
    logger.error(`[spider-tick] could not end alerts: ${errorName(err)}`);
  }

  // Every company's claims and pop-up records, whatever its earlier alerts' emails and texts are doing; then this check's
  // emails and texts join their companies' chains, and the check never waits on them.
  const batches: AlertBatch[] = [];
  const byOrg = new Map(watched.map((c) => [c.orgId, c]));
  for (const [orgId, stays] of groupByOrg(found?.due ?? [])) {
    if (stopRequested()) break;
    const company = byOrg.get(orgId)!;
    try {
      const batch = await runWithOrg(orgId, () => claimAndShow(company, stays, now, clock));
      if (batch) {
        batches.push(batch);
        result.claimed += batch.alerts.length;
      }
    } catch (err) {
      logger.error(`[spider-tick] could not alert org ${orgId}: ${errorName(err)}`);
    }
  }
  const sends = startSends(batches);
  result.waiting = waitingAlerts;
  // A starting trigger that is ready starts its company's summary now, beside the check (#3471): the claims above have already
  // left the stays that crossed before the trigger's moment to it.
  const summaries = startReadySummaries(companies, now);
  result.summaries = summaries.started;

  const sent = sentSinceLine;
  if (result.due > 0 || result.claimed > 0 || sent > 0 || result.summaries > 0 || result.ended > 0 || result.settled > 0 || result.dueMs >= SLOW_DUE_MS) {
    sentSinceLine = 0;
    logger.info('[spider-tick] check', {
      companies: result.companies,
      due: result.due,
      claimed: result.claimed,
      sent,
      waiting: result.waiting,
      summaries: result.summaries,
      ended: result.ended,
      settled: result.settled,
      dueMs: result.dueMs,
      durationMs: Date.now() - started,
    });
  }
  return { result, sends, summaries: summaries.done };
}

/** Every switched-on company inside the gate, with what the check needs: one read. */
async function readTickCompanies(): Promise<TickCompany[]> {
  const rows = await prisma.spiderSettings.findMany({
    where: { is_active: true, activated_at: { not: null } },
    select: {
      organization_id: true,
      activated_at: true,
      status_limits: true,
      channels: true,
      recipients: true,
      summary_trigger_at: true,
      summary_trigger_since: true,
      summary_trigger_kind: true,
      organization: { select: { id: true, is_demo: true, plan: true, trial_ends_at: true, feature_overrides: true } },
    },
    orderBy: { organization_id: 'asc' },
  });
  return rows
    .filter((r) => spiderAvailableForOrg(r.organization))
    .map((r) => ({
      orgId: r.organization_id,
      activatedAt: r.activated_at!,
      limits: readStatusLimits(r.status_limits),
      channels: readChannels(r.channels),
      recipients: r.recipients,
      triggerAt: r.summary_trigger_at,
      triggerSince: r.summary_trigger_since,
      triggerKind: r.summary_trigger_kind,
    }));
}

// ─── The due statement ───────────────────────────────────────────────────────

/** One due stay, as the due statement hands it over. */
export interface DueStay {
  orgId: string;
  leadId: string;
  status: SpiderStatus;
  enteredAt: Date;
  countedFrom: Date;
  /** This stay was alerted (or summarized) in an earlier switched-on period: its alert is a re-alert (D5). */
  prior: boolean;
}

export interface DueStays {
  due: DueStay[];
  settled: number;
  nextDueAt: number | null;
}

/** The stay's key, as Activate + Skip stores it (sweep.ts skippedStayKey) and the check remembers unreachable stays by. */
export function stayKey(leadId: string, status: string, enteredAt: Date): string {
  return `${leadId}|${status}|${enteredAt.getTime()}`;
}

type RawQuery = { $queryRaw: <T = unknown>(query: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => Prisma.PrismaPromise<T> };

/**
 * The check's ONE statement over the watch list, for every company at once (see the header, step 2). Every timestamp
 * is compared in UTC wall time (`now` passed in as ISO text, converted with AT TIME ZONE 'UTC'), never against the
 * session's clock or zone, so it answers the same under any session time zone. Also clears `pending` on the stays it
 * finds already settled and on excluded leads' due stays, in the same statement, and only on a row it read unchanged
 * (`changed_at`): a lead included again a moment before keeps its stay watched (rearmIncludedLeads).
 */
export async function findDueStays(
  db: RawQuery,
  input: { now: Date; companies: readonly DueCompany[]; unreachable: readonly string[] },
): Promise<DueStays> {
  const limits = input.companies.flatMap((c) =>
    SPIDER_WATCHED_STATUSES.filter((s) => c.limits[s].enabled).map((s) => ({
      org: c.orgId,
      stage: s,
      limit_ms: limitMs(c.limits[s].value, c.limits[s].unit),
      activated: c.activatedAt.toISOString(),
      cutoff: c.triggerAt ? c.triggerAt.toISOString() : null,
    })),
  );
  if (limits.length === 0) return { due: [], settled: 0, nextDueAt: null };
  const nowIso = input.now.toISOString();
  const [row] = await db.$queryRaw<{ due: { org: string; lead: string; stage: string; entered: string; counted: string; prior: boolean }[] | null; settled: number; next_due: string | null }[]>`
    WITH lim AS (
      SELECT l.org, l.stage, l.limit_ms,
             (l.activated::timestamptz AT TIME ZONE 'UTC') AS activated,
             (l.cutoff::timestamptz AT TIME ZONE 'UTC') AS cutoff,
             (${nowIso}::timestamptz AT TIME ZONE 'UTC') - l.limit_ms * interval '1 millisecond' AS due_before
        FROM json_to_recordset(${JSON.stringify(limits)}::json) AS l(org uuid, stage text, limit_ms bigint, activated text, cutoff text)
    ),
    orgs AS (SELECT DISTINCT org FROM lim),
    excluded AS (
      SELECT s.organization_id AS org, x AS lead_id
        FROM spider_settings s JOIN orgs o ON o.org = s.organization_id, unnest(s.excluded_lead_ids) AS x
    ),
    skipped AS (
      SELECT s.organization_id AS org, k AS stay
        FROM spider_settings s JOIN orgs o ON o.org = s.organization_id, unnest(s.backlog_skipped_stays) AS k
    ),
    candidates AS (
      SELECT c.*
        FROM (
          SELECT l.org, w.lead_id, w.stage, w.entered_at, w.changed_at, l.cutoff,
                 GREATEST(w.entered_at, l.activated) AS counted_from,
                 w.entered_at + l.limit_ms * interval '1 millisecond' AS crossed_at,
                 w.lead_id::text || '|' || w.stage || '|' || (extract(epoch FROM w.entered_at) * 1000)::bigint::text AS stay,
                 EXISTS (SELECT 1 FROM excluded e WHERE e.org = l.org AND e.lead_id = w.lead_id) AS is_excluded
            FROM lim l
            JOIN spider_lead_watch w
              ON w.organization_id = l.org AND w.stage = l.stage AND w.pending AND w.entered_at <= l.due_before
        ) c
       WHERE c.is_excluded OR c.cutoff IS NULL OR c.crossed_at > c.cutoff
    ),
    flagged AS (
      SELECT c.*,
             EXISTS (SELECT 1 FROM skipped k WHERE k.org = c.org AND k.stay = c.stay) AS skipped,
             EXISTS (
               SELECT 1 FROM spider_alerts a
                WHERE a.organization_id = c.org AND a.lead_id = c.lead_id AND a.status = c.stage::"LeadStatus"
                  AND a.entered_status_at = c.entered_at AND a.counted_from = c.counted_from
             ) AS claimed
        FROM candidates c
    ),
    settled AS (
      UPDATE spider_lead_watch w
         SET pending = false
        FROM flagged f
       WHERE (f.is_excluded OR f.skipped OR f.claimed)
         AND w.lead_id = f.lead_id AND w.organization_id = f.org AND w.stage = f.stage AND w.entered_at = f.entered_at
         AND w.pending AND w.changed_at = f.changed_at
      RETURNING w.lead_id
    ),
    sent AS (
      SELECT a.organization_id AS org, count(*)::int AS n
        FROM spider_alerts a
       WHERE a.organization_id IN (SELECT org FROM orgs)
         AND a.kind = 'ALERTED'
         AND a.alerted_at > (${nowIso}::timestamptz AT TIME ZONE 'UTC') - ${FLOOD_WINDOW_MS} * interval '1 millisecond'
       GROUP BY a.organization_id
    ),
    ranked AS (
      SELECT f.*, row_number() OVER (PARTITION BY f.org ORDER BY f.crossed_at, f.lead_id) AS rank
        FROM flagged f
       WHERE NOT f.is_excluded AND NOT f.skipped AND NOT f.claimed AND f.stay NOT IN (SELECT unnest(${[...input.unreachable]}::text[]))
    ),
    due AS (
      SELECT r.*
        FROM ranked r
        LEFT JOIN sent s ON s.org = r.org
       WHERE r.rank <= ${SPIDER_ALERTS_PER_COMPANY_RUN} - COALESCE(s.n, 0)
    ),
    nxt AS (
      SELECT min(n.entered_at + l.limit_ms * interval '1 millisecond') AS at
        FROM lim l
        CROSS JOIN LATERAL (
          SELECT w.entered_at FROM spider_lead_watch w
           WHERE w.organization_id = l.org AND w.stage = l.stage AND w.pending AND w.entered_at > l.due_before
           ORDER BY w.entered_at
           LIMIT 1
        ) n
    )
    SELECT
      (SELECT json_agg(json_build_object(
                'org', d.org, 'lead', d.lead_id, 'stage', d.stage,
                'entered', (extract(epoch FROM d.entered_at) * 1000)::bigint::text,
                'counted', (extract(epoch FROM d.counted_from) * 1000)::bigint::text,
                'prior', EXISTS (
                  SELECT 1 FROM spider_alerts a
                   WHERE a.organization_id = d.org AND a.lead_id = d.lead_id AND a.status = d.stage::"LeadStatus"
                     AND a.entered_status_at = d.entered_at)
              ) ORDER BY d.org, d.rank) FROM due d) AS due,
      (SELECT count(*)::int FROM settled) AS settled,
      (SELECT (extract(epoch FROM at) * 1000)::bigint::text FROM nxt) AS next_due`;
  return {
    due: (row?.due ?? []).map((d) => ({
      orgId: d.org,
      leadId: d.lead,
      status: d.stage as SpiderStatus,
      enteredAt: new Date(Number(d.entered)),
      countedFrom: new Date(Number(d.counted)),
      prior: d.prior,
    })),
    settled: row?.settled ?? 0,
    nextDueAt: row?.next_due ? Number(row.next_due) : null,
  };
}

function groupByOrg(stays: readonly DueStay[]): Map<string, DueStay[]> {
  const out = new Map<string, DueStay[]>();
  for (const s of stays) out.set(s.orgId, [...(out.get(s.orgId) ?? []), s]);
  return out;
}

// ─── Claiming, then the pop-up ───────────────────────────────────────────────

/** One company's claimed alerts, their pop-up records written, waiting for their emails and texts. */
interface AlertBatch {
  orgId: string;
  channels: SpiderChannels;
  alerts: (PlannedAlert & { alertId: string; outcome: AlertOutcome })[];
  writes: RunWrites;
}

/**
 * One company's due stays: its leads and people read for the batch at once, the claims written in one statement with
 * the watch rows' `pending` and stamped with the moment of the claim (`clock`), then the pop-up / red-frame records
 * (writeAlertRecords). Returns the batch for its emails and texts, or null when nothing was claimed.
 */
async function claimAndShow(company: TickCompany, stays: readonly DueStay[], now: Date, clock: () => Date): Promise<AlertBatch | null> {
  const { orgId } = company;
  const leads = await readAlertLeads(orgId, stays.map((s) => s.leadId));
  const leadById = new Map(leads.map((l) => [l.id, l]));
  const present = stays.filter((s) => leadById.has(s.leadId));
  if (present.length === 0) return null;
  const recipientsByLead = await resolveSpiderRecipientsForLeads(prisma, {
    orgId,
    leads: present.map((s) => ({ id: s.leadId, ownerId: leadById.get(s.leadId)!.commission_owner_id })),
    recipients: readRecipients(company.recipients),
  });
  const visits: AlertVisit[] = present.map((s) => {
    const lead = leadById.get(s.leadId)!;
    return {
      leadId: s.leadId,
      status: s.status,
      enteredAt: s.enteredAt,
      createdAt: lead.created_at,
      countedFrom: s.countedFrom,
      limit: company.limits[s.status],
      recipients: recipientsByLead.get(s.leadId) ?? [],
      priorAlertForVisit: s.prior,
      leadStatus: lead.status,
    };
  });
  // Nobody to tell: no place in the batch, and not asked about again for a while.
  for (const v of visits) {
    if (v.recipients.length === 0) unreachable.set(stayKey(v.leadId, v.status, v.enteredAt), now.getTime() + UNREACHABLE_RECHECK_MS);
  }
  const { chosen } = pickThisRun(visits);
  // "Alerted at" is the claim's own moment, not the check's start: a check with many companies claims each a little later.
  const claimedAt = clock();
  const planned = buildAlertPlans(orgId, claimedAt, chosen, company.channels, leadById);
  // The server is stopping: nothing is claimed, every stay is still due for the next server.
  if (planned.length === 0 || stopRequested()) return null;

  // Each alert's list is stored once however many alerts told it, before the claims that point at it.
  const setIds = await recipientSetIds(prisma, orgId, planned.map((p) => p.visit.recipients));
  const alertIds = await claimWatchedStays(
    orgId,
    company.activatedAt,
    planned.map((p, i) => ({ ...p.claim, recipient_set_id: setIds[i]! })),
  );
  const writes = newRunWrites();
  const alerts = planned.flatMap((p) => {
    const alertId = alertIds.get(p.visit.leadId);
    if (!alertId) return [];
    const outcome = queueAlertRecord({ orgId, alert: p, alertId, channels: company.channels, writes });
    return [{ ...p, alertId, outcome }];
  });
  if (alerts.length === 0) return null;
  // The pop-up and red-frame records now, before any email or text (#3469). A failure is logged there; the alerts are
  // claimed, so their emails and texts still go.
  await writeAlertRecords({ orgId, now: claimedAt, activatedAt: company.activatedAt, writes });
  return { orgId, channels: company.channels, alerts, writes };
}

// ─── The sends ───────────────────────────────────────────────────────────────

type ClaimedAlert = AlertBatch['alerts'][number];

/** A claimed batch waiting its turn on its company's chain; `settle` tells its check how many of its alerts were handled. */
interface QueuedBatch {
  batch: AlertBatch;
  settle: (handled: number) => void;
}

/**
 * Puts each claimed batch's emails and texts at the end of its company's chain: a company's batches go one after another,
 * in the order they were claimed, and each company's chain runs beside every other's, so one company's slow provider
 * never delays another company's alerts. The check never waits on them (a slow provider delays only emails and texts,
 * never a pop-up, a crossing or an ending); runSpiderTick and the stop handler do. Resolves to how many of the check's
 * alerts were handled; never rejects.
 */
function startSends(batches: readonly AlertBatch[]): Promise<number> {
  const runs = batches.map(
    (batch) =>
      new Promise<number>((settle) => {
        waitingAlerts += batch.alerts.length;
        const chain = queued.get(batch.orgId);
        if (chain) chain.push({ batch, settle });
        else queued.set(batch.orgId, [{ batch, settle }]);
        if (!senders.has(batch.orgId)) startSender(batch.orgId);
      }),
  );
  return Promise.all(runs).then((counts) => counts.reduce((sum, n) => sum + n, 0));
}

/** The company's one sender, on the jobs client in the company's scope, until its chain is empty. */
function startSender(orgId: string): void {
  const run = runOnJobsClient(() => runUnscoped(() => runWithOrg(orgId, () => drainCompany(orgId))))
    .catch((err: unknown) => {
      // The chain could not run at all (no jobs connection): the batches waiting on it are given up, as after a crash,
      // their alerts keeping no email or text outcome; never retried at once, so a lost connection is never a hot loop.
      const lost = queued.get(orgId)?.splice(0) ?? [];
      logger.error(`[spider-tick] could not send the alerts of org ${orgId} (${lost.length} batches): ${errorName(err)}`);
      for (const { batch, settle } of lost) {
        waitingAlerts -= batch.alerts.length;
        settle(0);
      }
    })
    .finally(() => {
      senders.delete(orgId);
      // A batch queued while this sender was ending gets a sender of its own.
      if (queued.get(orgId)?.length) startSender(orgId);
    });
  senders.set(orgId, run);
}

/**
 * Sends the company's batches one after another, oldest first. Stopping with no room left for another alert's sends
 * (SEND_STOP_MARGIN_MS), every batch still waiting is recorded interrupted at once, in one write for them all, however
 * many there are, so a long chain never outlasts the stop's bounded wait.
 */
async function drainCompany(orgId: string): Promise<void> {
  for (;;) {
    const waiting = queued.get(orgId) ?? [];
    if (waiting.length === 0) {
      queued.delete(orgId);
      return;
    }
    if (stopRequested() && stopTimeLeftMs() <= SEND_STOP_MARGIN_MS) {
      const rest = waiting.splice(0);
      try {
        const writes = newRunWrites();
        for (const { batch } of rest) await queueInterrupted(batch, 0, spiderSendCompany(orgId, []), writes);
        await recordDeliveries(orgId, writes.records);
      } catch (err) {
        logger.error(`[spider-tick] could not record ${rest.length} interrupted batches for org ${orgId}: ${errorName(err)}`);
      } finally {
        for (const { batch, settle } of rest) {
          waitingAlerts -= batch.alerts.length;
          settle(0);
        }
      }
      continue;
    }
    const { batch, settle } = waiting.shift()!;
    let handled = 0;
    try {
      handled = await sendBatch(batch);
    } catch (err) {
      logger.error(`[spider-tick] could not send the alerts of org ${orgId}: ${errorName(err)}`);
    } finally {
      waitingAlerts -= batch.alerts.length;
      settle(handled);
    }
  }
}

/**
 * One company's emails and texts, alert by alert, then its texting usage and delivery records. Resolves to how many
 * alerts were handled (not interrupted).
 *
 * Stopping (a deploy): an alert already shown still gets its email and text while the stop's bounded wait has room for
 * it (more than SEND_STOP_MARGIN_MS); when there is none, it and the rest are recorded interrupted, and never sent later.
 * STOP_RECORD_MS before the wait ends, a send still on its way is no longer waited for: that alert and the rest are
 * recorded interrupted then and there (a person of the alert in flight whose email or text already answered keeps that
 * answer), and the send's real record replaces its one if it answers in time.
 */
async function sendBatch(batch: AlertBatch): Promise<number> {
  const { orgId, writes } = batch;
  // What every email and text of the batch shares, read once by the first send that needs it (delivery.ts).
  const company = spiderSendCompany(
    orgId,
    batch.alerts.flatMap((p) => p.visit.recipients.flatMap((r) => (r.email?.trim() ? [r.email.trim()] : []))),
  );
  let handled = 0;
  let cutNow!: () => void;
  const cut = new Promise<'cut'>((resolve) => (cutNow = () => resolve('cut')));
  const cancelCut = onStopTimeLeft(STOP_RECORD_MS, cutNow);
  try {
    for (const [i, p] of batch.alerts.entries()) {
      if (stopRequested() && stopTimeLeftMs() <= SEND_STOP_MARGIN_MS) {
        await recordInterrupted(batch, i, company);
        break;
      }
      // Who has had their email or text so far, person by person: kept if the stop's wait runs short meanwhile.
      const progress = newSendProgress();
      const delivered = deliverAlert(batch, p, company, { writes, outcome: p.outcome, interrupted: false, sendProgress: progress }).then(
        () => 'handled' as const,
        (err: unknown) => {
          logger.error(`[spider-tick] alert failed for org ${orgId} lead ${p.visit.leadId}: ${errorName(err)}`);
          return 'failed' as const;
        },
      );
      const answer = await Promise.race([delivered, cut]);
      if (answer === 'cut') {
        await recordInterrupted(batch, i, company, progress);
        keepLateAnswer(orgId, delivered, writes);
        break;
      }
      if (answer === 'handled') {
        handled += 1;
        sentSinceLine += 1;
      }
      // Stopping: what is done so far is written at once, not at the end of the batch.
      if (stopRequested()) await writeSendRecords(orgId, writes);
    }
  } finally {
    cancelCut();
    await writeSendRecords(orgId, writes);
  }
  return handled;
}

/** The check's one way to an alert's emails and texts (sweep.ts sendAlertMessages); with `interrupted`, only its record. */
function deliverAlert(
  batch: AlertBatch,
  p: ClaimedAlert,
  company: SpiderSendCompany,
  a: { writes: RunWrites; outcome: AlertOutcome; interrupted: boolean; sendProgress?: SendProgress },
): Promise<void> {
  return sendAlertMessages({ orgId: batch.orgId, alert: p, alertId: p.alertId, channels: batch.channels, company, ...a });
}

/**
 * The batch's alerts from `from` on, recorded interrupted in one write (the outcome an alert whose sends cannot start
 * gets). The alert in flight when the stop's wait ran short (`from`) keeps, person by person, what already answered
 * (`inFlight`): an email or a text that went out is never called interrupted, and the rest of its people are.
 */
async function recordInterrupted(batch: AlertBatch, from: number, company: SpiderSendCompany, inFlight?: SendProgress): Promise<void> {
  const writes = newRunWrites();
  await queueInterrupted(batch, from, company, writes, inFlight);
  await recordDeliveries(batch.orgId, writes.records);
}

/** The interrupted records of the batch's alerts from `from` on, queued in `writes`: nothing is sent, read or written. */
async function queueInterrupted(batch: AlertBatch, from: number, company: SpiderSendCompany, writes: RunWrites, inFlight?: SendProgress): Promise<void> {
  for (const [k, p] of batch.alerts.slice(from).entries()) {
    const progress = k === 0 ? inFlight : undefined;
    await deliverAlert(batch, p, company, { writes, outcome: structuredClone(p.outcome), interrupted: true, sendProgress: progress });
  }
}

/**
 * A send the stop no longer waited on carries on while the process lives: if it answers in time, its real record (and
 * its texts' count) is written after the interrupted one, and replaces it. Kept only so the tests can wait for it; the
 * stop handler does not.
 */
function keepLateAnswer(orgId: string, delivered: Promise<unknown>, writes: RunWrites): void {
  const late = delivered
    .then(() => writeSendRecords(orgId, writes))
    .catch((err: unknown) => logger.error(`[spider-tick] could not record a late send for org ${orgId}: ${errorName(err)}`));
  lateAnswers.add(late);
  void late.finally(() => lateAnswers.delete(late));
}

/** The texting usage and delivery records gathered so far, written and taken out of `writes` (each is written once). */
async function writeSendRecords(orgId: string, writes: RunWrites): Promise<void> {
  const texts = new Map(writes.textsSent);
  writes.textsSent.clear();
  const records = writes.records.splice(0);
  await countSentTexts(orgId, texts);
  await recordDeliveries(orgId, records);
}

// ─── Ending within seconds ───────────────────────────────────────────────────

/** A place in the ending's order: a watch row's `changed_at` exactly as the database wrote it, and its lead. */
interface EndingCursor {
  changed: string;
  lead: string;
}

/** A changed watch row as the ending reads it, with one of its lead's alerts (null: the lead has none). */
interface ChangedWatchRow {
  org: string;
  lead: string;
  stage: string | null;
  entered: string | null;
  changed: string;
  excluded: boolean;
  alert: string | null;
}

/** An open Spider record (an in-app or red-frame record with an unread row), with what the ending rule reads of it. */
interface OpenSpiderRecordOf {
  id: string;
  dedup: string;
  status: string | null;
  entered_status_at: string | null;
}

/**
 * The ending step: the watch rows of these companies changed since the window start that have an open Spider record (an
 * unread row of an alert's in-app or red-frame record); each record the ending rule (alertStillOpen) no longer keeps open
 * is ended now, per company in one statement (endOpenSpiderRecords). Page by page (readEndingPage), at most
 * ENDING_PAGES_PER_CHECK pages: after each page whose endings all succeeded, the place it reached is kept, so the next
 * check goes on from there; a pass that has read every changed row moves the window start to a minute (ENDING_OVERLAP_MS)
 * before the check that began the pass, and the next check begins a new pass. A page whose read throws, or whose ending
 * failed for a company, moves nothing: the next check reads it again. Adds what it ended to `result.ended`.
 */
async function endChangedAlerts(companies: readonly TickCompany[], now: Date, result: Pick<TickResult, 'ended'>): Promise<void> {
  endingSince ??= new Date(now.getTime() - ENDING_OVERLAP_MS);
  const since = endingSince;
  const passAt = endingResume?.passAt ?? now.getTime();
  let after: EndingCursor | null = endingResume;
  const orgIds = companies.map((c) => c.orgId);
  const limitsOf = new Map(companies.map((c) => [c.orgId, c.limits]));
  for (let page = 0; page < ENDING_PAGES_PER_CHECK; page += 1) {
    const { rows, next } = await readEndingPage(orgIds, since, after);
    const finished = new Map<string, string[]>();
    for (const { record, row } of rows) {
      const limits = limitsOf.get(row.org);
      if (!limits) continue;
      const rules: OpenAlertRules = { limits, isExcluded: () => row.excluded };
      const alerted = alertedVisitOf(row.lead, { status: record.status, entered_status_at: record.entered_status_at });
      const visit = row.stage && row.entered ? { status: row.stage as SpiderStatus, entered_at: new Date(Number(row.entered)) } : undefined;
      if (alertStillOpen(alerted, visit, rules, now)) continue;
      const ids = finished.get(row.org) ?? [];
      ids.push(record.id);
      finished.set(row.org, ids);
    }
    let failed = false;
    for (const [orgId, notificationIds] of finished) {
      try {
        result.ended += await runWithOrg(orgId, () => endOpenSpiderRecords(orgId, now, { notificationIds: [...new Set(notificationIds)] }));
      } catch (err) {
        failed = true;
        logger.error(`[spider-tick] could not end ${notificationIds.length} alerts for org ${orgId}: ${errorName(err)}`);
      }
    }
    if (failed) return;
    if (!next) {
      endingSince = new Date(passAt - ENDING_OVERLAP_MS);
      endingResume = null;
      return;
    }
    after = next;
    endingResume = { ...next, passAt };
  }
}

/**
 * One page of the ending, in two short reads:
 *  1. the next ENDING_PAGE_SIZE watch rows of these companies changed after `since` (and after `after`), in (changed_at,
 *     lead_id) order, each with its lead's alerts;
 *  2. when any has an alert: the open records of those alerts, KEY BY KEY: for each exact key (`verb:alertId`) one
 *     lookup on the unique (organization_id, dedup_key) index, and for the record found one lookup of an unread row.
 * Two reads on purpose: a join from the alerts to their records on a key made in SQL (`verb || ':' || a.id`) never used
 * that index under the production role (those functions are not leakproof and the tables are row-secured): it compared
 * every unread bell row of the company with every open alert, 0.6-0.9 s a check at 20,000 unread rows.
 * Key by key on purpose too: under the production role the planner sees about 0.5% of the unread rows (the row-security
 * filter), so a plain join of the keys to the records and their unread rows may join every key to every unread record
 * of the company (0.55-4 s a check, custom plans only). Each LATERAL ... LIMIT 1 cannot be merged into the outer join,
 * so the read runs per key whatever the statistics say: its work grows with the keys, never with the company's history.
 * `next` is the page's last row when more rows follow (the read asks for one row more than a page to know).
 */
async function readEndingPage(
  orgIds: readonly string[],
  since: Date,
  after: EndingCursor | null,
): Promise<{ rows: { record: OpenSpiderRecordOf; row: ChangedWatchRow }[]; next: EndingCursor | null }> {
  const read = await prisma.$queryRaw<ChangedWatchRow[]>`
    SELECT w.organization_id::text AS org, w.lead_id::text AS lead, w.stage,
           (extract(epoch FROM w.entered_at) * 1000)::bigint::text AS entered,
           w.changed_at::text AS changed,
           (w.lead_id = ANY(s.excluded_lead_ids)) AS excluded,
           a.id::text AS alert
      FROM (
        SELECT organization_id, lead_id, stage, entered_at, changed_at
          FROM spider_lead_watch
         WHERE organization_id = ANY(${[...orgIds]}::uuid[])
           AND changed_at > (${since.toISOString()}::timestamptz AT TIME ZONE 'UTC')
           ${after ? Prisma.sql`AND changed_at >= ${after.changed}::timestamp AND (changed_at, lead_id) > (${after.changed}::timestamp, ${after.lead}::uuid)` : Prisma.empty}
         ORDER BY changed_at, lead_id
         LIMIT ${Prisma.raw(String(ENDING_PAGE_SIZE + 1))}
      ) w
      JOIN spider_settings s ON s.organization_id = w.organization_id
      LEFT JOIN spider_alerts a ON a.lead_id = w.lead_id AND a.organization_id = w.organization_id AND a.kind = 'ALERTED'
     ORDER BY w.changed_at, w.lead_id`;
  // A lead's rows come together (one per alert); the page is its first ENDING_PAGE_SIZE leads.
  const page: ChangedWatchRow[] = [];
  let leads = 0;
  let next: EndingCursor | null = null;
  for (const r of read) {
    if (page.length === 0 || page[page.length - 1]!.lead !== r.lead) {
      leads += 1;
      if (leads > ENDING_PAGE_SIZE) {
        const last = page[page.length - 1]!;
        next = { changed: last.changed, lead: last.lead };
        break;
      }
    }
    page.push(r);
  }
  const byKey = new Map<string, ChangedWatchRow>();
  for (const r of page) if (r.alert) for (const verb of [SPIDER_ALERT_VERB, SPIDER_FRAME_VERB]) byKey.set(`${verb}:${r.alert}`, r);
  if (byKey.size === 0) return { rows: [], next };
  const keys = [...byKey.keys()];
  const records = await prisma.$queryRaw<OpenSpiderRecordOf[]>`
    SELECT n.id::text AS id, n.dedup_key AS dedup,
           CASE WHEN jsonb_typeof(n.data->'status') = 'string' THEN n.data->>'status' END AS status,
           CASE WHEN jsonb_typeof(n.data->'entered_status_at') = 'string' THEN n.data->>'entered_status_at' END AS entered_status_at
      FROM unnest(${keys.map((k) => byKey.get(k)!.org)}::uuid[], ${keys}::text[]) AS k(org, dedup)
     CROSS JOIN LATERAL (
       SELECT n.id, n.organization_id, n.dedup_key, n.data FROM notifications n
        WHERE n.organization_id = k.org AND n.dedup_key = k.dedup
        LIMIT 1) n
     CROSS JOIN LATERAL (
       SELECT 1 FROM notification_recipients r
        WHERE r.organization_id = n.organization_id AND r.notification_id = n.id AND r.read_at IS NULL
        LIMIT 1) unread`;
  return { rows: records.map((record) => ({ record, row: byKey.get(record.dedup)! })), next };
}

/** An error's class name only - never its message, which can carry the values it failed on. */
function errorName(err: unknown): string {
  if (err instanceof Prisma.PrismaClientKnownRequestError) return `${err.name} ${err.code}`;
  return err instanceof Error ? err.name : 'unknown error';
}
