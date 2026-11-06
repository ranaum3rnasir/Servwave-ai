/**
 * The runs behind Spider's starting summary (#3108): the summary is written in small saved pieces that resume, and a
 * summary that keeps failing is given up on.
 *
 * - A run row (`spider_summary_runs`) is one go at making one summary: RUNNING until the summary is complete (DONE) or
 *   given up on (ABANDONED). At most one RUNNING run per company (a partial unique index).
 * - Every attempt is counted and saved BEFORE it does any work (`startAttempt`), so an attempt that is killed halfway
 *   still counts: a restart cannot try for ever. The same statement writes when the next attempt may start: 2, 8, then
 *   30 minutes after this one began. The next-attempt time is data on the run row, judged against the clock the sweep
 *   was given (`runSpiderSweep(now)`), so a restart soon after a kill waits out the rest of the time too.
 * - After SUMMARY_MAX_ATTEMPTS attempts that did not finish, the run is given up on (`giveUp`): the claims it saved are
 *   released (a claim is the lead's place in the unique claim key, so left alone it would stop the per-lead alerts from ever
 *   reaching that lead), the summary is marked SUPERSEDED, the run ABANDONED, and the sweep alerts per lead from then on
 *   (capped per run, runCaps.ts). Nothing here sends a message; the summary's delivery is summary.ts.
 * - The summary row has a status: BUILDING while its claims are being written (nobody can read it), READY once complete,
 *   SUPERSEDED when replaced. An older summary is marked SUPERSEDED and never deleted, so no row of its claims is rewritten
 *   (spider_alerts.summary_id is ON DELETE SET NULL; a delete would have rewritten every one).
 *
 * Who owns what in a summary's `delivery` record:
 *   - `state: 'SENDING'`, `email_started`, `text_started`, `email_done`, `text_done`: the delivery run (this module's markReady /
 *     markChannel*), while the delivery is going; they are gone from the final record.
 *   - `in_app`, `email`, `text`: written ONCE by recordDelivery when the delivery ends. From then on `email` belongs to the
 *     provider's delivery events (emailEvents.ts), which correct a person's outcome to "could not be delivered"; the final
 *     record merges with it and never overwrites it. An event that arrives before `email` exists is answered "not recorded
 *     yet" (the provider tries again), so no event is ever answered and then lost.
 *
 * This module is the ONE owner of the summary row's writes: its status (BUILDING, READY, SUPERSEDED), the mark that its
 * delivery has begun and each channel's start, and the record of the outcome. summary.ts only reads it.
 *
 * Every statement here is its own single statement on the shared client (and, run by the sweep, the jobs' client): no
 * interactive transaction, so no line is held for the length of the summary.
 *
 * Logs carry ids only.
 */
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';

/** Attempts a summary gets before the company falls back to per-lead alerts. */
export const SUMMARY_MAX_ATTEMPTS = 3;

/**
 * How long after an attempt BEGAN the next one may start: after the first, 2 minutes; after the second, 8; after the
 * third, 30. (The wait after the third only matters to an attempt that was killed: one that fails in a way the run can
 * see is given up on at once; a killed third attempt leaves a RUNNING run that is given up on once the 30 minutes pass.)
 */
export const SUMMARY_RETRY_WAITS_MS = [2 * 60_000, 8 * 60_000, 30 * 60_000] as const;

/** Claims per statement, at most (the statement's size also bounds it, summary.ts SUMMARY_CLAIMS_INSERT_BYTES). */
export const SUMMARY_CLAIMS_PER_STATEMENT = 500;

/** Claims released per statement when a run is given up on. */
const RELEASE_PER_STATEMENT = 500;

export type SummaryStatus = 'BUILDING' | 'READY' | 'SUPERSEDED';

/** A summary row with no status (the column is nullable) is a READY one: that is what every row from before #3108 is. */
const statusOf = (raw: string | null): SummaryStatus => (raw === 'BUILDING' || raw === 'SUPERSEDED' ? raw : 'READY');

