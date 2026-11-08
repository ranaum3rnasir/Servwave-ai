/**
 * Compares live `role_permissions` rows against `DEFAULT_GRANTS` for every organization.
 *
 * Report mode (default) is read-only: prints, per org/role, grants that are in DEFAULT_GRANTS
 * but missing from the DB ("missing") and grants that are in the DB but not in DEFAULT_GRANTS
 * ("extra" — never auto-removed, since these may be intentional per-org customization).
 *
 * --emit-sql mode prints an idempotent INSERT ... ON CONFLICT DO NOTHING statement that cross-joins
 * every org against the FULL DEFAULT_GRANTS list (not a pre-filtered "missing" set — which org is
 * missing which grant varies, so filtering here would under-fill some orgs; ON CONFLICT DO NOTHING
 * is what actually does the per-org skip at insert time). For pasting into a migration body — avoids
 * hand-transcribing DEFAULT_GRANTS.
 *
 * --strict mode (flag or DRIFT_STRICT=1 env var) exits 1 when any org has a "changed
 * conditions" finding — same grant, drifted value, the class of bug that broke SALES (#918).
 * "missing"/"extra" never fail strict mode: the additive sync (--emit-sql) handles "missing",
 * and "extra" is frequently intentional per-org customization (see notes below). Without
 * --strict, exit behavior is unchanged (always 0) so existing manual/report use is unaffected.
 *
 * Run with: cd backend && npx tsx src/scripts/check-role-permission-drift.ts [--emit-sql|--strict]
 *
 * NOTE (2026-07 subject split): orgs migrated by 20260717040000_split_inventory_purchasing_subjects
 * derived PurchaseOrder/Vendor rows from their pre-split Inventory rows. Expect e.g.
 * `SALES read PurchaseOrder` / `SALES read Vendor` as "extra" on pre-split orgs — intentional
 * grandfathering, do not delete. Run the derivation migration BEFORE any --emit-sql sync so
 * custom-widened orgs derive their full set rather than receiving bare defaults.
 *
 * NOTE (2026-07 Logistic Orders, LO-1): the LogisticOrder rows were seeded by
 * 20260720120000_logistic_orders_foundations using --emit-sql output FILTERED to that subject
 * (8 rows), not the full sweep — see that migration's header for why. `approve LogisticOrder`
 * is intentionally NOT a role grant (per-user capability only, userCapabilities.ts); if it ever
 * shows up as "extra" in a report, it was written by hand and should be removed, not kept.
 */
import { prisma } from '../lib/prisma';
import { DEFAULT_GRANTS, PRESERVED_ON_RESET } from '../lib/permissions/defaultGrants';

type GrantRow = { role: string; action: string; subject: string; conditions?: unknown };

const grantKey = (g: { role: string; action: string; subject: string }) => `${g.role}::${g.action}::${g.subject}`;

export function diffGrants(defaults: GrantRow[], existing: GrantRow[]) {
  const existingByKey = new Map(existing.map((g) => [grantKey(g), g]));
  const defaultKeys = new Set(defaults.map(grantKey));
  const missing = defaults.filter((g) => !existingByKey.has(grantKey(g)));
  // D15a: a grant the platform deliberately stopped seeding is NOT drift on an org that still
  // holds it - reporting it as "extra" invites an operator to remove exactly the row D15 promised
  // those orgs they would keep. shouldFail() is `strict && changedCount > 0` and treats extras as
  // informational, so this is cosmetic for CI but not for the human reading the output.
  const extra = existing.filter(
    (g) =>
      !defaultKeys.has(grantKey(g)) &&
      !PRESERVED_ON_RESET.some((p) => p.action === g.action && p.subject === g.subject),
  );
  // Same role/action/subject exists on both sides, but the condition JSON differs — the additive
  // sync won't touch these (never updates existing rows), so they need a human decision.
  const changed = defaults
    .filter((g) => existingByKey.has(grantKey(g)))
    .filter((g) => JSON.stringify(existingByKey.get(grantKey(g))!.conditions ?? null) !== JSON.stringify(g.conditions ?? null))
    .map((g) => ({ default: g, existing: existingByKey.get(grantKey(g))! }));
  return { missing, extra, changed };
}

