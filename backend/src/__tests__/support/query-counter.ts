/* =============================================================================
   Test helper (not a test file): count the SQL queries a block of code runs.

     const { count, queries } = await countQueries(async () => { await runSpiderSweep(now); });
     expect(count).toBe(countFor3Leads);                      // every statement, BEGIN/COMMIT included
     expect(writes(queries).length).toBe(...);                 // only INSERT / UPDATE / DELETE
     expect(reads(queries, ['leads']).length).toBe(...);       // only SELECTs that mention the table

   It counts what the client REALLY sends: queries inside interactive transactions, the transaction's BEGIN and
   COMMIT, raw queries, and the tenant guard's set_config. A count that ignored any of them could not tell a sweep that
   runs one query per lead from one that runs a fixed number.

   WHICH CLIENT: the default is the one `lib/prisma` exports, read at call time, so a suite that mocks `lib/prisma`
   with its own client counts that client, the one the code under test uses. Pass a client as the second argument to
   count another. Prisma delivers query events only to a client built with an event log (a test cannot add it later,
   and `$on('query')` on any other client silently does nothing). Two ways to get one:
     - the shared client: `PRISMA_QUERY_EVENTS=on` makes `lib/prisma.ts` add the event log. `setup.ts` sets it for every
       backend test; production ignores it (see lib/prisma.ts).
     - a client the test builds: give it `log: QUERY_EVENT_LOG` (`one-connection-client.ts` does).
   A client without the log fails fast with a message, never with a zero.

   WHERE A COUNT STARTS AND ENDS: a query's event can reach the listener AFTER the query has resolved (under load,
   with parallel queries, by several events). So neither "the block began" nor "the block returned" can bound a count.
   Instead each count sends a marker query, `SELECT '<marker>'`, before the block and another after it, and keeps
   exactly the events that arrive between the two markers' own events. Events arrive in the order the engine ran the
   statements, so that is exactly the block's queries: a late event of an earlier query lands before the start marker,
   and every event of the block lands before the end marker. Markers are never counted. They skip the tenant guard
   (they go through `$extends({})`, which the guard hands to the real client), so no BEGIN / set_config / COMMIT of a
   marker exists to be counted either.

   ONE COUNT AT A TIME PER DATABASE CLIENT:
     - Events carry no caller identity, so two counts at once on one client cannot be told apart. Counts are keyed by
       the client's event channel, which a client and its tenant-guard wrap share (one engine), and separate calls on
       one channel run one after another, in call order.
     - A count INSIDE another count's block on the same channel is refused with an error: count each part on its own.
       (Two inner counts running side by side would see each other's queries, a wrong number with no error.) A count
       on a different client inside a block is fine.
     - Prisma 6 cannot remove a `$on` listener, so each channel gets exactly ONE listener, ever. It does nothing while
       no count is running. Counting twice in one file adds no listener.
     - Anything else sending queries on the client while a count runs (a background timer, a parallel test in the same
       process) is counted too. Keep the block self-contained, and run DB files one at a time as CI does.
   ========================================================================== */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Prisma, PrismaClient } from '@prisma/client';

/** `log` for a client a test builds itself, so `$on('query')` works on it. */
export const QUERY_EVENT_LOG: Prisma.LogDefinition[] = [{ emit: 'event', level: 'query' }];

export interface CountedQuery {
  /** The SQL text as Prisma sent it (parameters are placeholders). */
  sql: string;
  /** The parameters, as Prisma reports them (a JSON string). */
  params: string;
}

export interface QueryCount {
  /** Every statement, transaction BEGIN/COMMIT and the tenant guard's set_config included. */
  count: number;
  queries: CountedQuery[];
}

type Sink = (query: CountedQuery) => void;
type QueryEvent = { query: string; params: string };
/** The parts of a Prisma client the counter uses. */
type Countable = {
  $on: (event: 'query', cb: (e: QueryEvent) => void) => unknown;
  $extends: (extension: object) => { $queryRawUnsafe: (sql: string) => Promise<unknown> };
  _engineConfig?: { logEmitter?: object };
};

interface Channel {
  sinks: Set<Sink>;
  /** The last count queued on this channel; the next one starts after it. */
  tail: Promise<unknown>;
}

const channels = new WeakMap<object, Channel>();
/** Set while a block runs: the channels being counted in this async context, so a nested count can be refused. */
const inside = new AsyncLocalStorage<Set<object>>();

/** Where a client's query events go: `$on` registers on the engine's log emitter, which a client and its tenant-guard
 *  wrap share. (A test double without that internal is its own channel.) */
function channelOf(client: Countable): object {
  return client._engineConfig?.logEmitter ?? client;
}

function channelFor(client: Countable, key: object): Channel {
  let channel = channels.get(key);
  if (!channel) {
    const sinks = new Set<Sink>();
    client.$on('query', (e) => {
      for (const sink of sinks) sink({ sql: e.query, params: e.params });
    });
    channel = { sinks, tail: Promise.resolve() };
    channels.set(key, channel);
  }
  return channel;
}

