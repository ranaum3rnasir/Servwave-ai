/* =============================================================================
   #2990: the alert log, the bell and red-frame records, and the texting-usage count hold exactly what they
   held before Spider wrote them in bulk, byte for byte.

   One sweep raises per-lead alerts in companies set up for every delivery outcome (sent, failed, skipped
   for each reason, no phone, opted out, the staff-text deadline of #2995, channels off, the red frame
   alone, a mix in one alert, nobody to tell, a lead about to be re-alerted), a second sweep switches
   Spider off in the middle of an alert and re-alerts that lead in a new switched-on period (its earlier
   card ends), and a third sends a starting summary. Every alert-log row (texts_sent included), every
   Spider notification and every recipient row of those companies is read back as Postgres prints it
   (`to_jsonb(row)::text`: every column, the JSON exactly as stored; only the row's own random id and its
   wall-clock created_at left out), with ids and the run's random tag replaced by fixed labels, and
   compared with the record captured from the code before #2990 (fixtures/spider-delivery-records-2990.json),
   at the integration head that already stores each email's provider message id (#2997).
   One entry was changed by hand, by Ran's ruling of 2026-11-04 ("Next run", #2992): Spider switched off while an
   alert is being raised no longer skips that alert's text; the change takes effect from the next run. So in
   `org:switched-off-mid-alert` the text is sent and counted (delivery.text, channels.sms, texts_sent); its card is
   still ended at once, as before. Every other company's record is the old code's.

   One change by #3107 (recipient lists stored once): an alert-log row no longer holds its own copy of the people it told
   (`recipients` is NULL) and points at a stored list (`recipient_set_id`, labelled `recipientset:<company>`). The record
   was changed by that rule and nothing else - every other column of every row, every bell record and every recipient row
   is the old code's - and the stored lists (`recipient_sets`) are, one for one, the lists the old rows held.

   To capture the record again (only ever from the code before the change it guards):
     SPIDER_2990_CAPTURE=1 npx vitest run src/__tests__/spider-delivery-records-db.test.ts
   prints it between the two marker lines instead of comparing.

   Email is faked at the provider's client and texts at the phone system's client; everything between
   the sweep and those two boundaries is real. Real migrated database (TEST_DATABASE_URL); skips when it
   is unset. Every company it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { PrismaClient, Role } from '@prisma/client';

const { realClient, resendSend } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return {
    realClient: dbUrl ? new PrismaClient({ datasources: { db: { url: dbUrl } } }) : undefined,
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
    // One alert's emails go out as one batch request (#3470); this answers it from the per-email fake above.
    batch = { send: async (...a: [never, never?]) => (await import('./spider-batch-test-helpers.js')).batchOverSingleSends(resendSend as never)(...(a as [never, never])) };
  },
}));
vi.mock('../lib/email', async () => vi.importActual('../lib/email'));

import { runSpiderSweep } from '../services/spider/sweep';
import { SPIDER_SWEEP_LEASE } from '../services/spider/sweepLease';
import * as ctm from '../lib/ctm/client';
import { _resetCtmSmsDoubleFireGuard } from '../lib/ctm/sendSms';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const suite = realClient ? describe : describe.skip;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = new Date('2026-10-01T12:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const FIXTURE = path.join(__dirname, 'fixtures', 'spider-delivery-records-2990.json');
const CAPTURE = process.env.SPIDER_2990_CAPTURE === '1';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** How a person's email and text go, faked at the two providers. */
type Email = 'sent' | 'fails' | 'suppressed' | 'none';
type Text = 'sent' | 'fails' | 'deadline' | 'optout-deadline' | 'opted-out' | 'none';
interface PersonSpec { label: string; role: Role; email?: Email; text?: Text; login?: boolean }
interface CompanySpec {
  label: string;
  people: PersonSpec[];
  channels: { in_app: boolean; red_frame: boolean; email: boolean; text: boolean };
  roles: Role[];
  leads: number;
  org?: { email?: boolean; texting?: boolean; phonePlan?: boolean };
  trigger?: boolean;
}

