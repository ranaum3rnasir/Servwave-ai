/* =============================================================================
   Roles & Permissions, PRD 10 (scenario pass 3 fix) - the catch-up for hand-written emails sent from a job's or lead's
   Communication tab before the send stamped the record's customer, applied for real.

   Proves against real Postgres, the way Render applies it (the Prisma deploy command), on a prod-shaped copy (every
   migration BEFORE this one):
     - a sent, hand-written email on a job gets the job's customer, and one on a lead gets the lead's;
     - a row naming both a job and a lead gets the job's customer (job over lead);
     - received mail, automated mail, a hand-written email with no recorded sender and a row that already has a customer
       keep exactly what they had, and so does a row naming neither record;
     - a second run changes nothing.

   Each case builds its own throwaway database on the server TEST_DATABASE_URL points at and drops it afterwards. Skips
   when TEST_DATABASE_URL is unset, and REFUSES a non-local host: it creates and drops databases. The Prisma CLI runs from
   a temp directory with DATABASE_URL and DIRECT_URL passed explicitly, so it can never fall back to the checkout's .env
   (the shared staging DB).
   ========================================================================== */

import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import { rmSync } from 'fs';
import { dirname, join } from 'path';
import { PrismaClient } from '@prisma/client';
import { deployMigrations } from './migration-deploy-support';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const MIGRATION = '20261012720000_email_record_tab_customer_backfill';
const PRISMA_DIR = join(__dirname, '..', '..', 'prisma');
const MIGRATION_SQL = join(PRISMA_DIR, 'migrations', MIGRATION, 'migration.sql');
const PRISMA_CLI = join(dirname(require.resolve('prisma/package.json')), 'build', 'index.js');

function assertLocal(raw: string): URL {
  const u = new URL(raw);
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname)) {
    throw new Error(`Record-tab email customer migration suite creates and drops databases; refusing non-local host ${u.hostname}`);
  }
  return u;
}

function clientAt(dbUrl: string) {
  return new PrismaClient({ datasources: { db: { url: dbUrl } } });
}
type Db = ReturnType<typeof clientAt>;