const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;

function sqlLiteral(g: GrantRow): string {
  const conditions = g.conditions == null ? 'NULL' : sqlString(JSON.stringify(g.conditions));
  return `  (${sqlString(g.role)},${sqlString(g.action)},${sqlString(g.subject)},${conditions})`;
}

export function shouldFail(changedCount: number, strict: boolean): boolean {
  return strict && changedCount > 0;
}

export function emitSyncSql(grants: GrantRow[]): string {
  if (grants.length === 0) return '-- no grants to sync';
  return [
    'INSERT INTO role_permissions (id, organization_id, role, action, subject, conditions, created_at, updated_at)',
    'SELECT',
    '  gen_random_uuid(),',
    '  o.id,',
    '  g.role,',
    '  g.action,',
    '  g.subject,',
    '  g.conditions::jsonb,',
    '  NOW(),',
    '  NOW()',
    'FROM organizations o',
    'CROSS JOIN (VALUES',
    grants.map(sqlLiteral).join(',\n'),
    ') AS g(role, action, subject, conditions)',
    'ON CONFLICT (organization_id, role, action, subject) DO NOTHING;',
  ].join('\n');
}

async function main(): Promise<number> {
  if (process.argv.includes('--emit-sql')) {
    // Cross-join every org against the FULL DEFAULT_GRANTS list — which grant is missing varies
    // per org, so ON CONFLICT DO NOTHING (not a pre-filtered list) is what does the per-org skip.
    console.log(emitSyncSql(DEFAULT_GRANTS as GrantRow[]));
    return 0;
  }

  const strict = process.argv.includes('--strict') || process.env.DRIFT_STRICT === '1';

  const orgs = await prisma.organization.findMany({ select: { id: true, name: true } });
  const existingAll = await prisma.rolePermission.findMany({
    select: { organization_id: true, role: true, action: true, subject: true, conditions: true },
  });

  let anyDrift = false;
  let changedTotal = 0;
  for (const org of orgs) {
    const existing = existingAll.filter((g) => g.organization_id === org.id);
    const { missing, extra, changed } = diffGrants(DEFAULT_GRANTS as GrantRow[], existing);
    if (missing.length === 0 && extra.length === 0 && changed.length === 0) continue;
    anyDrift = true;
    changedTotal += changed.length;
    console.log(`\n${org.name} (${org.id})`);
    if (missing.length) {
      console.log(`  missing (${missing.length}):`);
      for (const g of missing) console.log(`    ${g.role} ${g.action} ${g.subject}`);
    }
    if (extra.length) {
      console.log(`  extra — not in DEFAULT_GRANTS, review before removing (${extra.length}):`);
      for (const g of extra) console.log(`    ${g.role} ${g.action} ${g.subject}`);
    }
    if (changed.length) {
      console.log(`  changed conditions — same grant, different condition JSON, review before touching (${changed.length}):`);
      for (const c of changed) {
        console.log(`    ${c.default.role} ${c.default.action} ${c.default.subject}`);
        console.log(`      db:      ${JSON.stringify(c.existing.conditions)}`);
        console.log(`      default: ${JSON.stringify(c.default.conditions ?? null)}`);
      }
    }
  }
  if (!anyDrift) console.log('No drift — all orgs match DEFAULT_GRANTS.');

  if (shouldFail(changedTotal, strict)) {
    console.log(`\n::error::${changedTotal} changed-condition drift finding(s) — see org/role/action/subject/db/default above.`);
    return 1;
  }
  return 0;
}

if (require.main === module) {
  (async () => {
    let exitCode = 0;
    try {
      exitCode = await main();
    } catch (err) {
      console.error('Drift check failed:', err);
      exitCode = 1;
    } finally {
      await prisma.$disconnect();
    }
    process.exitCode = exitCode;
  })();
}
