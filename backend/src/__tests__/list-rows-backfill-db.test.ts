/* =============================================================================
   V7-03 - Migration B (the data-only backfill of job_types / lead_sources from the organizations' JSON columns).

   Real, migrated throwaway database (TEST_DATABASE_URL); skips when it is unset. The migration is static SQL for ALL
   organizations; the fill helper (listRowsFromOrgJsonSql) is the same statement for ONE. These tests prove they produce
   the same rows on the same JSON, that re-running never duplicates or overwrites, and that the file holds no DDL.
   ========================================================================== */
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { listRowsFromOrgJsonSql, LIST_TABLES, type ListTable } from '../lib/org-list-sql';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const MIGRATION_SQL = join(__dirname, '../../prisma/migrations/20261016100000_job_types_lead_sources_backfill/migration.sql');
const COLUMN: Record<ListTable, string> = { job_types: 'job_type_options', lead_sources: 'source_options' };

const clientAt = (u: string) => new PrismaClient({ datasources: { db: { url: u } } });

const long60 = 'x'.repeat(60);
const SHAPES: Record<string, unknown> = {
  ordered: ['Install', 'Repair', 'Maintenance'],
  dupes: ['Door', 'door', ' DOOR ', 'Lock', 'lock'],
  junk: ['  Spaced   out  ', '', '   ', 7, null, { a: 1 }, ['nested'], true, 'Kept'],
  cut: [long60, 'After'],
  empty: [],
  notArray: { not: 'an array' },
  scalar: 'just a string',
};