/** The summary that is current for a company: any that is not SUPERSEDED (at most one, by the partial unique index). */
const CURRENT: Prisma.SpiderSummaryWhereInput = { OR: [{ status: null }, { status: { not: 'SUPERSEDED' } }] };
/** A summary people can read. */
export const READABLE_SUMMARY: Prisma.SpiderSummaryWhereInput = { OR: [{ status: null }, { status: 'READY' }] };

/** What one channel (email or text) recorded when it finished: the outcome as the summary shows it, and each person's result. */
export interface ChannelDone {
  outcome: string;
  recipients?: { user_id: string; outcome: string; message_id?: string }[];
  results: { user_id: string; result: 'sent' | 'failed' | 'skipped'; reason: string | null }[];
}

/** What a summary's `delivery` says about how far its delivery got, before its outcome is recorded. */
export interface DeliveryProgress {
  /** Delivery began and no outcome is recorded yet (the run that began it stopped, or is still going). */
  unfinished: boolean;
  /** A channel that was started is not started again, whoever it had reached; one that finished is not redone either. */
  email: { started: boolean; done: ChannelDone | null };
  text: { started: boolean; done: ChannelDone | null };
}

export function deliveryProgress(delivery: Prisma.JsonValue): DeliveryProgress {
  const d: Record<string, Prisma.JsonValue | undefined> = delivery && typeof delivery === 'object' && !Array.isArray(delivery) ? delivery : {};
  const channel = (name: 'email' | 'text') => {
    const done = d[`${name}_done`];
    const finished =
      done && typeof done === 'object' && !Array.isArray(done) && typeof done.outcome === 'string' && Array.isArray(done.results) ? (done as unknown as ChannelDone) : null;
    return { started: d[`${name}_started`] === true, done: finished };
  };
  return { unfinished: d.state === 'SENDING', email: channel('email'), text: channel('text') };
}

/** A run in progress, with the parts of its summary the sweep decides on. */
export interface OpenRun {
  id: string;
  organization_id: string;
  summary_id: string;
  attempts: number;
  cursor: string | null;
  next_attempt_at: Date | null;
  summary: { status: SummaryStatus; triggered_at: Date; trigger_kind: string; lead_count: number; delivery: Prisma.JsonValue };
}

/** The READY summary that was made for this very trigger, if there is one (a trigger gets one summary, however a stop fell). */
export async function readySummaryOfTrigger(orgId: string, triggeredAt: Date): Promise<{ id: string; lead_count: number } | null> {
  return prisma.spiderSummary.findFirst({
    where: { organization_id: orgId, triggered_at: triggeredAt, ...READABLE_SUMMARY },
    select: { id: true, lead_count: true },
  });
}

/** The company's RUNNING run, if any. */
export async function findOpenRun(orgId: string): Promise<OpenRun | null> {
  const run = await prisma.spiderSummaryRun.findFirst({
    where: { organization_id: orgId, status: 'RUNNING' },
    select: { id: true, organization_id: true, summary_id: true, attempts: true, cursor: true, next_attempt_at: true },
  });
  if (!run) return null;
  const summary = await prisma.spiderSummary.findUnique({
    where: { id: run.summary_id },
    select: { status: true, triggered_at: true, trigger_kind: true, lead_count: true, delivery: true },
  });
  // The foreign key makes this impossible; a run with no summary has nothing to deliver and is treated as replaced.
  const row = summary ?? { status: 'SUPERSEDED', triggered_at: new Date(0), trigger_kind: '', lead_count: 0, delivery: {} };
  return { ...run, summary: { ...row, status: statusOf(row.status) } };
}

/**
 * Marks the company's current summary SUPERSEDED (a single-row update; none of its claims is touched). Nothing is
 * deleted: the summary and its claims stay for good. Returns the ids of the READY ones it replaced (for `restoreSummaries`).
 */
export async function supersedeCurrentSummary(orgId: string): Promise<string[]> {
  const ready = await prisma.spiderSummary.findMany({ where: { organization_id: orgId, ...READABLE_SUMMARY }, select: { id: true } });
  await prisma.spiderSummary.updateMany({ where: { organization_id: orgId, ...CURRENT }, data: { status: 'SUPERSEDED' } });
  return ready.map((r) => r.id);
}

