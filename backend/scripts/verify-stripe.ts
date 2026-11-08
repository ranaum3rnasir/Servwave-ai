#!/usr/bin/env tsx
import { preflight } from './verify-stripe/preflight';
import { setupFixtures, teardownFixtures } from './verify-stripe/fixtures';

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const preflightOnly = args.includes('--preflight');
const live = args.includes('--live');

async function main() {
  console.log('Stripe Verification Harness — sandbox mode');

  if (live && !args.includes('--confirm-i-mean-it')) {
    console.error('Refusing to run in live mode without --confirm-i-mean-it');
    process.exit(2);
  }

  const pf = await preflight();
  if (!pf.ok) {
    console.error('Preflight failed:', pf.errors);
    process.exit(1);
  }
  if (preflightOnly) {
    console.log('✓ Preflight passed (--preflight, exiting)');
    return;
  }

  let fixtures: Awaited<ReturnType<typeof setupFixtures>> | undefined;
  let assertions = 0;
  const failures: string[] = [];
  try {
    fixtures = await setupFixtures();
    const tests = [
      'flow-A-deposit-checkout',
      'flow-B-invoice-checkout',
      'flow-C-deposit-refund-realapi',
      'flow-D-invoice-refund-realapi',
      'flow-E-charge-refunded-sync',
      'idempotency-double-fire',
      'signature-mismatch',
      'amount-mismatch',
      'missing-metadata',
      'connect-infra',
    ];
    for (const t of tests) {
      const mod = await import(`./verify-stripe/tests/${t}`);
      try {
        const n = await mod.run(fixtures, { verbose });
        assertions += n;
        console.log(`✓ ${t} (${n} assertions)`);
      } catch (err: any) {
        failures.push(`${t}: ${err.message}`);
        console.log(`✗ ${t}: ${err.message}`);
      }
    }
  } finally {
    if (fixtures) await teardownFixtures(fixtures);
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s):`);
    failures.forEach((f) => console.error('  -', f));
    process.exit(1);
  }
  console.log(`\n${assertions} assertions passed`);
}

main().catch((err) => {
  console.error('Harness crashed:', err);
  process.exit(2);
});
