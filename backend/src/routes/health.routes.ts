import { Router } from 'express';
import { logger } from '../lib/logger';
import { prismaHealth } from '../lib/prismaHealth';
import { eventLoopWasBlocked, startEventLoopLagProbe } from '../lib/eventLoopLag';

const router = Router();

startEventLoopLagProbe();

// Is this process alive? Answered from memory: no database call, nothing that can queue behind a job. It fails only
// when the event loop was blocked for longer than the limit in lib/eventLoopLag.ts.
router.get('/', (_req, res) => {
  if (eventLoopWasBlocked()) {
    res.status(503).json({ status: 'error', timestamp: new Date().toISOString() });
    return;
  }
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Budget for the database probe. A stalled query is NOT the same failure as a rejected one: the probe once sat on
// its very first `SELECT 1` for 49s with neither a row nor an error, and an unbounded `await` turns that into a
// hang. 2s is far above a healthy ping and far below every deadline of the server (index.ts), so the answer always
// arrives in time to be read.
const HEALTH_DB_PROBE_TIMEOUT_MS = 2000;

// Can this process still get a line to the database, and does it answer? The probe runs on its own one-line client
// (lib/prismaHealth.ts), so what the users and the background jobs are doing with their lines cannot fail it, and it
// cannot take a line from them. Nothing here goes to the platform's restart check: that is /health.
router.get('/deep', async (_req, res) => {
  let probeTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Promise.resolve() adopts the PrismaPromise rather than assuming it is a native one.
    const probe = Promise.resolve(prismaHealth().$queryRaw`SELECT 1`);
    // Promise.race subscribes to BOTH entries, so a probe that rejects long after the timeout already won is still
    // a handled rejection, not an unhandled one.
    const timedOut = await Promise.race([
      probe.then(() => false),
      new Promise<boolean>((resolve) => {
        probeTimer = setTimeout(() => resolve(true), HEALTH_DB_PROBE_TIMEOUT_MS);
      }),
    ]);
    if (timedOut) {
      // Deliberately distinct from the reject message below: this line is the only evidence that separates "the
      // database said no" from "the database said nothing at all".
      logger.error(
        `Health check DB probe timed out after ${HEALTH_DB_PROBE_TIMEOUT_MS}ms: no line, no result and no error from the database`
      );
      res.status(503).json({ status: 'ok', db: 'error', timestamp: new Date().toISOString() });
      return;
    }
    res.json({ status: 'ok', db: 'ok', timestamp: new Date().toISOString() });
  } catch (err) {
    // The real cause goes to the log only; the body names the database state and nothing else.
    logger.error('Health check DB probe failed:', err);
    res.status(503).json({ status: 'ok', db: 'error', timestamp: new Date().toISOString() });
  } finally {
    // A fast success leaves the 2s timer armed, and an armed timer holds a ref on the event loop.
    clearTimeout(probeTimer);
  }
});

export default router;