/**
 * Starts a new summary and its run: the current summary is superseded (the one-current-summary-per-company index allows
 * no second), then the new summary (BUILDING) and its run (RUNNING, no attempt yet) are written, each in its own statement.
 * A stop between them leaves, at worst, a BUILDING summary with no run, which the next one supersedes. `replaced` is the
 * READY summaries it superseded.
 */
export async function createRun(a: { orgId: string; now: Date; triggeredAt: Date; triggerKind: string }): Promise<{ run: OpenRun; replaced: string[] }> {
  const replaced = await supersedeCurrentSummary(a.orgId);
  const summaryId = randomUUID();
  await prisma.spiderSummary.create({
    data: {
      id: summaryId,
      organization_id: a.orgId,
      created_at: a.now,
      triggered_at: a.triggeredAt,
      trigger_kind: a.triggerKind,
      status: 'BUILDING',
    },
    select: { id: true },
  });
  const created = await prisma.spiderSummaryRun.create({
    data: { id: randomUUID(), organization_id: a.orgId, summary_id: summaryId },
    select: { id: true },
  });
  const run: OpenRun = {
    id: created.id,
    organization_id: a.orgId,
    summary_id: summaryId,
    attempts: 0,
    cursor: null,
    next_attempt_at: null,
    summary: { status: 'BUILDING', triggered_at: a.triggeredAt, trigger_kind: a.triggerKind, lead_count: 0, delivery: {} },
  };
  return { run, replaced };
}

/**
 * The one place a summary becomes READY, in ONE statement, and the claim on its delivery: it also marks the delivery as begun
 * (`{ state: 'SENDING' }`). True only for the call that changed the row: that run delivers, nobody else ever does.
 */
export async function markReady(summaryId: string, leadCount: number): Promise<boolean> {
  const { count } = await prisma.spiderSummary.updateMany({
    where: { id: summaryId, status: 'BUILDING' },
    data: { status: 'READY', lead_count: leadCount, delivery: { state: 'SENDING' } },
  });
  return count === 1;
}

/** A summary that came to nothing (every stay was claimed meanwhile, or nobody could be told). `restore` brings back the READY ones it replaced. */
export async function endEmptySummary(orgId: string, summaryId: string, restore: readonly string[]): Promise<void> {
  await prisma.spiderSummary.updateMany({ where: { id: summaryId }, data: { status: 'SUPERSEDED' } });
  if (restore.length > 0) await prisma.spiderSummary.updateMany({ where: { id: { in: [...restore] }, organization_id: orgId }, data: { status: 'READY' } });
}

/** Saves that a delivery channel is about to start: if the run stops, the channel is not started again (at most once). */
export async function markChannelStarted(summaryId: string, channel: 'email' | 'text'): Promise<void> {
  const key = `${channel}_started`;
  await prisma.$executeRaw`UPDATE spider_summaries SET delivery = delivery || jsonb_build_object(${key}::text, true) WHERE id = ${summaryId}::uuid`;
}

/**
 * Saves how a delivery channel went, the moment it finishes, so a restart after that does not call it interrupted. It goes under
 * `email_done` / `text_done`, NOT under `email` / `text`: the provider's delivery events (emailEvents.ts) correct `email` only
 * once the final record has written it, and until then answer "not recorded yet" so the provider tries again.
 */
export async function markChannelDone(summaryId: string, channel: 'email' | 'text', done: ChannelDone): Promise<void> {
  const key = `${channel}_done`;
  await prisma.$executeRaw`UPDATE spider_summaries SET delivery = delivery || jsonb_build_object(${key}::text, ${JSON.stringify(done)}::jsonb) WHERE id = ${summaryId}::uuid`;
}

/**
 * Records how the delivery went, once: the summary's counts and, per channel, the outcome. This replaces the in-progress marks
 * and merges with, never overwrites, an `email` outcome already on the row (one the provider's events corrected).
 */
