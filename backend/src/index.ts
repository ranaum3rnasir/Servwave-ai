import './instrument'; // MUST be first — initializes Sentry before any other module loads
import fs from 'node:fs';
import app from './app';
import { env } from './config/env';
import { logger } from './lib/logger';
import cron from 'node-cron';
import { runInvoiceDueChecks } from './services/notifications/invoiceDueCron';
import { runSpiderWatcherSweep } from './services/notifications/spiderWatcherCron';
import { runAutomationTick } from './services/automations/cron';
import { BeeService } from './services/bee/beeService';
import { runUnscoped } from './lib/tenant-context';
import { backfillStripeFlags } from './lib/backfill-stripe-flags';
import { sweepUncapturedFees } from './lib/reconcile-stripe-fees';

const server = app.listen(env.PORT, '0.0.0.0', () => {
  logger.info(`ServWave API running on port ${env.PORT}`);

  // Brain (text + tool calling) canary — reports which provider/model actually
  // serves /api/copilot/generate, plus whether the selected provider's credential is set.
  let brain: string;
  if (env.BRAIN_PROVIDER === 'codex') {
    const authPath = env.CODEX_AUTH_PATH?.trim() || `${process.env.HOME}/.codex/auth.json`;
    brain = fs.existsSync(authPath) ? `codex:${env.CODEX_MODEL}` : `codex (not configured — ${authPath} missing)`;
  } else if (env.BRAIN_PROVIDER === 'groq') {
    brain = env.GROQ_API_KEY ? `groq:${env.GROQ_MODEL}` : 'groq (not configured — GROQ_API_KEY missing)';
  } else {
    brain = env.GEMINI_API_KEY ? `gemini:${env.GEMINI_TEXT_MODEL}` : 'gemini (not configured — GEMINI_API_KEY missing)';
  }
  // Speech-to-text always runs on Gemini, independent of the brain choice.
  const stt = env.GEMINI_API_KEY ? 'gemini' : 'not configured (GEMINI_API_KEY missing)';
  logger.info(`Servy copilot: brain=${brain} · stt=${stt}`);
});

// Bound how long a single inbound request may hold a handler open. Node 20
// defaults (headersTimeout 60s / requestTimeout 300s) are generous for a 512MB
// single instance; tighten so a slow-loris / stalled body can't pin a worker
// (defense-in-depth for the F-16/F-17 amplification surfaces on the free plan).
server.headersTimeout = 20_000; // 20s to send all headers
server.requestTimeout = 30_000; // 30s for the whole request

// D16 (2026-07-21) — the internal estimate expiration cron is retired (release plan §R1);
// SENT estimates no longer auto-archive on a lapsed valid_until. See cron/estimate-expiration.ts
// (deleted) in git history if SRVW-53 revives a real expiry feature.

// Daily invoice overdue / due-soon check at 6 AM UTC
cron.schedule('0 6 * * *', () => {
  runUnscoped(() => runInvoiceDueChecks()).catch((err) =>
    logger.error('invoice due cron failed', err),
  );
});

// Automation Center poller — every minute: scans time-based triggers
// ("24h before job" etc.) and executes due / send-window-deferred runs.
// runAutomationTick never throws; the catch is belt-and-braces.
//
// NO runUnscoped here, unlike the two sweeps above and below: runAutomationTick opens its own
// cross-org bypass internally (see its docblock). It has to - a poller with no tenant context
// reads zero rows under the DB tenant guard and goes silently dead, which is precisely what
// happened when this line was a bare call, and index.ts boots a server so no test could see it.
cron.schedule('* * * * *', () => {
  runAutomationTick().catch((err) => logger.error('automation tick failed', err));
});

logger.info('Automation Center poller scheduled (every minute)');

// Spider AI Lead Watcher sweep — every 2 minutes: checks open leads against
// configured stage thresholds for active orgs (ARCH-1).
cron.schedule('*/2 * * * *', () => {
  runUnscoped(() => runSpiderWatcherSweep()).catch((err) =>
    logger.error('spider watcher sweep failed', err),
  );
});

logger.info('Spider AI Lead Watcher sweep scheduled (every 2 minutes)');

// Bee Outbound Voice Queue sweep — every 2 minutes: processes due warranty outbound calls
cron.schedule('*/2 * * * *', () => {
  runUnscoped(() => BeeService.processDueQueueItems()).catch((err) =>
    logger.error('Bee outbound queue poller failed', err),
  );
});

logger.info('Bee Outbound Voice Queue poller scheduled (every 2 minutes)');

// Boot-time recovery for interrupted in_progress Bee calls
void runUnscoped(() => BeeService.recoverStaleQueueItems())
  .then((r) => {
    if (r.recovered > 0) logger.info(`[boot] Bee queue: ${r.recovered} stale call(s) recovered`);
  })
  .catch((err) => logger.error('[boot] Bee queue recovery failed', err));

// Nightly Stripe fee reconciliation sweep (Task 3.3) — backfills any Payment whose
// stripe_balance_transaction_id never got captured at webhook time (e.g. the balance
// transaction hadn't settled yet when the webhook fired). Cross-org, so unscoped —
// mirrors runInvoiceDueChecks's wiring exactly. Pinned to UTC so "nightly" is a fixed
// wall clock rather than whatever TZ the container happens to have - observed staging
// timestamps for the 6 AM job alternate between 06:00 and 10:00 UTC across days, so the
// container TZ does flip. NOTE: that 6 AM job is documented as UTC but passes no
// timezone, so it has this same latent drift - a known gap, deliberately left for its
// own change rather than widened into this one.
cron.schedule('0 7 * * *', () => {
  runUnscoped(() => sweepUncapturedFees())
    .then((r) => logger.info(`Stripe fee sweep: ${r.swept} payment(s) backfilled`))
    .catch((err) => logger.error('Stripe fee sweep cron failed', err));
}, { timezone: 'UTC' });

// Deploy-time (boot) run of the same sweep. Idempotent + fire-and-forget: never blocks
// boot, never crashes it - a restart cannot otherwise accelerate recovery from a capture
// missed at webhook time, and a deploy landing between a payment write and its detached
// fee-capture call is exactly the case this repairs. Safe to run alongside the 07:00 UTC
// cron above - the sweep's where clause makes an already-captured row invisible to it.
void runUnscoped(() => sweepUncapturedFees())
  .then((r) => logger.info(`[boot] Stripe fee sweep: ${r.swept} payment(s) backfilled`))
  .catch((err) => logger.error('[boot] Stripe fee sweep failed', err));

// Deploy-time (boot) backfill of Stripe capability flags for orgs that already
// carry a stripe_account_id. Idempotent + fire-and-forget: never blocks boot,
// never crashes it — see lib/backfill-stripe-flags.ts for why this must run
// at boot (not lazily on first status fetch).
void backfillStripeFlags()
  .then((r) => logger.info('[boot] stripe backfill', r))
  .catch((err) => logger.error('[boot] stripe backfill failed', err));
