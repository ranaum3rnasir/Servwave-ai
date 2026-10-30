/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.18 - the migration behind the Needs review folder, applied for real.

   Proves against real Postgres, the way Render applies it (the Prisma deploy command), on a prod-shaped copy (every migration
   BEFORE this one, with the held mail the old unmatched queue already had):
     - the messages the old queue held get a reason (a failed sender check, else a reply from an address we did not send to), are
       filed under the mailbox their reply address's conversation sits in, else the company's main mailbox, and move to the
       folder "needs_review"; a company with no main mailbox gets them with no mailbox, still held;
     - nothing else changes: delivered mail, sent mail and a conversation's own messages are byte-for-byte what they were;
     - a second run of the file changes nothing and fails nowhere;
     - deleting a mailbox or a conversation never deletes a held message (the links are cleared instead).

   Each case builds its own throwaway database on the server TEST_DATABASE_URL points at and drops it afterwards. Skips when
   TEST_DATABASE_URL is unset, and REFUSES a non-local host: it creates and drops databases. The Prisma CLI runs from a temp
   directory with DATABASE_URL and DIRECT_URL passed explicitly, so it can never fall back to the checkout's .env.
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

const MIGRATION = '20261012780000_needs_review_items';
const PRISMA_DIR = join(__dirname, '..', '..', 'prisma');
const MIGRATION_SQL = join(PRISMA_DIR, 'migrations', MIGRATION, 'migration.sql');
const PRISMA_CLI = join(dirname(require.resolve('prisma/package.json')), 'build', 'index.js');

function assertLocal(raw: string): URL {
  const u = new URL(raw);
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname)) {
    throw new Error(`Needs review migration suite creates and drops databases; refusing non-local host ${u.hostname}`);
  }
  return u;
}

const clientAt = (dbUrl: string) => new PrismaClient({ datasources: { db: { url: dbUrl } } });
type Db = ReturnType<typeof clientAt>;

