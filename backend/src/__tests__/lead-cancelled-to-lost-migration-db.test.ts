/* =============================================================================
   S05.18 - the one-time "Cancelled leads become Lost" move, applied for real.

   Proves against real Postgres, the way Render applies it (the Prisma deploy command), on a prod-shaped copy
   (every migration BEFORE this one, leads seeded in every status):
     - every Cancelled lead becomes Lost, in every company, and none is Cancelled afterwards;
     - the cancel reason becomes the lost reason (empty when the lead was cancelled from the status menu);
     - the lost date is the date the lead was cancelled, and the lead's last-changed date is left as it was, so
       neither the dashboard's Close Rate (counted by last change) nor "Lost this month" (counted by lost date)
       moves an old lead into the current month;
     - each moved lead gets exactly one History row (from Cancelled, to Lost, the old reason and date, no actor),
       dated at the cancel and sitting AFTER the History entry that cancelled the lead, so Reopen can read back
       past it;
     - no other table is written: no alert, no automation run, no stopped reminder is touched;
     - every other lead, and History already written ("Lead cancelled"), is left exactly as it was;
     - a second run moves nothing and writes nothing;
     - afterwards the database itself refuses to put a lead back to Cancelled, so the old backend that may still be
       serving while a deploy rolls cannot leave a Cancelled lead behind for the new one to trip over;
     - the run prints how many leads will move per company and how many did (read through psql, the one client
       that shows a notice; that case skips on a machine without it).

   Each case builds its own throwaway database on the server TEST_DATABASE_URL points at and drops it
   afterwards. Skips when TEST_DATABASE_URL is unset, and REFUSES a non-local host: it creates and drops
   databases. The Prisma CLI runs from a temp directory with DATABASE_URL and DIRECT_URL passed
   explicitly, so it can never fall back to the checkout's .env (the shared staging DB).

   Leads are put into Cancelled with raw SQL on purpose: the live Prisma client no longer knows the value, and the
   database before this migration still does.
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

const MIGRATION = '20261012140000_lead_cancelled_to_lost';
const VIA = 'lead_cancelled_retired';
const PRISMA_DIR = join(__dirname, '..', '..', 'prisma');
const MIGRATION_SQL = join(PRISMA_DIR, 'migrations', MIGRATION, 'migration.sql');
const PRISMA_CLI = join(dirname(require.resolve('prisma/package.json')), 'build', 'index.js');
const hasPsql = spawnSync('psql', ['--version']).status === 0;

function assertLocal(raw: string): URL {
  const u = new URL(raw);
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname)) {
    throw new Error(`Cancelled-to-Lost migration suite creates and drops databases; refusing non-local host ${u.hostname}`);
  }
  return u;
}

function clientAt(dbUrl: string) {
  return new PrismaClient({ datasources: { db: { url: dbUrl } } });
}
type Db = ReturnType<typeof clientAt>;

const at = (month: number, day: number, h = 15, m = 7, s = 33, ms = 412) => new Date(Date.UTC(2026, month, day, h, m, s, ms));

interface Seeded {
  id: string;
  org: string;
  /** Status the lead must hold once the move has run. */
  after: 'LOST' | 'WON' | 'ESTIMATED' | 'NEW';
  lostReason: string | null;
  lostAt: Date | null;
  updatedAt: Date;
  moves: boolean;
}

