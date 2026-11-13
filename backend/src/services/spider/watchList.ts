/**
 * Spider's watch list (#3468): the backfill and the nightly check of `spider_lead_watch`.
 *
 * The database keeps the list itself: triggers on `leads` write a lead's row (its Spider stage and the instant it entered
 * it, by `spiderStageOf`'s rules repeated in the SQL function `spider_stage_of`) in the same statement as every save that
 * changes one of the ten columns those rules read (migration 20261112090000). Two things are left for the server:
 *
 *  - The backfill: the leads that existed before the migration have no row until they are saved. It writes them.
 *  - The nightly check: the list should never drift from the leads (nothing writes the leads around the triggers), so it
 *    compares the two, repairs any difference and logs how many rows it repaired. 0 is the expected answer; anything else
 *    is logged as an error.
 *
 * Both are the same pass: every lead of every company, in lead id order, 2,000 leads per statement. Each statement reads its
 * chunk of leads, finds the ones whose row is missing or differs from what the lead says now, re-reads exactly those leads
 * under a share lock (skipping any lead a user is saving at that moment: that save's trigger writes its row) and writes
 * their rows. One statement per chunk, each its own transaction, nothing held between two of them, on the jobs' own
 * database lines (both are started through lib/scheduleJob.ts), unscoped (the pass crosses companies). A repaired or
 * new row is a new stay: pending = true and changed_at = now, as the trigger writes it.
 *
 * Neither runs unless it is chosen, with SPIDER_WATCH_LIST:
 *  - unset: nothing runs (the boot says so);
 *  - `backfill`: the backfill runs once at every boot. A run stopped half-way (a deploy, a restart) starts again at the next
 *    boot and writes only what is still missing; a chunk already written costs one read-only statement;
 *  - `check`: the nightly check runs (index.ts). No backfill.
 * So the production order is chosen step by step, never by the clock: the code release (unset), then `backfill` (its own
 * release; the boot logs "backfill finished"), then `check` (the next night logs "0 rows repaired"), then the per-lead check
 * of #3469. The nightly check never runs before someone chooses `check`, so it cannot quietly become the backfill; chosen
 * too early, it writes the missing rows all the same and logs that count as an error.
 *
 * Logs carry counts and lead ids only, never a name.
 */
import { prisma } from '../../lib/prisma';
import { runUnscoped } from '../../lib/tenant-context';
import { logger } from '../../lib/logger';
import { env } from '../../config/env';
import { isJobPaused } from '../../lib/jobsPaused';

/** Leads per statement. */
export const WATCH_LIST_CHUNK = 2_000;

/** A pause between two chunks: a background job is slow on purpose, so the users' lead saves always get through first. */
const PAUSE_BETWEEN_CHUNKS_MS = 50;

/** The backfill says how far it is every this many chunks (100,000 leads). */
const PROGRESS_EVERY_CHUNKS = 50;

export type WatchListMode = 'backfill' | 'check';

/** What SPIDER_WATCH_LIST asks for: `backfill`, `check`, or null (unset, empty, or anything else). */
export function watchListMode(): WatchListMode | null {
  const value = (env.SPIDER_WATCH_LIST ?? '').trim().toLowerCase();
  return value === 'backfill' || value === 'check' ? value : null;
}

/**
 * Whether the check (tick.ts, `spider-tick`) runs in this deployment: the watch list is marked complete (SPIDER_WATCH_LIST=check)
 * and the job is not paused. The one switch #3469 starts the check by and #3471 slows the sweep by: with it off, which is the
 * code release before the backfill, the sweep stays the 2-minute alerter and acts on starting triggers as before.
 */
export function spiderTickEnabled(): boolean {
  return watchListMode() === 'check' && !isJobPaused('spider-tick');
}

/** One chunk: how many leads it read, the last lead id it read (null when there were none), and what it found and wrote. */
export interface WatchListChunk {
  read: number;
  lastId: string | null;
  /** Leads whose row was missing or differed from the lead. */
  found: number;
  /** Of those, the ones a user was saving at that moment, left to that save's trigger. */
  busy: number;
  /** Rows written (inserted, or repaired). */
  written: number;
}

