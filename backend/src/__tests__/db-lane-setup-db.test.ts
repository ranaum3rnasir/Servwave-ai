/**
 * The lane setup against a real server (spec #3234, "Lanes"): a second worker on a lane fails loudly, the lock goes with its
 * connection, and a lane's leftover connections are ended when a file starts. Scratch databases of its own on the server of
 * TEST_DATABASE_URL, dropped at the end.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { joinLane } from './db-lane-setup';

const serverUrl = process.env.TEST_DATABASE_URL;
const suite = serverUrl ? describe : describe.skip;

const LANE = 97;
const dbName = `lane_${LANE}`;
const admin = (sql: string) => spawnSync('psql', ['-X', '-A', '-t', '-d', serverUrl!, '-c', sql], { encoding: 'utf8' });
const psqlUrl = (db: string) => { const u = new URL(serverUrl!); u.pathname = `/${db}`; return u.toString(); };

suite('the lane setup (real database)', () => {
  const base = (() => { const u = new URL(serverUrl ?? 'postgresql://x@localhost/x'); u.pathname = ''; return u.toString().replace(/\/$/, ''); })();
  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    DB_LANE_URL_BASE: base, DB_LANE_COUNT: String(LANE), VITEST_POOL_ID: String(LANE), DB_LANE_PSQL: 'psql', DB_LANE_LOCK_GRACE_MS: '400', ...extra,
  });
  const joined: { release: () => void }[] = [];

  beforeAll(() => {
    admin(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    expect(admin(`CREATE DATABASE ${dbName}`).status).toBe(0);
  });
  afterAll(() => {
    for (const j of joined) j.release();
    admin(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  });

  it('gives the worker its lane database', async () => {
    const lane = await joinLane(env());
    joined.push(lane!);
    expect(lane!.url).toBe(`${base}/${dbName}`);
    expect(lane!.lane).toBe(LANE);
  });

  it('refuses a second worker on the same lane, loudly, while the first is connected', async () => {
    await expect(joinLane(env())).rejects.toThrow(`db lanes: lane ${LANE} is already in use by another worker`);
  });

  it('lets the next worker in once the first one\'s connection is gone: the lock dies with it', async () => {
    for (const j of joined.splice(0)) j.release();
    const next = await joinLane(env({ DB_LANE_LOCK_GRACE_MS: '10000' }), Date.now());
    joined.push(next!);
    expect(next!.lane).toBe(LANE);
  });

  it('ends the leftover connections to the lane when a file starts', async () => {
    for (const j of joined.splice(0)) j.release();
    const marker = `leftover_${randomBytes(4).toString('hex')}`;
    const { spawn } = await import('node:child_process');
    const leftover = spawn('psql', ['-X', '-A', '-t', '-d', psqlUrl(dbName)], { stdio: ['pipe', 'pipe', 'pipe'] });
    leftover.stdin.write(`SET application_name = '${marker}';\nSELECT pg_sleep(60);\n`);
    const count = () => Number(admin(`SELECT count(*) FROM pg_stat_activity WHERE application_name = '${marker}'`).stdout.trim());
    const end = Date.now() + 5000;
    while (count() === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    expect(count()).toBe(1);
    joined.push((await joinLane(env({ DB_LANE_LOCK_GRACE_MS: '10000' }), Date.now()))!);
    // Ending a session only signals it and returns; the session leaves a moment later. Wait for it to be gone
    // (bounded), then assert, instead of reading the count in the gap.
    const gone = Date.now() + 10_000;
    while (count() !== 0 && Date.now() < gone) await new Promise((r) => setTimeout(r, 50));
    expect(count()).toBe(0);
    leftover.kill();
  });

  it('leaves alone a connection this file opened itself (one that is not older than the worker)', async () => {
    for (const j of joined.splice(0)) j.release();
    const marker = `own_${randomBytes(4).toString('hex')}`;
    const { spawn } = await import('node:child_process');
    const own = spawn('psql', ['-X', '-A', '-t', '-d', psqlUrl(dbName)], { stdio: ['pipe', 'pipe', 'pipe'] });
    own.stdin.write(`SET application_name = '${marker}';\nSELECT pg_sleep(60);\n`);
    const count = () => Number(admin(`SELECT count(*) FROM pg_stat_activity WHERE application_name = '${marker}'`).stdout.trim());
    const end = Date.now() + 5000;
    while (count() === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    const workerStartedBefore = Date.now() - 60_000;
    joined.push((await joinLane(env({ DB_LANE_LOCK_GRACE_MS: '10000' }), workerStartedBefore))!);
    expect(count()).toBe(1);
    own.kill();
  });

  it('throws, never skips, when the worker has no lane or the setup is incomplete', async () => {
    await expect(joinLane(env({ VITEST_POOL_ID: undefined }))).rejects.toThrow('db lanes: VITEST_POOL_ID is not set');
    await expect(joinLane(env({ VITEST_POOL_ID: String(LANE + 1) }))).rejects.toThrow(/db lanes: worker 98 has no lane/);
    await expect(joinLane(env({ DB_LANE_COUNT: undefined }))).rejects.toThrow('db lanes: DB_LANE_COUNT is not set');
    await expect(joinLane(env({ DB_LANE_PSQL: undefined }))).rejects.toThrow('db lanes: DB_LANE_PSQL is not set');
  });

  it('does nothing when lanes were not requested', async () => {
    expect(await joinLane({})).toBeUndefined();
  });
});
