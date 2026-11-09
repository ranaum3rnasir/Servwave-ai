/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.3 - the user mailbox migration, applied for real.

   Proves against real Postgres, the way Render applies it (the Prisma deploy command), on a prod-shaped copy (every
   migration BEFORE this one, companies with users and no user mailboxes):
     - every ACTIVE user, admins included, gets a first.last.company mailbox; inactive users get none;
     - among users who want the same name part the earlier-created one wins and the later ones get a mailbox in
       "address needed" with no address (ties broken by id); the register never adds a number or an initial;
     - a name part issued before in the company (a leaver's, or one held under an earlier company part) is taken;
     - a user with no usable name, and every user of a company with no frozen part, land in "address needed";
     - the address rule written in SQL equals the TypeScript pure core, name by name, over a wide set of names (accents,
       emoji, non-Latin scripts, CR/LF, angle brackets, very long names) and company parts of several lengths;
     - the dry run writes nothing, previews exactly what the run then does and names users by id only; the proof check
       confirms the result and compares it with the dry run;
     - no bell, notification or email row is written; a second run changes nothing; a user an older backend created
       during the deploy overlap gets a mailbox from running the file again.

   The database is built once on the server TEST_DATABASE_URL points at and dropped afterwards. Skips when
   TEST_DATABASE_URL is unset, and REFUSES a non-local host: it creates and drops databases. The Prisma CLI runs from a
   temp directory with DATABASE_URL and DIRECT_URL passed explicitly, so it can never fall back to the checkout's .env (the
   shared staging DB). Rows are written with raw SQL so a column a later slice adds cannot break the older-schema database.
   Nothing here imports, at load, a module that touches the app's client.
   ========================================================================== */

