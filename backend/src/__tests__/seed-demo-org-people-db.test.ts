/* =============================================================================
   Roles & Permissions, PRD 3, slice S03.20 - the demo-org seed fills lead Dispatchers and job Sold By.

   Runs the real seed script (`npm run seed:demo-org`) against a throwaway migrated database, the way an
   operator runs it against staging, and reads back what the demo shows:
     - leads with a Dispatcher and leads with "No dispatcher";
     - at least one open lead with no Owner (no stored Owner and no mirrored assignee row);
     - jobs with a Sold By, among them a multi-estimate job and a plan visit job;
     - nobody is placed in a slot their built-in role's switch does not allow (read from the switch catalog);
     - a plan visit job carries its plan's "Sold by" and no Dispatcher, a job from a lead carries the lead's Owner;
     - a second run leaves the same picture and touches no other organization.

   Each run builds its own database on the server TEST_DATABASE_URL points at and drops it afterwards. Skips when
   TEST_DATABASE_URL is unset, and REFUSES a non-local host: it creates and drops databases. The Prisma CLI runs
   from a temp directory with DATABASE_URL and DIRECT_URL passed explicitly, so it can never fall back to the
   checkout's .env (the shared staging DB), and so does the seed.
   ========================================================================== */

import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync, copyFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { PrismaClient } from '@prisma/client';
import { createMigrationDatabase, deployFrom } from './migration-deploy-support';
import { SWITCH_CATALOG, type BuiltInRole } from '../lib/permissions/switches/catalog';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const DEMO_ORG = '00000000-0000-0000-0000-000000000001';
const BACKEND_DIR = join(__dirname, '..', '..');
const PRISMA_DIR = join(BACKEND_DIR, 'prisma');
const TSX_CLI = join(dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');

const OPEN_LEAD_STATUSES = ['NEW', 'CONTACTED', 'WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED', 'ESTIMATED'];

function assertLocal(raw: string): URL {
  const u = new URL(raw);
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname)) {
    throw new Error(`demo seed suite creates and drops databases; refusing non-local host ${u.hostname}`);
  }
  return u;
}

// One factory, typed as what it returns (see payment-ledger-states-migration-db.test.ts for why).
function clientAt(dbUrl: string) {
  return new PrismaClient({ datasources: { db: { url: dbUrl } } });
}

/** Whether the built-in role holds the switch out of the box, read from the catalog. */
function presetAllows(role: string, switchKey: string): boolean {
  const entry = SWITCH_CATALOG.find((e) => e.key === switchKey);
  if (!entry) throw new Error(`no switch ${switchKey} in the catalog`);
  return entry.presets[role as BuiltInRole] === true;
}

