/**
 * One-time backfill: assign customer_number to all customers that have NULL.
 *
 * Finds every org that has at least one customer with customer_number IS NULL,
 * then for each org (in a transaction) assigns sequential numbers ordered by
 * created_at ASC, id ASC — deterministic and idempotent.
 *
 * Run with: cd backend && npx tsx src/scripts/backfill-customer-number.ts
 * Dry run:  cd backend && DRY_RUN=true npx tsx src/scripts/backfill-customer-number.ts
 */
import { prisma } from '../lib/prisma';
import { allocateNumber } from '../lib/numbering';
import { withNumberCollisionRetry } from '../lib/number-collision-retry';
import { Prisma } from '@prisma/client';

export async function runBackfill(): Promise<void> {
  const DRY_RUN = process.env.DRY_RUN === 'true';

  console.log(`Starting customer_number backfill${DRY_RUN ? ' (DRY RUN — no writes)' : ''}...\n`);

  // Find distinct org IDs that have at least one null-numbered customer
  const orgRows = await prisma.customer.findMany({
    where: { customer_number: null } as unknown as Prisma.CustomerWhereInput,
    select: { organization_id: true },
    distinct: ['organization_id'],
  });

  if (orgRows.length === 0) {
    console.log('No customers need numbering — all clean.');
    return;
  }

  console.log(`Found ${orgRows.length} org(s) with un-numbered customers.\n`);

  for (const { organization_id: orgId } of orgRows) {
    if (DRY_RUN) {
      // For dry run, query outside the transaction and skip writes
      const customers = await prisma.customer.findMany({
        where: { organization_id: orgId, customer_number: null } as unknown as Prisma.CustomerWhereInput,
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
        select: { id: true, first_name: true, last_name: true },
      });

      if (customers.length === 0) {
        console.log(`  org ${orgId}: no null-numbered customers (skipping).`);
        continue;
      }

      console.log(`  org ${orgId}: ${customers.length} customer(s) to number`);
      for (const c of customers) {
        console.log(`    [DRY RUN] would assign number to: ${c.last_name ?? ''}, ${c.first_name ?? ''} (${c.id})`);
      }
      continue;
    }

    // A retry re-runs this callback, so its progress lines print again for an attempt that rolled
    // back. Harmless in a one-off script: the `✓ id → number` lines from the losing attempt name
    // writes that were discarded, and the last block printed is the one that committed.
    await withNumberCollisionRetry(() => prisma.$transaction(async (tx) => {
      // Re-check inside transaction: find null-numbered customers for this org
      const customers = await tx.customer.findMany({
        where: { organization_id: orgId, customer_number: null } as unknown as Prisma.CustomerWhereInput,
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
        select: { id: true, first_name: true, last_name: true },
      });

      if (customers.length === 0) {
        console.log(`  org ${orgId}: no null-numbered customers (skipping).`);
        return;
      }

      console.log(`  org ${orgId}: ${customers.length} customer(s) to number`);

      for (const c of customers) {
        const customerNumber = await allocateNumber(tx, 'customer', orgId);
        await tx.customer.update({
          where: { id: c.id },
          data: { customer_number: customerNumber },
        });
        console.log(`    ✓ ${c.id} → ${customerNumber}`);
      }
    }), { label: 'customer.backfill' });

    console.log(`  org ${orgId}: done.\n`);
  }

  if (!DRY_RUN) {
    console.log('Backfill complete.');
  } else {
    console.log('\nDry run complete — no changes written.');
  }
}

async function main() {
  await runBackfill();
}

// Only run when executed directly (not when imported by tests)
if (require.main === module) {
  main()
    .catch((err) => {
      console.error('Backfill failed:', err);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
