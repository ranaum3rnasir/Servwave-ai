/* =============================================================================
   Roles & Permissions, PRD 1, slice S01.22 - the preset migration, applied for real.

   Proves against real Postgres, the way the deploy applies it (the Prisma deploy command), on a copy shaped
   like staging (every migration BEFORE this one, then fixtures: each historical Sales condition shape, a
   null-condition invoice read, a hand-made create-customer row, custom roles holding the old payments, user
   and logistic-order grants, a custom role already on the switch store, and people with per-person entries):
     - the built-in presets equal the catalog, switch by switch, for every kind of switch;
     - Sales' Jobs, Estimates and Invoices map as stated, and an unknown shape becomes Through own leads and is
       listed in the dry run; Sales keeps Reopen leads; Technician ends with Edit job line items;
     - custom roles are translated through the catalog; a grant with no switch is dropped and listed;
     - every non-admin person's set equals their role's, per-person entries are ignored and listed, and the
       Admin box is untouched;
     - every change is logged "migration"; a second run changes nothing;
     - the dry run (read-only) predicts exactly what the run then does; the proof check shows rows for every
       organization and role; the drift checker finds a freshly migrated organization clean and an edited one not;
     - the three checks print ids and counts, never a name or the database URL.

   The scratch database is created and dropped on the server TEST_DATABASE_URL points at. Skips when it is unset, and
   REFUSES a non-local host. The Prisma CLI runs from a temp directory with DATABASE_URL and DIRECT_URL passed
   explicitly, so it can never fall back to the checkout's .env (the shared staging DB). Nothing here imports a module
   that touches the app's client at load.
   ========================================================================== */

import { describe, it, expect, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import { rmSync } from 'fs';
import { dirname, join } from 'path';
import { PrismaClient } from '@prisma/client';
import { BUILT_IN_ROLES, SWITCH_CATALOG, sameSwitchValue, type SwitchValue } from '../lib/permissions/switches/catalog';
import { validateSwitchSet } from '../lib/permissions/switches/validate';
import { loadPresetMigrationSnapshot } from '../lib/permissions/switches/presetMigrationSnapshot';
import { PRESET_MIGRATION_NAME } from '../lib/permissions/switches/presetMigration';
import { followUpPresetMove, retiredByFollowUp } from '../lib/permissions/switches/presetMigrationDrift';
import { renamedSwitchKey } from '../lib/permissions/switches/presetMigrationRenames';
import {
  dryRunReport, driftReport, formatDriftReport, formatDryRunReport, formatProofReport, inReadOnlyTransaction, proofReport,
} from '../lib/permissions/switches/presetMigrationReport';
import { deployMigrations } from './migration-deploy-support';

// The store reads through the app's client; point it at the scratch database the suite migrates (set once it exists).
const scratch = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock('../lib/prisma', () => ({
  prisma: new Proxy({}, { get: (_t, key) => (scratch.client as Record<PropertyKey, unknown>)[key] }),
}));

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const PRISMA_DIR = join(__dirname, '..', '..', 'prisma');
const MIGRATION_SQL = join(PRISMA_DIR, 'migrations', PRESET_MIGRATION_NAME, 'migration.sql');
const PRISMA_CLI = join(dirname(require.resolve('prisma/package.json')), 'build', 'index.js');

function assertLocal(raw: string): URL {
  const u = new URL(raw);
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname)) {
    throw new Error(`Preset migration suite creates and drops databases; refusing non-local host ${u.hostname}`);
  }
  return u;
}

// One factory, typed as what it returns (see payment-ledger-states-migration-db.test.ts for why).
function clientAt(dbUrl: string) {
  return new PrismaClient({ datasources: { db: { url: dbUrl } } });
}
type Db = ReturnType<typeof clientAt>;

// The condition templates the old Roles editor wrote, as they were stored.
const USER = '{{userId}}';
const OWN_LEAD = { lead_assignees: { some: { user_id: USER } } };
const CREW = { visits: { some: { assignees: { some: { user_id: USER } } } } };
const SHAPE = {
  jobDefault: { estimate: { lead: OWN_LEAD } },
  jobCrew: CREW,
  jobPreVisitCrew: { assignees: { some: { user_id: USER } } },
  estimateDefault: { OR: [{ lead: OWN_LEAD }, { AND: [{ lead_id: null }, { created_by: USER }] }] },
  invoiceDefault: { job: { estimate: { lead: OWN_LEAD } } },
  invoiceCrew: { job: CREW },
  jobCrewOrCreator: { OR: [CREW, { created_by_id: USER }] },
  unknown: { created_by: USER },
};

// Names that must never show in anything the checks print.
const SECRET_NAMES = ['Zedquill', 'Ottoline'];

