/**
 * One-time backfill: transition leads to ESTIMATED where an estimate was sent
 * but the lead status was never updated (bug prior to fix in PR #75).
 *
 * Targets leads in NEW or CONTACTED that have at least
 * one estimate that was sent (status not DRAFT or ARCHIVED).
 *
 * Run with: cd backend && npx tsx src/backfill-lead-estimated-status.ts
 * Dry run:  cd backend && DRY_RUN=true npx tsx src/backfill-lead-estimated-status.ts
 */
import { prisma } from './lib/prisma';

const DRY_RUN = process.env.DRY_RUN === 'true';

async function main() {
  console.log(`Starting lead status backfill${DRY_RUN ? ' (DRY RUN — no writes)' : ''}...\n`);

  const leads = await prisma.lead.findMany({
    where: {
      status: { in: ['NEW', 'CONTACTED'] },
      estimates: {
        some: {
          status: { notIn: ['DRAFT', 'ARCHIVED'] },
        },
      },
    },
    select: {
      id: true,
      lead_number: true,
      status: true,
      organization_id: true,
      estimates: {
        where: { status: { notIn: ['DRAFT', 'ARCHIVED'] } },
        select: { estimate_number: true, status: true },
        orderBy: { created_at: 'asc' },
        take: 1,
      },
    },
  });

  if (leads.length === 0) {
    console.log('No leads to update — all clean.');
    return;
  }

  console.log(`Found ${leads.length} lead(s) to update:\n`);
  for (const lead of leads) {
    const est = lead.estimates[0];
    console.log(`  ${lead.lead_number}  ${lead.status} → ESTIMATED  (estimate ${est.estimate_number} is ${est.status})`);
  }

  if (DRY_RUN) {
    console.log('\nDry run complete — no changes written.');
    return;
  }

  console.log('\nApplying updates...');
  for (const lead of leads) {
    // DELIBERATE BYPASS of the single-writer rule (spec #1751 D6). Every other writer of
    // `leads.status` in the product goes through `transitionLeadStatus`, which is what makes the
    // status ledger trustworthy enough to report from. This one-shot repair script does not, and
    // the consequences are recorded here rather than left to be discovered:
    //
    //   - it files NO ledger entry, so these repairs are absent from the lead's timeline and from
    //     any time-in-stage computed off it;
    //   - it stamps NO stage clock, so a lead moved here gets no `first_estimate_sent_at` from
    //     this run (D10's backfill derives that from the estimate's own `sent_at` instead);
    //   - it has no actor to attribute the move to, which is the honest reason not to file a
    //     ledger entry claiming somebody made it.
    //
    // It repairs rows written before PR #75 and MUST NOT BE RE-RUN. A second run against a
    // database that has moved on would re-assert ESTIMATED over statuses set legitimately since,
    // silently and with no trace of having done so.
    await prisma.lead.update({
      where: { id: lead.id },
      data: { status: 'ESTIMATED' },
    });
    console.log(`  ✓ ${lead.lead_number} → ESTIMATED`);
  }

  console.log(`\nBackfill complete — ${leads.length} lead(s) updated.`);
}

main()
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
