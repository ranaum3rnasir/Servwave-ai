/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.21 - the mailbox handover migration, applied for real.

   Proves against real Postgres, the way Render applies it (the Prisma deploy command), on a prod-shaped
   copy (every migration BEFORE this one, with a company, a mailbox and a conversation already written):
     - mailboxes gained merged_into_mailbox_id and email_threads gained moved_from_mailbox_id, both nullable and
       empty on the rows that already existed, and the migration writes no row anywhere;
     - both are plain references that go empty when the mailbox row is removed (never a block);
     - the index that finds the conversations moved in from a mailbox exists;
     - a second run of the file changes nothing and prints no error.

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
import { deployMigrations } from './migration-deploy-support';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const MIGRATION = '20261012740000_mailbox_handover';
const PRISMA_DIR = join(__dirname, '..', '..', 'prisma');
const MIGRATION_SQL = join(PRISMA_DIR, 'migrations', MIGRATION, 'migration.sql');
const PRISMA_CLI = join(dirname(require.resolve('prisma/package.json')), 'build', 'index.js');

function assertLocal(raw: string): URL {
  const u = new URL(raw);
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname)) {
    throw new Error(`Mailbox handover migration suite creates and drops databases; refusing non-local host ${u.hostname}`);
  }
  return u;
}

function clientAt(dbUrl: string) {
  return new PrismaClient({ datasources: { db: { url: dbUrl } } });
}
type Db = ReturnType<typeof clientAt>;

