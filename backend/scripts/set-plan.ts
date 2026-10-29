#!/usr/bin/env npx tsx
/**
 * Change a plan, extend or end a trial, or set a per-org feature override.
 *
 * Usage:
 *   --org-id <uuid> --plan SCALE
 *   --org-id <uuid> --trial 14              # trial SCALE for N days
 *   --org-id <uuid> --end-trial
 *   --org-id <uuid> --feature phone --enable
 *   --org-id <uuid> --feature phone --disable
 *   --org-id <uuid> --feature phone --clear  # remove the override entirely
 */
import { prisma } from '../src/lib/prisma';
import { runUnscoped } from '../src/lib/tenant-context';
import { orgFeatures, effectivePlan, isGrantableFeature, isKnownFeature, catalogEntry } from '../src/lib/entitlements/resolve';
import { buildSetPlanSql } from '../src/lib/entitlements/ops-sql';
import type { PlanTier } from '../src/lib/entitlements/catalog';

const PLANS = ['STARTER', 'PRO', 'SCALE', 'ENTERPRISE'];
const args = process.argv.slice(2);
const arg = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const has = (f: string) => args.includes(f);

async function main() {
  const orgId = arg('--org-id');
  if (!orgId) { console.error('--org-id is required'); process.exit(1); }

  // --print-sql: emit idempotent SQL and exit WITHOUT opening a DB connection.
  // This is the prod path — the skill applies the SQL via Supabase MCP. Same TS
  // logic (buildSetPlanSql) as the live path below, so they can never disagree.
  if (has('--print-sql')) {
    const newPlan = arg('--plan');
    if (newPlan && !PLANS.includes(newPlan)) {
      console.error(`--plan must be one of ${PLANS.join(' | ')} (got "${newPlan}")`);
      process.exit(1);
    }
    const trialDays = arg('--trial');
    if (trialDays !== undefined && (!Number.isFinite(Number(trialDays)) || Number(trialDays) <= 0)) {
      console.error('--trial must be a positive number of days');
      process.exit(1);
    }
    const trialEndsAtISO = trialDays
      ? new Date(Date.now() + Number(trialDays) * 86_400_000).toISOString().slice(0, 10)
      : undefined;
    const featureOp = has('--enable') ? 'enable' : has('--disable') ? 'disable' : has('--clear') ? 'clear' : undefined;
    try {
      console.log(buildSetPlanSql(orgId, {
        plan: newPlan as PlanTier | undefined,
        endTrial: has('--end-trial'),
        trialEndsAtISO,
        feature: arg('--feature'),
        featureOp,
      }));
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
    return;
  }

  await runUnscoped(async () => {
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
    console.log(`\nOrg: ${org.name} (${org.id}) — plan ${org.plan}`);

    const update: Record<string, unknown> = {};

    const newPlan = arg('--plan');
    if (newPlan) {
      if (!PLANS.includes(newPlan)) {
        console.error(`--plan must be one of ${PLANS.join(' | ')} (got "${newPlan}")`);
        process.exit(1);
      }
      update.plan = newPlan;
    }

    const trialDays = arg('--trial');
    if (trialDays) {
      const n = Number(trialDays);
      if (!Number.isFinite(n) || n <= 0) { console.error('--trial must be a positive number of days'); process.exit(1); }
      update.trial_ends_at = new Date(Date.now() + n * 86_400_000);
    }
    if (has('--end-trial')) update.trial_ends_at = null;

    const feature = arg('--feature');
    if (feature) {
      // Validate against the catalog. An unvalidated key would be written to
      // JSONB, echoed back as "updated", and then silently ignored by the
      // resolver — the operator would believe the feature was granted.
      if (!isKnownFeature(feature)) {
        console.error(`Unknown feature "${feature}". Run audit-org.ts to see valid keys.`);
        process.exit(1);
      }
      if (!isGrantableFeature(feature)) {
        console.error(`"${feature}" is declared but not built (${catalogEntry(feature)?.label}). No gate exists; granting it would do nothing.`);
        process.exit(1);
      }
      const overrides = { ...((org.feature_overrides ?? {}) as Record<string, unknown>) };
      if (has('--enable')) overrides[feature] = true;
      else if (has('--disable')) overrides[feature] = false;
      else if (has('--clear')) delete overrides[feature];
      else { console.error('--feature requires --enable, --disable, or --clear'); process.exit(1); }
      update.feature_overrides = overrides;
    }

    if (Object.keys(update).length === 0) {
      console.error('Nothing to do. Pass --plan, --trial N, --end-trial, or --feature <key> --enable|--disable|--clear');
      process.exit(1);
    }

    const updated = await prisma.organization.update({ where: { id: orgId }, data: update as never });
    const source = {
      plan: updated.plan as string,
      trial_ends_at: updated.trial_ends_at,
      feature_overrides: (updated.feature_overrides ?? {}) as Record<string, unknown>,
    };

    console.log(`\n✅ Updated`);
    console.log(`   Plan:      ${updated.plan}`);
    console.log(`   Trial:     ${updated.trial_ends_at?.toISOString().slice(0, 10) ?? 'none'}`);
    console.log(`   Overrides: ${JSON.stringify(updated.feature_overrides)}`);
    console.log(`   Effective: ${effectivePlan(source)}`);
    console.log(`   Features:  ${orgFeatures(source).join(', ')}\n`);
    console.log(`   ⚠️  Users must sign out and back in — org_features is baked into the login payload.\n`);
  });
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
