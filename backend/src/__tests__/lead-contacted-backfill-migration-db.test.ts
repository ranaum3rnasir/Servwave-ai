/* =============================================================================
   #2618 Seam B - the one-time "New lead with a recorded contact -> Contacted" update, applied for real.

   Proves against real Postgres, the way Render applies it (the Prisma deploy command), on a prod-shaped
   copy (every migration BEFORE this one, leads seeded in every status with and without a contact time):
     - only a New lead with a recorded contact moves, to Contacted; every other lead keeps its status;
     - each moved lead gets exactly one STATUS_CHANGE History row (from New, to Contacted, no actor, the
       backfill marker), dated at the lead's recorded contact time, in the lead's own organization;
     - the contact time itself is unchanged, and History rows that were already there are untouched;
     - a lead the update already moved once and someone set back to New by hand is left alone, and so is
       a lead set back to New by hand after its recorded contact (it waits for its next contact);
     - a lead that leaves New while the update runs is not moved and does not fail the deploy;
     - a second run moves nothing and writes nothing;
     - the run prints per-org counts before it writes and proves the rows landed (read through psql, which
       is the one client that shows a notice; that case skips on a machine without it).

   Each case builds its own throwaway database on the server TEST_DATABASE_URL points at and drops it
   afterwards. Skips when TEST_DATABASE_URL is unset, and REFUSES a non-local host: it creates and drops
   databases. The Prisma CLI runs from a temp directory with DATABASE_URL and DIRECT_URL passed
   explicitly, so it can never fall back to the checkout's .env (the shared staging DB).
   ========================================================================== */

import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync, copyFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { PrismaClient, type LeadStatus } from '@prisma/client';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const MIGRATION = '20261011120000_lead_status_contacted_backfill';
const VIA = 'contacted_status_backfill';
const PRISMA_DIR = join(__dirname, '..', '..', 'prisma');
const MIGRATION_SQL = join(PRISMA_DIR, 'migrations', MIGRATION, 'migration.sql');
const PRISMA_CLI = join(dirname(require.resolve('prisma/package.json')), 'build', 'index.js');
const hasPsql = spawnSync('psql', ['--version']).status === 0;

const STATUSES: LeadStatus[] = [
  'NEW', 'CONTACTED', 'WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED', 'ESTIMATED', 'WON', 'LOST', 'CANCELLED',
];

function assertLocal(raw: string): URL {
  const u = new URL(raw);
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname)) {
    throw new Error(`Contacted backfill migration suite creates and drops databases; refusing non-local host ${u.hostname}`);
  }
  return u;
}

function clientAt(dbUrl: string) {
  return new PrismaClient({ datasources: { db: { url: dbUrl } } });
}
type Db = ReturnType<typeof clientAt>;

type SeededLead = { id: string; org: string; status: LeadStatus; contactedAt: Date | null; expect: LeadStatus; moves: boolean };

