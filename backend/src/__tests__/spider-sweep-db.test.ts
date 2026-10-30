/* =============================================================================
   Spider lead watcher (#2619) - Seam C: the sweep against a real migrated database.

   The sweep runs at chosen clock times against real companies, leads, History (timeline) rows,
   notifications and the Spider alert log. Email is faked at the provider's client and texts at the
   phone system's client - everything between the sweep and those two boundaries is real: the
   gate, the recipient rule, the claim, the bell's emit, the email brakes and the text gates.

   Covers #2622 (alerting), #2623 (ending), #2625 (email) and #2626 (text).
   Skips when TEST_DATABASE_URL is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { LeadStatus, PrismaClient, Role } from '@prisma/client';

const { realClient, resendSend } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return {
    realClient: dbUrl ? new PrismaClient({ datasources: { db: { url: dbUrl } } }) : undefined,
    resendSend: vi.fn(),
  };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));

const FRONTEND_URL = 'https://staging.app.test';
vi.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'test',
    EMAIL_FROM: 'no-reply@test.com',
    EMAIL_FROM_BUSINESS: 'no-reply@mail.test.com',
    RESEND_API_KEY: 're_test_key',
    FRONTEND_URL: 'https://staging.app.test',
    // The sweep opens its lock on a connection of its own, to the same database as the app's client.
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://test:test@localhost:5432/test',
  },
}));

// The email provider's client is the boundary: the real lib/email runs, its client is fake.
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: resendSend };
  },
}));
vi.mock('../lib/email', async () => vi.importActual('../lib/email'));

import { runSpiderSweep } from '../services/spider/sweep';
import { getCommUsage } from '../lib/comm-usage';
import { logger } from '../lib/logger';
import * as ctm from '../lib/ctm/client';
import { _resetCtmSmsDoubleFireGuard } from '../lib/ctm/sendSms';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const suite = realClient ? describe : describe.skip;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = new Date('2026-10-01T12:00:00.000Z');
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);

type Limit = { enabled: boolean; value: number; unit: 'MINUTE' | 'HOUR' | 'DAY' };
const ALL_OFF: Record<string, Limit> = {
  NEW: { enabled: false, value: 1, unit: 'DAY' },
  CONTACTED: { enabled: false, value: 1, unit: 'DAY' },
  WALKTHROUGH_SCHEDULED: { enabled: false, value: 1, unit: 'DAY' },
  WALKTHROUGH_COMPLETED: { enabled: false, value: 1, unit: 'DAY' },
  ESTIMATED: { enabled: false, value: 1, unit: 'DAY' },
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

  beforeEach(() => {
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
      for (const table of ['notifications', 'timeline_events', 'leads', 'phone_numbers', 'role_permissions', 'customers', 'users']) {
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
      await db.rolePermission.create({
        data: { organization_id: org, role: g.role, action: g.action, subject: g.subject, conditions: (g.conditions ?? undefined) as never },
      });
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
        id, organization_id: org, email, first_name: `${role.toLowerCase()}${seq}`, last_name: 'Tester', role,
        phone: opts.phone ?? null, is_active: opts.active ?? true, has_login: opts.login ?? true,
      },
    });
    return { id, email };
  }

  async function lead(c: Company, opts: { status?: LeadStatus; createdAt?: Date; owner?: string } = {}) {
    const id = randomUUID();
    await db.lead.create({
      data: {
        id, organization_id: c.org, customer_id: c.customer, lead_number: `L-${id.slice(0, 8)}`, service_request: 'Fix the door',
        status: opts.status ?? 'NEW', created_at: opts.createdAt ?? at(-30 * DAY), commission_owner_id: opts.owner ?? null,
      },
    });
    return id;
  }

  /** A status move the way the single status writer records it: the row and a History entry. */
  async function move(c: Company, leadId: string, from: LeadStatus, to: LeadStatus, when: Date) {
    await db.lead.update({ where: { id: leadId }, data: { status: to } });
    await db.timelineEvent.create({
      data: {
        organization_id: c.org, entity_type: 'LEAD', entity_id: leadId, event_type: 'STATUS_CHANGE',
        description: `${from} -> ${to}`, metadata: { from, to }, created_at: when,
      },
    });
  }

  async function configure(c: Company, opts: {
    active?: boolean;
    activatedAt?: Date;
    limits?: Record<string, Limit>;
    channels?: Partial<{ in_app: boolean; red_frame: boolean; email: boolean; text: boolean }>;
    recipients?: { roles?: Role[]; user_ids?: string[]; lead_owner?: boolean };
    watchAll?: boolean;
    selected?: string[];
  } = {}) {
    const data = {
      is_active: opts.active ?? true,
      activated_at: opts.activatedAt ?? at(-60 * DAY),
      status_limits: { ...ALL_OFF, ...(opts.limits ?? { NEW: { enabled: true, value: 2, unit: 'HOUR' } }) },
      channels: { in_app: true, red_frame: true, email: false, text: false, ...(opts.channels ?? {}) },
      recipients: { roles: [], user_ids: [], lead_owner: false, ...(opts.recipients ?? {}) },
      watch_all_leads: opts.watchAll ?? true,
      selected_lead_ids: opts.selected ?? [],
    };
    await db.spiderSettings.upsert({ where: { organization_id: c.org }, create: { organization_id: c.org, ...data }, update: data });
  }

  const alertsFor = (leadId: string) => db.spiderAlert.findMany({ where: { lead_id: leadId }, orderBy: { alerted_at: 'asc' } });

  async function spiderNotices(leadId: string) {
    return db.notificationRecipient.findMany({
      where: { notification: { verb: 'spider.alert', object_id: leadId } },
      select: { recipient_id: true, read_at: true },
      orderBy: { recipient_id: 'asc' },
    });
  }

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

    it('checks every open lead - 160 of them - with no cap', async () => {
      const c = await company();
      await configure(c, { channels: { in_app: false } });
      await db.lead.createMany({
        data: Array.from({ length: 160 }, (_, i) => ({
          id: randomUUID(), organization_id: c.org, customer_id: c.customer, lead_number: `B-${i}`,
          service_request: 'Fix', status: 'NEW' as const, created_at: at(-5 * HOUR),
        })),
      });
      const result = await runSpiderSweep(T0);
      expect(await db.spiderAlert.count({ where: { organization_id: c.org } })).toBe(160);
      expect(result.leadsChecked).toBeGreaterThanOrEqual(160);
    });

    it('measures time from the History entry into the current status, not from creation, and an edit never resets it', async () => {
      const c = await company();
      await configure(c, { limits: { CONTACTED: { enabled: true, value: 2, unit: 'HOUR' } } });
      const id = await lead(c, { createdAt: at(-10 * DAY) });
      await move(c, id, 'NEW', 'CONTACTED', at(-1 * HOUR));

      await runSpiderSweep(T0);
      expect(await alertsFor(id)).toEqual([]);

      // Editing the lead (a note, a phone number) changes nothing Spider reads.
      await db.lead.update({ where: { id }, data: { service_request: 'Fix the door and the frame' } });
      await runSpiderSweep(at(1 * HOUR + MIN));
      const [alert] = await alertsFor(id);
      expect(alert.status).toBe('CONTACTED');
      expect(alert.entered_status_at).toEqual(at(-1 * HOUR));
    });

    it('reads only History entries INTO the current status', async () => {
      const c = await company();
      await configure(c, { limits: { CONTACTED: { enabled: true, value: 2, unit: 'HOUR' } } });
      const id = await lead(c, { createdAt: at(-10 * DAY) });
      await move(c, id, 'NEW', 'CONTACTED', at(-3 * HOUR));
      // A later entry into another status that the lead is not in (an older path wrote History
      // without moving the row) must not restart the Contacted clock.
      await db.timelineEvent.create({
        data: {
          organization_id: c.org, entity_type: 'LEAD', entity_id: id, event_type: 'STATUS_CHANGE',
          description: 'x', metadata: { from: 'CONTACTED', to: 'WALKTHROUGH_SCHEDULED' }, created_at: at(-1 * HOUR),
        },
      });
      await runSpiderSweep(T0);
      const [alert] = await alertsFor(id);
      expect(alert?.entered_status_at).toEqual(at(-3 * HOUR));
    });

    it('never counts from earlier than the moment Spider was switched on', async () => {
      const c = await company();
      await configure(c, { activatedAt: at(-1 * HOUR), limits: { NEW: { enabled: true, value: 1, unit: 'DAY' } } });
      const id = await lead(c, { createdAt: at(-10 * DAY) });

      await runSpiderSweep(T0);
      expect(await alertsFor(id)).toEqual([]);

      await runSpiderSweep(at(23 * HOUR + MIN));
      const [alert] = await alertsFor(id);
      expect(alert.counted_from).toEqual(at(-1 * HOUR));
      expect(alert.entered_status_at).toEqual(at(-10 * DAY));
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

    it('with "watch all open leads" off, only the selected leads alert', async () => {
      const c = await company();
      const watched = await lead(c);
      const unwatched = await lead(c);
      await configure(c, { watchAll: false, selected: [watched] });
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

    it('a failed alert-log write sends nothing on any channel and is logged', async () => {
      const c = await company();
      await configure(c, { channels: { email: true, text: true } });
      const id = await lead(c);
      const spy = vi.spyOn(db.spiderAlert, 'create').mockRejectedValueOnce(new Error('disk full'));
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
      const id = await lead(c, { createdAt: at(-10 * DAY) });
      await move(c, id, 'NEW', 'CONTACTED', at(-3 * HOUR));
      const other = await db.notification.create({
        data: { organization_id: c.org, verb: 'lead.assigned', category: 'LEAD', priority: 'INTERRUPT', object_type: 'LEAD', object_id: id, title: 'x' },
      });
      await db.notificationRecipient.create({ data: { notification_id: other.id, organization_id: c.org, recipient_id: dispatcher.id, priority: 'INTERRUPT' } });

      await runSpiderSweep(T0);
      expect((await spiderNotices(id)).every((n) => n.read_at === null)).toBe(true);

      // Still in the alerted visit: stays unread.
      await runSpiderSweep(at(2 * MIN));
      expect((await spiderNotices(id)).every((n) => n.read_at === null)).toBe(true);

      await move(c, id, 'CONTACTED', 'WALKTHROUGH_SCHEDULED', at(5 * MIN));
      await runSpiderSweep(at(6 * MIN));

      const notices = await spiderNotices(id);
      expect(notices).toHaveLength(2);
      expect(notices.every((n) => n.read_at !== null)).toBe(true);
      expect(await alertsFor(id)).toHaveLength(1);
      const untouched = await db.notificationRecipient.findFirst({ where: { notification_id: other.id } });
      expect(untouched?.read_at).toBeNull();
    });

    it('ends the alert when the lead is won or lost', async () => {
      const c = await company();
      await configure(c);
      const ids = [await lead(c), await lead(c)];
      await runSpiderSweep(T0);
      await move(c, ids[0], 'NEW', 'WON', at(MIN));
      await move(c, ids[1], 'NEW', 'LOST', at(MIN));
      await runSpiderSweep(at(2 * MIN));
      for (const id of ids) expect((await spiderNotices(id))[0].read_at).not.toBeNull();
    });

    it('a lead that leaves a status and comes back is watched again and alerts once more for the new visit', async () => {
      const c = await company();
      await configure(c, { limits: { CONTACTED: { enabled: true, value: 2, unit: 'HOUR' } } });
      const id = await lead(c, { createdAt: at(-10 * DAY) });
      await move(c, id, 'NEW', 'CONTACTED', at(-3 * HOUR));
      await runSpiderSweep(T0);

      await move(c, id, 'CONTACTED', 'WALKTHROUGH_SCHEDULED', at(HOUR));
      await move(c, id, 'WALKTHROUGH_SCHEDULED', 'CONTACTED', at(2 * HOUR));
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
      await move(off, a, 'NEW', 'CONTACTED', at(MIN));
      await move(revoked, b, 'NEW', 'CONTACTED', at(MIN));
      await runSpiderSweep(at(2 * MIN));
      expect((await spiderNotices(a))[0].read_at).not.toBeNull();
      expect((await spiderNotices(b))[0].read_at).not.toBeNull();
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
      await move(b, bLead, 'NEW', 'CONTACTED', at(MIN));
      await runSpiderSweep(at(2 * MIN));
      expect((await spiderNotices(aLead))[0].read_at).toBeNull();
      expect((await spiderNotices(bLead))[0].read_at).not.toBeNull();
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
      const realUpdate = db.spiderAlert.update.bind(db.spiderAlert);
      const spy = vi.spyOn(db.spiderAlert, 'update').mockImplementation(((args: { data: { delivery?: unknown } }) =>
        args.data.delivery ? Promise.reject(new Error('lost')) : realUpdate(args as never)) as never);
      try {
        await runSpiderSweep(T0);
      } finally {
        spy.mockRestore();
      }
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

  // ─── Running ───────────────────────────────────────────────────────────────

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

    it('never runs while another sweep holds the lock, and never overlaps itself', async () => {
      const c = await company();
      await configure(c);
      const id = await lead(c);
      const { PrismaClient } = await import('@prisma/client');
      const other = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL! } } });
      try {
        let release!: () => void;
        const held = new Promise<void>((r) => (release = r));
        let locked!: () => void;
        const lockTaken = new Promise<void>((r) => (locked = r));
        const holder = other.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('spider.sweep', 0))::text`;
          locked();
          await held;
        }, { timeout: 30_000 });
        await lockTaken;
        const blocked = await runSpiderSweep(T0);
        release();
        await holder;
        expect(blocked.ran).toBe(false);
        expect(await alertsFor(id)).toEqual([]);
      } finally {
        await other.$disconnect();
      }

      const [first, second] = await Promise.all([runSpiderSweep(T0), runSpiderSweep(T0)]);
      expect([first.ran, second.ran].sort()).toEqual([false, true]);
      expect(await alertsFor(id)).toHaveLength(1);
    });
  });
});
