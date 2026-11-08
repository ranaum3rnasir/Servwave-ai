#!/usr/bin/env npx tsx
/**
 * Report an org's effective plan, features, overrides, seats, and grant health.
 * The "why can't they see X" diagnostic.
 *
 * Usage:
 *   --org-id <uuid> | --org-name "Northwind Services"        (live, queries the local-.env DB = staging)
 *   --from-json <path|->                              (compute from pre-fetched rows; no DB)
 *
 * The skill uses --from-json: it runs the SELECTs via Supabase MCP against the
 * chosen env, then pipes {org, users, grants} here so the report math stays in TS.
 */
import fs from 'fs';
import { prisma } from '../src/lib/prisma';
import { runUnscoped } from '../src/lib/tenant-context';
import { orgFeatures, effectivePlan } from '../src/lib/entitlements/resolve';
import { FEATURE_CATALOG } from '../src/lib/entitlements/catalog';
import { PLAN_FEATURES } from '../src/lib/entitlements/plans';
import { DEFAULT_GRANTS } from '../src/lib/permissions/defaultGrants';
import { buildAuditReport, type AuditData } from '../src/lib/entitlements/ops-sql';

const args = process.argv.slice(2);
const arg = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

async function main() {
  // --from-json: compute the report from already-fetched rows, no DB connection.
  const fromJson = arg('--from-json');
  if (fromJson) {
    const raw = fromJson === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(fromJson, 'utf8');
    const data = JSON.parse(raw) as AuditData;
    console.log(buildAuditReport(data));
    return;
  }

  const orgId = arg('--org-id');
  const orgName = arg('--org-name');
  if (!orgId && !orgName) { console.error('--org-id or --org-name required'); process.exit(1); }

  await runUnscoped(async () => {
    const org = await prisma.organization.findFirstOrThrow({
      where: orgId ? { id: orgId } : { name: { contains: orgName!, mode: 'insensitive' } },
      include: {
        users: { where: { is_active: true }, select: { email: true, role: true, has_login: true } },
        role_permissions: { select: { role: true, action: true, subject: true, conditions: true } },
      },
    });

    const source = {
      plan: org.plan as string,
      trial_ends_at: org.trial_ends_at,
      feature_overrides: (org.feature_overrides ?? {}) as Record<string, unknown>,
    };
    const effective = effectivePlan(source);
    const features = orgFeatures(source);

    console.log(`\n━━ ${org.name} (${org.id}) ━━`);
    console.log(`   Stored plan: ${org.plan}`);
    console.log(`   Trial:       ${org.trial_ends_at?.toISOString().slice(0, 10) ?? 'none'}`);
    console.log(`   Effective:   ${effective}`);
    console.log(`   Overrides:   ${JSON.stringify(org.feature_overrides)}`);
    console.log(`   is_demo:     ${org.is_demo}`);

    console.log(`\n━━ Features ━━`);
    for (const e of FEATURE_CATALOG) {
      const on = features.includes(e.key);
      const note = !e.built ? ' (declared, not built — no gate)' : '';
      console.log(`   ${on ? '✅' : '  '} ${e.key.padEnd(22)} ${e.minPlan.padEnd(11)}${note}`);
    }

    console.log(`\n━━ Seats ━━`);
    const logins = org.users.filter((u) => u.has_login);
    const allowed = PLAN_FEATURES[effective]?.seats_included;
    const over = allowed !== null && allowed !== undefined && logins.length > allowed;
    console.log(`   Active logins: ${logins.length} / ${allowed ?? '∞'}${over ? '  ⚠️  OVERAGE' : ''}`);
    console.log(`   (Seat caps are REPORTED, never enforced — v1 scope.)`);
    for (const u of org.users) console.log(`   - ${u.email} (${u.role})${u.has_login ? '' : ' [staff, no login]'}`);

    console.log(`\n━━ Grant health ━━`);
    // DEFAULT_GRANTS covers SALES/DISPATCHER/TECHNICIAN only — ADMIN is a CASL
    // superuser via defineAbility's role short-circuit and holds no rows.
    const actual = new Map(
      org.role_permissions.map((rp) => [`${rp.role}:${rp.action}:${rp.subject}`, rp.conditions]),
    );
    const missing = DEFAULT_GRANTS.filter((g) => !actual.has(`${g.role}:${g.action}:${g.subject}`));
    // A grant present but with conditions stripped is WORSE than a missing one:
    // it silently widens row scope (SALES reads every lead instead of own).
    const unscoped = DEFAULT_GRANTS.filter((g) => {
      const expected = (g as { conditions?: unknown }).conditions;
      if (expected == null) return false;
      const key = `${g.role}:${g.action}:${g.subject}`;
      return actual.has(key) && actual.get(key) == null;
    });

    if (missing.length === 0 && unscoped.length === 0) {
      console.log(`   ✅ All ${DEFAULT_GRANTS.length} DEFAULT_GRANTS present and correctly scoped`);
    }
    if (missing.length > 0) {
      console.log(`   ⚠️  ${missing.length} missing (those roles will 403):`);
      for (const g of missing) console.log(`      ${g.role} ${g.action} ${g.subject}`);
    }
    if (unscoped.length > 0) {
      console.log(`   🔴 ${unscoped.length} present but UNSCOPED — row isolation is broken:`);
      for (const g of unscoped) console.log(`      ${g.role} ${g.action} ${g.subject}`);
    }
    console.log('');
  });
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
