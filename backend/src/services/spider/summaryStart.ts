/**
 * The check's starting-summary step (#3471): a starting trigger is acted on within seconds of being ready, by the check
 * (tick.ts) that runs every few seconds, instead of by the 2-minute sweep.
 *
 * - When a trigger is ready (summaryTriggerReady). Activate with "Send" (kind SWITCHED_ON) is ready at once: the summary starts
 *   on the next check. A widening Save while Active (a stage switched on, a limit shortened, leads included again) is ready 30
 *   seconds after the LAST such Save, and never later than 2 minutes after the FIRST one still waiting (`summary_trigger_since`),
 *   so several quick Saves give one summary (#2794, user story 33; Ran, 12 Nov, D1 A) and Saves that keep coming cannot hold it
 *   back for ever.
 * - What it covers: the stays past their limit AT THE TRIGGER'S MOMENT (`summary_trigger_at`, the latest trigger) and not yet
 *   claimed, read from the watch list (spider_lead_watch, #3468), never by reading every open lead again. A stay that crosses
 *   after that moment is alerted on its own by the check at its crossing (the due statement's cut-off is the same instant),
 *   during the wait and during the build; it is never in the summary.
 * - How it runs: beside the check, never inside it. Each company's summary is one task at a time in this process, so a summary
 *   of thousands of leads never delays another company's alerts or the next check. Between servers, a lease per company (the
 *   sweep lease's table, a row named for the company) lets one server build it at a time. The summary itself is summary.ts's
 *   run: saved in pieces, resumed after a stop, 3 attempts, waits of 2, 8 and 30 minutes kept on the run's `next_attempt_at`.
 * - Never every pass: after an attempt that is waiting for its next try (or failed), the company is not asked again until the
 *   run's own next-attempt time (StartingSummaryResult.retryAt), so a 5-second check never turns a 2-minute retry into a
 *   5-second one. A failure before the run exists (finding or starting it) is held off the same way, 3 failures in this process,
 *   and then the trigger is dropped (unless a run is open: its claims are released only by its own attempts or by giving up)
 *   so the per-lead alerts take over.
 * - The trigger is cleared only if no newer one landed meanwhile; a newer one starts its own wait (clearSpentTrigger).
 *
 * Every statement is its own on the jobs client; no row lock is held across a round trip. Logs carry ids only.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { runOnJobsClient } from '../../lib/prismaJobs';
import { runUnscoped, runWithOrg } from '../../lib/tenant-context';
import { stopRequested } from '../../lib/graceful-stop';
import { limitMs, readRecipients, SPIDER_WATCHED_STATUSES, type SpiderChannels, type SpiderStatus, type SpiderStatusLimit } from './config';
import { SWEEP_PAGE_SIZE } from './pages';
import { claimSweepLease, summaryLeaseName } from './sweepLease';
import { hasOpenSummaryRun, runStartingSummary, type OverdueVisit } from './summary';
import { SUMMARY_MAX_ATTEMPTS, SUMMARY_RETRY_WAITS_MS, errorName } from './summaryRuns';
import { isTriggerKind } from './summaryMessages';

/** A widening Save starts its summary once the settings have been quiet this long. */
export const SUMMARY_QUIET_MS = 30_000;
/**
 * The longest a widening Save waits from when the first of the Saves still waiting was made: the summary starts then even if
 * Saves keep coming.
 */
export const SUMMARY_MAX_WAIT_MS = 2 * 60_000;
/** How long a company whose summary another server is building is left alone before it is asked about again. */
const BUILT_ELSEWHERE_RECHECK_MS = 15_000;

/** What decides whether a trigger is ready. */
export interface TriggerTimes {
  triggerAt: Date;
  /** When the first of the triggers still waiting was recorded (`summary_trigger_since`); null reads as `triggerAt`. */
  triggerSince: Date | null;
  triggerKind: string | null;
}

/** The moment (ms) a trigger is ready: at once for Activate's, else 30 s after the last Save, at most 2 minutes after the first. */
export function summaryTriggerReadyAt(t: TriggerTimes): number {
  if (t.triggerKind === 'SWITCHED_ON') return t.triggerAt.getTime();
  const since = (t.triggerSince ?? t.triggerAt).getTime();
  return Math.min(t.triggerAt.getTime() + SUMMARY_QUIET_MS, since + SUMMARY_MAX_WAIT_MS);
}

export function summaryTriggerReady(t: TriggerTimes, now: Date): boolean {
  return now.getTime() >= summaryTriggerReadyAt(t);
}

/** One switched-on company as the summary step needs it (the check's own read, tick.ts). */
export interface SummaryCompany extends Omit<TriggerTimes, 'triggerAt'> {
  orgId: string;
  /** The waiting trigger's moment, null when none waits. */
  triggerAt: Date | null;
  activatedAt: Date;
  limits: Record<SpiderStatus, SpiderStatusLimit>;
  channels: SpiderChannels;
  recipients: Prisma.JsonValue;
}

// ─── The stays the summary covers ────────────────────────────────────────────

