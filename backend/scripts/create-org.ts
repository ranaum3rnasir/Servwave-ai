#!/usr/bin/env npx tsx
/**
 * Provision a new tenant: org row → DEFAULT_GRANTS seed → plan/trial → checklist.
 *
 * Usage:
 *   npx tsx backend/scripts/create-org.ts --name "Acme Plumbing" \
 *     --email admin@acme.com --state TX --plan PRO [--trial]
 *
 * The DEFAULT_GRANTS seed is the point of this script: a fresh org has ZERO
 * RolePermission rows, so every non-admin 403s until they are seeded. The vault
 * flags it as the easiest step to forget, with a symptom that looks like a bug.
 */
import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/lib/prisma';
import { runUnscoped } from '../src/lib/tenant-context';
import { DEFAULT_GRANTS } from '../src/lib/permissions/defaultGrants';
import { seedStarterTaskCategories, STARTER_TASK_CATEGORIES } from '../src/lib/tasks/categories';
import { orgFeatures, effectivePlan } from '../src/lib/entitlements/resolve';
import { buildCreateOrgSql } from '../src/lib/entitlements/ops-sql';
import type { PlanTier } from '../src/lib/entitlements/catalog';

const args = process.argv.slice(2);
const arg = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const has = (f: string) => args.includes(f);

async function main() {
  const name = arg('--name');
  const email = arg('--email');
  const state = arg('--state');
  const plan = (arg('--plan') ?? 'STARTER') as 'STARTER' | 'PRO' | 'SCALE' | 'ENTERPRISE';
  const trial = has('--trial');

  if (!name || !email || !state) {
    console.error('Required: --name "Org Name" --email admin@org.com --state XX');
    process.exit(1);
  }
  if (state.length !== 2) {
    // StateTaxRate is a single global table keyed by 2-letter code; a state with
    // no row silently bills 0%. organization.state is also rendered raw into PDFs.
    console.error(`--state must be the 2-letter code (got "${state}")`);
    process.exit(1);
  }

  // --print-sql: the PROD path. Emit one idempotent SQL batch (via the same
  // buildCreateOrgSql the tests cover) and exit WITHOUT touching a DB — the skill
  // applies it over Supabase MCP. Requires a REAL address: this path never writes
  // the 'TBD'/'00000' placeholders the live path below uses for throwaway staging orgs.
  if (has('--print-sql')) {
    const addressLine1 = arg('--address-line1');
    const city = arg('--city');
    const postalCode = arg('--postal');
    if (!addressLine1 || !city || !postalCode) {
      console.error('Required for --print-sql: --address-line1 "..." --city "..." --postal "..."');
      process.exit(1);
    }
    const orgId = crypto.randomUUID();
    const trialEndsAtISO = trial ? new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10) : null;
    console.log(`-- new org id: ${orgId}`);
    console.log(`-- plan: ${plan}${trial ? ` (trialing SCALE until ${trialEndsAtISO})` : ''}`);
    console.log(buildCreateOrgSql({
      orgId, name, email, state, addressLine1, city, postalCode,
      plan: plan as PlanTier, trialEndsAtISO,
    }));
    return;
  }

  const orgId = crypto.randomUUID();
  const trial_ends_at = trial ? new Date(Date.now() + 14 * 86_400_000) : null;

  // runUnscoped: with DB_TENANT_GUARD=on a standalone script has no request
  // context, so RLS policies match no rows and every write fails closed.
  await runUnscoped(async () => {
    await prisma.organization.create({
      data: {
        id: orgId,
        name,
        email,
        state,
        address_line1: 'TBD',
        city: 'TBD',
        postal_code: '00000',
        estimate_terms: '',
        estimate_notes: '',
        estimate_payment_terms: '',
        plan,
        trial_ends_at,
      },
    });

    // Conditions carry the row-scope templates (OWN_LEAD, OWN_JOB, …). Dropping
    // them silently grants org-wide access — 25 of 143 grants are affected.
    // Mapper copied from src/lib/e2e-org.ts:79.
    await prisma.rolePermission.createMany({
      data: DEFAULT_GRANTS.map((g) => {
        const conditions = (g as { conditions?: Record<string, unknown> }).conditions;
        return {
          organization_id: orgId,
          role: g.role,
          action: g.action,
          subject: g.subject,
          conditions: conditions == null ? Prisma.JsonNull : (conditions as Prisma.InputJsonValue),
        };
      }),
      skipDuplicates: true,
    });

    // Every new organization starts with the three starter task categories.
    await seedStarterTaskCategories(prisma, orgId);
  });

  const source = { plan, trial_ends_at, feature_overrides: {} };
  const scoped = DEFAULT_GRANTS.filter((g) => (g as { conditions?: unknown }).conditions).length;

  console.log(`\n✅ Organization created`);
  console.log(`   ID:        ${orgId}`);
  console.log(`   Name:      ${name}`);
  console.log(`   Plan:      ${plan}${trial ? ` (trialing SCALE until ${trial_ends_at!.toISOString().slice(0, 10)})` : ''}`);
  console.log(`   Effective: ${effectivePlan(source)}`);
  console.log(`   Features:  ${orgFeatures(source).join(', ')}`);
  console.log(`   Grants:    ${DEFAULT_GRANTS.length} seeded (${scoped} row-scoped)`);
  console.log(`   Task categories: ${STARTER_TASK_CATEGORIES.map((c) => c.name).join(', ')}`);

  console.log(`\n📋 Go-live checklist — NOT done by this script:`);
  console.log(`   [ ] Seed app_settings (10 rows/org — see src/seed.ts:55-66).`);
  console.log(`       Without them: no deposit defaults, no payment methods, no email template.`);
  console.log(`   [ ] Create the admin via POST /api/users/invite (sends a set-password link).`);
  console.log(`       Needs RESEND_API_KEY + EMAIL_FROM + FRONTEND_URL set.`);
  console.log(`   [ ] Set accepted_payment_methods — defaults to [], so the org can accept nothing.`);
  console.log(`   [ ] Replace the address placeholders (address_line1/city/postal_code = "TBD").`);
  console.log(`       These render raw onto customer-facing estimate and invoice PDFs.`);
  console.log(`   [ ] Confirm a StateTaxRate row exists for "${state}" — a missing row bills 0%.`);
  console.log(`   [ ] Add ≥1 service location per customer before creating leads or jobs.`);
  console.log(`   [ ] If phone: set ctm_account_id, then grant with:`);
  console.log(`       npx tsx backend/scripts/set-plan.ts --org-id ${orgId} --feature phone --enable`);
  console.log(`   [ ] Verify: npx tsx backend/scripts/audit-org.ts --org-id ${orgId}\n`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
