/* =============================================================================
   Roles & Permissions, ticket 25 (finding M6, decision D2), migration M14: the audit table is addition-only, and so is the
   switch history (re-audit N13, the second suite below).

   The database itself refuses every UPDATE, DELETE and TRUNCATE on audit_logs, whoever asks: the app's runtime role
   (app_rls, which is what the live API connects as) and the table's owner (what a migration, a script or a support session
   connects as). A new row is still accepted. The rule holds when the deploy runs the migration a second time.

   The database seam: real statements against the real migrated database (TEST_DATABASE_URL); the suite skips when it is
   unset. Every attempt runs in a transaction that is always rolled back, so a missing rule changes nothing it would have
   destroyed (a TRUNCATE without the rule would wipe the shared table).
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaClient, type Prisma } from '@prisma/client';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const MIGRATION_SQL = join(__dirname, '..', '..', 'prisma', 'migrations', '20261028140000_audit_logs_append_only', 'migration.sql');

/** Thrown to roll a transaction back after its statements ran. */
class RolledBack extends Error {}

suite('the audit table is addition-only (real database)', () => {
  const db = new PrismaClient({ datasources: { db: { url: url ?? '' } } });
  const org = randomUUID();
  const rowId = randomUUID();

  beforeAll(async () => {
    // The runtime role the live API connects as, created the way the RLS suites create it, so this runs on CI's plain Postgres too.
    await db.$executeRawUnsafe(
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rls') THEN
           CREATE ROLE app_rls NOLOGIN NOBYPASSRLS;
         END IF;
       END $$;`,
    );
    // audit_logs has no foreign key, so a row for a company that is not in the database is a plain row.
    await db.$executeRawUnsafe(
      `INSERT INTO audit_logs (id, org_id, action, resource_type, resource_id, metadata) VALUES ($1::uuid, $2::uuid, 'user.admin_granted', 'User', 'x', '{"before":{"is_admin":false}}')`,
      rowId, org,
    );
  });
  afterAll(() => db.$disconnect());

  /** Run the statements in one transaction that is always rolled back. Returns the database's refusal, or 'allowed'. */
  async function attempt(run: (tx: Prisma.TransactionClient) => Promise<unknown>): Promise<string> {
    try {
      await db.$transaction(async (tx) => {
        await run(tx);
        throw new RolledBack();
      });
    } catch (err) {
      if (err instanceof RolledBack) return 'allowed';
      return (err as Error).message;
    }
    return 'allowed';
  }

  /**
   * As the app's runtime role, with this company as the request's company. The role is given the same table rights the live
   * role holds (inside the rolled-back transaction, so nothing about the role outlives the attempt), so a refusal is the
   * table's rule, not a missing grant or a row-level-security filter.
   */
  const asAppRole = (sql: string) => attempt(async (tx) => {
    await tx.$executeRawUnsafe('GRANT SELECT, INSERT, UPDATE, DELETE ON audit_logs TO app_rls');
    await tx.$executeRawUnsafe('SET LOCAL ROLE app_rls');
    await tx.$executeRawUnsafe("SELECT set_config('app.current_org_id', $1, true)", org);
    await tx.$executeRawUnsafe(sql);
  });
  const asOwner = (sql: string) => attempt((tx) => tx.$executeRawUnsafe(sql));

  const UPDATE = `UPDATE audit_logs SET metadata = '{"before":{"is_admin":true}}' WHERE id = '${rowId}'`;
  const DELETE = `DELETE FROM audit_logs WHERE id = '${rowId}'`;

  it('the runtime role reaches the row (it can read and add rows), so what follows is the table refusing', async () => {
    const seen = await attempt(async (tx) => {
      await tx.$executeRawUnsafe('GRANT SELECT, INSERT, UPDATE, DELETE ON audit_logs TO app_rls');
      await tx.$executeRawUnsafe('SET LOCAL ROLE app_rls');
      await tx.$executeRawUnsafe("SELECT set_config('app.current_org_id', $1, true)", org);
      await tx.$executeRawUnsafe(`INSERT INTO audit_logs (org_id, action) VALUES ('${org}'::uuid, 'test.added')`);
      const rows = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM audit_logs WHERE id = '${rowId}'`);
      if (Number(rows[0]!.n) !== 1) throw new Error('the runtime role does not see the row');
    });
    expect(seen).toBe('allowed');
  });

  it('refuses UPDATE and DELETE from the app runtime role', async () => {
    expect(await asAppRole(UPDATE)).toMatch(/audit_logs is append-only: UPDATE is refused/);
    expect(await asAppRole(DELETE)).toMatch(/audit_logs is append-only: DELETE is refused/);
  });

  it('refuses UPDATE, DELETE and TRUNCATE from the table owner', async () => {
    const owner = await db.$queryRawUnsafe<Array<{ me: string; owner: string }>>(
      "SELECT current_user AS me, tableowner AS owner FROM pg_tables WHERE tablename = 'audit_logs'",
    );
    // This connection is the owner, so these are the owner's own statements.
    expect(owner[0]!.me).toBe(owner[0]!.owner);
    expect(await asOwner(UPDATE)).toMatch(/audit_logs is append-only: UPDATE is refused/);
    expect(await asOwner(DELETE)).toMatch(/audit_logs is append-only: DELETE is refused/);
    expect(await asOwner('TRUNCATE audit_logs')).toMatch(/audit_logs is append-only: TRUNCATE is refused/);
  });

  it('refuses even with replication-mode triggers turned off for the session', async () => {
    expect(await attempt(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRawUnsafe(DELETE);
    })).toMatch(/audit_logs is append-only: DELETE is refused/);
  });

  it('holds when the deploy runs the migration again: one rule, still refusing', async () => {
    const sql = readFileSync(MIGRATION_SQL, 'utf8');
    const after = await attempt(async (tx) => {
      await tx.$executeRawUnsafe(sql);
      const triggers = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
        "SELECT count(*) AS n FROM pg_trigger WHERE tgrelid = 'audit_logs'::regclass AND NOT tgisinternal",
      );
      if (Number(triggers[0]!.n) !== 1) throw new Error(`expected one rule on audit_logs, found ${triggers[0]!.n}`);
      await tx.$executeRawUnsafe(DELETE);
    });
    expect(after).toMatch(/audit_logs is append-only: DELETE is refused/);
  });
});

