/* =============================================================================
   Roles & Permissions, PRD 3, slice S03.8 - the one-time Sold By backfill, applied for real.

   Proves against real Postgres, the way Render applies it (the Prisma deploy command), on a prod-shaped
   copy (every migration BEFORE this one, jobs with no Sold By):
     - a job with its own lead reference takes that lead's Owner, ahead of its anchor estimate's lead;
     - a job with only an anchor estimate takes that estimate's lead's Owner;
     - a multi-estimate job (own lead reference, no anchor estimate) takes the lead's Owner;
     - a leadless job, a job whose lead has no Owner, and a plan visit job whose plan names nobody stay empty;
     - a plan visit job takes its plan's "Sold by", never a lead's Owner;
     - the copy is as-is: an Owner who is no longer active is copied too;
     - a job that already has a Sold By keeps it;
     - a second run changes nothing;
     - the run prints per-org counts before writing and proves the rows landed (read through psql, which
       is the one client that shows a notice; that case skips on a machine without it).

   Each case builds its own throwaway database on the server TEST_DATABASE_URL points at and drops it
   afterwards. Skips when TEST_DATABASE_URL is unset, and REFUSES a non-local host: it creates and drops
   databases. The Prisma CLI runs from a temp directory with DATABASE_URL and DIRECT_URL passed
   explicitly, so it can never fall back to the checkout's .env (the shared staging DB).
   ========================================================================== */

import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import { rmSync } from 'fs';
import { dirname, join } from 'path';
import { PrismaClient } from '@prisma/client';
import { deployMigrations, createMigrationDatabase } from './migration-deploy-support';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const MIGRATION = '20261010090000_job_sold_by_backfill';
const PRISMA_DIR = join(__dirname, '..', '..', 'prisma');
const MIGRATION_SQL = join(PRISMA_DIR, 'migrations', MIGRATION, 'migration.sql');
const PRISMA_CLI = join(dirname(require.resolve('prisma/package.json')), 'build', 'index.js');
const hasPsql = spawnSync('psql', ['--version']).status === 0;

function assertLocal(raw: string): URL {
  const u = new URL(raw);
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname)) {
    throw new Error(`Sold By migration suite creates and drops databases; refusing non-local host ${u.hostname}`);
  }
  return u;
}

// One factory, typed as what it returns (see payment-ledger-states-migration-db.test.ts for why).
function clientAt(dbUrl: string) {
  return new PrismaClient({ datasources: { db: { url: dbUrl } } });
}
type Db = ReturnType<typeof clientAt>;

