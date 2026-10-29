#!/usr/bin/env tsx
/**
 * Delete specific seeded built-in automations across every org so the seeder can
 * rebuild them from the current registry.
 *
 * The seeder is idempotent by SKIP — an existing (organization_id, builtin_key)
 * row is left completely alone — so a registry copy change never reaches rows
 * that were already seeded. This is the deliberate escape hatch for that.
 *
 * REFUSES to delete a workflow that has ever enrolled anything or that reports a
 * trigger_count, so a built-in with real history can only be replaced by a human
 * who has looked at it. Run --dry-run first; it prints exactly what would go.
 *
 *   npx tsx scripts/reseed-builtin-keys.ts --keys=a,b,c [--dry-run]
 *
 * Delete order mirrors the app's own deleteWorkflow cascade:
 *   step_runs -> enrollments -> versions -> steps -> workflow
 */
import { prisma } from '../src/lib/prisma';

function argValue(args: string[], flag: string): string | undefined {
  const hit = args.find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1) : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const keys = (argValue(args, '--keys') ?? '').split(',').map((k) => k.trim()).filter(Boolean);
  if (keys.length === 0) throw new Error('usage: reseed-builtin-keys.ts --keys=a,b,c [--dry-run]');

  const rows = await prisma.workflow.findMany({
    where: { builtin_key: { in: keys } },
    select: {
      id: true, builtin_key: true, organization_id: true, trigger_count: true,
      _count: { select: { enrollments: true } },
    },
  });

  console.log(`${keys.length} key(s) → ${rows.length} workflow row(s)${dryRun ? ' (dry-run)' : ''}`);

  const withHistory = rows.filter((r) => r._count.enrollments > 0 || r.trigger_count > 0);
  if (withHistory.length > 0) {
    console.error(`\nREFUSING — ${withHistory.length} row(s) have run history and would lose it:`);
    for (const r of withHistory) {
      console.error(`  ${r.builtin_key} org=${r.organization_id} enrollments=${r._count.enrollments} triggers=${r.trigger_count}`);
    }
    console.error('\nDelete those by hand, or narrow --keys.');
    process.exit(1);
  }

  const byKey = new Map<string, number>();
  for (const r of rows) byKey.set(r.builtin_key!, (byKey.get(r.builtin_key!) ?? 0) + 1);
  for (const [k, n] of byKey) console.log(`  ${k}: ${n} org(s), no run history`);

  if (dryRun) { console.log('\nDry-run — nothing deleted. Re-run without --dry-run, then the seeder.'); return; }

  const ids = rows.map((r) => r.id);
  const deleted = await prisma.$transaction(async (tx) => {
    const enrollments = await tx.workflowEnrollment.findMany({ where: { workflow_id: { in: ids } }, select: { id: true } });
    const stepRuns = await tx.workflowStepRun.deleteMany({ where: { enrollment_id: { in: enrollments.map((e) => e.id) } } });
    const enr = await tx.workflowEnrollment.deleteMany({ where: { workflow_id: { in: ids } } });
    // published_version_id points at a version; clear it before deleting versions.
    await tx.workflow.updateMany({ where: { id: { in: ids } }, data: { published_version_id: null } });
    const versions = await tx.workflowVersion.deleteMany({ where: { workflow_id: { in: ids } } });
    const steps = await tx.workflowStep.deleteMany({ where: { workflow_id: { in: ids } } });
    const workflows = await tx.workflow.deleteMany({ where: { id: { in: ids } } });
    return { stepRuns: stepRuns.count, enrollments: enr.count, versions: versions.count, steps: steps.count, workflows: workflows.count };
  });

  console.log(`\nDeleted: ${JSON.stringify(deleted)}`);
  console.log('Now run: npm run automations:seed-defaults');
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error('Failed:', err instanceof Error ? err.message : err); process.exit(1); });
