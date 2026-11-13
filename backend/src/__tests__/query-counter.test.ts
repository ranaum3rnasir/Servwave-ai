import { describe, it, expect } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { countQueries, reads, writes, type CountedQuery } from './support/query-counter';

const q = (sql: string): CountedQuery => ({ sql, params: '[]' });
const log = [
  q('BEGIN'),
  q("SELECT set_config('app.current_org_id', $1, true)"),
  q('SELECT "public"."leads"."id" FROM "public"."leads" WHERE 1=1'),
  q('SELECT "public"."customers"."id" FROM "public"."customers"'),
  q('INSERT INTO "public"."timeline_events" ("id") VALUES ($1)'),
  q('UPDATE "public"."leads" SET "status" = $1'),
  q('DELETE FROM spider_alerts WHERE id = $1'),
  q('COMMIT'),
];

describe('query counter filters', () => {
  it('writes() keeps only INSERT, UPDATE and DELETE, optionally for given tables', () => {
    expect(writes(log)).toHaveLength(3);
    expect(writes(log, ['leads'])).toHaveLength(1);
    expect(writes(log, ['spider_alerts', 'timeline_events'])).toHaveLength(2);
  });

  it('reads() keeps only SELECTs, never the set_config one, optionally for given tables', () => {
    expect(reads(log)).toHaveLength(2);
    expect(reads(log, ['customers'])).toHaveLength(1);
    expect(reads(log, ['lead'])).toHaveLength(0); // whole table names, not prefixes
  });
});

/* A stand-in for a Prisma client whose query events arrive LATE: every query resolves at once, and its event is
   delivered LATE_MS later, in the order the queries ran (timers of one delay fire in the order they were set). That
   is the real engine's shape under load, made certain, so these tests fail on a broken counter every time, not only
   on a busy machine. `wrap` shares the client's event channel the way the tenant-guard wrap does, and runs each query
   in its own BEGIN ... COMMIT. */
const LATE_MS = 5;

type Listener = (e: { query: string; params: string }) => void;

function fakeClient({ silent = false } = {}) {
  const listeners: Listener[] = [];
  const send = (sql: string) => {
    if (silent) return;
    setTimeout(() => { for (const l of listeners) l({ query: sql, params: '[]' }); }, LATE_MS);
  };
  const client = {
    _engineConfig: { logEmitter: {} },
    $on: (_event: 'query', cb: Listener) => { listeners.push(cb); return client; },
    $extends: () => client, // as on the guard wrap, $extends hands back the real client
    $queryRawUnsafe: async (sql: string) => { send(sql); return []; },
    query: async (sql: string) => { send(sql); },
  };
  const wrap = Object.assign(Object.create(client) as typeof client, {
    query: async (sql: string) => { send('BEGIN'); send(sql); send('COMMIT'); },
  });
  return { client, wrap, as: (c: typeof client) => c as unknown as PrismaClient };
}

const sqls = (r: { queries: CountedQuery[] }) => r.queries.map((x) => x.sql);

describe('countQueries when events arrive after their queries resolve', () => {
  it('counts parallel queries exactly, every time', async () => {
    const { client, as } = fakeClient();
    const counts: number[] = [];
    for (let i = 0; i < 40; i++) {
      const r = await countQueries(
        () => Promise.all(Array.from({ length: 24 }, (_, n) => client.query(`SELECT ${n + 10}`))),
        as(client),
      );
      counts.push(r.count);
    }
    expect(counts).toEqual(Array(40).fill(24));
  });

  it('does not count a query that ran just before the count, whose event arrives after the count began', async () => {
    const { client, as } = fakeClient();
    await client.query('SELECT before');
    const r = await countQueries(() => client.query('SELECT inside'), as(client));
    expect(sqls(r)).toEqual(['SELECT inside']);
  });

  it("never counts the engine's own connection check (a bare SELECT 1), wherever it falls in the count", async () => {
    const { client, as } = fakeClient();
    const r = await countQueries(async () => {
      await client.query('SELECT 1');
      await client.query('SELECT 2');
      await client.query('SELECT 1');
      await client.query('SELECT 3');
      await client.query('  SELECT 1  ');
    }, as(client));
    expect(sqls(r)).toEqual(['SELECT 2', 'SELECT 3']);
    // A statement that merely starts like it is the code's own and is counted.
    const own = await countQueries(() => client.query('SELECT 1 FROM leads'), as(client));
    expect(sqls(own)).toEqual(['SELECT 1 FROM leads']);
  });

  it('never counts its own marker queries', async () => {
    const { client, as } = fakeClient();
    expect((await countQueries(async () => undefined, as(client))).count).toBe(0);
    const r = await countQueries(() => client.query('SELECT 7'), as(client));
    expect(sqls(r)).toEqual(['SELECT 7']);
  });

  it('refuses a count inside another count, and the outer count keeps every query before and after it', async () => {
    const { client, as } = fakeClient();
    const outer = await countQueries(async () => {
      await client.query('SELECT a');
      await expect(countQueries(() => client.query('SELECT x'), as(client))).rejects.toThrow(/inside another count/);
      // Two inner counts side by side would see each other's queries: both are refused.
      const both = await Promise.allSettled([
        countQueries(() => client.query('SELECT y'), as(client)),
        countQueries(() => client.query('SELECT z'), as(client)),
      ]);
      expect(both.map((s) => s.status)).toEqual(['rejected', 'rejected']);
      await client.query('BEGIN');
      await client.query('SELECT b');
      await client.query('COMMIT');
    }, as(client));
    expect(sqls(outer)).toEqual(['SELECT a', 'BEGIN', 'SELECT b', 'COMMIT']);
  });

  it('refuses a count on the tenant-guard wrap inside a count on its client (one event channel)', async () => {
    const { client, wrap, as } = fakeClient();
    const outer = await countQueries(async () => {
      await expect(countQueries(() => wrap.query('SELECT w'), as(wrap))).rejects.toThrow(/inside another count/);
      await client.query('SELECT a');
    }, as(client));
    expect(sqls(outer)).toEqual(['SELECT a']);
  });

  it('runs counts on a client and on its wrap one after the other, each with only its own queries', async () => {
    const { client, wrap, as } = fakeClient();
    const [plain, guarded] = await Promise.all([
      countQueries(async () => { await client.query('SELECT a'); await client.query('SELECT b'); }, as(client)),
      countQueries(() => wrap.query('SELECT w'), as(wrap)),
    ]);
    expect(sqls(plain)).toEqual(['SELECT a', 'SELECT b']);
    expect(sqls(guarded)).toEqual(['BEGIN', 'SELECT w', 'COMMIT']);
  });

  it('refuses, within a few seconds, a client that emits no query events, instead of answering zero', async () => {
    const { client, as } = fakeClient({ silent: true });
    const t0 = Date.now();
    await expect(countQueries(() => client.query('SELECT 1'), as(client))).rejects.toThrow(/emits no query events/);
    expect(Date.now() - t0).toBeLessThan(3_000);
  });
});
