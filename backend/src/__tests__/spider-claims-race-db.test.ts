/* =============================================================================
   #2990: a claim written by an earlier or a parallel run is never duplicated, and never makes the other run's
   alert go out twice, now that a run writes all its claims in one insert.

   The sweep's lease (#2993) normally keeps two runs apart. These tests take that guard away on purpose, so the
   claim key itself is what is tested:
   1. The bulk claim against a claim another connection holds uncommitted: it waits, skips that one, and returns
      only its own.
   2. Two whole sweeps of the same company at once (two copies of the sweep module, lease granted to both): each
      lead is claimed once and emailed once per person, and each run's log line counts exactly its own claims.

   Real migrated database (TEST_DATABASE_URL); skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

const { realClient, otherClient, resendSend } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return {
    realClient: dbUrl ? new PrismaClient({ datasources: { db: { url: dbUrl } } }) : undefined,
    // A second connection pool: "the other run".
    otherClient: dbUrl ? new PrismaClient({ datasources: { db: { url: dbUrl } } }) : undefined,
    resendSend: vi.fn(),
  };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));
vi.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'test',
    EMAIL_FROM: 'no-reply@test.com',
    EMAIL_FROM_BUSINESS: 'no-reply@mail.test.com',
    RESEND_API_KEY: 're_test_key',
    FRONTEND_URL: 'https://staging.app.test',
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://test:test@localhost:5432/test',
    SPIDER_PILOT_ORG_IDS: undefined,
  },
}));
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: resendSend };
  },
}));
vi.mock('../lib/email', async () => vi.importActual('../lib/email'));
// The lease is granted to every run: the claim key alone keeps the runs apart here.
vi.mock('../services/spider/sweepLease', () => ({
  SPIDER_SWEEP_LEASE: 'spider-sweep',
  claimSweepLease: async () => ({ held: () => true, release: async () => undefined }),
}));

const suite = realClient ? describe : describe.skip;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = new Date('2026-10-01T12:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

suite('Spider claims under a race (#2990, real database)', () => {
  const db = realClient as PrismaClient;
  const other = otherClient as PrismaClient;
  const orgs: string[] = [];

  beforeEach(async () => {
    vi.clearAllMocks();
    resendSend.mockResolvedValue({ data: { id: 'msg_1' }, error: null });
  });

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.spiderSettings.deleteMany({ where: { organization_id: org } }));
      for (const table of ['spider_alerts', 'notifications', 'leads', 'customers', 'users']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = $1::uuid`, org));
      }
      await quietly(db.organization.deleteMany({ where: { id: org } }));
    }
    await db.$disconnect();
    await other.$disconnect();
  });

  /** A company with `n` overdue New leads and two Admins who are emailed (in-app and email on). */
  async function company(n: number, opts: { settings?: boolean } = {}) {
    const org = randomUUID();
    orgs.push(org);
    const short = org.slice(0, 8);
    await db.organization.create({
      data: {
        id: org, name: `spider-race-${short}`, email: `org-${short}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        plan: 'SCALE', is_demo: true, feature_overrides: {} as never, email_sending_enabled: true,
      },
    });
    const people: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const email = `admin${i}-${short}@example.test`;
      await db.user.create({ data: { organization_id: org, email, first_name: `admin${i}`, last_name: 'Tester', role: 'ADMIN', is_admin: true, is_active: true, has_login: true } });
      people.push(email);
    }
    const customer = randomUUID();
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${short}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
    });
    const leads: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const id = randomUUID();
      await db.lead.create({
        data: { id, organization_id: org, customer_id: customer, lead_number: `L-${id.slice(0, 8)}`, service_request: 'Fix the door', status: 'NEW', created_at: at(-DAY - i * HOUR) },
      });
      leads.push(id);
    }
    if (opts.settings !== false) {
      const off = { enabled: false, value: 1, unit: 'DAY' };
      await db.spiderSettings.create({
        data: {
          organization_id: org, is_active: true, activated_at: at(-60 * DAY),
          status_limits: { NEW: { enabled: true, value: 2, unit: 'HOUR' }, CONTACTED: off, WALKTHROUGH_COMPLETED: off },
          channels: { in_app: true, red_frame: true, email: true, text: false },
          recipients: { roles: ['ADMIN'], user_ids: [], lead_owner: false },
          watch_all_leads: true, selected_lead_ids: [],
        },
      });
    }
    return { org, people, leads };
  }

  const claimRow = (org: string, leadId: string) => ({
    organization_id: org, lead_id: leadId, status: 'NEW' as const,
    entered_status_at: at(-DAY), counted_from: at(-DAY), limit_value: 2, limit_unit: 'HOUR', alerted_at: T0, recipient_ids: [],
  });

  it('the bulk claim waits for a claim another connection holds, skips it, and returns only its own', async () => {
    const { claimVisits } = await import('../services/spider/alertLog.js');
    const c = await company(2, { settings: false });
    const [taken, free] = c.leads as [string, string];
    let letGo!: () => void;
    const held = new Promise<void>((r) => { letGo = r; });
    let otherInserted!: () => void;
    const inserted = new Promise<void>((r) => { otherInserted = r; });
    // The other run: its claim on `taken` is written but not committed until we let it go.
    const otherRun = other.$transaction(async (tx) => {
      await tx.spiderAlert.create({ data: claimRow(c.org, taken) });
      otherInserted();
      await held;
    }, { timeout: 20_000 });
    await inserted;

    let settled = false;
    const mine = claimVisits([claimRow(c.org, taken), claimRow(c.org, free)]).finally(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 500));
    // It waits on the uncommitted claim: it cannot know yet whether that key is taken.
    expect(settled).toBe(false);
    letGo();
    await otherRun;
    const claimed = (await mine.catch((err: unknown) => err)) as Map<string, string>;

    // A taken key is skipped, never an error for the whole insert.
    expect(claimed).toBeInstanceOf(Map);
    expect([...claimed.keys()]).toEqual([free]);
    const rows = await db.spiderAlert.findMany({ where: { organization_id: c.org }, select: { id: true, lead_id: true } });
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.lead_id === free)!.id).toBe(claimed.get(free));
    expect(rows.find((r) => r.lead_id === taken)!.id).not.toBe(claimed.get(taken));
  });

  it('a claim an earlier run already wrote is skipped and not returned', async () => {
    const { claimVisits } = await import('../services/spider/alertLog.js');
    const c = await company(1, { settings: false });
    await db.spiderAlert.create({ data: claimRow(c.org, c.leads[0]!) });
    const claimed = await claimVisits([claimRow(c.org, c.leads[0]!)]).catch((err: unknown) => err);
    expect(claimed).toBeInstanceOf(Map);
    expect((claimed as Map<string, string>).size).toBe(0);
    expect(await db.spiderAlert.count({ where: { organization_id: c.org } })).toBe(1);
  });

  it('two whole sweeps at once: each lead is claimed and emailed once, and each run counts only its own claims', async () => {
    const c = await company(6);
    /** A separate copy of the sweep (its own in-process guard) and of the logger it writes its line to. */
    async function aRun() {
      vi.resetModules();
      const sweep = await import('../services/spider/sweep.js');
      const { logger } = await import('../lib/logger.js');
      return { sweep, logger };
    }
    const a = await aRun();
    const b = await aRun();
    expect(a.sweep.runSpiderSweep).not.toBe(b.sweep.runSpiderSweep);

    const [ra, rb] = await Promise.all([a.sweep.runSpiderSweep(T0), b.sweep.runSpiderSweep(T0)]);
    expect(ra.ran && rb.ran).toBe(true);

    // The two copies may share one logger mock (the setup file's): read each logger once.
    const loggers = [...new Set([a.logger, b.logger])];
    const errors = loggers.flatMap((l) => vi.mocked(l.error).mock.calls.map((x) => String(x[0])));
    expect(await db.spiderAlert.count({ where: { organization_id: c.org } }), `errors logged: ${JSON.stringify(errors)}`).toBe(6);
    const emailed = resendSend.mock.calls.map(([m]) => m as { to: string; text: string }).filter((m) => c.people.includes(m.to));
    // Every lead's alert reached each of the two Admins exactly once.
    for (const leadId of c.leads) {
      expect(emailed.filter((m) => m.text.includes(leadId)).map((m) => m.to).sort()).toEqual([...c.people].sort());
    }
    expect(emailed).toHaveLength(12);

    const companyLines = loggers.flatMap((l) =>
      (vi.mocked(l.info).mock.calls as unknown as unknown[][])
        .filter((x) => x[0] === '[spider] company swept' && (x[1] as { orgId?: string }).orgId === c.org)
        .map((x) => x[1] as { claimed: number; alreadyClaimed: number; alertsSent: number; overdue: number }),
    );
    // One line per run, each run's `claimed` the alerts it raised itself; together, every lead once.
    expect(companyLines).toHaveLength(2);
    for (const l of companyLines) {
      expect(l.claimed).toBe(l.alertsSent);
      expect(l.claimed + l.alreadyClaimed).toBeLessThanOrEqual(l.overdue);
    }
    expect(companyLines[0]!.claimed + companyLines[1]!.claimed).toBe(6);
  });
});