// The ten columns spider_stage_of reads, named as its arguments, from a leads row aliased `l`.
const STAGE_OF_L = `public.spider_stage_of(
    status => l.status, created_at => l.created_at, contacted_at => l.contacted_at,
    returned_to_new_at => l.returned_to_new_at, walkthrough_first_booked_at => l.walkthrough_first_booked_at,
    last_visit_completed_at => l.last_visit_completed_at, first_estimate_sent_at => l.first_estimate_sent_at,
    won_at => l.won_at, lost_at => l.lost_at, cancelled_at => l.cancelled_at)`;

/**
 * The one statement of a chunk. `$1` is the chunk size, `$2` (when `after` is set) the last lead id of the chunk before.
 *
 * - chunk:   the next leads by id (the primary key's order, so each chunk starts where the last one ended).
 * - drift:   those whose row is missing, or whose company, stage or entry instant differs from what the lead says.
 * - fresh:   exactly those leads read again under FOR SHARE, SKIP LOCKED: the newest committed version of the lead (a save
 *            committed since this statement began is seen), and a lead a user is saving right now is skipped rather than
 *            waited for (that save's trigger writes its row). The share lock keeps the lead unchanged until this
 *            statement's transaction commits, so the row written below can never undo a newer save.
 * - written: the rows, written as the trigger writes them; a row that already agrees (a save got there first) is not touched.
 */
function chunkSql(after: boolean): string {
  return `
WITH chunk AS (
  SELECT l.id, l.organization_id, s.stage, s.entered_at
    FROM (SELECT id, organization_id, status, created_at, contacted_at, returned_to_new_at, walkthrough_first_booked_at,
                 last_visit_completed_at, first_estimate_sent_at, won_at, lost_at, cancelled_at
            FROM public.leads
           ${after ? 'WHERE id > $2::uuid' : ''}
           ORDER BY id
           LIMIT $1) l
    CROSS JOIN LATERAL ${STAGE_OF_L} s
),
drift AS (
  SELECT c.id
    FROM chunk c
    LEFT JOIN public.spider_lead_watch w ON w.lead_id = c.id
   WHERE w.lead_id IS NULL
      OR w.organization_id IS DISTINCT FROM c.organization_id
      OR w.stage IS DISTINCT FROM c.stage
      OR w.entered_at IS DISTINCT FROM c.entered_at
),
fresh AS (
  SELECT l.id, l.organization_id, s.stage, s.entered_at
    FROM public.leads l
    CROSS JOIN LATERAL ${STAGE_OF_L} s
   WHERE l.id IN (SELECT id FROM drift)
     FOR SHARE OF l SKIP LOCKED
),
written AS (
  INSERT INTO public.spider_lead_watch AS w (lead_id, organization_id, stage, entered_at, pending, changed_at)
  SELECT id, organization_id, stage, entered_at, true, (now() AT TIME ZONE 'UTC') FROM fresh
  ON CONFLICT (lead_id) DO UPDATE
     SET organization_id = EXCLUDED.organization_id,
         stage = EXCLUDED.stage,
         entered_at = EXCLUDED.entered_at,
         pending = true,
         changed_at = EXCLUDED.changed_at
   WHERE w.organization_id IS DISTINCT FROM EXCLUDED.organization_id
      OR w.stage IS DISTINCT FROM EXCLUDED.stage
      OR w.entered_at IS DISTINCT FROM EXCLUDED.entered_at
  RETURNING w.lead_id
)
SELECT (SELECT count(*) FROM chunk)::int AS read,
       (SELECT id FROM chunk ORDER BY id DESC LIMIT 1)::text AS last_id,
       (SELECT count(*) FROM drift)::int AS found,
       (SELECT count(*) FROM fresh)::int AS locked,
       (SELECT count(*) FROM written)::int AS written`;
}

/** Compare and repair one chunk of `size` leads after the lead `after` (from the first lead when null). One statement. */
export async function reconcileWatchListChunk(after: string | null, size: number = WATCH_LIST_CHUNK): Promise<WatchListChunk> {
  const args: unknown[] = after === null ? [size] : [size, after];
  const [row] = await prisma.$queryRawUnsafe<{ read: number; last_id: string | null; found: number; locked: number; written: number }[]>(
    chunkSql(after !== null),
    ...args,
  );
  return { read: row!.read, lastId: row!.last_id, found: row!.found, busy: row!.found - row!.locked, written: row!.written };
}

/** A whole pass over every lead. */
export interface WatchListPass {
  leadsRead: number;
  found: number;
  busy: number;
  written: number;
  chunks: number;
  ms: number;
}