suite('record-tab email customer backfill migration (real database)', () => {
  const server = url ? assertLocal(url) : new URL('postgresql://localhost/unused');
  const admin = clientAt(url ?? '');
  const databases: string[] = [];
  const clients: Db[] = [];
  const tempDirs: string[] = [];

  async function createDatabase(): Promise<{ dbUrl: string; client: Db }> {
    const name = `sw_rtec_mig_${randomUUID().slice(0, 8)}`;
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    databases.push(name);
    const u = new URL(server.toString());
    u.pathname = `/${name}`;
    const dbUrl = u.toString();
    const client = clientAt(dbUrl);
    clients.push(client);
    return { dbUrl, client };
  }

  /** The migration file run a second time, the way the shared staging database may see it. */
  function runFileAgain(dbUrl: string, dir: string) {
    return spawnSync(process.execPath, [PRISMA_CLI, 'db', 'execute', '--url', dbUrl, '--file', MIGRATION_SQL], {
      cwd: dir,
      env: { ...process.env, DATABASE_URL: dbUrl, DIRECT_URL: dbUrl },
      encoding: 'utf8',
    });
  }

  async function seed(db: Db) {
    const org = randomUUID();
    const tag = org.slice(0, 8);
    await db.organization.create({
      data: {
        id: org, name: `rtec-${tag}`, email: `rtec-${tag}@example.test`, address_line1: '1 Test Way', city: 'Testville',
        state: 'MA', postal_code: '02108', estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
      },
      select: { id: true },
    });
    const sender = randomUUID();
    // Raw insert: this database holds only the migrations before the one under test, and the client's insert would name later columns (users.is_admin).
    await db.$executeRawUnsafe(
      `INSERT INTO users (id, organization_id, email, first_name, last_name, role, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, 'Sam', 'Sender', 'SALES'::"Role", now())`,
      sender, org, `sender-${tag}@example.test`,
    );
    const customer = async (n: number) => {
      const id = randomUUID();
      await db.customer.create({
        data: { id, organization_id: org, customer_number: `C-${tag}-${n}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: `Pat${n}`, last_name: 'Payer' },
        select: { id: true },
      });
      return id;
    };
    const [jobCustomer, leadCustomer, otherCustomer] = [await customer(1), await customer(2), await customer(3)];

    const location = randomUUID();
    await db.serviceLocation.create({
      data: { id: location, customer_id: jobCustomer, address_line1: '1 Test Way', city: 'Testville', state: 'MA', zip: '02108' },
      select: { id: true },
    });
    const job = randomUUID();
    await db.job.create({
      data: { id: job, organization_id: org, customer_id: jobCustomer, service_location_id: location, job_number: `J-${tag}`, status: 'SCHEDULED' },
      select: { id: true },
    });
    const lead = randomUUID();
    await db.lead.create({
      data: { id: lead, organization_id: org, customer_id: leadCustomer, lead_number: `L-${tag}`, service_request: 'Fix the door' },
      select: { id: true },
    });

    // Raw SQL, not the live client: this database is at the migration BEFORE the one under test, and the client writes every
    // column of the current schema (a default included), which a later migration may have added (S10.17 added two to emails).
    const email = async (tie: Record<string, unknown>) => {
      const id = randomUUID();
      const row = {
        account: 'user', direction: 'out', folder: 'sent', sent_by_user_id: sender, job_id: null, lead_id: null, customer_id: null, ...tie,
      } as {
        account: string; direction: string; folder: string; sent_by_user_id: string | null; job_id: string | null; lead_id: string | null;
        customer_id: string | null;
      };
      await db.$executeRawUnsafe(
        `INSERT INTO emails (id, organization_id, account, direction, folder, sent_by_user_id, job_id, lead_id, customer_id, "from", "to", subject,
                             snippet, body, "at", ts, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7::uuid, $8::uuid, $9::uuid, '{"name":null,"email":"office@example.com"}'::jsonb,
                 'customer@example.com', 'rtec', 's', '["b"]'::jsonb, '1:00 PM', $10, now())`,
        id, org, row.account, row.direction, row.folder, row.sent_by_user_id, row.job_id, row.lead_id, row.customer_id, Date.now());
      return id;
    };
    const rows = {
      onJob: await email({ job_id: job }),
      onLead: await email({ lead_id: lead }),
      onJobAndLead: await email({ job_id: job, lead_id: lead }),
      received: await email({ job_id: job, direction: 'in', folder: 'inbox', sent_by_user_id: null }),
      automated: await email({ job_id: job, account: 'system' }),
      noSender: await email({ job_id: job, sent_by_user_id: null }),
      alreadyStamped: await email({ job_id: job, customer_id: otherCustomer }),
      onNeither: await email({}),
    };
    return { rows, jobCustomer, leadCustomer, otherCustomer };
  }

  const customersOf = async (db: Db) =>
    Object.fromEntries((await db.email.findMany({ select: { id: true, customer_id: true } })).map((r) => [r.id, r.customer_id]));

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const c of clients) await quietly(c.$disconnect());
    for (const name of databases) await quietly(admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    await admin.$disconnect();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  it('gives a sent, hand-written record-tab email its record\'s customer, leaves every other row as it was, and a second run changes nothing', async () => {
    const { dbUrl, client } = await createDatabase();
    deployMigrations(dbUrl, MIGRATION, 'before', tempDirs);
    const { rows, jobCustomer, leadCustomer, otherCustomer } = await seed(client);
    const before = await customersOf(client);

    const dir = deployMigrations(dbUrl, MIGRATION, 'through', tempDirs);

    const after = await customersOf(client);
    expect(after).toEqual({
      ...before,
      [rows.onJob]: jobCustomer,
      [rows.onLead]: leadCustomer,
      [rows.onJobAndLead]: jobCustomer,
    });
    for (const untouched of [rows.received, rows.automated, rows.noSender, rows.onNeither]) {
      expect(after[untouched], untouched).toBeNull();
    }
    expect(after[rows.alreadyStamped]).toBe(otherCustomer);

    const again = runFileAgain(dbUrl, dir);
    expect(again.status, `${again.stdout}\n${again.stderr}`).toBe(0);
    expect(await customersOf(client)).toEqual(after);
  }, 240_000);
});