import { describe, it, expect, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import { mkdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { PrismaClient } from '@prisma/client';
import {
  USER_MAILBOX_MIGRATION, dryRunReport, formatDryRunReport, formatProofReport, proofReport, stopConditionMessage,
} from '../lib/mailbox/user-mailbox-report';
import { buildUserNamePart } from '../lib/mailbox/address-core';
import { deployMigrations, createMigrationDatabase } from './migration-deploy-support';

// The register reads the mailbox domain from the environment settings; nothing else here needs them.
vi.mock('../config/env', () => ({
  env: { MAILBOX_DOMAIN: 'staging.mail.test.com', EMAIL_FROM_BUSINESS: 'no-reply@mail.test.com', MAILBOX_ADDRESS_HASH_KEY: 'test-mailbox-hash-key-0123456789abcdef' },
}));

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const PRISMA_DIR = join(__dirname, '..', '..', 'prisma');
const MIGRATION_SQL = join(PRISMA_DIR, 'migrations', USER_MAILBOX_MIGRATION, 'migration.sql');
const PRISMA_CLI = join(dirname(require.resolve('prisma/package.json')), 'build', 'index.js');
const TSX_CLI = join(dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');
const REPORT_SCRIPT = join(__dirname, '..', 'scripts', 'user-mailbox-report.ts');

function assertLocal(raw: string): URL {
  const u = new URL(raw);
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname)) {
    throw new Error(`User mailbox migration suite creates and drops databases; refusing non-local host ${u.hostname}`);
  }
  return u;
}

function clientAt(dbUrl: string) {
  return new PrismaClient({ datasources: { db: { url: dbUrl } } });
}
type Db = ReturnType<typeof clientAt>;

const iso = (minutes: number) => new Date(Date.UTC(2025, 0, 1, 0, minutes)).toISOString();

suite('user mailbox migration (real database)', () => {
  const server = url ? assertLocal(url) : new URL('postgresql://localhost/unused');
  const admin = clientAt(url ?? '');
  const databases: string[] = [];
  const clients: Db[] = [];
  const tempDirs: string[] = [];

  async function createDatabase(template?: string): Promise<{ dbUrl: string; client: Db; name: string }> {
    const name = `s103_mig_${randomUUID().slice(0, 8)}`;
    if (template) await admin.$executeRawUnsafe(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
    else await createMigrationDatabase(admin, name, USER_MAILBOX_MIGRATION, tempDirs);
    databases.push(name);
    const u = new URL(server.toString());
    u.pathname = `/${name}`;
    const client = clientAt(u.toString());
    clients.push(client);
    return { dbUrl: u.toString(), client, name };
  }

  function cli(dbUrl: string, args: string[], cwd: string) {
    return spawnSync(process.execPath, [PRISMA_CLI, ...args], {
      cwd,
      env: { ...process.env, DATABASE_URL: dbUrl, DIRECT_URL: dbUrl, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
      encoding: 'utf8',
    });
  }

  /** The Prisma deploy command over only the migrations before this one, or through this one and no later (see migration-deploy-support). */
  const deploy = (dbUrl: string, which: 'before' | 'through') => deployMigrations(dbUrl, USER_MAILBOX_MIGRATION, which, tempDirs);

  /** The migration file run again, the way the shared staging database may see it. */
  function runFileAgain(dbUrl: string, dir: string) {
    return cli(dbUrl, ['db', 'execute', '--url', dbUrl, '--file', MIGRATION_SQL], dir);
  }

  function report(dbUrl: string, args: string[]) {
    return spawnSync(process.execPath, [TSX_CLI, REPORT_SCRIPT, ...args], {
      env: { ...process.env, DATABASE_URL: '' },
      encoding: 'utf8',
      cwd: join(__dirname, '..', '..'),
    });
  }

  async function company(db: Db, part: string | null) {
    const id = randomUUID();
    await db.$executeRawUnsafe(
      `INSERT INTO organizations (id, name, email, address_line1, city, state, postal_code, estimate_terms, estimate_notes,
                                  estimate_payment_terms, email_sender_local_part, updated_at)
       VALUES ($1::uuid, $2, $3, '1 Test Way', 'Testville', 'MA', '02108', '', '', '', $4, now())`,
      id, `s103-${id.slice(0, 8)}`, `${id.slice(0, 8)}@example.test`, part,
    );
    return id;
  }

  async function person(
    db: Db, org: string, first: string, last: string,
    opts: { created: string; active?: boolean; role?: string; id?: string } = { created: iso(0) },
  ) {
    const id = opts.id ?? randomUUID();
    await db.$executeRawUnsafe(
      `INSERT INTO users (id, organization_id, email, first_name, last_name, role, is_active, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::"Role", $7, $8::timestamp, now())`,
      id, org, `${id}@example.test`, first, last, opts.role ?? 'TECHNICIAN', opts.active ?? true, opts.created,
    );
    return id;
  }

  /** A mailbox (with its primary address) the migration finds already in place. */
  async function existingMailbox(db: Db, org: string, userId: string, localPart: string | null, status = 'active') {
    const box = randomUUID();
    await db.$executeRawUnsafe(
      `INSERT INTO mailboxes (id, organization_id, kind, user_id, holder_user_id, status, updated_at) VALUES ($1::uuid, $2::uuid, 'user', $3::uuid, $3::uuid, $4, now())`,
      box, org, userId, status,
    );
    if (localPart) {
      await db.$executeRawUnsafe(
        `INSERT INTO mailbox_addresses (id, local_part, kind, organization_id, mailbox_id, is_primary) VALUES (gen_random_uuid(), $1, 'issued', $2::uuid, $3::uuid, true)`,
        localPart, org, box,
      );
    }
    return box;
  }

  const mailboxOf = (db: Db, userId: string) =>
    db.$queryRawUnsafe<{ status: string; local_part: string | null; holder: string | null }[]>(
      `SELECT m.status, a.local_part, m.holder_user_id::text AS holder
       FROM mailboxes m LEFT JOIN mailbox_addresses a ON a.mailbox_id = m.id
       WHERE m.kind = 'user' AND m.user_id = $1::uuid AND m.status <> 'merged'`, userId);

  /** Everything the migration may write, in a form two runs can be compared in. */
  const snapshot = async (db: Db) => ({
    mailboxes: await db.$queryRawUnsafe(`SELECT user_id::text, organization_id::text, kind, status, holder_user_id::text FROM mailboxes ORDER BY kind, user_id, organization_id`),
    addresses: await db.$queryRawUnsafe(`SELECT local_part, kind, organization_id::text, is_primary FROM mailbox_addresses ORDER BY local_part`),
  });

  // Every DROP DATABASE forces an immediate checkpoint on the server, and the server's settings are durable (spec #3234: no
  // non-durable settings). This file drops over a dozen scratch databases one after another, and the other lanes' files do the same, so
  // under lanes the drops queue behind each other's checkpoints: measured 47 s with only these two files in the lanes, and past the lane
  // run's 60 s hook limit in two full runs at load 8-13. It is slow teardown, not a stuck one, so this hook alone gets the room.
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const c of clients) await quietly(c.$disconnect());
    for (const name of databases) await quietly(admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    await admin.$disconnect();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  }, 300_000);

  // ── The named cases ──────────────────────────────────────────────────────────────────────────────────────────────

  describe('a prod-shaped database', () => {
    const ids: Record<string, string> = {};
    let db: Db;
    let dbUrl: string;
    let dir: string;
    let dry: Awaited<ReturnType<typeof dryRunReport>>;
    let dryText: string;
    let before: Awaited<ReturnType<typeof snapshot>>;
    let notificationsBefore: number;
    let org1: string;
    let org2: string;
    let org3: string;
    let wide: Array<{ user: string; part: string; first: string; last: string }> = [];

    const LONG = 'x'.repeat(200);
    const PART_40 = 'c'.repeat(40);

    // Names for the SQL-equals-TypeScript comparison: hand-picked awkward ones plus a seeded random set.
    const AWKWARD: Array<[string, string]> = [
      ['Jane', 'Smith'], ['José', 'Müller'], ["Mary-Ann", "O'Neil"], ['  Agent  ', '007'], ['Jane 😀', 'Smith 😀'], ['山田', '太郎'],
      ['Иван', 'Петров'], ['Cher', ''], ['', 'Prince'], ['', ''], ['😀', '😀'], ['Ja\r\nne', 'Bcc: x@y.com\nSmith'],
      ['<script>', '"quoted"'], ['a@b', 'c,d;e(f)'], ['Kate', 'İvan'], ['J.R.', 'Ewing Jr.'], ['@[`{', '/:'],
      ['ª', 'µ'], ['ß', 'ø'], ['Ab\tc', 'd e'], [LONG, LONG], [LONG, 'li'], ['jo', LONG], [LONG, ''], ['', LONG],
      ['a'.repeat(23), 'smith'], ['a'.repeat(11), 'b'.repeat(11)], ['a'.repeat(12), 'b'.repeat(11)], ['a'.repeat(11), 'b'.repeat(12)],
      ['a'.repeat(22), 'b'], ['a', 'b'.repeat(22)], ['a', 'b'], ['0', '9'], ['ZZ', 'zz'],
    ];

    it('builds a database of companies with users and no user mailboxes', async () => {
      ({ dbUrl, client: db } = await createDatabase());
      deploy(dbUrl, 'before');

      org1 = await company(db, 'acme');
      org2 = await company(db, PART_40);
      org3 = await company(db, null);
      ids.org1 = org1; ids.org2 = org2; ids.org3 = org3;
      ids.emptyOrg = await company(db, 'emptyco');

      // Company 1 -----------------------------------------------------------------------------------------------
      ids.jane1 = await person(db, org1, 'Jane', 'Smith', { created: iso(1) });
      ids.jane2 = await person(db, org1, 'jane', 'SMITH', { created: iso(2) });
      ids.jane3 = await person(db, org1, ' Jane ', 'Smith!', { created: iso(3) });
      ids.jose = await person(db, org1, 'José', 'Müller', { created: iso(4) });
      ids.mary = await person(db, org1, 'Mary-Ann', "O'Neil", { created: iso(5), role: 'ADMIN' });
      ids.cher = await person(db, org1, 'Cher', '', { created: iso(6) });
      ids.prince = await person(db, org1, '', 'Prince', { created: iso(7) });
      ids.nameless = await person(db, org1, '山田', '太郎', { created: iso(8) });
      ids.inactive = await person(db, org1, 'Ina', 'Ctive', { created: iso(9), active: false });
      // a name part issued to a leaver, and one issued under an earlier company part
      ids.leaver = await person(db, org1, 'Leo', 'Leaver', { created: iso(10), active: false });
      await existingMailbox(db, org1, ids.leaver, 'leo.leaver.acme');
      ids.hireLikeLeaver = await person(db, org1, 'Leo', 'Leaver', { created: iso(11) });
      ids.raeOld = await person(db, org1, 'Rae', 'Ray', { created: iso(12), active: false });
      await existingMailbox(db, org1, ids.raeOld, 'rae.ray.oldacme');
      ids.raeNew = await person(db, org1, 'Rae', 'Ray', { created: iso(13) });
      // already has a live mailbox (the app made it): untouched, and counted as holding its name part
      ids.already = await person(db, org1, 'Al', 'Ready', { created: iso(14) });
      await existingMailbox(db, org1, ids.already, 'al.ready.acme');
      ids.alreadyTwin = await person(db, org1, 'Al', 'Ready', { created: iso(15) });
      // a mailbox merged away does not count as live
      ids.merged = await person(db, org1, 'Mel', 'Merged', { created: iso(16) });
      await existingMailbox(db, org1, ids.merged, null, 'merged');
      // equal creation time: the lower id wins
      const [lowId, highId] = [randomUUID(), randomUUID()].sort();
      ids.tieHigh = await person(db, org1, 'Tia', 'Tie', { created: iso(17), id: highId });
      ids.tieLow = await person(db, org1, 'Tia', 'Tie', { created: iso(17), id: lowId });
      ids.longName = await person(db, org1, LONG, LONG, { created: iso(18) });

      // Company 2: a 40-character company part leaves 23 characters for the name part --------------------------------
      ids.jane2co = await person(db, org2, 'Jane', 'Smith', { created: iso(1) });
      ids.tight = await person(db, org2, 'a'.repeat(30), 'b'.repeat(30), { created: iso(2) });
      ids.tightShortFirst = await person(db, org2, 'jo', 'b'.repeat(60), { created: iso(3) });
      ids.tightShortLast = await person(db, org2, 'a'.repeat(60), 'li', { created: iso(4) });
      ids.tightOneName = await person(db, org2, LONG, '', { created: iso(5) });

      // Company 3 has no frozen part ------------------------------------------------------------------------------------
      ids.noPart1 = await person(db, org3, 'Jane', 'Smith', { created: iso(1) });
      ids.noPart2 = await person(db, org3, 'Ann', 'Lee', { created: iso(2) });

      // The wide set: one company per company-part length, one user per name, so no two collide ---------------------------
      const rng = mulberry32(103);
      const alphabet = [...'abcXYZ019 -\'.,@<>"\r\n\t😀éüßøИ山', '\u212A', '\u0130'];
      const randomName = () => Array.from({ length: Math.floor(rng() * 40) }, () => alphabet[Math.floor(rng() * alphabet.length)]).join('');
      const names: Array<[string, string]> = [...AWKWARD];
      for (let i = 0; i < 80; i += 1) names.push([randomName(), randomName()]);
      // One company per name and per company-part length (short, 30, the 40-character maximum), one user in each, so no
      // two names compete for an address and each can be read back on its own.
      let counter = 0;
      for (const [first, last] of names) {
        for (const length of [6, 7, 30, 40]) {
          counter += 1;
          const part = `w${counter}`.padEnd(length, 'w');
          const org = await company(db, part);
          wide.push({ user: await person(db, org, first, last, { created: iso(1) }), part, first, last });
        }
      }
      expect(wide.length).toBe(names.length * 4);

      before = await snapshot(db);
      notificationsBefore = Number((await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM notifications`))[0]!.n);
    }, 600_000);

    it('a dry run writes nothing and names users by id only', async () => {
      dry = await dryRunReport(db);
      dryText = formatDryRunReport(dry).join('\n');

      expect(await snapshot(db)).toEqual(before);
      expect(dryText).not.toMatch(/Jane|Smith|Müller|Leaver|acme|@/);
      expect(dryText).toContain(org1);

      // company 1 by hand: 15 active users without a live mailbox
      const c1 = dry.perCompany.find((c) => c.organization_id === org1)!;
      expect(c1.users).toBe(15);
      expect(c1.by_reason).toEqual({ namesake: 3, taken: 3, no_name: 1, no_company_part: 0 });
      expect(c1.issue).toBe(8);
      expect(c1.address_needed).toBe(7);
      const c3 = dry.perCompany.find((c) => c.organization_id === org3)!;
      expect(c3).toMatchObject({ users: 2, issue: 0, address_needed: 2, by_reason: { namesake: 0, taken: 0, no_name: 0, no_company_part: 2 } });
      expect(dry.perCompany.some((c) => c.organization_id === ids.emptyOrg)).toBe(false);

      // namesake groups: users, by id, grouped under the one who gets the address
      const inOrg1 = dry.namesakes.filter((g) => g.organization_id === org1);
      expect(inOrg1).toHaveLength(2);
      const jane = inOrg1.find((g) => g.winner_user_id === ids.jane1)!;
      expect([...jane.loser_user_ids].sort()).toEqual([ids.jane2, ids.jane3].sort());
      const tie = inOrg1.find((g) => g.winner_user_id === ids.tieLow)!;
      expect(tie.loser_user_ids).toEqual([ids.tieHigh]);
      expect(dry.totals.namesake_groups).toBe(dry.namesakes.length);
    }, 120_000);

    it('applies the migration', () => {
      dir = deploy(dbUrl, 'through');
    }, 300_000);

    it('gives every active user a mailbox and none to the inactive, with the namesake rule', async () => {
      const issued = async (key: string) => mailboxOf(db, ids[key]!);

      expect(await issued('jane1')).toEqual([{ status: 'active', local_part: 'jane.smith.acme', holder: ids.jane1 }]);
      for (const key of ['jane2', 'jane3']) expect(await issued(key), key).toEqual([{ status: 'address_needed', local_part: null, holder: ids[key] }]);
      expect(await issued('jose')).toEqual([{ status: 'active', local_part: 'jos.mller.acme', holder: ids.jose }]);
      // an admin gets one like everyone else
      expect(await issued('mary')).toEqual([{ status: 'active', local_part: 'maryann.oneil.acme', holder: ids.mary }]);
      expect(await issued('cher')).toEqual([{ status: 'active', local_part: 'cher.acme', holder: ids.cher }]);
      expect(await issued('prince')).toEqual([{ status: 'active', local_part: 'prince.acme', holder: ids.prince }]);
      expect(await issued('nameless')).toEqual([{ status: 'address_needed', local_part: null, holder: ids.nameless }]);
      expect(await issued('inactive')).toEqual([]);
      // the leaver keeps hers; the hire named like the leaver gets nothing
      expect(await issued('leaver')).toEqual([{ status: 'active', local_part: 'leo.leaver.acme', holder: ids.leaver }]);
      expect(await issued('hireLikeLeaver')).toEqual([{ status: 'address_needed', local_part: null, holder: ids.hireLikeLeaver }]);
      // a name part held under an earlier company part is still taken
      expect(await issued('raeNew')).toEqual([{ status: 'address_needed', local_part: null, holder: ids.raeNew }]);
      expect(await issued('already')).toEqual([{ status: 'active', local_part: 'al.ready.acme', holder: ids.already }]);
      expect(await issued('alreadyTwin')).toEqual([{ status: 'address_needed', local_part: null, holder: ids.alreadyTwin }]);
      // a merged mailbox is not live: the user gets a fresh one beside it
      expect(await issued('merged')).toEqual([{ status: 'active', local_part: 'mel.merged.acme', holder: ids.merged }]);
      expect(await issued('tieLow')).toEqual([{ status: 'active', local_part: 'tia.tie.acme', holder: ids.tieLow }]);
      expect(await issued('tieHigh')).toEqual([{ status: 'address_needed', local_part: null, holder: ids.tieHigh }]);

      const long = (await issued('longName'))[0]!;
      expect(long.status).toBe('active');
      expect(long.local_part!.length).toBeLessThanOrEqual(64);

      // company 2: the cap leaves 23 characters for the name part
      expect(await issued('jane2co')).toEqual([{ status: 'active', local_part: `jane.smith.${'c'.repeat(40)}`, holder: ids.jane2co }]);
      expect((await issued('tight'))[0]!.local_part).toBe(`${'a'.repeat(11)}.${'b'.repeat(11)}.${'c'.repeat(40)}`);
      expect((await issued('tightShortFirst'))[0]!.local_part).toBe(`jo.${'b'.repeat(20)}.${'c'.repeat(40)}`);
      expect((await issued('tightShortLast'))[0]!.local_part).toBe(`${'a'.repeat(20)}.li.${'c'.repeat(40)}`);
      expect((await issued('tightOneName'))[0]!.local_part).toBe(`${'x'.repeat(23)}.${'c'.repeat(40)}`);

      // company 3 has no company part: nobody gets an address
      for (const key of ['noPart1', 'noPart2']) expect(await issued(key), key).toEqual([{ status: 'address_needed', local_part: null, holder: ids[key] }]);
    });

    it('left no person without a mailbox, no address shared and none longer than 64 characters', async () => {
      const [without] = await db.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM users u WHERE u.is_active AND NOT EXISTS (SELECT 1 FROM mailboxes m WHERE m.kind = 'user' AND m.user_id = u.id AND m.status <> 'merged')`);
      expect(Number(without!.n)).toBe(0);
      const [inactive] = await db.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM mailboxes m JOIN users u ON u.id = m.user_id WHERE NOT u.is_active AND m.kind = 'user' AND m.user_id::text NOT IN ('${ids.leaver}', '${ids.raeOld}')`);
      expect(Number(inactive!.n)).toBe(0);
      const [long] = await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM mailbox_addresses WHERE length(local_part) > 64`);
      expect(Number(long!.n)).toBe(0);
      const [dup] = await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM (SELECT local_part FROM mailbox_addresses GROUP BY 1 HAVING count(*) > 1) d`);
      expect(Number(dup!.n)).toBe(0);
    });

    it('agrees with the TypeScript address rule, name by name, over a wide set of names and company parts', async () => {
      let compared = 0;
      for (const w of wide) {
        const expectedName = buildUserNamePart(w.first, w.last, w.part);
        const rows = await mailboxOf(db, w.user);
        expect(rows, JSON.stringify([w.first, w.last, w.part])).toHaveLength(1);
        if (expectedName === null) {
          expect(rows[0], JSON.stringify([w.first, w.last])).toMatchObject({ status: 'address_needed', local_part: null });
        } else {
          expect(rows[0], JSON.stringify([w.first, w.last])).toMatchObject({ status: 'active', local_part: `${expectedName}.${w.part}` });
          expect(rows[0]!.local_part!.length).toBeLessThanOrEqual(64);
          expect(rows[0]!.local_part).toMatch(/^[a-z0-9]+(\.[a-z0-9]+)+$/);
        }
        compared += 1;
      }
      expect(compared).toBe(wide.length);
    }, 300_000);

    it('writes no bell, notification or email row', async () => {
      const [after] = await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM notifications`);
      expect(Number(after!.n)).toBe(notificationsBefore);
      const [recipients] = await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM notification_recipients`);
      expect(Number(recipients!.n)).toBe(0);
    });

    it('the proof check confirms the result and matches the dry run, company by company', async () => {
      const proof = await proofReport(db, dry);
      expect(proof.differences).toEqual([]);
      expect(proof).toMatchObject({ usersWithoutMailbox: 0, doubleMailboxes: 0, badAddresses: 0, sharedAddresses: 0, ok: true });
      const c1 = proof.perCompany.find((c) => c.organization_id === org1)!;
      // 15 new + the three that were already live (the leaver's, the one under the earlier company part, al ready's)
      expect(c1).toMatchObject({ mailboxes: 18, active: 11, address_needed: 7 });
      expect(formatProofReport(proof, true).at(-1)).toBe('OK');
    });

    it('a second run changes nothing', async () => {
      const first = await snapshot(db);
      const again = runFileAgain(dbUrl, dir);
      expect(again.status, again.stderr).toBe(0);
      expect(await snapshot(db)).toEqual(first);
    }, 120_000);

    it('gives a user an older backend created during the deploy overlap a mailbox when the file is run again', async () => {
      const late = await person(db, org1, 'Lia', 'Late', { created: iso(30) });
      expect(await mailboxOf(db, late)).toEqual([]);
      const again = runFileAgain(dbUrl, dir);
      expect(again.status, again.stderr).toBe(0);
      expect(await mailboxOf(db, late)).toEqual([{ status: 'active', local_part: 'lia.late.acme', holder: late }]);
    }, 120_000);

    it('prints the dry run and the proof through the script, over any URL, with ids only', () => {
      const run = report(dbUrl, ['dry-run', '--url', dbUrl]);
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain('User mailbox dry run (read-only, nothing written)');
      expect(run.stdout + run.stderr).not.toContain(dbUrl);
      expect(run.stdout).not.toMatch(/Jane|Smith|Müller|acme/);
      const proof = report(dbUrl, ['proof', '--url', dbUrl]);
      expect(proof.status, proof.stderr).toBe(0);
      expect(proof.stdout).toContain('OK');
      expect(report(dbUrl, ['sideways']).status).toBe(2);
    }, 120_000);
  });

  // ── The dry run predicts the migration's own stop conditions ─────────────────────────────────────────────────────────
  //
  // Batch 76 (12 Oct): on staging the migration stopped with "1 active user mailboxes are left without a primary
  // address" because a hand-made fixture mailbox was active with no address, while the dry run reported nothing. Each
  // case below builds a database that trips one condition (or none), asks the dry run, then applies the REAL migration
  // and checks the two agree: the same message when it stops, a clean apply when the dry run said PASS.

  describe('the dry run predicts what the migration does', () => {
    let baseName: string;
    const tmp = join(tmpdir(), `s103-dry-${randomUUID().slice(0, 8)}`);
    tempDirs.push(tmp);

    /** A copy of a database at the migration before this one, with a company that has a frozen part. */
    async function fixture() {
      const made = await createDatabase(baseName);
      const org = await company(made.client, 'acme');
      return { ...made, org };
    }

    /** The real migration, applied the way Render applies it; what came of it. */
    function applyMigration(dbUrl: string): { applied: true; dir: string } | { applied: false; error: string } {
      try {
        return { applied: true, dir: deploy(dbUrl, 'through') };
      } catch (err) {
        return { applied: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    const failing = (r: Awaited<ReturnType<typeof dryRunReport>>) => r.stopConditions.filter((c) => !c.pass);

    it('builds the starting database once', async () => {
      const base = await createDatabase();
      baseName = base.name;
      deploy(base.dbUrl, 'before');
      // Nothing may stay connected to a database used as a template.
      await base.client.$disconnect();
    }, 600_000);

    it('FAILS an active mailbox with no address, naming its id, exits non-zero, and the migration then stops with the same message', async () => {
      const { dbUrl, client: db, org } = await fixture();
      const ann = await person(db, org, 'Ann', 'Fixture', { created: iso(1) });
      await person(db, org, 'Bob', 'Normal', { created: iso(2) });
      const box = await existingMailbox(db, org, ann, null, 'active');

      const dry = await dryRunReport(db);
      expect(failing(dry)).toEqual([
        expect.objectContaining({
          key: 'every_active_mailbox_has_a_primary_address', pass: false, count: 1,
          message: 'S10.3: 1 active user mailboxes are left without a primary address',
          mailbox_ids: [box], user_ids: [], company_ids: [org],
        }),
      ]);
      expect(dry.stopConditions.filter((c) => c.pass).map((c) => c.key)).toEqual(['one_live_mailbox_per_user', 'every_active_user_has_a_mailbox']);
      // what was invisible: the pre-existing mailboxes, by state
      expect(dry.existing).toEqual([{ organization_id: org, active_with_address: 0, active_without_address: 1, address_needed: 0, merged: 0 }]);

      // the command: prints FAIL with the id, no name or address, saves the same in JSON, and exits 1
      const out = join(tmp, 'dry.json');
      mkdirSync(tmp, { recursive: true });
      const run = report(dbUrl, ['dry-run', '--url', dbUrl, '--out', out]);
      expect(run.status, run.stderr).toBe(1);
      expect(run.stdout).toMatch(/^ {2}FAIL /m);
      expect(run.stdout).toContain(box);
      expect(run.stdout).not.toMatch(/Ann|Fixture|acme|@/);
      expect(JSON.parse(readFileSync(out, 'utf8')).stopConditions).toEqual(JSON.parse(JSON.stringify(dry.stopConditions)));

      const applied = applyMigration(dbUrl);
      expect(applied.applied).toBe(false);
      expect((applied as { error: string }).error).toContain(failing(dry)[0]!.message);

      // the failed attempt is on the ledger, and the dry run says so rather than "already applied"
      const after = await dryRunReport(db);
      expect(after.ledger).toBe('failed_unresolved');
      expect(after.alreadyApplied).toBe(false);
    }, 300_000);

    it('PASSES every condition once the fixture is corrected to "address needed", exits 0, and the migration applies', async () => {
      const { dbUrl, client: db, org } = await fixture();
      const ann = await person(db, org, 'Ann', 'Fixture', { created: iso(1) });
      await person(db, org, 'Bob', 'Normal', { created: iso(2) });
      await existingMailbox(db, org, ann, null, 'address_needed');

      const dry = await dryRunReport(db);
      expect(failing(dry)).toEqual([]);
      expect(dry.stopConditions.map((c) => c.key)).toEqual(['one_live_mailbox_per_user', 'every_active_user_has_a_mailbox', 'every_active_mailbox_has_a_primary_address']);
      expect(dry.existing).toEqual([{ organization_id: org, active_with_address: 0, active_without_address: 0, address_needed: 1, merged: 0 }]);
      const run = report(dbUrl, ['dry-run', '--url', dbUrl]);
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout.match(/^ {2}PASS /gm)).toHaveLength(3);

      const applied = applyMigration(dbUrl);
      expect(applied.applied, (applied as { error?: string }).error).toBe(true);

      // the proof runs the same checks on the written state
      const proof = await proofReport(db, dry);
      expect(proof.stopConditions.every((c) => c.pass)).toBe(true);
      expect(proof.ok).toBe(true);
      const proofRun = report(dbUrl, ['proof', '--url', dbUrl]);
      expect(proofRun.status, proofRun.stderr).toBe(0);
      expect(proofRun.stdout.match(/^ {2}PASS /gm)).toHaveLength(3);

      // and a dry run on a database that already has the migration says so, instead of reporting a plan
      const again = await dryRunReport(db);
      expect(again.alreadyApplied).toBe(true);
      expect(again.ledger).toBe('applied');
      const againRun = report(dbUrl, ['dry-run', '--url', dbUrl]);
      expect(againRun.status, againRun.stderr).toBe(0);
      expect(againRun.stdout).toContain('already applied: nothing to do');
      expect(againRun.stdout).not.toContain('mailboxes to issue');
    }, 300_000);

    it('FAILS two companies that would be issued the same address (a company part with a dot in it)', async () => {
      const { dbUrl, client: db } = await fixture();
      // 'a.b.c' is both "a" at company part 'b.c' and "a.b" at company part 'c'; the second insert is skipped by the register
      const orgA = await company(db, 'b.c');
      const orgB = await company(db, 'c');
      const one = await person(db, orgA, 'A', '', { created: iso(1) });
      const two = await person(db, orgB, 'A', 'B', { created: iso(2) });

      const dry = await dryRunReport(db);
      const [fail] = failing(dry);
      expect(failing(dry)).toHaveLength(1);
      expect(fail).toMatchObject({ key: 'every_active_mailbox_has_a_primary_address', count: 1, message: 'S10.3: 1 active user mailboxes are left without a primary address' });
      // which of the two the database loses is its choice: the report names the later-created one
      expect(fail!.user_ids).toEqual([two]);
      expect(fail!.company_ids).toEqual([orgB]);
      expect([one, two]).toContain(fail!.user_ids[0]);

      const applied = applyMigration(dbUrl);
      expect(applied.applied).toBe(false);
      expect((applied as { error: string }).error).toContain(fail!.message);
    }, 300_000);

    it('FAILS a user who already has two live mailboxes (the unique index cannot be built), and a second broken state is listed behind it', async () => {
      const { dbUrl, client: db, org } = await fixture();
      const twice = await person(db, org, 'Tom', 'Twice', { created: iso(1) });
      const first = await existingMailbox(db, org, twice, 'tom.twice.acme', 'active');
      const second = await existingMailbox(db, org, twice, null, 'address_needed');
      const other = await person(db, org, 'Ona', 'Other', { created: iso(2) });
      const bare = await existingMailbox(db, org, other, null, 'active');

      const dry = await dryRunReport(db);
      expect(failing(dry).map((c) => c.key)).toEqual(['one_live_mailbox_per_user', 'every_active_mailbox_has_a_primary_address']);
      const [double, noAddress] = failing(dry);
      expect(double).toMatchObject({ count: 1, user_ids: [twice], company_ids: [org] });
      expect([...double!.mailbox_ids].sort()).toEqual([first, second].sort());
      expect(noAddress).toMatchObject({ count: 1, mailbox_ids: [bare] });

      // the migration reaches the index first, so that is the message it stops with
      const applied = applyMigration(dbUrl);
      expect(applied.applied).toBe(false);
      expect((applied as { error: string }).error).toContain(double!.message);
    }, 300_000);

    it('words the "left without a mailbox" stop as the migration does, and finds a user the plan would miss', async () => {
      // No data state makes the plan skip an active user, so the real migration is made to stop here with a trigger that
      // discards one user's new mailbox (a dry run cannot see a trigger, and is not asked to).
      const { dbUrl, client: db, org } = await fixture();
      const lost = await person(db, org, 'Lou', 'Lost', { created: iso(1) });
      await db.$executeRawUnsafe(`CREATE FUNCTION s103_drop_mailbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.user_id = '${lost}'::uuid THEN RETURN NULL; END IF; RETURN NEW; END $$`);
      await db.$executeRawUnsafe(`CREATE TRIGGER s103_drop_mailbox BEFORE INSERT ON mailboxes FOR EACH ROW EXECUTE FUNCTION s103_drop_mailbox()`);
      const applied = applyMigration(dbUrl);
      expect(applied.applied).toBe(false);
      expect((applied as { error: string }).error).toContain(stopConditionMessage('every_active_user_has_a_mailbox', 1));

      // the check itself, on a plan that leaves that user out: FAIL with the user's id
      const fresh = await fixture();
      const lou = await person(fresh.client, fresh.org, 'Lou', 'Lost', { created: iso(1) });
      await person(fresh.client, fresh.org, 'Max', 'Kept', { created: iso(2) });
      const planWithoutLou = `SELECT u.id AS user_id, u.organization_id, u.created_at, 'issue' AS outcome, NULL::uuid AS winner_user_id, 'max.kept.acme' AS local_part
                              FROM users u WHERE u.first_name = 'Max'`;
      const dry = await dryRunReport(fresh.client, planWithoutLou);
      expect(failing(dry)).toEqual([
        expect.objectContaining({ key: 'every_active_user_has_a_mailbox', count: 1, user_ids: [lou], company_ids: [fresh.org], message: 'S10.3: 1 active users are left without a mailbox' }),
      ]);
    }, 300_000);

    it('lets through users the NEW backend made during the deploy overlap, and issues one to the users it never saw', async () => {
      const { dbUrl, client: db, org } = await fixture();
      const { issueUserMailbox } = await import('../lib/mailbox/register.js');
      const make = async (first: string, last: string, created: number) => {
        const id = await person(db, org, first, last, { created: iso(created) });
        const issued = await db.$transaction((tx) => issueUserMailbox(tx, { id, organization_id: org, first_name: first, last_name: last }));
        return { id, issued };
      };
      // created by the new backend before the migration: one with an address, one whose name is taken (address needed)
      const withAddress = await make('Nia', 'New', 1);
      const namesake = await make('Nia', 'New', 2);
      expect(withAddress.issued).toMatchObject({ status: 'active', localPart: 'nia.new.acme' });
      expect(namesake.issued).toMatchObject({ status: 'address_needed', localPart: null });
      // created by the old backend, which knows no mailboxes; and a leaver reactivated before the migration ran
      const old = await person(db, org, 'Olly', 'Old', { created: iso(3) });
      const leaver = await person(db, org, 'Rea', 'Active', { created: iso(4), active: false });
      await db.$executeRawUnsafe(`UPDATE users SET is_active = true WHERE id = $1::uuid`, leaver);

      const dry = await dryRunReport(db);
      expect(failing(dry)).toEqual([]);
      expect(dry.perCompany.find((c) => c.organization_id === org)).toMatchObject({ users: 2, issue: 2 });
      expect(dry.existing).toEqual([{ organization_id: org, active_with_address: 1, active_without_address: 0, address_needed: 1, merged: 0 }]);

      const before = await snapshot(db);
      const applied = applyMigration(dbUrl);
      expect(applied.applied, (applied as { error?: string }).error).toBe(true);
      expect(await mailboxOf(db, withAddress.id)).toEqual([{ status: 'active', local_part: 'nia.new.acme', holder: withAddress.id }]);
      expect(await mailboxOf(db, namesake.id)).toEqual([{ status: 'address_needed', local_part: null, holder: namesake.id }]);
      expect(await mailboxOf(db, old)).toEqual([{ status: 'active', local_part: 'olly.old.acme', holder: old }]);
      expect(await mailboxOf(db, leaver)).toEqual([{ status: 'active', local_part: 'rea.active.acme', holder: leaver }]);
      expect((await snapshot(db)).mailboxes).toHaveLength((before.mailboxes as unknown[]).length + 2);

      // a user the OLD backend creates AFTER the migration has no mailbox: the proof says so, with the id, and fails;
      // running the migration file again (nothing else to do) gives the user a mailbox and the proof passes
      const late = await person(db, org, 'Lena', 'Late', { created: iso(5) });
      const bad = await proofReport(db);
      expect(bad.ok).toBe(false);
      expect(bad.stopConditions.find((c) => c.key === 'every_active_user_has_a_mailbox')).toMatchObject({
        pass: false, count: 1, user_ids: [late], company_ids: [org], message: 'S10.3: 1 active users are left without a mailbox',
      });
      const proofRun = report(dbUrl, ['proof', '--url', dbUrl]);
      expect(proofRun.status).toBe(1);
      expect(proofRun.stdout).toContain(late);
      const again = runFileAgain(dbUrl, (applied as { dir: string }).dir);
      expect(again.status, again.stderr).toBe(0);
      expect((await proofReport(db)).ok).toBe(true);
    }, 300_000);
  });
});

// ── helpers local to the wide set ────────────────────────────────────────────────────────────────────────────────────

/** A deterministic random source, so the wide set is the same every run. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
