/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.4 - every email conversation is placed in a mailbox, with an
   origin, by the migration, applied for real.

   Proves against real Postgres, the way Render applies it (the Prisma deploy command), on a prod-shaped
   copy (every migration BEFORE this one, companies that already have their main mailbox from S10.1):
     - every conversation lands in ITS company's main mailbox, its assignee kept;
     - a conversation whose reply token names a record (an estimate's, with a customer reply in it) gets
       origin "record" with that record; every other one gets origin "migrated";
     - loose system email (no conversation) stays in no mailbox, and the customer's reply stays where it was;
     - a second run changes nothing; a dry run reports counts and writes nothing.

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

const MIGRATION = '20261011100000_email_thread_mailbox_origin';
const PRISMA_DIR = join(__dirname, '..', '..', 'prisma');
const MIGRATION_SQL = join(PRISMA_DIR, 'migrations', MIGRATION, 'migration.sql');
const PRISMA_CLI = join(dirname(require.resolve('prisma/package.json')), 'build', 'index.js');
const hasPsql = spawnSync('psql', ['--version']).status === 0;

function assertLocal(raw: string): URL {
  const u = new URL(raw);
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname)) {
    throw new Error(`Email thread mailbox migration suite creates and drops databases; refusing non-local host ${u.hostname}`);
  }
  return u;
}

function clientAt(dbUrl: string) {
  return new PrismaClient({ datasources: { db: { url: dbUrl } } });
}
type Db = ReturnType<typeof clientAt>;

