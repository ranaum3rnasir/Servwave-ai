/* =============================================================================
   #3468: the watch-list migration, applied for real, the way the deploy applies it (the Prisma deploy command), on a
   fresh database at the migration before it that already has leads.

   Proves:
     - a leads table that stays busy (a save left open) makes it give up after its tries, with nothing changed, and
       without cancelling that save;
     - a leads table busy for a few seconds is waited out (a try times out, the next one gets in) and the save that held
       it commits normally;
     - the shape, exactly as #3468 asks: columns and types (timestamp(3) WITHOUT time zone, text stage with a CHECK, not
       an enum), the key and both foreign keys deleting with their lead and company, the two indexes as written, the tenant
       policy forced on, the two triggers on leads, the IMMUTABLE stage function;
     - leads itself is untouched: same columns, same storage (no rewrite), same indexes, and the leads that existed get no
       row (that is the backfill's job, never the migration's);
     - neither outside role (`anon`, `authenticated`) can reach the table even where the default privileges would hand it
       to them; the live API's role (`app_rls`), where the cluster has it, can write it;
     - after the deploy, a new lead and a stage change write their rows;
     - a second run of the file changes nothing and reports no error.

   Builds its own throwaway database on the server TEST_DATABASE_URL points at and drops it afterwards. Skips when
   TEST_DATABASE_URL is unset, and REFUSES a non-local host: it creates and drops databases. The Prisma CLI runs from a
   temp directory with DATABASE_URL and DIRECT_URL passed explicitly, so it never falls back to a checkout's .env.
   ========================================================================== */

import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { spawn, spawnSync } from 'child_process';
import { rmSync } from 'fs';
import { dirname, join } from 'path';
import { PrismaClient } from '@prisma/client';
import { deployMigrations, createMigrationDatabase } from './migration-deploy-support';
import { cancelOtherStatementsInOwnDatabase } from './support/cancel-own-backend';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const MIGRATION = '20261112090000_spider_lead_watch';
const PRISMA_DIR = join(__dirname, '..', '..', 'prisma');
const MIGRATION_SQL = join(PRISMA_DIR, 'migrations', MIGRATION, 'migration.sql');
const PRISMA_CLI = join(dirname(require.resolve('prisma/package.json')), 'build', 'index.js');
const HOUR = 3_600_000;

function assertLocal(raw: string): URL {
  const u = new URL(raw);
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname)) {
    throw new Error(`Spider watch-list migration suite creates and drops databases; refusing non-local host ${u.hostname}`);
  }
  return u;
}

const clientAt = (dbUrl: string) => new PrismaClient({ datasources: { db: { url: dbUrl } } });
type Db = ReturnType<typeof clientAt>;

/** psql takes the URL without Prisma's own parameters. */
function psqlUrl(dbUrl: string): string {
  const u = new URL(dbUrl);
  for (const param of ['schema', 'connection_limit', 'pool_timeout', 'pgbouncer']) u.searchParams.delete(param);
  return u.toString();
}

