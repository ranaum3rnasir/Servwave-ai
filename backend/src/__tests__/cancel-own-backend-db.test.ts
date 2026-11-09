/* =============================================================================
   support/cancel-own-backend.ts cannot reach another database.

   A second database on the same server holds a session sleeping in the database; the helper is called on the suite's own database;
   the other session survives and its statement runs to its end. The helper does end a sleeper in its own database.
   Real migrated database (TEST_DATABASE_URL); skips when it is unset. The second database is created here and dropped here.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { cancelOtherStatementsInOwnDatabase, terminateOtherSessionsInOwnDatabase } from './support/cancel-own-backend';

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

suite('cancel-own-backend helper (real database)', () => {
  const ownUrl = process.env.TEST_DATABASE_URL!;
  const otherName = `t_cancel_other_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const urlFor = (name: string) => { const u = new URL(ownUrl); u.pathname = `/${name}`; return u.toString(); };
  let own: PrismaClient;
  let ownSecond: PrismaClient;
  let other: PrismaClient;
  let admin: PrismaClient;

  beforeAll(async () => {
    admin = new PrismaClient({ datasources: { db: { url: urlFor('postgres') } } });
    await admin.$executeRawUnsafe(`CREATE DATABASE "${otherName}"`);
    own = new PrismaClient({ datasources: { db: { url: ownUrl } } });
    ownSecond = new PrismaClient({ datasources: { db: { url: ownUrl } } });
    other = new PrismaClient({ datasources: { db: { url: urlFor(otherName) } } });
  }, 60_000);

  afterAll(async () => {
    await Promise.all([own?.$disconnect(), ownSecond?.$disconnect(), other?.$disconnect()]);
    await admin?.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${otherName}" WITH (FORCE)`);
    await admin?.$disconnect();
  });

  const sleeping = (client: PrismaClient, seconds: number) => client.$queryRaw`SELECT 1 FROM pg_sleep(${seconds})`.then(() => 'finished' as const, () => 'ended' as const);
  const startedIn = async (client: PrismaClient) => {
    for (let i = 0; i < 200; i++) {
      const [row] = await client.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND query LIKE '%pg_sleep%' AND query NOT LIKE '%pg_stat_activity%'`;
      if (Number(row!.n) > 0) return;
      await new Promise((r) => setImmediate(r));
    }
    throw new Error('the sleeping statement never showed in pg_stat_activity');
  };

  it('ends a sleeping statement in its own database', async () => {
    const victim = sleeping(ownSecond, 30);
    await startedIn(own);
    expect(await cancelOtherStatementsInOwnDatabase(own)).toBeGreaterThan(0);
    expect(await victim).toBe('ended');
  });

  it('leaves a session in another database alone: its statement runs to its end', async () => {
    const survivor = sleeping(other, 1);
    await startedIn(other);
    await cancelOtherStatementsInOwnDatabase(own);
    await terminateOtherSessionsInOwnDatabase(own);
    expect(await survivor).toBe('finished');
  });
});