/**
 * The stays past their limit at `cutoff` (the trigger's moment) that nothing has claimed, read from the watch list in keyset
 * pages of SWEEP_PAGE_SIZE by lead id: a stage whose limit is on, the stay's limit passed by `cutoff`, the lead not excluded,
 * the stay not skipped by Activate + Skip, no alert-log row for it (an alert or an earlier summary, by the claim's five parts).
 * Every timestamp is compared in UTC wall time (`cutoff` and `activatedAt` passed as ISO text, converted with AT TIME ZONE
 * 'UTC'), never against the session's zone.
 */
export async function readSummaryStays(
  orgId: string,
  c: { limits: Record<SpiderStatus, SpiderStatusLimit>; activatedAt: Date },
  cutoff: Date,
): Promise<OverdueVisit[]> {
  const limits = SPIDER_WATCHED_STATUSES.filter((s) => c.limits[s].enabled).map((s) => ({ stage: s, limit_ms: limitMs(c.limits[s].value, c.limits[s].unit) }));
  if (limits.length === 0) return [];
  const limitsJson = JSON.stringify(limits);
  const cutoffIso = cutoff.toISOString();
  const activatedIso = c.activatedAt.toISOString();
  const out: OverdueVisit[] = [];
  let after: string | null = null;
  for (;;) {
    const rows: { lead: string; stage: string; entered: string }[] = await prisma.$queryRaw`
      WITH lim AS (
        SELECT l.stage, l.limit_ms FROM json_to_recordset(${limitsJson}::json) AS l(stage text, limit_ms bigint)
      )
      SELECT w.lead_id::text AS lead, w.stage, (extract(epoch FROM w.entered_at) * 1000)::bigint::text AS entered
        FROM lim l
        JOIN spider_lead_watch w
          ON w.organization_id = ${orgId}::uuid AND w.stage = l.stage
         AND w.entered_at <= (${cutoffIso}::timestamptz AT TIME ZONE 'UTC') - l.limit_ms * interval '1 millisecond'
       WHERE (${after}::uuid IS NULL OR w.lead_id > ${after}::uuid)
         AND NOT EXISTS (
           SELECT 1 FROM spider_settings s
            WHERE s.organization_id = w.organization_id
              AND (w.lead_id = ANY(s.excluded_lead_ids)
                   OR (w.lead_id::text || '|' || w.stage || '|' || (extract(epoch FROM w.entered_at) * 1000)::bigint::text) = ANY(s.backlog_skipped_stays)))
         AND NOT EXISTS (
           SELECT 1 FROM spider_alerts a
            WHERE a.organization_id = w.organization_id AND a.lead_id = w.lead_id AND a.status = w.stage::"LeadStatus"
              AND a.entered_status_at = w.entered_at
              AND a.counted_from = GREATEST(w.entered_at, (${activatedIso}::timestamptz AT TIME ZONE 'UTC')))
       ORDER BY w.lead_id
       LIMIT ${SWEEP_PAGE_SIZE}`;
    for (const r of rows) {
      const status = r.stage as SpiderStatus;
      const enteredAt = new Date(Number(r.entered));
      const limit = c.limits[status];
      out.push({
        id: r.lead,
        status,
        entered_at: enteredAt,
        counted_from: enteredAt > c.activatedAt ? enteredAt : c.activatedAt,
        limit: { value: limit.value, unit: limit.unit },
      });
    }
    if (rows.length < SWEEP_PAGE_SIZE) return out;
    after = rows[rows.length - 1]!.lead;
  }
}

// ─── The trigger ─────────────────────────────────────────────────────────────

/**
 * A trigger whose summary is done (or given up on) is cleared, but only if no newer trigger landed during the run
 * (`summary_trigger_at` still the one acted on). A newer one starts its own wait: the one left was recorded by a Save that
 * merged into the one just served, so it counts as a widening Save from now (its quiet time and its 2-minute cap start afresh,
 * and it is no longer "switched on", which the summary's wording would claim).
 */
export async function clearSpentTrigger(orgId: string, trigger: Date, now: Date): Promise<boolean> {
  const { count } = await prisma.spiderSettings.updateMany({
    where: { organization_id: orgId, summary_trigger_at: trigger },
    data: { summary_trigger_at: null, summary_trigger_kind: null, summary_trigger_since: null },
  });
  if (count === 1) return true;
  await prisma.spiderSettings.updateMany({
    where: { organization_id: orgId, summary_trigger_at: { not: null } },
    data: { summary_trigger_since: now, summary_trigger_kind: 'SETTINGS_CHANGED' },
  });
  return false;
}

// ─── The task ────────────────────────────────────────────────────────────────

/** Companies whose summary is being built (or finished) by this process now. */
const building = new Map<string, Promise<number>>();
/** Companies not to be asked about before this time (ms, the check's clock): a wait on the run, or a failure's wait. */
const holdUntil = new Map<string, number>();
/** Failures before the run existed (finding or starting it), per company, in this process. */
const failures = new Map<string, number>();

/** Settles once no summary is running in this process. Never rejects. */
export async function whenSummariesIdle(): Promise<void> {
  while (building.size > 0) await Promise.all([...building.values()]);
}

