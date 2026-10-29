/**
 * Real-DB test for the one-time "move existing leads" migration of the walkthrough lead-statuses
 * feature (PRD 10.2, slice 03): `20261006200200_lead_status_walkthrough_backfill`.
 *
 * The migration is data-only SQL, so the only honest test is to build fixtures in a real Postgres,
 * run the migration's own SQL file against them, and read the result back. A mocked prisma would
 * prove nothing about a CTE.
 *
 * Skipped by default (CI skips integration tests). To run, against a LOCAL, throwaway database that
 * has every migration applied (the fixtures are inserted and removed again, but never point this at
 * a shared database):
 *   DATABASE_URL=postgresql://<you>@localhost:5433/<db> RUN_INTEGRATION_TESTS=1 \
 *     npx vitest run src/__tests__/lead-status-walkthrough-backfill.integration.test.ts
 *
 * Fixtures are keyed by fixed ids so a killed run is cleaned up by the next one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

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
  'prisma/migrations/20261006200200_lead_status_walkthrough_backfill/migration.sql',
);

const ORG_A = '00000000-0000-0000-0000-0000000003a1';
const ORG_B = '00000000-0000-0000-0000-0000000003b1';
const USER_A = '00000000-0000-0000-0000-0000000003a2';
const USER_B = '00000000-0000-0000-0000-0000000003b2';

type LeadStatus = 'NEW' | 'CONTACTED' | 'WALKTHROUGH_SCHEDULED' | 'WALKTHROUGH_COMPLETED' | 'ESTIMATED' | 'WON' | 'LOST' | 'CANCELLED';
type VisitStatus = 'SCHEDULED' | 'EN_ROUTE' | 'ON_SITE' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
type EstimateStatus = 'DRAFT' | 'SENT' | 'PENDING' | 'WON' | 'DECLINED' | 'EXPIRED' | 'ARCHIVED' | 'SUPERSEDED';

interface Fixture {
  key: string;
  org: 'A' | 'B';
  status: LeadStatus;
  visits?: VisitStatus[];
  estimates?: Array<{ status: EstimateStatus; sent?: boolean }>;
  /** What the lead must be after the migration. */
  expect: LeadStatus;
}