suite('Migration B: lists backfill (real database)', () => {
  const db: ReturnType<typeof clientAt> = clientAt(url ?? '');
  const created: string[] = [];

  async function makeOrg(json: Record<string, unknown>): Promise<string> {
    const id = randomUUID();
    created.push(id);
    await db.organization.create({
      data: {
        id, name: `v7-03b-${id.slice(0, 8)}`, email: `v7b-${id.slice(0, 8)}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
      },
    });
    for (const [col, value] of Object.entries(json)) {
      await db.$executeRawUnsafe(`UPDATE organizations SET "${col}" = $1::jsonb WHERE id = $2::uuid`, JSON.stringify(value), id);
    }
    return id;
  }
  const rowsOf = (table: ListTable, org: string) =>
    db.$queryRawUnsafe<Array<{ name: string; sort_order: number; archived_at: Date | null }>>(
      `SELECT name, sort_order, archived_at FROM ${table} WHERE organization_id = $1::uuid ORDER BY sort_order, name`, org);
  // One call per statement (a prepared statement takes one command); the deploy runs the whole file.
  const runMigration = async () => {
    const body = readFileSync(MIGRATION_SQL, 'utf8').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    for (const stmt of body.split(/;\s*$/m).map((x) => x.trim()).filter(Boolean)) await db.$executeRawUnsafe(stmt);
  };

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const id of created) {
      for (const t of LIST_TABLES) await quietly(db.$executeRawUnsafe(`DELETE FROM ${t} WHERE organization_id = $1::uuid`, id));
      await quietly(db.organization.deleteMany({ where: { id } }));
    }
    await db.$disconnect();
  });

  it('is data only: two INSERT ... SELECT statements, no DDL, nothing Supabase-only', () => {
    const sql = readFileSync(MIGRATION_SQL, 'utf8').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(sql.match(/INSERT INTO/g)).toHaveLength(2);
    expect(sql).toMatch(/INSERT INTO "job_types"/);
    expect(sql).toMatch(/INSERT INTO "lead_sources"/);
    expect(sql).not.toMatch(/\b(CREATE|ALTER|DROP|GRANT|REVOKE|TRUNCATE|DELETE|UPDATE)\b/i);
    expect(sql).not.toMatch(/auth\.|authenticated|service_role|anon\b/);
  });

  it('produces exactly the rows the per-org fill helper produces, for every list shape, in both tables', async () => {
    const names = Object.keys(SHAPES);
    const viaHelper: Record<string, string> = {};
    const viaMigration: Record<string, string> = {};
    for (const n of names) {
      const json = { job_type_options: SHAPES[n], source_options: SHAPES[n] };
      viaHelper[n] = await makeOrg(json);
      viaMigration[n] = await makeOrg(json);
    }
    for (const n of names) for (const t of LIST_TABLES) await db.$executeRawUnsafe(listRowsFromOrgJsonSql('$1::uuid', t), viaHelper[n]);
    await runMigration();
    for (const n of names) {
      for (const t of LIST_TABLES) {
        const a = await rowsOf(t, viaHelper[n]);
        const b = await rowsOf(t, viaMigration[n]);
        expect(b, `${t} / ${n}`).toEqual(a);
      }
    }
    // and the shapes came out as intended, not merely equal
    expect((await rowsOf('job_types', viaMigration.ordered)).map((r) => [r.name, r.sort_order])).toEqual([['Install', 0], ['Repair', 1], ['Maintenance', 2]]);
    expect((await rowsOf('job_types', viaMigration.dupes)).map((r) => [r.name, r.sort_order])).toEqual([['Door', 0], ['Lock', 1]]);
    expect((await rowsOf('lead_sources', viaMigration.junk)).map((r) => r.name)).toEqual(['Spaced out', 'Kept']);
    expect((await rowsOf('lead_sources', viaMigration.cut))[0].name).toBe('x'.repeat(50));
    for (const n of ['empty', 'notArray', 'scalar']) {
      expect(await rowsOf('job_types', viaMigration[n])).toHaveLength(0);
      expect(await rowsOf('lead_sources', viaMigration[n])).toHaveLength(0);
    }
  });

  it('leaves an org that already has rows untouched (even only archived ones), and a second run changes nothing', async () => {
    const renamed = await makeOrg({ job_type_options: ['Old A', 'Old B'], source_options: ['Old S'] });
    await db.$executeRawUnsafe(
      `INSERT INTO job_types (id, organization_id, name, sort_order, archived_at, created_at, updated_at)
       VALUES (gen_random_uuid(), $1::uuid, 'Renamed By Admin', 0, now(), now(), now())`, renamed);
    const fresh = await makeOrg({ job_type_options: ['One', 'Two'], source_options: ['Web', 'Referral'] });

    await runMigration();
    const afterFirst = { renamedJt: await rowsOf('job_types', renamed), renamedLs: await rowsOf('lead_sources', renamed), fresh: await rowsOf('job_types', fresh) };
    expect(afterFirst.renamedJt.map((r) => r.name)).toEqual(['Renamed By Admin']);
    expect(afterFirst.renamedJt[0].archived_at).not.toBeNull();
    expect(afterFirst.renamedLs.map((r) => r.name)).toEqual(['Old S']); // other table had no rows: filled
    expect(afterFirst.fresh.map((r) => r.name)).toEqual(['One', 'Two']);

    const total = () => db.$queryRawUnsafe<Array<{ n: number }>>(`SELECT (SELECT count(*) FROM job_types) + (SELECT count(*) FROM lead_sources) AS n`);
    const before = await total();
    await runMigration();
    expect(await total()).toEqual(before);
    expect(await rowsOf('job_types', renamed)).toEqual(afterFirst.renamedJt);
    expect(await rowsOf('job_types', fresh)).toEqual(afterFirst.fresh);
  });

  it('writes rows when applied by a role WITHOUT bypassrls (forced RLS must not turn it into INSERT 0 0)', async () => {
    const role = 'v7_03b_nobypass_role';
    const org = await makeOrg({ job_type_options: ['Alpha', 'Beta'], source_options: ['Web'] });
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    await quietly(db.$executeRawUnsafe(`DROP OWNED BY ${role}`));
    await quietly(db.$executeRawUnsafe(`DROP ROLE IF EXISTS ${role}`));
    await db.$executeRawUnsafe(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    try {
      await db.$executeRawUnsafe(`GRANT SELECT ON organizations TO ${role}`);
      await db.$executeRawUnsafe(`GRANT SELECT, INSERT ON job_types, lead_sources TO ${role}`);
      // One transaction, like the deploy runs the file.
      await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
        const body = readFileSync(MIGRATION_SQL, 'utf8').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
        for (const stmt of body.split(/;\s*$/m).map((x) => x.trim()).filter(Boolean)) await tx.$executeRawUnsafe(stmt);
      });
      expect((await rowsOf('job_types', org)).map((r) => r.name)).toEqual(['Alpha', 'Beta']);
      expect((await rowsOf('lead_sources', org)).map((r) => r.name)).toEqual(['Web']);
    } finally {
      await quietly(db.$executeRawUnsafe(`DROP OWNED BY ${role}`));
      await quietly(db.$executeRawUnsafe(`DROP ROLE IF EXISTS ${role}`));
    }
  });

  it('writes the lists of two orgs independently (rows keyed by their own organization, same names allowed)', async () => {
    const a = await makeOrg({ job_type_options: ['Shared'], source_options: [] });
    const b = await makeOrg({ job_type_options: ['Shared', 'Only B'], source_options: [] });
    await runMigration();
    expect((await rowsOf('job_types', a)).map((r) => r.name)).toEqual(['Shared']);
    expect((await rowsOf('job_types', b)).map((r) => r.name)).toEqual(['Shared', 'Only B']);
  });
});
