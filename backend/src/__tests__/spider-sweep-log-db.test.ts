/* =============================================================================
   Spider sweep log line (#2986): one structured info line per company the run sweeps, and the companies it
   skips told apart from quiet ones. Real migrated database (TEST_DATABASE_URL); skips when it is unset.
   Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

const { realClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return { realClient: dbUrl ? new PrismaClient({ datasources: { db: { url: dbUrl } } }) : undefined };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));
vi.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'test',
    EMAIL_FROM: 'no-reply@test.com',
    EMAIL_FROM_BUSINESS: 'no-reply@mail.test.com',
    FRONTEND_URL: 'https://staging.app.test',
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://test:test@localhost:5432/test',
  },
}));

import { runSpiderSweep } from '../services/spider/sweep';
import { SPIDER_SWEEP_LEASE } from '../services/spider/sweepLease';
import { logger } from '../lib/logger';

const suite = realClient ? describe : describe.skip;

const HOUR = 3_600_000;
const T0 = new Date('2026-10-01T12:00:00.000Z');
const SWEPT = '[spider] company swept';
const SKIPPED = '[spider] companies skipped this run';

suite('Spider sweep log line (real database)', () => {
  const db = realClient as PrismaClient;
  const orgs: string[] = [];

  const clearLease = () => db.$executeRawUnsafe(`DELETE FROM spider_sweep_leases WHERE name = $1`, SPIDER_SWEEP_LEASE);

  beforeEach(async () => {
    // Every run sweeps every company with settings: switch off what earlier cases left on.
    if (orgs.length) await db.spiderSettings.updateMany({ where: { organization_id: { in: orgs } }, data: { is_active: false } });
    await clearLease();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.spiderSettings.deleteMany({ where: { organization_id: org } }));
      for (const table of ['spider_alerts', 'notifications', 'timeline_events', 'leads', 'customers', 'users']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.organization.deleteMany({ where: { id: org } }));
    }
    await clearLease().catch(() => undefined);
    await db.$disconnect();
  });

  /** A demo company with `leads` day-old New leads. `limits` false = no stage switched on; `active` false = Spider off. */
  async function company(leads: number, opts: { active?: boolean; limits?: boolean } = {}) {
    const { active = true, limits = true } = opts;
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    await db.organization.create({
      data: {
        id: org, name: `Secret Customer Co ${tag}`, email: `org-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '', plan: 'SCALE', is_demo: true,
      },
    });
    await db.user.create({
      data: { id: randomUUID(), organization_id: org, email: `staff-${tag}@example.test`, first_name: 'Staffy', last_name: 'Contactable', role: 'ADMIN', is_admin: true },
    });
    const customer = randomUUID();
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
    });
    for (let i = 0; i < leads; i += 1) {
      const id = randomUUID();
      await db.lead.create({
        data: {
          id, organization_id: org, customer_id: customer, lead_number: `L-${id.slice(0, 8)}`, service_request: 'Fix the secret door',
          status: 'NEW', created_at: new Date(T0.getTime() - 24 * HOUR),
        },
      });
    }
    const off = { enabled: false, value: 1, unit: 'DAY' };
    await db.spiderSettings.create({
      data: {
        organization_id: org,
        is_active: active,
        activated_at: new Date(T0.getTime() - 60 * 24 * HOUR),
        status_limits: { NEW: { enabled: limits, value: 2, unit: 'HOUR' }, CONTACTED: off, WALKTHROUGH_COMPLETED: off },
        channels: { in_app: true, red_frame: true, email: false, text: false },
        recipients: { roles: ['ADMIN'], user_ids: [], lead_owner: false },
        watch_all_leads: true,
        selected_lead_ids: [],
      },
    });
    return org;
  }

  const infoCalls = () => vi.mocked(logger.info).mock.calls as unknown as [string, unknown][];
  const sweptFor = (org: string) => infoCalls().filter(([msg, meta]) => msg === SWEPT && (meta as { orgId: string }).orgId === org);
  const skippedMeta = () => infoCalls().filter(([msg]) => msg === SKIPPED).map(([, meta]) => meta as { skipped: Record<string, number> });

  it('logs exactly one line per swept company, with exactly these fields', async () => {
    const org = await company(3);

    await runSpiderSweep(T0);
    const lines = sweptFor(org);

    expect(lines).toHaveLength(1);
    const meta = lines[0][1] as Record<string, unknown>;
    // The exact key set: nothing else (no name, contact or lead content) can ride along.
    expect(Object.keys(meta).sort()).toEqual(['alertsSent', 'alreadyClaimed', 'claimed', 'durationMs', 'leadsChecked', 'orgId', 'overdue']);
    expect(meta).toMatchObject({ orgId: org, leadsChecked: 3, overdue: 3, claimed: 3, alreadyClaimed: 0, alertsSent: 3 });
    expect(typeof meta.durationMs).toBe('number');
    expect(meta.durationMs as number).toBeGreaterThanOrEqual(0);
  });

  it('splits visits claimed by this run from those an earlier run already claimed', async () => {
    const org = await company(2);
    await runSpiderSweep(T0);
    vi.clearAllMocks();

    await runSpiderSweep(new Date(T0.getTime() + 2 * 60_000));

    expect(sweptFor(org)[0][1]).toMatchObject({ orgId: org, leadsChecked: 2, overdue: 2, claimed: 0, alreadyClaimed: 2, alertsSent: 0 });
  });

  it('a starting-summary run reports the backlog it claimed, though it sent no per-lead alert', async () => {
    const org = await company(3);
    await db.spiderSettings.update({
      where: { organization_id: org },
      data: { summary_trigger_at: new Date(T0.getTime() - HOUR), summary_trigger_since: new Date(T0.getTime() - HOUR), summary_trigger_kind: 'SWITCHED_ON' },
    });

    await runSpiderSweep(T0);

    expect(sweptFor(org)[0][1]).toMatchObject({ orgId: org, leadsChecked: 3, overdue: 3, claimed: 3, alreadyClaimed: 0, alertsSent: 0 });
    expect(await db.spiderAlert.count({ where: { organization_id: org } })).toBe(3);
  });

  it('a company whose sweep throws still gets its line, with the error class only', async () => {
    const org = await company(2);
    const original = db.spiderSettings.findUnique.bind(db.spiderSettings);
    const spy = vi.spyOn(db.spiderSettings, 'findUnique').mockImplementation(((args: { where: { organization_id?: string } }) => {
      if (args?.where?.organization_id === org) return Promise.reject(new TypeError('boom: Staffy Contactable staff@example.test'));
      return original(args as never);
    }) as never);
    try {
      await runSpiderSweep(T0);
    } finally {
      spy.mockRestore();
    }

    const lines = sweptFor(org);
    expect(lines).toHaveLength(1);
    const meta = lines[0][1] as Record<string, unknown>;
    expect(Object.keys(meta).sort()).toEqual(['alertsSent', 'alreadyClaimed', 'claimed', 'durationMs', 'leadsChecked', 'orgId', 'outcome', 'overdue']);
    expect(meta).toMatchObject({ orgId: org, outcome: 'TypeError', leadsChecked: 0, claimed: 0, alertsSent: 0 });
    expect(typeof meta.durationMs).toBe('number');
    expect(JSON.stringify(meta)).not.toContain('Staffy');
  });

  it('a quiet company (nothing overdue) is a swept line with zeros, not a skip', async () => {
    const org = await company(0);

    await runSpiderSweep(T0);

    expect(sweptFor(org)[0][1]).toMatchObject({ orgId: org, leadsChecked: 0, overdue: 0, claimed: 0, alreadyClaimed: 0, alertsSent: 0 });
    expect(skippedMeta().flatMap((m) => Object.keys(m.skipped))).not.toContain('outside_gate');
  });

  it('skipped companies get no swept line and are counted by reason in one summary line', async () => {
    const off = await company(1, { active: false });
    const noLimits = await company(1, { limits: false });

    await runSpiderSweep(T0);

    expect(sweptFor(off)).toHaveLength(0);
    expect(sweptFor(noLimits)).toHaveLength(0);
    const summaries = skippedMeta();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].skipped.switched_off).toBeGreaterThanOrEqual(1);
    expect(summaries[0].skipped.no_limits_set).toBeGreaterThanOrEqual(1);
    expect(Object.keys(summaries[0])).toEqual(['skipped']);
  });

  it('no staff contact, customer name, company name or lead content appears in anything logged', async () => {
    await company(2);

    await runSpiderSweep(T0);

    const text = JSON.stringify(
      (['info', 'warn', 'error'] as const).flatMap((level) => (vi.mocked(logger[level]).mock.calls as unknown as [string, unknown][]).filter(([m]) => m === SWEPT || m === SKIPPED)),
    );
    expect(text).toContain(SWEPT); // not vacuous: the line is there to be checked
    for (const secret of ['example.test', 'Staffy', 'Contactable', 'Payer', 'Secret Customer Co', 'secret door', 'L-', 'Testville']) {
      expect(text).not.toContain(secret);
    }
  });
});
