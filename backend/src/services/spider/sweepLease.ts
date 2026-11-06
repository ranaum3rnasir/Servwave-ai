/**
 * The Spider sweep's lease (#2993): at most one sweep run at a time across servers, without holding a transaction.
 *
 * A run claims the one row of spider_sweep_leases for the sweep: it inserts it, or takes it over when the row's
 * expires_at has passed (a run that was killed never gives its lease up; it just expires). While it works, a timer
 * renews expires_at; at the end the run deletes its own row. Each of these is a single statement on the app's shared
 * client, so the run pins no connection (the deployed pool holds one) and no transaction stays open.
 *
 * Expiry is judged by the database's clock alone (`now()`), so servers whose clocks differ still agree on it.
 *
 * Losing the lease: a renewal that no longer finds the row as this run's own and unexpired (another server took it
 * over, or it expired first) marks the lease lost. So does running out of confirmed time locally, when no renewal has
 * got through for long enough (a slow database, a busy process): `held()` turns false a margin before the last
 * confirmed expiry. Either way the run stops before its next step (sweep.ts checks `held()` before each company, each
 * per-lead alert and the starting summary). `held()` costs no query, so checking it per lead adds nothing to the
 * sweep's query count. The alert log's unique claim stays the last word against a double send.
 */
import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';

/** The sweep's row in spider_sweep_leases. */
export const SPIDER_SWEEP_LEASE = 'spider.sweep';

interface LeaseTiming {
  /** How long a claim or a renewal holds the lease. */
  ttlMs: number;
  /** How often a run renews while it works. */
  renewEveryMs: number;
}

/**
 * The sweep runs every 2 minutes. A lease of 2 minutes renewed every 30 s survives three missed renewals; a killed
 * run's lease frees up at most 2 minutes after its last renewal.
 */
const DEFAULT_TIMING: LeaseTiming = { ttlMs: 2 * 60_000, renewEveryMs: 30_000 };
let timing: LeaseTiming = { ...DEFAULT_TIMING };

/** Test-only: shorter lease times, so a case can outlast a lease in a second or two. No argument restores them. */
export function _setSweepLeaseTiming(t?: Partial<LeaseTiming>): void {
  timing = { ...DEFAULT_TIMING, ...t };
}

export interface SweepLease {
  /** This run's own id, written in the row. */
  readonly holder: string;
  /** True while this run still holds the lease. No query. Once false, stays false. */
  held(): boolean;
  /** Stops renewing and deletes the row if it is still this run's. Never throws. */
  release(): Promise<void>;
}

/** The lease for this run, or null while a live run (on any server) holds it. Throws only when the database does. */
export async function claimSweepLease(): Promise<SweepLease | null> {
  const holder = randomUUID();
  const { ttlMs, renewEveryMs } = timing;
  // Each confirmed expiry is counted from just BEFORE its statement was sent: the database set it later than that, so
  // this run's idea of its expiry is never later than the database's.
  const sentAt = performance.now();
  const rows = await prisma.$queryRaw<{ claimed: boolean }[]>`
    INSERT INTO spider_sweep_leases (name, holder, claimed_at, expires_at)
    VALUES (${SPIDER_SWEEP_LEASE}, ${holder}, now(), now() + ${interval(ttlMs)})
    ON CONFLICT (name) DO UPDATE
      SET holder = EXCLUDED.holder, claimed_at = EXCLUDED.claimed_at, expires_at = EXCLUDED.expires_at
      WHERE spider_sweep_leases.expires_at <= now()
    RETURNING true AS claimed`;
  if (rows.length === 0) return null;

  let validUntil = sentAt + ttlMs;
  // Stop a quarter of the lease before the confirmed expiry: room for the step already under way to finish.
  const marginMs = ttlMs / 4;
  let lost = false;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let renewing: Promise<void> | undefined;

  const markLost = (why: string) => {
    if (lost) return;
    lost = true;
    logger.warn(`[spider] sweep lease lost (${why}) - this run stops before its next step`);
  };

  const renew = async () => {
    const sent = performance.now();
    try {
      const n = await prisma.$executeRaw`
        UPDATE spider_sweep_leases SET expires_at = now() + ${interval(ttlMs)}
        WHERE name = ${SPIDER_SWEEP_LEASE} AND holder = ${holder} AND expires_at > now()`;
      if (n === 0) markLost('it expired or another server took it over');
      else validUntil = sent + ttlMs;
    } catch (err) {
      // Not lost yet: the last confirmed expiry still stands, and held() runs out on its own if no renewal gets through.
      logger.error(`[spider] could not renew the sweep lease: ${errorName(err)}`);
    }
  };

  const schedule = () => {
    if (stopped || lost) return;
    timer = setTimeout(() => {
      renewing = renew().finally(() => {
        renewing = undefined;
        schedule();
      });
    }, renewEveryMs);
    timer.unref?.();
  };
  schedule();

  return {
    holder,
    held() {
      if (!lost && performance.now() >= validUntil - marginMs) markLost('no renewal got through in time');
      return !lost;
    },
    async release() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await renewing;
      try {
        // Only this run's own row: a lease another server has taken over is left alone.
        await prisma.$executeRaw`DELETE FROM spider_sweep_leases WHERE name = ${SPIDER_SWEEP_LEASE} AND holder = ${holder}`;
      } catch (err) {
        // The row expires on its own.
        logger.error(`[spider] could not release the sweep lease: ${errorName(err)}`);
      }
    },
  };
}

/** A whole number of milliseconds as a Postgres interval, sent as a parameter. */
function interval(ms: number): Prisma.Sql {
  return Prisma.sql`make_interval(secs => ${Math.round(ms) / 1000}::double precision)`;
}

/** An error's class name only - never its message, which can carry the values it failed on. */
function errorName(err: unknown): string {
  if (err instanceof Prisma.PrismaClientKnownRequestError) return `${err.name} ${err.code}`;
  return err instanceof Error ? err.name : 'unknown error';
}
