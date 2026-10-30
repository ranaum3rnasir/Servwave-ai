#!/usr/bin/env npx tsx
/**
 * Run the nightly connected-account status refresh by hand (payments go-live slice 06).
 *
 * Usage:
 *   npx tsx scripts/refresh-account-status.ts --dry-run   # list the orgs the nightly job would refresh
 *   npx tsx scripts/refresh-account-status.ts             # refresh them now (fails closed per org)
 *
 * Uses the DATABASE_URL and STRIPE_SECRET_KEY of the environment it runs in.
 */
import { prisma } from '../src/lib/prisma';
import { runUnscoped } from '../src/lib/tenant-context';
import { refreshAllAccountStatuses } from '../src/lib/account-status';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const summary = await runUnscoped(() => refreshAllAccountStatuses({ dryRun }));
  console.log(JSON.stringify(summary, null, 2));
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
