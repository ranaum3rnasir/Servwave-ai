/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.17 - the migration that lets a RECEIVED email's attachments be stored, applied for real.

   Proves against real Postgres, the way Render applies it (the Prisma deploy command), on a prod-shaped copy (every migration
   BEFORE this one, with a composed email that already has a file):
     - nothing existing changes: the email and its file are kept, the file's new provider id is empty, and the email reads "no
       files on their way" with no tries (mail that arrived before this is never retried);
     - the provider's attachment id is unique within its email: the same id twice on one email is refused, the same id on another
       email is fine, and any number of files with no provider id (every composed one) sit side by side;
     - a second run of the file changes nothing and fails nowhere.

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

const MIGRATION = '20261012760000_received_email_attachments';
const PRISMA_DIR = join(__dirname, '..', '..', 'prisma');
const MIGRATION_SQL = join(PRISMA_DIR, 'migrations', MIGRATION, 'migration.sql');
const PRISMA_CLI = join(dirname(require.resolve('prisma/package.json')), 'build', 'index.js');

function assertLocal(raw: string): URL {
  const u = new URL(raw);
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname)) {
    throw new Error(`Received email attachments migration suite creates and drops databases; refusing non-local host ${u.hostname}`);
  }
  return u;
}

const clientAt = (dbUrl: string) => new PrismaClient({ datasources: { db: { url: dbUrl } } });
type Db = ReturnType<typeof clientAt>;

suite('received email attachments migration (real database)', () => {
  const server = url ? assertLocal(url) : new URL('postgresql://localhost/unused');
  const admin = clientAt(url ?? '');
  const databases: string[] = [];
  const clients: Db[] = [];
  const tempDirs: string[] = [];

  async function createDatabase(): Promise<{ dbUrl: string; client: Db }> {
    const name = `s1017_mig_${randomUUID().slice(0, 8)}`;
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    databases.push(name);
    const u = new URL(server.toString());
    u.pathname = `/${name}`;
    const dbUrl = u.toString();
    const client = clientAt(dbUrl);
    clients.push(client);
    return { dbUrl, client };
  }

  const ids = { org: randomUUID(), emailA: randomUUID(), emailB: randomUUID(), composed: randomUUID() };

  /** A company with two emails, one of which carries a composed file (no provider id, as every file was before this). */
  async function seed(db: Db) {
    await db.$executeRawUnsafe(
      `INSERT INTO organizations (id, name, email, address_line1, city, state, postal_code, estimate_terms, estimate_notes,
                                  estimate_payment_terms, email_sender_local_part, updated_at)
       VALUES ($1::uuid, 'Co', 'co@example.test', '1 Test Way', 'Testville', 'MA', '02108', '', '', '', 'cos1017', now())`, ids.org);
    for (const id of [ids.emailA, ids.emailB]) {
      await db.$executeRawUnsafe(
        `INSERT INTO emails (id, account, "from", "to", subject, snippet, body, "at", ts, folder, direction, organization_id, updated_at)
         VALUES ($1::uuid, 'user', '{"email":"x@example.test"}'::jsonb, 'jane@example.test', 'Subject', 'snip', '[]'::jsonb, '9:00 AM',
                 1789000000000, 'sent', 'out', $2::uuid, now())`, id, ids.org);
    }
    await db.$executeRawUnsafe(
      `INSERT INTO email_attachments (id, email_id, file_name, content_type, file_size, storage_path, position, organization_id)
       VALUES ($1::uuid, $2::uuid, 'quote.pdf', 'application/pdf', 10, 'o/email/e/quote.pdf', 0, $3::uuid)`, ids.composed, ids.emailA, ids.org);
  }

  const addFile = (db: Db, email: string, providerId: string | null, position: number) =>
    db.$executeRawUnsafe(
      `INSERT INTO email_attachments (id, email_id, file_name, content_type, file_size, storage_path, position, provider_attachment_id, organization_id)
       VALUES (gen_random_uuid(), $1::uuid, 'f.jpg', 'image/jpeg', 1, $2, $3, $4, $5::uuid)`,
      email, `o/email/${email}/${randomUUID()}.jpg`, position, providerId, ids.org);

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const c of clients) await quietly(c.$disconnect());
    for (const name of databases) await quietly(admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    await admin.$disconnect();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  it('leaves existing mail and files as they were, and a second run of the file changes nothing', async () => {
    const { dbUrl, client } = await createDatabase();
    deployMigrations(dbUrl, MIGRATION, 'before', tempDirs);
    await seed(client);

    const dir = deployMigrations(dbUrl, MIGRATION, 'through', tempDirs);

    const emails = await client.$queryRawUnsafe<{ id: string; attachments_pending: boolean; attachment_attempts: number }[]>(
      `SELECT id::text, attachments_pending, attachment_attempts FROM emails ORDER BY id`);
    expect(emails).toHaveLength(2);
    for (const email of emails) expect(email).toMatchObject({ attachments_pending: false, attachment_attempts: 0 });
    const files = await client.$queryRawUnsafe<{ id: string; file_name: string; provider_attachment_id: string | null }[]>(
      `SELECT id::text, file_name, provider_attachment_id FROM email_attachments`);
    expect(files).toEqual([{ id: ids.composed, file_name: 'quote.pdf', provider_attachment_id: null }]);

    const again = spawnSync(process.execPath, [PRISMA_CLI, 'db', 'execute', '--url', dbUrl, '--file', MIGRATION_SQL], {
      cwd: dir,
      env: { ...process.env, DATABASE_URL: dbUrl, DIRECT_URL: dbUrl, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
      encoding: 'utf8',
    });
    expect(again.status, again.stderr).toBe(0);
    expect(await client.$queryRawUnsafe(`SELECT id::text, file_name, provider_attachment_id FROM email_attachments`)).toEqual(files);
  }, 300_000);

  it('keeps a provider attachment id unique within its email, and lets files with none sit side by side', async () => {
    const { dbUrl, client } = await createDatabase();
    deployMigrations(dbUrl, MIGRATION, 'before', tempDirs);
    await seed(client);
    deployMigrations(dbUrl, MIGRATION, 'through', tempDirs);

    await addFile(client, ids.emailA, 'att_1', 1);
    await expect(addFile(client, ids.emailA, 'att_1', 2)).rejects.toThrow(/23505.*(email_id, provider_attachment_id)/s);
    // The same provider id on another email (a message that reached two mailboxes is stored once for each) is fine.
    await addFile(client, ids.emailB, 'att_1', 0);
    // Composed files carry no provider id: any number of them.
    await addFile(client, ids.emailA, null, 3);
    await addFile(client, ids.emailA, null, 4);

    const [{ n }] = await client.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM email_attachments`);
    expect(n).toBe(5);
  }, 300_000);
});