suite('Needs review migration (real database)', () => {
  const server = url ? assertLocal(url) : new URL('postgresql://localhost/unused');
  const admin = clientAt(url ?? '');
  const databases: string[] = [];
  const clients: Db[] = [];
  const tempDirs: string[] = [];

  async function createDatabase(): Promise<{ dbUrl: string; client: Db }> {
    const name = `s1018_mig_${randomUUID().slice(0, 8)}`;
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    databases.push(name);
    const u = new URL(server.toString());
    u.pathname = `/${name}`;
    const dbUrl = u.toString();
    const client = clientAt(dbUrl);
    clients.push(client);
    return { dbUrl, client };
  }

  const ids = {
    orgA: randomUUID(), orgB: randomUUID(), mainA: randomUUID(), boxA: randomUUID(), threadInBox: randomUUID(),
    tokenInBox: 'tok-in-box-' + randomUUID().slice(0, 8), tokenNoThread: 'tok-no-thread-' + randomUUID().slice(0, 8),
    mismatch: randomUUID(), forged: randomUUID(), noToken: randomUUID(), orphanToken: randomUUID(), delivered: randomUUID(),
    sent: randomUUID(), orgBHeld: randomUUID(),
  };

  async function org(db: Db, id: string, tag: string, withMain: boolean) {
    await db.$executeRawUnsafe(
      `INSERT INTO organizations (id, name, email, address_line1, city, state, postal_code, estimate_terms, estimate_notes,
                                  estimate_payment_terms, email_sender_local_part, updated_at)
       VALUES ($1::uuid, $2, $3, '1 Test Way', 'Testville', 'MA', '02108', '', '', '', $4, now())`,
      id, `Co ${tag}`, `${tag}@example.test`, `co${tag}`);
    if (withMain) {
      await db.$executeRawUnsafe(
        `INSERT INTO mailboxes (id, organization_id, kind, status, updated_at) VALUES ($1::uuid, $2::uuid, 'main', 'active', now())`, ids.mainA, id);
    }
  }

  async function email(db: Db, id: string, orgId: string, f: {
    direction: string; folder: string; match?: string | null; auth?: string | null; token?: string | null; thread?: string | null;
  }) {
    await db.$executeRawUnsafe(
      `INSERT INTO emails (id, account, "from", "to", subject, snippet, body, "at", ts, folder, direction, thread_id, reply_token, inbound_match,
                           inbound_auth, organization_id, updated_at)
       VALUES ($1::uuid, 'user', '{"email":"x@example.test"}'::jsonb, 'jane@example.test', 'Subject', 'snip', '[]'::jsonb, '9:00 AM', 1789000000000,
               $2, $3, $4::uuid, $5, $6::"InboundMatchState", $7::"InboundAuthVerdict", $8::uuid, now())`,
      id, f.folder, f.direction, f.thread ?? null, f.token ?? null, f.match ?? null, f.auth ?? null, orgId);
  }

  /** What the old unmatched queue held, in a company with a main mailbox and in one without. */
  async function seed(db: Db) {
    await org(db, ids.orgA, 'a1018', true);
    await org(db, ids.orgB, 'b1018', false);
    await db.$executeRawUnsafe(
      `INSERT INTO mailboxes (id, organization_id, kind, status, updated_at) VALUES ($1::uuid, $2::uuid, 'user', 'active', now())`, ids.boxA, ids.orgA);
    await db.$executeRawUnsafe(
      `INSERT INTO email_threads (id, organization_id, mailbox_id, origin, updated_at) VALUES ($1::uuid, $2::uuid, $3::uuid, 'started', now())`,
      ids.threadInBox, ids.orgA, ids.boxA);
    await db.$executeRawUnsafe(
      `INSERT INTO reply_tokens (token, organization_id, thread_id, expected_from) VALUES ($1, $2::uuid, $3::uuid, 'jane@example.test')`,
      ids.tokenInBox, ids.orgA, ids.threadInBox);
    await db.$executeRawUnsafe(
      `INSERT INTO reply_tokens (token, organization_id, thread_id, expected_from) VALUES ($1, $2::uuid, NULL, 'jane@example.test')`,
      ids.tokenNoThread, ids.orgA);
    await email(db, ids.mismatch, ids.orgA, { direction: 'in', folder: 'inbox', match: 'UNMATCHED_SENDER', auth: 'PASS', token: ids.tokenInBox });
    await email(db, ids.forged, ids.orgA, { direction: 'in', folder: 'inbox', match: 'UNMATCHED_SENDER', auth: 'FAIL', token: ids.tokenInBox });
    await email(db, ids.noToken, ids.orgA, { direction: 'in', folder: 'inbox', match: 'UNMATCHED_NO_TOKEN', auth: 'UNAVAILABLE' });
    await email(db, ids.orphanToken, ids.orgA, { direction: 'in', folder: 'inbox', match: 'UNMATCHED_SENDER', auth: 'PASS', token: ids.tokenNoThread });
    await email(db, ids.delivered, ids.orgA, { direction: 'in', folder: 'inbox', match: 'MATCHED', auth: 'PASS', token: ids.tokenInBox, thread: ids.threadInBox });
    await email(db, ids.sent, ids.orgA, { direction: 'out', folder: 'sent', thread: ids.threadInBox });
    await email(db, ids.orgBHeld, ids.orgB, { direction: 'in', folder: 'inbox', match: 'UNMATCHED_SENDER', auth: 'PASS' });
  }

  const rows = (db: Db) => db.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT id::text, folder, thread_id::text, review_reason, review_mailbox_id::text, review_thread_id::text, inbound_match::text, inbound_auth::text, unread
       FROM emails ORDER BY id`);
  const byId = (all: Record<string, unknown>[], id: string) => all.find((r) => r.id === id);

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const c of clients) await quietly(c.$disconnect());
    for (const name of databases) await quietly(admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    await admin.$disconnect();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  it('files what the old unmatched queue held under a mailbox with a reason, and changes nothing else', async () => {
    const { dbUrl, client } = await createDatabase();
    deployMigrations(dbUrl, MIGRATION, 'before', tempDirs);
    await seed(client);
    const before = await client.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT id::text, folder, thread_id::text, unread FROM emails ORDER BY id`);

    deployMigrations(dbUrl, MIGRATION, 'through', tempDirs);
    const after = await rows(client);

    // A reply from an address we did not send to: under the mailbox its reply address's conversation sits in, naming it.
    expect(byId(after, ids.mismatch)).toMatchObject({
      folder: 'needs_review', thread_id: null, review_reason: 'sender_mismatch', review_mailbox_id: ids.boxA, review_thread_id: ids.threadInBox, unread: true,
    });
    // A failed sender check names that instead.
    expect(byId(after, ids.forged)).toMatchObject({ folder: 'needs_review', review_reason: 'failed_authentication', review_mailbox_id: ids.boxA });
    // No reply address, or one with no conversation: the main mailbox.
    expect(byId(after, ids.noToken)).toMatchObject({ folder: 'needs_review', review_reason: 'sender_mismatch', review_mailbox_id: ids.mainA, review_thread_id: null });
    expect(byId(after, ids.orphanToken)).toMatchObject({ folder: 'needs_review', review_mailbox_id: ids.mainA, review_thread_id: null });
    // A company with no main mailbox: still held, filed under nothing.
    expect(byId(after, ids.orgBHeld)).toMatchObject({ folder: 'needs_review', review_reason: 'sender_mismatch', review_mailbox_id: null });
    // Everything else is as it was.
    for (const id of [ids.delivered, ids.sent]) {
      expect(byId(after, id)).toMatchObject({ review_reason: null, review_mailbox_id: null, review_thread_id: null });
      expect(byId(after, id)).toMatchObject(byId(before as Record<string, unknown>[], id)!);
    }
    expect(after.filter((r) => r.review_reason !== null)).toHaveLength(5);
  }, 300_000);

  it('changes nothing on a second run of the file, the way the shared staging database may see it', async () => {
    const { dbUrl, client } = await createDatabase();
    deployMigrations(dbUrl, MIGRATION, 'before', tempDirs);
    await seed(client);
    const dir = deployMigrations(dbUrl, MIGRATION, 'through', tempDirs);
    const once = await rows(client);

    const again = spawnSync(process.execPath, [PRISMA_CLI, 'db', 'execute', '--url', dbUrl, '--file', MIGRATION_SQL], {
      cwd: dir,
      env: { ...process.env, DATABASE_URL: dbUrl, DIRECT_URL: dbUrl, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
      encoding: 'utf8',
    });
    expect(again.status, again.stderr).toBe(0);
    expect(await rows(client)).toEqual(once);
  }, 300_000);

  it('never deletes a held message when its mailbox or its conversation is deleted: the links are cleared', async () => {
    const { dbUrl, client } = await createDatabase();
    deployMigrations(dbUrl, MIGRATION, 'before', tempDirs);
    await seed(client);
    deployMigrations(dbUrl, MIGRATION, 'through', tempDirs);

    // Delivered mail of that conversation goes with nothing: only the held link is let go.
    await client.$executeRawUnsafe(`UPDATE emails SET thread_id = NULL WHERE thread_id = $1::uuid`, ids.threadInBox);
    await client.$executeRawUnsafe(`DELETE FROM reply_tokens WHERE thread_id = $1::uuid`, ids.threadInBox);
    await client.$executeRawUnsafe(`DELETE FROM email_threads WHERE id = $1::uuid`, ids.threadInBox);
    await client.$executeRawUnsafe(`DELETE FROM mailboxes WHERE id = $1::uuid`, ids.boxA);

    const after = await rows(client);
    expect(byId(after, ids.mismatch)).toMatchObject({ review_reason: 'sender_mismatch', review_mailbox_id: null, review_thread_id: null });
    expect(byId(after, ids.forged)).toMatchObject({ review_reason: 'failed_authentication', review_mailbox_id: null });
  }, 300_000);
});