export interface WatchListPassOptions {
  /** Leads per statement (tests use a small one). */
  chunk?: number;
  /** The pause between two chunks. */
  pauseMs?: number;
  /** Called after each chunk with the pass so far (the backfill's progress line). */
  onChunk?: (pass: WatchListPass, chunk: WatchListChunk) => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every lead, chunk by chunk, until a chunk reads none. Unscoped: the pass crosses companies by design. */
export async function reconcileWatchList(options: WatchListPassOptions = {}): Promise<WatchListPass> {
  const size = options.chunk ?? WATCH_LIST_CHUNK;
  const pauseMs = options.pauseMs ?? PAUSE_BETWEEN_CHUNKS_MS;
  const started = Date.now();
  const pass: WatchListPass = { leadsRead: 0, found: 0, busy: 0, written: 0, chunks: 0, ms: 0 };
  let after: string | null = null;
  for (;;) {
    const chunk: WatchListChunk = await runUnscoped(() => reconcileWatchListChunk(after, size));
    pass.chunks += 1;
    pass.leadsRead += chunk.read;
    pass.found += chunk.found;
    pass.busy += chunk.busy;
    pass.written += chunk.written;
    pass.ms = Date.now() - started;
    options.onChunk?.(pass, chunk);
    if (chunk.lastId === null || chunk.read < size) break;
    after = chunk.lastId;
    if (pauseMs > 0) await sleep(pauseMs);
  }
  pass.ms = Date.now() - started;
  return pass;
}

const counts = (p: WatchListPass) =>
  `${p.leadsRead} leads read in ${p.chunks} statements, ${p.ms} ms` + (p.busy > 0 ? `, ${p.busy} being saved at that moment (left to their save)` : '');

/** What the boot says when SPIDER_WATCH_LIST does not ask for the backfill. */
function bootLine(): string {
  const written = env.SPIDER_WATCH_LIST;
  const mode = watchListMode();
  if (mode === 'check') return '[spider-watch] SPIDER_WATCH_LIST=check: the nightly check is on; no backfill at boot';
  if (written !== undefined && written.trim() !== '') {
    return `[spider-watch] SPIDER_WATCH_LIST=${written.trim()} is neither backfill nor check: no backfill, no nightly check`;
  }
  return '[spider-watch] SPIDER_WATCH_LIST is not set: no backfill, no nightly check (the database keeps the list on every lead save)';
}

/**
 * The backfill, run at boot (index.ts, job `spider-watch-backfill`). Runs only when SPIDER_WATCH_LIST=backfill; otherwise it
 * logs what the setting asks for and reads nothing. Resolves to the pass, or null when it did not run.
 */
export async function runWatchListBackfill(options: WatchListPassOptions = {}): Promise<WatchListPass | null> {
  if (watchListMode() !== 'backfill') {
    const line = bootLine();
    if (/neither backfill nor check/.test(line)) logger.warn(line);
    else logger.info(line);
    return null;
  }
  logger.info('[spider-watch] backfill started (SPIDER_WATCH_LIST=backfill)');
  const pass = await reconcileWatchList({
    ...options,
    onChunk: (p, chunk) => {
      if (p.chunks % PROGRESS_EVERY_CHUNKS === 0) {
        logger.info(`[spider-watch] backfill: ${p.written} rows written so far, ${counts(p)}, at lead ${chunk.lastId}`);
      }
      options.onChunk?.(p, chunk);
    },
  });
  logger.info(`[spider-watch] backfill finished: ${pass.written} rows written, ${counts(pass)}`);
  return pass;
}

/**
 * The nightly check (index.ts, job `spider-watch-check`). Runs only when SPIDER_WATCH_LIST=check; otherwise it logs one line
 * and reads nothing. 0 rows repaired is logged as info; any other count as an error. Resolves to the pass, or null.
 */
export async function runWatchListCheck(options: WatchListPassOptions = {}): Promise<WatchListPass | null> {
  if (watchListMode() !== 'check') {
    logger.info('[spider-watch] the nightly check is off (it runs only with SPIDER_WATCH_LIST=check)');
    return null;
  }
  const pass = await reconcileWatchList(options);
  if (pass.written === 0) {
    logger.info(`[spider-watch] check: 0 rows repaired, ${counts(pass)}`);
  } else {
    logger.error(`[spider-watch] check: ${pass.written} rows repaired (expected 0), ${counts(pass)}`);
  }
  return pass;
}