suite('Spider watch-list migration (real database)', () => {
  const server = url ? assertLocal(url) : new URL('postgresql://localhost/unused');
  const admin = clientAt(url ?? '');
  const tempDirs: string[] = [];
  const name = `sp_watch_mig_${randomUUID().slice(0, 8)}`;
  let dbUrl = '';
  let db: Db | undefined;
  let dir = '';
  /** The company and leads that existed before the migration. */
  let org = '';
  let customer = '';
  let oldLeads: string[] = [];
  /** leads as it was before the migration: columns, storage, indexes. */
  let leadsBefore: unknown;
  let outsideRoles = false;
  let probeReach: { rolname: string; reach: boolean }[] = [];
  /** The deploy that met a busy leads table: how long it took, and how the save that held leads ended. */
  let busyDeploy: { ms: number; holderExit: number | null; holderErr: string } | undefined;

  const leadsShape = (c: Db) =>
    c.$queryRawUnsafe<unknown[]>(
      `SELECT (SELECT json_agg(json_build_object('name', column_name, 'type', data_type, 'nullable', is_nullable, 'default', column_default)
                              ORDER BY ordinal_position)
                 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'leads') AS columns,
              (SELECT relfilenode FROM pg_class WHERE oid = 'public.leads'::regclass)::text AS storage,
              (SELECT json_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'leads') AS indexes`);

  const tableExists = async (c: Db) =>
    (await c.$queryRawUnsafe<{ t: string | null }[]>(`SELECT to_regclass('public.spider_lead_watch')::text AS t`))[0]!.t !== null;

  /** The fresh database at the migration before, with a company and two leads. Made once. */
  async function atBefore(): Promise<Db> {
    if (db) return db;
    await createMigrationDatabase(admin, name, MIGRATION, tempDirs);
    const u = new URL(server.toString());
    u.pathname = `/${name}`;
    dbUrl = u.toString();
    db = clientAt(dbUrl);
    deployMigrations(dbUrl, MIGRATION, 'before', tempDirs);

    org = randomUUID();
    customer = randomUUID();
    const tag = org.slice(0, 8);
    await db.organization.create({
      data: {
        id: org, name: `spider-watch-mig-${tag}`, email: `org-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '', is_demo: true,
      },
    });
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
    });
    oldLeads = [randomUUID(), randomUUID()];
    await db.lead.createMany({
      data: [
        { id: oldLeads[0]!, organization_id: org, customer_id: customer, lead_number: `L-${tag}-1`, service_request: 'Fix the door' },
        { id: oldLeads[1]!, organization_id: org, customer_id: customer, lead_number: `L-${tag}-2`, service_request: 'Fix the gate', status: 'CONTACTED', contacted_at: new Date(Date.now() - HOUR) },
      ],
    });
    leadsBefore = await leadsShape(db);

    const [{ n }] = await db.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM pg_roles WHERE rolname IN ('anon', 'authenticated')`);
    outsideRoles = n === 2;
    return db;
  }

  /**
   * A save on leads left open for `seconds`, in its own psql session. Resolves once it holds its lock, to `{ ended }`
   * (how the save ended). Wrapped in an object on purpose: an async function that returned the promise itself would be
   * awaited to its end, so the caller would only go on once the save had committed.
   */
  async function holdLeads(seconds: number): Promise<{ ended: Promise<{ exit: number | null; stderr: string }> }> {
    const child = spawn('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', psqlUrl(dbUrl), '-c',
      `BEGIN; UPDATE leads SET service_request = service_request WHERE id = '${oldLeads[0]}'; SELECT pg_sleep(${seconds}); COMMIT;`],
    { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += String(d); });
    const ended = new Promise<{ exit: number | null; stderr: string }>((resolve) => child.on('close', (exit) => resolve({ exit, stderr })));
    for (let waited = 0; ; waited += 50) {
      const [{ held }] = await db!.$queryRawUnsafe<{ held: number }[]>(
        `SELECT count(*)::int AS held FROM pg_locks
          WHERE database = (SELECT oid FROM pg_database WHERE datname = current_database())
            AND relation = 'public.leads'::regclass AND mode = 'RowExclusiveLock' AND granted AND pid <> pg_backend_pid()`);
      if (held > 0) break;
      if (waited > 15_000) throw new Error(`the open save never took its lock: ${stderr}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    return { ended };
  }

  /** Deployed through the migration while a save held leads for 5 s. Made once. */
  async function migrated(): Promise<Db> {
    const c = await atBefore();
    if (busyDeploy) return c;
    if (outsideRoles) {
      // The hosted database's default privileges: every table the migrating role creates in public is granted in full
      // to both outside roles. Set on this throwaway database only, for the role the deploy below connects as.
      await c.$executeRawUnsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated`);
      await c.$executeRawUnsafe(`CREATE TABLE sp_watch_probe (id int)`);
      probeReach = await reachOf(c, 'sp_watch_probe');
      await c.$executeRawUnsafe(`DROP TABLE sp_watch_probe`);
    }
    // A save holds leads for 5 s: the first try (at most 2 s) times out, a later one gets in once the save commits.
    const holder = await holdLeads(5);
    const started = Date.now();
    dir = deployMigrations(dbUrl, MIGRATION, 'through', tempDirs);
    const ms = Date.now() - started;
    const ended = await holder.ended;
    busyDeploy = { ms, holderExit: ended.exit, holderErr: ended.stderr };
    return c;
  }

  const reachOf = (c: Db, table: string) =>
    c.$queryRawUnsafe<{ rolname: string; reach: boolean }[]>(
      `SELECT r.rolname, has_table_privilege(r.oid, $1::regclass, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS reach
         FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated') ORDER BY r.rolname`, `public.${table}`);

  const runFileAgain = () =>
    spawnSync(process.execPath, [PRISMA_CLI, 'db', 'execute', '--url', dbUrl, '--file', MIGRATION_SQL], {
      cwd: dir || tempDirs[0],
      env: { ...process.env, DATABASE_URL: dbUrl, DIRECT_URL: dbUrl, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
      encoding: 'utf8',
    });

  /** Everything the migration makes, as the catalog reports it. */
  const shape = (c: Db) =>
    c.$queryRawUnsafe<unknown[]>(
      `SELECT (SELECT json_agg(json_build_object('name', column_name, 'type', data_type, 'precision', datetime_precision,
                                                 'nullable', is_nullable, 'default', column_default) ORDER BY column_name)
                 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'spider_lead_watch') AS columns,
              (SELECT json_agg(json_build_object('name', conname, 'def', pg_get_constraintdef(oid)) ORDER BY conname)
                 FROM pg_constraint WHERE conrelid = to_regclass('public.spider_lead_watch')) AS constraints,
              (SELECT json_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'spider_lead_watch') AS indexes,
              (SELECT json_agg(json_build_object('name', polname, 'using', pg_get_expr(polqual, polrelid), 'check', pg_get_expr(polwithcheck, polrelid)) ORDER BY polname)
                 FROM pg_policy WHERE polrelid = to_regclass('public.spider_lead_watch')) AS policies,
              (SELECT json_agg(pg_get_triggerdef(oid) ORDER BY tgname) FROM pg_trigger
                WHERE tgrelid = 'public.leads'::regclass AND NOT tgisinternal AND tgname LIKE 'spider_lead_watch%') AS lead_triggers,
              (SELECT json_agg(json_build_object('name', proname, 'volatility', provolatile) ORDER BY proname)
                 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('spider_stage_of', 'spider_lead_watch_sync')) AS functions`);

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    if (db) await quietly(db.$disconnect());
    await quietly(admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    await admin.$disconnect();
    for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  });

  it('gives up after its tries when leads stays busy, changes nothing, and leaves the open save alone', async () => {
    const c = await atBefore();
    expect(await tableExists(c)).toBe(false);

    // A save left open for longer than every try and every pause together (5 x 2 s + 1 + 2 + 3 + 4 s = 20 s).
    const holder = await holdLeads(60);
    const started = Date.now();
    const run = runFileAgain();
    const ms = Date.now() - started;
    // The save is still open and running when the migration has given up: it was waited on, never cancelled.
    const stillOpen = await c.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'active' AND query LIKE '%pg_sleep(60)%'`);
    // Ends the held save's statement (the helper acts on this test's own database only); nothing else is running there.
    await cancelOtherStatementsInOwnDatabase(c);
    await holder.ended;

    expect(run.status).not.toBe(0);
    expect(`${run.stdout}\n${run.stderr}`).toMatch(/spider_lead_watch: leads stayed busy for 5 tries of 2 s; nothing was changed/);
    expect(ms).toBeGreaterThanOrEqual(18_000);
    expect(stillOpen).toEqual([{ n: 1 }]);
    // Nothing was changed: no table, no function, no trigger, leads as it was.
    expect(await tableExists(c)).toBe(false);
    expect(await shape(c)).toEqual([{ columns: null, constraints: null, indexes: null, policies: null, lead_triggers: null, functions: null }]);
    expect(await leadsShape(c)).toEqual(leadsBefore);
  }, 300_000);

  it('waits out a leads table busy for a few seconds, and the save that held it commits normally', async () => {
    await migrated();
    expect(busyDeploy!.holderExit, busyDeploy!.holderErr).toBe(0);
    // The first try waits at most 2 s, then a 1 s pause: the deploy could only get in on a later try.
    expect(busyDeploy!.ms).toBeGreaterThanOrEqual(3_000);
  }, 300_000);

  it('makes the table, its keys, its two indexes, its tenant policy, the two triggers and the stage function as #3468 asks', async () => {
    const c = await migrated();
    const [s] = await shape(c) as [Record<string, unknown>];
    expect(s.columns).toEqual([
      { name: 'changed_at', type: 'timestamp without time zone', precision: 3, nullable: 'NO', default: 'CURRENT_TIMESTAMP' },
      { name: 'entered_at', type: 'timestamp without time zone', precision: 3, nullable: 'YES', default: null },
      { name: 'lead_id', type: 'uuid', precision: null, nullable: 'NO', default: null },
      { name: 'organization_id', type: 'uuid', precision: null, nullable: 'NO', default: null },
      { name: 'pending', type: 'boolean', precision: null, nullable: 'NO', default: 'true' },
      { name: 'stage', type: 'text', precision: null, nullable: 'YES', default: null },
    ]);
    expect(s.constraints).toEqual([
      { name: 'spider_lead_watch_lead_id_fkey', def: 'FOREIGN KEY (lead_id) REFERENCES leads(id) ON UPDATE CASCADE ON DELETE CASCADE' },
      { name: 'spider_lead_watch_organization_id_fkey', def: 'FOREIGN KEY (organization_id) REFERENCES organizations(id) ON UPDATE CASCADE ON DELETE CASCADE' },
      { name: 'spider_lead_watch_pkey', def: 'PRIMARY KEY (lead_id)' },
      { name: 'spider_lead_watch_stage_check', def: "CHECK ((stage = ANY (ARRAY['NEW'::text, 'CONTACTED'::text, 'WALKTHROUGH_COMPLETED'::text])))" },
    ]);
    expect(s.indexes).toEqual([
      'CREATE INDEX spider_lead_watch_due_idx ON public.spider_lead_watch USING btree (organization_id, stage, entered_at) WHERE (pending AND (stage IS NOT NULL))',
      'CREATE INDEX spider_lead_watch_organization_id_changed_at_idx ON public.spider_lead_watch USING btree (organization_id, changed_at)',
      'CREATE UNIQUE INDEX spider_lead_watch_pkey ON public.spider_lead_watch USING btree (lead_id)',
    ]);
    // The same tenant policy, word for word, as the other Spider tables carry (its USING is the one leads has).
    const [canonical] = await c.$queryRawUnsafe<{ leads: string; using: string; check: string }[]>(
      `SELECT (SELECT pg_get_expr(polqual, polrelid) FROM pg_policy WHERE polrelid = 'public.leads'::regclass AND polname = 'tenant_isolation') AS leads,
              p.using, p.check
         FROM (SELECT pg_get_expr(polqual, polrelid) AS using, pg_get_expr(polwithcheck, polrelid) AS check
                 FROM pg_policy WHERE polrelid = 'public.spider_recipient_sets'::regclass AND polname = 'tenant_isolation') p`);
    expect(canonical!.leads).toMatch(/app\.bypass_rls.*app\.current_org_id/);
    expect(canonical!.using).toBe(canonical!.leads);
    expect(canonical!.check).toBe(canonical!.leads);
    expect(s.policies).toEqual([{ name: 'tenant_isolation', using: canonical!.using, check: canonical!.check }]);
    const [rls] = await c.$queryRawUnsafe<{ on: boolean; forced: boolean }[]>(
      `SELECT relrowsecurity AS on, relforcerowsecurity AS forced FROM pg_class WHERE oid = 'public.spider_lead_watch'::regclass`);
    expect(rls).toEqual({ on: true, forced: true });
    expect(s.lead_triggers).toEqual([
      expect.stringMatching(/^CREATE TRIGGER spider_lead_watch_on_insert AFTER INSERT ON (public\.)?leads FOR EACH ROW EXECUTE FUNCTION (public\.)?spider_lead_watch_sync\(\)$/),
      expect.stringMatching(/^CREATE TRIGGER spider_lead_watch_on_update AFTER UPDATE ON (public\.)?leads FOR EACH ROW WHEN \(.+\) EXECUTE FUNCTION (public\.)?spider_lead_watch_sync\(\)$/),
    ]);
    expect(s.functions).toEqual([{ name: 'spider_lead_watch_sync', volatility: 'v' }, { name: 'spider_stage_of', volatility: 'i' }]);
  }, 300_000);

  it('leaves leads itself untouched, and writes no row for the leads that already existed (that is the backfill)', async () => {
    const c = await migrated();
    expect(await leadsShape(c)).toEqual(leadsBefore);
    expect(await c.$queryRawUnsafe(`SELECT count(*)::int AS n FROM spider_lead_watch`)).toEqual([{ n: 0 }]);
  }, 300_000);

  it('after the deploy, a new lead and a stage change write their rows', async () => {
    const c = await migrated();
    const fresh = randomUUID();
    await c.lead.create({ data: { id: fresh, organization_id: org, customer_id: customer, lead_number: `L-${fresh.slice(0, 8)}`, service_request: 'Fix the lock' } });
    const contactedAt = new Date(Date.now() - 2 * HOUR);
    await c.lead.update({ where: { id: oldLeads[0]! }, data: { status: 'CONTACTED', contacted_at: contactedAt } });
    const rows = await c.$queryRawUnsafe<{ lead_id: string; stage: string; entered_at: Date; pending: boolean }[]>(
      `SELECT lead_id::text, stage, entered_at, pending FROM spider_lead_watch ORDER BY lead_id`);
    const created = await c.lead.findUniqueOrThrow({ where: { id: fresh }, select: { created_at: true } });
    expect(rows).toEqual([
      { lead_id: fresh, stage: 'NEW', entered_at: created.created_at, pending: true },
      { lead_id: oldLeads[0], stage: 'CONTACTED', entered_at: contactedAt, pending: true },
    ].sort((x, y) => (x.lead_id! < y.lead_id! ? -1 : 1)));
    // Not left for the next test's count of rows.
    await c.lead.delete({ where: { id: fresh } });
  }, 300_000);

  it("keeps both outside roles off the table though the default privileges hand it to them; the live API's role can write it", async (ctx) => {
    const c = await migrated();
    // Every lead save writes this table, so where the cluster has the live API's role, the migration's own grant is there.
    const appRls = await c.$queryRawUnsafe<{ write: boolean }[]>(
      `SELECT has_table_privilege(oid, 'public.spider_lead_watch', 'SELECT, INSERT, UPDATE, DELETE') AS write FROM pg_roles WHERE rolname = 'app_rls'`);
    for (const role of appRls) expect(role.write).toBe(true);
    // CI's Database job makes both outside roles before the migrations (scripts/ci-outside-roles.sql), so there this must run.
    if (!outsideRoles) {
      expect(process.env.CI, 'the outside roles are missing in CI').not.toBe('true');
      ctx.skip();
    }
    expect(probeReach).toEqual([{ rolname: 'anon', reach: true }, { rolname: 'authenticated', reach: true }]);
    expect(await reachOf(c, 'spider_lead_watch')).toEqual([{ rolname: 'anon', reach: false }, { rolname: 'authenticated', reach: false }]);
  }, 300_000);

  it('a second run of the file changes nothing and reports no error', async () => {
    const c = await migrated();
    await c.$executeRawUnsafe(`UPDATE spider_lead_watch SET pending = false, changed_at = '2000-01-01 00:00:00'`);
    const before = { shape: await shape(c), rows: await c.$queryRawUnsafe(`SELECT * FROM spider_lead_watch ORDER BY lead_id`), leads: await leadsShape(c) };

    const again = runFileAgain();

    expect(again.status, again.stderr).toBe(0);
    expect({ shape: await shape(c), rows: await c.$queryRawUnsafe(`SELECT * FROM spider_lead_watch ORDER BY lead_id`), leads: await leadsShape(c) }).toEqual(before);
  }, 300_000);
});
