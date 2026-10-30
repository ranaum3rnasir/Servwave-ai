import './instrument'; // MUST be first — initializes Sentry before any other module loads
import fs from 'node:fs';
import app from './app';
import { env } from './config/env';
import { logger } from './lib/logger';
import cron from 'node-cron';
import { runInvoiceDueChecks } from './services/notifications/invoiceDueCron';
import { runAutomationTick } from './services/automations/cron';
import { runUnscoped } from './lib/tenant-context';
import { refreshAllAccountStatuses } from './lib/account-status';
import { sweepUncapturedFees } from './lib/reconcile-stripe-fees';
import { runNightlyReconcile } from './services/payment-reconcile';
import { runSpiderSweep } from './services/spider/sweep';
import { sweepReceivedAttachments } from './lib/inbound-attachments';

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
cron.schedule('* * * * *', () => {
  runAutomationTick().catch((err) => logger.error('automation tick failed', err));
});

logger.info('Automation Center poller scheduled (every minute)');

// Spider lead watcher sweep (#2619) — every 2 minutes. Unscoped at the top, then scoped per
// company inside; one instance across servers (advisory lock) and never two overlapping runs.
// runSpiderSweep never throws; the catch is belt-and-braces.
cron.schedule('*/2 * * * *', () => {
  runSpiderSweep().catch((err) => logger.error('spider sweep failed', err));
});

// Received-mail attachments (PRD 10, S10.17) — every 10 minutes: received messages whose files were still on their way after the
// first try (the provider was unreachable, the process stopped mid-way) are tried again, a fixed number of times each. Cross-company,
// so unscoped at the top. sweepReceivedAttachments never throws and never runs twice at once; the catch is belt-and-braces.
cron.schedule('*/10 * * * *', () => {
  runUnscoped(() => sweepReceivedAttachments()).catch((err) => logger.error('received attachments sweep failed', err));
});

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

// Nightly payment reconcile against the processor (payments go-live slice 37). Runs after the fee
// sweep (07:00) and the account-status refresh (07:30), at 08:07 rather than 08:00 so it does not
// start in the same second as the hourly and per-minute jobs (staging's pool has one connection).
// Listing the orgs is the only cross-org read (unscoped, like the crons above); each org is then
// compared in its own tenant context, and one org failing never stops the rest. Drift is alerted by an ops email and a log line per finding.
cron.schedule('7 8 * * *', () => {
  runUnscoped(() => runNightlyReconcile())
    .then((r) => logger.info(`Payment reconcile: ${r.orgs.length} org(s) checked, ${r.driftCount} difference(s), ${r.errorCount} not checked`))
    .catch((err) => logger.error('Payment reconcile cron failed', err));
}, { timezone: 'UTC' });

// Nightly Stripe account-status refresh (payments go-live slice 06, #1987). Replaces the old
// boot-time backfill, which ran with no tenant context and failed OPEN. Listing the orgs is
// the only cross-org read (unscoped, like the crons above); each org is then refreshed in its
// own tenant context and FAILS CLOSED on any processor error (lib/account-status.ts). The
// account event and the return from onboarding refresh between runs.
cron.schedule('30 7 * * *', () => {
  runUnscoped(() => refreshAllAccountStatuses())
    .then((r) => logger.info(`Stripe account status refresh: ${r.orgs.length} org(s) checked`))
    .catch((err) => logger.error('Stripe account status refresh cron failed', err));
}, { timezone: 'UTC' });