suite('email thread mailbox migration (real database)', () => {
  const server = url ? assertLocal(url) : new URL('postgresql://localhost/unused');
  const admin = clientAt(url ?? '');
  const databases: string[] = [];
  const clients: Db[] = [];
  const tempDirs: string[] = [];

  async function createDatabase(): Promise<{ dbUrl: string; client: Db }> {
    const name = `s104_mig_${randomUUID().slice(0, 8)}`;
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

  const ids = {
    orgA: randomUUID(), orgB: randomUUID(), mainA: randomUUID(), mainB: randomUUID(),
    jane: randomUUID(),
    assigned: randomUUID(), unassigned: randomUUID(), estimate: randomUUID(), composed: randomUUID(), other: randomUUID(),
    estimateId: randomUUID(), customerId: randomUUID(),
    sentEmail: randomUUID(), replyEmail: randomUUID(), looseEmail: randomUUID(),
  };

  async function org(db: Db, id: string, mainId: string, tag: string) {
    await db.$executeRawUnsafe(
      `INSERT INTO organizations (id, name, email, address_line1, city, state, postal_code, estimate_terms, estimate_notes,
                                  estimate_payment_terms, email_sender_local_part, updated_at)
       VALUES ($1::uuid, $2, $3, '1 Test Way', 'Testville', 'MA', '02108', '', '', '', $4, now())`,
      id, `Co ${tag}`, `${tag}@example.test`, `co${tag}`);
    // What S10.1 left behind: the company's main mailbox.
    await db.$executeRawUnsafe(
      `INSERT INTO mailboxes (id, organization_id, kind, status, updated_at) VALUES ($1::uuid, $2::uuid, 'main', 'active', now())`,
      mainId, id);
  }

  async function thread(db: Db, id: string, orgId: string, assignee: string | null) {
    await db.$executeRawUnsafe(
      `INSERT INTO email_threads (id, organization_id, assigned_to_user_id, updated_at) VALUES ($1::uuid, $2::uuid, $3::uuid, now())`,
      id, orgId, assignee);
  }

  async function token(db: Db, t: string, orgId: string, threadId: string, entity: { type: string; id: string } | null) {
    await db.$executeRawUnsafe(
      `INSERT INTO reply_tokens (token, organization_id, thread_id, entity_type, entity_id, customer_id, expected_from)
       VALUES ($1, $2::uuid, $3::uuid, $4, $5::uuid, $6::uuid, 'jane@example.test')`,
      t, orgId, threadId, entity?.type ?? null, entity?.id ?? null, entity ? ids.customerId : null);
  }

  async function email(db: Db, id: string, orgId: string, threadId: string | null, fields: { account: string; direction: string; folder: string }) {
    await db.$executeRawUnsafe(
      `INSERT INTO emails (id, account, "from", "to", subject, snippet, body, "at", ts, folder, direction, thread_id, organization_id, updated_at)
       VALUES ($1::uuid, $2, '{"email":"x@example.test"}'::jsonb, 'jane@example.test', 'Subject', 'snip', '[]'::jsonb, '9:00 AM', 1789000000000,
               $3, $4, $5::uuid, $6::uuid, now())`,
      id, fields.account, fields.folder, fields.direction, threadId, orgId);
  }

  /** Two companies, each with its main mailbox; company A holds every kind of conversation. */
  async function seed(db: Db) {
    await org(db, ids.orgA, ids.mainA, 'a' + ids.orgA.slice(0, 6).replace(/[0-9]/g, 'x'));
    await org(db, ids.orgB, ids.mainB, 'b' + ids.orgB.slice(0, 6).replace(/[0-9]/g, 'x'));
    await db.$executeRawUnsafe(
      `INSERT INTO users (id, email, first_name, last_name, role, organization_id, updated_at)
       VALUES ($1::uuid, $2, 'Jane', 'Doe', 'ADMIN', $3::uuid, now())`,
      ids.jane, `jane${ids.jane.slice(0, 6)}@example.test`, ids.orgA);
    await thread(db, ids.assigned, ids.orgA, ids.jane);
    await thread(db, ids.unassigned, ids.orgA, null);
    await thread(db, ids.estimate, ids.orgA, null);
    await token(db, 'tok-estimate-' + ids.estimate.slice(0, 8), ids.orgA, ids.estimate, { type: 'estimate', id: ids.estimateId });
    await email(db, ids.sentEmail, ids.orgA, ids.estimate, { account: 'system', direction: 'out', folder: 'sent' });
    await email(db, ids.replyEmail, ids.orgA, ids.estimate, { account: 'user', direction: 'in', folder: 'inbox' });
    await thread(db, ids.composed, ids.orgA, ids.jane);
    // a compose-path token names a thread and a customer, never a record
    await token(db, 'tok-composed-' + ids.composed.slice(0, 8), ids.orgA, ids.composed, null);
    await thread(db, ids.other, ids.orgB, null);
    await email(db, ids.looseEmail, ids.orgA, null, { account: 'system', direction: 'out', folder: 'sent' });
  }

  const threads = (db: Db) =>
    db.$queryRawUnsafe<
      { id: string; mailbox_id: string | null; origin: string; record_type: string | null; record_id: string | null; assigned_to_user_id: string | null }[]
    >(`SELECT id::text, mailbox_id::text, origin, record_type, record_id::text, assigned_to_user_id::text
       FROM email_threads ORDER BY id`);

  const emails = (db: Db) =>
    db.$queryRawUnsafe<{ id: string; thread_id: string | null }[]>(`SELECT id::text, thread_id::text FROM emails ORDER BY id`);

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const c of clients) await quietly(c.$disconnect());
    for (const name of databases) await quietly(admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    await admin.$disconnect();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  it('puts every conversation in its own main mailbox with its origin, leaves loose system email alone, and a second run changes nothing', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');
    await seed(client);
    const emailsBefore = await emails(client);

    const dir = deploy(dbUrl, 'through');

    const byId = new Map((await threads(client)).map((t) => [t.id, t]));
    const at = (id: string) => byId.get(id)!;
    expect(at(ids.assigned)).toMatchObject({ mailbox_id: ids.mainA, origin: 'migrated', assigned_to_user_id: ids.jane });
    expect(at(ids.unassigned)).toMatchObject({ mailbox_id: ids.mainA, origin: 'migrated', assigned_to_user_id: null });
    expect(at(ids.composed)).toMatchObject({ mailbox_id: ids.mainA, origin: 'migrated', assigned_to_user_id: ids.jane, record_type: null, record_id: null });
    expect(at(ids.estimate)).toMatchObject({
      mailbox_id: ids.mainA, origin: 'record', record_type: 'estimate', record_id: ids.estimateId, assigned_to_user_id: null,
    });
    // the other company's conversation goes to ITS main mailbox
    expect(at(ids.other)).toMatchObject({ mailbox_id: ids.mainB, origin: 'migrated' });
    // every conversation in the database has a mailbox
    expect([...byId.values()].every((t) => t.mailbox_id !== null)).toBe(true);

    // email rows did not move; loose system email is still in no conversation, so in no mailbox
    expect(await emails(client)).toEqual(emailsBefore);
    expect((await emails(client)).find((e) => e.id === ids.looseEmail)!.thread_id).toBeNull();
    expect((await emails(client)).find((e) => e.id === ids.replyEmail)!.thread_id).toBe(ids.estimate);

    const snapshot = await threads(client);
    const again = runFileAgain(dbUrl, dir);
    expect(again.stderr).toBe('');
    expect(again.status).toBe(0);
    expect(await threads(client)).toEqual(snapshot);
  }, 300_000);

  it('leaves a conversation that already has a mailbox exactly as it is', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');
    await seed(client);
    const dir = deploy(dbUrl, 'through');

    // written by the new code after the first run: a conversation started here, in the main mailbox
    const fresh = randomUUID();
    await client.$executeRawUnsafe(
      `INSERT INTO email_threads (id, organization_id, mailbox_id, origin, updated_at) VALUES ($1::uuid, $2::uuid, $3::uuid, 'started', now())`,
      fresh, ids.orgA, ids.mainA);
    const run = runFileAgain(dbUrl, dir);
    expect(run.status, run.stderr).toBe(0);

    const row = (await threads(client)).find((t) => t.id === fresh)!;
    expect(row).toMatchObject({ mailbox_id: ids.mainA, origin: 'started' });
  }, 300_000);

  it.skipIf(!hasPsql)('reports per-environment counts, and a dry run writes nothing', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');
    await seed(client);

    const dry = spawnSync('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1', '-c', "SET s10_4.dry_run = 'on'", '-f', MIGRATION_SQL], { encoding: 'utf8' });
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stderr).toContain('DRY RUN, nothing written');
    // 5 conversations to place: 4 in company A, 1 in company B; 1 of them is a record conversation
    expect(dry.stderr).toContain('S10.4 5 conversations, 5 to place, 1 record, 4 migrated');
    expect((await threads(client)).every((t) => t.mailbox_id === null)).toBe(true);

    const real = spawnSync('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1', '-f', MIGRATION_SQL], { encoding: 'utf8' });
    expect(real.status, real.stderr).toBe(0);
    expect(real.stderr).toContain('S10.4 done: 5 conversations, 5 in a mailbox, 1 record, 4 migrated, 0 without a main mailbox');
    // ids and counts only, never a subject or an address
    expect(real.stderr).not.toMatch(/jane@example|Subject/);
  }, 300_000);
});
