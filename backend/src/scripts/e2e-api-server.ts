/**
 * Boot the API for a LOCAL browser suite (the mobile gate, frontend/e2e/playwright.mobile.config.ts)
 * WITHOUT anything index.ts schedules.
 *
 * `npm run dev` runs src/index.ts, which also starts the Automation Center poller (every minute),
 * the invoice-due and fee-sweep crons, and boot-time payment-provider sweeps. Those are
 * cross-org: a laptop running them against the staging database executes other orgs' due
 * automation runs (texts, emails) alongside the deployed staging API. A suite that only needs the
 * HTTP API and the test doors must not do that, so this entry point serves `app` and nothing else.
 *
 * The test doors tear a provisioned company down through the company purge, which needs
 * MAILBOX_ADDRESS_HASH_KEY. This server runs with E2E_TEST_DOORS=true, so config/env supplies a
 * harness-only key when backend/.env has none (config/e2eHarnessMailboxKey.ts); a key set there wins.
 *
 * Usage (from backend/): PORT=3340 E2E_TEST_DOORS=true npx tsx src/scripts/e2e-api-server.ts
 */
import app from '../app';
import { env } from '../config/env';
import { logger } from '../lib/logger';

if (env.NODE_ENV === 'production') {
  throw new Error('e2e-api-server refuses to run with NODE_ENV=production');
}

app.listen(env.PORT, '127.0.0.1', () => {
  logger.info(`ServWave API (no crons, e2e) on port ${env.PORT}`);
});