/* -----------------------------------------------------------------------------------------------------------------------------
   Re-audit N13 (pre-PR review fixes): the switch history, permission_change_log, is addition-only too, by the same migration
   (M14). Its rows hang off their company (ON DELETE CASCADE), so the one delete it allows is the company's own removal.
   ----------------------------------------------------------------------------------------------------------------------------- */
suite('the switch history is addition-only, except with its company (real database)', () => {
  const db = new PrismaClient({ datasources: { db: { url: url ?? '' } } });
  const orgs: string[] = [];
  let org = '';
  const rowId = randomUUID();

  async function newCompany(): Promise<string> {
    const id = randomUUID();
    orgs.push(id);
    const tag = id.slice(0, 8);
    await db.organization.create({
      data: {
        id, name: `n13-${tag}`, email: `n13-${tag}@example.test`, address_line1: '1 Test Way', city: 'Testville', state: 'MA',
        postal_code: '02108', estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
      },
    });
    return id;
  }

  const historyRow = (company: string, id: string = randomUUID()) => db.$executeRawUnsafe(
    `INSERT INTO permission_change_log (id, organization_id, target_type, target_id, switch_key, from_value, to_value, reason)
     VALUES ($1::uuid, $2::uuid, 'ROLE', 'n13-role', 'see_prices', 'false'::jsonb, 'true'::jsonb, 'manual')`,
    id, company,
  );

  beforeAll(async () => {
    await db.$executeRawUnsafe(
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rls') THEN
           CREATE ROLE app_rls NOLOGIN NOBYPASSRLS;
         END IF;
       END $$;`,
    );
    org = await newCompany();
    await historyRow(org, rowId);
  });
  afterAll(async () => {
    // Removing the companies is the one delete the rule allows: their history goes with them.
    await db.organization.deleteMany({ where: { id: { in: orgs } } });
    await db.$disconnect();
  });

  async function attempt(run: (tx: Prisma.TransactionClient) => Promise<unknown>): Promise<string> {
    try {
      await db.$transaction(async (tx) => {
        await run(tx);
        throw new RolledBack();
      });
    } catch (err) {
      if (err instanceof RolledBack) return 'allowed';
      return (err as Error).message;
    }
    return 'allowed';
  }

  /** As the app's runtime role, in this company, with the table rights the live role holds (inside the rolled-back transaction). */
  const asAppRole = (sql: string) => attempt(async (tx) => {
    await tx.$executeRawUnsafe('GRANT SELECT, INSERT, UPDATE, DELETE ON permission_change_log TO app_rls');
    await tx.$executeRawUnsafe('GRANT SELECT ON organizations TO app_rls');
    await tx.$executeRawUnsafe('SET LOCAL ROLE app_rls');
    await tx.$executeRawUnsafe("SELECT set_config('app.current_org_id', $1, true)", org);
    await tx.$executeRawUnsafe(sql);
  });
  /** As the owner, with every company in view (the setting the e2e and cron paths use), so no row is hidden from the statement. */
  const asOwner = (sql: string) => attempt(async (tx) => {
    await tx.$executeRawUnsafe("SELECT set_config('app.bypass_rls', 'on', true)");
    await tx.$executeRawUnsafe(sql);
  });

  const UPDATE = `UPDATE permission_change_log SET to_value = 'false'::jsonb WHERE id = '${rowId}'`;
  const DELETE = `DELETE FROM permission_change_log WHERE id = '${rowId}'`;

  it('the runtime role sees the row and can add one, so what follows is the table refusing', async () => {
    const seen = await attempt(async (tx) => {
      await tx.$executeRawUnsafe('GRANT SELECT, INSERT, UPDATE, DELETE ON permission_change_log TO app_rls');
      await tx.$executeRawUnsafe('GRANT SELECT ON organizations TO app_rls');
      await tx.$executeRawUnsafe('SET LOCAL ROLE app_rls');
      await tx.$executeRawUnsafe("SELECT set_config('app.current_org_id', $1, true)", org);
      await tx.$executeRawUnsafe(
        `INSERT INTO permission_change_log (id, organization_id, target_type, target_id, reason) VALUES (gen_random_uuid(), '${org}'::uuid, 'ROLE', 'n13', 'manual')`,
      );
      const rows = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM permission_change_log WHERE id = '${rowId}'`);
      if (Number(rows[0]!.n) !== 1) throw new Error('the runtime role does not see the row');
    });
    expect(seen).toBe('allowed');
  });

  it('refuses UPDATE and DELETE from the app runtime role', async () => {
    expect(await asAppRole(UPDATE)).toMatch(/permission_change_log is append-only: UPDATE is refused/);
    expect(await asAppRole(DELETE)).toMatch(/permission_change_log is append-only: DELETE is refused/);
  });

  it('refuses UPDATE, DELETE and TRUNCATE from the table owner', async () => {
    expect(await asOwner(UPDATE)).toMatch(/permission_change_log is append-only: UPDATE is refused/);
    expect(await asOwner(DELETE)).toMatch(/permission_change_log is append-only: DELETE is refused/);
    expect(await asOwner('TRUNCATE permission_change_log')).toMatch(/permission_change_log is append-only: TRUNCATE is refused/);
  });

  it('refuses even with replication-mode triggers turned off for the session', async () => {
    expect(await attempt(async (tx) => {
      await tx.$executeRawUnsafe("SELECT set_config('app.bypass_rls', 'on', true)");
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRawUnsafe(DELETE);
    })).toMatch(/permission_change_log is append-only: DELETE is refused/);
  });

  it('is not fooled by a temporary table that takes the companies table\'s name', async () => {
    expect(await attempt(async (tx) => {
      await tx.$executeRawUnsafe("SELECT set_config('app.bypass_rls', 'on', true)");
      await tx.$executeRawUnsafe('CREATE TEMP TABLE organizations (id uuid) ON COMMIT DROP');
      await tx.$executeRawUnsafe(DELETE);
    })).toMatch(/permission_change_log is append-only: DELETE is refused/);
    // The same as the app's runtime role, which may make temporary tables like any login.
    expect(await attempt(async (tx) => {
      await tx.$executeRawUnsafe('GRANT SELECT, INSERT, UPDATE, DELETE ON permission_change_log TO app_rls');
      await tx.$executeRawUnsafe('GRANT SELECT ON organizations TO app_rls');
      await tx.$executeRawUnsafe('SET LOCAL ROLE app_rls');
      await tx.$executeRawUnsafe("SELECT set_config('app.current_org_id', $1, true)", org);
      await tx.$executeRawUnsafe('CREATE TEMP TABLE organizations (id uuid) ON COMMIT DROP');
      await tx.$executeRawUnsafe(DELETE);
    })).toMatch(/permission_change_log is append-only: DELETE is refused/);
  });

  it('lets the history go with its company, and only then', async () => {
    const gone = await newCompany();
    await historyRow(gone);
    await historyRow(gone);
    await db.organization.delete({ where: { id: gone } });
    const left = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*) AS n FROM permission_change_log WHERE organization_id = '${gone}'`,
    );
    expect(Number(left[0]!.n)).toBe(0);
    // The other company's row is still there.
    const kept = await db.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM permission_change_log WHERE id = '${rowId}'`);
    expect(Number(kept[0]!.n)).toBe(1);
  });

  it('holds when the deploy runs the migration again: the two rules once each, still refusing', async () => {
    const sql = readFileSync(MIGRATION_SQL, 'utf8');
    const after = await attempt(async (tx) => {
      await tx.$executeRawUnsafe(sql);
      const triggers = await tx.$queryRawUnsafe<Array<{ tgname: string; tgenabled: string }>>(
        "SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = 'permission_change_log'::regclass AND NOT tgisinternal ORDER BY tgname",
      );
      const seen = triggers.map((t) => `${t.tgname}:${t.tgenabled}`).join(',');
      if (seen !== 'permission_change_log_append_only:A,permission_change_log_delete_with_company:A') throw new Error(`rules found: ${seen}`);
      await tx.$executeRawUnsafe("SELECT set_config('app.bypass_rls', 'on', true)");
      await tx.$executeRawUnsafe(DELETE);
    });
    expect(after).toMatch(/permission_change_log is append-only: DELETE is refused/);
  });
});
