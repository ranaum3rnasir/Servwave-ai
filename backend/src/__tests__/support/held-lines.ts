/* =============================================================================
   Hold database lines busy, for suites that need "every line is taken" to be true rather than assumed.

   `hold` runs `lines` statements that sit inside Postgres (pg_sleep) on `client`, the way a stuck job would, and
   resolves only once Postgres itself shows them running, seen from the monitor client's own line (so watching never
   takes a line from what is being held). `released` settles when they are let go.
   ========================================================================== */

import type { PrismaClient } from '@prisma/client';

const SLEEP_STATEMENT = 'SELECT 1 FROM pg_sleep';

export function heldLines(monitor: PrismaClient) {
  /** How many connections to this database are inside a pg_sleep right now. */
  async function sleepersNow(): Promise<number> {
    const rows = await monitor.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_stat_activity
      WHERE datname = current_database() AND state = 'active' AND query LIKE ${SLEEP_STATEMENT + '%'}`;
    return Number(rows[0]!.n);
  }

  async function hold(client: PrismaClient, lines: number, seconds: number) {
    const before = await sleepersNow();
    const released = Promise.all(
      Array.from({ length: lines }, () => client.$queryRaw`SELECT 1 FROM pg_sleep(${seconds})`),
    );
    const deadline = Date.now() + 5000;
    while ((await sleepersNow()) < before + lines) {
      if (Date.now() > deadline) throw new Error('the lines never became busy');
      await new Promise((r) => setTimeout(r, 20));
    }
    return { released };
  }

  return { hold, sleepersNow };
}
