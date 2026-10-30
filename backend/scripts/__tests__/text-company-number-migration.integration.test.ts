/**
 * Real-DB test for Roles & Permissions S08.1: the migration that gives calls and texts a company
 * number (`20261008090000_comm_company_number_on_calls_and_texts`) and the one-time text fill-in
 * (`scripts/text-company-number-fill-in.ts`).
 *
 * The call backfill is SQL, so the only honest test builds calls in a real Postgres, runs the
 * migration's own file against them and reads the result back. The fill-in is run for real against
 * the same database with the phone service's history stubbed.
 *
 * Skipped by default (CI skips integration tests). To run, against a LOCAL, throwaway database that
 * has every migration applied (fixtures are inserted and removed again; never point this at a
 * shared database):
 *   DATABASE_URL=postgresql://<you>@localhost:5433/<db> RUN_INTEGRATION_TESTS=1 \
 *     npx vitest run scripts/__tests__/text-company-number-migration.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fillInOrg, fillInAllOrgs, type FillInDeps } from '../text-company-number-fill-in';

dotenv.config();

const enabled =
  process.env.RUN_INTEGRATION_TESTS === '1' &&
  typeof process.env.DATABASE_URL === 'string' &&
  !process.env.DATABASE_URL.includes('test:test@localhost');

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== '1')('integration opt-in', () => {
  it('has a real, local DATABASE_URL to run against', () => {
    expect(enabled).toBe(true);
    // The fixtures are written, then deleted. Never let that happen on a shared database.
    expect(process.env.DATABASE_URL).toMatch(/@(localhost|127\.0\.0\.1)[:/]/);
  });
});

const MIGRATION_SQL = path.join(
  process.cwd(),
  'prisma/migrations/20261008090000_comm_company_number_on_calls_and_texts/migration.sql',
);

const ORG_A = '00000000-0000-0000-0000-0000000008a1';
const ORG_B = '00000000-0000-0000-0000-0000000008b1';
const USER_A = '00000000-0000-0000-0000-0000000008a2';
const LINE_A1 = '00000000-0000-0000-0000-0000000008a3';
const LINE_A2 = '00000000-0000-0000-0000-0000000008a4';
const LINE_B1 = '00000000-0000-0000-0000-0000000008b3';
const THREAD_A = '00000000-0000-0000-0000-0000000008a5';
const THREAD_B = '00000000-0000-0000-0000-0000000008b5';

const callId = (n: number) => `00000000-0000-0000-0002-${String(n).padStart(12, '0')}`;
const msgId = (n: number) => `00000000-0000-0000-0003-${String(n).padStart(12, '0')}`;

// direction, from, to, which company number it must end up on (null = stays empty), organization.
const CALLS: Array<{ n: number; org: 'A' | 'B'; direction: 'in' | 'out'; from: string; to: string; expect: string | null }> = [
  { n: 1, org: 'A', direction: 'in', from: '+12015551111', to: '+12015550001', expect: LINE_A1 },
  { n: 2, org: 'A', direction: 'out', from: '+12015550002', to: '+12015551111', expect: LINE_A2 },
  // stored without the plus sign, or formatted: still the same number
  { n: 3, org: 'A', direction: 'in', from: '+12015551111', to: '2015550001', expect: LINE_A1 },
  { n: 4, org: 'A', direction: 'in', from: '+12015551111', to: '(201) 555-0002', expect: LINE_A2 },
  { n: 5, org: 'A', direction: 'out', from: '12015550001', to: '+12015551111', expect: LINE_A1 },
  // the CUSTOMER's side matching a company number does not count: only the company side is read
  { n: 6, org: 'A', direction: 'in', from: '+12015550001', to: '+12015559999', expect: null },
  // a number that is none of the organization's own
  { n: 7, org: 'A', direction: 'in', from: '+12015551111', to: '+19995550000', expect: null },
  { n: 8, org: 'A', direction: 'in', from: '+12015551111', to: 'unknown', expect: null },
  // the same digits in another organization's list are never a match
  { n: 9, org: 'A', direction: 'in', from: '+12015551111', to: '+12015550777', expect: null },
  { n: 10, org: 'B', direction: 'in', from: '+12015551111', to: '+12015550777', expect: LINE_B1 },
];

describe.skipIf(!enabled)('company number on calls and texts - real DB', () => {
  let prisma: any;
  let migrationSql: string;

  async function run(sql: string, ...params: unknown[]) {
    return prisma.$executeRawUnsafe(sql, ...params);
  }
  async function query<T = any>(sql: string, ...params: unknown[]): Promise<T[]> {
    return prisma.$queryRawUnsafe(sql, ...params);
  }
  async function clean() {
    const orgs = [ORG_A, ORG_B];
    await run(`DELETE FROM audit_logs WHERE org_id = ANY($1::uuid[])`, orgs);
    for (const t of ['messages', 'message_threads', 'call_sessions', 'phone_numbers', 'users']) {
      await run(`DELETE FROM ${t} WHERE organization_id = ANY($1::uuid[])`, orgs);
    }
    await run('DELETE FROM organizations WHERE id = ANY($1::uuid[])', orgs);
  }

  /** Apply the migration through psql so its NOTICE lines (the row counts) can be read. */
  function applyMigration(): string {
    const res = spawnSync('psql', [process.env.DATABASE_URL!, '-X', '-v', 'ON_ERROR_STOP=1', '-f', MIGRATION_SQL], {
      encoding: 'utf8',
    });
    expect(res.status, res.stderr).toBe(0);
    return res.stderr;
  }

  const callCompanyNumbers = async () =>
    query<{ id: string; phone_number_id: string | null }>(
      `SELECT id::text, phone_number_id::text FROM call_sessions WHERE organization_id = ANY($1::uuid[]) ORDER BY id`,
      [ORG_A, ORG_B],
    );

  beforeAll(async () => {
    const prismaPkg = await import('@prisma/client');
    prisma = new prismaPkg.PrismaClient();
    migrationSql = fs.readFileSync(MIGRATION_SQL, 'utf8');
    expect(migrationSql.length).toBeGreaterThan(0);
    // The columns the fixtures write to must exist, so apply the (idempotent) migration to an empty
    // fixture set first. Every test below then re-applies it to fixtures that need the backfill.
    applyMigration();
    await clean();

    for (const org of ['A', 'B'] as const) {
      await run(
        `INSERT INTO organizations (id, name, address_line1, city, state, postal_code, email, estimate_terms, estimate_notes, estimate_payment_terms, updated_at)
         VALUES ($1::uuid, $2, '1 Test St', 'Austin', 'TX', '78701', $3, '', '', '', now())`,
        org === 'A' ? ORG_A : ORG_B,
        `s081 org ${org}`,
        `s081-${org}@example.invalid`,
      );
    }
    await run(
      `INSERT INTO users (id, organization_id, email, first_name, last_name, role, updated_at)
       VALUES ($1::uuid, $2::uuid, 's081-user@example.invalid', 'Test', 'User', 'ADMIN', now())`,
      USER_A,
      ORG_A,
    );
    for (const [id, org, e164, tpn] of [
      [LINE_A1, ORG_A, '+12015550001', 'TPN-A1'],
      [LINE_A2, ORG_A, '+12015550002', 'TPN-A2'],
      [LINE_B1, ORG_B, '+12015550777', 'TPN-B1'],
    ]) {
      await run(
        `INSERT INTO phone_numbers (id, organization_id, e164, ctm_number_id, updated_at) VALUES ($1::uuid, $2::uuid, $3, $4, now())`,
        id,
        org,
        e164,
        tpn,
      );
    }
    for (const c of CALLS) {
      await run(
        `INSERT INTO call_sessions (id, organization_id, direction, from_number, to_number, status, answered_by, started_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'completed', '{}'::jsonb, now(), now())`,
        callId(c.n),
        c.org === 'A' ? ORG_A : ORG_B,
        c.direction,
        c.from,
        c.to,
      );
    }
    for (const [thread, org] of [
      [THREAD_A, ORG_A],
      [THREAD_B, ORG_B],
    ]) {
      await run(
        `INSERT INTO message_threads (id, organization_id, campaign_type, updated_at) VALUES ($1::uuid, $2::uuid, 'customer_care', now())`,
        thread,
        org,
      );
    }
  });

  afterAll(async () => {
    if (prisma) {
      await clean();
      await prisma.$disconnect();
    }
  });

  describe('the migration', () => {
    it('gives each call the company number whose stored number matches, and leaves the others empty', async () => {
      applyMigration();
      const rows = await callCompanyNumbers();
      const byId = new Map(rows.map((r) => [r.id, r.phone_number_id]));
      const actual = CALLS.map((c) => ({ n: c.n, line: byId.get(callId(c.n)) }));
      const wanted = CALLS.map((c) => ({ n: c.n, line: c.expect }));
      expect(actual).toEqual(wanted);
    });

    it('reports the row counts', async () => {
      // Clear the links so this run has something to match, then read the migration's own report.
      await run(`UPDATE call_sessions SET phone_number_id = NULL WHERE organization_id = ANY($1::uuid[])`, [ORG_A, ORG_B]);
      const notices = applyMigration();
      const matched = CALLS.filter((c) => c.expect !== null).length;
      // Other rows may exist in a local database, so the in-run count is at least ours.
      const inRun = Number(/calls matched to a company number in this run: (\d+)/.exec(notices)?.[1]);
      expect(inRun).toBeGreaterThanOrEqual(matched);
      expect(notices).toMatch(/calls now carrying a company number: \d+ of \d+ \(\d+ left empty\)/);
    });

    it('changes nothing on a second application', async () => {
      const before = await callCompanyNumbers();
      const notices = applyMigration();
      expect(await callCompanyNumbers()).toEqual(before);
      expect(notices).toMatch(/calls matched to a company number in this run: 0/);
    });

    it('does not overwrite a company number a call already carries', async () => {
      await run(`UPDATE call_sessions SET phone_number_id = $1::uuid WHERE id = $2::uuid`, LINE_A2, callId(1));
      applyMigration();
      const row = (await callCompanyNumbers()).find((r) => r.id === callId(1));
      expect(row?.phone_number_id).toBe(LINE_A2);
      await run(`UPDATE call_sessions SET phone_number_id = $1::uuid WHERE id = $2::uuid`, LINE_A1, callId(1));
    });

    it('leaves a call and a text in place, with the link cleared, when their number or sender is deleted', async () => {
      await run(
        `INSERT INTO phone_numbers (id, organization_id, e164, updated_at) VALUES ('00000000-0000-0000-0000-0000000008a9'::uuid, $1::uuid, '+12015550003', now())`,
        ORG_A,
      );
      await run(`UPDATE call_sessions SET phone_number_id = '00000000-0000-0000-0000-0000000008a9'::uuid WHERE id = $1::uuid`, callId(7));
      await run(
        `INSERT INTO messages (id, thread_id, organization_id, direction, body, ts, phone_number_id, sent_by_user_id, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'out', 'x', now(), '00000000-0000-0000-0000-0000000008a9'::uuid, $4::uuid, now())`,
        msgId(900),
        THREAD_A,
        ORG_A,
        USER_A,
      );
      await run(`DELETE FROM phone_numbers WHERE id = '00000000-0000-0000-0000-0000000008a9'::uuid`);
      const call = (await callCompanyNumbers()).find((r) => r.id === callId(7));
      expect(call?.phone_number_id).toBeNull();
      const [m] = await query(`SELECT phone_number_id::text, sent_by_user_id::text FROM messages WHERE id = $1::uuid`, msgId(900));
      expect(m.phone_number_id).toBeNull();
      expect(m.sent_by_user_id).toBe(USER_A);
      await run(`DELETE FROM messages WHERE id = $1::uuid`, msgId(900));
    });
  });

  describe('the one-time text fill-in', () => {
    // History: the phone service's list names the tracking number of each text by message id.
    const history = [
      [
        { message_id: 'MSG-S081-1', tracking_number: '+12015550001', direction: 'msg_inbound' },
        { message_id: 'MSG-S081-2', tracking_number: '+12015550002', direction: 'msg_outbound' },
        { sid: 'CA-not-a-text', tracking_number: '+12015550001', direction: 'inbound' },
        { message_id: 'MSG-S081-never-stored', tracking_number: '+12015550001', direction: 'msg_inbound' },
        // a number that is none of this organization's own
        { message_id: 'MSG-S081-5', tracking_number: '+19995550000', direction: 'msg_inbound' },
      ],
    ];
    const deps = (): FillInDeps =>
      ({
        client: {
          listCalls: () =>
            (async function* () {
              for (const page of history) yield page;
            })(),
        },
        prisma,
      }) as unknown as FillInDeps;

    const textCompanyNumbers = async () =>
      query<{ id: string; phone_number_id: string | null; sent_by_user_id: string | null }>(
        `SELECT id::text, phone_number_id::text, sent_by_user_id::text FROM messages WHERE organization_id = ANY($1::uuid[]) ORDER BY id`,
        [ORG_A, ORG_B],
      );

    beforeAll(async () => {
      const texts: Array<[number, string, string, 'in' | 'out', string | null]> = [
        // placed from the history
        [1, ORG_A, THREAD_A, 'in', 'MSG-S081-1'],
        [2, ORG_A, THREAD_A, 'out', 'MSG-S081-2'],
        // app-sent: not in the history, placed from the "text sent" audit entry
        [3, ORG_A, THREAD_A, 'out', 'MSG-S081-3'],
        // app-sent whose audit entry names a line the organization no longer has
        [4, ORG_A, THREAD_A, 'out', 'MSG-S081-4'],
        // history names a number that is not the organization's
        [5, ORG_A, THREAD_A, 'in', 'MSG-S081-5'],
        // in neither source
        [6, ORG_A, THREAD_A, 'in', 'MSG-S081-6'],
        // another organization's text with a message id the history names for organization A
        [7, ORG_B, THREAD_B, 'in', 'MSG-S081-1-other'],
      ];
      for (const [n, org, thread, direction, sid] of texts) {
        await run(
          `INSERT INTO messages (id, thread_id, organization_id, direction, body, ts, ctm_sms_id, updated_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'hello', now(), $5, now())`,
          msgId(n),
          thread,
          org,
          direction,
          sid,
        );
      }
      // The text sent from the app (3) is also given a message that has no phone-service id at all (8).
      await run(
        `INSERT INTO messages (id, thread_id, organization_id, direction, body, ts, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'out', 'sid-less', now(), now())`,
        msgId(8),
        THREAD_A,
        ORG_A,
      );
      for (const [n, tpn] of [
        [3, 'TPN-A2'],
        [4, 'TPN-gone'],
        [8, 'TPN-A1'],
      ] as const) {
        await run(
          `INSERT INTO audit_logs (org_id, action, resource_type, resource_id, metadata)
           VALUES ($1::uuid, 'sms.sent', 'Message', $2, $3::jsonb)`,
          ORG_A,
          msgId(n),
          JSON.stringify({ thread_id: THREAD_A, from_tpn: tpn }),
        );
      }
      // An audit entry in ANOTHER organization naming the same message must not place it.
      await run(
        `INSERT INTO audit_logs (org_id, action, resource_type, resource_id, metadata)
         VALUES ($1::uuid, 'sms.sent', 'Message', $2, $3::jsonb)`,
        ORG_B,
        msgId(6),
        JSON.stringify({ from_tpn: 'TPN-B1' }),
      );
    });

    it('sets the company number from the history by message id, then from the audit entry, and leaves the rest', async () => {
      const counts = await fillInOrg(deps(), { orgId: ORG_A, accountId: 'acct' });

      const byId = new Map((await textCompanyNumbers()).map((r) => [r.id, r.phone_number_id]));
      expect(byId.get(msgId(1))).toBe(LINE_A1);
      expect(byId.get(msgId(2))).toBe(LINE_A2);
      expect(byId.get(msgId(3))).toBe(LINE_A2);
      expect(byId.get(msgId(8))).toBe(LINE_A1);
      expect(byId.get(msgId(4))).toBeNull();
      expect(byId.get(msgId(5))).toBeNull();
      expect(byId.get(msgId(6))).toBeNull();
      expect(byId.get(msgId(7))).toBeNull();
      expect(counts).toEqual({ texts_matched_history: 2, texts_matched_audit: 2, texts_left_without_number: 3 });
    });

    it('never gives older app-sent texts a sender', async () => {
      const rows = await textCompanyNumbers();
      expect(rows.every((r) => r.sent_by_user_id === null)).toBe(true);
    });

    it('a second run changes nothing', async () => {
      const before = await textCompanyNumbers();
      const counts = await fillInOrg(deps(), { orgId: ORG_A, accountId: 'acct' });
      expect(await textCompanyNumbers()).toEqual(before);
      expect(counts).toEqual({ texts_matched_history: 0, texts_matched_audit: 0, texts_left_without_number: 3 });
    });

    it('over every organization it also places the other organizations without crossing them', async () => {
      const totals = await fillInAllOrgs(deps());
      const byId = new Map((await textCompanyNumbers()).map((r) => [r.id, r.phone_number_id]));
      expect(byId.get(msgId(7))).toBeNull();
      // Nothing of ours moves again; counts for rows outside the fixtures are whatever the database holds.
      expect(totals.texts_matched_history).toBe(0);
    });
  });
});