suite('the preset migration (real database)', () => {
  const server = url ? assertLocal(url) : new URL('postgresql://localhost/unused');
  const admin = clientAt(url ?? '');
  const databases: string[] = [];
  const clients: Db[] = [];
  const tempDirs: string[] = [];

  async function createDatabase(): Promise<{ dbUrl: string; client: Db }> {
    const name = `s0122_mig_${randomUUID().slice(0, 8)}`;
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    databases.push(name);
    const u = new URL(server.toString());
    u.pathname = `/${name}`;
    const dbUrl = u.toString();
    const client = clientAt(dbUrl);
    clients.push(client);
    return { dbUrl, client };
  }

  function cli(dbUrl: string, args: string[], cwd: string) {
    return spawnSync(process.execPath, [PRISMA_CLI, ...args], {
      cwd,
      env: { ...process.env, DATABASE_URL: dbUrl, DIRECT_URL: dbUrl },
      encoding: 'utf8',
    });
  }

  /** The Prisma deploy command over only the migrations before this one, or through this one and no later (see migration-deploy-support). */
  const deploy = (dbUrl: string, which: 'before' | 'through') => deployMigrations(dbUrl, PRESET_MIGRATION_NAME, which, tempDirs);

  /** The migration file run a second time, the way the shared staging database may see it. */
  function runFileAgain(dbUrl: string, dir: string) {
    return cli(dbUrl, ['db', 'execute', '--url', dbUrl, '--file', MIGRATION_SQL], dir);
  }

  // ─── Fixtures (raw SQL: the live client reads every mapped column, which an older scratch schema may lack) ─────────

  async function newOrg(db: Db): Promise<string> {
    const id = randomUUID();
    const tag = id.slice(0, 8);
    await db.$executeRawUnsafe(
      `INSERT INTO organizations (id, name, email, address_line1, city, state, postal_code, estimate_terms, estimate_notes, estimate_payment_terms, plan, updated_at)
       VALUES ('${id}', 'org-${tag}', 'org-${tag}@example.test', '1 Test Way', 'Testville', 'MA', '02108', '', '', '', 'SCALE', now())`,
    );
    return id;
  }
  async function newUser(db: Db, org: string, name: string, role: string, opts: { customRoleId?: string; active?: boolean } = {}): Promise<string> {
    const id = randomUUID();
    await db.$executeRawUnsafe(
      `INSERT INTO users (id, organization_id, email, first_name, last_name, role, custom_role_id, is_active, updated_at)
       VALUES ('${id}', '${org}', '${name.toLowerCase()}-${id.slice(0, 8)}@example.test', '${name}', 'Tester', '${role}'::"Role",
               ${opts.customRoleId ? `'${opts.customRoleId}'` : 'NULL'}, ${opts.active === false ? 'false' : 'true'}, now())`,
    );
    return id;
  }
  async function newCustomRole(db: Db, org: string, key: string, base: string, opts: { blank?: boolean } = {}): Promise<string> {
    const id = randomUUID();
    await db.$executeRawUnsafe(
      `INSERT INTO custom_roles (id, organization_id, key, label, base_role, made_from_blank, updated_at)
       VALUES ('${id}', '${org}', '${key}', '${key}', '${base}'::"Role", ${opts.blank ? 'true' : 'false'}, now())`,
    );
    return id;
  }
  async function grant(db: Db, org: string, role: string, action: string, subject: string, conditions: unknown = null) {
    // A SQL NULL is a row with no condition; the JSON null the repair migrations once wrote is passed as the string 'null'.
    const value = conditions === null ? 'NULL' : `'${JSON.stringify(conditions).replace(/'/g, "''")}'::jsonb`;
    await db.$executeRawUnsafe(
      `INSERT INTO role_permissions (id, organization_id, role, action, subject, conditions, updated_at)
       VALUES (gen_random_uuid(), '${org}', '${role}', '${action}', '${subject}', ${value}, now())`,
    );
  }
  async function storedRoleSwitch(db: Db, org: string, role: string, key: string, value: SwitchValue) {
    await db.$executeRawUnsafe(
      `INSERT INTO permission_role_switches (id, organization_id, role_key, switch_key, value, updated_at)
       VALUES (gen_random_uuid(), '${org}', '${role}', '${key}', '${JSON.stringify(value)}'::jsonb, now())`,
    );
  }

  /** One organization per case the migration has to tell apart; returns every id the assertions need. */
  async function seed(db: Db) {
    // Sales on today's defaults, with a person who holds a per-person entry and a pinned value.
    const orgDefault = await newOrg(db);
    await grant(db, orgDefault, 'SALES', 'read', 'Job', SHAPE.jobDefault);
    await grant(db, orgDefault, 'SALES', 'read', 'Estimate', SHAPE.estimateDefault);
    await grant(db, orgDefault, 'SALES', 'read', 'Invoice', SHAPE.invoiceDefault);
    await grant(db, orgDefault, 'SALES', 'read', 'Lead', OWN_LEAD);
    const adminBox = await newUser(db, orgDefault, 'Zedquill', 'ADMIN');
    const salesWithEntries = await newUser(db, orgDefault, 'Ottoline', 'SALES');
    const technician = await newUser(db, orgDefault, 'Tess', 'TECHNICIAN');
    const dispatcher = await newUser(db, orgDefault, 'Dee', 'DISPATCHER');
    const inactiveSales = await newUser(db, orgDefault, 'Ina', 'SALES', { active: false });
    await db.$executeRawUnsafe(
      `INSERT INTO user_permission_overrides (id, organization_id, user_id, action, subject, effect, updated_at)
       VALUES (gen_random_uuid(), '${orgDefault}', '${salesWithEntries}', 'update', 'Job', 'allow', now())`,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO permission_user_switches (id, organization_id, user_id, switch_key, value, updated_at)
       VALUES (gen_random_uuid(), '${orgDefault}', '${salesWithEntries}', 'view_jobs', 'false'::jsonb, now())`,
    );

    // An unconditioned invoice read (a SQL null and a JSON null), and a hand-made create-customer row.
    const orgAll = await newOrg(db);
    await grant(db, orgAll, 'SALES', 'read', 'Job', SHAPE.jobDefault);
    await grant(db, orgAll, 'SALES', 'read', 'Invoice', null);
    await grant(db, orgAll, 'SALES', 'create', 'Customer', null);
    await db.$executeRawUnsafe(
      `INSERT INTO role_permissions (id, organization_id, role, action, subject, conditions, updated_at)
       VALUES (gen_random_uuid(), '${orgAll}', 'SALES', 'read', 'Estimate', 'null'::jsonb, now())`,
    );
    const salesAll = await newUser(db, orgAll, 'Sam', 'SALES');

    // The crew-only shapes, and a shape nobody knows.
    const orgCrew = await newOrg(db);
    await grant(db, orgCrew, 'SALES', 'read', 'Job', SHAPE.jobCrew);
    await grant(db, orgCrew, 'SALES', 'read', 'Invoice', SHAPE.invoiceCrew);
    await grant(db, orgCrew, 'SALES', 'read', 'Estimate', SHAPE.unknown);
    const orgPreVisit = await newOrg(db);
    await grant(db, orgPreVisit, 'SALES', 'read', 'Job', SHAPE.jobPreVisitCrew);

    // The hand-made technician rows of an organization that widened its technicians' reach.
    const orgHandMade = await newOrg(db);
    await grant(db, orgHandMade, 'TECHNICIAN', 'read', 'Invoice', null);
    await grant(db, orgHandMade, 'TECHNICIAN', 'create', 'Customer', null);
    await grant(db, orgHandMade, 'TECHNICIAN', 'read', 'PurchaseOrder', null);
    const handMadeTechnician = await newUser(db, orgHandMade, 'Hank', 'TECHNICIAN');

    // An organization with no role rows at all: only the presets can speak for it.
    const orgBare = await newOrg(db);
    const bareTechnician = await newUser(db, orgBare, 'Bea', 'TECHNICIAN');

    // Custom roles.
    const orgCustom = await newOrg(db);
    const bundleRole = await newCustomRole(db, orgCustom, 'bundle', 'SALES');
    for (const [a, s, c] of [
      ['read', 'Customer', null], ['read', 'Job', null], ['read', 'Invoice', null], ['read', 'User', null], ['read', 'Lead', OWN_LEAD],
      ['record_payment', 'Invoice', null], ['record_payment', 'Estimate', null],
      ['create', 'User', null], ['submit', 'LogisticOrder', null], ['schedule_walkthrough', 'Lead', null],
      ['cancel', 'Lead', null], ['read', 'Dashboard', null],
    ] as const) await grant(db, orgCustom, 'bundle', a, s, c);
    const refundRole = await newCustomRole(db, orgCustom, 'refunder', 'DISPATCHER');
    for (const [a, s] of [['read', 'Invoice'], ['refund', 'Invoice'], ['update', 'Invoice']] as const) await grant(db, orgCustom, 'refunder', a, s);
    // The crew-or-creator read the Technician default writes: the old editor's "Owned".
    await grant(db, orgCustom, 'refunder', 'read', 'Job', SHAPE.jobCrewOrCreator);
    // create-user without View users: the switch needs View users, so it cannot be kept on.
    const needyRole = await newCustomRole(db, orgCustom, 'needy', 'SALES');
    await grant(db, orgCustom, 'needy', 'create', 'User');
    // A role made on the switch store already: never translated again.
    const storedRole = await newCustomRole(db, orgCustom, 'on-the-store', 'TECHNICIAN');
    await storedRoleSwitch(db, orgCustom, 'on-the-store', 'view_jobs', true);
    await grant(db, orgCustom, 'on-the-store', 'read', 'Invoice');
    const emptyRole = await newCustomRole(db, orgCustom, 'empty', 'TECHNICIAN');
    const blankRole = await newCustomRole(db, orgCustom, 'blank', 'SALES', { blank: true });
    const bundlePerson = await newUser(db, orgCustom, 'Bob', 'SALES', { customRoleId: bundleRole });
    const refundPerson = await newUser(db, orgCustom, 'Rae', 'DISPATCHER', { customRoleId: refundRole });
    const needyPerson = await newUser(db, orgCustom, 'Ned', 'SALES', { customRoleId: needyRole });
    const storedPerson = await newUser(db, orgCustom, 'Stan', 'TECHNICIAN', { customRoleId: storedRole });
    const emptyPerson = await newUser(db, orgCustom, 'Emi', 'TECHNICIAN', { customRoleId: emptyRole });
    const blankPerson = await newUser(db, orgCustom, 'Bly', 'SALES', { customRoleId: blankRole });
    // An admin-based custom role: not the Admin box, so it is filled like anyone else.
    const adminCopyRole = await newCustomRole(db, orgCustom, 'admin-copy', 'ADMIN');
    await grant(db, orgCustom, 'admin-copy', 'read', 'Job');
    const adminCopyPerson = await newUser(db, orgCustom, 'Ada', 'ADMIN', { customRoleId: adminCopyRole });
    const customBox = await newUser(db, orgCustom, 'Boxy', 'ADMIN');

    return {
      orgs: { orgDefault, orgAll, orgCrew, orgPreVisit, orgHandMade, orgBare, orgCustom },
      people: {
        adminBox, salesWithEntries, technician, dispatcher, inactiveSales, salesAll, handMadeTechnician, bareTechnician,
        bundlePerson, refundPerson, needyPerson, storedPerson, emptyPerson, blankPerson, adminCopyPerson, customBox,
      },
      roles: { bundleRole, refundRole, needyRole, storedRole, emptyRole, blankRole, adminCopyRole },
    };
  }
  type Seed = Awaited<ReturnType<typeof seed>>;

  // ─── Reading the result ─────────────────────────────────────────────────────────────────────────────────────────

  const roleSet = async (db: Db, org: string, role: string): Promise<Record<string, unknown>> => {
    const rows = await db.$queryRawUnsafe<Array<{ switch_key: string; value: unknown }>>(
      `SELECT switch_key, value FROM permission_role_switches WHERE organization_id = '${org}' AND role_key = '${role}'`,
    );
    return Object.fromEntries(rows.map((r) => [r.switch_key, r.value]));
  };
  const personSet = async (db: Db, user: string): Promise<Record<string, unknown>> => {
    const rows = await db.$queryRawUnsafe<Array<{ switch_key: string; value: unknown }>>(
      `SELECT switch_key, value FROM permission_user_switches WHERE user_id = '${user}'`,
    );
    return Object.fromEntries(rows.map((r) => [r.switch_key, r.value]));
  };
  const basedOn = async (db: Db, user: string) =>
    (await db.$queryRawUnsafe<Array<{ based_on_role_key: string | null }>>(`SELECT based_on_role_key FROM users WHERE id = '${user}'`))[0]!.based_on_role_key;
  const count = async (db: Db, table: string) =>
    Number((await db.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM ${table}`))[0]!.n);
  /** Everything the migration can touch, fingerprinted, so "changes nothing" is a comparison of two strings. */
  const fingerprint = async (db: Db) =>
    (await db.$queryRawUnsafe<Array<{ f: string }>>(
      `SELECT md5(
         (SELECT COALESCE(string_agg(organization_id || role_key || switch_key || value::text || updated_at::text, ',' ORDER BY organization_id, role_key, switch_key), '') FROM permission_role_switches) ||
         (SELECT COALESCE(string_agg(user_id::text || switch_key || value::text || updated_at::text, ',' ORDER BY user_id, switch_key), '') FROM permission_user_switches) ||
         (SELECT COALESCE(string_agg(id::text, ',' ORDER BY id), '') FROM permission_change_log) ||
         (SELECT COALESCE(string_agg(id::text || COALESCE(based_on_role_key, '-'), ',' ORDER BY id), '') FROM users)
       ) AS f`,
    ))[0]!.f;

  // What the migration wrote, frozen: the live catalog keeps growing after it, so it cannot stand for "every switch
  // the migration wrote" (see presetMigrationSnapshot.ts; preset-migration-snapshot.test.ts ties it to the SQL).
  const snapshot = loadPresetMigrationSnapshot();
  const catalogKeys = snapshot.switches.map((s) => s.key).sort();
  /** The preset a built-in role starts from, as the migration wrote it (JSON). */
  const preset = (role: (typeof BUILT_IN_ROLES)[number]) => ({ ...snapshot.presets[role]! }) as Record<string, unknown>;

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const c of clients) await quietly(c.$disconnect());
    for (const name of databases) await quietly(admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    await admin.$disconnect();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  // One scratch database serves every case: the fixtures are separate organizations, and the cases that need the
  // migration applied read the same result.
  let state:
    | {
        dbUrl: string; client: Db; dir: string; seeded: Seed;
        baselineDry: Awaited<ReturnType<typeof dryRunReport>>;
        beforeDry: Awaited<ReturnType<typeof dryRunReport>>;
        beforeProof: Awaited<ReturnType<typeof proofReport>>;
        beforeCounts: { roleRows: number; userRows: number; logRows: number; organizations: number };
        afterCounts: { roleRows: number; userRows: number; logRows: number };
        afterFirstRun: string;
        secondRun: { status: number | null; stderr: string; after: string };
        afterDry: Awaited<ReturnType<typeof dryRunReport>>;
      }
    | undefined;

  async function migrated() {
    if (state) return state;
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');
    // What the scratch database already holds (the demo organization the migrations seed), before the fixtures.
    const baselineDry = await dryRunReport(client);
    const seeded = await seed(client);
    const beforeCounts = {
      roleRows: await count(client, 'permission_role_switches'),
      userRows: await count(client, 'permission_user_switches'),
      logRows: await count(client, 'permission_change_log'),
      organizations: await count(client, 'organizations'),
    };
    const beforePrint = await fingerprint(client);
    const beforeDry = await dryRunReport(client);
    const beforeProof = await proofReport(client);
    expect(await fingerprint(client), 'the dry run and the proof wrote nothing').toBe(beforePrint);

    const dir = deploy(dbUrl, 'through');
    const afterCounts = {
      roleRows: (await count(client, 'permission_role_switches')) - beforeCounts.roleRows,
      userRows: (await count(client, 'permission_user_switches')) - beforeCounts.userRows,
      logRows: (await count(client, 'permission_change_log')) - beforeCounts.logRows,
    };
    // The file run again, the way the shared staging database may see it: nothing may move.
    const afterFirstRun = await fingerprint(client);
    const again = runFileAgain(dbUrl, dir);
    const secondRun = { status: again.status, stderr: again.stderr, after: await fingerprint(client) };
    const afterDry = await dryRunReport(client);
    state = { dbUrl, client, dir, seeded, baselineDry, beforeDry, beforeProof, beforeCounts, afterCounts, afterFirstRun, secondRun, afterDry };
    return state;
  }

  it('writes the four built-in presets of every organization from the catalog, switch by switch', async () => {
    const { client, seeded } = await migrated();
    for (const org of Object.values(seeded.orgs)) {
      for (const role of BUILT_IN_ROLES) {
        const set = await roleSet(client, org, role);
        expect(Object.keys(set).sort(), `${role} holds a row for every switch`).toEqual(catalogKeys);
        // Sales' three record scopes are read from its old rows; every other value is the catalog's.
        const expected = preset(role);
        const scopes = ['jobs_scope', 'estimates_scope', 'invoices_scope'];
        for (const key of catalogKeys) {
          if (role === 'SALES' && scopes.includes(key)) continue;
          expect(set[key], `${role} ${key}`).toEqual(expected[key]);
        }
        expect(set.leads_scope, `${role} leads scope`).toEqual(expected.leads_scope);
      }
    }
    // Every kind of switch is among them: a choice, a list and plain on/off.
    const kinds = new Set(snapshot.switches.map((s) => s.kind));
    expect([...kinds].sort()).toEqual(['choice', 'list', 'toggle']);
  }, 300_000);

  it('maps Sales\' Jobs, Estimates and Invoices from its read rows and Leads to Attached', async () => {
    const { client, seeded } = await migrated();
    const sales = (org: string) => roleSet(client, org, 'SALES');
    // Today's default -> Through own leads, on all three.
    expect(await sales(seeded.orgs.orgDefault)).toMatchObject({
      jobs_scope: 'through_own_leads', estimates_scope: 'through_own_leads', invoices_scope: 'through_own_leads', leads_scope: 'attached',
    });
    // No condition (a SQL null, and the JSON null an old repair wrote) -> All; the default stays Through own leads.
    expect(await sales(seeded.orgs.orgAll)).toMatchObject({
      jobs_scope: 'through_own_leads', estimates_scope: 'all', invoices_scope: 'all', leads_scope: 'attached',
    });
    // Crew-only "Owned" -> Attached (both the visit shape and the pre-visit shape); anything else -> Through own leads.
    expect(await sales(seeded.orgs.orgCrew)).toMatchObject({
      jobs_scope: 'attached', invoices_scope: 'attached', estimates_scope: 'through_own_leads',
    });
    expect(await sales(seeded.orgs.orgPreVisit)).toMatchObject({ jobs_scope: 'attached' });
    // No Sales rows at all: the preset.
    expect(await sales(seeded.orgs.orgBare)).toMatchObject({ jobs_scope: 'through_own_leads', leads_scope: 'attached' });
  }, 300_000);

  it('keeps Reopen leads on for Sales and ends with Edit job line items on for Technician, in the role and in the person', async () => {
    const { client, seeded } = await migrated();
    for (const org of Object.values(seeded.orgs)) {
      expect((await roleSet(client, org, 'SALES')).reopen_leads).toBe(true);
      expect((await roleSet(client, org, 'TECHNICIAN')).edit_job_line_items).toBe(true);
    }
    expect((await personSet(client, seeded.people.salesWithEntries)).reopen_leads).toBe(true);
    expect((await personSet(client, seeded.people.technician)).edit_job_line_items).toBe(true);
  }, 300_000);

  it('stores no value for a switch the catalog does not hold, so no dashboard, timeclock settings or Cancel leads value lands', async () => {
    const { client } = await migrated();
    const stray = await client.$queryRawUnsafe<Array<{ switch_key: string }>>(
      `SELECT DISTINCT switch_key FROM (SELECT switch_key FROM permission_role_switches UNION SELECT switch_key FROM permission_user_switches) s
       WHERE switch_key NOT IN (${catalogKeys.map((k) => `'${k}'`).join(', ')})`,
    );
    expect(stray).toEqual([]);
    const retired = await client.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*) AS n FROM permission_role_switches WHERE switch_key ~ '(dashboard|timeclock|cancel_leads)'`,
    );
    expect(Number(retired[0]!.n)).toBe(0);
  }, 300_000);

  it('fills every non-admin person from their role alone, ignores their per-person entries, and leaves the Admin box untouched', async () => {
    const { client, seeded } = await migrated();
    const { people, orgs } = seeded;
    // Built-in roles: the person's set is exactly the role's.
    expect(await personSet(client, people.technician)).toEqual(preset('TECHNICIAN'));
    expect(await personSet(client, people.dispatcher)).toEqual(preset('DISPATCHER'));
    expect(await personSet(client, people.handMadeTechnician)).toEqual(preset('TECHNICIAN'));
    expect(await personSet(client, people.bareTechnician)).toEqual(preset('TECHNICIAN'));
    expect(await basedOn(client, people.technician)).toBe('TECHNICIAN');
    expect(await basedOn(client, people.dispatcher)).toBe('DISPATCHER');
    // A person with a pinned value and a per-person entry: back to their role (view_jobs was pinned off).
    const sales = await personSet(client, people.salesWithEntries);
    expect(sales).toEqual(await roleSet(client, orgs.orgDefault, 'SALES'));
    expect(sales.view_jobs).toBe(true);
    // An inactive person is filled too (they may come back).
    expect(await personSet(client, people.inactiveSales)).toEqual(await roleSet(client, orgs.orgDefault, 'SALES'));
    // Custom roles: the person's set is the (translated) role's.
    for (const [person, org, role] of [
      [people.bundlePerson, orgs.orgCustom, 'bundle'], [people.refundPerson, orgs.orgCustom, 'refunder'],
      [people.needyPerson, orgs.orgCustom, 'needy'], [people.emptyPerson, orgs.orgCustom, 'empty'],
      [people.blankPerson, orgs.orgCustom, 'blank'], [people.adminCopyPerson, orgs.orgCustom, 'admin-copy'],
    ] as const) {
      expect(await personSet(client, person), role).toEqual(await roleSet(client, org, role));
      expect(await basedOn(client, person), role).toBe(role);
    }
    // The Admin box has no set and no based-on role.
    for (const box of [people.adminBox, people.customBox]) {
      expect(await personSet(client, box)).toEqual({});
      expect(await basedOn(client, box)).toBeNull();
    }
  }, 300_000);

  it('translates a custom role from its grants through the catalog, and drops a grant no switch stands for', async () => {
    const { client, seeded } = await migrated();
    const org = seeded.orgs.orgCustom;
    const bundle = await roleSet(client, org, 'bundle');
    // The payments bundle -> Record payments; no refund grant -> Refund payments off.
    expect(bundle).toMatchObject({ record_payments: true, refund_payments: false });
    // create-user -> Create users and Invite users; the submit grant adds no logistic-order power; walkthrough booking kept.
    expect(bundle).toMatchObject({ create_users: true, invite_users: true, create_logistic_orders: false, book_walkthroughs: true });
    // Reads and scopes come from the read rows: unconditioned Jobs -> All; the lead shape -> Attached.
    expect(bundle).toMatchObject({ view_customers: true, view_jobs: true, jobs_scope: 'all', leads_scope: 'attached', view_leads: true });
    // What it never held is off.
    expect(bundle).toMatchObject({ delete_jobs: false, access_reports: false });
    // The refund grant -> Refund payments on, Record payments off.
    expect(await roleSet(client, org, 'refunder')).toMatchObject({
      refund_payments: true, record_payments: false, view_invoices: true, edit_invoices: true, view_jobs: true, jobs_scope: 'attached',
    });
    // A role with no old grants: every grant-backed switch off, the rest from its base preset (then settled).
    const empty = await roleSet(client, org, 'empty');
    expect(empty).toMatchObject({ view_jobs: false, view_customers: false, edit_job_line_items: false });
    // Dropped grants set no value: there is no key for the dashboard or cancel lead.
    expect(Object.keys(bundle).sort()).toEqual(catalogKeys);
    // A role made from blank starts from the narrowest value for a switch no old grant speaks for.
    expect(await roleSet(client, org, 'blank')).toMatchObject({ communication_scope: 'linked_to_me', inventory_view: 'counter', restrict_stock_to_own_van: false });
    // A role on the switch store already is left exactly as it is (one row), and its people resolve through it.
    expect(await roleSet(client, org, 'on-the-store')).toEqual({ view_jobs: true });
  }, 300_000);

  it('turns a switch off when the switch it needs is off, so every stored set passes the catalog validator', async () => {
    const { client, seeded } = await migrated();
    const needy = await roleSet(client, seeded.orgs.orgCustom, 'needy');
    // Create users needs View users, which this role never held.
    expect(needy).toMatchObject({ view_users: false, create_users: false, invite_users: false });
    const sets: Array<[string, Record<string, unknown>]> = [];
    for (const org of Object.values(seeded.orgs)) {
      for (const role of BUILT_IN_ROLES) sets.push([`${org} ${role}`, await roleSet(client, org, role)]);
    }
    for (const role of ['bundle', 'refunder', 'needy', 'empty', 'blank', 'admin-copy']) {
      sets.push([role, await roleSet(client, seeded.orgs.orgCustom, role)]);
    }
    for (const [name, set] of sets) {
      // The migration is frozen history and predates "Refund payments needs View payments and payouts" (payments
      // go-live P8); that one later-added need is checked by permission-refund-requires-view-payments.test.ts.
      const laterNeed = (v: { switchKey: string; needs: string[] }) => v.switchKey === 'refund_payments' && v.needs.join() === 'view_payments';
      // Likewise it predates "Create needs Edit" (AL-04): a Create it writes on beside an Edit it writes off is moved by the
      // follow-up migration 20261028100300 (M7), checked by permission-create-requires-edit-migration-db.test.ts.
      const createNeedsEdit = (v: { switchKey: string; needs: string[] }) => v.switchKey.startsWith('create_') && v.needs.length > 0 && v.needs.every((n) => n.startsWith('edit_'));
      // And it predates the scope switches (AL-08): the See-all toggles it wrote and "Linked to me" are carried to their scope
      // switch by the follow-up migration 20261028100500 (M9a), checked by permission-reach-scope-migration-db.test.ts.
      const retiredKey = (v: { switchKey: string }) => retiredByFollowUp(v.switchKey) || renamedSwitchKey(v.switchKey) !== undefined;
      // And it predates the money root (AL-05): a switch that now needs See prices, and See financial data (now See costs).
      const needsSeePrices = (v: { needs: string[] }) => v.needs.includes('see_prices');
      const oldScopeSpelling = (v: { switchKey: string }) => v.switchKey === 'communication_scope' && set.communication_scope === 'linked_to_me';
      expect(validateSwitchSet(set as Record<string, SwitchValue>).filter((v) => !laterNeed(v) && !createNeedsEdit(v) && !retiredKey(v) && !oldScopeSpelling(v) && !needsSeePrices(v)), name).toEqual([]);
    }
  }, 300_000);

  it('writes every change to the change log with the reason migration, and logs nothing for a value that does not change', async () => {
    const { client, seeded } = await migrated();
    const log = await client.$queryRawUnsafe<
      Array<{ target_type: string; target_id: string; switch_key: string; from_value: unknown; to_value: unknown; reason: string; actor_id: string | null }>
    >(`SELECT target_type, target_id, switch_key, from_value, to_value, reason, actor_id FROM permission_change_log`);
    expect(log.length).toBeGreaterThan(0);
    for (const row of log) {
      expect(row.reason).toBe('migration');
      expect(row.actor_id).toBeNull();
      expect(row.from_value).not.toEqual(row.to_value);
    }
    const entry = (type: string, id: string, key: string) => log.find((l) => l.target_type === type && l.target_id === id && l.switch_key === key);
    // Sales' invoices scope moved from its preset to All in one organization: the role's log says so.
    const orgRows = await client.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*) AS n FROM permission_change_log WHERE organization_id = '${seeded.orgs.orgAll}' AND target_type = 'ROLE'
         AND target_id = 'SALES' AND switch_key = 'invoices_scope' AND from_value = '"through_own_leads"'::jsonb AND to_value = '"all"'::jsonb`,
    );
    expect(Number(orgRows[0]!.n)).toBe(1);
    // A person on a translated custom role: Record payments went from the Sales preset (off) to on.
    expect(entry('USER', seeded.people.bundlePerson, 'record_payments')).toMatchObject({ from_value: false, to_value: true });
    // A technician on the plain preset changed nothing, so has no entry.
    expect(log.filter((l) => l.target_type === 'USER' && l.target_id === seeded.people.technician)).toEqual([]);
    expect(log.filter((l) => l.target_type === 'USER' && l.target_id === seeded.people.adminBox)).toEqual([]);
  }, 300_000);

  it('previews exactly what the run then does: the dry run counts equal the rows written', async () => {
    const { beforeDry, afterCounts, beforeCounts } = await migrated();
    expect(beforeDry.organizations).toBe(beforeCounts.organizations);
    expect(beforeDry.totals.roleRowsToWrite).toBe(afterCounts.roleRows);
    expect(beforeDry.totals.personRowsToWrite).toBeGreaterThan(0);
    // The stray pinned row is replaced, not added, so the net new person rows are one fewer than the rows written.
    expect(afterCounts.userRows).toBe(beforeDry.totals.personRowsToWrite - 1);
    expect(beforeDry.totals.logEntries).toBe(afterCounts.logRows);
    expect(beforeDry.customRoles.translated).toBe(6);
    expect(beforeDry.customRoles.alreadyOnSwitches).toBe(1);
  }, 300_000);

  it('lists in the dry run the Sales mapping cases, the unknown shape, the ignored entries, the dropped grants and the translated roles', async () => {
    const { beforeDry, baselineDry, seeded } = await migrated();
    // Sales cases over every organization: what the scratch database held already, plus the fixtures.
    const added = (key: string, kind: 'default' | 'all' | 'crew_only' | 'unknown_shape') =>
      beforeDry.salesScope[key]![kind] - baselineDry.salesScope[key]![kind];
    expect(['default', 'all', 'crew_only', 'unknown_shape'].map((k) => added('jobs_scope', k as 'default'))).toEqual([2, 0, 2, 0]);
    expect(['default', 'all', 'crew_only', 'unknown_shape'].map((k) => added('estimates_scope', k as 'default'))).toEqual([1, 1, 0, 1]);
    expect(['default', 'all', 'crew_only', 'unknown_shape'].map((k) => added('invoices_scope', k as 'default'))).toEqual([1, 1, 1, 0]);
    expect(beforeDry.salesUnknownShapes).toEqual([{ organization_id: seeded.orgs.orgCrew, switch_key: 'estimates_scope' }]);
    expect(beforeDry.ignoredOverrides).toEqual([
      expect.objectContaining({ organization_id: seeded.orgs.orgDefault, user_id: seeded.people.salesWithEntries, action: 'update', subject: 'Job', effect: 'allow' }),
    ]);
    const dropped = beforeDry.dropped.filter((d) => d.custom_role_id === seeded.roles.bundleRole).map((d) => `${d.action} ${d.subject}`).sort();
    expect(dropped).toEqual(['cancel Lead', 'read Dashboard']);
    const lines = formatDryRunReport(beforeDry).join('\n');
    expect(lines).toContain(`custom role ${seeded.roles.bundleRole} cancel Lead`);
    expect(lines).toContain(`organization ${seeded.orgs.orgCrew} estimates_scope`);
  }, 300_000);

  it('prints ids and counts only: no name, email or database URL, in any of the three checks', async () => {
    const { client, dbUrl, seeded } = await migrated();
    // Corrupt one stored value so the drift report has something to print.
    await client.$executeRawUnsafe(
      `UPDATE permission_role_switches SET value = 'false'::jsonb WHERE organization_id = '${seeded.orgs.orgBare}' AND role_key = 'TECHNICIAN' AND switch_key = 'record_payments'`,
    );
    const text = [
      ...formatDryRunReport(await dryRunReport(client)),
      ...formatProofReport(await proofReport(client)),
      ...formatDriftReport(await driftReport(client)),
    ].join('\n');
    for (const name of SECRET_NAMES) expect(text.toLowerCase()).not.toContain(name.toLowerCase());
    expect(text).not.toContain('@example.test');
    expect(text).not.toContain(dbUrl);
    expect(text).not.toMatch(/postgres(ql)?:\/\//);
    await client.$executeRawUnsafe(
      `UPDATE permission_role_switches SET value = 'true'::jsonb WHERE organization_id = '${seeded.orgs.orgBare}' AND role_key = 'TECHNICIAN' AND switch_key = 'record_payments'`,
    );
  }, 300_000);

  it('refuses to write from inside a read-only check, and rolls back whatever it opened', async () => {
    const { client } = await migrated();
    const before = await count(client, 'permission_change_log');
    await expect(
      inReadOnlyTransaction(client, (tx) => tx.$executeRawUnsafe(`DELETE FROM permission_change_log`)),
    ).rejects.toThrow(/read-only/i);
    expect(await count(client, 'permission_change_log')).toBe(before);
  }, 300_000);

  it('shows with the proof check that every organization and role holds switch rows, which it did not before', async () => {
    const { client, beforeProof, seeded } = await migrated();
    expect(beforeProof.ok).toBe(false);
    expect(beforeProof.missingRoleRows.length).toBe((await count(client, 'organizations')) * BUILT_IN_ROLES.length);
    const proof = await proofReport(client);
    expect(proof.missingRoleRows).toEqual([]);
    expect(proof.customRoles.withoutRows).toEqual([]);
    expect(proof.people.withoutSet).toEqual([]);
    expect(proof.people.notBasedOnRole).toEqual([]);
    expect(proof.ok).toBe(true);
    for (const role of BUILT_IN_ROLES) expect(proof.builtInRoles[role]).toEqual({ full: proof.organizations, partial: 0, none: 0 });
    expect(proof.people.nonAdmin).toBeGreaterThanOrEqual(Object.keys(seeded.people).length - 2);
    // Take one organization's Technician rows away: the proof names that organization and role.
    await client.$executeRawUnsafe(`DELETE FROM permission_role_switches WHERE organization_id = '${seeded.orgs.orgBare}' AND role_key = 'TECHNICIAN'`);
    const broken = await proofReport(client);
    expect(broken.ok).toBe(false);
    expect(broken.missingRoleRows).toEqual([{ organization_id: seeded.orgs.orgBare, role_key: 'TECHNICIAN', rows: 0 }]);
    await client.$executeRawUnsafe(
      `INSERT INTO permission_role_switches (id, organization_id, role_key, switch_key, value, updated_at)
       SELECT gen_random_uuid(), '${seeded.orgs.orgBare}', 'TECHNICIAN', k, v, now()
       FROM jsonb_each('${JSON.stringify(preset('TECHNICIAN')).replace(/'/g, "''")}'::jsonb) AS e(k, v)`,
    );
    expect((await proofReport(client)).ok).toBe(true);
  }, 300_000);

  /**
   * The drift report without the presets a LATER migration moves (AL-04, 20261028100300): the stored rows hold what this
   * migration wrote, the catalog holds what the follow-up carries them to, and that gap is not drift.
   */
  const withoutFollowUps = <R extends {
    drifted: Array<{ role_key: string; switch_key: string; stored: unknown; preset: unknown }>;
    unknownSwitches: Array<{ switch_key: string }>;
  }>(r: R): R => ({
    ...r,
    drifted: r.drifted.filter((d) => {
      const move = followUpPresetMove(d.role_key, d.switch_key, d.preset as SwitchValue);
      return !(move && sameSwitchValue(move.was, d.stored as SwitchValue));
    }),
    // The stored rows of a switch a later migration retired (AL-08) are that migration's to carry, not unknown switches.
    unknownSwitches: r.unknownSwitches.filter((u) => !retiredByFollowUp(u.switch_key) && renamedSwitchKey(u.switch_key) === undefined),
  });

  it('finds a freshly migrated organization free of drift, and reports an edited built-in role', async () => {
    const { client, seeded } = await migrated();
    const clean = withoutFollowUps(await driftReport(client));
    const inOrg = (org: string) => clean.drifted.filter((d) => d.organization_id === org);
    // Presets only: no drift. The hand-made technician rows changed nothing either.
    expect(inOrg(seeded.orgs.orgBare)).toEqual([]);
    expect(inOrg(seeded.orgs.orgHandMade)).toEqual([]);
    expect(clean.unknownSwitches).toEqual([]);
    // An organization whose Sales rows mapped the Estimates and Invoices scope away from the preset: those two switches are
    // retired now (AL-06b, migration 20261028101000 deletes their rows), so they are no drift.
    expect(inOrg(seeded.orgs.orgAll)).toEqual([]);
    // A catalog preset that no longer matches what is stored is drift: edit one value, and an unknown key too.
    await client.$executeRawUnsafe(
      `UPDATE permission_role_switches SET value = 'true'::jsonb WHERE organization_id = '${seeded.orgs.orgBare}' AND role_key = 'DISPATCHER' AND switch_key = 'delete_jobs'`,
    );
    await client.$executeRawUnsafe(
      `INSERT INTO permission_role_switches (id, organization_id, role_key, switch_key, value, updated_at)
       VALUES (gen_random_uuid(), '${seeded.orgs.orgBare}', 'SALES', 'access_dashboard', 'true'::jsonb, now())`,
    );
    const dirty = withoutFollowUps(await driftReport(client));
    expect(dirty.drifted.filter((d) => d.organization_id === seeded.orgs.orgBare)).toEqual([
      { organization_id: seeded.orgs.orgBare, role_key: 'DISPATCHER', switch_key: 'delete_jobs', stored: true, preset: false },
    ]);
    expect(dirty.unknownSwitches).toEqual([{ organization_id: seeded.orgs.orgBare, role_key: 'SALES', switch_key: 'access_dashboard' }]);
    await client.$executeRawUnsafe(
      `UPDATE permission_role_switches SET value = 'false'::jsonb WHERE organization_id = '${seeded.orgs.orgBare}' AND role_key = 'DISPATCHER' AND switch_key = 'delete_jobs'`,
    );
    await client.$executeRawUnsafe(`DELETE FROM permission_role_switches WHERE switch_key = 'access_dashboard'`);
    expect(withoutFollowUps(await driftReport(client)).drifted.filter((d) => d.organization_id === seeded.orgs.orgBare)).toEqual([]);
  }, 300_000);

  it('lets a switch added after the migration read its preset for every built-in role that holds no row for it', async () => {
    const { client, seeded } = await migrated();
    scratch.client = client;
    const { resolveRoleSwitchValues } = await import('../lib/permissions/switches/store.js');
    const written = new Set(catalogKeys);
    const added = SWITCH_CATALOG.filter((s) => !written.has(s.key));
    expect(added.length, 'the catalog holds a switch the migration did not write').toBeGreaterThan(0);
    for (const org of Object.values(seeded.orgs)) {
      for (const role of BUILT_IN_ROLES) {
        const stored = await roleSet(client, org, role);
        const values = await resolveRoleSwitchValues(org, role, role);
        for (const sw of added) {
          expect(stored, `${role} holds no row for ${sw.key}`).not.toHaveProperty(sw.key);
          expect(values[sw.key], `${role} ${sw.key}`).toEqual(sw.presets[role]);
        }
      }
    }
  }, 300_000);

  it('changes nothing on a second run', async () => {
    const { afterFirstRun, secondRun } = await migrated();
    expect(secondRun.stderr).toBe('');
    expect(secondRun.status).toBe(0);
    expect(secondRun.after).toBe(afterFirstRun);
  }, 300_000);

  it('finds nothing left for the dry run to do once the migration has run', async () => {
    const { afterDry } = await migrated();
    expect(afterDry.totals).toEqual({ roleRowsToWrite: 0, peopleFilled: afterDry.totals.peopleFilled, peopleChanged: 0, personRowsToWrite: 0, logEntries: 0 });
    expect(afterDry.customRoles.translated).toBe(0);
    expect(afterDry.totals.peopleFilled).toBeGreaterThan(0);
  }, 300_000);
});
