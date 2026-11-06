/* =============================================================================
   #3104 (B7 follow-up): the data step that moves each lead's saved Lead Notes text (leads.notes) into its general note,
   applied for real.

   Proves against real Postgres, the way Render applies it (the Prisma deploy command), on a database at the migration
   before it:
     - a lead with saved text gets one general note: that text (blanks at either end removed), at the lead's creation
       time, by the lead's creator;
     - a lead with no creator gets its note by the company's Owner (Ran's build ruling 1);
     - in a company with no Owner, by its longest-standing ACTIVE Admin (the `is_admin` flag, active and not erased,
       earliest `created_at`, ties by id; Ran's build ruling 5): an older inactive or erased Admin is passed over;
     - a lead with blank or no text gets no note;
     - a lead that already has a general note is not given a second one, and keeps its own;
     - another (not general) note on the lead does not stop the move;
     - a lead with no creator in a company with neither an Owner nor an active Admin gets no note, and the run reports it;
     - leads.notes is left as it was;
     - a second run writes nothing.

   Each case builds its own throwaway database on the server TEST_DATABASE_URL points at and drops it afterwards. Skips when
   TEST_DATABASE_URL is unset, and REFUSES a non-local host: it creates and drops databases.
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

const MIGRATION = '20261104120100_lead_notes_to_general_note';
const PRISMA_DIR = join(__dirname, '..', '..', 'prisma');
const MIGRATION_SQL = join(PRISMA_DIR, 'migrations', MIGRATION, 'migration.sql');
const PRISMA_CLI = join(dirname(require.resolve('prisma/package.json')), 'build', 'index.js');
const hasPsql = spawnSync('psql', ['--version']).status === 0;

function assertLocal(raw: string): URL {
  const u = new URL(raw);
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname)) {
    throw new Error(`The general-note migration suite creates and drops databases; refusing non-local host ${u.hostname}`);
  }
  return u;
}

function clientAt(dbUrl: string) {
  return new PrismaClient({ datasources: { db: { url: dbUrl } } });
}
type Db = ReturnType<typeof clientAt>;

suite('lead notes to general note migration (real database)', () => {
  const server = url ? assertLocal(url) : new URL('postgresql://localhost/unused');
  const admin = clientAt(url ?? '');
  const databases: string[] = [];
  const clients: Db[] = [];
  const tempDirs: string[] = [];

  async function createDatabase(): Promise<{ dbUrl: string; client: Db }> {
    const name = `gn3104_mig_${randomUUID().slice(0, 8)}`;
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    databases.push(name);
    const u = new URL(server.toString());
    u.pathname = `/${name}`;
    const dbUrl = u.toString();
    const client = clientAt(dbUrl);
    clients.push(client);
    return { dbUrl, client };
  }

  const deploy = (dbUrl: string, which: 'before' | 'through') => deployMigrations(dbUrl, MIGRATION, which, tempDirs);

  function runFileAgain(dbUrl: string, dir: string) {
    return spawnSync(process.execPath, [PRISMA_CLI, 'db', 'execute', '--url', dbUrl, '--file', MIGRATION_SQL], {
      cwd: dir,
      env: { ...process.env, DATABASE_URL: dbUrl, DIRECT_URL: dbUrl },
      encoding: 'utf8',
    });
  }

  /**
   * One company with every kind of lead the move has to tell apart. `withOwner` false: the company has no Owner. `admins`:
   * 'none' gives it no Admin at all; 'mixed' gives it, by when they joined, an erased Admin, an inactive Admin, then two
   * active Admins (the older one is the longest-standing active Admin); 'tie' gives it two active Admins who joined at the
   * same moment.
   */
  async function seed(db: Db, withOwner = true, admins: 'none' | 'mixed' | 'tie' = 'mixed') {
    const org = randomUUID();
    const tag = org.slice(0, 8);
    await db.organization.create({
      data: {
        id: org, name: `gn-${tag}`, email: `gn-${tag}@example.test`, address_line1: '1 Test Way', city: 'Testville',
        state: 'MA', postal_code: '02108', estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
      },
      select: { id: true },
    });
    const user = async (
      first: string,
      opts: { admin?: boolean; active?: boolean; erased?: boolean; joined?: Date; id?: string } = {},
    ) => {
      const id = opts.id ?? randomUUID();
      await db.user.create({
        data: {
          id, organization_id: org, email: `${first.toLowerCase()}-${tag}@example.test`, first_name: first, last_name: 'Tester',
          role: opts.admin ? 'ADMIN' : 'SALES', is_admin: opts.admin ?? false, is_active: opts.active ?? true,
          erased_at: opts.erased ? new Date(Date.UTC(2024, 0, 1)) : null, created_at: opts.joined ?? new Date(Date.UTC(2025, 0, 1)),
        },
        select: { id: true },
      });
      return id;
    };
    const dana = await user('Dana');
    const owner = withOwner ? await user('Morgan', { admin: true, joined: new Date(Date.UTC(2023, 0, 1)) }) : null;
    if (owner) await db.organization.update({ where: { id: org }, data: { owner_user_id: owner }, select: { id: true } });
    let senior: string | null = null;
    if (admins === 'mixed') {
      // Erased but still flagged active, so the erased check is proven on its own.
      await user('Erased', { admin: true, erased: true, active: true, joined: new Date(Date.UTC(2019, 0, 1)) });
      await user('Inactive', { admin: true, active: false, joined: new Date(Date.UTC(2020, 0, 1)) });
      senior = await user('Senior', { admin: true, joined: new Date(Date.UTC(2021, 0, 1)) });
      await user('Junior', { admin: true, joined: new Date(Date.UTC(2022, 0, 1)) });
    } else if (admins === 'tie') {
      const joined = new Date(Date.UTC(2021, 0, 1));
      const [low, high] = [randomUUID(), randomUUID()].sort();
      await user('Second', { admin: true, joined, id: high! });
      senior = await user('First', { admin: true, joined, id: low! });
    }
    const customer = randomUUID();
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
      select: { id: true },
    });
    let n = 0;
    const lead = async (notes: string | null, createdBy: string | null) => {
      const id = randomUUID();
      // A fixed creation time in the past, so the note's time is visibly the lead's, not the run's.
      const createdAt = new Date(Date.UTC(2026, 0, 10 + ++n, 15, 30));
      await db.lead.create({
        data: { id, organization_id: org, customer_id: customer, lead_number: `L-${tag}-${n}`, service_request: 'Fix the door', notes, created_by_id: createdBy, created_at: createdAt },
        select: { id: true },
      });
      return { id, createdAt };
    };
    const leads = {
      byCreator: await lead('  Customer prefers mornings.\n', dana),
      noCreator: await lead('Old import text', null),
      blank: await lead('   \n\t ', dana),
      empty: await lead(null, dana),
      alreadyGeneral: await lead('Text in the column', dana),
      withOtherNote: await lead('Gate code 4411', dana),
    };
    await db.note.create({ data: { organization_id: org, entity_type: 'LEAD', entity_id: leads.alreadyGeneral.id, content: 'Already the general note', created_by: dana, is_general: true }, select: { id: true } });
    await db.note.create({ data: { organization_id: org, entity_type: 'LEAD', entity_id: leads.withOtherNote.id, content: 'Dog in the yard', created_by: dana }, select: { id: true } });
    return { org, dana, owner, senior, leads };
  }

  const generalNotes = (db: Db, org: string) =>
    db.note.findMany({
      where: { organization_id: org, is_general: true },
      select: { entity_id: true, content: true, created_by: true, created_at: true },
      orderBy: { created_at: 'asc' },
    });

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const c of clients) await quietly(c.$disconnect());
    for (const name of databases) await quietly(admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    await admin.$disconnect();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  it('moves every lead\'s saved text into its general note, by its creator or the company Owner, and a second run writes nothing', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');
    const { org, dana, owner, leads } = await seed(client);
    const columnBefore = await client.lead.findMany({ where: { organization_id: org }, select: { id: true, notes: true }, orderBy: { id: 'asc' } });

    const dir = deploy(dbUrl, 'through');
    const moved = await generalNotes(client, org);
    expect(moved).toEqual([
      { entity_id: leads.byCreator.id, content: 'Customer prefers mornings.', created_by: dana, created_at: leads.byCreator.createdAt },
      { entity_id: leads.noCreator.id, content: 'Old import text', created_by: owner, created_at: leads.noCreator.createdAt },
      { entity_id: leads.withOtherNote.id, content: 'Gate code 4411', created_by: dana, created_at: leads.withOtherNote.createdAt },
      // The one already there, untouched and not doubled (its time is when the seed wrote it, the newest).
      expect.objectContaining({ entity_id: leads.alreadyGeneral.id, content: 'Already the general note', created_by: dana }),
    ]);
    expect(await client.note.count({ where: { entity_id: { in: [leads.blank.id, leads.empty.id] } } })).toBe(0);
    expect(await client.note.count({ where: { entity_id: leads.withOtherNote.id } })).toBe(2);
    // The lead's own column is left as it was.
    expect(await client.lead.findMany({ where: { organization_id: org }, select: { id: true, notes: true }, orderBy: { id: 'asc' } })).toEqual(columnBefore);

    const again = runFileAgain(dbUrl, dir);
    expect(again.status, again.stderr).toBe(0);
    expect(await generalNotes(client, org)).toEqual(moved);
  }, 300_000);

  it('credits a creator-less lead to the Owner, else the longest-standing active Admin, else leaves it, company by company', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');
    const ownerAndAdmins = await seed(client, true, 'mixed');
    const adminsOnly = await seed(client, false, 'mixed');
    const tiedAdmins = await seed(client, false, 'tie');
    const nobody = await seed(client, false, 'none');

    const dir = deploy(dbUrl, 'through');
    const authorOf = async (leadId: string) =>
      (await client.note.findFirst({ where: { entity_id: leadId, is_general: true }, select: { created_by: true } }))?.created_by ?? null;

    // The Owner comes before any Admin.
    expect(await authorOf(ownerAndAdmins.leads.noCreator.id)).toBe(ownerAndAdmins.owner);
    // No Owner: the active Admin who joined first, not the erased or the inactive one who joined earlier.
    expect(await authorOf(adminsOnly.leads.noCreator.id)).toBe(adminsOnly.senior);
    // Two who joined at the same moment: the lower id.
    expect(await authorOf(tiedAdmins.leads.noCreator.id)).toBe(tiedAdmins.senior);
    // None of the three: no note.
    expect(await authorOf(nobody.leads.noCreator.id)).toBeNull();
    // A lead with a creator is always the creator's, whatever else the company has.
    for (const c of [ownerAndAdmins, adminsOnly, tiedAdmins, nobody]) expect(await authorOf(c.leads.byCreator.id)).toBe(c.dana);

    const snapshot = await client.note.findMany({ orderBy: { id: 'asc' } });
    const again = runFileAgain(dbUrl, dir);
    expect(again.status, again.stderr).toBe(0);
    expect(await client.note.findMany({ orderBy: { id: 'asc' } })).toEqual(snapshot);
  }, 300_000);

  it.skipIf(!hasPsql)('reports, per company, the leads it moves (by whom) and the ones it leaves without a note', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');
    const nobody = await seed(client, false, 'none');
    const adminsOnly = await seed(client, false, 'mixed');
    const withOwner = await seed(client, true, 'none');

    const run = () => spawnSync('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1', '-f', MIGRATION_SQL], { encoding: 'utf8' });
    const first = run();
    expect(first.status, first.stderr).toBe(0);
    expect(first.stderr).toContain(`org ${nobody.org}: 2 leads get a general note (0 by the company Owner, 0 by its longest-standing active Admin), 1 left without one`);
    expect(first.stderr).toContain(`org ${adminsOnly.org}: 3 leads get a general note (0 by the company Owner, 1 by its longest-standing active Admin), 0 left without one`);
    expect(first.stderr).toContain(`org ${withOwner.org}: 3 leads get a general note (1 by the company Owner, 0 by its longest-standing active Admin), 0 left without one`);
    expect(first.stderr).toContain('#3104: 8 general notes written.');

    const second = run();
    expect(second.status, second.stderr).toBe(0);
    expect(second.stderr).toContain(`org ${nobody.org}: 0 leads get a general note (0 by the company Owner, 0 by its longest-standing active Admin), 1 left without one`);
    expect(second.stderr).not.toContain(`org ${adminsOnly.org}:`);
    expect(second.stderr).toContain('#3104: 0 general notes written.');
  }, 300_000);
});
