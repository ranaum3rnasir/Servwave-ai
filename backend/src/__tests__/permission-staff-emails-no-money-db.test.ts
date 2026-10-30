/* =============================================================================
   Roles & Permissions security fixes, M4 (ticket 35), Ran's ruling of 2026-10-28: the emails ServWave sends to the company's own
   people carry NO amount, for anyone. (The customer's own emails are untouched: the customer sees their own bill.)

   One table, driven from the source so a new sender fails it:
     - every exported `send...` function of lib/email.ts must be in the table below with its audience, and every other file that
       calls the mail provider must be on the short list. A new staff email is not on it, so the build fails until someone decides
       whether it names a figure;
     - every sender whose audience is the company's people and which used to carry an amount (the deposit received alert, the
       payment-method-selected alert) is called with a figure in every money-sounding argument, through the real dispatcher with
       only the provider's client faked, and its subject, text and HTML must hold none of it;
     - every billing alert verb the owner payment emails are sent for (refund, refund failed, bank payment, dispute, unapplied
       capture and the rest: `BILLING_ALERT_VERBS`) goes through the real `notifyOwners` to a real person who handles billing: the
       email they receive and the bell they get carry no amount.
   Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

const { realClient, resendSend } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined, resendSend: vi.fn() };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: resendSend };
    domains = { create: vi.fn(), get: vi.fn(), verify: vi.fn(), remove: vi.fn() };
  },
}));
vi.mock('../lib/email', async (importOriginal) => {
  const { env } = await import('../config/env.js');
  Object.assign(env, {
    RESEND_API_KEY: 're_test_key', MAILBOX_DOMAIN: 'staging.mail.test.com', EMAIL_FROM_BUSINESS: 'no-reply@mail.test.com',
    EMAIL_FROM: 'no-reply@mail.test.com', EMAIL_REPLY_DOMAIN: 'reply.test.com',
  });
  return importOriginal();
});

import { switchFixture, type Person } from './permission-switches-fixture';
import { SWITCH_CATALOG, type SwitchValue } from '../lib/permissions/switches/catalog';
import { BILLING_ALERT_VERBS } from '../services/notifications/invoiceBillingAlerts';

const suite = realClient ? describe : describe.skip;
const SRC = join(__dirname, '..');
const SENTINEL = 8675.31;

type Audience = 'customer' | 'staff-no-money' | 'staff-money-removed' | 'internal';
/**
 * Every exported sender of lib/email.ts and who it is for.
 *  customer             - goes to the customer about their own estimate, invoice, payment, visit: untouched.
 *  staff-no-money       - goes to the company's people (or is typed by one) and names no figure.
 *  staff-money-removed  - goes to the company's people and used to carry an amount; the table below proves it carries none now.
 *  internal             - ServWave's own inbox, never a company's people.
 */
