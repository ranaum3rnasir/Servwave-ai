/* =============================================================================
   Health endpoints (#3106) - the health endpoint and the deep health endpoint, over HTTP, real app, real
   migrated database.

   /health says the process is alive and never asks the database. /health/deep asks the database on a line of its
   own and says it is down when it cannot get an answer within 2 s. The platform restarts the server when /health
   fails, so a job holding every database line must not be able to fail it.

   Skips when TEST_DATABASE_URL is unset.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Prisma, PrismaClient } from '@prisma/client';

const { realClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (!dbUrl) return { realClient: undefined };
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  // Two lines, so "every line of the users' pool" is something a test can hold.
  const url = new URL(dbUrl);
  url.searchParams.set('connection_limit', '2');
  return { realClient: new PrismaClient({ datasources: { db: { url: url.toString() } } }) };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));

// The app's database URL points at the same test database as the client above (the deep probe's client reads it).
vi.mock('../config/env', async () => {
  const { testEnv } = await import('./test-env.js');
  return { env: { ...testEnv, DATABASE_URL: process.env.TEST_DATABASE_URL ?? testEnv.DATABASE_URL } };
});

import request from 'supertest';
import { performance } from 'perf_hooks';
import { switchFixture } from './permission-switches-fixture';
import { heldLines } from './support/held-lines';
import { terminateOtherSessionsInOwnDatabase } from './support/cancel-own-backend';

const suite = realClient ? describe : describe.skip;

suite('Health endpoints (real database)', () => {
  const db = realClient as PrismaClient;
  let app: Parameters<typeof request>[0];
  const fx = switchFixture(realClient as PrismaClient, async () => (await import('../app.js')).default as never);
  // The deep probe's own client. Only used here to hold ITS line, the way a stuck statement would.
  let healthClient: PrismaClient;
  // A line of its own for looking at Postgres, so watching never takes a line from what is being held.
  let monitor: PrismaClient;
  let hold: ReturnType<typeof heldLines>['hold'];

  beforeAll(async () => {
    app = await fx.listener();
    healthClient = (await import('../lib/prismaHealth.js')).prismaHealth();
    const { PrismaClient: Client } = await import('@prisma/client');
    // Options typed first, not inlined: an inline literal assigned to a `PrismaClient`-typed place costs ~39k types (~700k the first) and once ran CI's typecheck out of memory.
    const monitorOptions: Prisma.PrismaClientOptions = { datasources: { db: { url: process.env.TEST_DATABASE_URL! } } };
    monitor = new Client(monitorOptions);
    hold = heldLines(monitor).hold;
  }, 120_000);

  afterAll(async () => {
    await fx.cleanup();
    await db.$disconnect();
    await healthClient.$disconnect();
    await monitor.$disconnect();
  });

  /** True when the promise settles within `ms`. */
  async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
    return Promise.race([
      p.then(() => true, () => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
    ]);
  }

  it('/health answers 200 within 100 ms while every database line is held', async () => {
    await request(app).get('/health'); // warm the route: the claim is about the database, not about a cold start

    const jobs = await hold(db, 2, 3);
    const probe = await hold(healthClient, 1, 3);
    // The hold is real: a further statement on the users' pool is stuck behind it.
    const starved = db.$queryRaw`SELECT 1`;
    expect(await settlesWithin(starved, 300)).toBe(false);

    const started = performance.now();
    const res = await request(app).get('/health');
    const elapsed = performance.now() - started;
    process.stdout.write(`MEASURE /health with every line held: ${elapsed.toFixed(1)} ms\n`);

    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(100);

    await Promise.all([jobs.released, probe.released, starved]);
  });

  it('/health/deep says the database is fine when it answers', async () => {
    const res = await request(app).get('/health/deep');
    expect(res.status).toBe(200);
    expect(res.body.db).toBe('ok');
    expect(res.body.status).toBe('ok');
    expect(res.body.timestamp).toBeDefined();
  });

  it('/health/deep says the database is down when it cannot get a line within 2 s', async () => {
    const stuck = await hold(healthClient, 1, 4);

    const started = performance.now();
    const res = await request(app).get('/health/deep');
    const elapsed = performance.now() - started;
    process.stdout.write(`MEASURE /health/deep with its line held: ${res.status} after ${elapsed.toFixed(0)} ms\n`);

    expect(res.status).toBe(503);
    expect(res.body.db).toBe('error');
    // Given up at 2 s: not at once, and not after the 10 s a pool would wait by default.
    expect(elapsed).toBeGreaterThan(1900);
    expect(elapsed).toBeLessThan(3000);

    await stuck.released;
  });

  it('/health/deep does not depend on the users\' lines: it answers ok while every one of them is held', async () => {
    // Held longer than the 2 s budget, so a probe that had to wait for one of these lines would be reported down.
    const jobs = await hold(db, 2, 4);

    const res = await request(app).get('/health/deep');

    expect(res.status).toBe(200);
    expect(res.body.db).toBe('ok');
    await jobs.released;
  });

  /** The database restarting or a pooler recycling the line: Postgres ends every other session. */
  async function dropEveryLine() {
    await request(app).get('/health/deep'); // the line is open
    await terminateOtherSessionsInOwnDatabase(monitor);
    // The users' pool lost its lines too; let it notice here, so the next test finds it whole.
    for (let i = 0; i < 4; i++) await db.$queryRaw`SELECT 1`.catch(() => undefined);
  }

  it('/health/deep says the database is down, at once, when the database drops its line', async () => {
    await dropEveryLine();

    const started = performance.now();
    const res = await request(app).get('/health/deep');
    const elapsed = performance.now() - started;

    expect(res.status).toBe(503);
    expect(res.body.db).toBe('error');
    expect(elapsed).toBeLessThan(1000);
  });

  it('/health/deep leaves no armed timer behind after a fast answer', async () => {
    // The 2 s budget is a setTimeout the success path never waits for. Left armed it holds a ref on the event
    // loop, so every shutdown would stall up to 2 s. Count the live Timeout handles across the request.
    const armedTimers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

    const before = armedTimers();
    const res = await request(app).get('/health/deep');
    expect(res.status).toBe(200);
    expect(armedTimers()).toBe(before);
  });

  // Every entry point the ticket changed, in every state it can answer in. What a body may say is a short list,
  // not a hunt for bad words: the keys and their values are the whole of it, and the words are checked on top.
  describe.each([
    {
      name: '/health, loop free',
      path: '/health',
      status: 200,
      arrange: async () => () => undefined,
    },
    {
      name: '/health, loop blocked past the limit',
      path: '/health',
      status: 503,
      arrange: async () => {
        await new Promise((r) => setTimeout(r, 600));
        const until = Date.now() + 2500;
        while (Date.now() < until) {
          /* busy */
        }
        return () => undefined;
      },
    },
    {
      name: '/health/deep, database answering',
      path: '/health/deep',
      status: 200,
      arrange: async () => () => undefined,
    },
    {
      name: '/health/deep, database drops the line',
      path: '/health/deep',
      status: 503,
      arrange: async () => {
        await dropEveryLine();
        return () => undefined;
      },
    },
    {
      name: '/health/deep, database line held',
      path: '/health/deep',
      status: 503,
      arrange: async () => {
        const stuck = await hold(healthClient, 1, 3);
        return () => stuck.released;
      },
    },
  ])('$name', ({ path, status, arrange }) => {
    it('answers with the state and nothing else', async () => {
      // Let the lag reading of an earlier case clear before this one is asked.
      await new Promise((r) => setTimeout(r, 1000));
      const release = await arrange();
      const res = await request(app).get(path);
      await release();

      expect(res.status).toBe(status);
      // Only these keys, only these values: no message, host, version, address or stack can be in there.
      expect(Object.keys(res.body).sort()).toEqual(path === '/health' ? ['status', 'timestamp'] : ['db', 'status', 'timestamp']);
      expect(['ok', 'error']).toContain(res.body.status);
      if (path === '/health/deep') expect(['ok', 'error']).toContain(res.body.db);
      expect(new Date(res.body.timestamp).toISOString()).toBe(res.body.timestamp);
      // And in words: no vendor, no database detail, no address.
      expect(res.text).not.toMatch(/supabase|render|ctm|calltracking|stripe|prisma|postgres|pooler|sslmode|password|localhost|127\.0\.0\.1|\.com|P20\d\d|ECONN|stack|timed out|connection/i);
    });
  });

  // The night the lines are all taken: a company's staff are working, a job takes every line, the platform keeps
  // asking. It must see a live process (no restart), the deep check must name the database as down, and when the
  // job lets go, the staff member's request that was waiting is answered.
  it('journey: a job takes every line while staff work; the platform sees a live process and nobody is lost', async () => {
    const org = await fx.newOrg();
    const staff = await fx.signedInAs(org.admin);
    const before = await staff.get('/api/customers');
    expect(before.status).toBe(200);

    const jobs = await hold(db, 2, 3);
    const probe = await hold(healthClient, 1, 3);
    const waiting = staff.get('/api/customers').then((r) => r); // queued behind the job; .then() sends it

    const live = await request(app).get('/health');
    const deep = await request(app).get('/health/deep');
    expect(live.status).toBe(200);
    expect(deep.status).toBe(503);
    expect(deep.body.db).toBe('error');

    await Promise.all([jobs.released, probe.released]);
    const answered = await waiting;
    expect(answered.status).toBe(200);
    expect(JSON.stringify(answered.body)).toContain(org.customer);

    const after = await request(app).get('/health/deep');
    expect(after.status).toBe(200);
    expect(after.body.db).toBe('ok');
  });
});