const ON = { in_app: true, red_frame: true, email: true, text: true };
const COMPANIES: CompanySpec[] = [
  { label: 'all-sent', people: [{ label: 'admin', role: 'ADMIN' }, { label: 'disp', role: 'DISPATCHER' }], channels: ON, roles: ['ADMIN', 'DISPATCHER'], leads: 2 },
  { label: 'all-failed', people: [{ label: 'admin', role: 'ADMIN', email: 'fails', text: 'fails' }], channels: ON, roles: ['ADMIN'], leads: 1 },
  { label: 'company-off', people: [{ label: 'admin', role: 'ADMIN' }], channels: ON, roles: ['ADMIN'], leads: 1, org: { email: false, texting: false } },
  { label: 'no-phone-plan', people: [{ label: 'admin', role: 'ADMIN' }], channels: ON, roles: ['ADMIN'], leads: 1, org: { phonePlan: false } },
  { label: 'opted-out', people: [{ label: 'admin', role: 'ADMIN', email: 'suppressed', text: 'opted-out' }], channels: ON, roles: ['ADMIN'], leads: 1 },
  { label: 'no-phone', people: [{ label: 'admin', role: 'ADMIN', text: 'none' }], channels: { in_app: false, red_frame: false, email: true, text: true }, roles: ['ADMIN'], leads: 1 },
  { label: 'deadline', people: [{ label: 'admin', role: 'ADMIN', text: 'deadline' }, { label: 'disp', role: 'DISPATCHER', text: 'optout-deadline' }], channels: ON, roles: ['ADMIN', 'DISPATCHER'], leads: 1 },
  { label: 'frame-only', people: [{ label: 'admin', role: 'ADMIN' }], channels: { in_app: false, red_frame: true, email: false, text: false }, roles: ['ADMIN'], leads: 1 },
  { label: 'all-off', people: [{ label: 'admin', role: 'ADMIN' }], channels: { in_app: false, red_frame: false, email: false, text: false }, roles: ['ADMIN'], leads: 1 },
  {
    label: 'mixed',
    people: [
      { label: 'admin', role: 'ADMIN' },
      { label: 'disp', role: 'DISPATCHER', email: 'fails', text: 'none' },
      { label: 'disp2', role: 'DISPATCHER', email: 'suppressed', text: 'fails' },
    ],
    channels: ON,
    roles: ['ADMIN', 'DISPATCHER'],
    leads: 1,
  },
  { label: 'nobody', people: [{ label: 'admin', role: 'ADMIN', login: false }], channels: ON, roles: ['ADMIN'], leads: 1 },
  // Alerted in the first sweep; switched on again (a new period) before the second, which re-alerts it (D5).
  { label: 'realert', people: [{ label: 'admin', role: 'ADMIN' }], channels: ON, roles: ['ADMIN'], leads: 1 },
];
const SWITCHED_OFF: CompanySpec = { label: 'switched-off-mid-alert', people: [{ label: 'admin', role: 'ADMIN' }], channels: ON, roles: ['ADMIN'], leads: 1 };
const SUMMARY: CompanySpec = {
  label: 'summary',
  people: [{ label: 'admin', role: 'ADMIN' }, { label: 'disp', role: 'DISPATCHER', email: 'fails', text: 'fails' }],
  channels: ON,
  roles: ['ADMIN', 'DISPATCHER'],
  leads: 3,
  trigger: true,
};

