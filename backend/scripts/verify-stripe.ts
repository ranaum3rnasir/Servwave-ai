#!/usr/bin/env tsx
/**
 * The sandbox verification suite: every payment flow, end to end, against a running backend and
 * the processor's SANDBOX. One command, one dated report.
 *
 *   npm run verify:stripe                       # all flows, report written
 *   npm run verify:stripe -- --only=flow-B-invoice-checkout,flow-J-partial-card-tip
 *   npm run verify:stripe -- --preflight        # only check the setup
 *
 * Setup (the backend under test and this script must share one database and one set of keys):
 *   VERIFY_STRIPE_API_URL            the backend under test (default http://localhost:3000)
 *   DATABASE_URL                     the database that backend uses
 *   STRIPE_SECRET_KEY                sk_test_ only (preflight refuses anything else)
 *   STRIPE_WEBHOOK_SECRET[_CONNECT]  the backend's webhook secret(s); events are signed with it
 *   VERIFY_STRIPE_CHARGING_ACCOUNT   an onboarded sandbox connected account owned by a DEMO org in
 *                                    that database; the connected-account flows write only there
 *   VERIFY_STRIPE_STAFF_EMAIL        the demo admin who makes the in-app refund (default admin@alphacrm.com)
 *   VERIFY_STRIPE_REPORT_DIR         where the dated report goes (default: the payments go-live folder)
 *
 * Which sandbox account: a localhost run must use an onboarded sandbox account that no shared
 * environment owns (acct_1UNvTdFtdeVYLzj2). acct_1UNTxHFzMNWc6ouv belongs to the staging demo org,
 * its events reach staging, so it is for the staging run only. There is no live mode: preflight
 * refuses a non-test key, a production API host, and a processor that reports livemode.
 *
 * Run it with NO event forwarder (`stripe listen`) attached: the flows play the processor's own
 * events to the backend themselves, so a listener would only race them.
 *
 * On a database that is not on this machine nothing is ever deleted: the rows the run created
 * (all tagged qa-39-) stay, and the report lists them.
 *
 * Exit code: 0 green; 1 any failed flow, or any skipped flow (pass --allow-skips to permit skips);
 * 2 the run could not start.
 */
import path from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import Stripe from 'stripe';
import { env } from '../src/config/env';
import { STRIPE_API_VERSION } from '../src/lib/stripe';
import { prisma } from '../src/lib/prisma';
import { preflight } from './verify-stripe/preflight';
import { API_URL } from './verify-stripe/sign';
import { FLOWS } from './verify-stripe/flows';
import { databaseIsLocal } from './verify-stripe/policy';
import { SkipFlow, type SuiteContext } from './verify-stripe/context';
import { leftBehind, runDeferredCleanups } from './verify-stripe/harness';
import { renderReport, reportFileName, suiteVerdict, type FlowResult } from './verify-stripe/report';

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const preflightOnly = args.includes('--preflight');
const allowSkips = args.includes('--allow-skips');
const noReport = args.includes('--no-report');
const argValue = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
// --only=flow-C-deposit-refund-realapi,flow-D-invoice-refund-realapi runs just those flows.
const only = argValue('only')?.split(',');

const DEFAULT_REPORT_DIR = path.resolve(__dirname, '../../md_files/plans/payments/2026-10-05-payments-go-live');

async function main() {
  console.log('Stripe Verification Harness - sandbox mode');

  if (only) {
    const unknown = only.filter((id) => !FLOWS.some((f) => f.id === id));
    if (unknown.length) {
      console.error(`Unknown flow(s) in --only: ${unknown.join(', ')}`);
      process.exit(2);
    }
  }

  const pf = await preflight();
  if (!pf.ok) {
    console.error('Preflight failed:', pf.errors);
    process.exit(2);
  }
  if (preflightOnly) {
    console.log('Preflight passed (--preflight, exiting)');
    return;
  }

  const ctx: SuiteContext = {
    apiUrl: API_URL,
    stripe: new Stripe(env.STRIPE_SECRET_KEY!, { apiVersion: STRIPE_API_VERSION as Stripe.LatestApiVersion }),
    chargingAccount: process.env.VERIFY_STRIPE_CHARGING_ACCOUNT?.trim() || null,
    booked: [],
  };
  const startedAt = new Date();
  const results: FlowResult[] = [];

  try {
    for (const flow of FLOWS) {
      if (only && !only.includes(flow.id)) continue;
      const t0 = Date.now();
      try {
        if (flow.needs?.includes('charging-account') && !ctx.chargingAccount) {
          throw new SkipFlow('no charging account: set VERIFY_STRIPE_CHARGING_ACCOUNT to an onboarded sandbox connected account');
        }
        const mod = await import(`./verify-stripe/tests/${flow.id}`);
        const n: number = await mod.run(ctx, { verbose });
        results.push({ id: flow.id, status: 'pass', assertions: n, ms: Date.now() - t0 });
        console.log(`PASS ${flow.id} (${n} assertions)`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof SkipFlow) {
          results.push({ id: flow.id, status: 'skip', assertions: 0, ms: Date.now() - t0, reason: message });
          console.log(`SKIP ${flow.id}: ${message}`);
        } else {
          results.push({ id: flow.id, status: 'fail', assertions: 0, ms: Date.now() - t0, error: message });
          console.log(`FAIL ${flow.id}: ${message}`);
        }
      }
    }
  } finally {
    await runDeferredCleanups();
    const markdown = renderReport(results, {
      startedAt,
      apiUrl: API_URL,
      databaseKind: databaseIsLocal(process.env.DATABASE_URL) ? 'local' : 'shared',
      fixtures: leftBehind,
    });
    if (!noReport) {
      const dir = argValue('report-dir') ?? process.env.VERIFY_STRIPE_REPORT_DIR ?? DEFAULT_REPORT_DIR;
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, reportFileName(startedAt));
      writeFileSync(file, markdown);
      console.log(`\nReport: ${file}`);
    }
    await prisma.$disconnect();
  }

  const verdict = suiteVerdict(results, { strict: !allowSkips && !only });
  const passed = results.filter((r) => r.status === 'pass').length;
  console.log(`\n${verdict === 'green' ? 'GREEN' : 'NOT GREEN'}: ${passed}/${results.length} flows passed, ${results.reduce((n, r) => n + r.assertions, 0)} assertions`);
  if (verdict === 'red') process.exit(1);
}

main().catch((err) => {
  console.error('Harness crashed:', err);
  process.exit(2);
});