// Every case in the slice's acceptance list, plus the edges the PRD's definition of "sent" and
// "open" create. `expect` differing from `status` means the lead MUST get exactly one History row.
const FIXTURES: Fixture[] = [
  // --- moves to Walkthrough Scheduled (any open visit) ---
  { key: 'new-open', org: 'A', status: 'NEW', visits: ['SCHEDULED'], expect: 'WALKTHROUGH_SCHEDULED' },
  { key: 'contacted-open', org: 'A', status: 'CONTACTED', visits: ['SCHEDULED'], expect: 'WALKTHROUGH_SCHEDULED' },
  { key: 'contacted-en-route', org: 'A', status: 'CONTACTED', visits: ['EN_ROUTE'], expect: 'WALKTHROUGH_SCHEDULED' },
  { key: 'contacted-on-site', org: 'A', status: 'CONTACTED', visits: ['ON_SITE'], expect: 'WALKTHROUGH_SCHEDULED' },
  { key: 'contacted-in-progress', org: 'A', status: 'CONTACTED', visits: ['IN_PROGRESS'], expect: 'WALKTHROUGH_SCHEDULED' },
  // an open visit wins over a finished one (a walkthrough can span several trips)
  { key: 'contacted-open-and-finished', org: 'A', status: 'CONTACTED', visits: ['COMPLETED', 'SCHEDULED'], expect: 'WALKTHROUGH_SCHEDULED' },
  { key: 'new-open-plus-cancelled', org: 'A', status: 'NEW', visits: ['CANCELLED', 'SCHEDULED'], expect: 'WALKTHROUGH_SCHEDULED' },
  { key: 'org-b-open', org: 'B', status: 'NEW', visits: ['SCHEDULED'], expect: 'WALKTHROUGH_SCHEDULED' },

  // --- moves to Walkthrough Completed (finished visits only) ---
  { key: 'new-finished', org: 'A', status: 'NEW', visits: ['COMPLETED'], expect: 'WALKTHROUGH_COMPLETED' },
  { key: 'contacted-finished', org: 'A', status: 'CONTACTED', visits: ['COMPLETED', 'COMPLETED'], expect: 'WALKTHROUGH_COMPLETED' },
  { key: 'contacted-finished-plus-cancelled', org: 'A', status: 'CONTACTED', visits: ['COMPLETED', 'CANCELLED'], expect: 'WALKTHROUGH_COMPLETED' },
  { key: 'org-b-finished', org: 'B', status: 'CONTACTED', visits: ['COMPLETED'], expect: 'WALKTHROUGH_COMPLETED' },

  // --- New / Contacted that stay (no visits, or none that count) ---
  { key: 'new-no-visits', org: 'A', status: 'NEW', expect: 'NEW' },
  { key: 'contacted-no-visits', org: 'A', status: 'CONTACTED', expect: 'CONTACTED' },
  { key: 'new-only-cancelled', org: 'A', status: 'NEW', visits: ['CANCELLED', 'CANCELLED'], expect: 'NEW' },

  // --- a sent estimate blocks the move, by the PRD 7.1 definition of "sent" ---
  { key: 'open-and-sent', org: 'A', status: 'CONTACTED', visits: ['SCHEDULED'], estimates: [{ status: 'SENT' }], expect: 'CONTACTED' },
  { key: 'finished-and-sent', org: 'A', status: 'NEW', visits: ['COMPLETED'], estimates: [{ status: 'SENT' }], expect: 'NEW' },
  { key: 'open-and-pending', org: 'A', status: 'CONTACTED', visits: ['SCHEDULED'], estimates: [{ status: 'PENDING' }], expect: 'CONTACTED' },
  { key: 'open-and-won-est', org: 'A', status: 'CONTACTED', visits: ['SCHEDULED'], estimates: [{ status: 'WON' }], expect: 'CONTACTED' },
  { key: 'open-and-declined', org: 'A', status: 'CONTACTED', visits: ['SCHEDULED'], estimates: [{ status: 'DECLINED' }], expect: 'CONTACTED' },
  { key: 'open-and-expired', org: 'A', status: 'CONTACTED', visits: ['SCHEDULED'], estimates: [{ status: 'EXPIRED' }], expect: 'CONTACTED' },
  { key: 'open-and-superseded-sent', org: 'A', status: 'CONTACTED', visits: ['SCHEDULED'], estimates: [{ status: 'SUPERSEDED', sent: true }], expect: 'CONTACTED' },
  // a sent estimate on ANY of several estimates is enough
  { key: 'open-draft-and-sent', org: 'A', status: 'CONTACTED', visits: ['SCHEDULED'], estimates: [{ status: 'DRAFT' }, { status: 'SENT' }], expect: 'CONTACTED' },
  // DRAFT, ARCHIVED and a SUPERSEDED that was never sent do not count as sent, so these still move
  { key: 'open-and-draft', org: 'A', status: 'CONTACTED', visits: ['SCHEDULED'], estimates: [{ status: 'DRAFT' }], expect: 'WALKTHROUGH_SCHEDULED' },
  { key: 'finished-and-archived', org: 'A', status: 'NEW', visits: ['COMPLETED'], estimates: [{ status: 'ARCHIVED' }], expect: 'WALKTHROUGH_COMPLETED' },
  { key: 'open-and-superseded-unsent', org: 'A', status: 'CONTACTED', visits: ['SCHEDULED'], estimates: [{ status: 'SUPERSEDED', sent: false }], expect: 'WALKTHROUGH_SCHEDULED' },

  // --- every other status is never touched, whatever its visits say (D3) ---
  { key: 'estimated-open', org: 'A', status: 'ESTIMATED', visits: ['SCHEDULED'], estimates: [{ status: 'SENT' }], expect: 'ESTIMATED' },
  { key: 'estimated-finished', org: 'A', status: 'ESTIMATED', visits: ['COMPLETED'], expect: 'ESTIMATED' },
  { key: 'won-open', org: 'A', status: 'WON', visits: ['SCHEDULED'], expect: 'WON' },
  { key: 'won-finished', org: 'A', status: 'WON', visits: ['COMPLETED'], expect: 'WON' },
  { key: 'lost-open', org: 'A', status: 'LOST', visits: ['SCHEDULED'], expect: 'LOST' },
  { key: 'lost-finished', org: 'A', status: 'LOST', visits: ['COMPLETED'], expect: 'LOST' },
  { key: 'cancelled-open', org: 'A', status: 'CANCELLED', visits: ['SCHEDULED'], expect: 'CANCELLED' },
  { key: 'cancelled-finished', org: 'A', status: 'CANCELLED', visits: ['COMPLETED'], expect: 'CANCELLED' },
  // already in a walkthrough status (e.g. the migration ran, or slice 02 moved it): left alone
  { key: 'already-scheduled', org: 'A', status: 'WALKTHROUGH_SCHEDULED', visits: ['SCHEDULED'], expect: 'WALKTHROUGH_SCHEDULED' },
  { key: 'already-completed', org: 'A', status: 'WALKTHROUGH_COMPLETED', visits: ['COMPLETED'], expect: 'WALKTHROUGH_COMPLETED' },
];