suite('job Sold By backfill migration (real database)', () => {
  const server = url ? assertLocal(url) : new URL('postgresql://localhost/unused');
  const admin = clientAt(url ?? '');
  const databases: string[] = [];
  const clients: Db[] = [];
  const tempDirs: string[] = [];

  async function createDatabase(): Promise<{ dbUrl: string; client: Db }> {
    const name = `s038_mig_${randomUUID().slice(0, 8)}`;
    await createMigrationDatabase(admin, name, MIGRATION, tempDirs);
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
  const deploy = (dbUrl: string, which: 'before' | 'through') => deployMigrations(dbUrl, MIGRATION, which, tempDirs);

  /** The migration file run a second time, the way the shared staging database may see it. */
  function runFileAgain(dbUrl: string, dir: string) {
    return cli(dbUrl, ['db', 'execute', '--url', dbUrl, '--file', MIGRATION_SQL], dir);
  }

  /**
   * One organization with every kind of job the backfill has to tell apart. Returns each job's id with the
   * Sold By it must end up with (null = stays empty).
   */
  async function seed(db: Db) {
    const org = randomUUID();
    const tag = org.slice(0, 8);
    await db.organization.create({
      data: {
        id: org, name: `s038-${tag}`, email: `s038-${tag}@example.test`, address_line1: '1 Test Way', city: 'Testville',
        state: 'MA', postal_code: '02108', estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
      },
      // Narrow: this database sits at an older migration, so the live client must not read back columns added since.
      select: { id: true },
    });
    const user = async (name: string, active = true) => {
      const id = randomUUID();
  // Raw insert: this database holds only the migrations before the one under test, and the client's insert would name later columns (users.is_admin).
      await db.$executeRawUnsafe(
        `INSERT INTO users (id, organization_id, email, first_name, last_name, role, is_active, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, 'Tester', 'SALES'::"Role", $5, now())`,
        id, org, `${name}-${tag}@example.test`, name, active,
      );
      return id;
    };
    const [ownerA, ownerB, planSeller, existing, retired] = [
      await user('ownera'), await user('ownerb'), await user('planseller'), await user('existing'), await user('retired', false),
    ];
    const customer = randomUUID();
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
    });
    const location = randomUUID();
    await db.serviceLocation.create({
      data: { id: location, customer_id: customer, address_line1: '1 Test Way', city: 'Testville', state: 'MA', zip: '02108' },
    });
    let n = 0;
    const lead = async (owner: string | null) => {
      const id = randomUUID();
      await db.lead.create({
        data: { id, organization_id: org, customer_id: customer, lead_number: `L-${tag}-${++n}`, service_request: 'Fix the door', commission_owner_id: owner },
        // This scratch DB sits at the migration before Lead.dispatcher_id exists, so do not read back the full row.
        select: { id: true },
      });
      return id;
    };
    const estimate = async (leadId: string) => {
      const id = randomUUID();
      await db.estimate.create({
        data: {
          id, organization_id: org, customer_id: customer, lead_id: leadId, created_by: ownerA,
          estimate_number: `E-${tag}-${++n}`, subtotal: 100, tax_amount: 0, total_amount: 100,
        },
        // Narrow: this database sits at an older migration, so the live client must not read back columns added since.
        select: { id: true },
      });
      return id;
    };
    const plan = async (soldBy: string | null) => {
      const id = randomUUID();
      await db.servicePlan.create({
        data: {
          id, organization_id: org, customer_id: customer, service_location_id: location, service_plan_number: `SP-${tag}-${++n}`,
          name: 'Quarterly check', visit_cadence: 'WEEKLY', start_date: new Date(), contract_price: 100, sold_by: soldBy,
        },
      });
      return id;
    };
    const job = async (opts: { leadId?: string; estimateId?: string; planId?: string; soldBy?: string }) => {
      const id = randomUUID();
      await db.job.create({
        data: {
          id, organization_id: org, customer_id: customer, service_location_id: location, job_number: `J-${tag}-${++n}`,
          lead_id: opts.leadId ?? null, estimate_id: opts.estimateId ?? null, source_plan_id: opts.planId ?? null,
          salesperson_id: opts.soldBy ?? null,
        },
        // Narrow: this database sits at an older migration, so the live client must not read back columns added since.
        select: { id: true },
      });
      return id;
    };

    const leadA = await lead(ownerA);
    const leadB = await lead(ownerB);
    const leadRetired = await lead(retired);
    const leadNoOwner = await lead(null);
    const planWithSeller = await plan(planSeller);
    const planWithoutSeller = await plan(null);

    const jobs = {
      // the job's own lead reference is read first, ahead of its anchor estimate's lead
      ownLeadFirst: { id: await job({ leadId: leadA, estimateId: await estimate(leadB) }), expect: ownerA },
      anchorOnly: { id: await job({ estimateId: await estimate(leadB) }), expect: ownerB },
      // built from several estimates of one lead: no anchor estimate, but the lead reference is there
      multiEstimate: { id: await job({ leadId: leadA }), expect: ownerA },
      leadless: { id: await job({}), expect: null },
      leadWithoutOwner: { id: await job({ leadId: leadNoOwner }), expect: null },
      // the copy is as-is: no active check
      retiredOwner: { id: await job({ leadId: leadRetired }), expect: retired },
      planVisit: { id: await job({ planId: planWithSeller }), expect: planSeller },
      // a plan visit job takes its plan's seller, never a lead's Owner
      planVisitIgnoresLead: { id: await job({ planId: planWithSeller, leadId: leadA }), expect: planSeller },
      planVisitNobody: { id: await job({ planId: planWithoutSeller, leadId: leadA }), expect: null },
      alreadySet: { id: await job({ leadId: leadA, soldBy: existing }), expect: existing },
    };
    return { org, jobs };
  }

  const soldByOf = async (db: Db, jobs: Record<string, { id: string }>) => {
    const rows = await db.job.findMany({ where: { id: { in: Object.values(jobs).map((j) => j.id) } }, select: { id: true, salesperson_id: true } });
    const byId = new Map(rows.map((r) => [r.id, r.salesperson_id]));
    return Object.fromEntries(Object.entries(jobs).map(([name, j]) => [name, byId.get(j.id) ?? null]));
  };
  const expected = (jobs: Record<string, { expect: string | null }>) =>
    Object.fromEntries(Object.entries(jobs).map(([name, j]) => [name, j.expect]));

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const c of clients) await quietly(c.$disconnect());
    for (const name of databases) await quietly(admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    await admin.$disconnect();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  it('fills every kind of existing job in the pinned order, and a second run changes nothing', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');
    const { jobs } = await seed(client);
    expect(Object.values(await soldByOf(client, jobs)).filter(Boolean)).toHaveLength(1); // only the one already set

    const dir = deploy(dbUrl, 'through');
    const filled = await soldByOf(client, jobs);
    expect(filled).toEqual(expected(jobs));

    const again = runFileAgain(dbUrl, dir);
    expect(again.stderr).toBe('');
    expect(again.status).toBe(0);
    expect(await soldByOf(client, jobs)).toEqual(filled);
  }, 300_000);

  it('keeps each organization to its own people', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');
    const first = await seed(client);
    const second = await seed(client);

    deploy(dbUrl, 'through');

    for (const { jobs } of [first, second]) expect(await soldByOf(client, jobs)).toEqual(expected(jobs));
  }, 300_000);

  it.skipIf(!hasPsql)('prints per-org counts before it writes and proves the rows landed', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');
    const { org, jobs } = await seed(client);

    const run = () => spawnSync('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1', '-f', MIGRATION_SQL], { encoding: 'utf8' });
    const first = run();
    expect(first.status, first.stderr).toBe(0);
    const notices = first.stderr.split('\n').filter((l) => l.includes('S03.8'));

    // 6 of the 9 jobs without a Sold By get one; the 3 others have nobody to copy. The already-set job is left alone.
    const willFill = notices.findIndex((l) => l.includes(`org ${org}: 9 jobs without a Sold By, 6 will be filled, 3 stay empty`));
    const landed = notices.findIndex((l) => l.includes(`org ${org}: 6 of 6 planned Sold By values landed`));
    expect(willFill).toBeGreaterThanOrEqual(0);
    expect(landed).toBeGreaterThan(willFill);
    expect(await soldByOf(client, jobs)).toEqual(expected(jobs));

    // A second run finds nothing left to fill.
    const second = run();
    expect(second.status, second.stderr).toBe(0);
    expect(second.stderr).not.toContain(`org ${org}: 9 jobs`);
    expect(second.stderr).toContain(`org ${org}: 3 jobs without a Sold By, 0 will be filled, 3 stay empty`);
  }, 300_000);
});
