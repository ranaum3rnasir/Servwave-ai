#!/usr/bin/env tsx
/**
 * Seed every DEFAULT_AUTOMATIONS entry (services/automations/defaultAutomations.ts)
 * for one org, or every org. Idempotent — safe to re-run; only missing
 * builtin_keys are created (seedDefaultAutomationsForOrg checks first).
 *
 * Every seeded workflow is PUBLISHED; whether it lands enabled comes from the
 * registry's per-entry `seed_enabled`. An entry only carries `seed_enabled:
 * true` in the same change that DELETES the hard-coded sender it replaces, so
 * running this can never double-email a customer. (It is read from the registry
 * rather than hardcoded off because the seeder skips existing rows outright —
 * anything seeded disabled could never be enabled by re-running it.)
 *
 * ONE EXCEPTION, and it is the reason --dry-run now reports more than a key list.
 * The five `default-task-*` entries (Spec B slice 7) retire no hard-coded sender,
 * because tasks have never had one - so they cannot double-send, but they ARE
 * net-new email. Four of the five are event triggers and send nothing until
 * somebody acts. The fifth is a due-date reminder driven by a clock, and its
 * blast radius on the FIRST sweep after seeding is the only number here that is
 * not zero on day one. A key count is not that number (it is always five per
 * entitled org) and neither is a total task count, so --dry-run computes the
 * real one per org: open tasks whose due date falls inside the sweep's first
 * window, times the recipients each of those tasks would reach. Read it before
 * seeding an org that has been running for a while.
 *
 * Entitlement-gated (#1069): an org not entitled to `automations` gets nothing
 * seeded, dry-run or real - reported separately below rather than folded into
 * "already present", since the reason is plan, not prior state. This is the
 * one-way door: a row created for an unentitled org can't be corrected by
 * re-running this (the seeder skips existing rows outright), so seeding it is
 * the mistake to prevent, not a mistake to clean up later.
 *
 * Usage (precedent: scripts/ctm-backfill.ts):
 *   npm run automations:seed-defaults -- [--org=<uuid>] [--dry-run]
 *
 *   --org      scope to one organization id; omitted = every org
 *   --dry-run  report which builtin_keys WOULD be created, write nothing
 */
import { prisma } from '../src/lib/prisma';
import { hasFeature } from '../src/lib/entitlements/resolve';
import { openTaskStatusFilter } from '../src/lib/tasks/status';
import { seedDefaultAutomationsForOrg } from '../src/services/automations/seedDefaultAutomations';
import { DEFAULT_AUTOMATIONS } from '../src/services/automations/defaultAutomations';
import { anchorWindow } from '../src/services/automations/dateAnchorSweep';

/**
 * How much mail the ONE clock-driven default would send on its first sweep, for this org.
 *
 * Built from the same two pieces the poller uses - the registry entry's own trigger_config and
 * dateAnchorSweep's `anchorWindow` - rather than from a hand-written date range, so the figure
 * cannot drift from what the sweep will actually select. The grace period baked into an
 * `after` window is exactly why: a chase's first window reaches a week further back than the
 * offset alone suggests, and a hand-rolled query would quietly under-report it.
 *
 * `emails` counts the ASSIGNEES of each matching task, which is the audience the seeded
 * reminder addresses. An org that edits its copy to add watchers changes that number, but by
 * then the seed has already happened and this figure has done its job.
 */
async function reminderFirstWindow(orgId: string): Promise<{ tasks: number; emails: number; window: string } | null> {
  const reminder = DEFAULT_AUTOMATIONS.find((d) => d.trigger_config != null);
  if (!reminder?.trigger_config) return null;
  const { direction, offset_minutes } = reminder.trigger_config;
  const window = anchorWindow(direction, offset_minutes * 60_000, new Date());
  const rows = await prisma.task.findMany({
    where: { organization_id: orgId, status: openTaskStatusFilter(), due_at: window },
    select: { assignee_ids: true },
  });
  return {
    tasks: rows.length,
    emails: rows.reduce((total, r) => total + r.assignee_ids.length, 0),
    window: `${window.gte.toISOString()} .. ${window.lte.toISOString()}`,
  };
}

function argValue(args: string[], flag: string): string | undefined {
  const hit = args.find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1) : undefined;
}

async function dryRunOrg(orgId: string): Promise<{ created: string[]; skipped: string[]; entitled: boolean }> {
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { plan: true, trial_ends_at: true, feature_overrides: true },
  });
  const entitlementSource = org && { ...org, feature_overrides: org.feature_overrides as Record<string, unknown> | null };
  if (!entitlementSource || !hasFeature(entitlementSource, 'automations')) {
    return { created: [], skipped: DEFAULT_AUTOMATIONS.map((d) => d.builtin_key), entitled: false };
  }

  const created: string[] = [];
  const skipped: string[] = [];
  for (const def of DEFAULT_AUTOMATIONS) {
    const existing = await prisma.workflow.findFirst({
      where: { organization_id: orgId, builtin_key: def.builtin_key },
      select: { id: true },
    });
    (existing ? skipped : created).push(def.builtin_key);
  }
  return { created, skipped, entitled: true };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const orgId = argValue(args, '--org');
  const dryRun = args.includes('--dry-run');

  const orgs = orgId
    ? [{ id: orgId }]
    : await prisma.organization.findMany({ select: { id: true, name: true } });

  if (orgId && orgs.length === 0) {
    console.error(`Organization ${orgId} not found`);
    process.exit(1);
  }

  console.log(
    `Seeding ${DEFAULT_AUTOMATIONS.length} default automations across ${orgs.length} org(s)${dryRun ? ' (dry-run)' : ''}`,
  );

  let totalCreated = 0;
  let totalSkipped = 0;
  let totalNotEntitled = 0;
  let totalFirstSweepEmails = 0;
  for (const org of orgs) {
    const label = 'name' in org ? `${org.name} (${org.id})` : org.id;
    const result = dryRun ? await dryRunOrg(org.id) : await seedDefaultAutomationsForOrg(org.id);
    totalCreated += result.created.length;
    if (!result.entitled) {
      totalNotEntitled++;
      console.log(`  ${label}: not entitled to automations (plan) - 0 seeded`);
      continue;
    }
    totalSkipped += result.skipped.length;
    if (result.created.length > 0) {
      console.log(`  ${label}: +${result.created.length} (${result.created.join(', ')})`);
    }
    // Only on a dry run, and only when the reminder is among the keys this org would gain -
    // an org that already has it is not about to receive a first sweep.
    if (dryRun && result.created.includes('default-task-due-reminder')) {
      const radius = await reminderFirstWindow(org.id);
      if (radius) {
        totalFirstSweepEmails += radius.emails;
        console.log(
          `      first reminder sweep: ${radius.tasks} open task(s) due in ${radius.window} -> ${radius.emails} email(s)`,
        );
      }
    }
  }

  console.log(
    `\n${dryRun ? 'Dry-run' : 'Seed'} complete: ${totalCreated} created, ${totalSkipped} already present, ${totalNotEntitled} org(s) not entitled`,
  );
  if (dryRun) {
    console.log(
      `First reminder sweep across every org above would send ${totalFirstSweepEmails} email(s). Every other default sends nothing until somebody acts.`,
    );
  }
}

// Only run when executed directly (not when imported by tests) — same guard as scripts/ctm-backfill.ts.
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Seed failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
