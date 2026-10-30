/* =============================================================================
   V7-03 - Migration A (the job_types / lead_sources tables) and the statement that copies an org's JSON list into rows.

   Real, migrated throwaway database (TEST_DATABASE_URL); skips when it is unset. A fresh-database apply is what the CI
   `Database (migrations + RLS)` job does when it deploys every migration; this suite covers what that cannot see:
     - the migration file run a second time (the shared staging database may see it twice) changes nothing;
     - RLS is on, forced, and a second org cannot read the first org's rows through a tenant role;
     - the fill statement (the one the data backfill migration will also use, and the org creators call): order, dedupe,
       cut, junk, re-run safety, an org that already has rows.
   ========================================================================== */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { listRowsFromOrgJsonSql, seedListRows, LIST_TABLES, type ListTable } from '../lib/org-list-rows';
import { buildCreateOrgSql } from '../lib/entitlements/ops-sql';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const MIGRATION_SQL = join(__dirname, '../../prisma/migrations/20261016090000_job_types_lead_sources/migration.sql');
const PRISMA_CLI = join(dirname(require.resolve('prisma/package.json')), 'build', 'index.js');

const COLUMN: Record<ListTable, string> = { job_types: 'job_type_options', lead_sources: 'source_options' };
const PROBE_ROLE = 'v7_03a_probe_role';