suite('Spider alert-log records, unchanged by the bulk writes (#2990, real database)', () => {
  const db = realClient as PrismaClient;
  const tag = randomUUID().slice(0, 8);
  const orgs: string[] = [];
  /** Every id this file created, to its fixed label. */
  const labelOf = new Map<string, string>();
  const emailBehaviour = new Map<string, Email>();
  const textBehaviour = new Map<string, Text>();
  const suppressed: string[] = [];
  let phoneSeq = 0;

  const clearLease = () => db.$executeRawUnsafe(`DELETE FROM spider_sweep_leases WHERE name = $1`, SPIDER_SWEEP_LEASE);

  async function makeCompany(spec: CompanySpec): Promise<string> {
    const org = randomUUID();
    orgs.push(org);
    labelOf.set(org, `org:${spec.label}`);
    await db.organization.create({
      data: {
        id: org, name: `spider-records-${spec.label}-${tag}`, email: `org-${spec.label}-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        plan: 'SCALE', is_demo: true,
        feature_overrides: (spec.org?.phonePlan === false ? { phone: false } : {}) as never,
        email_sending_enabled: spec.org?.email ?? true,
        ctm_account_id: `acct-${spec.label}-${tag}`, ctm_sms_ready: true, sms_sending_enabled: spec.org?.texting ?? true,
      },
    });
    await db.phoneNumber.create({
      data: { organization_id: org, e164: '+16175550000', sms_enabled: true, ctm_number_id: `TPN-${spec.label}-${tag}`, status: 'active', is_org_default: true },
    });
    // Ids drawn first and sorted, so the people's order (recipients are ordered by id) is the spec's order every run.
    const ids = spec.people.map(() => randomUUID()).sort();
    for (const [i, p] of spec.people.entries()) {
      const id = ids[i]!;
      labelOf.set(id, `user:${spec.label}:${p.label}`);
      const email = `${spec.label}-${p.label}-${tag}@example.test`;
      const phone = p.text === 'none' ? null : `+1617555${String(1000 + ++phoneSeq).slice(-4)}`;
      await db.user.create({
        data: {
          id, organization_id: org, email, first_name: p.label, last_name: 'Tester', role: p.role, is_admin: p.role === 'ADMIN',
          phone, is_active: true, has_login: p.login ?? true,
        },
      });
      emailBehaviour.set(email, p.email ?? 'sent');
      if (phone) textBehaviour.set(phone, p.text ?? 'sent');
      if (p.email === 'suppressed') {
        await db.emailSuppression.create({ data: { address: email, kind: 'HARD_BOUNCE', category: 'TRANSACTIONAL' } });
        suppressed.push(email);
      }
    }
    const customer = randomUUID();
    labelOf.set(customer, `customer:${spec.label}`);
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer', phone: '+16175559999' },
    });
    for (let i = 0; i < spec.leads; i += 1) {
      const id = randomUUID();
      labelOf.set(id, `lead:${spec.label}:${i}`);
      await db.lead.create({
        data: {
          id, organization_id: org, customer_id: customer, lead_number: `L-${spec.label}-${i}-${tag}`, service_request: 'Fix the door',
          // Each lead a different age, so a summary's "most overdue first" order is fixed.
          status: 'NEW', created_at: at(-(3 + i) * DAY),
        },
      });
    }
    const off = { enabled: false, value: 1, unit: 'DAY' };
    await db.spiderSettings.create({
      data: {
        organization_id: org,
        is_active: true,
        activated_at: at(-60 * DAY),
        status_limits: { NEW: { enabled: true, value: 2, unit: 'HOUR' }, CONTACTED: off, WALKTHROUGH_COMPLETED: off },
        channels: spec.channels,
        recipients: { roles: spec.roles, user_ids: [], lead_owner: false },
        watch_all_leads: true,
        selected_lead_ids: [],
        summary_trigger_at: spec.trigger ? at(-HOUR) : null,
        summary_trigger_since: spec.trigger ? at(-HOUR) : null,
        summary_trigger_kind: spec.trigger ? 'SWITCHED_ON' : null,
      },
    });
    return org;
  }

  /** `recipient_sets` are the stored lists of people (#3107): what each alert row used to hold in its own `recipients` column. */
  type Captured = Record<string, { alerts: string[]; notifications: string[]; recipients: string[]; recipient_sets: string[] }>;
  const clean = (text: string) => text.replace(UUID, (id) => labelOf.get(id) ?? 'UNKNOWN-ID').split(tag).join('TAG');

  /** Every alert-log row, Spider notification and recipient row of these companies, exactly as Postgres prints them, with fixed labels for the ids. */
  async function records(): Promise<Captured> {
    const summaries = await db.spiderSummary.findMany({ where: { organization_id: { in: orgs } }, select: { id: true, organization_id: true } });
    for (const s of summaries) labelOf.set(s.id, `summary:${labelOf.get(s.organization_id)}`);
    // A company's people are stored once per distinct list (#3107); every company here tells the same people each time.
    // The set's hash is of the real ids and addresses, so it is left out of the record like a row's own random id.
    const sets = await db.$queryRawUnsafe<{ org: string; id: string; row: string }[]>(
      `SELECT organization_id::text AS org, id::text AS id, (to_jsonb(s) - 'id' - 'hash' - 'created_at')::text AS row
         FROM spider_recipient_sets s WHERE organization_id = ANY($1::uuid[])`,
      orgs,
    );
    for (const s of sets) labelOf.set(s.id, `recipientset:${labelOf.get(s.org)}`);
    const alerts = await db.$queryRawUnsafe<{ org: string; lead: string; id: string; row: string }[]>(
      `SELECT organization_id::text AS org, lead_id::text AS lead, id::text AS id, (to_jsonb(a) - 'id')::text AS row
         FROM spider_alerts a WHERE organization_id = ANY($1::uuid[]) ORDER BY lead_id, counted_from`,
      orgs,
    );
    // An alert's own id is random and is only ever named by its own row; it stays out (above), and any
    // other place it appears is labelled by its lead and its place among that lead's alerts.
    const seen = new Map<string, number>();
    for (const r of alerts) {
      const n = seen.get(r.lead) ?? 0;
      seen.set(r.lead, n + 1);
      labelOf.set(r.id, `alert:${labelOf.get(r.lead)}:${n}`);
    }
    const notifications = await db.$queryRawUnsafe<{ org: string; id: string; dedup: string | null; row: string }[]>(
      `SELECT organization_id::text AS org, id::text AS id, dedup_key AS dedup, (to_jsonb(n) - 'id' - 'created_at')::text AS row
         FROM notifications n WHERE organization_id = ANY($1::uuid[]) AND verb LIKE 'spider.%'`,
      orgs,
    );
    for (const n of notifications) labelOf.set(n.id, `notification:${clean(n.dedup ?? 'none')}`);
    const recipients = await db.$queryRawUnsafe<{ org: string; row: string }[]>(
      `SELECT r.organization_id::text AS org, (to_jsonb(r) - 'id' - 'created_at')::text AS row
         FROM notification_recipients r JOIN notifications n ON n.id = r.notification_id
        WHERE r.organization_id = ANY($1::uuid[]) AND n.verb LIKE 'spider.%'`,
      orgs,
    );
    const out: Captured = {};
    for (const org of orgs) out[labelOf.get(org)!] = { alerts: [], notifications: [], recipients: [], recipient_sets: [] };
    for (const r of alerts) out[labelOf.get(r.org)!]!.alerts.push(clean(r.row));
    for (const r of notifications) out[labelOf.get(r.org)!]!.notifications.push(clean(r.row));
    for (const r of recipients) out[labelOf.get(r.org)!]!.recipients.push(clean(r.row));
    for (const r of sets) out[labelOf.get(r.org)!]!.recipient_sets.push(clean(r.row));
    for (const c of Object.values(out)) for (const list of Object.values(c)) list.sort();
    return out;
  }

  let captured: Captured;

  beforeAll(async () => {
    // Other files' companies must not alert inside these sweeps (they have their own runs).
    await db.spiderSettings.updateMany({
      where: { organization: { name: { startsWith: 'spider-records-' } } },
      data: { is_active: false, summary_trigger_at: null, summary_trigger_kind: null, summary_trigger_since: null },
    });
    _resetCtmSmsDoubleFireGuard();
    clearPermissionCache();
    resendSend.mockImplementation(async (m: { to: string }) => {
      const how = emailBehaviour.get(m.to);
      // Each email's provider id names its person, so a record that kept the wrong person's id (#2997) shows.
      return how === 'fails' ? { data: null, error: { name: 'application_error', message: 'boom' } } : { data: { id: `msg-${m.to}` }, error: null };
    });
    vi.mocked(ctm.isCtmConfigured).mockReturnValue(true);
    vi.mocked(ctm.isOutboundAllowed).mockReturnValue(true);
    vi.mocked(ctm.isOptedOut).mockImplementation(async (_account: string, to: string) => {
      const how = textBehaviour.get(to);
      if (how === 'optout-deadline') throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      return how === 'opted-out';
    });
    vi.mocked(ctm.sendSms).mockImplementation((async (_account: string, m: { to: string }) => {
      const how = textBehaviour.get(m.to);
      if (how === 'fails') throw new (ctm.CtmApiError as unknown as new (s: number, r: string) => Error)(500, 'server error');
      if (how === 'deadline') throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      return { id: 'sms_1' };
    }) as never);

    // 1. Per-lead alerts, every outcome.
    for (const spec of COMPANIES) await makeCompany(spec);
    await clearLease();
    expect((await runSpiderSweep(T0)).ran).toBe(true);

    // 2. Spider switched off while an alert is being raised: after its email, before its text. The alert still goes out
    // in full and its card is ended at once (Ran, 2026-11-04, "Next run"). And the lead alerted in the first sweep, in a
    // new switched-on period: it is re-alerted, and its earlier card ends.
    const realertOrg = orgs[COMPANIES.findIndex((c) => c.label === 'realert')]!;
    await db.spiderSettings.update({ where: { organization_id: realertOrg }, data: { activated_at: at(500) } });
    const offOrg = await makeCompany(SWITCHED_OFF);
    const behaviour = resendSend.getMockImplementation()!;
    let first = true;
    resendSend.mockImplementation(async (m: { to: string }) => {
      if (first && m.to.startsWith(SWITCHED_OFF.label)) {
        first = false;
        await db.spiderSettings.update({ where: { organization_id: offOrg }, data: { is_active: false } });
      }
      return behaviour(m);
    });
    await clearLease();
    expect((await runSpiderSweep(at(1000))).ran).toBe(true);
    resendSend.mockImplementation(behaviour);

    // 3. A starting summary.
    await makeCompany(SUMMARY);
    await clearLease();
    expect((await runSpiderSweep(at(2000))).ran).toBe(true);

    captured = await records();
    if (CAPTURE) {
      process.stdout.write(`\n=====2990-CAPTURE-BEGIN=====\n${JSON.stringify(captured, null, 2)}\n=====2990-CAPTURE-END=====\n`);
    }
  }, 120_000);

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    await quietly(clearLease());
    await quietly(db.emailSuppression.deleteMany({ where: { address: { in: suppressed } } }));
    for (const org of orgs) {
      await quietly(db.spiderSettings.deleteMany({ where: { organization_id: org } }));
      for (const table of ['spider_alerts', 'spider_summaries', 'notifications', 'leads', 'phone_numbers', 'customers', 'users']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = $1::uuid`, org));
      }
      await quietly(db.organization.deleteMany({ where: { id: org } }));
    }
    await db.$disconnect();
  });

  it('raised the alerts it was set up to raise (the record below is not empty by accident)', () => {
    expect(captured['org:all-sent']!.alerts).toHaveLength(2);
    expect(captured['org:all-sent']!.notifications).toHaveLength(2);
    expect(captured['org:all-sent']!.recipients).toHaveLength(4);
    expect(captured['org:nobody']).toEqual({ alerts: [], notifications: [], recipients: [], recipient_sets: [] });
    expect(captured['org:frame-only']!.notifications.join()).toContain('"verb": "spider.frame"');
    expect(captured['org:summary']!.alerts).toHaveLength(3);
    expect(captured['org:switched-off-mid-alert']!.alerts).toHaveLength(1);
    // Switched off mid-alert (#2992, "Next run"): the text still went and was counted; the card is ended.
    expect(captured['org:switched-off-mid-alert']!.alerts[0]).toContain('"text": {"outcome": "Text message sent"');
    expect(captured['org:switched-off-mid-alert']!.alerts[0]).toContain('"texts_sent": 1');
    expect(captured['org:switched-off-mid-alert']!.recipients.every((r) => !r.includes('"read_at": null'))).toBe(true);
    // The re-alert: two alerts, two cards, the earlier one ended by the second sweep.
    expect(captured['org:realert']!.alerts).toHaveLength(2);
    expect(captured['org:realert']!.recipients.filter((r) => r.includes('"read_at": null'))).toHaveLength(1);
    // The records carry each sent email's provider message id (#2997), per person, and the texts each counted.
    expect(captured['org:all-sent']!.alerts[0]).toContain('"message_id": "msg-all-sent-admin-TAG@example.test"');
    expect(captured['org:all-sent']!.alerts[0]).toContain('"message_id": "msg-all-sent-disp-TAG@example.test"');
    expect(captured['org:all-sent']!.alerts[0]).toContain('"texts_sent": 2');
    for (const c of Object.values(captured)) for (const list of Object.values(c)) for (const row of list) expect(row).not.toContain('UNKNOWN-ID');
  });

  const expected = (): Captured => JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const allCompanies = [...COMPANIES, SWITCHED_OFF, SUMMARY].map((c) => `org:${c.label}`);
  for (const company of allCompanies) {
    it.skipIf(CAPTURE)(`${company}: every alert-log row is byte for byte what the code before #2990 wrote`, () => {
      expect(captured[company]!.alerts).toEqual(expected()[company]!.alerts);
    });
    it.skipIf(CAPTURE)(`${company}: the list of people each alert told is, set by set, the list the alert rows held before #3107`, () => {
      expect(captured[company]!.recipient_sets).toEqual(expected()[company]!.recipient_sets);
    });
    it.skipIf(CAPTURE)(`${company}: every bell and frame record and recipient row is byte for byte what the code before #2990 wrote`, () => {
      expect({ notifications: captured[company]!.notifications, recipients: captured[company]!.recipients })
        .toEqual({ notifications: expected()[company]!.notifications, recipients: expected()[company]!.recipients });
    });
  }

  it.skipIf(CAPTURE)('the record covers exactly these companies', () => {
    expect(Object.keys(expected()).sort()).toEqual([...allCompanies].sort());
  });
});