export async function recordDelivery(summaryId: string, record: { leadCount: number; recipientCount: number; delivery: Prisma.InputJsonValue }): Promise<void> {
  await prisma.$executeRaw`
    UPDATE spider_summaries
       SET lead_count = ${record.leadCount}::int,
           recipient_count = ${record.recipientCount}::int,
           delivery = ${JSON.stringify(record.delivery)}::jsonb
                      || CASE WHEN delivery ? 'email' THEN jsonb_build_object('email', delivery->'email') ELSE '{}'::jsonb END
     WHERE id = ${summaryId}::uuid`;
}

/**
 * Counts the attempt and saves it, with the time the next one may start, BEFORE the attempt does any work. Returns the
 * attempt's number (1, 2, 3).
 */
export async function startAttempt(run: Pick<OpenRun, 'id' | 'attempts'>, now: Date): Promise<number> {
  const wait = SUMMARY_RETRY_WAITS_MS[Math.min(run.attempts, SUMMARY_RETRY_WAITS_MS.length - 1)]!;
  const saved = await prisma.spiderSummaryRun.update({
    where: { id: run.id },
    data: { attempts: { increment: 1 }, next_attempt_at: new Date(now.getTime() + wait) },
    select: { attempts: true },
  });
  return saved.attempts;
}

/** Saves the last lead whose claim is now saved: a resumed run starts after it. */
export async function saveCursor(runId: string, leadId: string): Promise<void> {
  await prisma.spiderSummaryRun.update({ where: { id: runId }, data: { cursor: leadId } });
}

/** Records why an attempt failed: the error's class only, never its message. */
export async function recordFailure(runId: string, err: unknown): Promise<void> {
  await prisma.spiderSummaryRun.update({ where: { id: runId }, data: { last_error: errorName(err) } });
}

/** The run is complete. */
export async function finishRun(runId: string, now: Date): Promise<void> {
  await prisma.spiderSummaryRun.update({ where: { id: runId }, data: { status: 'DONE', finished_at: now } });
}

/**
 * Releases the claims of a summary that will never be READY, in statements of at most RELEASE_PER_STATEMENT rows, each
 * saved on its own: the leads are unclaimed again, so the per-lead path can alert them. Safe to repeat (a second call
 * after a stop finishes the rest). Returns how many it released.
 */
export async function releaseSummaryClaims(orgId: string, summaryId: string): Promise<number> {
  let released = 0;
  for (;;) {
    const n = await prisma.$executeRaw`
      DELETE FROM spider_alerts
       WHERE id IN (SELECT id FROM spider_alerts
                     WHERE organization_id = ${orgId}::uuid AND summary_id = ${summaryId}::uuid
                     LIMIT ${RELEASE_PER_STATEMENT})`;
    released += n;
    if (n < RELEASE_PER_STATEMENT) return released;
  }
}

/**
 * Gives up on a run: its claims are released FIRST (if that stops, the run is still RUNNING and the next sweep finishes
 * it), then the summary is marked SUPERSEDED and the run ABANDONED. `lastError` is kept on the run; the caller logs the
 * outcome once. Returns how many claims were released.
 */
export async function giveUp(run: Pick<OpenRun, 'id' | 'organization_id' | 'summary_id'>, now: Date, lastError: string | null): Promise<number> {
  const released = await releaseSummaryClaims(run.organization_id, run.summary_id);
  await prisma.spiderSummary.updateMany({ where: { id: run.summary_id }, data: { status: 'SUPERSEDED' } });
  await prisma.spiderSummaryRun.update({
    where: { id: run.id },
    data: { status: 'ABANDONED', finished_at: now, ...(lastError ? { last_error: lastError } : {}) },
  });
  return released;
}

/** An error's class name only - never its message, which can carry the values it failed on. */
export function errorName(err: unknown): string {
  if (err instanceof Prisma.PrismaClientKnownRequestError) return `${err.name} ${err.code}`;
  return err instanceof Error ? err.name : 'unknown error';
}

/** Logged once, when a run is given up on. */
export function logGaveUp(orgId: string, summaryId: string, attempts: number, released: number): void {
  logger.error(
    `[spider] starting summary gave up for org ${orgId} (summary ${summaryId}) after ${attempts} attempts; ${released} saved claims released: alerting per lead from the next run`,
  );
}