const leadId = (i: number) => `00000000-0000-0000-0001-${String(i).padStart(12, '0')}`;
const customerId = (org: 'A' | 'B') => (org === 'A' ? '00000000-0000-0000-0000-0000000003a3' : '00000000-0000-0000-0000-0000000003b3');
const orgId = (org: 'A' | 'B') => (org === 'A' ? ORG_A : ORG_B);
const userId = (org: 'A' | 'B') => (org === 'A' ? USER_A : USER_B);

const DESC_SCHEDULED = 'Lead moved to Walkthrough Scheduled (set from its booked walkthroughs)';
const DESC_COMPLETED = 'Lead moved to Walkthrough Completed (set from its finished walkthroughs)';

describe.skipIf(!enabled)('walkthrough status backfill migration - real DB', () => {
  let prisma: any;
  let migrationSql: string;
  const fixtureIds = FIXTURES.map((_, i) => leadId(i + 1));

  async function run(sql: string, ...params: unknown[]) {
    return prisma.$executeRawUnsafe(sql, ...params);
  }
  async function query<T = any>(sql: string, ...params: unknown[]): Promise<T[]> {
    return prisma.$queryRawUnsafe(sql, ...params);
  }

  async function clean() {
    const orgs = [ORG_A, ORG_B];
    for (const t of ['timeline_events', 'estimates', 'visits', 'leads', 'customers', 'users']) {
      await run(`DELETE FROM ${t} WHERE organization_id = ANY($1::uuid[])`, orgs);
    }
    await run('DELETE FROM organizations WHERE id = ANY($1::uuid[])', orgs);
  }

  async function snapshot() {
    return {
      leads: await query(
        `SELECT id::text, status::text, updated_at FROM leads WHERE organization_id = ANY($1::uuid[]) ORDER BY id`,
        [ORG_A, ORG_B],
      ),
      timeline: await query(
        `SELECT id::text, entity_id::text, description, metadata FROM timeline_events WHERE organization_id = ANY($1::uuid[]) ORDER BY id`,
        [ORG_A, ORG_B],
      ),
    };
  }

  beforeAll(async () => {
    const prismaPkg = await import('@prisma/client');
    prisma = new prismaPkg.PrismaClient();
    await clean();

    for (const org of ['A', 'B'] as const) {
      await run(
        `INSERT INTO organizations (id, name, address_line1, city, state, postal_code, email, estimate_terms, estimate_notes, estimate_payment_terms, updated_at)
         VALUES ($1::uuid, $2, '1 Test St', 'Austin', 'TX', '78701', $3, '', '', '', now())`,
        orgId(org),
        `lws03 backfill org ${org}`,
        `lws03-${org}@example.invalid`,
      );
      await run(
        `INSERT INTO users (id, organization_id, email, first_name, last_name, role, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, 'Test', 'User', 'ADMIN', now())`,
        userId(org),
        orgId(org),
        `lws03-user-${org}@example.invalid`,
      );
      await run(
        `INSERT INTO customers (id, organization_id, customer_number, kind, segment, first_name, last_name, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, 'PERSON', 'RESIDENTIAL', 'Test', 'Customer', now())`,
        customerId(org),
        orgId(org),
        `LWS03-${org}`,
      );
    }

    for (let i = 0; i < FIXTURES.length; i++) {
      const f = FIXTURES[i];
      await run(
        `INSERT INTO leads (id, organization_id, customer_id, lead_number, service_request, status, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::"LeadStatus", '2026-01-01', '2026-01-01')`,
        leadId(i + 1),
        orgId(f.org),
        customerId(f.org),
        `LWS03-L${i + 1}`,
        f.key,
        f.status,
      );
      let seq = 0;
      for (const vs of f.visits ?? []) {
        seq += 1;
        await run(
          `INSERT INTO visits (id, organization_id, lead_id, visit_seq, purpose, status, updated_at)
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, 'WALKTHROUGH', $4::"VisitStatus", now())`,
          orgId(f.org),
          leadId(i + 1),
          seq,
          vs,
        );
      }
      let n = 0;
      for (const e of f.estimates ?? []) {
        n += 1;
        await run(
          `INSERT INTO estimates (id, organization_id, customer_id, lead_id, estimate_number, status, sent_at, subtotal, tax_amount, total_amount, created_by, updated_at)
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4, $5::"EstimateStatus", $6, 0, 0, 0, $7::uuid, now())`,
          orgId(f.org),
          customerId(f.org),
          leadId(i + 1),
          `LWS03-E${i + 1}-${n}`,
          e.status,
          e.sent ? new Date('2026-02-01') : null,
          userId(f.org),
        );
      }
    }

    migrationSql = fs.readFileSync(MIGRATION_SQL, 'utf8');
  });

  afterAll(async () => {
    if (prisma) {
      await clean();
      await prisma.$disconnect();
    }
  });

  it('runs the migration SQL without error', async () => {
    await expect(run(migrationSql)).resolves.not.toThrow();
  });

  it('puts every lead in the status its visits support, and leaves every other lead alone', async () => {
    const rows = await query<{ id: string; status: string }>(
      `SELECT id::text, status::text FROM leads WHERE id = ANY($1::uuid[])`,
      fixtureIds,
    );
    const byId = new Map(rows.map((r) => [r.id, r.status]));
    const actual = FIXTURES.map((f, i) => ({ key: f.key, status: byId.get(leadId(i + 1)) }));
    const wanted = FIXTURES.map((f) => ({ key: f.key, status: f.expect }));
    expect(actual).toEqual(wanted);
  });

  it('writes exactly one STATUS_CHANGE History row per moved lead, with the PRD wording', async () => {
    const rows = await query<any>(
      `SELECT entity_id::text, organization_id::text, entity_type, event_type, description, metadata, created_by
         FROM timeline_events WHERE organization_id = ANY($1::uuid[])`,
      [ORG_A, ORG_B],
    );
    const moved = FIXTURES.map((f, i) => ({ f, id: leadId(i + 1) })).filter(({ f }) => f.expect !== f.status);
    expect(moved.length).toBeGreaterThan(10);
    // exactly one row per moved lead, and no row at all for any other lead
    expect(rows.map((r) => r.entity_id).sort()).toEqual(moved.map((m) => m.id).sort());

    for (const { f, id } of moved) {
      const row = rows.find((r) => r.entity_id === id);
      expect(row, f.key).toBeTruthy();
      expect(row.entity_type, f.key).toBe('LEAD');
      expect(row.event_type, f.key).toBe('STATUS_CHANGE');
      expect(row.created_by, f.key).toBeNull();
      expect(row.organization_id, f.key).toBe(orgId(f.org));
      expect(row.metadata, f.key).toEqual({ from: f.status, to: f.expect, via: 'walkthrough_status_backfill' });
      expect(row.description, f.key).toBe(f.expect === 'WALKTHROUGH_SCHEDULED' ? DESC_SCHEDULED : DESC_COMPLETED);
    }
  });

  it('bumps updated_at on moved leads only', async () => {
    const rows = await query<{ id: string; updated_at: Date }>(
      `SELECT id::text, updated_at FROM leads WHERE id = ANY($1::uuid[])`,
      fixtureIds,
    );
    const seeded = new Date('2026-01-01T00:00:00Z').getTime();
    for (const r of rows) {
      const i = fixtureIds.indexOf(r.id);
      const f = FIXTURES[i];
      const touched = new Date(r.updated_at).getTime() !== seeded;
      expect(touched, f.key).toBe(f.expect !== f.status);
    }
  });

  it('a second run moves nothing, inserts nothing and does not error', async () => {
    const before = await snapshot();
    await expect(run(migrationSql)).resolves.not.toThrow();
    const after = await snapshot();
    expect(after).toEqual(before);
  });
});
