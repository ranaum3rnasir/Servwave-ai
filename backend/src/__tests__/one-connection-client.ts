/* =============================================================================
   Test helper (not a test file): a Prisma client with the hosted database's pool.

   The deployed DATABASE_URL goes through a pooler with connection_limit=1 (at most a few). Local and CI URLs carry 5,
   which hides a whole class of defect: `prisma.$transaction(async (tx) => ...)` holds one pooled connection for the
   life of the callback, and a query on the GLOBAL client made inside it (directly, or by a helper the callback calls)
   needs a second one. With none free it waits out the pool timeout (Prisma P2024) and takes the transaction down.

   A suite that hands this client to `vi.mock('../lib/prisma', ...)` runs the real app on that pool, so such a query
   fails in seconds instead of passing locally and failing on the hosted database. The pool timeout is kept short for
   the same reason: a regression should fail the case that caused it, quickly.

   It is loaded from `vi.hoisted(async () => ...)` because the mock factory runs before the file's imports:

     const clientPromise = vi.hoisted(async () => {
       const { oneConnectionClient } = await import('./one-connection-client.js');
       return oneConnectionClient(process.env.TEST_DATABASE_URL);
     });
     vi.mock('../lib/prisma', async () => ({ prisma: await clientPromise }));
     // the suite then reads the same client with `await clientPromise` in its beforeAll
   ========================================================================== */

import type { PrismaClient } from '@prisma/client';
import { QUERY_EVENT_LOG } from './support/query-counter';

/** Seconds a query waits for a free connection before it fails (the hosted default is 10). */
export const SHORT_POOL_TIMEOUT_SECONDS = 4;

/** A client on `url` holding one connection, or undefined when there is no database (the suite then skips). */
export async function oneConnectionClient(url: string | undefined): Promise<PrismaClient | undefined> {
  if (!url) return undefined;
  const { PrismaClient } = await import('@prisma/client');
  const pooled = new URL(url);
  pooled.searchParams.set('connection_limit', '1');
  pooled.searchParams.set('pool_timeout', String(SHORT_POOL_TIMEOUT_SECONDS));
  return new PrismaClient({ datasources: { db: { url: pooled.toString() } }, log: QUERY_EVENT_LOG });
}