const SENDERS: Record<string, Audience> = {
  sendComposedEmail: 'staff-no-money', // a person's own message, typed by them
  sendEstimateEmail: 'customer',
  sendStagePickupEmail: 'staff-no-money', // the technician's pickup ticket: quantities and units, no price
  sendUserInviteEmail: 'staff-no-money',
  sendMfaCodeEmail: 'staff-no-money',
  sendPasswordResetEmail: 'staff-no-money',
  sendAdminChangeAlertEmail: 'staff-no-money',
  sendOwnerApprovalEmail: 'staff-no-money', // Make Owner (ticket 27): the approval link to the company's Owner
  sendOwnerChangedEmail: 'staff-no-money', // Make Owner (ticket 27): the new and the outgoing Owner are told
  sendOpsAlertEmail: 'internal', // the nightly payments check, to ServWave's own inbox
  sendEstimateApprovedNotification: 'customer', // the signed copy goes to the customer
  sendEstimateWithDepositEmail: 'customer',
  sendDepositPaymentConfirmation: 'customer',
  sendDepositReceivedConfirmation: 'customer',
  sendRefundNotification: 'customer',
  sendInvoiceRefundNotification: 'customer',
  sendBankPaymentProcessingEmail: 'customer',
  sendBankPaymentFailedEmail: 'customer', // also what "contact the customer" sends them
  sendDepositPaidAlert: 'staff-money-removed', // the estimate's creator
  sendPaymentMethodSelectedAlert: 'staff-money-removed', // the estimate's creator
  sendPaymentsActionNeededEmail: 'staff-no-money',
  sendOwnerPaymentNoticeEmail: 'staff-money-removed', // the people who handle billing, via notifyOwners
  sendJobScheduledEmail: 'customer',
  sendJobRescheduledEmail: 'customer',
  sendJobVisitCancelledEmail: 'customer',
  sendCalendarEntryScheduledEmail: 'staff-no-money',
  sendCalendarEntryMovedEmail: 'staff-no-money',
  sendCalendarEntryCancelledEmail: 'staff-no-money',
  sendWalkthroughScheduledEmail: 'customer',
  sendWalkthroughRescheduledEmail: 'customer',
  sendInvoiceEmail: 'customer',
  sendPaymentReceivedEmail: 'customer',
  sendAutomationEmail: 'staff-no-money', // renders the author's words; the price merge fields are emptied for a teammate without See prices (M4)
  sendAiFarmBookingEmails: 'internal', // ServWave's sales inbox and the requester's confirmation
  sendSalesContactEmail: 'internal',
};
/** Files other than lib/email.ts that call the mail provider directly. */
const OTHER_MAIL_FILES: Record<string, string> = {
  'services/spider/delivery.ts': 'Spider lead alerts: names a lead and a time, no figure',
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (name === '__tests__' || name === 'node_modules') continue;
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('M4: every email sender is decided (source guard)', () => {
  it('lists every exported sender of lib/email.ts, and no sender that is gone', () => {
    const source = readFileSync(join(SRC, 'lib', 'email.ts'), 'utf8');
    const found = [...source.matchAll(/^export async function (send\w+)\(/gm)].map((m) => m[1]!).sort();
    expect(found.length).toBeGreaterThan(25);
    expect(Object.keys(SENDERS).sort()).toEqual(found);
  });

  it('no other file calls the mail provider except the ones decided', () => {
    const callers = sourceFiles(SRC)
      .filter((f) => !f.endsWith(join('lib', 'email.ts')))
      .filter((f) => /\bemails\.send\(|\bdispatchEmail\(/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(SRC.length + 1))
      .sort();
    expect(callers).toEqual(Object.keys(OTHER_MAIL_FILES).sort());
  });

  it('a staff sender takes no amount argument at all', () => {
    const source = readFileSync(join(SRC, 'lib', 'email.ts'), 'utf8');
    for (const [name, audience] of Object.entries(SENDERS)) {
      if (audience !== 'staff-money-removed' && audience !== 'staff-no-money') continue;
      const sig = new RegExp(`export async function ${name}\\(params: \\{([\\s\\S]*?)\\n\\}\\)`).exec(source)?.[1] ?? '';
      const money = [...sig.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]!).filter((k) => /amount|total|price|balance|cost|fee|tip|charged|refund/i.test(k));
      expect(money, `${name} takes ${money.join(', ')}`).toEqual([]);
    }
  });
});

suite('M4: the emails to the company\'s people name no amount (real dispatcher, real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  const orgs: string[] = [];
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      for (const table of ['notification_recipients', 'notifications', 'emails', 'email_threads', 'reply_tokens', 'mailbox_addresses', 'mailboxes']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
    }
    await fx.cleanup();
  });
  beforeEach(() => {
    resendSend.mockReset();
    resendSend.mockImplementation(async () => ({ data: { id: `re_${randomUUID()}` }, error: null }));
  });

  type Sent = { to: string; subject: string; text?: string; html?: string };
  const sentTo = (address: string) => resendSend.mock.calls.map((c) => c[0] as Sent).filter((m) => m.to === address);
  const noFigure = (mail: Sent, label: string) => {
    const all = `${mail.subject}\n${mail.text ?? ''}\n${mail.html ?? ''}`;
    expect(all, label).not.toContain('8675');
    expect(all, label).not.toMatch(/\$\s*\d/);
    expect(all, label).not.toMatch(/\bAmount\b|\bBalance due\b/);
    expect(all, label).not.toContain('()');
  };

  async function org() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    const part = `co${made.tag}`;
    await db.organization.update({ where: { id: made.org }, data: { email_sending_enabled: true, email_sender_local_part: part } });
    return made;
  }
  const ALL_OFF = Object.fromEntries(SWITCH_CATALOG.filter((s) => s.kind === 'toggle').map((s) => [s.key, false]));
  let sequence = 0;
  async function person(orgId: string, values: Record<string, SwitchValue>): Promise<Person> {
    const key = `m4-staff-${++sequence}`;
    const role = await fx.addCustomRole(orgId, key, 'TECHNICIAN', { madeFromBlank: true, copyGrants: false });
    await fx.setRoleSwitches(orgId, key, { ...ALL_OFF, ...values });
    return fx.addUser(orgId, `m4s${sequence}`, 'TECHNICIAN', { customRoleId: role.id });
  }

  it('the deposit received alert and the payment-method-selected alert (the estimate\'s creator) name no amount', async () => {
    const w = await org();
    const email = await import('../lib/email.js');
    const everyMoneyArgument = { depositAmount: SENTINEL, amount: SENTINEL, total: SENTINEL, totalCharged: SENTINEL, price: SENTINEL, balance: SENTINEL };
    const common = { organizationId: w.org, estimateNumber: 'E-1', customerName: 'Pat Payer', paymentMethod: 'CARD' };
    await email.sendDepositPaidAlert({ ...common, ...everyMoneyArgument, to: 'creator-a@example.test' } as never);
    await email.sendPaymentMethodSelectedAlert({ ...common, ...everyMoneyArgument, to: 'creator-b@example.test' } as never);
    const a = sentTo('creator-a@example.test');
    const b = sentTo('creator-b@example.test');
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    noFigure(a[0]!, 'deposit received');
    noFigure(b[0]!, 'payment method selected');
    // Complete sentences, nothing left dangling, the method and the estimate still named.
    expect(a[0]!.text).toBe('Deposit received for E-1 from Pat Payer via Card. You can now create a job.');
    expect(b[0]!.text).toBe('Customer selected Card for the deposit on E-1. Watch for incoming payment.');
  });

  it.each(BILLING_ALERT_VERBS.map((v) => [v] as const))('%s: the owner payment email and the bell, sent through notifyOwners, name no amount', async (verb) => {
    const w = await org();
    await db.user.update({ where: { id: w.admin.id }, data: { is_active: false } });
    const handler = await person(w.org, { view_jobs: true, jobs_scope: 'all', view_leads: true, leads_scope: 'all', view_invoices: true, access_billing: true, see_prices: true });
    const job = await fx.addJob(w.org, w.customer, {});
    const inv = await fx.addInvoice(w.org, w.customer, { jobId: job.id });
    await db.invoice.update({ where: { id: inv.id }, data: { status: 'SENT', sent_at: new Date() } });
    const number = (await db.invoice.findUniqueOrThrow({ where: { id: inv.id } })).invoice_number;

    const { notifyOwners } = await import('../lib/owner-payment-notices.js');
    await notifyOwners({
      verb, organizationId: w.org, object: { type: 'INVOICE', id: inv.id, label: number },
      data: { amount: String(SENTINEL), customer_name: 'Pat Payer', variant: 'bank_return', cleared: 'yes', customer_notice: 'sent', reason: 'OVERPAYMENT' },
      dedupKey: `${verb}:m4:${inv.id}`, actionLabel: 'Open the invoice',
    });

    const mails = sentTo(handler.email);
    expect(mails.length, 'the person who handles billing was emailed').toBe(1);
    noFigure(mails[0]!, `${verb} email`);
    expect(mails[0]!.subject).toContain(number);

    const bell = await (await fx.signedInAs(handler)).get('/api/notifications');
    const mine = (bell.body.items as Array<{ verb: string; title: string; body: string | null; data: Record<string, unknown> }>).filter((i) => i.verb === verb);
    expect(mine.length, 'and the bell has it').toBe(1);
    expect(Object.keys(mine[0]!.data)).not.toContain('amount');
    noFigure({ to: '', subject: `${mine[0]!.title}\n${mine[0]!.body ?? ''}`, text: JSON.stringify(mine[0]!.data) }, `${verb} bell`);
    const stored = await db.notification.findFirstOrThrow({ where: { organization_id: w.org, verb } });
    expect(Object.keys(stored.data as object), 'nothing is stored either').not.toContain('amount');
  });
});
