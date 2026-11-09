/*
 * Database check lanes: the setup that points each test worker at its own database.
 *
 * `npm run test:db` (scripts/ci-db/) copies the migrated database once per lane (`lane_1` ... `lane_N`) and runs every
 * remaining real-database test file in ONE vitest run with one worker per lane. This file is called from setup.ts, before
 * a test file loads, and does nothing at all unless that command started the run (DB_LANE_URL_BASE is set). So the old way
 * still works unchanged: set TEST_DATABASE_URL yourself and run one file.
 *
 * In lane mode it:
 *  1. points TEST_DATABASE_URL at the worker's lane. It THROWS, never skips, when the worker id is missing or outside the
 *     lanes: a skipped file would be a green check that tested nothing;
 *  2. takes a Postgres advisory lock on the lane for the whole file and fails loudly if it cannot. Two workers on one lane
 *     are a hard error instead of a flake that a retry hides. The lock belongs to a connection (a psql child process) that
 *     dies with this worker, so it cannot go stale;
 *  3. ends the leftover client connections to the lane (nothing else is legitimately connected when a file starts);
 *  4. notes when the file started and ended in the run's events file, so the command can name the in-flight file per lane.
 *
 * Errors start with "db lanes:"; the command reads that prefix and reports the run as a wiring failure of the
 * infrastructure, not as a failed test.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect } from 'vitest';
import { terminateOtherSessionsOlderThanSql } from './support/cancel-own-backend';

/** The advisory lock class of the lane locks: (class, lane number). Nothing else in the repo takes locks in this class. */
export const LANE_LOCK_CLASS = 3236;
/** How long a second worker on a lane waits for the first one's connection to go before it fails (a worker that just ended). */
export const LANE_LOCK_GRACE_MS = 15_000;

/**
 * The database a worker uses, or undefined when lanes were not requested (`base` unset). Throws when they were and the worker
 * id is missing, not a whole number, or outside 1..lanes.
 */
export function laneDatabaseUrl(base: string | undefined, workerId: string | undefined, lanes: number): string | undefined {
  if (!base) return undefined;
  if (!workerId) throw new Error('db lanes: VITEST_POOL_ID is not set');
  const n = Number(workerId);
  if (!/^\d+$/.test(workerId) || n < 1 || n > lanes) {
    throw new Error(`db lanes: worker ${workerId} has no lane (lanes are 1..${lanes})`);
  }
  return `${base}/lane_${n}`;
}

type Sql = (statement: string) => Promise<string[]>;

