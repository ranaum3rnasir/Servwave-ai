/* =============================================================================
   The query counter (support/query-counter.ts), run on the SHARED client of lib/prisma.ts and on the tenant-guard
   wrap, against a real migrated database. It is the example the Spider efficiency tickets copy: a code path that must
   run the same number of queries for 3 leads as for 30 counts its queries with countQueries.

   Skips when TEST_DATABASE_URL is unset. Reads and writes nothing that stays: the one UPDATE matches no row.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const url = process.env.TEST_DATABASE_URL;
// lib/prisma.ts reads DATABASE_URL when it is first imported; setup.ts has mocked that module, so take the real one.
if (url) process.env.DATABASE_URL = url;

import { countQueries, reads, writes } from './support/query-counter';

const suite = url ? describe : describe.skip;
const NO_SUCH_ORG = '00000000-0000-0000-0000-00000000dead';

suite('countQueries on the shared client (real database)', () => {
  let prisma: PrismaClient;
  let wrapWithTenantGuard: typeof import('../lib/tenant-guard.js').wrapWithTenantGuard;
  const countOrgs = () => prisma.organization.count();

  beforeAll(async () => {
    ({ prisma } = await vi.importActual<typeof import('../lib/prisma')>('../lib/prisma'));
    ({ wrapWithTenantGuard } = await import('../lib/tenant-guard.js'));
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('counts a plain query once, with its SQL', async () => {
    const { count, queries } = await countQueries(countOrgs, prisma);
    expect(count).toBe(1);
    expect(queries[0].sql).toMatch(/SELECT/i);
    expect(queries[0].sql).toMatch(/organizations/);
  });

  it('counts the queries inside an interactive transaction, BEGIN and COMMIT included', async () => {
    const { count, queries } = await countQueries(() =>
      prisma.$transaction(async (tx) => {
        await tx.organization.count();
        await tx.organization.count();
        await tx.$executeRawUnsafe('UPDATE organizations SET name = name WHERE id = $1::uuid', NO_SUCH_ORG);
      }),
    prisma);
    expect(count).toBe(5);
    expect(reads(queries, ['organizations'])).toHaveLength(2);
    expect(writes(queries, ['organizations'])).toHaveLength(1);
    expect(writes(queries, ['leads'])).toHaveLength(0);
  });

  it('counts the same each time and leaves no listener running between counts', async () => {
    const first = await countQueries(countOrgs, prisma);
    await countOrgs(); // outside a count: must not be added to anything
    const second = await countQueries(countOrgs, prisma);
    expect(second.count).toBe(first.count);
    expect(second.queries).toHaveLength(1);
  });

  it('refuses a count inside another count, and the outer count still holds every query before and after it', async () => {
    const outer = await countQueries(async () => {
      await countOrgs();
      await expect(countQueries(countOrgs, prisma)).rejects.toThrow(/inside another count/);
      await prisma.$transaction(async (tx) => { await tx.organization.count(); });
    }, prisma);
    // the SELECT, then BEGIN, the SELECT, COMMIT
    expect(outer.queries.map((q) => q.sql.split(' ')[0])).toEqual(['SELECT', 'BEGIN', 'SELECT', 'COMMIT']);
  });

  it('refuses a count started first thing inside an interactive transaction that is being counted', async () => {
    const outer = await countQueries(() =>
      prisma.$transaction(async (tx) => {
        await expect(countQueries(async () => undefined, prisma)).rejects.toThrow(/inside another count/);
        await tx.organization.count();
      }),
    prisma);
    expect(outer.count).toBe(3); // BEGIN, the SELECT, COMMIT
  });

  it('treats the tenant-guard wrap and its client as one: a count on one inside a count on the other is refused', async () => {
    const guarded = wrapWithTenantGuard(prisma);
    const outer = await countQueries(async () => {
      await expect(countQueries(() => guarded.organization.count(), guarded)).rejects.toThrow(/inside another count/);
      await countOrgs();
    }, prisma);
    expect(outer.count).toBe(1);
  });

  it('runs counts on the client and its tenant-guard wrap one after the other, with one listener', async () => {
    const guarded = wrapWithTenantGuard(prisma);
    const [plain, wrapped] = await Promise.all([
      countQueries(async () => { await countOrgs(); await countOrgs(); }, prisma),
      countQueries(() => guarded.organization.count(), guarded),
    ]);
    expect(plain.count).toBe(2);
    expect(wrapped.count).toBe(4); // BEGIN, set_config, the SELECT, COMMIT
    const emitter = (prisma as unknown as { _engineConfig: { logEmitter: { listenerCount(e: string): number } } })
      ._engineConfig.logEmitter;
    expect(emitter.listenerCount('query')).toBe(1);
  });

  it('runs two counts started together one after the other, each with its own queries', async () => {
    const [a, b] = await Promise.all([
      countQueries(async () => { await countOrgs(); await countOrgs(); }, prisma),
      countQueries(countOrgs, prisma),
    ]);
    expect(a.count).toBe(2);
    expect(b.count).toBe(1);
  });

  it('counts parallel queries exactly, every time, even when their events arrive late', async () => {
    const counts: number[] = [];
    for (let i = 0; i < 40; i++) {
      const r = await countQueries(() => Promise.all(Array.from({ length: 24 }, () => countOrgs())), prisma);
      counts.push(r.count);
    }
    expect(counts).toEqual(Array(40).fill(24));
    expect(await countQueries(countOrgs, prisma).then((r) => r.count)).toBe(1);
  });

  it('stops listening and rethrows when the block throws', async () => {
    await expect(countQueries(async () => { await countOrgs(); throw new Error('boom'); }, prisma)).rejects.toThrow('boom');
    const after = await countQueries(countOrgs, prisma);
    expect(after.count).toBe(1);
  });

  it('counts the tenant guard wrap: its set_config and a transaction per operation', async () => {
    const guarded = wrapWithTenantGuard(prisma);
    const { count, queries } = await countQueries(() => guarded.organization.count(), guarded);
    // BEGIN, set_config, the SELECT, COMMIT; the markers skip the guard, so none of theirs is here
    expect(queries.map((q) => q.sql.split(' ')[0])).toEqual(['BEGIN', 'SELECT', 'SELECT', 'COMMIT']);
    expect(count).toBe(4);
    expect(reads(queries)).toHaveLength(1);
  });

  it('refuses a client that emits no query events instead of answering zero', async () => {
    const { PrismaClient: Plain } = await import('@prisma/client');
    const quiet = new Plain({ datasources: { db: { url: url! } } });
    try {
      await expect(countQueries(() => quiet.organization.count(), quiet)).rejects.toThrow(/emits no query events/);
    } finally {
      await quiet.$disconnect();
    }
  });
});