suite('mailbox handover migration (real database)', () => {
  const server = url ? assertLocal(url) : new URL('postgresql://localhost/unused');
  const admin = clientAt(url ?? '');
  const databases: string[] = [];
  const clients: Db[] = [];
  const tempDirs: string[] = [];

  async function createDatabase(): Promise<{ dbUrl: string; client: Db }> {
    const name = `s1021_mig_${randomUUID().slice(0, 8)}`;
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    databases.push(name);
    const u = new URL(server.toString());
    u.pathname = `/${name}`;
    const dbUrl = u.toString();
    const client = clientAt(dbUrl);
    clients.push(client);
    // A cluster that also hosts the hosted platform's API roles needs the (stub) auth schema the oldest
    // migrations name; a vanilla server (CI) has neither and needs nothing.
    const roles = await admin.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'authenticated'`);
    if (roles[0].n > 0) {
      await client.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS auth`);
      for (const fn of ['uid() RETURNS uuid', 'role() RETURNS text', 'jwt() RETURNS jsonb']) {
        const type = fn.split(' ').pop();
        await client.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION auth.${fn} LANGUAGE sql AS 'SELECT NULL::${type}'`);
      }
    }
    return { dbUrl, client };
  }

  const deploy = (dbUrl: string, which: 'before' | 'through') => deployMigrations(dbUrl, MIGRATION, which, tempDirs);

  function runFileAgain(dbUrl: string, dir: string) {
    return spawnSync(process.execPath, [PRISMA_CLI, 'db', 'execute', '--url', dbUrl, '--file', MIGRATION_SQL], {
      cwd: dir,
      env: { ...process.env, DATABASE_URL: dbUrl, DIRECT_URL: dbUrl, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
      encoding: 'utf8',
    });
  }

  const ids = { org: randomUUID(), user: randomUUID(), main: randomUUID(), box: randomUUID(), thread: randomUUID() };

  /** One company with its main mailbox, a person with a mailbox, and a conversation in that mailbox. */
  async function seed(db: Db) {
    await db.$executeRawUnsafe(
      `INSERT INTO organizations (id, name, email, address_line1, city, state, postal_code, estimate_terms, estimate_notes, estimate_payment_terms, updated_at)
       VALUES ($1::uuid, 'Co S1021', 's1021@example.test', '1 Test Way', 'Testville', 'MA', '02108', '', '', '', now())`, ids.org);
    await db.$executeRawUnsafe(
      `INSERT INTO users (id, email, first_name, last_name, role, organization_id, updated_at)
       VALUES ($1::uuid, 's1021@example.test', 'Pat', 'Leaver', 'SALES', $2::uuid, now())`, ids.user, ids.org);
    await db.$executeRawUnsafe(
      `INSERT INTO mailboxes (id, organization_id, kind, status, updated_at) VALUES ($1::uuid, $2::uuid, 'main', 'active', now())`, ids.main, ids.org);
    await db.$executeRawUnsafe(
      `INSERT INTO mailboxes (id, organization_id, kind, user_id, holder_user_id, status, updated_at) VALUES ($1::uuid, $2::uuid, 'user', $3::uuid, $3::uuid, 'active', now())`,
      ids.box, ids.org, ids.user);
    await db.$executeRawUnsafe(
      `INSERT INTO email_threads (id, organization_id, mailbox_id, origin, updated_at) VALUES ($1::uuid, $2::uuid, $3::uuid, 'started', now())`,
      ids.thread, ids.org, ids.box);
  }

  const columns = (db: Db, table: string) =>
    db.$queryRawUnsafe<{ column_name: string; data_type: string; is_nullable: string }[]>(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, table);

  const rows = (db: Db) =>
    db.$queryRawUnsafe<unknown[]>(
      `SELECT m.id::text AS mailbox, m.status, m.holder_user_id::text AS holder, t.id::text AS thread, t.mailbox_id::text AS thread_mailbox, t.origin
       FROM mailboxes m LEFT JOIN email_threads t ON t.mailbox_id = m.id ORDER BY m.id`);

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const c of clients) await quietly(c.$disconnect());
    for (const name of databases) await quietly(admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    await admin.$disconnect();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  it('adds the two references on a copy that already holds mailboxes and conversations, and changes nothing that existed', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');
    await seed(client);
    const before = await rows(client);

    deploy(dbUrl, 'through');

    const mailboxColumns = new Map((await columns(client, 'mailboxes')).map((c) => [c.column_name, c]));
    expect(mailboxColumns.get('merged_into_mailbox_id')).toMatchObject({ data_type: 'uuid', is_nullable: 'YES' });
    const threadColumns = new Map((await columns(client, 'email_threads')).map((c) => [c.column_name, c]));
    expect(threadColumns.get('moved_from_mailbox_id')).toMatchObject({ data_type: 'uuid', is_nullable: 'YES' });

    expect(await rows(client)).toEqual(before);
    const empty = await client.$queryRawUnsafe<{ merged: string | null; moved: string | null }[]>(
      `SELECT (SELECT merged_into_mailbox_id::text FROM mailboxes WHERE id = $1::uuid) AS merged,
              (SELECT moved_from_mailbox_id::text FROM email_threads WHERE id = $2::uuid) AS moved`, ids.box, ids.thread);
    expect(empty[0]).toEqual({ merged: null, moved: null });
  }, 300_000);

  it('goes empty, never blocks, when the mailbox a reference names is removed; and indexes the conversations moved in from a mailbox', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');
    await seed(client);
    deploy(dbUrl, 'through');

    await client.$executeRawUnsafe(`UPDATE mailboxes SET merged_into_mailbox_id = $1::uuid, status = 'merged' WHERE id = $2::uuid`, ids.main, ids.box);
    await client.$executeRawUnsafe(`UPDATE email_threads SET moved_from_mailbox_id = $1::uuid WHERE id = $2::uuid`, ids.box, ids.thread);
    // A reference to a mailbox that does not exist is refused, as a foreign key should.
    await expect(client.$executeRawUnsafe(`UPDATE email_threads SET moved_from_mailbox_id = $1::uuid WHERE id = $2::uuid`, randomUUID(), ids.thread)).rejects.toThrow();

    await client.$executeRawUnsafe(`UPDATE email_threads SET mailbox_id = $1::uuid WHERE id = $2::uuid`, ids.main, ids.thread);
    await client.$executeRawUnsafe(`DELETE FROM mailboxes WHERE id = $1::uuid`, ids.box);
    const after = await client.$queryRawUnsafe<{ moved: string | null }[]>(`SELECT moved_from_mailbox_id::text AS moved FROM email_threads WHERE id = $1::uuid`, ids.thread);
    expect(after[0].moved).toBeNull();
    await client.$executeRawUnsafe(`DELETE FROM mailboxes WHERE id = $1::uuid`, ids.main);

    const indexes = await client.$queryRawUnsafe<{ indexname: string }[]>(`SELECT indexname FROM pg_indexes WHERE tablename = 'email_threads'`);
    expect(indexes.map((i) => i.indexname)).toContain('email_threads_moved_from_mailbox_id_idx');
  }, 300_000);

  it('a second run of the file changes nothing and reports no error', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');
    await seed(client);
    const dir = deploy(dbUrl, 'through');
    await client.$executeRawUnsafe(`UPDATE mailboxes SET merged_into_mailbox_id = $1::uuid, status = 'merged' WHERE id = $2::uuid`, ids.main, ids.box);
    const snapshot = await client.$queryRawUnsafe<unknown[]>(`SELECT id::text, status, merged_into_mailbox_id::text FROM mailboxes ORDER BY id`);

    const again = runFileAgain(dbUrl, dir);
    expect(again.stderr).toBe('');
    expect(again.status).toBe(0);
    expect(await client.$queryRawUnsafe(`SELECT id::text, status, merged_into_mailbox_id::text FROM mailboxes ORDER BY id`)).toEqual(snapshot);
  }, 300_000);
});