suite('demo-org seed fills lead Dispatchers and job Sold By (real database)', () => {
  const server = url ? assertLocal(url) : new URL('postgresql://localhost/unused');
  const admin = clientAt(url ?? '');
  const databases: string[] = [];
  const clients: ReturnType<typeof clientAt>[] = [];
  const tempDirs: string[] = [];

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const c of clients) await quietly(c.$disconnect());
    for (const name of databases) await quietly(admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    await admin.$disconnect();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  /** A migrated database holding the demo org's staff and one other organization with a lead. */
  async function migratedDatabase() {
    const name = `s0320_seed_${randomUUID().slice(0, 8)}`;
    // A copy of the run's base, then the rest of the history: the same migrated database the full deploy gives.
    const latest = readdirSync(join(PRISMA_DIR, 'migrations')).filter((e) => e !== 'migration_lock.toml').sort().pop()!;
    await createMigrationDatabase(admin, name, latest, tempDirs);
    databases.push(name);
    const u = new URL(server.toString());
    u.pathname = `/${name}`;
    const dbUrl = u.toString();
    const db = clientAt(dbUrl);
    clients.push(db);

    const dir = mkdtempSync(join(tmpdir(), 's0320-mig-'));
    tempDirs.push(dir);
    copyFileSync(join(PRISMA_DIR, 'schema.prisma'), join(dir, 'schema.prisma'));
    cpSync(join(PRISMA_DIR, 'migrations'), join(dir, 'migrations'), { recursive: true });
    // The shared deploy gives the database the stub auth helpers first (see migration-deploy-support).
    deployFrom(dbUrl, dir);

    // The demo org itself comes from the migrations; the seed never creates users.
    const staff: Array<[string, 'ADMIN' | 'SALES' | 'DISPATCHER' | 'TECHNICIAN']> = [
      ['admin1', 'ADMIN'], ['sales1', 'SALES'], ['sales2', 'SALES'], ['disp1', 'DISPATCHER'], ['disp2', 'DISPATCHER'],
      ['tech1', 'TECHNICIAN'], ['tech2', 'TECHNICIAN'], ['tech3', 'TECHNICIAN'],
    ];
    for (const [handle, role] of staff) {
      await db.user.create({
        data: { organization_id: DEMO_ORG, email: `${handle}@example.test`, first_name: handle, last_name: 'Tester', role },
        select: { id: true },
      });
    }
    // The account `npm run seed` makes. The demo company has no Owner yet, so the demo seed makes this person its Owner (AL-16).
    const seedAdmin = await db.user.create({
      data: { organization_id: DEMO_ORG, email: 'admin@servwave.com', first_name: 'System', last_name: 'Admin', role: 'ADMIN', is_admin: true },
      select: { id: true },
    });

    // Another company the seed must never touch.
    const other = randomUUID();
    await db.organization.create({
      data: {
        id: other, name: 'Other Co', email: 'other@example.test', address_line1: '1 Test Way', city: 'Testville',
        state: 'MA', postal_code: '02108', estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
      },
      select: { id: true },
    });
    const customer = randomUUID();
    await db.customer.create({
      data: { id: customer, organization_id: other, customer_number: 'C-OTHER', kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
      select: { id: true },
    });
    const location = randomUUID();
    await db.serviceLocation.create({
      data: { id: location, customer_id: customer, address_line1: '1 Test Way', city: 'Testville', state: 'MA', zip: '02108' },
      select: { id: true },
    });
    await db.lead.create({
      data: { organization_id: other, customer_id: customer, service_location_id: location, lead_number: 'L-OTHER', service_request: 'Fix the door' },
      select: { id: true },
    });
    return { dbUrl, db, other, seedAdmin: seedAdmin.id };
  }

  function runSeed(dbUrl: string) {
    const run = spawnSync(process.execPath, [TSX_CLI, 'src/seed-demo-org.ts'], {
      cwd: BACKEND_DIR,
      env: { ...process.env, DATABASE_URL: dbUrl, DIRECT_URL: dbUrl, SUPABASE_URL: '', SEED_DEMO_ALPHA: 'true' },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (run.status !== 0) throw new Error(`seed failed:\n${run.stdout}\n${run.stderr}`);
  }

  type Db = ReturnType<typeof clientAt>;
  const count = async (db: Db, sql: string) => Number((await db.$queryRawUnsafe<Array<{ n: bigint }>>(sql))[0]!.n);
  const others = async (db: Db, org: string) => ({
    leads: await count(db, `SELECT count(*) AS n FROM leads WHERE organization_id = '${org}'`),
    customers: await count(db, `SELECT count(*) AS n FROM customers WHERE organization_id = '${org}'`),
    jobs: await count(db, `SELECT count(*) AS n FROM jobs WHERE organization_id = '${org}'`),
    users: await count(db, `SELECT count(*) AS n FROM users WHERE organization_id = '${org}'`),
  });

  /** Everything the acceptance criteria read, after a run. */
  async function picture(db: Db) {
    const org = `'${DEMO_ORG}'`;
    return {
      leads: await count(db, `SELECT count(*) AS n FROM leads WHERE organization_id = ${org}`),
      jobs: await count(db, `SELECT count(*) AS n FROM jobs WHERE organization_id = ${org}`),
      withDispatcher: await count(db, `SELECT count(*) AS n FROM leads WHERE organization_id = ${org} AND dispatcher_id IS NOT NULL`),
      withoutDispatcher: await count(db, `SELECT count(*) AS n FROM leads WHERE organization_id = ${org} AND dispatcher_id IS NULL`),
      openNoOwner: await count(
        db,
        `SELECT count(*) AS n FROM leads l WHERE l.organization_id = ${org} AND l.commission_owner_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM lead_assignees a WHERE a.lead_id = l.id)
           AND l.status::text IN (${OPEN_LEAD_STATUSES.map((s) => `'${s}'`).join(',')})`,
      ),
      jobsWithSoldBy: await count(db, `SELECT count(*) AS n FROM jobs WHERE organization_id = ${org} AND salesperson_id IS NOT NULL`),
    };
  }

  const ownerOfDemo = async (db: Db) =>
    (await db.organization.findUniqueOrThrow({ where: { id: DEMO_ORG }, select: { owner_user_id: true } })).owner_user_id;

  it('fills leads and jobs with the new people fields, only from people the switches allow', async () => {
    const { dbUrl, db, seedAdmin } = await migratedDatabase();
    runSeed(dbUrl);

    // Every company has an Owner (AL-16): the demo company's is the seed admin.
    expect(await ownerOfDemo(db)).toBe(seedAdmin);

    const seen = await picture(db);
    expect(seen.withDispatcher).toBeGreaterThan(0);
    expect(seen.withoutDispatcher).toBeGreaterThan(0);
    expect(seen.openNoOwner).toBeGreaterThanOrEqual(1);
    expect(seen.jobsWithSoldBy).toBeGreaterThan(0);

    // A lead without an Owner has no mirrored assignee row either: the two always travel together.
    expect(
      await count(
        db,
        `SELECT count(*) AS n FROM leads l WHERE l.organization_id = '${DEMO_ORG}' AND l.commission_owner_id IS NULL
           AND EXISTS (SELECT 1 FROM lead_assignees a WHERE a.lead_id = l.id)`,
      ),
    ).toBe(0);

    // Nobody sits in a slot their role's switch keeps closed (expected values come from the catalog).
    const people = await db.$queryRawUnsafe<Array<{ id: string; role: string }>>(`SELECT id, role::text AS role FROM users WHERE organization_id = '${DEMO_ORG}'`);
    const roleOf = new Map(people.map((p) => [p.id, p.role]));
    const leadDispatchers = await db.$queryRawUnsafe<Array<{ id: string }>>(`SELECT DISTINCT dispatcher_id AS id FROM leads WHERE organization_id = '${DEMO_ORG}' AND dispatcher_id IS NOT NULL`);
    for (const { id } of leadDispatchers) expect(presetAllows(roleOf.get(id)!, 'can_be_dispatcher')).toBe(true);
    const sellers = await db.$queryRawUnsafe<Array<{ id: string }>>(`SELECT DISTINCT salesperson_id AS id FROM jobs WHERE organization_id = '${DEMO_ORG}' AND salesperson_id IS NOT NULL`);
    for (const { id } of sellers) expect(presetAllows(roleOf.get(id)!, 'can_own_leads')).toBe(true);

    // A job that came from a lead is sold by that lead's Owner.
    const mismatched = await count(
      db,
      `SELECT count(*) AS n FROM jobs j JOIN estimates e ON e.id = j.estimate_id JOIN leads l ON l.id = e.lead_id
         WHERE j.organization_id = '${DEMO_ORG}' AND j.salesperson_id IS DISTINCT FROM l.commission_owner_id`,
    );
    expect(mismatched).toBe(0);

    // A multi-estimate job: no anchor estimate, its own lead reference, two or more estimates attached, and a Sold By.
    const multi = await db.$queryRawUnsafe<Array<{ id: string; salesperson_id: string | null; owner: string | null }>>(
      `SELECT j.id, j.salesperson_id, l.commission_owner_id AS owner
         FROM jobs j JOIN leads l ON l.id = j.lead_id
        WHERE j.organization_id = '${DEMO_ORG}' AND j.estimate_id IS NULL
          AND (SELECT count(*) FROM estimates e WHERE e.job_id = j.id) >= 2`,
    );
    expect(multi.length).toBeGreaterThanOrEqual(1);
    for (const job of multi) {
      expect(job.salesperson_id).not.toBeNull();
      expect(job.salesperson_id).toBe(job.owner);
    }

    // A plan visit job: carries its plan's "Sold by" and starts with no Dispatcher, and no lead behind it.
    const planJobs = await db.$queryRawUnsafe<Array<{ salesperson_id: string | null; dispatcher_id: string | null; sold_by: string | null; lead_id: string | null }>>(
      `SELECT j.salesperson_id, j.dispatcher_id, p.sold_by, j.lead_id
         FROM jobs j JOIN service_plans p ON p.id = j.source_plan_id
        WHERE j.organization_id = '${DEMO_ORG}'`,
    );
    expect(planJobs.length).toBeGreaterThanOrEqual(1);
    for (const job of planJobs) {
      expect(job.salesperson_id).not.toBeNull();
      expect(job.salesperson_id).toBe(job.sold_by);
      expect(job.dispatcher_id).toBeNull();
      expect(job.lead_id).toBeNull();
    }
    // ...and it is the plan's visit that points back at the job, as scheduling a visit does.
    expect(
      await count(
        db,
        `SELECT count(*) AS n FROM jobs j WHERE j.organization_id = '${DEMO_ORG}' AND j.source_plan_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM plan_visits v WHERE v.job_id = j.id AND v.service_plan_id = j.source_plan_id)`,
      ),
    ).toBe(0);
  }, 240_000);

  it('can be run again: the same picture, and no other organization is touched', async () => {
    const { dbUrl, db, other, seedAdmin } = await migratedDatabase();
    const otherBefore = await others(db, other);
    const staffBefore = await others(db, DEMO_ORG);

    runSeed(dbUrl);
    const first = await picture(db);
    runSeed(dbUrl);
    const second = await picture(db);

    // Counts do not double, and every fact the demo shows is still there.
    expect(second.leads).toBe(first.leads);
    expect(second.jobs).toBe(first.jobs);
    // The Owner the first run set is kept.
    expect(await ownerOfDemo(db)).toBe(seedAdmin);
    expect(second.withDispatcher).toBeGreaterThan(0);
    expect(second.withoutDispatcher).toBeGreaterThan(0);
    expect(second.openNoOwner).toBeGreaterThanOrEqual(1);
    expect(second.jobsWithSoldBy).toBeGreaterThan(0);
    expect(await count(db, `SELECT count(*) AS n FROM jobs WHERE organization_id = '${DEMO_ORG}' AND source_plan_id IS NOT NULL`)).toBeGreaterThanOrEqual(1);

    expect(await others(db, other)).toEqual(otherBefore);
    expect((await others(db, DEMO_ORG)).users).toBe(staffBefore.users);
  }, 360_000);
});