suite('lists as rows: migration A and the JSON fill (real database)', () => {
  const db = new PrismaClient({ datasources: { db: { url: url ?? '' } } });
  const created: string[] = [];

  async function makeOrg(json?: { job_type_options?: unknown; source_options?: unknown }): Promise<string> {
    const id = randomUUID();
    created.push(id);
    await db.organization.create({
      data: {
        id, name: `v7-03-${id.slice(0, 8)}`, email: `v7-${id.slice(0, 8)}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
      },
    });
    for (const [col, value] of Object.entries(json ?? {})) {
      await db.$executeRawUnsafe(`UPDATE organizations SET "${col}" = $1::jsonb WHERE id = $2::uuid`, JSON.stringify(value), id);
    }
    return id;
  }
  const rowsOf = (table: ListTable, org: string) =>
    db.$queryRawUnsafe<Array<{ name: string; sort_order: number; archived_at: Date | null }>>(
      `SELECT name, sort_order, archived_at FROM ${table} WHERE organization_id = $1::uuid ORDER BY sort_order, name`, org);
  const fill = (table: ListTable, org: string) => db.$executeRawUnsafe(listRowsFromOrgJsonSql('$1::uuid', table), org);

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    await quietly(db.$executeRawUnsafe(`DROP OWNED BY ${PROBE_ROLE}`));
    await quietly(db.$executeRawUnsafe(`DROP ROLE IF EXISTS ${PROBE_ROLE}`));
    for (const id of created) {
      for (const t of ['job_types', 'lead_sources', 'role_permissions', 'app_settings', 'org_tax_rates', 'task_categories', 'mailbox_addresses', 'mailboxes']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${t} WHERE organization_id = $1::uuid`, id));
      }
      await quietly(db.organization.deleteMany({ where: { id } }));
    }
    await db.$disconnect();
  });

  describe('Migration A', () => {
    const indexCount = () =>
      db.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT count(*)::int AS n FROM pg_indexes WHERE tablename IN ('job_types','lead_sources','jobs','leads','customers')`);

    const applyFile = () => execFileSync(process.execPath, [PRISMA_CLI, 'db', 'execute', '--url', url ?? '', '--file', MIGRATION_SQL], { stdio: 'pipe' });

    it('can be applied again, twice over, without error and without changing the tables', async () => {
      applyFile();
      const before = await indexCount();
      applyFile();
      expect((await indexCount())[0].n).toBe(before[0].n);
    });

    it('created the record-column indexes', async () => {
      const names = (await db.$queryRawUnsafe<Array<{ indexname: string }>>(
        `SELECT indexname FROM pg_indexes WHERE indexname IN ('jobs_organization_id_job_type_idx','leads_organization_id_job_type_idx','customers_organization_id_ad_source_idx')`,
      )).map((r) => r.indexname);
      expect(names.sort()).toEqual(['customers_organization_id_ad_source_idx', 'jobs_organization_id_job_type_idx', 'leads_organization_id_job_type_idx']);
    });

    it('has no lower(name) index (case-insensitive uniqueness is enforced in code)', async () => {
      const defs = await db.$queryRawUnsafe<Array<{ indexdef: string }>>(
        `SELECT indexdef FROM pg_indexes WHERE tablename IN ('job_types','lead_sources')`);
      expect(defs.length).toBeGreaterThan(0);
      expect(defs.some((d) => d.indexdef.toLowerCase().includes('lower('))).toBe(false);
    });

    it('has RLS enabled and forced on both tables', async () => {
      const rows = await db.$queryRawUnsafe<Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>>(
        `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('job_types','lead_sources') ORDER BY relname`);
      expect(rows).toEqual([
        { relname: 'job_types', relrowsecurity: true, relforcerowsecurity: true },
        { relname: 'lead_sources', relrowsecurity: true, relforcerowsecurity: true },
      ]);
    });

    it('lets a tenant role see only its own org\'s rows, and write only into it', async () => {
      const a = await makeOrg();
      const b = await makeOrg();
      for (const t of LIST_TABLES) {
        await db.$executeRawUnsafe(
          `INSERT INTO ${t} (id, organization_id, name, sort_order, created_at, updated_at) VALUES (gen_random_uuid(), $1::uuid, 'A row', 0, now(), now()), (gen_random_uuid(), $2::uuid, 'B row', 0, now(), now())`, a, b);
      }
      await db.$executeRawUnsafe(`DROP OWNED BY ${PROBE_ROLE}`).catch(() => undefined);
      await db.$executeRawUnsafe(`DROP ROLE IF EXISTS ${PROBE_ROLE}`);
      await db.$executeRawUnsafe(`CREATE ROLE ${PROBE_ROLE} NOLOGIN`);
      await db.$executeRawUnsafe(`GRANT SELECT, INSERT ON job_types, lead_sources TO ${PROBE_ROLE}`);
      for (const t of LIST_TABLES) {
        const seen = await db.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL ROLE ${PROBE_ROLE}`);
          await tx.$executeRawUnsafe(`SELECT set_config('app.current_org_id', $1, true)`, a);
          return tx.$queryRawUnsafe<Array<{ name: string }>>(`SELECT name FROM ${t}`);
        });
        expect(seen.map((r) => r.name)).toEqual(['A row']);
        await expect(db.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL ROLE ${PROBE_ROLE}`);
          await tx.$executeRawUnsafe(`SELECT set_config('app.current_org_id', $1, true)`, a);
          await tx.$executeRawUnsafe(
            `INSERT INTO ${t} (id, organization_id, name, sort_order, created_at, updated_at) VALUES (gen_random_uuid(), $1::uuid, 'Planted', 0, now(), now())`, b);
        })).rejects.toThrow();
      }
    });
  });

  describe.each(LIST_TABLES)('the fill statement for %s', (table) => {
    const col = COLUMN[table];

    it('turns array order into sort_order', async () => {
      const org = await makeOrg({ [col]: ['Third', 'Alpha', 'Zed'] });
      await fill(table, org);
      expect((await rowsOf(table, org)).map((r) => [r.name, r.sort_order])).toEqual([['Third', 0], ['Alpha', 1], ['Zed', 2]]);
    });

    it('collapses case-insensitive duplicates to the first, and numbers the survivors from 0', async () => {
      const org = await makeOrg({ [col]: ['Repair', 'Install', 'REPAIR', 'install ', 'Other'] });
      await fill(table, org);
      expect((await rowsOf(table, org)).map((r) => [r.name, r.sort_order])).toEqual([['Repair', 0], ['Install', 1], ['Other', 2]]);
    });

    it('skips empty strings and non-strings, trims, collapses inner spaces, and leaves every row active', async () => {
      const org = await makeOrg({ [col]: ['', '   ', 5, null, true, { a: 1 }, ['x'], '  A   b  ', 'Real'] });
      await fill(table, org);
      const rows = await rowsOf(table, org);
      expect(rows.map((r) => [r.name, r.sort_order])).toEqual([['A b', 0], ['Real', 1]]);
      expect(rows.every((r) => r.archived_at === null)).toBe(true);
    });

    it('cuts a 60-character value to 50', async () => {
      const org = await makeOrg({ [col]: ['x'.repeat(60)] });
      await fill(table, org);
      expect((await rowsOf(table, org)).map((r) => r.name)).toEqual(['x'.repeat(50)]);
    });

    it('gives an org with [] no rows, and does not throw on a non-array value', async () => {
      const empty = await makeOrg({ [col]: [] });
      const notArray = await makeOrg({ [col]: { not: 'an array' } });
      const text = await makeOrg({ [col]: 'a string' });
      for (const org of [empty, notArray, text]) {
        await fill(table, org);
        expect(await rowsOf(table, org)).toEqual([]);
      }
    });

    it('leaves an org that already has rows untouched (even archived ones), and a second run changes nothing', async () => {
      const org = await makeOrg({ [col]: ['Json one', 'Json two'] });
      await db.$executeRawUnsafe(
        `INSERT INTO ${table} (id, organization_id, name, sort_order, archived_at, created_at, updated_at) VALUES (gen_random_uuid(), $1::uuid, 'Renamed by admin', 0, now(), now(), now())`, org);
      await fill(table, org);
      expect((await rowsOf(table, org)).map((r) => r.name)).toEqual(['Renamed by admin']);

      const fresh = await makeOrg({ [col]: ['One', 'Two'] });
      await fill(table, fresh);
      const first = await rowsOf(table, fresh);
      await fill(table, fresh);
      expect(await rowsOf(table, fresh)).toEqual(first);
    });

    it('only touches the org it is given', async () => {
      const mine = await makeOrg({ [col]: ['Mine'] });
      const other = await makeOrg({ [col]: ['Other'] });
      await fill(table, mine);
      expect(await rowsOf(table, other)).toEqual([]);
    });
  });

  describe('new organizations', () => {
    const DEFAULT_JOB_TYPES = ['HVAC Service', 'HVAC Install', 'Plumbing', 'Electrical', 'General Maintenance', 'Other'];
    const DEFAULT_SOURCES = ['Google', 'Referral', 'Facebook', 'Instagram', 'Yelp', 'Direct Mail', 'Door Hanger', 'Other'];

    it('seedListRows (create-org script, e2e org, dev seeds) leaves rows equal to the column defaults, any number of times', async () => {
      const org = await makeOrg();
      await seedListRows(db, org);
      await seedListRows(db, org);
      expect((await rowsOf('job_types', org)).map((r) => r.name)).toEqual(DEFAULT_JOB_TYPES);
      expect((await rowsOf('lead_sources', org)).map((r) => r.name)).toEqual(DEFAULT_SOURCES);
    });

    it('buildCreateOrgSql (the onboarding SQL) does the same, and re-applying it seeds nothing twice', async () => {
      const orgId = randomUUID();
      created.push(orgId);
      const sql = buildCreateOrgSql({
        orgId, name: `v7-03-ops-${orgId.slice(0, 8)}`, email: 'ops@example.test', state: 'MA',
        addressLine1: '1 Test Way', city: 'Testville', postalCode: '02108', plan: 'STARTER', trialEndsAtISO: null,
      });
      const apply = async () => {
        for (const stmt of sql.split(/;\s*\n\s*\n/).map((s) => s.trim()).filter(Boolean)) await db.$executeRawUnsafe(stmt);
      };
      await apply();
      await apply();
      expect((await rowsOf('job_types', orgId)).map((r) => r.name)).toEqual(DEFAULT_JOB_TYPES);
      expect((await rowsOf('lead_sources', orgId)).map((r) => r.name)).toEqual(DEFAULT_SOURCES);
    });
  });
});