/** Tests: forgets what this process remembers (holds, failures); waits for running summaries first. */
export async function _resetSummaryStart(): Promise<void> {
  await whenSummariesIdle();
  holdUntil.clear();
  failures.clear();
}

/**
 * Starts the summary of every company whose trigger is ready (and is not already being built here, nor held off), each as its
 * own task; returns at once with a promise of the leads they covered. Never rejects. A company with no trigger is forgotten.
 */
export function startReadySummaries(companies: readonly SummaryCompany[], now: Date): { started: number; done: Promise<number> } {
  const runs: Promise<number>[] = [];
  for (const c of companies) {
    if (!c.triggerAt) {
      holdUntil.delete(c.orgId);
      failures.delete(c.orgId);
      continue;
    }
    const trigger = c.triggerAt;
    if (building.has(c.orgId) || !summaryTriggerReady({ ...c, triggerAt: trigger }, now) || (holdUntil.get(c.orgId) ?? 0) > now.getTime()) continue;
    if (stopRequested()) break;
    const run = summariseCompany(c, trigger, now).finally(() => building.delete(c.orgId));
    building.set(c.orgId, run);
    runs.push(run);
  }
  return { started: runs.length, done: Promise.all(runs).then((leads) => leads.reduce((sum, n) => sum + n, 0)) };
}

/** One company's summary on the jobs client, in the company's scope. Never rejects. */
function summariseCompany(c: SummaryCompany, trigger: Date, now: Date): Promise<number> {
  return runOnJobsClient(() => runUnscoped(() => runWithOrg(c.orgId, () => buildSummary(c, trigger, now)))).catch((err: unknown) => {
    logger.error(`[spider-tick] starting summary task failed for org ${c.orgId}: ${errorName(err)}`);
    return 0;
  });
}

async function buildSummary(c: SummaryCompany, trigger: Date, now: Date): Promise<number> {
  const { orgId } = c;
  const lease = await claimSweepLease(undefined, summaryLeaseName(orgId));
  if (!lease) {
    // Another server is building it (or its lease has yet to expire): asked again in a few seconds.
    holdUntil.set(orgId, now.getTime() + BUILT_ELSEWHERE_RECHECK_MS);
    return 0;
  }
  try {
    if (!lease.held() || stopRequested()) return 0;
    const overdue = await readSummaryStays(orgId, c, trigger);
    const r = await runStartingSummary({
      orgId,
      now,
      triggeredAt: trigger,
      triggerKind: isTriggerKind(c.triggerKind) ? c.triggerKind : 'SETTINGS_CHANGED',
      activatedAt: c.activatedAt,
      overdue,
      channels: c.channels,
      recipientsConfig: readRecipients(c.recipients),
    });
    failures.delete(orgId);
    // The run is waiting for its next try (an attempt failed, or was stopped): the trigger stays, the company is not asked
    // again until the run's own next-attempt time, and its per-lead alerts for stays after the trigger go on (the due statement).
    if (r.state === 'waiting' || r.state === 'retry') {
      holdUntil.set(orgId, (r.retryAt ?? new Date(now.getTime() + SUMMARY_RETRY_WAITS_MS[0])).getTime());
      return 0;
    }
    holdUntil.delete(orgId);
    await clearSpentTrigger(orgId, trigger, now);
    return r.leads;
  } catch (err) {
    await failedBeforeTheRun(c, trigger, now, err);
    return 0;
  } finally {
    await lease.release();
  }
}

/**
 * A failure before the summary's run could count an attempt (finding the stays, finding or starting the run). Held off for the
 * same waits (2, 8, 30 minutes); after SUMMARY_MAX_ATTEMPTS in this process the trigger is dropped and logged once, so the
 * per-lead alerts take over, unless a run is open (its claims are released only by its own attempts, or by giving up). A restart
 * forgets the count, which costs three more tries per restart, never a loop.
 */
async function failedBeforeTheRun(c: SummaryCompany, trigger: Date, now: Date, err: unknown): Promise<void> {
  const count = (failures.get(c.orgId) ?? 0) + 1;
  failures.set(c.orgId, count);
  const wait = SUMMARY_RETRY_WAITS_MS[Math.min(count - 1, SUMMARY_RETRY_WAITS_MS.length - 1)]!;
  holdUntil.set(c.orgId, now.getTime() + wait);
  logger.error(`[spider-tick] starting summary failed for org ${c.orgId} (failure ${count} of ${SUMMARY_MAX_ATTEMPTS}): ${errorName(err)}`);
  if (count < SUMMARY_MAX_ATTEMPTS) return;
  const open = await hasOpenSummaryRun(c.orgId).catch(() => true);
  if (open) return;
  logger.error(`[spider-tick] starting summary gave up for org ${c.orgId} after ${count} failures: alerting per lead from the next check`);
  failures.delete(c.orgId);
  holdUntil.delete(c.orgId);
  await clearSpentTrigger(c.orgId, trigger, now).catch((e: unknown) => logger.error(`[spider-tick] could not clear the trigger of org ${c.orgId}: ${errorName(e)}`));
}
