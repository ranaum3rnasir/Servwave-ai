/* =============================================================================
   Test helper: end the OTHER sessions of the database the client is connected to.

   This is the only place in test code that may name a backend cancel or terminate (real-db-test-waits-guard.test.ts fails any
   other file). The statements are fixed text and cannot be widened by a caller: they act on sessions of `current_database()`
   only, never on the caller's own session, so another lane's database (another database on the same server) is out of reach.
   cancel-own-backend-db.test.ts proves it against a second database.
   ========================================================================== */

import type { PrismaClient } from '@prisma/client';

/** Ends the running statement of every other session of this client's database; the sessions stay connected. Returns how many were signalled. */
export async function cancelOtherStatementsInOwnDatabase(client: PrismaClient): Promise<number> {
  const rows = await client.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM (SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()) AS signalled`;
  return Number(rows[0]!.n);
}

/** Drops every other session of this client's database. Returns how many were signalled. */
export async function terminateOtherSessionsInOwnDatabase(client: PrismaClient): Promise<number> {
  const rows = await client.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM (SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()) AS signalled`;
  return Number(rows[0]!.n);
}

/**
 * The statement that drops the sessions of the current database that are OLDER than a moment (milliseconds since the epoch),
 * never the caller's own: for a caller that has no Prisma client, only a psql session (the Database check's lane setup, which
 * ends the leftovers of the file that used the lane before without touching what the new file opened itself). Fixed text apart from
 * the number.
 */
export function terminateOtherSessionsOlderThanSql(startedAtMs: number): string {
  if (!Number.isFinite(startedAtMs)) throw new Error('terminateOtherSessionsOlderThanSql: startedAtMs must be a number');
  return `SELECT count(*) AS n FROM (SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_start < to_timestamp(${(startedAtMs / 1000).toFixed(3)})) AS signalled`;
}
