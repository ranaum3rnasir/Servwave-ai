/* =============================================================================
   The synthetic big company (#2984) on a real migrated database (TEST_DATABASE_URL; skips when unset).

   The journey: seed the company (small sizes here; the defaults are 15,000 / 5,000 / 60), see it as
   its Admin through the Spider API (off, set up), switch Spider on through the API, let the sweep run
   the starting summary, and see the summary cover every overdue lead. Then the one delete command
   removes the company and everything Spider wrote for it, and nothing of any other company.

   Also: a second seed refuses and doubles nothing; delete refuses a company that only shares the id;
   delete still finishes when someone added records the bulk path cannot remove.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

const { realClient } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined };
});

vi.mock('../../src/lib/prisma', () => ({ prisma: realClient }));
// The sweep opens its lock on a connection of its own from the app's database URL: the test database.
vi.mock('../../src/config/env', async () => {
  const { testEnv } = await import('../../src/__tests__/test-env.js');
  return { env: { ...testEnv, DATABASE_URL: process.env.TEST_DATABASE_URL ?? testEnv.DATABASE_URL } };
});

import { supabaseAdmin } from '../../src/lib/supabase';
import { switchFixture } from '../../src/__tests__/permission-switches-fixture';
import { runSpiderSweep } from '../../src/services/spider/sweep';
import { SUMMARY_QUIET_MS } from '../../src/services/spider/summary';
import {
  SYNTHETIC_COMPANY_ID,
  SYNTHETIC_EMAIL_DOMAIN,
  countSyntheticCompany,
  deleteSyntheticCompany,
  seedSyntheticCompany,
} from '../synthetic-big-company';

const suite = realClient ? describe : describe.skip;
const SIZES = { customers: 40, overdueLeads: 24, staff: 7 };
const STATUS = '/api/ai-farm/spider/status';
const SETTINGS = '/api/ai-farm/spider/settings';

suite('synthetic big company (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../../src/app.js')).default as never);

  /** Every row the company or Spider holds for it, by table. */
  async function everything(org: string) {
    const [orgs, customers, leads, users, settings, alerts, summaries, notifications, mailboxes] = await Promise.all([
      db.organization.count({ where: { id: org } }),
      db.customer.count({ where: { organization_id: org } }),
      db.lead.count({ where: { organization_id: org } }),
      db.user.count({ where: { organization_id: org } }),
      db.spiderSettings.count({ where: { organization_id: org } }),
      db.spiderAlert.count({ where: { organization_id: org } }),
      db.spiderSummary.count({ where: { organization_id: org } }),
      db.notification.count({ where: { organization_id: org } }),
      db.mailbox.count({ where: { organization_id: org } }),
    ]);
    return { orgs, customers, leads, users, settings, alerts, summaries, notifications, mailboxes };
  }

  /** Another demo company with Spider settings, a customer and a lead, whose name even starts the same way. */
  async function otherCompany() {
    const org = randomUUID();
    await db.organization.create({
      data: {
        id: org, name: 'Synthetic Big Company (another one)', email: `other-${org.slice(0, 8)}@example.test`, is_demo: true, plan: 'SCALE',
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
      },
    });
    const customer = await db.customer.create({
      data: { organization_id: org, customer_number: 'C00001', kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Other' },
    });
    await db.lead.create({
      data: { organization_id: org, lead_number: 'L00001', customer_id: customer.id, service_request: 'x', created_at: new Date(Date.now() - 30 * 86_400_000) },
    });
    await db.spiderSettings.create({ data: { organization_id: org } });
    return org;
  }

  async function removeOther(org: string) {
    await db.spiderSettings.deleteMany({ where: { organization_id: org } });
    await db.lead.deleteMany({ where: { organization_id: org } });
    await db.customer.deleteMany({ where: { organization_id: org } });
    await db.organization.deleteMany({ where: { id: org } });
  }

  beforeAll(async () => {
    // A run that crashed earlier may have left the company behind.
    await deleteSyntheticCompany(db);
    await import('../../src/app.js');
  }, 120_000);
  afterAll(async () => {
    await deleteSyntheticCompany(db);
    await fx.cleanup();
  }, 120_000);

  it('seeds the company, its Spider starting summary covers every overdue lead, and one delete removes it and nothing else', async () => {
    const other = await otherCompany();
    try {
      const otherBefore = await everything(other);
      const createUser = vi.mocked(supabaseAdmin.auth.admin.createUser);
      createUser.mockClear();

      const seeded = await seedSyntheticCompany(db, { sizes: SIZES, chunkSize: 10 });
      expect(seeded.ok).toBe(true);
      expect(await countSyntheticCompany(db)).toEqual({
        customers: 40, customerEmails: 40, customerPhones: 40, serviceLocations: 40,
        leads: 24, leadAssignees: 24, overdueLeads: 24, staff: 7, alertableStaff: 7, spiderOn: false,
      });
      const org = await db.organization.findUniqueOrThrow({ where: { id: SYNTHETIC_COMPANY_ID } });
      expect(org).toMatchObject({ is_demo: true, plan: 'SCALE', customer_next_number: 41, lead_next_number: 25 });
      // No sign-in account was made for anyone, and no password exists.
      expect(createUser).not.toHaveBeenCalled();
      const staff = await db.user.findMany({ where: { organization_id: SYNTHETIC_COMPANY_ID }, orderBy: { email: 'asc' } });
      for (const s of staff) {
        expect(s.password_hash).toBe('');
        expect(s.email.endsWith(`@${SYNTHETIC_EMAIL_DOMAIN}`)).toBe(true);
      }
      expect(org.owner_user_id).toBe(staff[0]!.id);

      // As the company's Admin: Spider is set up and off.
      const admin = staff.find((s) => s.is_admin)!;
      const api = await fx.signedInAs({ id: admin.id, email: admin.email });
      expect((await api.get(STATUS)).body).toEqual({ isActive: false, isSetUp: true });

      // Switch it on through the API; the settings it was seeded with are the ones in force.
      expect((await api.put(STATUS, { isActive: true })).status).toBe(200);
      const settings = (await api.get(SETTINGS)).body.settings;
      expect(settings.status_limits.NEW).toEqual({ enabled: true, value: 4, unit: 'HOUR' });
      expect(settings.status_limits.CONTACTED).toEqual({ enabled: true, value: 2, unit: 'DAY' });

      // Once the quiet period is over, the sweep sends the starting summary: every overdue lead, once.
      const result = await runSpiderSweep(new Date(Date.now() + SUMMARY_QUIET_MS + 5_000));
      expect(result.ran).toBe(true);
      const claims = await db.spiderAlert.findMany({ where: { organization_id: SYNTHETIC_COMPANY_ID }, select: { kind: true, lead_id: true } });
      expect(claims).toHaveLength(24);
      expect(claims.every((c) => c.kind === 'SUMMARIZED')).toBe(true);
      expect(new Set(claims.map((c) => c.lead_id)).size).toBe(24);
      expect(await db.spiderSummary.count({ where: { organization_id: SYNTHETIC_COMPANY_ID } })).toBe(1);

      // A second seed refuses and adds nothing.
      const again = await seedSyntheticCompany(db, { sizes: SIZES });
      expect(again).toEqual({ ok: false, reason: expect.stringContaining('already exists') });
      expect((await countSyntheticCompany(db))!.customers).toBe(40);

      // One delete: the company and everything Spider wrote for it are gone; the other company is whole.
      expect(await deleteSyntheticCompany(db)).toMatchObject({ ok: true, deleted: true, path: 'fast' });
      expect(await everything(SYNTHETIC_COMPANY_ID)).toEqual({
        orgs: 0, customers: 0, leads: 0, users: 0, settings: 0, alerts: 0, summaries: 0, notifications: 0, mailboxes: 0,
      });
      expect(await db.user.count({ where: { email: { endsWith: `@${SYNTHETIC_EMAIL_DOMAIN}` } } })).toBe(0);
      expect(await everything(other)).toEqual(otherBefore);
      // Deleting again is a no-op.
      expect(await deleteSyntheticCompany(db)).toEqual({ ok: true, deleted: false });
    } finally {
      await removeOther(other);
    }
  }, 120_000);

  it('still deletes everything when someone added a record the bulk delete cannot remove', async () => {
    expect((await seedSyntheticCompany(db, { sizes: { customers: 6, overdueLeads: 4, staff: 2 } })).ok).toBe(true);
    const lead = await db.lead.findFirstOrThrow({ where: { organization_id: SYNTHETIC_COMPANY_ID } });
    const admin = await db.user.findFirstOrThrow({ where: { organization_id: SYNTHETIC_COMPANY_ID, is_admin: true } });
    // An estimate on a lead holds the lead and its customer in place (ON DELETE RESTRICT).
    await db.estimate.create({
      data: {
        organization_id: SYNTHETIC_COMPANY_ID, customer_id: lead.customer_id, lead_id: lead.id, estimate_number: 'E00001',
        subtotal: 0, tax_amount: 0, total_amount: 0, created_by: admin.id,
      },
    });
    expect(await deleteSyntheticCompany(db)).toMatchObject({ ok: true, deleted: true, path: 'full' });
    expect(await everything(SYNTHETIC_COMPANY_ID)).toMatchObject({ orgs: 0, customers: 0, leads: 0, users: 0 });
    expect(await db.estimate.count({ where: { organization_id: SYNTHETIC_COMPANY_ID } })).toBe(0);
  }, 120_000);

  it('refuses to delete a company that has the id but not the markers, and deletes nothing', async () => {
    await db.organization.create({
      data: {
        id: SYNTHETIC_COMPANY_ID, name: 'Someone else', email: 'someone@example.test', is_demo: false,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
      },
    });
    try {
      const customer = await db.customer.create({
        data: { organization_id: SYNTHETIC_COMPANY_ID, customer_number: 'C00001', kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat' },
      });
      expect(await deleteSyntheticCompany(db)).toEqual({ ok: false, reason: expect.stringContaining('Refusing') });
      expect(await db.customer.count({ where: { id: customer.id } })).toBe(1);
      // Nor will seed build over it.
      expect((await seedSyntheticCompany(db, { sizes: SIZES })).ok).toBe(false);
    } finally {
      await db.customer.deleteMany({ where: { organization_id: SYNTHETIC_COMPANY_ID } });
      await db.organization.deleteMany({ where: { id: SYNTHETIC_COMPANY_ID } });
    }
  });
});
