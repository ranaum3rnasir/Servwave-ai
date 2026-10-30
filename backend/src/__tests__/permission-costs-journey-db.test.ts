/* =============================================================================
   Roles & Permissions security fixes, M4 (ticket 35): the real journeys behind "staff email totals" and "bell alert amounts".

   Three journeys, each from the real door to what the teammate receives, on a real migrated database (TEST_DATABASE_URL; the
   suite skips when it is unset). Only the mail provider's client (and the text provider's recorder) are replaced.

   1. An automation sends a staff email that carries the estimate's total and the customer's private link
      ({{estimate.total}}, {{estimate.link}}): the real context loader and the real executor run. A teammate without See
      prices gets the email with those two fields empty; the customer, in the very same send, gets them. A teammate WITH See
      prices gets them. A figure typed into the body by the author is text and stays whatever the reader holds (Ran, 2026-10-28:
      messages are never scanned). The same for a text to a teammate.
   2. The workflow test-send ("send to me"): a person without See prices tests an automation whose copy renders the sample
      total and link: the preview they are shown and the email they are sent leave those fields empty; with See prices they
      are there.
   3. A bell alert about a payment reaches a teammate: someone takes a payment on an invoice of a job the teammate is crewed on,
      and the teammate's bell carries the alert, with no amount in it whatever they hold (Ran, 2026-10-28: a bell names no figure).
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient, Role } from '@prisma/client';

const { realClient, resendSend, recordSms } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined, resendSend: vi.fn(), recordSms: vi.fn() };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));
// Only the mail provider's client is faked.
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: resendSend };
    domains = { create: vi.fn(), get: vi.fn(), verify: vi.fn(), remove: vi.fn() };
  },
}));
// The text provider's recorder: it keeps the body each handset was sent.
vi.mock('../services/automations/smsRecord', () => ({ recordOutboundSms: recordSms }));
// The suite-wide setup replaces the dispatcher with a stub; here the real one runs.
vi.mock('../lib/email', async (importOriginal) => {
  const { env } = await import('../config/env.js');
  Object.assign(env, {
    RESEND_API_KEY: 're_test_key', MAILBOX_DOMAIN: 'staging.mail.test.com', EMAIL_FROM_BUSINESS: 'no-reply@mail.test.com',
    EMAIL_REPLY_DOMAIN: 'reply.test.com',
  });
  return importOriginal();
});

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG, type SwitchValue } from '../lib/permissions/switches/catalog';
import { reviewAttentionSettled } from '../services/notifications/reviewAttentionQueue';

const suite = realClient ? describe : describe.skip;
const keyOf = (label: string) => SWITCH_CATALOG.find((s) => s.label === label)!.key;
const SEE_PRICES = keyOf('See prices');
const CUSTOMER_EMAIL = 'angel@example.com';
const TYPED = 'Reminder: the shop minimum is $75.';

suite('M4: the staff email total, the staff text and the bell amount reach a teammate only with See prices (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  const orgs: string[] = [];
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      for (const table of ['notification_recipients', 'notifications', 'email_read_states', 'email_attachments', 'emails', 'reply_tokens', 'email_threads',
        'mailbox_readers', 'mailbox_addresses', 'mailboxes', 'payments', 'workflow_step_runs', 'workflow_enrollments', 'workflow_versions', 'workflow_steps', 'workflows']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
    }
    await fx.cleanup();
  });
  beforeEach(() => {
    TOKEN = randomUUID();
    resendSend.mockReset();
    resendSend.mockImplementation(async () => ({ data: { id: `re_${randomUUID()}` }, error: null }));
    recordSms.mockReset();
    recordSms.mockImplementation(async () => ({ threadId: randomUUID(), messageId: randomUUID(), delivery: { delivered: true } }));
  });

  let sequence = 0;
  const ALL_OFF = Object.fromEntries(SWITCH_CATALOG.filter((s) => s.kind === 'toggle').map((s) => [s.key, false]));

  /** A company that sends mail, with its main mailbox, a customer with an email, and a SENT estimate with a customer link. */
  async function newOrg() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    const part = `co${made.tag}`;
    await db.organization.update({ where: { id: made.org }, data: { email_sending_enabled: true, email_sender_local_part: part } });
    await db.customer.update({ where: { id: made.customer }, data: { email: CUSTOMER_EMAIL } });
    const main = await db.mailbox.create({ data: { organization_id: made.org, kind: 'main', status: 'active' }, select: { id: true } });
    await db.mailboxAddress.create({ data: { local_part: part, organization_id: made.org, mailbox_id: main.id, is_primary: true } });
    return made;
  }

  /** A teammate on a custom role made from blank holding exactly these switches (See prices as told). */
  async function teammate(org: string, seesPrices: boolean, values: Record<string, SwitchValue> = {}): Promise<Person & { key: string }> {
    const key = `m4-journey-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'TECHNICIAN', { madeFromBlank: true, copyGrants: false });
    await setRoleSwitchValues({
      organizationId: org, roleKey: key, actorId: null, reason: 'manual',
      values: { ...ALL_OFF, view_estimates: true, view_jobs: true, jobs_scope: 'all', view_invoices: true, [SEE_PRICES]: seesPrices, ...values },
    });
    const person = await fx.addUser(org, `m4j${sequence}`, 'TECHNICIAN', { customRoleId: role.id });
    await db.user.update({ where: { id: person.id }, data: { phone: `+1555555${String(1000 + sequence)}` } });
    return Object.assign(person, { key });
  }
  const setPrices = (org: string, key: string, on: boolean) =>
    setRoleSwitchValues({ organizationId: org, roleKey: key, actorId: null, reason: 'manual', values: { [SEE_PRICES]: on } });

  const BODY = `Estimate {{estimate.number}} total {{estimate.total}}. Open it: {{estimate.link}}. ${TYPED}`;
  let TOKEN = randomUUID();

  async function runAutomation(org: string, entity: { type: string; id: string }, actionType: 'SEND_EMAIL' | 'SEND_SMS', config: Record<string, unknown>) {
    const { loadExecutionBundle } = await import('../services/automations/context.js');
    const { executeAction } = await import('../services/automations/executors.js');
    const loaded = await loadExecutionBundle({ entityType: entity.type, entityId: entity.id, organizationId: org, dedupeKey: `m4:${randomUUID()}` });
    expect(loaded, 'the entity loads').not.toBeNull();
    return executeAction(
      { id: randomUUID(), name: 'Estimate approved', action_type: actionType, action_config: { subject: 'Estimate {{estimate.number}} total {{estimate.total}}', body: BODY, ...config }, organization_id: org } as never,
      loaded!.bundle,
    );
  }
  type Sent = { to: string; subject: string; text: string; html: string };
  const sentTo = (address: string) => resendSend.mock.calls.map((c) => c[0] as Sent).find((m) => m.to === address)!;

  /** An estimate of $100 created by this person, sent, with a customer link. */
  async function sentEstimate(org: string, customer: string, creator: Person) {
    const est = await fx.addEstimate(org, customer, creator.id);
    await db.estimate.update({ where: { id: est.id }, data: { status: 'SENT', sent_at: new Date(), public_token: TOKEN, total_amount: 100 } });
    return est.id;
  }

  describe('1. the automation staff email', () => {
    it('the teammate without See prices gets the email without the total or the link; the customer, in the same send, gets both', async () => {
      const w = await newOrg();
      const creator = await teammate(w.org, false);
      const estimate = await sentEstimate(w.org, w.customer, creator);

      const res = await runAutomation(w.org, { type: 'estimate', id: estimate }, 'SEND_EMAIL', { recipients: ['customer', 'creator'] });
      expect(res.status).toBe('SENT');

      const staff = sentTo(creator.email);
      expect(staff, 'the teammate was mailed').toBeDefined();
      for (const part of [staff.subject, staff.text, staff.html]) {
        expect(part).not.toContain('$100.00');
        expect(part).not.toContain(TOKEN);
        expect(part).not.toContain('/p/estimates/');
      }
      expect(staff.subject).toMatch(/^Estimate E-/);
      // The words the author typed are text, not a field: they stay.
      expect(staff.text).toContain(TYPED);

      const customer = sentTo(CUSTOMER_EMAIL);
      expect(customer.text).toContain('$100.00');
      expect(customer.text).toContain(`/p/estimates/${estimate}?token=${TOKEN}`);
      expect(customer.subject).toContain('$100.00');
      expect(customer.text).toContain(TYPED);
    });

    it('a teammate WITH See prices gets the total and the link', async () => {
      const w = await newOrg();
      const creator = await teammate(w.org, true);
      const estimate = await sentEstimate(w.org, w.customer, creator);

      await runAutomation(w.org, { type: 'estimate', id: estimate }, 'SEND_EMAIL', { recipients: ['creator'] });

      const staff = sentTo(creator.email);
      expect(staff.text).toContain('$100.00');
      expect(staff.text).toContain(`token=${TOKEN}`);
    });

    it('flips with the switch: the same teammate, mailed again after See prices is turned on, gets the total', async () => {
      const w = await newOrg();
      const creator = await teammate(w.org, false);
      const estimate = await sentEstimate(w.org, w.customer, creator);
      await runAutomation(w.org, { type: 'estimate', id: estimate }, 'SEND_EMAIL', { recipients: ['creator'] });
      expect(sentTo(creator.email).text).not.toContain('$100.00');

      await setPrices(w.org, creator.key, true);
      resendSend.mockClear();
      await runAutomation(w.org, { type: 'estimate', id: estimate }, 'SEND_EMAIL', { recipients: ['creator'] });
      expect(sentTo(creator.email).text).toContain('$100.00');
    });

    it('an address typed into the step that belongs to a teammate without See prices is treated as that teammate', async () => {
      const w = await newOrg();
      const creator = await teammate(w.org, false);
      const estimate = await sentEstimate(w.org, w.customer, creator);

      await runAutomation(w.org, { type: 'estimate', id: estimate }, 'SEND_EMAIL', { recipients: ['custom'], custom_emails: [creator.email.toUpperCase()] });

      const staff = sentTo(creator.email.toUpperCase());
      expect(staff.text).not.toContain('$100.00');
      expect(staff.text).not.toContain(TOKEN);
    });

    it('an outside address typed into the step (not a teammate) is sent the email as written', async () => {
      const w = await newOrg();
      const creator = await teammate(w.org, false);
      const estimate = await sentEstimate(w.org, w.customer, creator);

      await runAutomation(w.org, { type: 'estimate', id: estimate }, 'SEND_EMAIL', { recipients: ['custom'], custom_emails: ['bookkeeper@example.org'] });

      expect(sentTo('bookkeeper@example.org').text).toContain('$100.00');
    });

    it('an invoice email follows the same rule for {{invoice.total}} and {{invoice.link}}', async () => {
      const w = await newOrg();
      const lead = await teammate(w.org, false);
      const job = await fx.addJob(w.org, w.customer, { dispatcher: lead.id });
      const inv = await fx.addInvoice(w.org, w.customer, { jobId: job.id });
      await db.invoice.update({ where: { id: inv.id }, data: { status: 'SENT', sent_at: new Date(), public_token: TOKEN } });

      await runAutomation(w.org, { type: 'invoice', id: inv.id }, 'SEND_EMAIL', {
        recipients: ['customer', 'specific_user'], user_ids: [lead.id],
        subject: 'Invoice {{invoice.number}} {{invoice.total}}', body: 'Total {{invoice.total}} pay: {{invoice.link}}',
      });

      const staff = sentTo(lead.email);
      expect(staff.text).not.toContain('$100.00');
      expect(staff.text).not.toContain(TOKEN);
      expect(sentTo(CUSTOMER_EMAIL).text).toContain(`token=${TOKEN}`);
    });

    it('a text to a teammate without See prices leaves the total and the link empty; the customer\'s text keeps them', async () => {
      const w = await newOrg();
      const creator = await teammate(w.org, false);
      const estimate = await sentEstimate(w.org, w.customer, creator);
      await db.customer.update({ where: { id: w.customer }, data: { phone: '+15555559999' } });

      const res = await runAutomation(w.org, { type: 'estimate', id: estimate }, 'SEND_SMS', { recipients: ['customer', 'creator'] });
      expect(res.status).toBe('SENT');

      const bodies = recordSms.mock.calls.map((c) => c[0] as { to: { type: string }; body: string });
      const toStaff = bodies.find((b) => b.to.type === 'user')!;
      const toCustomer = bodies.find((b) => b.to.type === 'customer')!;
      expect(toStaff.body).not.toContain('$100.00');
      expect(toStaff.body).not.toContain(TOKEN);
      expect(toStaff.body).toContain(TYPED);
      expect(toCustomer.body).toContain('$100.00');
      expect(toCustomer.body).toContain(TOKEN);
      // Run history names no part of the text (Ran, 2026-10-28: "just the subject").
      expect(res.detail).toBe('Text message sent');
      expect(res.detail).not.toContain('$100');
    });
  });

  describe('2. the workflow test-send ("send to me")', () => {
    async function workflowFor(org: string) {
      const admin = (await db.user.findFirstOrThrow({ where: { organization_id: org, is_admin: true } }));
      const wf = await db.workflow.create({
        data: {
          organization_id: org, name: 'Estimate approved', trigger_type: 'ESTIMATE_APPROVED', status: 'DRAFT', created_by_id: admin.id,
          steps: { create: [{ organization_id: org, position: 0, step_type: 'SEND_EMAIL', config: { recipients: ['creator'], subject: 'Approved {{estimate.total}}', body: BODY } }] },
        },
      });
      return wf.id;
    }
    const automations = { view_automations: true, create_automations: true, edit_automations: true };

    it('without See prices, the preview and the email sent to the tester leave the total and the link empty', async () => {
      const w = await newOrg();
      const me = await teammate(w.org, false, automations);
      const wf = await workflowFor(w.org);

      const res = await (await fx.signedInAs(me)).post(`/api/workflows/${wf}/test`, { send_to_me: true });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const shown = JSON.stringify(res.body.steps);
      expect(shown).not.toContain('$2,450.00');
      expect(shown).not.toContain('/p/estimates/');
      expect(shown).toContain(TYPED);
      expect(res.body.delivered).toContain('email');

      const mail = sentTo(me.email);
      expect(mail.text).not.toContain('$2,450.00');
      expect(mail.text).not.toContain('/p/estimates/');
      expect(mail.html).not.toContain('$2,450.00');
      expect(mail.text).toContain(TYPED);
    });

    it('with See prices, the sample total and link are shown and sent', async () => {
      const w = await newOrg();
      const me = await teammate(w.org, true, automations);
      const wf = await workflowFor(w.org);

      const res = await (await fx.signedInAs(me)).post(`/api/workflows/${wf}/test`, { send_to_me: true });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(JSON.stringify(res.body.steps)).toContain('$2,450.00');
      expect(sentTo(me.email).text).toContain('$2,450.00');
    });
  });

  describe('3. the bell alert about a payment', () => {
    it('someone takes a payment on the invoice of a job the teammate is crewed on: the alert reaches them and names no amount, with or without See prices', async () => {
      const w = await fx.newOrg();
      orgs.push(w.org);
      await db.user.update({ where: { id: w.admin.id }, data: { is_active: false } });
      await db.organization.update({ where: { id: w.org }, data: { accepted_payment_methods: ['CASH', 'CHECK', 'CARD'] } });
      const opens = { view_jobs: true, jobs_scope: 'all', view_leads: true, leads_scope: 'all', view_invoices: true, can_be_on_crew: true };
      const crewMember = await teammate(w.org, false, opens);
      const actor = await teammate(w.org, true, { ...opens, record_payments: true, allowed_payment_methods: ['CASH'] });
      const job = await fx.addJob(w.org, w.customer, { status: 'SCHEDULED', crew: [crewMember.id], createdBy: actor.id });
      const inv = await fx.addInvoice(w.org, w.customer, { jobId: job.id });
      await db.invoice.update({ where: { id: inv.id }, data: { status: 'SENT', sent_at: new Date() } });

      const paid = await (await fx.signedInAs(actor)).post(`/api/invoices/${inv.id}/payments`, { amount: 100, method: 'CASH' });
      expect(paid.status, JSON.stringify(paid.body)).toBeLessThan(300);
      await reviewAttentionSettled();

      const bell = async () => {
        const res = await (await fx.signedInAs(crewMember)).get('/api/notifications');
        expect(res.status).toBe(200);
        return (res.body.items as Array<{ verb: string; data: Record<string, unknown>; title: string; body: string | null }>).filter((i) => i.verb.startsWith('billing.'));
      };
      for (const seesPrices of [false, true]) {
        await setPrices(w.org, crewMember.key, seesPrices);
        const alerts = await bell();
        expect(alerts.length, 'the alert reached the teammate').toBeGreaterThan(0);
        for (const alert of alerts) {
          expect(Object.keys(alert.data), alert.verb).not.toContain('amount');
          expect(JSON.stringify(alert), alert.verb).not.toMatch(/\$\s*\d|100\.00|Amount/);
          expect(alert.title).toContain(' for INV-');
        }
      }
      // And nothing was stored: the row itself carries no amount.
      const stored = await db.notification.findMany({ where: { organization_id: w.org, object_id: inv.id } });
      expect(stored.length).toBeGreaterThan(0);
      for (const n of stored) expect(Object.keys(n.data as object)).not.toContain('amount');
    });
  });

  describe('4. the automation Activity tab shows the subject of an email and none of a text', () => {
    const SECRET = 'Hi Pat, your invoice for $60.00 is ready: https://app.example.test/p/invoices/x?token=abc';

    it('an email step shows its subject as stored; a text step that went out shows one neutral line, whatever is stored; a text that did not go out keeps its reason', async () => {
      const w = await newOrg();
      const me = await teammate(w.org, false, { view_automations: true });
      const admin = await db.user.findFirstOrThrow({ where: { organization_id: w.org, is_admin: true } });
      const wf = await db.workflow.create({
        data: {
          organization_id: w.org, name: 'Estimate approved', trigger_type: 'ESTIMATE_APPROVED', status: 'DRAFT', created_by_id: admin.id,
          steps: { create: [{ organization_id: w.org, position: 0, step_type: 'SEND_TEXT', config: { recipients: ['customer'], body: 'x' } }] },
        },
      });
      const version = await db.workflowVersion.create({ data: { workflow_id: wf.id, version: 1, definition: { steps: [] }, organization_id: w.org } });
      const job = await fx.addJob(w.org, w.customer);
      const enrollment = (n: number) => db.workflowEnrollment.create({
        data: {
          workflow_id: wf.id, workflow_version_id: version.id, entity_type: 'job', entity_id: job.id, entity_label: `J-${n}`,
          dedupe_key: `m4-activity-${n}-${randomUUID()}`, resume_at: new Date(), organization_id: w.org,
        },
      });
      const run = async (n: number, stepType: 'SEND_TEXT' | 'SEND_EMAIL', status: 'SENT' | 'SKIPPED' | 'FAILED', detail: string) =>
        db.workflowStepRun.create({
          data: { enrollment_id: (await enrollment(n)).id, step_index: 0, step_type: stepType, status, detail, recipient_summary: 'Pat Payer', organization_id: w.org, executed_at: new Date() },
        });
      // Rows written by the old code: a text step's detail was the first 120 characters of the message.
      await run(1, 'SEND_TEXT', 'SENT', SECRET);
      await run(2, 'SEND_EMAIL', 'SENT', 'Your invoice INV-7 is ready');
      await run(3, 'SEND_TEXT', 'SKIPPED', 'Customer has no phone number on file');
      await run(4, 'SEND_TEXT', 'SENT', 'Text message sent');

      const res = await (await fx.signedInAs(me)).get(`/api/workflows/${wf.id}/activity`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const rows = res.body.rows as Array<{ step_type: string; status: string; detail: string | null; recipient_summary: string | null; entity_label: string }>;
      const by = (label: string) => rows.find((r) => r.entity_label === label)!;
      expect(by('J-1').detail).toBe('Text message sent');
      expect(by('J-1').recipient_summary, 'who it reached is still shown').toBe('Pat Payer');
      expect(by('J-2').detail, 'an email shows its subject').toBe('Your invoice INV-7 is ready');
      expect(by('J-3').detail, 'a text that did not go out keeps its reason').toBe('Customer has no phone number on file');
      expect(by('J-4').detail).toBe('Text message sent');
      expect(JSON.stringify(res.body)).not.toContain('$60.00');
      expect(JSON.stringify(res.body)).not.toContain('token=abc');
    });
  });

  describe('5. the history of a record names no figure, and no typed text is scanned', () => {
    it('a payment recorded through the real route reads "Payment received via ..." for everyone, its figure is on the entry and only with See prices, and a note someone typed keeps its "$500"', async () => {
      const w = await fx.newOrg();
      orgs.push(w.org);
      await db.organization.update({ where: { id: w.org }, data: { accepted_payment_methods: ['CASH', 'CHECK', 'CARD'] } });
      const opens = { view_jobs: true, jobs_scope: 'all', view_leads: true, leads_scope: 'all', view_invoices: true };
      const reader = await teammate(w.org, false, opens);
      const actor = await teammate(w.org, true, { ...opens, record_payments: true, allowed_payment_methods: ['CASH'] });
      const job = await fx.addJob(w.org, w.customer, { status: 'SCHEDULED', createdBy: actor.id });
      const inv = await fx.addInvoice(w.org, w.customer, { jobId: job.id });
      await db.invoice.update({ where: { id: inv.id }, data: { status: 'SENT', sent_at: new Date() } });
      const paid = await (await fx.signedInAs(actor)).post(`/api/invoices/${inv.id}/payments`, { amount: 100, method: 'CASH' });
      expect(paid.status, JSON.stringify(paid.body)).toBeLessThan(300);
      // Words a person typed: never scanned.
      await db.timelineEvent.create({
        data: {
          organization_id: w.org, entity_type: 'INVOICE', entity_id: inv.id, event_type: 'NOTE_ADDED',
          description: 'Customer says their budget is $500 and wants the 5% off.', created_by: actor.id,
        },
      });

      type Entry = { event_type: string; description: string; metadata?: { amount?: number } | null };
      const history = async (who: Person) => {
        const res = await (await fx.signedInAs(who)).get(`/api/invoices/${inv.id}/timeline`);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        return res.body.events as Entry[];
      };
      for (const seesPrices of [false, true]) {
        await setPrices(w.org, reader.key, seesPrices);
        const events = await history(reader);
        const payment = events.find((e) => e.event_type === 'PAYMENT_RECEIVED')!;
        expect(payment.description).toBe('Payment received via Cash');
        expect(payment.description).not.toMatch(/\$\s*\d/);
        expect(Object.prototype.hasOwnProperty.call(payment.metadata ?? {}, 'amount'), `amount on the entry, with See prices ${seesPrices}`).toBe(seesPrices);
        expect(events.find((e) => e.event_type === 'NOTE_ADDED')!.description).toBe('Customer says their budget is $500 and wants the 5% off.');
      }
      // The job's own history line for the same payment: no figure in its words either.
      await setPrices(w.org, reader.key, false);
      const jobHistory = await (await fx.signedInAs(reader)).get(`/api/jobs/${job.id}/timeline`);
      const entries = (jobHistory.body.events as Array<{ event_type: string; description: string; metadata?: object | null }>)
        .filter((e) => e.event_type !== 'NOTE_ADDED'); // the note someone typed is theirs, and stays
      expect(entries.length).toBeGreaterThan(0);
      for (const e of entries) {
        expect(e.description, e.event_type).not.toMatch(/\$\s*\d/);
        expect(JSON.stringify(e.metadata ?? {}), e.event_type).not.toMatch(/"amount"/);
      }
    });
  });
});
