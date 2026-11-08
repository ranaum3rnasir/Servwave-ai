/* =============================================================================
   Task categories - the three starters land in every organization, exactly once.

   Runs against a real, migrated throwaway database: the `database` CI job (after
   `prisma migrate deploy`) or a local one. Skips when TEST_DATABASE_URL is unset,
   the same idiom as seed-organization-db.test.ts.

   Covers every way a category row is seeded:
     - the migration's backfill statement, re-run over this suite's own orgs
       (idempotency, and "an existing same-name category is left alone");
     - seedStarterTaskCategories, which scripts/create-org.ts and lib/e2e-org.ts call;
     - buildCreateOrgSql, the SQL the onboarding skill applies.
   Every org this suite creates is removed again in afterAll.

   ORDER-INDEPENDENT: the backfill is replayed over THIS suite's orgs only. Replayed
   verbatim it walks every organization in the database, so run in one vitest call
   beside another *-db suite it seeded starters into that suite's fixture orgs (a
   unique-name clash on "Part order" in task-category-delete-db.test.ts).
   ========================================================================== */

import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { STARTER_TASK_CATEGORIES, seedStarterTaskCategories } from '../lib/tasks/categories';
import { buildCreateOrgSql } from '../lib/entitlements/ops-sql';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const MIGRATION = join(__dirname, '../../prisma/migrations/20260928080000_task_categories/migration.sql');

/** The migration's starter backfill, verbatim - the statement that ran on every existing org. */
function migrationBackfillStatement(): string {
  const sql = readFileSync(MIGRATION, 'utf8');
  const match = sql.match(/INSERT INTO "task_categories"[\s\S]*?ON CONFLICT DO NOTHING;/);
  if (!match) throw new Error('starter backfill statement not found in the migration');
  return match[0];
}

const ORG_SOURCE = 'FROM "organizations" o\n';

/**
 * The one client method these helpers call. Typed narrowly on purpose: the suite's client is
 * `new PrismaClient({ datasources })`, whose inferred options generic differs from a bare
 * `PrismaClient`, so a `PrismaClient` parameter made tsc relate the two whole clients
 * structurally - about 4s and several hundred MB of heap, enough to push the backend
 * type-check past the CI runner's heap limit.
 */
type RawExec = Pick<PrismaClient, '$executeRawUnsafe'>;

/**
 * The same statement with its org source narrowed to `orgIds` ($1) - every other clause (the
 * starter list, the case-insensitive NOT EXISTS, ON CONFLICT) is the migration's own text.
 * Other suites' orgs sharing the database are never written.
 */
function scopedBackfill(prisma: RawExec, orgIds: string[]) {
  const stmt = migrationBackfillStatement();
  if (!stmt.includes(ORG_SOURCE)) throw new Error(`backfill no longer reads ${ORG_SOURCE.trim()}; update scopedBackfill`);
  const scoped = stmt.replace(ORG_SOURCE, 'FROM (SELECT * FROM "organizations" WHERE "id" = ANY($1::uuid[])) o\n');
  return prisma.$executeRawUnsafe(scoped, orgIds);
}

/** One statement per call - Prisma prepares what it sends, so a multi-statement string fails. */
async function runStatements(prisma: RawExec, sql: string) {
  for (const stmt of sql.split(/;\s*\n\s*\n/).map((s) => s.trim()).filter(Boolean)) {
    await prisma.$executeRawUnsafe(stmt);
  }
}

suite('task category starters (real database)', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: url ?? '' } } });
  const created: string[] = [];

  async function makeOrg(): Promise<string> {
    const id = randomUUID();
    created.push(id);
    await prisma.organization.create({
      data: {
        id, name: `vtc08-seed-${id.slice(0, 8)}`, email: `seed-${id.slice(0, 8)}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
      },
    });
    return id;
  }

  const categoriesOf = (orgId: string) =>
    prisma.taskCategory.findMany({
      where: { organization_id: orgId },
      orderBy: { sort_order: 'asc' },
      select: { name: true, color: true, sort_order: true },
    });

  const STARTERS = STARTER_TASK_CATEGORIES.map((c, i) => ({ name: c.name, color: c.color, sort_order: i }));

  afterAll(async () => {
    // Each step swallows its own failure so one missing table cannot strand the org rows.
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const id of created) {
      await quietly(prisma.taskCategory.deleteMany({ where: { organization_id: id } }));
      await quietly(prisma.rolePermission.deleteMany({ where: { organization_id: id } }));
      await quietly(prisma.appSetting.deleteMany({ where: { organization_id: id } }));
      await quietly(prisma.$executeRawUnsafe('DELETE FROM org_tax_rates WHERE organization_id = $1::uuid', id));
      await quietly(prisma.organization.deleteMany({ where: { id } }));
    }
    await prisma.$disconnect();
  });

  it('the starters are Follow-up, Part order and Internal with their colors', () => {
    expect(STARTER_TASK_CATEGORIES).toEqual([
      { name: 'Follow-up', color: '#22C55E' },
      { name: 'Part order', color: '#F97316' },
      { name: 'Internal', color: '#6B7280' },
    ]);
  });

  it('the migration backfill gives every org exactly the three, and a re-run seeds nothing twice', async () => {
    const orgs = [await makeOrg(), await makeOrg()];

    await scopedBackfill(prisma, orgs);
    await scopedBackfill(prisma, orgs);

    // Each org the backfill walked: none is missing a starter, none has two.
    for (const org of orgs) expect(await categoriesOf(org)).toEqual(STARTERS);
  });

  it('leaves an existing same-name category alone, whatever its letter case', async () => {
    const org = await makeOrg();
    await prisma.taskCategory.create({
      data: { organization_id: org, name: 'follow-UP', color: '#3B82F6', sort_order: 7 },
    });

    await scopedBackfill(prisma, [org]);
    await seedStarterTaskCategories(prisma, org);

    const rows = await categoriesOf(org);
    expect(rows).toHaveLength(3);
    expect(rows).toContainEqual({ name: 'follow-UP', color: '#3B82F6', sort_order: 7 });
    expect(rows.map((r) => r.name)).not.toContain('Follow-up');
  });

  it('seedStarterTaskCategories (create-org script, e2e org) seeds a new org once, however often it runs', async () => {
    const org = await makeOrg();

    await seedStarterTaskCategories(prisma, org);
    await seedStarterTaskCategories(prisma, org);

    expect(await categoriesOf(org)).toEqual(STARTERS);
  });

  it('buildCreateOrgSql (the onboarding SQL) seeds the three, and re-applying it seeds nothing twice', async () => {
    const orgId = randomUUID();
    created.push(orgId);
    const sql = buildCreateOrgSql({
      orgId, name: `vtc08-ops-${orgId.slice(0, 8)}`, email: 'ops@example.test', state: 'MA',
      addressLine1: '1 Test Way', city: 'Testville', postalCode: '02108', plan: 'STARTER', trialEndsAtISO: null,
    });

    await runStatements(prisma, sql);
    await runStatements(prisma, sql);

    expect(await categoriesOf(orgId)).toEqual(STARTERS);
  });
});
