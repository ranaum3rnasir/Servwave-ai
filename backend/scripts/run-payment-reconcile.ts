#!/usr/bin/env npx tsx
/**
 * Run the nightly payment reconcile by hand (payments go-live slice 37).
 *
 * Usage:
 *   npx tsx scripts/run-payment-reconcile.ts                      # every connected org
 *   npx tsx scripts/run-payment-reconcile.ts --org <id> [--org <id>]   # only these orgs
 *
 * Writes the same summary rows and ops email the cron does. Prints the summary as JSON.
 * Uses the DATABASE_URL and STRIPE_SECRET_KEY of the environment it runs in.
 */
import { prisma } from '../src/lib/prisma';
import { runUnscoped } from '../src/lib/tenant-context';
import { runNightlyReconcile } from '../src/services/payment-reconcile';
import { parseOrgIds, unknownOrgLines } from '../src/services/payment-reconcile/org-args';

export { parseOrgIds, unknownOrgLines };

async function main() {
  const orgIds = parseOrgIds(process.argv.slice(2));
  if (orgIds) {
    const known = await runUnscoped(() => prisma.organization.findMany({
      where: { id: { in: orgIds }, stripe_account_id: { not: null } },
      select: { id: true },
    }));
    const lines = unknownOrgLines(orgIds, known.map((o) => o.id));
    if (lines.length) {
      lines.forEach((l) => console.error(l));
      process.exitCode = 1;
      return;
    }
  }
  const summary = await runUnscoped(() => runNightlyReconcile({ orgIds }));
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
  main()
    .catch((err) => { console.error(err); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
}
