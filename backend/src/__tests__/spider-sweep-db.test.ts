/* =============================================================================
   Spider lead watcher (#2619) - Seam C: the sweep against a real migrated database.

   The sweep runs at chosen clock times against real companies, leads (and their stage timestamps),
   notifications and the Spider alert log. Email is faked at the provider's client and texts at the
   phone system's client - everything between the sweep and those two boundaries is real: the
   gate, the recipient rule, the claim, the bell's emit, the email brakes and the text gates.

   Covers #2622 (alerting), #2623 (ending), #2625 (email) and #2626 (text).
   Skips when TEST_DATABASE_URL is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { LeadStatus, PrismaClient, Role } from '@prisma/client';

const { realClient, resendSend, faults } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return {
    realClient: dbUrl ? new PrismaClient({ datasources: { db: { url: dbUrl } } }) : undefined,
    resendSend: vi.fn(),
    faults: { executeRaw: null as null | ((sql: string) => Error | null), calls: [] as string[] },
  };
});

// The real client, with raw statements that a test can make fail (support/prisma-faults.ts).
vi.mock('../lib/prisma', async () => ({ prisma: realClient && (await import('./support/prisma-faults.js')).withFaults(realClient, faults) }));

const FRONTEND_URL = 'https://staging.app.test';
vi.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'test',
    EMAIL_FROM: 'no-reply@test.com',
    EMAIL_FROM_BUSINESS: 'no-reply@mail.test.com',
    RESEND_API_KEY: 're_test_key',
    FRONTEND_URL: 'https://staging.app.test',
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://test:test@localhost:5432/test',
    // SPEC-5: the Spider pilot list, unset as today. Tests that need it assign it and restore it.
    SPIDER_PILOT_ORG_IDS: undefined,
  },
}));

// The email provider's client is the boundary: the real lib/email runs, its client is fake.
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: resendSend };
    // One alert's emails go out as one batch request (#3470); this answers it from the per-email fake above.
    batch = { send: async (...a: [never, never?]) => (await import('./spider-batch-test-helpers.js')).batchOverSingleSends(resendSend as never)(...(a as [never, never])) };
  },
}));
vi.mock('../lib/email', async () => vi.importActual('../lib/email'));

import { runSpiderSweep } from '../services/spider/sweep';
import { reconsiderLeadContact, recordLeadContactOnLink, recordLeadOutboundContact } from '../services/lead-contact.service';
import { getCommUsage } from '../lib/comm-usage';
import { logger } from '../lib/logger';
import * as ctm from '../lib/ctm/client';
import { _resetCtmSmsDoubleFireGuard } from '../lib/ctm/sendSms';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { env } from '../config/env';

const suite = realClient ? describe : describe.skip;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = new Date('2026-10-01T12:00:00.000Z');
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);

type Limit = { enabled: boolean; value: number; unit: 'MINUTE' | 'HOUR' | 'DAY' };
// The three stages Spider acts on (Ran, 15 Oct, D2): New, Contacted and Walkthrough Completed.
const ALL_OFF: Record<string, Limit> = {
  NEW: { enabled: false, value: 1, unit: 'DAY' },
  CONTACTED: { enabled: false, value: 1, unit: 'DAY' },
  WALKTHROUGH_COMPLETED: { enabled: false, value: 1, unit: 'DAY' },
};

suite('Spider sweep (real database)', () => {
  const db = realClient as PrismaClient;
  const orgs: string[] = [];
  let seq = 0;

  beforeAll(async () => {
    // A sweep covers every company with a Spider settings row; leftovers from an earlier run of
    // this file must not leak into this one's counts.
    await db.spiderSettings.deleteMany({ where: { organization: { name: { startsWith: 'spider-sweep-' } } } });
  });

  beforeEach(async () => {
    // Every run sweeps every company with settings, so a company an earlier test left switched on, or
    // with a starting trigger still waiting, would alert or send its summary inside this test. Each
    // test switches on only the companies it configures.
    await db.spiderSettings.updateMany({
      where: { organization: { name: { startsWith: 'spider-sweep-' } } },
      data: { is_active: false, summary_trigger_at: null, summary_trigger_kind: null, summary_trigger_since: null },
    });
    vi.clearAllMocks();
    clearPermissionCache();
    _resetCtmSmsDoubleFireGuard();
    resendSend.mockResolvedValue({ data: { id: 'msg_1' }, error: null });
    vi.mocked(ctm.isCtmConfigured).mockReturnValue(true);
    vi.mocked(ctm.isOutboundAllowed).mockReturnValue(true);
    vi.mocked(ctm.isOptedOut).mockResolvedValue(false);
    vi.mocked(ctm.sendSms).mockResolvedValue({ id: 'sms_1' });
  });

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      for (const table of ['notifications', 'timeline_events', 'leads', 'phone_numbers', 'customers', 'users']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.organization.deleteMany({ where: { id: org } }));
    }
    await db.$disconnect();
  });

  // ─── Fixtures ──────────────────────────────────────────────────────────────

  interface Company {
    org: string;
    admin: { id: string; email: string };
    customer: string;
  }

  /** A Scale demo company that may email and text, with a texting number and the default grants. */
  async function company(opts: { demo?: boolean; plan?: 'SCALE' | 'PRO'; overrides?: object; email?: boolean } = {}): Promise<Company> {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    await db.organization.create({
      data: {
        id: org, name: `spider-sweep-${tag}`, email: `org-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        plan: opts.plan ?? 'SCALE', is_demo: opts.demo ?? true,
        feature_overrides: (opts.overrides ?? {}) as never,
        email_sending_enabled: opts.email ?? true,
        ctm_account_id: `acct-${tag}`, ctm_sms_ready: true, sms_sending_enabled: true,
      },
    });
    for (const g of DEFAULT_GRANTS) {
    }
    await db.phoneNumber.create({
      data: { organization_id: org, e164: '+16175550000', sms_enabled: true, ctm_number_id: `TPN-${tag}`, status: 'active', is_org_default: true },
    });
    const admin = await person(org, 'ADMIN', { phone: '+16175550101' });
    const customer = randomUUID();
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer', phone: '+16175559999' },
    });
    return { org, admin, customer };
  }

  async function person(org: string, role: Role, opts: { phone?: string | null; active?: boolean; login?: boolean } = {}) {
    const id = randomUUID();
    const email = `p${++seq}-${org.slice(0, 8)}@example.test`;
    await db.user.create({
      data: {
        id, organization_id: org, email, first_name: `${role.toLowerCase()}${seq}`, last_name: 'Tester', role, is_admin: role === 'ADMIN',
        phone: opts.phone ?? null, is_active: opts.active ?? true, has_login: opts.login ?? true,
      },
    });
    return { id, email };
  }

  /** The lead timestamps Spider decides a lead's stage from (Ran, 15 Oct: the contractor's rules). */
  interface Times {
    contacted_at?: Date | null;
    walkthrough_first_booked_at?: Date | null;
    last_visit_completed_at?: Date | null;
    first_estimate_sent_at?: Date | null;
    won_at?: Date | null;
    lost_at?: Date | null;
    cancelled_at?: Date | null;
  }

  async function lead(c: Company, opts: { status?: LeadStatus; createdAt?: Date; owner?: string } & Times = {}) {
    const id = randomUUID();
    const { status, createdAt, owner, ...times } = opts;
    await db.lead.create({
      data: {
        id, organization_id: c.org, customer_id: c.customer, lead_number: `L-${id.slice(0, 8)}`, service_request: 'Fix the door',
        status: status ?? 'NEW', created_at: createdAt ?? at(-30 * DAY), commission_owner_id: owner ?? null, ...times,
      },
    });
    return id;
  }

  /** A lead moving on: its status and the timestamps the move writes. */
  async function move(leadId: string, status: LeadStatus, times: Times = {}) {
    await db.lead.update({ where: { id: leadId }, data: { status, ...times } });
  }

  async function configure(c: Company, opts: {
    active?: boolean;
    activatedAt?: Date;
    limits?: Record<string, Limit>;
    channels?: Partial<{ in_app: boolean; red_frame: boolean; email: boolean; text: boolean }>;
    recipients?: { roles?: Role[]; user_ids?: string[]; lead_owner?: boolean };
    /** The leads Spider does not watch (#3434). */
    excluded?: string[];
    /** A starting trigger waiting (#2794), and its kind. */
    trigger?: Date | null;
    triggerKind?: string;
    /** When the trigger first started waiting (defaults to the trigger itself). */
    triggerSince?: Date;
  } = {}) {
    const data = {
      summary_trigger_at: opts.trigger ?? null,
      summary_trigger_kind: opts.trigger ? (opts.triggerKind ?? 'SWITCHED_ON') : null,
      summary_trigger_since: opts.trigger ? (opts.triggerSince ?? opts.trigger) : null,
      is_active: opts.active ?? true,
      activated_at: opts.activatedAt ?? at(-60 * DAY),
      status_limits: { ...ALL_OFF, ...(opts.limits ?? { NEW: { enabled: true, value: 2, unit: 'HOUR' } }) },
      channels: { in_app: true, red_frame: true, email: false, text: false, ...(opts.channels ?? {}) },
      recipients: { roles: [], user_ids: [], lead_owner: false, ...(opts.recipients ?? {}) },
      excluded_lead_ids: opts.excluded ?? [],
    };
    await db.spiderSettings.upsert({ where: { organization_id: c.org }, create: { organization_id: c.org, ...data }, update: data });
  }

  /**
   * A lead's alert-log rows. `recipients` is the list of people the row recorded: a row keeps no copy of its own since
   * #3107, it points at a stored recipient set, so the list is read through it (the row's own column is NULL).
   */
  const alertsFor = async (leadId: string) =>
    (await db.spiderAlert.findMany({ where: { lead_id: leadId }, orderBy: { alerted_at: 'asc' }, include: { recipient_set: true } })).map((a) => ({
      ...a,
      recipients: a.recipient_set?.recipients ?? a.recipients,
    }));

  async function spiderNotices(leadId: string) {
    return db.notificationRecipient.findMany({
      where: { notification: { verb: 'spider.alert', object_id: leadId } },
      select: { recipient_id: true, read_at: true },
      orderBy: { recipient_id: 'asc' },
    });
  }

  // SPEC-5: the Spider pilot list (SPIDER_PILOT_ORG_IDS), restored after every test.
  const pilotEnv = env as { SPIDER_PILOT_ORG_IDS?: string };
  const pilotListBefore = pilotEnv.SPIDER_PILOT_ORG_IDS;
  afterEach(() => {
    pilotEnv.SPIDER_PILOT_ORG_IDS = pilotListBefore;
  });
  const setPilotList = (...orgIds: string[]) => {
    pilotEnv.SPIDER_PILOT_ORG_IDS = orgIds.length ? orgIds.join(',') : undefined;
  };

  const emailedTo = () => resendSend.mock.calls.map(([m]) => m.to as string).sort();
  const textedTo = () => vi.mocked(ctm.sendSms).mock.calls.map(([, m]) => m.to).sort();

  // ─── Alerting (#2622) ──────────────────────────────────────────────────────

  describe('alerting', () => {
    it('alerts an overdue lead on the next run, with no browser involved', async () => {
      const c = await company();
      await configure(c);
      const id = await lead(c, { createdAt: at(-3 * HOUR) });

      const result = await runSpiderSweep(T0);

      expect(result.ran).toBe(true);
      const [alert] = await alertsFor(id);
      expect(alert).toMatchObject({ organization_id: c.org, status: 'NEW', limit_value: 2, limit_unit: 'HOUR', recipient_ids: [c.admin.id] });
      expect(alert.entered_status_at).toEqual(at(-3 * HOUR));
      expect(await spiderNotices(id)).toEqual([{ recipient_id: c.admin.id, read_at: null }]);
      const notification = await db.notification.findFirst({ where: { verb: 'spider.alert', object_id: id } });
      expect(notification?.data).toMatchObject({
        lead_id: id, customer_name: 'Pat Payer', status: 'NEW', status_label: 'New', time_in_status: '3 hours',
      });
    });

    it('does not alert a lead that is not yet overdue', async () => {
      const c = await company();
      await configure(c);
      const id = await lead(c, { createdAt: at(-1 * HOUR) });
      await runSpiderSweep(T0);
      expect(await alertsFor(id)).toEqual([]);
    });

    it('two runs give one alert-log row, one notification, one email and one text per recipient', async () => {
      const c = await company();
      await configure(c, { channels: { email: true, text: true } });
      const id = await lead(c, { createdAt: at(-3 * HOUR) });

      await runSpiderSweep(T0);
      await runSpiderSweep(at(2 * MIN));

      expect(await alertsFor(id)).toHaveLength(1);
      expect(await spiderNotices(id)).toHaveLength(1);
      expect(emailedTo()).toEqual([c.admin.email]);
      expect(textedTo()).toEqual(['+16175550101']);
    });

    // No cap on the leads a run CHECKS. The alerts it SENDS are capped at 100 per company per run (#2991): the rest go
    // out on the next run.
    it('checks every open lead - 160 of them - with no cap, and alerts them all over two runs', async () => {
      const c = await company();
      await configure(c, { channels: { in_app: false, red_frame: false } });
      await db.lead.createMany({
        data: Array.from({ length: 160 }, (_, i) => ({
          id: randomUUID(), organization_id: c.org, customer_id: c.customer, lead_number: `B-${i}`,
          service_request: 'Fix', status: 'NEW' as const, created_at: at(-5 * HOUR),
        })),
      });
      const result = await runSpiderSweep(T0);
      expect(result.leadsChecked).toBeGreaterThanOrEqual(160);
      expect(await db.spiderAlert.count({ where: { organization_id: c.org } })).toBe(100);
      const next = await runSpiderSweep(at(2 * MIN));
      expect(next.leadsChecked).toBeGreaterThanOrEqual(160);
      expect(await db.spiderAlert.count({ where: { organization_id: c.org } })).toBe(160);
    });

    it('measures Contacted time from contacted_at, not from creation, and an edit never resets it', async () => {
      const c = await company();
      await configure(c, { limits: { CONTACTED: { enabled: true, value: 2, unit: 'HOUR' } } });
      const id = await lead(c, { status: 'CONTACTED', createdAt: at(-10 * DAY), contacted_at: at(-1 * HOUR) });

      await runSpiderSweep(T0);
      expect(await alertsFor(id)).toEqual([]);

      // Editing the lead (a note, a phone number) changes nothing Spider reads.
      await db.lead.update({ where: { id }, data: { service_request: 'Fix the door and the frame' } });
      await runSpiderSweep(at(1 * HOUR + MIN));
      const [alert] = await alertsFor(id);
      expect(alert.status).toBe('CONTACTED');
      expect(alert.entered_status_at).toEqual(at(-1 * HOUR));
    });

    // The contractor's stage rules (spiderWatcherCron.ts), decided from the lead's timestamps:
    //   New                    no contacted_at, status New, no walkthrough booked or completed - from creation
    //   Contacted              contacted_at or a status past New, no walkthrough booked or completed - from contacted_at, else creation
    //   Walkthrough Completed  last_visit_completed_at and no estimate sent - from last_visit_completed_at
    it('decides the stage and its clock from the lead timestamps, as the contractor did', async () => {
      const c = await company();
      const on = { enabled: true, value: 1, unit: 'MINUTE' as const };
      await configure(c, { limits: { NEW: on, CONTACTED: on, WALKTHROUGH_COMPLETED: on } });
      const created = at(-10 * DAY);
      const cases: { name: string; id: string; stage: string | null; from?: Date }[] = [
        { name: 'new, never contacted', id: await lead(c, { createdAt: created }), stage: 'NEW', from: created },
        { name: 'status New with contacted_at', id: await lead(c, { createdAt: created, contacted_at: at(-5 * DAY) }), stage: 'CONTACTED', from: at(-5 * DAY) },
        { name: 'status Contacted with no contacted_at', id: await lead(c, { status: 'CONTACTED', createdAt: created }), stage: 'CONTACTED', from: created },
        // His query fetched only New, Contacted and Estimate Sent leads: a walkthrough status with no
        // visit timestamps is never "contacted, walkthrough not yet scheduled".
        { name: 'status Walkthrough Scheduled, no timestamps', id: await lead(c, { status: 'WALKTHROUGH_SCHEDULED', createdAt: created }), stage: null },
        { name: 'status Walkthrough Completed, no timestamps', id: await lead(c, { status: 'WALKTHROUGH_COMPLETED', createdAt: created, contacted_at: at(-5 * DAY) }), stage: null },
        { name: 'walkthrough booked, not completed', id: await lead(c, { status: 'WALKTHROUGH_SCHEDULED', createdAt: created, contacted_at: at(-5 * DAY), walkthrough_first_booked_at: at(-4 * DAY) }), stage: null },
        // The contractor's query never fetched Walkthrough Completed leads, so this stage could not fire for them.
        { name: 'walkthrough completed', id: await lead(c, { status: 'WALKTHROUGH_COMPLETED', createdAt: created, contacted_at: at(-5 * DAY), walkthrough_first_booked_at: at(-4 * DAY), last_visit_completed_at: at(-3 * DAY) }), stage: 'WALKTHROUGH_COMPLETED', from: at(-3 * DAY) },
        { name: 'walkthrough completed, estimate sent', id: await lead(c, { status: 'ESTIMATED', createdAt: created, walkthrough_first_booked_at: at(-4 * DAY), last_visit_completed_at: at(-3 * DAY), first_estimate_sent_at: at(-2 * DAY) }), stage: null },
        // An estimate sent with no walkthrough is past Contacted: never "contacted, walkthrough not scheduled".
        { name: 'estimate sent, no walkthrough', id: await lead(c, { status: 'ESTIMATED', createdAt: created, contacted_at: at(-5 * DAY), first_estimate_sent_at: at(-2 * DAY) }), stage: null },
        { name: 'cancelled', id: await lead(c, { status: 'CONTACTED', createdAt: created, cancelled_at: at(-1 * DAY) }), stage: null },
        { name: 'won', id: await lead(c, { status: 'WON', createdAt: created, won_at: at(-1 * DAY) }), stage: null },
        { name: 'lost', id: await lead(c, { status: 'LOST', createdAt: created, lost_at: at(-1 * DAY) }), stage: null },
      ];

      await runSpiderSweep(T0);

      for (const k of cases) {
        const alerts = await alertsFor(k.id);
        if (k.stage === null) {
          expect(alerts, k.name).toEqual([]);
        } else {
          expect(alerts.map((a) => a.status), k.name).toEqual([k.stage]);
          expect(alerts[0]!.entered_status_at, k.name).toEqual(k.from);
        }
      }
    });

    // #2794: no clock clamp. Time in the stage counts from when the lead entered it, whenever Spider
    // was switched on; the starting summary (below) is what keeps switching on from flooding.
    it('counts from when the lead entered its stage, not from when Spider was switched on', async () => {
      const c = await company();
      await configure(c, { activatedAt: at(-1 * HOUR), limits: { NEW: { enabled: true, value: 1, unit: 'DAY' } } });
      const id = await lead(c, { createdAt: at(-10 * DAY) });

      await runSpiderSweep(T0);
      const [alert] = await alertsFor(id);
      expect(alert.kind).toBe('ALERTED');
      expect(alert.entered_status_at).toEqual(at(-10 * DAY));
      // counted_from only names the switched-on period in the claim key (D5).
      expect(alert.counted_from).toEqual(at(-1 * HOUR));
    });

    it('a lead 29 days into a 30-day limit alerts the day it crosses, not a full limit after Spider was switched on', async () => {
      const c = await company();
      await configure(c, { activatedAt: at(-1 * HOUR), limits: { NEW: { enabled: true, value: 30, unit: 'DAY' } } });
      const id = await lead(c, { createdAt: at(-29 * DAY) });
      await runSpiderSweep(T0);
      expect(await alertsFor(id)).toEqual([]);
      await runSpiderSweep(at(DAY + MIN));
      expect(await alertsFor(id)).toHaveLength(1);
    });

    it('editing a limit after an alert does not alert the same status visit again', async () => {
      const c = await company();
      await configure(c);
      const id = await lead(c, { createdAt: at(-3 * HOUR) });
      await runSpiderSweep(T0);
      await configure(c, { limits: { NEW: { enabled: true, value: 1, unit: 'MINUTE' } } });
      await runSpiderSweep(at(2 * MIN));
      expect(await alertsFor(id)).toHaveLength(1);
      expect(await spiderNotices(id)).toHaveLength(1);
    });

    it('never alerts Won or Lost leads, or a status that is switched off', async () => {
      const c = await company();
      await configure(c, { limits: { NEW: { enabled: true, value: 1, unit: 'MINUTE' }, CONTACTED: { enabled: false, value: 1, unit: 'MINUTE' } } });
      const closed = await Promise.all((['WON', 'LOST'] as const).map((status) => lead(c, { status })));
      const contacted = await lead(c, { status: 'CONTACTED' });
      await runSpiderSweep(T0);
      for (const id of [...closed, contacted]) expect(await alertsFor(id)).toEqual([]);
    });

    // Ran, 14 Oct: Spider may be switched on before it is set up. Until a status is switched on
    // it watches nothing: no alert, no notice, no email and no text on any lead.
    it('an on Spider with no status switched on alerts nothing on any channel, until a status is switched on', async () => {
      const c = await company();
      // Its own phone, so its texts are told apart from every other test company's Admin.
      await db.user.update({ where: { id: c.admin.id }, data: { phone: '+16175550177' } });
      await configure(c, { limits: ALL_OFF, channels: { in_app: true, email: true, text: true } });
      const ids = await Promise.all(
        (['NEW', 'CONTACTED', 'WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED', 'ESTIMATED'] as const).map((status) =>
          lead(c, { status, createdAt: at(-90 * DAY) }),
        ),
      );

      expect((await runSpiderSweep(T0)).ran).toBe(true);
      for (const id of ids) expect(await alertsFor(id)).toEqual([]);
      expect(await db.notification.count({ where: { verb: 'spider.alert', object_id: { in: ids } } })).toBe(0);
      expect(emailedTo()).not.toContain(c.admin.email);
      expect(textedTo()).not.toContain('+16175550177');

      // The same company with one status switched on alerts that status, so the run above was a
      // real one that found nothing to watch.
      await configure(c, { limits: { ...ALL_OFF, NEW: { enabled: true, value: 1, unit: 'MINUTE' } }, channels: { in_app: true, email: true, text: true } });
      await runSpiderSweep(at(2 * MIN));
      expect(await alertsFor(ids[0]!)).toHaveLength(1);
      expect(emailedTo()).toContain(c.admin.email);
      expect(textedTo()).toContain('+16175550177');
    });

    it('an excluded lead never alerts; every other open lead does (#3434)', async () => {
      const c = await company();
      const watched = await lead(c);
      const unwatched = await lead(c);
      await configure(c, { excluded: [unwatched] });
      await runSpiderSweep(T0);
      expect(await alertsFor(watched)).toHaveLength(1);
      expect(await alertsFor(unwatched)).toEqual([]);
    });

    it('losing the feature, losing the demo status, or switching Spider off stops alerts', async () => {
      const noFeature = await company({ overrides: { spider: false } });
      const belowScale = await company({ plan: 'PRO' });
      const notDemo = await company({ demo: false });
      const off = await company();
      for (const c of [noFeature, belowScale, notDemo]) await configure(c);
      await configure(off, { active: false });
      const ids = await Promise.all([noFeature, belowScale, notDemo, off].map((c) => lead(c)));
      await runSpiderSweep(T0);
      for (const id of ids) expect(await alertsFor(id)).toEqual([]);
      expect(await db.notification.count({ where: { verb: 'spider.alert', object_id: { in: ids } } })).toBe(0);
    });

    // SPEC-5: demo companies plus the companies on the Spider pilot list, the feature still required.
    it('a listed non-demo company alerts like a demo company', async () => {
      const c = await company({ demo: false });
      await configure(c);
      const id = await lead(c);
      const unlisted = await runSpiderSweep(at(-MIN));
      expect(await alertsFor(id)).toEqual([]);

      setPilotList(c.org);
      const result = await runSpiderSweep(T0);

      expect(await alertsFor(id)).toHaveLength(1);
      expect(await db.notification.count({ where: { verb: 'spider.alert', object_id: id } })).toBe(1);
      expect(await spiderNotices(id)).toEqual([{ recipient_id: c.admin.id, read_at: null }]);
      expect(result.companies).toBe(unlisted.companies + 1);
    });

    it('a listed company without the feature gets no alerts', async () => {
      const belowScale = await company({ demo: false, plan: 'PRO' });
      const switchedOff = await company({ demo: false, overrides: { spider: false } });
      for (const c of [belowScale, switchedOff]) await configure(c);
      const ids = [await lead(belowScale), await lead(switchedOff)];
      setPilotList(belowScale.org, switchedOff.org);
      await runSpiderSweep(T0);
      for (const id of ids) expect(await alertsFor(id)).toEqual([]);
      expect(await db.notification.count({ where: { verb: 'spider.alert', object_id: { in: ids } } })).toBe(0);
    });

    it('an unlisted non-demo company stays out while another is listed', async () => {
      const listed = await company({ demo: false });
      const unlisted = await company({ demo: false });
      await configure(listed);
      await configure(unlisted);
      const [listedLead, unlistedLead] = [await lead(listed), await lead(unlisted)];
      setPilotList(listed.org);
      await runSpiderSweep(T0);
      expect(await alertsFor(listedLead)).toHaveLength(1);
      expect(await alertsFor(unlistedLead)).toEqual([]);
      expect(await db.notification.count({ where: { verb: 'spider.alert', object_id: unlistedLead } })).toBe(0);
    });

    it("keeps companies apart, and one company's failure does not stop another's", async () => {
      const a = await company();
      const b = await company();
      await configure(a);
      await configure(b);
      const aLead = await lead(a);
      const bLead = await lead(b);

      const realFind = db.spiderSettings.findUnique.bind(db.spiderSettings);
      const spy = vi.spyOn(db.spiderSettings, 'findUnique').mockImplementation(((args: { where: { organization_id?: string } }) => {
        if (args.where.organization_id === a.org) return Promise.reject(new Error('company A broke'));
        return realFind(args as never);
      }) as never);
      try {
        await runSpiderSweep(T0);
      } finally {
        spy.mockRestore();
      }
      expect(await alertsFor(aLead)).toEqual([]);
      const [bAlert] = await alertsFor(bLead);
      expect(bAlert.recipient_ids).toEqual([b.admin.id]);
      expect(vi.mocked(logger.error).mock.calls.map((c) => String(c[0])).join('\n')).toContain(`org ${a.org}`);

      // Company A's next run alerts only A's lead, only to A's people.
      await runSpiderSweep(at(2 * MIN));
      const [aAlert] = await alertsFor(aLead);
      expect(aAlert.organization_id).toBe(a.org);
      expect((await spiderNotices(aLead)).map((n) => n.recipient_id)).toEqual([a.admin.id]);
      expect(await alertsFor(bLead)).toHaveLength(1);
    });

    // D4 and Ran's ruling of 2026-11-04 ("Next run"): a company switched off before a run sends nothing; a switch-off
    // made while a run is sending takes effect from the next run (at most about 45 s, up to 100 alerts, #2991). The
    // run's records are ended at once by its end step's switch check, so no card stays open in a switched-off company.
    describe('switched off during a run', () => {
      async function twoOverdueLeads() {
        const c = await company();
        const dispatcher = await person(c.org, 'DISPATCHER', { phone: '+16175550188' });
        await configure(c, {
          channels: { in_app: true, red_frame: true, email: true, text: true },
          recipients: { roles: ['ADMIN', 'DISPATCHER'] },
        });
        const leads = [await lead(c, { createdAt: at(-3 * HOUR) }), await lead(c, { createdAt: at(-4 * HOUR) })];
        return { c, dispatcher, leads };
      }

      /** The first email of the run changes the stored switch, as an Admin's click landing then would. */
      function onFirstEmail(change: () => Promise<unknown>) {
        let first = true;
        resendSend.mockImplementation(async () => {
          if (first) {
            first = false;
            await change();
          }
          return { data: { id: 'msg_1' }, error: null };
        });
      }

      const leadOfEmail = (leads: string[]) => resendSend.mock.calls.map(([m]) => leads.find((id) => String(m.text).includes(id)));

      /** Both leads went out in full to both people, and every one of their cards is already ended. */
      async function expectSentInFullAndEnded(leads: string[], people: string[]) {
        for (const id of leads) {
          const [alert] = await alertsFor(id);
          expect(alert, id).toBeDefined();
          expect((alert!.delivery as { email: { outcome: string } }).email.outcome).toBe('Email sent');
          expect((alert!.delivery as { text: { outcome: string } }).text.outcome).toBe('Text message sent');
          const notices = await spiderNotices(id);
          expect(notices.map((n) => n.recipient_id)).toEqual([...people].sort());
          expect(notices.every((n) => n.read_at !== null)).toBe(true);
        }
        expect(leadOfEmail(leads).filter(Boolean)).toHaveLength(leads.length * people.length);
      }

      it("takes effect from the next run: the run's claimed alerts go out in full, their cards end at once, the next run sends nothing", async () => {
        const { c, dispatcher, leads } = await twoOverdueLeads();
        onFirstEmail(() => db.spiderSettings.update({ where: { organization_id: c.org }, data: { is_active: false } }));

        await runSpiderSweep(T0);

        await expectSentInFullAndEnded(leads, [c.admin.id, dispatcher.id]);

        // The next run: Spider is off, so nothing more goes out and nothing is claimed.
        resendSend.mockClear();
        vi.mocked(ctm.sendSms).mockClear();
        const another = await lead(c, { createdAt: at(-5 * HOUR) });
        await runSpiderSweep(at(2 * MIN));
        expect(leadOfEmail([...leads, another]).filter(Boolean)).toEqual([]);
        expect(await alertsFor(another)).toEqual([]);
      });

      it('a quick off-then-on during a run: the run still sends its claimed alerts, and ends their cards (a new switched-on period)', async () => {
        const { c, dispatcher, leads } = await twoOverdueLeads();
        onFirstEmail(async () => {
          await db.spiderSettings.update({ where: { organization_id: c.org }, data: { is_active: false } });
          await db.spiderSettings.update({ where: { organization_id: c.org }, data: { is_active: true, activated_at: new Date() } });
        });

        await runSpiderSweep(T0);

        await expectSentInFullAndEnded(leads, [c.admin.id, dispatcher.id]);
      });
    });

    it('a failed alert-log write sends nothing on any channel and is logged', async () => {
      const c = await company();
      await configure(c, { channels: { email: true, text: true } });
      const id = await lead(c);
      // The sweep runs every company left by earlier tests, so fail only the claims that include this
      // lead (a run's claims go in with one insert, #2990); a bare mockRejectedValueOnce lands on
      // whichever company is swept first.
      const realBulk = db.spiderAlert.createManyAndReturn.bind(db.spiderAlert);
      const spy = vi.spyOn(db.spiderAlert, 'createManyAndReturn').mockImplementation(((args: { data: { lead_id?: string }[] }) =>
        args.data.some((r) => r.lead_id === id) ? Promise.reject(new Error('disk full')) : realBulk(args as never)) as never);
      try {
        await runSpiderSweep(T0);
      } finally {
        spy.mockRestore();
      }
      expect(await alertsFor(id)).toEqual([]);
      expect(await spiderNotices(id)).toEqual([]);
      expect(resendSend).not.toHaveBeenCalled();
      expect(ctm.sendSms).not.toHaveBeenCalled();
      expect(vi.mocked(logger.error).mock.calls.map((x) => String(x[0])).join('\n')).toContain('nothing sent');
    });
  });

  // ─── Recipients ────────────────────────────────────────────────────────────

  describe('recipients', () => {
    it('are the configured roles, users and owner, once each, and only people who can sign in', async () => {
      const c = await company();
      const dispatcher = await person(c.org, 'DISPATCHER');
      const owner = await person(c.org, 'SALES');
      const picked = await person(c.org, 'TECHNICIAN');
      await person(c.org, 'DISPATCHER', { active: false });
      await person(c.org, 'DISPATCHER', { login: false });
      const id = await lead(c, { owner: owner.id });
      // The owner is also picked by id, and a dispatcher both by role and by id: each still once.
      await configure(c, { recipients: { roles: ['DISPATCHER'], user_ids: [owner.id, dispatcher.id, picked.id], lead_owner: true } });

      await runSpiderSweep(T0);

      const expected = [dispatcher.id, owner.id].sort();
      const [alert] = await alertsFor(id);
      // The picked technician cannot open this lead (not on it), so no channel tells them about it.
      expect([...alert.recipient_ids].sort()).toEqual(expected);
      expect((await spiderNotices(id)).map((n) => n.recipient_id)).toEqual(expected);
    });

    it("reach the lead's owner when only the owner is configured, and the Admins, claimed once, for an unowned lead", async () => {
      const c = await company();
      const owner = await person(c.org, 'SALES');
      await configure(c, { recipients: { roles: [], user_ids: [], lead_owner: true } });
      const owned = await lead(c, { owner: owner.id });
      const unowned = await lead(c);
      await runSpiderSweep(T0);
      expect((await alertsFor(owned))[0].recipient_ids).toEqual([owner.id]);
      // The owner reaches nobody on an unowned lead, so the Admins get the alert.
      expect((await alertsFor(unowned)).map((a) => a.recipient_ids)).toEqual([[c.admin.id]]);
      expect((await spiderNotices(unowned)).map((n) => n.recipient_id)).toEqual([c.admin.id]);

      // That status visit is claimed: giving the lead an owner later does not alert it again.
      await db.lead.update({ where: { id: unowned }, data: { commission_owner_id: owner.id } });
      await runSpiderSweep(at(2 * MIN));
      expect(await alertsFor(unowned)).toHaveLength(1);
    });

    it('fall back to the Admins on every channel, claimed once, when the configured roles reach nobody', async () => {
      const c = await company();
      const secondAdmin = await person(c.org, 'ADMIN', { phone: '+16175550102' });
      await person(c.org, 'ADMIN', { active: false, phone: '+16175550103' });
      await person(c.org, 'SALES', { phone: '+16175550104' });
      await configure(c, {
        recipients: { roles: ['TECHNICIAN'], user_ids: [], lead_owner: false },
        channels: { in_app: true, email: true, text: true },
      });
      const id = await lead(c);

      await runSpiderSweep(T0);
      await runSpiderSweep(at(2 * MIN));

      const admins = [c.admin.id, secondAdmin.id].sort();
      const alerts = await alertsFor(id);
      expect(alerts).toHaveLength(1);
      expect([...alerts[0].recipient_ids].sort()).toEqual(admins);
      expect((await spiderNotices(id)).map((n) => n.recipient_id)).toEqual(admins);
      expect(emailedTo()).toEqual([c.admin.email, secondAdmin.email].sort());
      expect(textedTo()).toEqual(['+16175550101', '+16175550102']);
    });

    it('fall back to the Admins when the chosen people cannot open the lead', async () => {
      const c = await company();
      const picked = await person(c.org, 'TECHNICIAN');
      await configure(c, { recipients: { roles: [], user_ids: [picked.id], lead_owner: false } });
      const id = await lead(c);
      await runSpiderSweep(T0);
      // The technician is not on this lead, so cannot open it: the Admin is alerted instead.
      expect((await alertsFor(id)).map((a) => a.recipient_ids)).toEqual([[c.admin.id]]);
    });

    it('claim nothing when nobody at all - not even an Admin - can be reached, and alert once someone can', async () => {
      const c = await company();
      await db.user.update({ where: { id: c.admin.id }, data: { is_active: false } });
      await configure(c, { recipients: { roles: ['TECHNICIAN'], user_ids: [], lead_owner: false }, channels: { email: true } });
      const id = await lead(c);
      await runSpiderSweep(T0);
      expect(await alertsFor(id)).toEqual([]);
      expect(resendSend).not.toHaveBeenCalled();

      // Nothing was claimed, so once the Admin can sign in again the same status visit alerts.
      await db.user.update({ where: { id: c.admin.id }, data: { is_active: true } });
      await runSpiderSweep(at(2 * MIN));
      expect((await alertsFor(id)).map((a) => a.recipient_ids)).toEqual([[c.admin.id]]);
    });

    it("fall back to the company's Admins when none are configured", async () => {
      const c = await company();
      const secondAdmin = await person(c.org, 'ADMIN');
      await person(c.org, 'SALES');
      await configure(c, { recipients: { roles: [], user_ids: [], lead_owner: false } });
      const id = await lead(c);
      await runSpiderSweep(T0);
      expect([...(await alertsFor(id))[0].recipient_ids].sort()).toEqual([c.admin.id, secondAdmin.id].sort());
    });

    it('reach the same people on every channel, skip staff with no phone for texts and record it', async () => {
      const c = await company();
      const withPhone = await person(c.org, 'DISPATCHER', { phone: '(617) 555-0142' });
      const noPhone = await person(c.org, 'DISPATCHER', { phone: null });
      await configure(c, { recipients: { roles: ['DISPATCHER'] }, channels: { in_app: true, email: true, text: true } });
      const id = await lead(c);

      await runSpiderSweep(T0);

      const [alert] = await alertsFor(id);
      const people = [withPhone.id, noPhone.id].sort();
      expect([...alert.recipient_ids].sort()).toEqual(people);
      expect((await spiderNotices(id)).map((n) => n.recipient_id)).toEqual(people);
      expect(emailedTo()).toEqual([withPhone.email, noPhone.email].sort());
      expect(textedTo()).toEqual(['+16175550142']);

      const delivery = alert.delivery as { text: { outcome: string; recipients: { user_id: string; outcome: string }[] } };
      expect(delivery.text.recipients).toEqual(expect.arrayContaining([
        { user_id: withPhone.id, outcome: 'Text message sent' },
        { user_id: noPhone.id, outcome: 'Text skipped: no phone number on profile' },
      ]));
      expect(alert.texts_sent).toBe(1);
    });
  });

  // ─── Ending alerts (#2623) ─────────────────────────────────────────────────

  describe('ending alerts', () => {
    it('marks the alert read for every recipient once the lead moves on, keeps the log row, and leaves other verbs alone', async () => {
      const c = await company();
      const dispatcher = await person(c.org, 'DISPATCHER');
      await configure(c, {
        limits: { CONTACTED: { enabled: true, value: 2, unit: 'HOUR' } },
        recipients: { roles: ['ADMIN', 'DISPATCHER'] },
      });
      const id = await lead(c, { status: 'CONTACTED', createdAt: at(-10 * DAY), contacted_at: at(-3 * HOUR) });
      const other = await db.notification.create({
        data: { organization_id: c.org, verb: 'lead.assigned', category: 'LEAD', priority: 'INTERRUPT', object_type: 'LEAD', object_id: id, title: 'x' },
      });
      await db.notificationRecipient.create({ data: { notification_id: other.id, organization_id: c.org, recipient_id: dispatcher.id, priority: 'INTERRUPT' } });

      await runSpiderSweep(T0);
      expect((await spiderNotices(id)).every((n) => n.read_at === null)).toBe(true);

      // Still in the alerted visit: stays unread.
      await runSpiderSweep(at(2 * MIN));
      expect((await spiderNotices(id)).every((n) => n.read_at === null)).toBe(true);

      await move(id, 'WALKTHROUGH_SCHEDULED', { walkthrough_first_booked_at: at(5 * MIN) });
      await runSpiderSweep(at(6 * MIN));

      const notices = await spiderNotices(id);
      expect(notices).toHaveLength(2);
      expect(notices.every((n) => n.read_at !== null)).toBe(true);
      expect(await alertsFor(id)).toHaveLength(1);
      const untouched = await db.notificationRecipient.findFirst({ where: { notification_id: other.id } });
      expect(untouched?.read_at).toBeNull();
    });

    // SPEC-4 §7.4: a communication filed onto the lead afterwards (attached, or a logged entry moved
    // onto it) is reaching out to it, so the New alert ends exactly as for a contact logged on the
    // lead. A move that also flips the entry from inbound to outbound is not (D6), and stays alerted.
    it('an outbound communication linked to the lead ends its New alert at the next run', async () => {
      const c = await company();
      await configure(c);
      const linked = await lead(c);
      const flipped = await lead(c);
      await runSpiderSweep(T0);
      expect(await spiderNotices(linked)).toHaveLength(1);
      expect(await spiderNotices(flipped)).toHaveLength(1);

      // A logged outbound entry moved onto each lead from another lead.
      const elsewhere = randomUUID();
      const move = (leadId: string, directionBefore: string) =>
        recordLeadContactOnLink({ client: db }, {
          source: 'log', channel: 'call', orgId: c.org,
          leadIdBefore: elsewhere, leadIdAfter: leadId,
          directionBefore, directionAfter: 'OUT',
          automated: false, at: at(MIN), actorId: c.admin.id,
        });
      await move(linked, 'OUT');
      await move(flipped, 'IN');

      await runSpiderSweep(at(2 * MIN));

      expect((await spiderNotices(linked)).every((n) => n.read_at !== null)).toBe(true);
      expect((await spiderNotices(flipped)).every((n) => n.read_at === null)).toBe(true);
      expect(await alertsFor(linked)).toHaveLength(1);
    });

    it('ends the alert when the lead is won or lost', async () => {
      const c = await company();
      await configure(c);
      const ids = [await lead(c), await lead(c)];
      await runSpiderSweep(T0);
      await move(ids[0]!, 'WON', { won_at: at(MIN) });
      await move(ids[1]!, 'LOST', { lost_at: at(MIN) });
      await runSpiderSweep(at(2 * MIN));
      for (const id of ids) expect((await spiderNotices(id))[0].read_at).not.toBeNull();
    });

    // A later completed visit re-anchors last_visit_completed_at: a new Walkthrough Completed visit.
    it('a lead that enters a stage again is watched again and alerts once more for the new visit', async () => {
      const c = await company();
      await configure(c, { limits: { WALKTHROUGH_COMPLETED: { enabled: true, value: 2, unit: 'HOUR' } } });
      const id = await lead(c, {
        status: 'WALKTHROUGH_COMPLETED', createdAt: at(-10 * DAY), contacted_at: at(-9 * DAY),
        walkthrough_first_booked_at: at(-8 * DAY), last_visit_completed_at: at(-3 * HOUR),
      });
      await runSpiderSweep(T0);

      await move(id, 'WALKTHROUGH_COMPLETED', { last_visit_completed_at: at(2 * HOUR) });
      await runSpiderSweep(at(3 * HOUR));
      expect(await alertsFor(id)).toHaveLength(1);

      await runSpiderSweep(at(4 * HOUR + MIN));
      const alerts = await alertsFor(id);
      expect(alerts).toHaveLength(2);
      expect(alerts.map((a) => a.entered_status_at)).toEqual([at(-3 * HOUR), at(2 * HOUR)]);
      const notices = await spiderNotices(id);
      expect(notices.filter((n) => n.read_at === null)).toHaveLength(1);
    });

    it('still ends alerts after Spider is switched off or the company loses the gate', async () => {
      const off = await company();
      const revoked = await company();
      await configure(off);
      await configure(revoked);
      const [a, b] = [await lead(off), await lead(revoked)];
      await runSpiderSweep(T0);
      await configure(off, { active: false });
      await db.organization.update({ where: { id: revoked.org }, data: { is_demo: false } });
      await move(a, 'CONTACTED', { contacted_at: at(MIN) });
      await move(b, 'CONTACTED', { contacted_at: at(MIN) });
      await runSpiderSweep(at(2 * MIN));
      expect((await spiderNotices(a))[0].read_at).not.toBeNull();
      expect((await spiderNotices(b))[0].read_at).not.toBeNull();
    });

    // D4: an off company has no open Spider alert. Whatever slipped past the switch's own clear
    // (a failed clear, or a company already off when this shipped) is ended by the next run.
    it('a company that is off has its open alerts ended by the next run', async () => {
      const c = await company();
      await configure(c, { channels: { in_app: true, red_frame: true } });
      const id = await lead(c);
      await runSpiderSweep(T0);
      const [before] = await alertsFor(id);
      expect((await spiderNotices(id))[0].read_at).toBeNull();

      // Off straight in the database, past the switch; the lead stays overdue in the same stage.
      await db.spiderSettings.update({ where: { organization_id: c.org }, data: { is_active: false } });
      const result = await runSpiderSweep(at(2 * MIN));

      expect((await spiderNotices(id)).every((n) => n.read_at !== null)).toBe(true);
      expect(await alertsFor(id)).toEqual([before]);
      expect(result.alertsEnded).toBeGreaterThanOrEqual(1);
    });

    // SPEC-5 R10 (Ran, decision 11.2): losing access behaves like Spider off - the next run clears the
    // company's open alerts for every person, raises nothing new, and keeps History.
    it('a company removed from the pilot list has its open alerts cleared', async () => {
      const c = await company({ demo: false });
      const dispatcher = await person(c.org, 'DISPATCHER');
      await configure(c, { recipients: { roles: ['ADMIN', 'DISPATCHER'] } });
      const movesOn = await lead(c);
      const stuck = await lead(c);
      setPilotList(c.org);
      await runSpiderSweep(T0);
      const historyBefore = await db.spiderAlert.findMany({ where: { organization_id: c.org }, orderBy: { lead_id: 'asc' } });
      expect(historyBefore).toHaveLength(2);
      for (const id of [movesOn, stuck]) {
        expect((await spiderNotices(id)).map((n) => n.recipient_id).sort()).toEqual([c.admin.id, dispatcher.id].sort());
      }

      setPilotList();
      await move(movesOn, 'CONTACTED', { contacted_at: at(MIN) });
      const another = await lead(c);
      const result = await runSpiderSweep(at(2 * MIN));

      for (const id of [movesOn, stuck]) {
        const notices = await spiderNotices(id);
        expect(notices).toHaveLength(2);
        expect(notices.every((n) => n.read_at !== null)).toBe(true);
      }
      expect(await alertsFor(another)).toEqual([]);
      expect(await db.spiderAlert.findMany({ where: { organization_id: c.org }, orderBy: { lead_id: 'asc' } })).toEqual(historyBefore);
      expect(result.alertsEnded).toBeGreaterThanOrEqual(4);
    });

    it.each([
      ['loses the Spider feature', { feature_overrides: { spider: false } }],
      ['loses its demo status', { is_demo: false }],
    ])('a demo company that %s has its open alerts cleared the same way', async (_label, data) => {
      const c = await company();
      await configure(c);
      const stuck = await lead(c);
      await runSpiderSweep(T0);
      const historyBefore = await alertsFor(stuck);
      expect((await spiderNotices(stuck))[0].read_at).toBeNull();

      await db.organization.update({ where: { id: c.org }, data });
      const another = await lead(c);
      await runSpiderSweep(at(2 * MIN));

      expect((await spiderNotices(stuck)).every((n) => n.read_at !== null)).toBe(true);
      expect(await alertsFor(another)).toEqual([]);
      expect(await alertsFor(stuck)).toEqual(historyBefore);
    });

    it("losing access never clears another company's alerts", async () => {
      const a = await company({ demo: false });
      const b = await company();
      await configure(a);
      await configure(b);
      const [aLead, bLead] = [await lead(a), await lead(b)];
      setPilotList(a.org);
      await runSpiderSweep(T0);
      expect((await spiderNotices(aLead))[0].read_at).toBeNull();

      setPilotList();
      await runSpiderSweep(at(2 * MIN));
      expect((await spiderNotices(aLead))[0].read_at).not.toBeNull();
      expect((await spiderNotices(bLead))[0].read_at).toBeNull();
    });

    it("never ends another company's alerts when one company is off", async () => {
      const a = await company();
      const b = await company();
      await configure(a);
      await configure(b);
      const aLead = await lead(a);
      const bLead = await lead(b);
      await runSpiderSweep(T0);
      await db.spiderSettings.update({ where: { organization_id: a.org }, data: { is_active: false } });
      await runSpiderSweep(at(2 * MIN));
      expect((await spiderNotices(aLead))[0].read_at).not.toBeNull();
      expect((await spiderNotices(bLead))[0].read_at).toBeNull();
    });

    it("never marks another company's alerts read", async () => {
      const a = await company();
      const b = await company();
      await configure(a);
      await configure(b);
      const aLead = await lead(a);
      const bLead = await lead(b);
      await runSpiderSweep(T0);
      // B's lead moves on, but only through A's eyes would that matter; A's alert must stay unread.
      await move(bLead, 'CONTACTED', { contacted_at: at(MIN) });
      await runSpiderSweep(at(2 * MIN));
      expect((await spiderNotices(aLead))[0].read_at).toBeNull();
      expect((await spiderNotices(bLead))[0].read_at).not.toBeNull();
    });

    // #3450 (Ran, 11 Nov): an open alert follows the settings saved now. The end step marks read the records of a lead
    // that is excluded, whose stage's limit is off, or that a longer limit no longer finds past it; a shorter limit or
    // more recipients ends nothing. In-app alerts and red-frame-only records alike.
    describe('when the settings change (#3450)', () => {
      const NEW_1D = { NEW: { enabled: true, value: 1, unit: 'DAY' as const } };
      const lanes = [
        { name: 'in-app alerts', verb: 'spider.alert', channels: { in_app: true, red_frame: true } },
        { name: 'red-frame-only records', verb: 'spider.frame', channels: { in_app: false, red_frame: true } },
      ];
      const unreadOf = async (leadId: string, verb: string) => {
        const rows = await db.notificationRecipient.findMany({ where: { notification: { verb, object_id: leadId } }, select: { read_at: true } });
        expect(rows.length, `records for ${leadId}`).toBeGreaterThan(0);
        return rows.every((r) => r.read_at === null);
      };

      for (const lane of lanes) {
        describe(lane.name, () => {
          it('excluding a lead ends its records at the next run, and only its', async () => {
            const c = await company();
            await configure(c, { channels: lane.channels });
            const x = await lead(c, { createdAt: at(-3 * HOUR) });
            const y = await lead(c, { createdAt: at(-3 * HOUR) });
            await runSpiderSweep(T0);
            expect(await unreadOf(x, lane.verb)).toBe(true);

            await configure(c, { channels: lane.channels, excluded: [x] });
            await runSpiderSweep(at(2 * MIN));
            expect(await unreadOf(x, lane.verb)).toBe(false);
            expect(await unreadOf(y, lane.verb)).toBe(true);
          });

          it("switching a stage's limit off ends every open record of that stage, and no other stage's", async () => {
            const c = await company();
            const limits = { NEW: { enabled: true, value: 2, unit: 'HOUR' as const }, CONTACTED: { enabled: true, value: 2, unit: 'HOUR' as const } };
            await configure(c, { channels: lane.channels, limits });
            const x = await lead(c, { createdAt: at(-3 * HOUR) });
            const y = await lead(c, { createdAt: at(-3 * HOUR) });
            const contacted = await lead(c, { status: 'CONTACTED', createdAt: at(-10 * DAY), contacted_at: at(-3 * HOUR) });
            await runSpiderSweep(T0);

            await configure(c, { channels: lane.channels, limits: { ...limits, NEW: { enabled: false, value: 2, unit: 'HOUR' } } });
            await runSpiderSweep(at(2 * MIN));
            expect(await unreadOf(x, lane.verb)).toBe(false);
            expect(await unreadOf(y, lane.verb)).toBe(false);
            expect(await unreadOf(contacted, lane.verb)).toBe(true);
          });

          it('a longer limit ends the records of a lead no longer past it, and keeps one still past it', async () => {
            const c = await company();
            await configure(c, { channels: lane.channels });
            const notPast = await lead(c, { createdAt: at(-3 * HOUR) });
            const stillPast = await lead(c, { createdAt: at(-30 * HOUR) });
            await runSpiderSweep(T0);

            await configure(c, { channels: lane.channels, limits: NEW_1D });
            await runSpiderSweep(at(2 * MIN));
            expect(await unreadOf(notPast, lane.verb)).toBe(false);
            expect(await unreadOf(stillPast, lane.verb)).toBe(true);
          });

          // Ran, 11 Nov: "No, once is enough." A cleared alert is not alerted again in the same stage visit and switched-on
          // period, however the lead becomes alertable again: the claim key (lead, stage, entered instant, counted-from) is
          // still taken. One alert-log row, one record, and it stays read.
          describe('once is enough: a cleared alert is not raised again in the same stay and period', () => {
            const onceOnly = async (x: string) => {
              expect(await alertsFor(x)).toHaveLength(1);
              expect(await db.notification.count({ where: { object_id: x, verb: { in: ['spider.alert', 'spider.frame'] } } })).toBe(1);
              expect(await unreadOf(x, lane.verb)).toBe(false);
            };

            it('excluded, then included again (the Save widens the scope)', async () => {
              const c = await company();
              await configure(c, { channels: lane.channels });
              const x = await lead(c, { createdAt: at(-3 * HOUR) });
              await runSpiderSweep(T0);
              expect(await alertsFor(x)).toHaveLength(1);

              await configure(c, { channels: lane.channels, excluded: [x] });
              await runSpiderSweep(at(2 * MIN));
              expect(await unreadOf(x, lane.verb)).toBe(false);

              // Included again, with the starting trigger a real Save records, then past its quiet period.
              await configure(c, { channels: lane.channels, trigger: at(3 * MIN), triggerKind: 'SCOPE_WIDENED' });
              await runSpiderSweep(at(20 * MIN));
              await runSpiderSweep(at(25 * MIN));
              await onceOnly(x);
            });

            it("the stage's limit switched off, then on again (the Save adds a stage)", async () => {
              const c = await company();
              await configure(c, { channels: lane.channels });
              const x = await lead(c, { createdAt: at(-3 * HOUR) });
              await runSpiderSweep(T0);

              await configure(c, { channels: lane.channels, limits: { NEW: { enabled: false, value: 2, unit: 'HOUR' } } });
              await runSpiderSweep(at(2 * MIN));
              expect(await unreadOf(x, lane.verb)).toBe(false);

              await configure(c, { channels: lane.channels, trigger: at(3 * MIN), triggerKind: 'STAGE_ADDED' });
              await runSpiderSweep(at(20 * MIN));
              await runSpiderSweep(at(25 * MIN));
              await onceOnly(x);
            });

            it('the limit lengthened past the lead, then the lead crosses the longer limit', async () => {
              const c = await company();
              await configure(c, { channels: lane.channels });
              const x = await lead(c, { createdAt: at(-3 * HOUR) });
              await runSpiderSweep(T0);

              // 3 h 2 min in, a 4-hour limit: no longer past it.
              await configure(c, { channels: lane.channels, limits: { NEW: { enabled: true, value: 4, unit: 'HOUR' } } });
              await runSpiderSweep(at(2 * MIN));
              expect(await unreadOf(x, lane.verb)).toBe(false);

              // 4 h 10 min in: past the longer limit, in the same stay and period.
              await runSpiderSweep(at(70 * MIN));
              await runSpiderSweep(at(75 * MIN));
              await onceOnly(x);
            });
          });

          it('a shorter limit or more recipients ends nothing', async () => {
            const c = await company();
            await person(c.org, 'DISPATCHER');
            await configure(c, { channels: lane.channels });
            const x = await lead(c, { createdAt: at(-3 * HOUR) });
            await runSpiderSweep(T0);

            await configure(c, { channels: lane.channels, limits: { NEW: { enabled: true, value: 1, unit: 'HOUR' } }, recipients: { roles: ['ADMIN', 'DISPATCHER'] } });
            await runSpiderSweep(at(2 * MIN));
            expect(await unreadOf(x, lane.verb)).toBe(true);
            expect(await alertsFor(x)).toHaveLength(1);
          });
        });
      }
    });
  });

  // SPEC-4 D7 (§6.12.4, §7.4): a Contacted lead whose last outbound contact is taken away goes back
  // to New, and Spider treats that as a fresh New stay: counted from the move back (or from
  // switch-on, if later), one alert per stay. The first stay's alert stays as it was.
  describe('a lead moved back to New', () => {
    const DAY_LIMIT = { NEW: { enabled: true, value: 1, unit: 'DAY' as const } };

    /** An outbound call reaches the lead at `at`: New -> Contacted, as every contact door does. */
    const contact = (c: Company, leadId: string, when: Date) =>
      recordLeadOutboundContact({ client: db }, {
        leadId, orgId: c.org, channel: 'call', direction: 'out', automated: false, at: when, actorId: c.admin.id,
      });

    /** A person takes the lead's only outbound contact away at `when`: the lead goes back to New. */
    async function movedBack(c: Company, leadId: string, when: Date) {
      await expect(reconsiderLeadContact({ client: db }, {
        leadId, orgId: c.org, actorId: c.admin.id, entry: { source: 'call', id: randomUUID() }, now: when,
      })).resolves.toBe(true);
    }

    it('alerts again once the New limit passes from the move back, once, and leaves the first stay\'s alert as it was', async () => {
      const c = await company();
      await configure(c, { limits: DAY_LIMIT });
      const created = at(-2 * DAY);
      const id = await lead(c, { createdAt: created });
      await runSpiderSweep(T0);
      const [first] = await alertsFor(id);
      expect(first!.entered_status_at).toEqual(created);

      await contact(c, id, at(MIN));
      await runSpiderSweep(at(2 * MIN));
      expect((await spiderNotices(id)).every((n) => n.read_at !== null)).toBe(true);

      const T = at(10 * MIN);
      await movedBack(c, id, T);

      // Younger than the limit: no alert, and the first stay's alert stays ended and unchanged.
      await runSpiderSweep(at(11 * MIN));
      expect(await alertsFor(id)).toEqual([first]);
      expect((await spiderNotices(id)).every((n) => n.read_at !== null)).toBe(true);

      await runSpiderSweep(new Date(T.getTime() + DAY));
      const alerts = await alertsFor(id);
      expect(alerts).toHaveLength(2);
      expect(alerts[0]).toEqual(first);
      expect(alerts[1]).toMatchObject({ status: 'NEW', entered_status_at: T, counted_from: T });
      // The card's sentence still counts from the lead's creation (3 days), not from the stay (1 day).
      expect(alerts[1]!.in_app_message).toBe('This lead was created 3 days ago and has not yet been contacted.');
      // The pop-up card rebuilds that sentence live, so the alert carries when the lead was created; its time in the
      // stage still counts from the stay.
      const fresh = await db.notification.findFirst({
        where: { verb: 'spider.alert', object_id: id }, orderBy: { created_at: 'desc' }, select: { data: true },
      });
      expect(fresh?.data).toMatchObject({
        lead_created_at: created.toISOString(),
        stage_entered_at: T.toISOString(),
        counted_from: T.toISOString(),
        time_in_stage: '1 day',
      });
      const notices = await spiderNotices(id);
      expect(notices).toHaveLength(2);
      expect(notices.filter((n) => n.read_at === null)).toHaveLength(1);

      await runSpiderSweep(new Date(T.getTime() + DAY + 2 * MIN));
      expect(await alertsFor(id)).toHaveLength(2);
    });

    it('moved to Contacted and back between two sweeps: the first stay\'s open alert ends at the next run, and a fresh one comes after the limit', async () => {
      const c = await company();
      await configure(c, { limits: DAY_LIMIT });
      const id = await lead(c, { createdAt: at(-2 * DAY) });
      await runSpiderSweep(T0);
      expect(await spiderNotices(id)).toEqual([{ recipient_id: c.admin.id, read_at: null }]);

      await contact(c, id, at(MIN));
      const T = at(2 * MIN);
      await movedBack(c, id, T);

      await runSpiderSweep(at(3 * MIN));
      expect((await spiderNotices(id)).every((n) => n.read_at !== null)).toBe(true);
      expect(await alertsFor(id)).toHaveLength(1);

      await runSpiderSweep(new Date(T.getTime() + DAY));
      const alerts = await alertsFor(id);
      expect(alerts.map((a) => a.entered_status_at)).toEqual([at(-2 * DAY), T]);
    });

    it('an open Contacted alert ends at the next run after the move back', async () => {
      const c = await company();
      await configure(c, { limits: { ...DAY_LIMIT, CONTACTED: { enabled: true, value: 2, unit: 'HOUR' } } });
      const id = await lead(c, { createdAt: at(-10 * DAY) });
      await contact(c, id, at(-3 * HOUR));
      await runSpiderSweep(T0);
      const [contacted] = await alertsFor(id);
      expect(contacted!.status).toBe('CONTACTED');
      expect(await spiderNotices(id)).toEqual([{ recipient_id: c.admin.id, read_at: null }]);

      await movedBack(c, id, at(MIN));
      await runSpiderSweep(at(2 * MIN));

      expect((await spiderNotices(id)).every((n) => n.read_at !== null)).toBe(true);
      // The new New stay is a minute old: nothing new yet.
      expect(await alertsFor(id)).toEqual([contacted]);
    });

    // #2794: the stay counts from the move back whenever Spider was switched on; counted_from names
    // the switched-on period.
    it('switched on after the move back: the stay counts from the move back', async () => {
      const c = await company();
      const id = await lead(c, { createdAt: at(-2 * DAY) });
      await contact(c, id, at(-DAY));
      const T = at(MIN);
      await movedBack(c, id, T);
      const switchedOn = at(HOUR);
      await configure(c, { limits: DAY_LIMIT, activatedAt: switchedOn });

      await runSpiderSweep(new Date(T.getTime() + DAY - MIN));
      expect(await alertsFor(id)).toEqual([]);

      await runSpiderSweep(new Date(T.getTime() + DAY));
      const [alert] = await alertsFor(id);
      expect(alert).toMatchObject({ status: 'NEW', entered_status_at: T, counted_from: switchedOn });
    });
  });

  // ─── Switched back on (SPEC-3, D5) ─────────────────────────────────────────

  // Ran, 20 Oct (D5): after Spider is switched back on, a lead still stuck in a stage is reported
  // again: once per stage visit per switched-on period. Ran, 27 Oct (#2794): at once, in the
  // switch-on's starting summary, not after a full limit counted from the switch-on.
  // "Off and on" writes the settings row directly, as a company switched off and on before the
  // switch-off clear existed would hold it, so nothing here relies on that clear.
  describe('after Spider is switched back on (D5)', () => {
    type Settings = Parameters<typeof configure>[1];
    async function offThenOn(c: Company, activatedAt: Date, settings: Settings = {}) {
      await configure(c, { ...settings, active: false });
      await configure(c, { ...settings, activatedAt });
    }
    const emailsTo = (c: Company) => emailedTo().filter((to) => to === c.admin.email);
    const textsFor = (c: Company) => vi.mocked(ctm.sendSms).mock.calls.filter(([account]) => account === `acct-${c.org.slice(0, 8)}`);

    it('a lead still in the same stage is in the switch-on summary at once, and only once', async () => {
      const c = await company();
      const settings: Settings = { channels: { email: true, text: true } };
      await configure(c, settings);
      const id = await lead(c, { createdAt: at(-3 * HOUR) });
      await runSpiderSweep(T0);
      expect(await alertsFor(id)).toHaveLength(1);

      // Switched back on as the switch does it: a new period and a starting trigger.
      const on = at(10 * MIN);
      await offThenOn(c, on, { ...settings, trigger: on });
      await runSpiderSweep(at(11 * MIN));
      expect(await alertsFor(id)).toHaveLength(1);

      await runSpiderSweep(at(13 * MIN));
      const alerts = await alertsFor(id);
      expect(alerts).toHaveLength(2);
      expect(alerts.map((a) => a.entered_status_at)).toEqual([at(-3 * HOUR), at(-3 * HOUR)]);
      expect(alerts[1]).toMatchObject({ kind: 'SUMMARIZED', counted_from: on });

      for (const t of [15 * MIN, 10 * MIN + 2 * HOUR, 10 * MIN + 4 * HOUR]) await runSpiderSweep(at(t));
      expect(await alertsFor(id)).toHaveLength(2);
      expect(emailsTo(c)).toHaveLength(2);
      expect(textsFor(c)).toHaveLength(2);
      expect(await db.notification.count({ where: { verb: 'spider.alert', object_id: id } })).toBe(1);
    });

    it('the earlier alert row is never rewritten', async () => {
      const c = await company();
      await configure(c);
      const id = await lead(c, { createdAt: at(-3 * HOUR) });
      await runSpiderSweep(T0);
      const [first] = await alertsFor(id);

      await offThenOn(c, at(10 * MIN));
      await runSpiderSweep(at(10 * MIN + 2 * HOUR));

      const alerts = await alertsFor(id);
      expect(alerts).toHaveLength(2);
      expect(alerts.find((a) => a.id === first!.id)).toEqual(first);
    });

    it('each further off and on gives one more alert; no off and on gives none', async () => {
      const c = await company();
      await configure(c);
      const id = await lead(c, { createdAt: at(-3 * HOUR) });
      await runSpiderSweep(T0);

      await offThenOn(c, at(1 * HOUR));
      await runSpiderSweep(at(3 * HOUR));
      await offThenOn(c, at(4 * HOUR));
      await runSpiderSweep(at(6 * HOUR));
      expect(await alertsFor(id)).toHaveLength(3);

      for (let run = 1; run <= 5; run++) await runSpiderSweep(at(6 * HOUR + run * 2 * MIN));
      const alerts = await alertsFor(id);
      expect(alerts).toHaveLength(3);
      expect(alerts.map((a) => a.counted_from)).toEqual([at(-3 * HOUR), at(1 * HOUR), at(4 * HOUR)]);
    });

    // Both per-person records: the in-app alert, and the red-frame-only record when in-app is off.
    for (const [verb, inApp] of [['spider.alert', true], ['spider.frame', false]] as const) {
      it(`a re-alert replaces an open earlier ${verb} record for the same lead, and leaves other leads' alone`, async () => {
        const c = await company();
        const settings: Settings = {
          channels: { in_app: inApp, red_frame: true },
          limits: { NEW: { enabled: true, value: 2, unit: 'HOUR' }, CONTACTED: { enabled: true, value: 1, unit: 'HOUR' } },
        };
        await configure(c, settings);
        const id = await lead(c, { createdAt: at(-3 * HOUR) });
        const other = await lead(c, { status: 'CONTACTED', createdAt: at(-4 * HOUR), contacted_at: at(-3 * HOUR) });
        await runSpiderSweep(T0);

        // Both first alerts stay unread through the off and on, as a company held them at deploy time.
        await offThenOn(c, at(10 * MIN), settings);
        await runSpiderSweep(at(10 * MIN + 1 * HOUR)); // the Contacted lead's limit passes first
        await runSpiderSweep(at(10 * MIN + 2 * HOUR)); // then the New lead's

        const records = (leadId: string) =>
          db.notificationRecipient.findMany({
            where: { notification: { verb, object_id: leadId } },
            select: { read_at: true, notification: { select: { dedup_key: true } } },
          });
        for (const leadId of [id, other]) {
          const [firstAlert, reAlert] = await alertsFor(leadId);
          expect(reAlert).toBeDefined();
          const mine = await records(leadId);
          expect(mine).toHaveLength(2);
          expect(mine.find((r) => r.notification.dedup_key === `${verb}:${firstAlert!.id}`)?.read_at).not.toBeNull();
          expect(mine.find((r) => r.notification.dedup_key === `${verb}:${reAlert!.id}`)?.read_at).toBeNull();
        }
      });
    }

    it('a re-alert still goes out when ending the earlier card fails, and the failure is logged by id', async () => {
      const c = await company();
      await configure(c);
      const id = await lead(c, { createdAt: at(-3 * HOUR) });
      await runSpiderSweep(T0);
      await offThenOn(c, at(10 * MIN));

      const realUpdate = db.notificationRecipient.updateManyAndReturn.bind(db.notificationRecipient);
      // A run ends every re-alerted lead's earlier card in one write (#2990), which reads back the rows it ended for the
      // live line (#3472): fail the one that names this lead.
      const spy = vi.spyOn(db.notificationRecipient, 'updateManyAndReturn').mockImplementation(((args: { where?: { notification?: { object_id?: { in?: string[] } } } }) =>
        args?.where?.notification?.object_id?.in?.includes(id) ? Promise.reject(new Error('connection lost')) : realUpdate(args as never)) as never);
      try {
        await runSpiderSweep(at(10 * MIN + 2 * HOUR));
      } finally {
        spy.mockRestore();
      }
      const [, reAlert] = await alertsFor(id);
      expect(reAlert).toBeDefined();
      expect(await db.notification.count({ where: { dedup_key: `spider.alert:${reAlert!.id}` } })).toBe(1);
      expect(vi.mocked(logger.error).mock.calls.map((x) => String(x[0]))).toContain(
        `[spider] could not end the earlier alerts for org ${c.org} leads ${id}: Error`,
      );
    });

    it('a first alert ends nothing', async () => {
      const c = await company();
      await configure(c);
      const id = await lead(c, { createdAt: at(-3 * HOUR) });
      // The ending write reads back the rows it ended, for the live line (#3472).
      const spy = vi.spyOn(db.notificationRecipient, 'updateManyAndReturn');
      try {
        await runSpiderSweep(T0);
        // A lead's cards are ended by naming it, alone or in the run's one list of re-alerted leads (#2990).
        const endedForLead = spy.mock.calls.filter(([args]) => {
          const objectId = (args?.where?.notification as { object_id?: unknown } | undefined)?.object_id;
          return objectId === id || ((objectId as { in?: string[] } | undefined)?.in ?? []).includes(id);
        });
        expect(endedForLead).toEqual([]);
      } finally {
        spy.mockRestore();
      }
      expect(await spiderNotices(id)).toEqual([{ recipient_id: c.admin.id, read_at: null }]);
    });

    it('the unique key is still the claim within one switched-on period', async () => {
      const c = await company();
      await configure(c, { channels: { email: true, text: true } });
      const id = await lead(c, { createdAt: at(-3 * HOUR) });
      // Already alerted in this period (counted from entering the stage, after the switch-on)...
      await db.spiderAlert.create({
        data: {
          organization_id: c.org, lead_id: id, status: 'NEW', entered_status_at: at(-3 * HOUR), counted_from: at(-3 * HOUR),
          limit_value: 2, limit_unit: 'HOUR', alerted_at: at(-HOUR),
        },
      });
      // ...but the pre-check misses it, so only the insert can stop a second alert.
      const realFind = db.spiderAlert.findMany.bind(db.spiderAlert);
      let missed = false;
      const spy = vi.spyOn(db.spiderAlert, 'findMany').mockImplementation(((args: { where?: { organization_id?: string } }) => {
        if (!missed && args?.where?.organization_id === c.org) {
          missed = true;
          return Promise.resolve([]);
        }
        return realFind(args as never);
      }) as never);
      try {
        await runSpiderSweep(T0);
      } finally {
        spy.mockRestore();
      }
      expect(missed).toBe(true);
      expect(await alertsFor(id)).toHaveLength(1);
      expect(await db.notification.count({ where: { object_id: id } })).toBe(0);
      expect(emailsTo(c)).toEqual([]);
      expect(textsFor(c)).toEqual([]);
      expect(vi.mocked(logger.error).mock.calls.filter((x) => String(x[0]).includes(c.org))).toEqual([]);
    });

    it('a stage visit that begins after switch-on alerts once, counted from entering it', async () => {
      const c = await company();
      const settings: Settings = {
        limits: { NEW: { enabled: true, value: 2, unit: 'HOUR' }, CONTACTED: { enabled: true, value: 1, unit: 'HOUR' } },
      };
      await configure(c, settings);
      const id = await lead(c, { createdAt: at(-3 * HOUR) });
      await runSpiderSweep(T0);

      await offThenOn(c, at(10 * MIN), settings);
      await move(id, 'CONTACTED', { contacted_at: at(30 * MIN) });
      await runSpiderSweep(at(30 * MIN + HOUR - MIN));
      await runSpiderSweep(at(30 * MIN + HOUR));
      await runSpiderSweep(at(30 * MIN + HOUR + 2 * MIN));

      const contacted = (await alertsFor(id)).filter((a) => a.status === 'CONTACTED');
      expect(contacted).toHaveLength(1);
      expect(contacted[0]!.entered_status_at).toEqual(at(30 * MIN));
      expect(contacted[0]!.counted_from).toEqual(at(30 * MIN));
    });

    // The settings save restarts the clock when it switches on the first stage: a new switched-on
    // period, with nothing ever alerted under the one it ends.
    it('a moved activated_at with nothing alerted before gives exactly one alert', async () => {
      const c = await company();
      await configure(c, { limits: ALL_OFF, activatedAt: at(-60 * DAY) });
      const id = await lead(c, { createdAt: at(-3 * HOUR) });
      await runSpiderSweep(T0);
      expect(await alertsFor(id)).toEqual([]);

      await configure(c, { activatedAt: at(10 * MIN) });
      await runSpiderSweep(at(10 * MIN + 2 * HOUR));
      await runSpiderSweep(at(10 * MIN + 2 * HOUR + 2 * MIN));
      const alerts = await alertsFor(id);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.counted_from).toEqual(at(10 * MIN));
    });

    it("another company's alerts are not re-raised or ended", async () => {
      const a = await company();
      const b = await company();
      await configure(a);
      await configure(b);
      const aLead = await lead(a, { createdAt: at(-3 * HOUR) });
      const bLead = await lead(b, { createdAt: at(-3 * HOUR) });
      await runSpiderSweep(T0);
      const bBefore = { alerts: await alertsFor(bLead), notices: await spiderNotices(bLead) };

      await offThenOn(a, at(10 * MIN));
      await runSpiderSweep(at(10 * MIN + 2 * HOUR));

      expect(await alertsFor(aLead)).toHaveLength(2);
      expect({ alerts: await alertsFor(bLead), notices: await spiderNotices(bLead) }).toEqual(bBefore);
      expect(bBefore.notices).toEqual([{ recipient_id: b.admin.id, read_at: null }]);
    });
  });

  // ─── Email (#2625) ─────────────────────────────────────────────────────────

  describe('email', () => {
    it('goes out from "ServWave Spider Alerts" with a lead link on this environment', async () => {
      const c = await company();
      await configure(c, { channels: { email: true } });
      const id = await lead(c);
      await runSpiderSweep(T0);
      expect(resendSend).toHaveBeenCalledTimes(1);
      const [message] = resendSend.mock.calls[0];
      expect(message.from).toBe('"ServWave Spider Alerts" <alerts@spider.servwave.com>');
      expect(message.to).toBe(c.admin.email);
      expect(message.text).toContain(`${FRONTEND_URL}/leads/${id}`);
      expect(message.html).toContain(`${FRONTEND_URL}/leads/${id}`);
      const [alert] = await alertsFor(id);
      expect((alert.delivery as { email: { outcome: string } }).email.outcome).toBe('Email sent');
    });

    it('sends nothing when the company email switch or the Spider email channel is off, and records why', async () => {
      const companyOff = await company({ email: false });
      const channelOff = await company();
      await configure(companyOff, { channels: { email: true } });
      await configure(channelOff, { channels: { email: false } });
      const [a, b] = [await lead(companyOff), await lead(channelOff)];
      await runSpiderSweep(T0);
      expect(resendSend).not.toHaveBeenCalled();
      expect(((await alertsFor(a))[0].delivery as { email: { outcome: string } }).email.outcome).toBe('Email skipped: company email is switched off');
      expect(((await alertsFor(b))[0].delivery as { email: { outcome: string } }).email.outcome).toBe('Email alerts are switched off');
    });

    it('skips a suppressed address and records the skip', async () => {
      const c = await company();
      const suppressed = await person(c.org, 'ADMIN');
      await db.emailSuppression.create({ data: { address: suppressed.email, category: 'TRANSACTIONAL', kind: 'HARD_BOUNCE' } });
      try {
        await configure(c, { channels: { email: true } });
        const id = await lead(c);
        await runSpiderSweep(T0);
        expect(emailedTo()).toEqual([c.admin.email]);
        const recipients = ((await alertsFor(id))[0].delivery as { email: { recipients: { user_id: string; outcome: string }[] } }).email.recipients;
        expect(recipients).toContainEqual({ user_id: suppressed.id, outcome: 'Email skipped: address is suppressed' });
      } finally {
        await db.emailSuppression.deleteMany({ where: { address: suppressed.email } });
      }
    });

    it('records a provider rejection in plain words', async () => {
      const c = await company();
      await configure(c, { channels: { email: true } });
      resendSend.mockResolvedValue({ data: null, error: { name: 'validation_error', message: 'Resend says no' } });
      const id = await lead(c);
      await runSpiderSweep(T0);
      const outcome = ((await alertsFor(id))[0].delivery as { email: { outcome: string } }).email.outcome;
      expect(outcome).toBe('Email could not be delivered');
    });
  });

  // ─── Text (#2626) ──────────────────────────────────────────────────────────

  describe('text', () => {
    it("goes only to staff phones, never the customer's, creates no conversation, and counts toward texting usage", async () => {
      const c = await company();
      await configure(c, { channels: { text: true } });
      const id = await lead(c);
      const usageBefore = (await getCommUsage(c.org, { now: T0 })).texting.used;

      await runSpiderSweep(T0);

      expect(textedTo()).toEqual(['+16175550101']);
      expect(textedTo()).not.toContain('+16175559999');
      expect(vi.mocked(ctm.sendSms).mock.calls[0][1].msg).toContain(`${FRONTEND_URL}/leads/${id}`);
      expect(await db.messageThread.count({ where: { organization_id: c.org } })).toBe(0);
      expect(await db.message.count({ where: { organization_id: c.org } })).toBe(0);
      expect((await getCommUsage(c.org, { now: T0 })).texting.used).toBe(usageBefore + 1);
    });

    it('counts a sent text toward usage even when recording the delivery afterwards fails', async () => {
      const c = await company();
      await configure(c, { channels: { text: true } });
      const id = await lead(c);
      // The run's one delivery-record write fails, and so does each one-by-one retry of it (#2990).
      const realUpdate = db.spiderAlert.update.bind(db.spiderAlert);
      const spy = vi.spyOn(db.spiderAlert, 'update').mockImplementation(((args: { data: { delivery?: unknown } }) =>
        args.data.delivery ? Promise.reject(new Error('lost')) : realUpdate(args as never)) as never);
      // The delivery-record write only (the usage count is its own write, #2990).
      const isDeliveryWrite = (sql: string) => /UPDATE spider_alerts/.test(sql) && /SET channels/.test(sql);
      faults.calls = [];
      faults.executeRaw = (sql) => (isDeliveryWrite(sql) ? new Error('lost') : null);
      try {
        await runSpiderSweep(T0);
      } finally {
        spy.mockRestore();
        faults.executeRaw = null;
      }
      expect(faults.calls.filter(isDeliveryWrite).length).toBeGreaterThan(0);
      expect(((await alertsFor(id))[0].delivery as Record<string, unknown>).text).toBeUndefined();
      expect(textedTo()).toEqual(['+16175550101']);
      expect((await alertsFor(id))[0].texts_sent).toBe(1);
    });

    it('sends nothing for a company that fails the phone-plan gate or has texting switched off, and records why', async () => {
      const noPhonePlan = await company({ overrides: { phone: false } });
      const textingOff = await company();
      await db.organization.update({ where: { id: textingOff.org }, data: { sms_sending_enabled: false } });
      const channelOff = await company();
      await configure(noPhonePlan, { channels: { text: true } });
      await configure(textingOff, { channels: { text: true } });
      await configure(channelOff, { channels: { text: false } });
      const [a, b, d] = [await lead(noPhonePlan), await lead(textingOff), await lead(channelOff)];
      await runSpiderSweep(T0);
      expect(ctm.sendSms).not.toHaveBeenCalled();
      const outcome = async (id: string) => ((await alertsFor(id))[0].delivery as { text: { outcome: string } }).text.outcome;
      expect(await outcome(a)).toBe('Text skipped: texting is not part of the company plan');
      expect(await outcome(b)).toBe('Text skipped: company texting is switched off');
      expect(await outcome(d)).toBe('Text alerts are switched off');
      expect((await alertsFor(a))[0].texts_sent).toBe(0);
    });

    it('records a failed send in plain words', async () => {
      const c = await company();
      await configure(c, { channels: { text: true } });
      vi.mocked(ctm.sendSms).mockRejectedValue(new Error('CallTrackingMetrics 500'));
      const id = await lead(c);
      await runSpiderSweep(T0);
      expect(((await alertsFor(id))[0].delivery as { text: { outcome: string } }).text.outcome).toBe('Text message could not be delivered');
    });
  });

  // ─── The contractor's message texts (Ran, 15 Oct) ──────────────────────────

  describe("the contractor's message texts", () => {
    const sentence = (t: string) => `This lead was created ${t} ago and has not yet been contacted.`;

    it('the in-app alert: his title and stage sentence, and the card fields stored at alert time', async () => {
      const c = await company();
      await configure(c);
      const id = await lead(c, { createdAt: at(-3 * HOUR) });
      const number = `L-${id.slice(0, 8)}`;

      await runSpiderSweep(T0);

      const n = await db.notification.findFirst({ where: { verb: 'spider.alert', object_id: id } });
      expect(n?.priority).toBe('FEED');
      expect(await db.notificationRecipient.findMany({ where: { notification_id: n!.id }, select: { priority: true } })).toEqual([
        { priority: 'FEED' },
      ]);
      expect(n?.title).toBe(`Spider Alert - Pat Payer (${number})`);
      expect(n?.body).toBe(sentence('3 hours'));
      expect(n?.object_label).toBe(number);
      expect(n?.data).toMatchObject({
        lead_number: number,
        customer_name: 'Pat Payer',
        company_name: null,
        stage_name: 'New',
        service_location: 'Service location on file',
        service_request: 'Fix the door',
        assigned_to: 'Unassigned',
        stage_entered_at: at(-3 * HOUR).toISOString(),
        lead_created_at: at(-3 * HOUR).toISOString(),
        time_in_stage: '3 hours',
        title: `Spider Alert - Pat Payer (${number})`,
        body: sentence('3 hours'),
        full_message: `Spider Alert - Pat Payer (${number})\n${sentence('3 hours')}\n\nView lead: ${FRONTEND_URL}/leads/${id}`,
        lead_url: `${FRONTEND_URL}/leads/${id}`,
      });
    });

    it("counts the time in the stage from when the lead entered it, even when Spider was switched on later", async () => {
      const c = await company();
      await configure(c, { activatedAt: at(-3 * HOUR) });
      const id = await lead(c, { createdAt: at(-5 * DAY) });
      await runSpiderSweep(T0);
      const n = await db.notification.findFirst({ where: { verb: 'spider.alert', object_id: id } });
      expect(n?.body).toBe(sentence('5 days'));
    });

    it("names the company, the lead's first assignee (else its owner), and the service location by his fallbacks", async () => {
      const c = await company();
      const rep = await person(c.org, 'SALES');
      const tech = await person(c.org, 'TECHNICIAN');
      await db.customer.update({ where: { id: c.customer }, data: { company_name: 'Payer Homes' } });
      await db.serviceLocation.create({
        data: { customer_id: c.customer, address_line1: '1 First Way', city: 'Testville', state: 'MA', zip: '02108', created_at: at(-9 * DAY) },
      });
      await db.serviceLocation.create({
        data: { customer_id: c.customer, address_line1: '2 Primary Road', address_line2: 'Unit 4', city: 'Testville', state: 'MA', zip: '02108', is_primary: true },
      });
      await configure(c);
      const assigned = await lead(c, { owner: rep.id });
      await db.leadAssignee.create({ data: { lead_id: assigned, user_id: tech.id, organization_id: c.org } });
      const owned = await lead(c, { owner: rep.id });

      await runSpiderSweep(T0);

      const dataOf = async (leadId: string) =>
        (await db.notification.findFirst({ where: { verb: 'spider.alert', object_id: leadId } }))?.data as Record<string, unknown>;
      const techName = (await db.user.findUniqueOrThrow({ where: { id: tech.id } })).first_name + ' Tester';
      const repName = (await db.user.findUniqueOrThrow({ where: { id: rep.id } })).first_name + ' Tester';
      expect(await dataOf(assigned)).toMatchObject({
        company_name: 'Payer Homes',
        assigned_to: techName,
        service_location: '2 Primary Road, Unit 4, Testville, MA, 02108',
      });
      expect((await dataOf(owned)).assigned_to).toBe(repName);
    });

    it('the email: his subject, plain-text body and HTML body, in the company layout, from the Spider sender', async () => {
      const c = await company();
      await configure(c, { channels: { email: true } });
      const id = await lead(c, { createdAt: at(-3 * HOUR) });
      const number = `L-${id.slice(0, 8)}`;
      await runSpiderSweep(T0);

      const [message] = resendSend.mock.calls[0];
      const admin = await db.user.findUniqueOrThrow({ where: { id: c.admin.id } });
      expect(message.from).toBe('"ServWave Spider Alerts" <alerts@spider.servwave.com>');
      expect(message.subject).toBe(`Spider Alert - Pat Payer (${number})`);
      expect(message.text).toBe(`Spider Alert - Pat Payer (${number})\n${sentence('3 hours')}\n\nView lead: ${FRONTEND_URL}/leads/${id}`);
      const html = message.html as string;
      const org = await db.organization.findUniqueOrThrow({ where: { id: c.org } });
      expect(html).toContain(org.name);
      expect(html).toContain('🕷️ Spider AI Lead Watcher Alert');
      expect(html).toContain(`Hi ${admin.first_name} ${admin.last_name},`);
      expect(html).toContain(sentence('3 hours'));
      expect(html).toContain('Assigned To:');
      expect(html).toContain('Service location on file');
      expect(html).toContain(`View lead: ${FRONTEND_URL}/leads/${id}`);
      expect(html).toContain('This is an automated message from ServWave.');
    });

    it('the text message: his full alert text', async () => {
      const c = await company();
      await configure(c, { channels: { text: true } });
      const id = await lead(c, { createdAt: at(-3 * HOUR) });
      await runSpiderSweep(T0);
      expect(vi.mocked(ctm.sendSms).mock.calls[0][1].msg).toBe(
        `Spider Alert - Pat Payer (L-${id.slice(0, 8)})\n${sentence('3 hours')}\n\nView lead: ${FRONTEND_URL}/leads/${id}`,
      );
    });
  });

  // ─── The History snapshot (S3: what his alert log stored at alert time) ─────

  describe('the History snapshot', () => {
    const sentence = (t: string) => `This lead was created ${t} ago and has not yet been contacted.`;

    it('stores the lead, customer, address, stage, time in the stage and the messages as they were when it went out', async () => {
      const c = await company();
      await db.customer.update({ where: { id: c.customer }, data: { company_name: 'Payer Homes' } });
      await db.serviceLocation.create({
        data: { customer_id: c.customer, address_line1: '2 Primary Road', city: 'Testville', state: 'MA', zip: '02108', is_primary: true },
      });
      await configure(c, { channels: { in_app: true, email: true, text: true } });
      const id = await lead(c, { createdAt: at(-3 * HOUR) });
      const number = `L-${id.slice(0, 8)}`;

      await runSpiderSweep(T0);

      const [alert] = await alertsFor(id);
      const full = `Spider Alert - Pat Payer (${number})\n${sentence('3 hours')}\n\nView lead: ${FRONTEND_URL}/leads/${id}`;
      expect(alert).toMatchObject({
        lead_number: number,
        customer_id: c.customer,
        customer_name: 'Pat Payer',
        company_name: 'Payer Homes',
        service_request: 'Fix the door',
        service_location: '2 Primary Road, Testville, MA, 02108',
        stage_name: 'New',
        elapsed_value: 3,
        elapsed_unit: 'HOUR',
        email_subject: `Spider Alert - Pat Payer (${number})`,
        email_body: full,
        sms_message: full,
        in_app_message: sentence('3 hours'),
      });

      // A later edit to the customer never changes what the alert recorded.
      await db.customer.update({ where: { id: c.customer }, data: { first_name: 'Renamed' } });
      expect((await alertsFor(id))[0].customer_name).toBe('Pat Payer');
    });

    it('stores each recipient with name, email, role and how they were chosen, and never a phone number', async () => {
      const c = await company();
      const owner = await person(c.org, 'SALES', { phone: '+16175550111' });
      // A chosen person who can open the lead (a Technician not on the lead could not, and is left out).
      const chosen = await person(c.org, 'ADMIN', { phone: '+16175550122' });
      const dispatcher = await person(c.org, 'DISPATCHER', { phone: '+16175550133' });
      await configure(c, { recipients: { roles: ['DISPATCHER'], user_ids: [chosen.id], lead_owner: true } });
      const id = await lead(c, { owner: owner.id });

      await runSpiderSweep(T0);

      const [alert] = await alertsFor(id);
      const name = async (uid: string) => {
        const u = await db.user.findUniqueOrThrow({ where: { id: uid } });
        return `${u.first_name} ${u.last_name}`;
      };
      expect(alert.recipients).toEqual(expect.arrayContaining([
        { id: owner.id, name: await name(owner.id), email: owner.email, role: 'SALES', type: 'owner' },
        { id: chosen.id, name: await name(chosen.id), email: chosen.email, role: 'ADMIN', type: 'user' },
        { id: dispatcher.id, name: await name(dispatcher.id), email: dispatcher.email, role: 'DISPATCHER', type: 'admin' },
      ]));
      expect(alert.recipients).toHaveLength(3);
      // Exactly these people's numbers, and no phone field: a bare /555/ would also match a random id or email.
      const stored = JSON.stringify(alert.recipients);
      for (const phone of ['+16175550111', '+16175550122', '+16175550133', '6175550111', '6175550122', '6175550133']) {
        expect(stored).not.toContain(phone);
      }
      for (const r of alert.recipients as Record<string, unknown>[]) expect(Object.keys(r).sort()).toEqual(['email', 'id', 'name', 'role', 'type']);
    });

    it("marks the Admins Spider fell back to as chosen by role ('admin')", async () => {
      const c = await company();
      await configure(c, { recipients: { lead_owner: true } });
      const id = await lead(c);
      await runSpiderSweep(T0);
      const [alert] = await alertsFor(id);
      expect(alert.recipients).toEqual([expect.objectContaining({ id: c.admin.id, role: 'ADMIN', type: 'admin' })]);
    });

    it('stores a SENT / FAILED / SKIPPED outcome per channel with sent, skipped and failed counts, and the sender', async () => {
      const c = await company();
      await person(c.org, 'ADMIN', { phone: null });
      await configure(c, { channels: { in_app: true, email: true, text: true } });
      const id = await lead(c);

      await runSpiderSweep(T0);

      const [alert] = await alertsFor(id);
      expect(alert.channels).toEqual({
        email: {
          enabled: true, status: 'SENT', sent: 2, skipped: 0, failed: 0, error: null, skip_reason: null,
          from: 'ServWave Spider Alerts <alerts@spider.servwave.com>',
        },
        sms: { enabled: true, status: 'SENT', sent: 1, skipped: 1, failed: 0, error: null, skip_reason: 'no phone number' },
        in_app: { enabled: true, status: 'SENT' },
      });
    });

    it("records a failure with the contractor's wording, and a switched-off channel as not enabled", async () => {
      const c = await company();
      await configure(c, { channels: { in_app: false, email: true, text: true } });
      resendSend.mockResolvedValue({ data: null, error: { name: 'validation_error', message: 'provider says no' } });
      vi.mocked(ctm.sendSms).mockRejectedValue(new Error('provider 500'));
      const id = await lead(c);

      await runSpiderSweep(T0);

      const [alert] = await alertsFor(id);
      const ch = alert.channels as Record<string, Record<string, unknown>>;
      expect(ch.email).toMatchObject({ enabled: true, status: 'FAILED', sent: 0, failed: 1, error: 'Email delivery failed' });
      expect(ch.sms).toMatchObject({ enabled: true, status: 'FAILED', sent: 0, failed: 1, error: 'Text message delivery failed' });
      expect(ch.in_app).toEqual({ enabled: false, status: 'SKIPPED' });
      expect(JSON.stringify(ch)).not.toMatch(/provider/i);
    });

    it('records a skip with its reason: company email off, and texting not in the plan', async () => {
      const c = await company({ email: false, overrides: { phone: false } });
      await configure(c, { channels: { email: true, text: true } });
      const id = await lead(c);
      await runSpiderSweep(T0);
      const ch = (await alertsFor(id))[0].channels as Record<string, Record<string, unknown>>;
      expect(ch.email).toMatchObject({ enabled: true, status: 'SKIPPED', sent: 0, skipped: 1, failed: 0, skip_reason: 'company email is switched off' });
      expect(ch.sms).toMatchObject({ enabled: true, status: 'SKIPPED', sent: 0, skipped: 1, failed: 0, skip_reason: 'SMS messaging is not entitled' });
    });
  });

  // ─── Red Frame on its own (Ran, 15 Oct: his Red Frame works without in-app) ──

  describe('the red frame with in-app alerts off', () => {
    const recordsFor = (leadId: string, verb: string) =>
      db.notificationRecipient.findMany({
        where: { notification: { verb, object_id: leadId } },
        select: { recipient_id: true, read_at: true },
        orderBy: { recipient_id: 'asc' },
      });

    it('Red Frame on, In-app off: records a bell-hidden frame record per recipient and no in-app alert, ended when the lead moves on', async () => {
      const c = await company();
      const rep = await person(c.org, 'DISPATCHER');
      await configure(c, { channels: { in_app: false, red_frame: true }, recipients: { roles: ['ADMIN', 'DISPATCHER'] } });
      const id = await lead(c, { createdAt: at(-3 * HOUR) });

      await runSpiderSweep(T0);

      expect(await spiderNotices(id)).toEqual([]);
      const frames = await recordsFor(id, 'spider.frame');
      expect(frames.map((f) => f.recipient_id)).toEqual([c.admin.id, rep.id].sort());
      expect(frames.every((f) => f.read_at === null)).toBe(true);
      const n = await db.notification.findFirst({ where: { verb: 'spider.frame', object_id: id } });
      expect(n?.data).toMatchObject({ status: 'NEW', entered_status_at: at(-3 * HOUR).toISOString() });
      const [alert] = await alertsFor(id);
      expect((alert.delivery as { in_app: { outcome: string } }).in_app.outcome).toBe('In-app alerts are switched off');

      // Once per stage visit, as every channel.
      await runSpiderSweep(at(2 * MIN));
      expect(await recordsFor(id, 'spider.frame')).toHaveLength(2);

      await move(id, 'CONTACTED', { contacted_at: at(3 * MIN) });
      await runSpiderSweep(at(4 * MIN));
      expect((await recordsFor(id, 'spider.frame')).every((f) => f.read_at !== null)).toBe(true);
    });

    it('Red Frame off and In-app off: records nothing per person, as before (the alert log row still is)', async () => {
      const c = await company();
      await configure(c, { channels: { in_app: false, red_frame: false, email: true } });
      const id = await lead(c, { createdAt: at(-3 * HOUR) });

      await runSpiderSweep(T0);

      expect(await alertsFor(id)).toHaveLength(1);
      expect(await db.notification.count({ where: { organization_id: c.org } })).toBe(0);
      expect(emailedTo()).toEqual([c.admin.email]);
    });

    it('In-app on: the in-app alert alone carries the frame, with no separate frame record', async () => {
      const c = await company();
      await configure(c, { channels: { in_app: true, red_frame: true } });
      const id = await lead(c, { createdAt: at(-3 * HOUR) });
      await runSpiderSweep(T0);
      expect(await spiderNotices(id)).toHaveLength(1);
      expect(await recordsFor(id, 'spider.frame')).toEqual([]);
    });
  });

  // ─── Running ───────────────────────────────────────────────────────────────

  // ─── The starting summary (#2794) ──────────────────────────────────────────

  describe('the starting summary', () => {
    const SUMMARY_VERB = 'spider.starting_summary';
    /** A trigger whose quiet period (one sweep interval, 2 minutes) has passed by T0. */
    const QUIET = at(-3 * MIN);

    const summaryOf = (org: string) => db.spiderSummary.findFirst({ where: { organization_id: org, status: 'READY' } });
    const triggerOf = async (org: string) =>
      (await db.spiderSettings.findUniqueOrThrow({ where: { organization_id: org } })).summary_trigger_at;
    async function bellFor(org: string) {
      return db.notificationRecipient.findMany({
        where: { organization_id: org, notification: { verb: SUMMARY_VERB } },
        select: { recipient_id: true, priority: true, notification: { select: { title: true, body: true, data: true, priority: true } } },
      });
    }
    const alertNotices = (org: string) =>
      db.notification.count({ where: { organization_id: org, verb: { in: ['spider.alert', 'spider.frame'] } } });
    const mailTo = (email: string) => resendSend.mock.calls.map(([m]) => m).filter((m) => m.to === email);
    const textsTo = (phone: string) => vi.mocked(ctm.sendSms).mock.calls.map(([, m]) => m).filter((m) => m.to === phone);

    it('reports the backlog in one summary per person instead of one alert per lead, and clears the trigger', async () => {
      const c = await company();
      await db.user.update({ where: { id: c.admin.id }, data: { phone: '+16175550201' } });
      await configure(c, { trigger: QUIET, channels: { in_app: true, red_frame: true, email: true, text: true } });
      const overdue = await Promise.all([lead(c, { createdAt: at(-3 * DAY) }), lead(c, { createdAt: at(-5 * HOUR) }), lead(c, { createdAt: at(-3 * HOUR) })]);
      const notYet = await lead(c, { createdAt: at(-1 * HOUR) });

      const result = await runSpiderSweep(T0);

      expect(result.leadsSummarized).toBeGreaterThanOrEqual(3);
      // Every overdue stay is claimed as summarized, linked to the one summary; nothing alerted one by one.
      const summary = await summaryOf(c.org);
      expect(summary).toMatchObject({ lead_count: 3, recipient_count: 1, trigger_kind: 'SWITCHED_ON' });
      expect(summary!.triggered_at).toEqual(QUIET);
      for (const id of overdue) {
        const [row] = await alertsFor(id);
        expect(row).toMatchObject({ kind: 'SUMMARIZED', summary_id: summary!.id, recipient_ids: [c.admin.id], stage_name: 'New' });
      }
      expect(await alertsFor(notYet)).toEqual([]);
      expect(await alertNotices(c.org)).toBe(0);
      // In the app: one notification, the demo's words, on the feed (no toast), linking to the summary.
      const bell = await bellFor(c.org);
      expect(bell).toHaveLength(1);
      expect(bell[0]).toMatchObject({
        recipient_id: c.admin.id,
        priority: 'FEED',
        notification: { title: 'Spider is on. 3 of your leads were already past their limit.', body: 'Your starting summary' },
      });
      expect(bell[0]!.notification.data).toMatchObject({ link_path: '/spider/summary', lead_count: 3 });
      // One email and one text, never one per lead.
      expect(mailTo(c.admin.email)).toHaveLength(1);
      expect(mailTo(c.admin.email)[0]!.subject).toBe("Spider's starting summary: 3 of your leads are past their limit");
      expect(textsTo('+16175550201')).toHaveLength(1);
      // The trigger is spent.
      expect(await triggerOf(c.org)).toBeNull();
      // The delivery is recorded on the summary, in plain words.
      expect(summary!.delivery).toMatchObject({
        in_app: { outcome: 'Shown in the app' },
        email: { outcome: 'Email sent' },
        text: { outcome: 'Text message sent' },
      });
    });

    it('then alerts normally: a lead crossing its limit later alerts on its own, and no summarized lead alerts again', async () => {
      const c = await company();
      await configure(c, { trigger: QUIET });
      const old = await lead(c, { createdAt: at(-3 * DAY) });
      const later = await lead(c, { createdAt: at(-1 * HOUR) });
      await runSpiderSweep(T0);
      await runSpiderSweep(at(2 * HOUR));

      expect(await alertsFor(old)).toHaveLength(1);
      const [laterRow] = await alertsFor(later);
      expect(laterRow).toMatchObject({ kind: 'ALERTED', summary_id: null });
      expect(await spiderNotices(later)).toEqual([{ recipient_id: c.admin.id, read_at: null }]);
      expect(await spiderNotices(old)).toEqual([]);
      expect(await bellFor(c.org)).toHaveLength(1);
    });

    it('gives each person exactly the leads they would have been alerted about', async () => {
      const c = await company();
      const maya = await person(c.org, 'SALES');
      const leo = await person(c.org, 'SALES');
      // Owners only: each salesperson their own leads; the unowned lead goes to the Admin backstop.
      await configure(c, { trigger: QUIET, recipients: { lead_owner: true }, channels: { in_app: true, email: true } });
      const mayas = [await lead(c, { owner: maya.id, createdAt: at(-3 * DAY) }), await lead(c, { owner: maya.id, createdAt: at(-4 * DAY) })];
      const leos = await lead(c, { owner: leo.id, createdAt: at(-3 * DAY) });
      const nobodys = await lead(c, { createdAt: at(-3 * DAY) });

      await runSpiderSweep(T0);

      const bell = await bellFor(c.org);
      const titleFor = (id: string) => bell.find((b) => b.recipient_id === id)?.notification.title;
      expect(bell).toHaveLength(3);
      expect(titleFor(maya.id)).toBe('Spider is on. 2 of your leads were already past their limit.');
      expect(titleFor(leo.id)).toBe('Spider is on. 1 of your leads was already past its limit.');
      expect(titleFor(c.admin.id)).toBe('Spider is on. 1 of your leads was already past its limit.');
      // Each email lists that person's leads only, and no Owner column for a list of one's own leads.
      const mayaMail = mailTo(maya.email)[0]!;
      for (const id of mayas) expect(mayaMail.html).toContain(`/leads/${id}`);
      expect(mayaMail.html).not.toContain(`/leads/${leos}`);
      expect(mayaMail.html).not.toContain(`/leads/${nobodys}`);
      expect(mayaMail.html).not.toContain('>Owner</th>');
      const adminMail = mailTo(c.admin.email)[0]!;
      expect(adminMail.html).toContain(`/leads/${nobodys}`);
      expect(adminMail.html).not.toContain(`/leads/${mayas[0]}`);
      expect(adminMail.html).toContain('>Owner</th>');
      expect(adminMail.html).toContain('>No owner</td>');
    });

    it('never tells anyone about a lead they cannot open, nor anyone who cannot sign in', async () => {
      const c = await company();
      const gone = await person(c.org, 'SALES', { login: false });
      await configure(c, { trigger: QUIET, recipients: { user_ids: [gone.id] } });
      await lead(c, { createdAt: at(-3 * DAY) });
      await runSpiderSweep(T0);
      // The chosen person cannot sign in: the Admins are the backstop, as for an alert.
      expect((await bellFor(c.org)).map((b) => b.recipient_id)).toEqual([c.admin.id]);
    });

    it('sends nothing and makes no summary when nothing is overdue, keeps the last summary, and clears the trigger', async () => {
      const c = await company();
      await configure(c, { trigger: QUIET, channels: { in_app: true, email: true, text: true } });
      await lead(c, { createdAt: at(-1 * HOUR) });
      await runSpiderSweep(T0);
      expect(await summaryOf(c.org)).toBeNull();
      expect(await bellFor(c.org)).toEqual([]);
      expect(mailTo(c.admin.email)).toEqual([]);
      expect(await triggerOf(c.org)).toBeNull();
    });

    it('waits for the settings to be quiet for a sweep interval: alerting nothing meanwhile, then one summary for several saves', async () => {
      const c = await company();
      await configure(c, { trigger: at(-1 * MIN) });
      const id = await lead(c, { createdAt: at(-3 * DAY) });

      await runSpiderSweep(T0);
      expect(await alertsFor(id)).toEqual([]);
      expect(await bellFor(c.org)).toEqual([]);
      expect(await triggerOf(c.org)).toEqual(at(-1 * MIN));

      // Another save a minute later moves the trigger on: still quiet-period.
      await db.spiderSettings.update({ where: { organization_id: c.org }, data: { summary_trigger_at: at(MIN) } });
      await runSpiderSweep(at(2 * MIN));
      expect(await bellFor(c.org)).toEqual([]);

      await runSpiderSweep(at(4 * MIN));
      expect(await bellFor(c.org)).toHaveLength(1);
      expect((await alertsFor(id))[0]).toMatchObject({ kind: 'SUMMARIZED' });
    });

    it('keeps a trigger that lands while the summary is being made, and acts on it later', async () => {
      const c = await company();
      await configure(c, { trigger: QUIET, channels: { in_app: true, email: true } });
      await lead(c, { createdAt: at(-3 * DAY) });
      // A save during the run: the email goes out mid-run, and the save lands then.
      resendSend.mockImplementationOnce(async () => {
        await db.spiderSettings.update({ where: { organization_id: c.org }, data: { summary_trigger_at: at(MIN), summary_trigger_kind: 'STAGE_ADDED' } });
        return { data: { id: 'msg_1' }, error: null };
      });
      await runSpiderSweep(T0);
      expect(await triggerOf(c.org)).toEqual(at(MIN));
      // The newer trigger waits afresh: its bound counts from this run, not from the first one.
      expect((await db.spiderSettings.findUniqueOrThrow({ where: { organization_id: c.org } })).summary_trigger_since).toEqual(T0);

      // The newer trigger is acted on in its turn: a stage switched on brings its own backlog.
      await configure(c, {
        trigger: at(MIN),
        triggerKind: 'STAGE_ADDED',
        limits: { NEW: { enabled: true, value: 2, unit: 'HOUR' }, CONTACTED: { enabled: true, value: 1, unit: 'DAY' } },
        channels: { in_app: true, email: true },
      });
      const contacted = await lead(c, { status: 'CONTACTED', createdAt: at(-9 * DAY), contacted_at: at(-8 * DAY) });
      await runSpiderSweep(at(4 * MIN));
      expect(await triggerOf(c.org)).toBeNull();
      expect((await alertsFor(contacted))[0]).toMatchObject({ kind: 'SUMMARIZED' });
      expect(await summaryOf(c.org)).toMatchObject({ lead_count: 1, trigger_kind: 'STAGE_ADDED' });
    });

    it("a stage switched on, a limit shortened or a scope widened summarizes only that backlog: leads already alerted are not told again", async () => {
      const c = await company();
      await configure(c);
      const alerted = await lead(c, { createdAt: at(-3 * DAY) });
      await runSpiderSweep(T0);
      expect(await alertsFor(alerted)).toHaveLength(1);

      // A Contacted backlog, and a New lead that only the shorter limit makes overdue.
      const contacted = await lead(c, { status: 'CONTACTED', createdAt: at(-9 * DAY), contacted_at: at(-8 * DAY) });
      const newish = await lead(c, { createdAt: at(-90 * MIN) });
      await configure(c, {
        trigger: at(2 * MIN),
        triggerKind: 'SETTINGS_CHANGED',
        limits: { NEW: { enabled: true, value: 1, unit: 'HOUR' }, CONTACTED: { enabled: true, value: 1, unit: 'DAY' } },
      });
      await runSpiderSweep(at(5 * MIN));

      const summary = await summaryOf(c.org);
      expect(summary).toMatchObject({ lead_count: 2, trigger_kind: 'SETTINGS_CHANGED' });
      expect(await db.spiderAlert.findMany({ where: { summary_id: summary!.id }, select: { lead_id: true } })).toEqual(
        expect.arrayContaining([{ lead_id: contacted }, { lead_id: newish }]),
      );
      expect(await alertsFor(alerted)).toHaveLength(1);
      expect((await alertsFor(alerted))[0]!.kind).toBe('ALERTED');
    });

    it('switched back on after a pause: the leads that went overdue while it was off arrive as a summary', async () => {
      const c = await company();
      await configure(c, { active: false });
      const ids = await Promise.all([lead(c, { createdAt: at(-2 * DAY) }), lead(c, { createdAt: at(-3 * DAY) })]);
      await runSpiderSweep(T0);
      expect(await db.spiderAlert.count({ where: { organization_id: c.org } })).toBe(0);
      // A trigger left waiting while off does nothing until Spider is on again.
      await configure(c, { active: false, trigger: at(-DAY) });
      await runSpiderSweep(at(2 * MIN));
      expect(await summaryOf(c.org)).toBeNull();

      await configure(c, { active: true, trigger: at(3 * MIN) });
      await runSpiderSweep(at(6 * MIN));
      expect(await summaryOf(c.org)).toMatchObject({ lead_count: 2 });
      for (const id of ids) expect((await alertsFor(id))[0]).toMatchObject({ kind: 'SUMMARIZED' });
      expect(await alertNotices(c.org)).toBe(0);
    });

    it('keeps one current summary: a new one supersedes the old, whose leads keep their claim and their link to it', async () => {
      const c = await company();
      await configure(c, { trigger: QUIET });
      const first = await lead(c, { createdAt: at(-3 * DAY) });
      await runSpiderSweep(T0);
      const old = await summaryOf(c.org);

      await configure(c, { trigger: at(2 * MIN), limits: { NEW: { enabled: true, value: 2, unit: 'HOUR' }, CONTACTED: { enabled: true, value: 1, unit: 'DAY' } } });
      const second = await lead(c, { status: 'CONTACTED', createdAt: at(-9 * DAY), contacted_at: at(-8 * DAY) });
      await runSpiderSweep(at(5 * MIN));

      const now = await summaryOf(c.org);
      expect(now!.id).not.toBe(old!.id);
      expect(await db.spiderSummary.count({ where: { organization_id: c.org, status: { not: 'SUPERSEDED' } } })).toBe(1);
      expect(await db.spiderSummary.findUniqueOrThrow({ where: { id: old!.id } })).toMatchObject({ status: 'SUPERSEDED' });
      expect((await alertsFor(first))[0]).toMatchObject({ kind: 'SUMMARIZED', summary_id: old!.id });
      expect((await alertsFor(second))[0]).toMatchObject({ kind: 'SUMMARIZED', summary_id: now!.id });
      await runSpiderSweep(at(10 * MIN));
      expect(await alertsFor(first)).toHaveLength(1);
    });

    it('emails at most the 50 most overdue leads, then "And N more"', async () => {
      const c = await company();
      await configure(c, { trigger: QUIET, channels: { in_app: true, email: true } });
      for (let i = 0; i < 63; i++) await lead(c, { createdAt: at(-(3 * DAY + i * HOUR)) });
      await runSpiderSweep(T0);
      const [mail] = mailTo(c.admin.email);
      expect(mail!.subject).toBe("Spider's starting summary: 63 of your leads are past their limit");
      const body = (mail!.html as string).split('<tbody>')[1]!.split('</tbody>')[0]!;
      expect(body.match(/<tr>/g)).toHaveLength(50);
      expect(mail!.html).toContain('<b>And 13 more.</b> See them all in ServWave.');
      // Most overdue first: the oldest lead (3 days 62 hours in New, 2-hour limit) heads the list, and the
      // 13 least overdue are the ones left to the link.
      const overs = [...body.matchAll(/>([^<>]+)&nbsp;over</g)].map((m) => m[1]);
      expect(overs[0]).toBe('5 days 12 hours');
      expect(overs[49]).toBe('3 days 11 hours');
      expect(body).not.toContain('>2 days 22 hours&nbsp;over<');
      expect(mail!.from).toContain('alerts@spider.servwave.com');
    });

    it('texts the email line when the email went out, and the link when it did not; texts count toward usage', async () => {
      const c = await company();
      await db.user.update({ where: { id: c.admin.id }, data: { phone: '+16175550202' } });
      const noMail = await person(c.org, 'ADMIN', { phone: '+16175550203' });
      // No email address on their profile: no summary email can reach them.
      await db.user.update({ where: { id: noMail.id }, data: { email: '' } });
      await configure(c, { trigger: QUIET, channels: { in_app: false, email: true, text: true } });
      await lead(c, { createdAt: at(-3 * DAY) });
      await lead(c, { createdAt: at(-4 * DAY) });
      const usageBefore = (await getCommUsage(c.org, { now: T0 })).texting.used;

      await runSpiderSweep(T0);

      expect(textsTo('+16175550202').map((m) => m.msg)).toEqual([
        'Spider sent you an email with your starting summary: 2 of your leads were already past their limit.',
      ]);
      expect(textsTo('+16175550203').map((m) => m.msg)).toEqual([
        `Spider found 2 of your leads already past their limit. See them: ${FRONTEND_URL}/spider/summary`,
      ]);
      expect((await getCommUsage(c.org, { now: T0 })).texting.used).toBe(usageBefore + 2);
      // In-app off: no bell entry.
      expect(await bellFor(c.org)).toEqual([]);
    });

    it('with Spider email off, the text carries the link to the summary page', async () => {
      const c = await company();
      await db.user.update({ where: { id: c.admin.id }, data: { phone: '+16175550204' } });
      await configure(c, { trigger: QUIET, channels: { in_app: true, email: false, text: true } });
      await lead(c, { createdAt: at(-3 * DAY) });
      await runSpiderSweep(T0);
      expect(textsTo('+16175550204').map((m) => m.msg)).toEqual([
        `Spider found 1 of your leads already past its limit. See it: ${FRONTEND_URL}/spider/summary`,
      ]);
      expect(mailTo(c.admin.email)).toEqual([]);
      expect((await summaryOf(c.org))!.delivery).toMatchObject({ email: { outcome: 'Email alerts are switched off' } });
    });

    it('never raises the red frame, even with in-app alerts off and the Red Frame on', async () => {
      const c = await company();
      await configure(c, { trigger: QUIET, channels: { in_app: false, red_frame: true } });
      await lead(c, { createdAt: at(-3 * DAY) });
      await runSpiderSweep(T0);
      expect(await summaryOf(c.org)).toMatchObject({ lead_count: 1 });
      expect(await alertNotices(c.org)).toBe(0);
      const frames = await db.notificationRecipient.count({ where: { organization_id: c.org, notification: { verb: 'spider.frame' } } });
      expect(frames).toBe(0);
    });

    // ─── Failures, retries and the bounded wait (verifier round 1) ───

    /** The timezone read the summary makes before it writes anything: fails for this company only. */
    function failSummaryReadFor(org: string, times = 1) {
      const original = db.organization.findUnique.bind(db.organization);
      let left = times;
      return vi.spyOn(db.organization, 'findUnique').mockImplementation(((args: { where: { id?: string }; select?: { timezone?: boolean } }) => {
        if (left > 0 && args.where.id === org && args.select?.timezone) {
          left -= 1;
          return Promise.reject(new Error('read failed')) as never;
        }
        return original(args as never);
      }) as never);
    }

    it('a summary that fails before its claims writes nothing, keeps the trigger, alerts nobody, and succeeds on the next run', async () => {
      const c = await company();
      await configure(c, { trigger: QUIET });
      const ids = [await lead(c, { createdAt: at(-3 * DAY) }), await lead(c, { createdAt: at(-4 * DAY) })];
      const spy = failSummaryReadFor(c.org);

      await runSpiderSweep(T0);
      spy.mockRestore();
      expect(await summaryOf(c.org)).toBeNull();
      expect(await db.spiderAlert.count({ where: { organization_id: c.org } })).toBe(0);
      expect(await alertNotices(c.org)).toBe(0);
      expect(await triggerOf(c.org)).toEqual(QUIET);

      await runSpiderSweep(at(2 * MIN));
      expect(await summaryOf(c.org)).toMatchObject({ lead_count: 2 });
      for (const id of ids) expect((await alertsFor(id))[0]).toMatchObject({ kind: 'SUMMARIZED' });
      expect(await alertNotices(c.org)).toBe(0);
      expect(await triggerOf(c.org)).toBeNull();
    });

    it('a delivery that fails after the claims keeps the claims and the summary, records the failure, and never re-alerts', async () => {
      const c = await company();
      await configure(c, { trigger: QUIET, channels: { in_app: true, email: true } });
      const id = await lead(c, { createdAt: at(-3 * DAY) });
      resendSend.mockRejectedValue(new Error('provider down'));

      await runSpiderSweep(T0);
      const summary = await summaryOf(c.org);
      expect(summary).toMatchObject({ lead_count: 1 });
      expect(summary!.delivery).toMatchObject({ in_app: { outcome: 'Shown in the app' }, email: { outcome: 'Email could not be delivered' } });
      const [row] = await alertsFor(id);
      expect(row).toMatchObject({ kind: 'SUMMARIZED', summary_id: summary!.id });
      expect(row!.channels).toMatchObject({ email: { enabled: true, status: 'FAILED', failed: 1 } });
      expect(await triggerOf(c.org)).toBeNull();

      await runSpiderSweep(at(2 * MIN));
      expect(await alertsFor(id)).toHaveLength(1);
      expect(await alertNotices(c.org)).toBe(0);
    });

    it('acts at most 10 minutes after the trigger first started waiting, even while saves keep coming', async () => {
      const c = await company();
      // Saved a minute ago, but waiting for 9 minutes: still within the bound, so still waiting.
      await configure(c, { trigger: at(-1 * MIN), triggerSince: at(-9 * MIN) });
      await lead(c, { createdAt: at(-3 * DAY) });
      await runSpiderSweep(T0);
      expect(await summaryOf(c.org)).toBeNull();

      // Another save a minute later; the trigger has now waited 10 minutes: acted on regardless.
      await db.spiderSettings.update({ where: { organization_id: c.org }, data: { summary_trigger_at: at(30_000) } });
      await runSpiderSweep(at(MIN));
      expect(await summaryOf(c.org)).toMatchObject({ lead_count: 1 });
      expect(await triggerOf(c.org)).toBeNull();
    });

    it('gives up on a summary that fails 3 attempts in a row (waits 2 and 8 minutes): drops the trigger, logs it once, and alerts per lead from then on', async () => {
      const c = await company();
      await configure(c, { trigger: at(-3 * MIN), triggerSince: at(-11 * MIN) });
      const id = await lead(c, { createdAt: at(-3 * DAY) });
      const spy = failSummaryReadFor(c.org, 3);
      const errors = vi.spyOn(logger, 'error');
      const gaveUp = () => errors.mock.calls.map(([m]) => String(m)).filter((m) => m.includes('gave up') && m.includes(c.org));

      await runSpiderSweep(T0);
      expect(await triggerOf(c.org)).not.toBeNull();
      await runSpiderSweep(at(2 * MIN));
      expect(await triggerOf(c.org)).not.toBeNull();
      expect(await alertsFor(id)).toEqual([]);
      await runSpiderSweep(at(10 * MIN));
      spy.mockRestore();
      expect(await summaryOf(c.org)).toBeNull();
      expect(await triggerOf(c.org)).toBeNull();
      expect(gaveUp()).toHaveLength(1);

      await runSpiderSweep(at(12 * MIN));
      expect(gaveUp()).toHaveLength(1);
      errors.mockRestore();
      expect((await alertsFor(id))[0]).toMatchObject({ kind: 'ALERTED' });
      expect(await spiderNotices(id)).toHaveLength(1);
    });

    it('switching on with nothing overdue removes the last summary; another trigger with nothing overdue keeps it', async () => {
      const c = await company();
      await configure(c, { trigger: QUIET, triggerKind: 'STAGE_ADDED' });
      await lead(c, { createdAt: at(-3 * DAY) });
      await runSpiderSweep(T0);
      expect(await summaryOf(c.org)).not.toBeNull();

      // A stage switched on with no backlog of its own keeps it.
      await configure(c, { trigger: at(2 * MIN), triggerKind: 'STAGE_ADDED' });
      await runSpiderSweep(at(5 * MIN));
      expect(await summaryOf(c.org)).not.toBeNull();

      // Switched on again with nothing new overdue: the card's summary goes, and nothing is sent.
      await configure(c, { trigger: at(6 * MIN), triggerKind: 'SWITCHED_ON' });
      await runSpiderSweep(at(9 * MIN));
      expect(await summaryOf(c.org)).toBeNull();
      expect(await bellFor(c.org)).toHaveLength(1);
      expect(await db.spiderAlert.count({ where: { organization_id: c.org } })).toBe(1);
    });

    it("records each summarized lead's History row with how its people were told", async () => {
      const c = await company();
      await configure(c, { trigger: QUIET, channels: { in_app: true, email: true, text: false } });
      const id = await lead(c, { createdAt: at(-3 * DAY) });
      await runSpiderSweep(T0);
      const [row] = await alertsFor(id);
      expect(row!.kind).toBe('SUMMARIZED');
      expect(row!.channels).toMatchObject({
        in_app: { enabled: true, status: 'SENT' },
        email: { enabled: true, status: 'SENT', sent: 1 },
        sms: { enabled: false, status: 'SKIPPED' },
      });
      expect(row!.recipients).toEqual([expect.objectContaining({ id: c.admin.id, type: 'admin' })]);
    });
  });

  describe('running', () => {
    it('server logs carry ids only - never an email address or phone number', async () => {
      const c = await company();
      const dispatcher = await person(c.org, 'DISPATCHER', { phone: '+16175550177' });
      await configure(c, { recipients: { roles: ['ADMIN', 'DISPATCHER'] }, channels: { email: true, text: true } });
      resendSend.mockResolvedValueOnce({ data: null, error: { name: 'x', message: `rejected ${dispatcher.email}` } });
      vi.mocked(ctm.sendSms).mockRejectedValueOnce(new Error('send to +16175550101 failed'));
      await lead(c);
      await runSpiderSweep(T0);

      const logged = JSON.stringify(
        (['info', 'warn', 'error', 'debug'] as const).flatMap((level) => vi.mocked(logger[level]).mock.calls),
      );
      expect(logged).not.toContain('@');
      for (const digits of ['6175550101', '6175550177', '6175559999']) expect(logged).not.toContain(digits);
    });

    it('never runs while another sweep holds the lease, and never overlaps itself', async () => {
      const c = await company();
      await configure(c);
      const id = await lead(c);
      await db.$executeRawUnsafe(
        `INSERT INTO spider_sweep_leases (name, holder, claimed_at, expires_at) VALUES ('spider.sweep', 'other-server', now(), now() + interval '1 minute')
         ON CONFLICT (name) DO UPDATE SET holder = EXCLUDED.holder, claimed_at = EXCLUDED.claimed_at, expires_at = EXCLUDED.expires_at`,
      );
      try {
        const blocked = await runSpiderSweep(T0);
        expect(blocked.ran).toBe(false);
        expect(await alertsFor(id)).toEqual([]);
      } finally {
        await db.$executeRawUnsafe(`DELETE FROM spider_sweep_leases WHERE name = 'spider.sweep'`);
      }

      const [first, second] = await Promise.all([runSpiderSweep(T0), runSpiderSweep(T0)]);
      expect([first.ran, second.ran].sort()).toEqual([false, true]);
      expect(await alertsFor(id)).toHaveLength(1);
    });
  });
});