/** A psql child process that stays connected, with a way to ask it one statement at a time. */
export function openSession(psql: string, url: string): { child: ChildProcessWithoutNullStreams; ask: Sql } {
  const child = spawn(psql, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=0', '-d', url], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.unref();
  // The worker must be able to end while the session is open.
  (child.stdin as unknown as { unref?: () => void }).unref?.();
  (child.stdout as unknown as { unref?: () => void }).unref?.();
  (child.stderr as unknown as { unref?: () => void }).unref?.();
  let out = '';
  let err = '';
  let waiting: { done: (lines: string[]) => void; fail: (e: Error) => void } | undefined;
  const settle = () => {
    const at = out.indexOf('__done__\n');
    if (at < 0 || !waiting) return;
    const lines = out.slice(0, at).split('\n').filter(Boolean);
    out = out.slice(at + '__done__\n'.length);
    const w = waiting;
    waiting = undefined;
    w.done(lines);
  };
  child.stdout.on('data', (b: Buffer) => { out += b.toString(); settle(); });
  child.stderr.on('data', (b: Buffer) => { err += b.toString(); });
  child.on('error', (e) => waiting?.fail(new Error(`db lanes: psql could not start (${e.message})`)));
  child.on('exit', () => waiting?.fail(new Error(`db lanes: the lane connection closed (${err.trim().split('\n')[0] ?? 'no message'})`)));
  const ask: Sql = (statement) => new Promise((done, fail) => {
    waiting = { done, fail };
    child.stdin.write(`${statement};\n\\echo __done__\n`);
  });
  return { child, ask };
}

/** Waits until the lane's advisory lock is ours; a worker that just ended may still hold it for a moment. */
export async function takeLaneLock(ask: Sql, lane: number, graceMs: number): Promise<void> {
  const deadline = Date.now() + graceMs;
  for (;;) {
    const [got] = await ask(`SELECT pg_try_advisory_lock(${LANE_LOCK_CLASS}, ${lane})`);
    if (got === 't') return;
    if (Date.now() >= deadline) throw new Error(`db lanes: lane ${lane} is already in use by another worker`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function note(event: Record<string, unknown>): void {
  const file = process.env.DB_CHECK_EVENTS_FILE;
  if (file) appendFileSync(file, `${JSON.stringify({ ...event, t: Date.now() })}\n`);
}

export interface LaneAssignment {
  url: string;
  lane: number;
  lanes: number;
  psql: string;
}

/**
 * The lane of this worker, from its environment, or undefined when lanes were not requested. Pure and synchronous, so a worker with no
 * lane (or an incomplete setup) fails at once, before the test file loads. Throws a "db lanes:" error on any problem.
 */
export function laneFromEnv(env: NodeJS.ProcessEnv): LaneAssignment | undefined {
  const base = env.DB_LANE_URL_BASE;
  if (!base) return undefined;
  const lanes = Number(env.DB_LANE_COUNT);
  if (!Number.isInteger(lanes) || lanes < 1) throw new Error('db lanes: DB_LANE_COUNT is not set');
  const url = laneDatabaseUrl(base, env.VITEST_POOL_ID, lanes)!;
  const psql = env.DB_LANE_PSQL;
  if (!psql) throw new Error('db lanes: DB_LANE_PSQL is not set');
  return { url, lane: Number(env.VITEST_POOL_ID), lanes, psql };
}

export interface JoinedLane {
  url: string;
  lane: number;
  /** Ends the lane connection (and with it the lock). */
  release: () => void;
}

/**
 * Takes the lock on the lane and ends the connections that were left on it by the worker before this one (those older than this
 * process: nothing this file itself opened is touched). Throws a "db lanes:" error when the lane is in use.
 */
export async function holdLane(a: LaneAssignment, env: NodeJS.ProcessEnv, startedAtMs: number = Date.now() - process.uptime() * 1000): Promise<JoinedLane> {
  const { child, ask } = openSession(a.psql, a.url);
  try {
    await takeLaneLock(ask, a.lane, Number(env.DB_LANE_LOCK_GRACE_MS ?? LANE_LOCK_GRACE_MS));
    await ask(terminateOtherSessionsOlderThanSql(startedAtMs));
  } catch (e) {
    child.stdin.end();
    throw e;
  }
  return { url: a.url, lane: a.lane, release: () => { child.stdin.end(); } };
}

/** Both steps at once (the lane's address and the hold on it). */
export async function joinLane(env: NodeJS.ProcessEnv, startedAtMs?: number): Promise<JoinedLane | undefined> {
  const a = laneFromEnv(env);
  return a ? holdLane(a, env, startedAtMs) : undefined;
}

/**
 * Called from setup.ts. The address and the "started" note are set at once, before the test file loads, and a worker with no lane
 * throws there. The lock is taken in a hook before the first test: the setup file cannot wait at its top level (the backend compiles
 * as CommonJS), and an import that opens a connection is left alone because only older connections are ended.
 */
export function applyLaneSetup(): void {
  const lane = laneFromEnv(process.env);
  if (!lane) return;
  process.env.TEST_DATABASE_URL = lane.url;
  const testPath = expect.getState().testPath;
  const file = testPath ? path.relative(process.cwd(), testPath).split(path.sep).join('/') : '(unknown file)';
  note({ ev: 'lane-start', lane: lane.lane, file });
  let joined: JoinedLane | undefined;
  beforeAll(async () => { joined = await holdLane(lane, process.env); });
  afterAll(() => {
    note({ ev: 'lane-end', lane: lane.lane, file });
    joined?.release();
  });
}