async function defaultClient(): Promise<PrismaClient> {
  const { prisma } = await import('../../lib/prisma.js');
  return prisma;
}

const MARK = 'countQueries-marker-';
let markSeq = 0;
/** How long a marker's event may take. Real lag is milliseconds; no event at all means the client emits none. */
const MARKER_WAIT_MS = 2_000;

const SILENT =
  'countQueries: this client emits no query events. Build it with `log: QUERY_EVENT_LOG`, or for the shared client ' +
  'run with PRISMA_QUERY_EVENTS=on (setup.ts sets it) before lib/prisma is first imported.';
const LOST = 'countQueries: the end-of-count marker query sent no event, so the count is unknown.';

/** One count: keeps the events strictly between its own start marker's event and its own end marker's event. */
function recorder() {
  const id = `${MARK}${++markSeq}-${Math.random().toString(36).slice(2, 10)}`;
  const startTag = `'${id}-start'`;
  const endTag = `'${id}-end'`;
  const queries: CountedQuery[] = [];
  let phase: 'before' | 'counting' | 'done' = 'before';
  let markStarted: () => void = () => undefined;
  let markEnded: () => void = () => undefined;
  const started = new Promise<void>((r) => { markStarted = r; });
  const ended = new Promise<void>((r) => { markEnded = r; });

  const sink: Sink = (q) => {
    if (q.sql.includes(MARK)) {
      // A marker is never counted; only this count's own two move it on.
      if (phase === 'before' && q.sql.includes(startTag)) { phase = 'counting'; markStarted(); }
      else if (phase === 'counting' && q.sql.includes(endTag)) { phase = 'done'; markEnded(); }
      return;
    }
    if (phase === 'counting') queries.push(q);
  };

  async function send(client: Countable, tag: string, arrived: Promise<void>, failure: string): Promise<void> {
    // `$extends({})` is the real client even on a tenant-guard wrap, so the marker is ONE plain statement.
    await client.$extends({}).$queryRawUnsafe(`SELECT ${tag}`);
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(failure)), MARKER_WAIT_MS);
    });
    try {
      await Promise.race([arrived, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    queries,
    sink,
    begin: (client: Countable) => send(client, startTag, started, SILENT),
    finish: (client: Countable) => send(client, endTag, ended, LOST),
  };
}

async function run<T>(client: Countable, key: object, fn: () => Promise<T>): Promise<QueryCount & { result: T }> {
  const { sinks } = channelFor(client, key);
  const rec = recorder();
  sinks.add(rec.sink);
  try {
    await rec.begin(client);
    const result = await inside.run(new Set([...(inside.getStore() ?? []), key]), fn);
    await rec.finish(client);
    return { count: rec.queries.length, queries: rec.queries, result };
  } finally {
    sinks.delete(rec.sink);
  }
}

/**
 * Run `fn` and return how many queries the client sent meanwhile, with their SQL.
 * `result` is what `fn` returned. If `fn` throws, the error propagates and nothing is left listening.
 * Called inside another count's block on the same client (or its tenant-guard wrap), it rejects instead.
 */
export async function countQueries<T = void>(
  fn: () => Promise<T>,
  client?: PrismaClient,
): Promise<QueryCount & { result: T }> {
  const target = (client ?? (await defaultClient())) as unknown as Countable;
  const key = channelOf(target);
  if (inside.getStore()?.has(key)) {
    throw new Error(
      'countQueries: a count cannot run inside another count on the same database client (or its tenant-guard ' +
        'wrap). Count each part on its own.',
    );
  }
  const channel = channelFor(target, key);
  const mine = channel.tail.then(() => run(target, key, fn));
  channel.tail = mine.catch(() => undefined);
  return mine;
}

const WRITE = /^\s*(INSERT|UPDATE|DELETE)\b/i;
const READ = /^\s*(SELECT|WITH)\b/i;

/** Only the INSERT / UPDATE / DELETE statements. */
export function writes(queries: CountedQuery[], tables?: string[]): CountedQuery[] {
  return queries.filter((q) => WRITE.test(q.sql) && mentions(q.sql, tables));
}

/** Only the SELECT statements (the tenant guard's set_config SELECT is left out). */
export function reads(queries: CountedQuery[], tables?: string[]): CountedQuery[] {
  return queries.filter((q) => READ.test(q.sql) && !/set_config\(/i.test(q.sql) && mentions(q.sql, tables));
}

/** Prisma quotes names as "public"."leads"; a raw query may not. Matches the bare table name as a whole word. */
function mentions(sql: string, tables?: string[]): boolean {
  if (!tables || tables.length === 0) return true;
  return tables.some((t) => new RegExp(`(^|[^\\w])"?${t}"?([^\\w]|$)`, 'i').test(sql));
}