suite('Cancelled leads become Lost (real database)', () => {
  const server = url ? assertLocal(url) : new URL('postgresql://localhost/unused');
  const admin = clientAt(url ?? '');
  const databases: string[] = [];
  const clients: Db[] = [];
  const tempDirs: string[] = [];

  async function createDatabase(): Promise<{ dbUrl: string; client: Db }> {
    const name = `sw0518_mig_${randomUUID().slice(0, 8)}`;
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
      env: { ...process.env, DATABASE_URL: dbUrl, DIRECT_URL: dbUrl, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
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
   * One organization with a lead in several statuses, four of them Cancelled in the four ways a lead was
   * cancelled before the release, plus the History each already had. Returns every lead with where it must end up.
   */
  async function seed(db: Db) {
    const org = randomUUID();
    const tag = org.slice(0, 8);
    await db.organization.create({
      data: {
        id: org, name: `s0518-${tag}`, email: `s0518-${tag}@example.test`, address_line1: '1 Test Way', city: 'Testville',
        state: 'MA', postal_code: '02108', estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
      },
      // Narrow: this database sits at an older migration, so the live client must not read back columns added since.
      select: { id: true },
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
    const lead = async (fields: { updatedAt: Date; status?: string; set?: string }) => {
      const id = randomUUID();
      await db.lead.create({
        data: { id, organization_id: org, customer_id: customer, lead_number: `L-${tag}-${++n}`, service_request: 'Fix the door' },
        select: { id: true },
      });
      // Every column is written by SQL so the dates are exactly what the case needs (updated_at is stamped by the client otherwise).
      await db.$executeRawUnsafe(
        `UPDATE leads SET updated_at = '${fields.updatedAt.toISOString()}', status = '${fields.status ?? 'ESTIMATED'}'::"LeadStatus" ${fields.set ? `, ${fields.set}` : ''} WHERE id = '${id}'::uuid`,
      );
      return id;
    };
    const history = async (leadId: string, description: string, metadata: object | null, createdAt: Date) => {
      await db.timelineEvent.create({
        data: {
          organization_id: org, entity_type: 'LEAD', entity_id: leadId, event_type: 'STATUS_CHANGE', description, metadata: metadata ?? undefined,
          created_by: seller, created_at: createdAt,
        },
      });
    };

    const leads: Record<string, Seeded> = {};

    // 1. Cancelled with a typed reason. The cancel History entry is written a few milliseconds AFTER cancelled_at
    //    (cancelled_at is taken before the write), which is the order the migrated entry must stay behind.
    const typedAt = at(7, 12);
    const typed = await lead({
      updatedAt: at(7, 12, 15, 7, 34, 100),
      status: 'CANCELLED',
      set: `cancelled_at = '${typedAt.toISOString()}', cancelled_reason = 'Customer went with another company'`,
    });
    await history(typed, 'Lead cancelled', { from: 'ESTIMATED', to: 'CANCELLED' }, new Date(typedAt.getTime() + 9));
    leads.typed = { id: typed, org, after: 'LOST', lostReason: 'Customer went with another company', lostAt: typedAt, updatedAt: at(7, 12, 15, 7, 34, 100), moves: true };

    // 2. Cancelled from the status menu: the old menu stamped the date but never asked for a reason.
    const menuAt = at(6, 3, 9, 30, 0, 250);
    const menu = await lead({ updatedAt: at(6, 3, 9, 30, 1, 0), status: 'CANCELLED', set: `cancelled_at = '${menuAt.toISOString()}'` });
    await history(menu, 'Lead status changed to Cancelled', { from: 'CONTACTED', to: 'CANCELLED' }, new Date(menuAt.getTime() + 4));
    leads.menu = { id: menu, org, after: 'LOST', lostReason: null, lostAt: menuAt, updatedAt: at(6, 3, 9, 30, 1, 0), moves: true };

    // 3. Cancelled with no cancelled_at on the row: the date is the History entry that cancelled it.
    const noStampAt = at(5, 20, 12, 0, 0, 500);
    const noStamp = await lead({ updatedAt: at(7, 1), status: 'CANCELLED' });
    await history(noStamp, 'Lead status changed to Cancelled', { from: 'NEW', to: 'CANCELLED' }, noStampAt);
    leads.noStamp = { id: noStamp, org, after: 'LOST', lostReason: null, lostAt: noStampAt, updatedAt: at(7, 1), moves: true };

    // 4. Cancelled with nothing to date it by: its last-changed date.
    const bare = await lead({ updatedAt: at(4, 2, 8, 15, 0, 125), status: 'CANCELLED' });
    leads.bare = { id: bare, org, after: 'LOST', lostReason: null, lostAt: at(4, 2, 8, 15, 0, 125), updatedAt: at(4, 2, 8, 15, 0, 125), moves: true };

    // Leads that are not Cancelled stay exactly as they are, Lost ones included.
    const lostAt = at(7, 30, 10);
    const lost = await lead({
      updatedAt: at(7, 30, 10, 0, 1, 0), status: 'LOST',
      set: `lost_at = '${lostAt.toISOString()}', lost_reason = 'Too expensive'`,
    });
    leads.lost = { id: lost, org, after: 'LOST', lostReason: 'Too expensive', lostAt, updatedAt: at(7, 30, 10, 0, 1, 0), moves: false };
    const won = await lead({ updatedAt: at(7, 2), status: 'WON' });
    leads.won = { id: won, org, after: 'WON', lostReason: null, lostAt: null, updatedAt: at(7, 2), moves: false };
    const estimated = await lead({ updatedAt: at(7, 3), status: 'ESTIMATED' });
    leads.estimated = { id: estimated, org, after: 'ESTIMATED', lostReason: null, lostAt: null, updatedAt: at(7, 3), moves: false };
    const fresh = await lead({ updatedAt: at(7, 4), status: 'NEW' });
    leads.fresh = { id: fresh, org, after: 'NEW', lostReason: null, lostAt: null, updatedAt: at(7, 4), moves: false };

    return { org, leads };
  }

  const read = async (db: Db, leads: Record<string, Seeded>) => {
    const ids = Object.values(leads).map((l) => l.id);
    const rows = await db.$queryRawUnsafe<
      { id: string; status: string; lost_reason: string | null; lost_at: Date | null; updated_at: Date; cancelled_at: Date | null; cancelled_reason: string | null }[]
    >(
      `SELECT id, status::text AS status, lost_reason, lost_at, updated_at, cancelled_at, cancelled_reason FROM leads WHERE id = ANY($1::uuid[])`, ids,
    );
    return new Map(rows.map((r) => [r.id, r]));
  };

  /** A digest of every table the move must NOT write: any alert, automation run or stopped reminder it touched shows up. */
  const otherTables = async (db: Db) => {
    const tables = await db.$queryRawUnsafe<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
         AND table_name NOT IN ('leads', 'timeline_events', '_prisma_migrations') ORDER BY table_name`,
    );
    const out: Record<string, string> = {};
    for (const { table_name } of tables) {
      const [row] = await db.$queryRawUnsafe<{ d: string }[]>(
        `SELECT count(*)::text || ':' || coalesce(md5(string_agg(t::text, ',' ORDER BY t::text)), '') AS d FROM "${table_name}" t`,
      );
      out[table_name] = row.d;
    }
    return out;
  };

  const snapshot = async (db: Db) => ({
    leads: await db.$queryRawUnsafe(`SELECT id, status::text AS status, lost_at, lost_reason, updated_at, cancelled_at, cancelled_reason FROM leads ORDER BY id`),
    history: await db.timelineEvent.findMany({ orderBy: { id: 'asc' } }),
  });

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const c of clients) await quietly(c.$disconnect());
    for (const name of databases) await quietly(admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    await admin.$disconnect();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  it('turns every Cancelled lead into Lost with its reason and date, keeps the last-changed date, and writes one History row each', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');
    const { org, leads } = await seed(client);
    const cancelledBefore = await client.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM leads WHERE status::text = 'CANCELLED'`);
    expect(cancelledBefore[0].n).toBe(4);
    const lostBefore = await client.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM leads WHERE status::text = 'LOST'`);
    const historyBefore = await client.timelineEvent.findMany({ orderBy: { id: 'asc' } });
    const othersBefore = await otherTables(client);

    deploy(dbUrl, 'through');

    // After the move nothing is Cancelled, and exactly the four moved are the new Lost ones.
    const cancelledAfter = await client.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM leads WHERE status::text = 'CANCELLED'`);
    expect(cancelledAfter[0].n).toBe(0);
    const lostAfter = await client.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM leads WHERE status::text = 'LOST'`);
    expect(lostAfter[0].n - lostBefore[0].n).toBe(cancelledBefore[0].n);

    const rows = await read(client, leads);
    for (const [name, l] of Object.entries(leads)) {
      const row = rows.get(l.id)!;
      expect(row.status, name).toBe(l.after);
      expect(row.lost_reason, name).toBe(l.lostReason);
      expect(row.lost_at?.getTime() ?? null, name).toBe(l.lostAt?.getTime() ?? null);
      // The last-changed date is exactly what it was: the Close Rate counts leads by it.
      expect(row.updated_at.getTime(), name).toBe(l.updatedAt.getTime());
    }
    // The cancel columns are left as they were; they are the record of what happened.
    expect(rows.get(leads.typed.id)!.cancelled_reason).toBe('Customer went with another company');
    expect(rows.get(leads.typed.id)!.cancelled_at?.getTime()).toBe(leads.typed.lostAt!.getTime());

    // No migrated lead lands in the current month.
    const startOfThisMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    for (const l of Object.values(leads).filter((x) => x.moves)) {
      expect(rows.get(l.id)!.lost_at!.getTime()).toBeLessThan(startOfThisMonth.getTime());
      expect(rows.get(l.id)!.updated_at.getTime()).toBeLessThan(startOfThisMonth.getTime());
    }

    // One History row per moved lead, and none for any other lead.
    const historyAfter = await client.timelineEvent.findMany({ orderBy: { id: 'asc' } });
    const beforeIds = new Set(historyBefore.map((r) => r.id));
    expect(historyAfter.filter((r) => beforeIds.has(r.id))).toEqual(historyBefore);
    const added = historyAfter.filter((r) => !beforeIds.has(r.id));
    const moved = Object.values(leads).filter((l) => l.moves);
    expect(added.map((r) => r.entity_id).sort()).toEqual(moved.map((l) => l.id).sort());

    for (const l of moved) {
      const row = added.find((r) => r.entity_id === l.id)!;
      expect(row.organization_id).toBe(org);
      expect(row.entity_type).toBe('LEAD');
      expect(row.event_type).toBe('STATUS_CHANGE');
      expect(row.created_by).toBeNull();
      const meta = row.metadata as Record<string, unknown>;
      expect(meta.from).toBe('CANCELLED');
      expect(meta.to).toBe('LOST');
      expect(meta.via).toBe(VIA);
      // The old reason, and the date it was cancelled, travel with the entry.
      expect(meta.cancelled_reason).toBe(l === leads.typed ? 'Customer went with another company' : null);
      expect(new Date(meta.cancelled_at as string).getTime()).toBe(l.lostAt!.getTime());
      // The words say what happened and carry the old reason; no clock time is printed in them.
      expect(row.description).toContain('Cancelled before Cancelled was retired');
      expect(row.description).toContain(l === leads.typed ? 'Customer went with another company' : 'none recorded');
      expect(row.description).not.toMatch(/\d{1,2}:\d{2}/);
      // Dated at the cancel itself, not at the day of the migration.
      expect(Math.abs(row.created_at.getTime() - l.lostAt!.getTime())).toBeLessThan(60_000);
    }

    // The entry sits AFTER the entry that cancelled the lead, so Reopen can read back past it (S05.19).
    for (const l of [leads.typed, leads.menu, leads.noStamp]) {
      const entries = historyAfter.filter((r) => r.entity_id === l.id && r.event_type === 'STATUS_CHANGE')
        .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
      expect(entries).toHaveLength(2);
      expect((entries[0].metadata as Record<string, unknown>).to).toBe('LOST');
      expect((entries[1].metadata as Record<string, unknown>).to).toBe('CANCELLED');
    }

    // Nothing else was written: no alert, no automation run, no stopped reminder moved. The deploy stops at this
    // migration, so every other table (all of them, none left out) is compared as it was.
    expect(await otherTables(client)).toEqual(othersBefore);
  }, 300_000);

  it('moves a second company in the same run, each lead into its own company, and a second run changes nothing', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');
    const first = await seed(client);
    const second = await seed(client);

    const dir = deploy(dbUrl, 'through');

    for (const { org, leads } of [first, second]) {
      const rows = await read(client, leads);
      for (const l of Object.values(leads)) expect(rows.get(l.id)!.status).toBe(l.after);
      for (const l of Object.values(leads).filter((x) => x.moves)) {
        const written = await client.timelineEvent.findMany({ where: { entity_id: l.id, metadata: { path: ['via'], equals: VIA } } });
        expect(written).toHaveLength(1);
        expect(written[0].organization_id).toBe(org);
      }
    }

    const settled = await snapshot(client);
    const again = runFileAgain(dbUrl, dir);
    expect(again.stderr).toBe('');
    expect(again.status).toBe(0);
    expect(await snapshot(client)).toEqual(settled);
  }, 300_000);

  it('leaves the database refusing to set a lead back to Cancelled, whoever asks', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');
    const { leads } = await seed(client);
    deploy(dbUrl, 'through');

    // The old backend, still serving while a deploy rolls, cancelling a lead: refused by the database.
    await expect(
      client.$executeRawUnsafe(`UPDATE leads SET status = 'CANCELLED'::"LeadStatus" WHERE id = '${leads.fresh.id}'::uuid`),
    ).rejects.toThrow(/leads_status_not_cancelled/);
    // Every other status is still fine.
    await client.$executeRawUnsafe(`UPDATE leads SET status = 'LOST'::"LeadStatus" WHERE id = '${leads.fresh.id}'::uuid`);
    const [row] = await client.$queryRawUnsafe<{ status: string }[]>(`SELECT status::text AS status FROM leads WHERE id = '${leads.fresh.id}'::uuid`);
    expect(row.status).toBe('LOST');
  }, 300_000);

  it.skipIf(!hasPsql)('prints how many leads will move per company before it writes, and how many did', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');
    const { org } = await seed(client);

    const run = () => spawnSync('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1', '-f', MIGRATION_SQL], { encoding: 'utf8' });
    const first = run();
    expect(first.status, first.stderr).toBe(0);
    const notices = first.stderr.split('\n').filter((l) => l.includes('S05.18'));

    const willMove = notices.findIndex((l) => l.includes(`org ${org}: 4 Cancelled leads will move to Lost`));
    const landed = notices.findIndex((l) => l.includes('all orgs: 4 of 4 Cancelled leads moved to Lost, 4 History rows written'));
    expect(willMove).toBeGreaterThanOrEqual(0);
    expect(landed).toBeGreaterThan(willMove);

    const second = run();
    expect(second.status, second.stderr).toBe(0);
    expect(second.stderr).not.toContain(`org ${org}:`);
    expect(second.stderr).toContain('all orgs: 0 of 0 Cancelled leads moved to Lost, 0 History rows written');
  }, 300_000);
});