suite('lead Contacted backfill migration (real database)', () => {
  const server = url ? assertLocal(url) : new URL('postgresql://localhost/unused');
  const admin = clientAt(url ?? '');
  const databases: string[] = [];
  const clients: Db[] = [];
  const tempDirs: string[] = [];

  async function createDatabase(): Promise<{ dbUrl: string; client: Db }> {
    const name = `sw2618_s2_mig_${randomUUID().slice(0, 8)}`;
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

  /** The Prisma deploy command with either every migration or only those before MIGRATION. */
  function deploy(dbUrl: string, which: 'all' | 'before'): string {
    const dir = mkdtempSync(join(tmpdir(), 'sw2618-s2-mig-'));
    tempDirs.push(dir);
    copyFileSync(join(PRISMA_DIR, 'schema.prisma'), join(dir, 'schema.prisma'));
    const source = join(PRISMA_DIR, 'migrations');
    for (const entry of readdirSync(source)) {
      if (which === 'before' && entry !== 'migration_lock.toml' && entry >= MIGRATION) continue;
      cpSync(join(source, entry), join(dir, 'migrations', entry), { recursive: true });
    }
    const run = cli(dbUrl, ['migrate', 'deploy', '--schema', join(dir, 'schema.prisma')], dir);
    if (run.status !== 0) throw new Error(`deploy failed:\n${run.stdout}\n${run.stderr}`);
    return dir;
  }

  /** The migration file run a second time, the way the shared staging database may see it. */
  function runFileAgain(dbUrl: string, dir: string) {
    return cli(dbUrl, ['db', 'execute', '--url', dbUrl, '--file', MIGRATION_SQL], dir);
  }

  /**
   * One organization with a lead in every status, each with and without a recorded contact, plus the
   * History it already had. Returns every lead with the status it must end up in.
   */
  async function seed(db: Db) {
    const org = randomUUID();
    const tag = org.slice(0, 8);
    await db.organization.create({
      data: {
        id: org, name: `s2618-${tag}`, email: `s2618-${tag}@example.test`, address_line1: '1 Test Way', city: 'Testville',
        state: 'MA', postal_code: '02108', estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
      },
    });
    const seller = randomUUID();
    await db.user.create({
      data: { id: seller, organization_id: org, email: `seller-${tag}@example.test`, first_name: 'Sam', last_name: 'Seller', role: 'SALES' },
    });
    const customer = randomUUID();
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
    });

    let n = 0;
    const lead = async (status: LeadStatus, contactedAt: Date | null) => {
      const id = randomUUID();
      await db.lead.create({
        data: {
          id, organization_id: org, customer_id: customer, lead_number: `L-${tag}-${++n}`, service_request: 'Fix the door',
          status, contacted_at: contactedAt,
        },
        select: { id: true },
      });
      return id;
    };

    const leads: Record<string, SeededLead> = {};
    for (const [i, status] of STATUSES.entries()) {
      // distinct, millisecond-precise contact times, so a row dated "now" or at the wrong lead cannot pass
      const contactedAt = new Date(Date.UTC(2026, 8, 1 + i, 14, 23, 45, 100 + i));
      const moves = status === 'NEW';
      leads[`${status}_contacted`] = {
        id: await lead(status, contactedAt), org, status, contactedAt, moves, expect: moves ? 'CONTACTED' : status,
      };
      leads[`${status}_never_contacted`] = {
        id: await lead(status, null), org, status, contactedAt: null, moves: false, expect: status,
      };
    }

    // History a lead already had stays as it was.
    await db.timelineEvent.create({
      data: {
        organization_id: org, entity_type: 'LEAD', entity_id: leads.CONTACTED_contacted.id, event_type: 'STATUS_CHANGE',
        description: 'Lead moved to Contacted', metadata: { from: 'NEW', to: 'CONTACTED', via: 'manual' }, created_by: seller,
      },
    });

    // Moved by an earlier run of this update, then set back to New by hand: a re-run leaves it alone.
    const reopenedAt = new Date(Date.UTC(2026, 7, 20, 9, 5, 0, 250));
    const reopened = await lead('NEW', reopenedAt);
    await db.timelineEvent.create({
      data: {
        organization_id: org, entity_type: 'LEAD', entity_id: reopened, event_type: 'STATUS_CHANGE',
        description: 'Lead moved to Contacted (set from its recorded contact)',
        metadata: { from: 'NEW', to: 'CONTACTED', via: VIA }, created_at: reopenedAt,
      },
    });
    leads.reopened_after_backfill = { id: reopened, org, status: 'NEW', contactedAt: reopenedAt, moves: false, expect: 'NEW' };

    // Set back to New by hand AFTER its recorded contact: a hand reset stays until the next qualifying
    // contact, and moving it would end its History on a "-> Contacted" row dated before the reset.
    const resetContactAt = new Date(Date.UTC(2026, 6, 10, 16, 0, 0, 125));
    const resetAfter = await lead('NEW', resetContactAt);
    await db.timelineEvent.create({
      data: {
        organization_id: org, entity_type: 'LEAD', entity_id: resetAfter, event_type: 'STATUS_CHANGE',
        description: 'Lead status changed to New', metadata: { from: 'CONTACTED', to: 'NEW', via: 'manual_edit' },
        created_by: seller, created_at: new Date(resetContactAt.getTime() + 86_400_000),
      },
    });
    leads.reset_to_new_after_its_contact = { id: resetAfter, org, status: 'NEW', contactedAt: resetContactAt, moves: false, expect: 'NEW' };

    // Set back to New BEFORE its recorded contact: the contact came later, so it still moves.
    const laterContactAt = new Date(Date.UTC(2026, 6, 12, 11, 30, 0, 375));
    const resetBefore = await lead('NEW', laterContactAt);
    await db.timelineEvent.create({
      data: {
        organization_id: org, entity_type: 'LEAD', entity_id: resetBefore, event_type: 'STATUS_CHANGE',
        description: 'Lead status changed to New', metadata: { from: 'CONTACTED', to: 'NEW', via: 'manual_edit' },
        created_by: seller, created_at: new Date(laterContactAt.getTime() - 86_400_000),
      },
    });
    leads.reset_to_new_before_its_contact = { id: resetBefore, org, status: 'NEW', contactedAt: laterContactAt, moves: true, expect: 'CONTACTED' };

    return { org, leads };
  }

  const statusesOf = async (db: Db, leads: Record<string, SeededLead>) => {
    const rows = await db.lead.findMany({
      where: { id: { in: Object.values(leads).map((l) => l.id) } },
      select: { id: true, status: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r.status]));
    return Object.fromEntries(Object.entries(leads).map(([name, l]) => [name, byId.get(l.id)]));
  };
  const expected = (leads: Record<string, SeededLead>) =>
    Object.fromEntries(Object.entries(leads).map(([name, l]) => [name, l.expect]));

  /** Everything the update could touch, to prove a second run leaves it byte-for-byte alone. */
  const snapshot = async (db: Db) => ({
    leads: await db.lead.findMany({
      select: { id: true, status: true, contacted_at: true, updated_at: true }, orderBy: { id: 'asc' },
    }),
    history: await db.timelineEvent.findMany({
      select: { id: true, organization_id: true, entity_id: true, event_type: true, description: true, metadata: true, created_by: true, created_at: true },
      orderBy: { id: 'asc' },
    }),
  });

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const c of clients) await quietly(c.$disconnect());
    for (const name of databases) await quietly(admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    await admin.$disconnect();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  it('moves only New leads with a recorded contact, with one History row dated at the contact, and a second run changes nothing', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');
    const { org, leads } = await seed(client);
    const historyBefore = await client.timelineEvent.findMany({ orderBy: { id: 'asc' } });

    const dir = deploy(dbUrl, 'all');

    expect(await statusesOf(client, leads)).toEqual(expected(leads));

    const moved = Object.values(leads).filter((l) => l.moves);
    expect(moved).toHaveLength(2);
    const backfillRows = await client.timelineEvent.findMany({ where: { metadata: { path: ['via'], equals: VIA } } });
    // the moved leads' new rows, plus the one the reopened lead already carried
    expect(backfillRows).toHaveLength(3);

    for (const l of moved) {
      const rows = await client.timelineEvent.findMany({ where: { entity_id: l.id, metadata: { path: ['via'], equals: VIA } } });
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row.organization_id).toBe(org);
      expect(row.entity_type).toBe('LEAD');
      expect(row.event_type).toBe('STATUS_CHANGE');
      expect(row.description).toBe('Lead moved to Contacted (set from its recorded contact)');
      expect(row.metadata).toEqual({ from: 'NEW', to: 'CONTACTED', via: VIA });
      expect(row.created_by).toBeNull();
      expect(row.created_at.getTime()).toBe(l.contactedAt!.getTime());
    }

    // No other lead got a row, and the rows that were already there are untouched.
    const historyAfter = await client.timelineEvent.findMany({ orderBy: { id: 'asc' } });
    const beforeIds = new Set(historyBefore.map((r) => r.id));
    expect(historyAfter.filter((r) => beforeIds.has(r.id))).toEqual(historyBefore);
    const added = historyAfter.filter((r) => !beforeIds.has(r.id)).map((r) => r.entity_id).sort();
    expect(added).toEqual(moved.map((l) => l.id).sort());

    // The contact clock is never written by the update.
    const clocks = await client.lead.findMany({ select: { id: true, contacted_at: true } });
    const clockOf = new Map(clocks.map((c) => [c.id, c.contacted_at?.getTime() ?? null]));
    for (const l of Object.values(leads)) expect(clockOf.get(l.id)).toBe(l.contactedAt?.getTime() ?? null);

    const settled = await snapshot(client);
    const again = runFileAgain(dbUrl, dir);
    expect(again.stderr).toBe('');
    expect(again.status).toBe(0);
    expect(await snapshot(client)).toEqual(settled);
  }, 300_000);

  it('keeps each organization to its own leads and History', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');
    const first = await seed(client);
    const second = await seed(client);

    deploy(dbUrl, 'all');

    for (const { org, leads } of [first, second]) {
      expect(await statusesOf(client, leads)).toEqual(expected(leads));
      for (const l of Object.values(leads).filter((x) => x.moves)) {
        const rows = await client.timelineEvent.findMany({
          where: { entity_id: l.id, metadata: { path: ['via'], equals: VIA } }, select: { organization_id: true },
        });
        expect(rows).toEqual([{ organization_id: org }]);
      }
    }
  }, 300_000);

  // A lead can leave New between the plan and the write (a user moves it while the deploy runs).
  // That lead is simply not moved, writes no History row, and the deploy still succeeds: a planned
  // vs moved difference is reported, never a failed deploy. A BEFORE UPDATE trigger that skips one
  // planned lead's write stands in for that concurrent move, deterministically.
  it('a lead that leaves New while it runs is not moved, gets no History row, and does not fail the deploy', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');
    const { leads } = await seed(client);
    const left = leads.NEW_contacted;
    await client.$executeRawUnsafe(`
      CREATE FUNCTION sw2618_left_new_meanwhile() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN
        IF OLD.id = '${left.id}'::uuid AND NEW.status = 'CONTACTED' THEN RETURN NULL; END IF;
        RETURN NEW;
      END $f$`);
    await client.$executeRawUnsafe(
      'CREATE TRIGGER sw2618_left_new_meanwhile BEFORE UPDATE ON leads FOR EACH ROW EXECUTE FUNCTION sw2618_left_new_meanwhile()');

    deploy(dbUrl, 'all');

    expect(await statusesOf(client, leads)).toEqual({ ...expected(leads), NEW_contacted: 'NEW' });
    expect(await client.timelineEvent.count({ where: { entity_id: left.id } })).toBe(0);
    const other = leads.reset_to_new_before_its_contact;
    expect(await client.timelineEvent.count({ where: { entity_id: other.id, metadata: { path: ['via'], equals: VIA } } })).toBe(1);
  }, 300_000);

  it.skipIf(!hasPsql)('prints per-org counts before it writes and proves the rows landed', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');
    const { org, leads } = await seed(client);

    const run = () => spawnSync('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1', '-f', MIGRATION_SQL], { encoding: 'utf8' });
    const first = run();
    expect(first.status, first.stderr).toBe(0);
    const notices = first.stderr.split('\n').filter((l) => l.includes('#2618'));

    const willMove = notices.findIndex((l) => l.includes(`org ${org}: 2 New leads with a recorded contact will move to Contacted`));
    const landed = notices.findIndex((l) => l.includes('all orgs: 2 of 2 planned leads moved to Contacted, 2 History rows written'));
    expect(willMove).toBeGreaterThanOrEqual(0);
    expect(landed).toBeGreaterThan(willMove);
    expect(await statusesOf(client, leads)).toEqual(expected(leads));

    // A second run finds nothing left to move.
    const second = run();
    expect(second.status, second.stderr).toBe(0);
    expect(second.stderr).not.toContain(`org ${org}:`);
    expect(second.stderr).toContain('all orgs: 0 of 0 planned leads moved to Contacted, 0 History rows written');
  }, 300_000);
});
