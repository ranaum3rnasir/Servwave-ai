/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.1 - the mailbox register migration, applied for real.

   Proves against real Postgres, the way Render applies it (the Prisma deploy command), on a prod-shaped
   copy (every migration BEFORE this one, companies with no main mailbox):
     - two companies deriving the same part: the one created first keeps it, the other gets the next free
       variant, and a variant never takes a part another company already holds;
     - a company whose CHOSEN part equals another's DERIVED part keeps it, whatever the ages;
     - a company that has a chosen part keeps it;
     - a company whose name gives nothing usable, and one whose effective part is reserved (derived or
       chosen), get a generated neutral part;
     - after the run: one main mailbox per company, a unique non-reserved primary address for each, the
       part frozen on the company, the six reserved parts in the register and issued to nobody;
     - every changed company is in the report with its reason, and the report names ids, never names;
     - a dry run prints the same report and writes nothing;
     - a second run changes nothing.

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

/** The one company the migrations create themselves (the shared demo org). */
const DEMO_ORG = '00000000-0000-0000-0000-000000000001';
const MIGRATION = '20261011090000_mailbox_address_register';
const PRISMA_DIR = join(__dirname, '..', '..', 'prisma');
const MIGRATION_SQL = join(PRISMA_DIR, 'migrations', MIGRATION, 'migration.sql');
const PRISMA_CLI = join(dirname(require.resolve('prisma/package.json')), 'build', 'index.js');
const hasPsql = spawnSync('psql', ['--version']).status === 0;

function assertLocal(raw: string): URL {
  const u = new URL(raw);
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname)) {
    throw new Error(`Mailbox register migration suite creates and drops databases; refusing non-local host ${u.hostname}`);
  }
  return u;
}

function clientAt(dbUrl: string) {
  return new PrismaClient({ datasources: { db: { url: dbUrl } } });
}
type Db = ReturnType<typeof clientAt>;

type Fixture = { name: string; created: string; chosen?: string };
/** Oldest first. The expected part and reason for each is written out by hand below. */
const FIXTURES: Record<string, Fixture> = {
  acmeFirst: { name: 'Acme Doors', created: '2025-01-01T00:00:00Z' },
  acmeSecond: { name: 'ACME  Doors!', created: '2025-01-02T00:00:00Z' },
  // already holds the variant the second Acme would take first
  acmeTwo: { name: 'Acme Doors 2', created: '2025-01-03T00:00:00Z' },
  betaDerived: { name: 'Beta Co', created: '2025-02-01T00:00:00Z' },
  betaChosen: { name: 'Totally Different Name', created: '2025-02-02T00:00:00Z', chosen: 'betaco' },
  chosenKept: { name: 'Delta Services', created: '2025-03-01T00:00:00Z', chosen: 'service' },
  plain: { name: 'Gamma Plumbing', created: '2025-03-02T00:00:00Z' },
  fallback: { name: '!!! ---', created: '2025-04-01T00:00:00Z' },
  reservedDerived: { name: 'Postmaster', created: '2025-04-02T00:00:00Z' },
  reservedChosen: { name: 'Epsilon Locks', created: '2025-04-03T00:00:00Z', chosen: 'abuse' },
};

const EXPECTED: Record<string, { part: string; reason: string | null }> = {
  acmeFirst: { part: 'acmedoors', reason: null },
  acmeSecond: { part: 'acmedoors3', reason: 'collision' }, // acmedoors2 belongs to acmeTwo
  acmeTwo: { part: 'acmedoors2', reason: null },
  betaDerived: { part: 'betaco2', reason: 'collision' }, // the chosen claim beats the older derived one
  betaChosen: { part: 'betaco', reason: null },
  chosenKept: { part: 'service', reason: null },
  plain: { part: 'gammaplumbing', reason: null },
  fallback: { part: 'company1', reason: 'fallback' },
  reservedDerived: { part: 'company2', reason: 'reserved' },
  reservedChosen: { part: 'company3', reason: 'reserved' },
};

suite('mailbox register migration (real database)', () => {
  const server = url ? assertLocal(url) : new URL('postgresql://localhost/unused');
  const admin = clientAt(url ?? '');
  const databases: string[] = [];
  const clients: Db[] = [];
  const tempDirs: string[] = [];

  async function createDatabase(): Promise<{ dbUrl: string; client: Db }> {
    const name = `s101_mig_${randomUUID().slice(0, 8)}`;
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

  /** One company per fixture, written with raw SQL so the scratch database needs no live-client columns. */
  async function seed(db: Db): Promise<Record<string, string>> {
    const ids: Record<string, string> = {};
    for (const [key, f] of Object.entries(FIXTURES)) {
      const id = randomUUID();
      ids[key] = id;
      await db.$executeRawUnsafe(
        `INSERT INTO organizations (id, name, email, address_line1, city, state, postal_code, estimate_terms, estimate_notes,
                                    estimate_payment_terms, email_sender_local_part, created_at, updated_at)
         VALUES ($1::uuid, $2, $3, '1 Test Way', 'Testville', 'MA', '02108', '', '', '', $4, $5::timestamp, now())`,
        id, f.name, `${id.slice(0, 8)}@example.test`, f.chosen ?? null, f.created,
      );
    }
    return ids;
  }

  const state = (db: Db) =>
    db.$queryRawUnsafe<{ id: string; part: string | null; mailboxes: number; primary_part: string | null }[]>(`
      SELECT o.id::text AS id, o.email_sender_local_part AS part,
             (SELECT count(*)::int FROM mailboxes m WHERE m.organization_id = o.id AND m.kind = 'main') AS mailboxes,
             (SELECT a.local_part FROM mailbox_addresses a JOIN mailboxes m ON m.id = a.mailbox_id
               WHERE m.organization_id = o.id AND m.kind = 'main' AND a.is_primary) AS primary_part
      FROM organizations o ORDER BY o.created_at`);

  const addresses = (db: Db) =>
    db.$queryRawUnsafe<{ id: string; local_part: string; kind: string; organization_id: string | null }[]>(
      `SELECT id::text, local_part, kind, organization_id::text FROM mailbox_addresses ORDER BY local_part`);

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const c of clients) await quietly(c.$disconnect());
    for (const name of databases) await quietly(admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    await admin.$disconnect();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  it('gives every company one main mailbox with a unique, non-reserved address, and a second run changes nothing', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');
    const ids = await seed(client);

    const dir = deploy(dbUrl, 'through');

    const rows = await state(client);
    const byOrg = new Map(rows.map((r) => [r.id, r]));
    for (const [key, id] of Object.entries(ids)) {
      const row = byOrg.get(id)!;
      expect(row.part, key).toBe(EXPECTED[key]!.part);
      expect(row.primary_part, key).toBe(EXPECTED[key]!.part);
      expect(row.mailboxes, key).toBe(1);
    }
    const parts = rows.map((r) => r.primary_part);
    expect(new Set(parts).size).toBe(parts.length);

    const register = await addresses(client);
    const reserved = register.filter((a) => a.kind === 'reserved');
    expect(reserved.map((a) => a.local_part).sort()).toEqual(['abuse', 'bounce', 'bounces', 'no-reply', 'noreply', 'postmaster']);
    expect(reserved.every((a) => a.organization_id === null)).toBe(true);
    // the fixtures, plus the one company the migrations themselves create (the shared demo org)
    expect(register.filter((a) => a.kind === 'issued')).toHaveLength(rows.length);
    expect(rows.length).toBe(Object.keys(ids).length + 1);
    expect(byOrg.get(DEMO_ORG)!.primary_part).toBe('demoorganization');

    const again = runFileAgain(dbUrl, dir);
    expect(again.stderr).toBe('');
    expect(again.status).toBe(0);
    expect(await state(client)).toEqual(rows);
    expect(await addresses(client)).toEqual(register);
  }, 300_000);

  it('keeps a frozen part when the company is renamed afterwards', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');
    const ids = await seed(client);
    deploy(dbUrl, 'through');

    await client.$executeRawUnsafe(`UPDATE organizations SET name = 'Renamed Entirely' WHERE id = $1::uuid`, ids.plain);

    const row = (await state(client)).find((r) => r.id === ids.plain)!;
    expect(row.part).toBe('gammaplumbing');
    expect(row.primary_part).toBe('gammaplumbing');
  }, 300_000);

  it.skipIf(!hasPsql)('reports every changed company with its reason, and a dry run writes nothing', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');
    const ids = await seed(client);

    // Dry run: the tables are created (idempotent schema), the data step only reports.
    const dry = spawnSync('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1', '-c', "SET s10_1.dry_run = 'on'", '-f', MIGRATION_SQL], { encoding: 'utf8' });
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stderr).toContain('DRY RUN, nothing written');
    const keyOf = new Map(Object.entries(ids).map(([key, id]) => [id, key]));
    const before = await state(client);
    for (const r of before) {
      expect(r.mailboxes).toBe(0);
      const key = keyOf.get(r.id);
      expect(r.part).toBe(key ? FIXTURES[key]!.chosen ?? null : null);
    }
    expect((await addresses(client)).filter((a) => a.kind === 'issued')).toHaveLength(0);

    const real = spawnSync('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1', '-f', MIGRATION_SQL], { encoding: 'utf8' });
    expect(real.status, real.stderr).toBe(0);
    const notices = real.stderr.split('\n').filter((l) => l.includes('S10.1'));

    const changed = Object.entries(EXPECTED).filter(([, e]) => e.reason !== null);
    for (const [key, e] of changed) {
      expect(notices.some((l) => l.includes(`org ${ids[key]}`) && l.includes(`-> ${e.part} (${e.reason})`)), key).toBe(true);
    }
    for (const [key, e] of Object.entries(EXPECTED).filter(([, x]) => x.reason === null)) {
      expect(notices.some((l) => l.includes(`org ${ids[key]}`)), key).toBe(false);
    }
    // ids and parts only, never a company name
    expect(notices.join('\n')).not.toMatch(/Gamma|Postmaster|Acme Doors/);
    expect(notices.some((l) => l.includes(`S10.1 done: ${before.length} companies, ${before.length} main mailboxes, ${before.length} primary main addresses`))).toBe(true);
  }, 300_000);

  it('hands a company already through the register its part back, and leaves new companies to the next run', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');
    await seed(client);
    const dir = deploy(dbUrl, 'through');

    // A company created afterwards derives a part a registered company holds.
    const id = randomUUID();
    await client.$executeRawUnsafe(
      `INSERT INTO organizations (id, name, email, address_line1, city, state, postal_code, estimate_terms, estimate_notes, estimate_payment_terms, updated_at)
       VALUES ($1::uuid, 'Gamma Plumbing', 'late@example.test', '1 Test Way', 'Testville', 'MA', '02108', '', '', '', now())`, id);
    const run = runFileAgain(dbUrl, dir);
    expect(run.status, run.stderr).toBe(0);

    const row = (await state(client)).find((r) => r.id === id)!;
    expect(row.part).toBe('gammaplumbing2');
    expect(row.primary_part).toBe('gammaplumbing2');
    expect((await state(client)).find((r) => r.part === 'gammaplumbing')!.mailboxes).toBe(1);
  }, 300_000);
});
