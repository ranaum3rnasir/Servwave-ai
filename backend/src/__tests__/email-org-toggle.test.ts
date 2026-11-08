import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';

// Capture fn must exist before the hoisted vi.mock factory references it.
const { resendSend } = vi.hoisted(() => ({ resendSend: vi.fn() }));

// Override the global env mock (setup.ts) so the email module initializes a
// real Resend client instead of short-circuiting on a missing key.
vi.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'test',
    EMAIL_FROM: 'Alpha <noreply@test.com>',
    RESEND_API_KEY: 're_test_key',
    FRONTEND_URL: 'http://localhost:5173',
  },
}));

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: resendSend };
  },
}));

vi.mock('../lib/comm-persist', () => ({
  persistTransactionalEmail: vi.fn().mockResolvedValue(undefined),
}));

// sendInvoiceEmail now attaches a rendered PDF — stub the renderer so this suite stays
// focused on the org-toggle gate, not pdfmake.
vi.mock('../lib/pdf', () => ({
  generateInvoicePdf: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fake')),
}));

import { prisma } from '../lib/prisma';
import { persistTransactionalEmail } from '../lib/comm-persist';

// setup.ts mocks '../lib/email' globally; pull the REAL module here.
let sendInvoiceEmail: typeof import('../lib/email')['sendInvoiceEmail'];
let sendClockOverrideDecisionEmail: typeof import('../lib/email')['sendClockOverrideDecisionEmail'];
let sendMfaCodeEmail: typeof import('../lib/email')['sendMfaCodeEmail'];
let sendUserInviteEmail: typeof import('../lib/email')['sendUserInviteEmail'];
let sendAutomationEmail: typeof import('../lib/email')['sendAutomationEmail'];
let sendSalesContactEmail: typeof import('../lib/email')['sendSalesContactEmail'];

beforeAll(async () => {
  const real = await vi.importActual<typeof import('../lib/email')>('../lib/email');
  sendInvoiceEmail = real.sendInvoiceEmail;
  sendClockOverrideDecisionEmail = real.sendClockOverrideDecisionEmail;
  sendMfaCodeEmail = real.sendMfaCodeEmail;
  sendUserInviteEmail = real.sendUserInviteEmail;
  sendAutomationEmail = real.sendAutomationEmail;
  sendSalesContactEmail = real.sendSalesContactEmail;
});

beforeEach(() => {
  vi.clearAllMocks();
  resendSend.mockResolvedValue({ id: 'msg_1' });
  // renderInvoicePdfBuffer's own lookup, ahead of the stubbed generateInvoicePdf above —
  // individual tests below still control the organization.findUnique mock for the
  // email_sending_enabled check that runs after it.
  (prisma.invoice.findUnique as Mock).mockResolvedValue({ organization_id: ORG_ID, payments: [] });
});

const ORG_ID = '00000000-0000-0000-0000-000000000001';

describe('Org-level email_sending_enabled toggle', () => {
  it('skips the send when the org has email sending disabled', async () => {
    (prisma.organization.findUnique as Mock).mockResolvedValue({ email_sending_enabled: false });

    await sendInvoiceEmail({
      invoiceId: 'inv-1',
      organizationId: ORG_ID,
      to: 'cust@example.com',
      customerName: 'Cust',
      invoiceNumber: 'I00001',
      total: 100,
      amountDue: 100,
      dueDate: '2026-08-01',
      publicUrl: 'https://app.example/i/tok',
    });

    expect(resendSend).not.toHaveBeenCalled();
  });

  it('sends normally when the org has email sending enabled', async () => {
    (prisma.organization.findUnique as Mock).mockResolvedValue({ email_sending_enabled: true });

    await sendInvoiceEmail({
      invoiceId: 'inv-1',
      organizationId: ORG_ID,
      to: 'cust@example.com',
      customerName: 'Cust',
      invoiceNumber: 'I00001',
      total: 100,
      amountDue: 100,
      dueDate: '2026-08-01',
      publicUrl: 'https://app.example/i/tok',
    });

    expect(resendSend).toHaveBeenCalledTimes(1);
  });

  it('fails open (sends) when the org lookup returns nothing — legacy/unmocked rows default to enabled', async () => {
    // First call is renderInvoicePdfBuffer's own org lookup (needs a truthy row to render at
    // all); the SECOND call is dispatchEmail's email_sending_enabled check — the one actually
    // under test here — which sees the "nothing found" row this test is named for.
    (prisma.organization.findUnique as Mock)
      .mockResolvedValueOnce({ estimate_template: 'alpha-classic' })
      .mockResolvedValueOnce(undefined);

    await sendInvoiceEmail({
      invoiceId: 'inv-1',
      organizationId: ORG_ID,
      to: 'cust@example.com',
      customerName: 'Cust',
      invoiceNumber: 'I00001',
      total: 100,
      amountDue: 100,
      dueDate: '2026-08-01',
      publicUrl: 'https://app.example/i/tok',
    });

    expect(resendSend).toHaveBeenCalledTimes(1);
  });

  it('respects the toggle for senders that take org branding (org.id), not just a bare organizationId', async () => {
    (prisma.organization.findUnique as Mock).mockResolvedValue({ email_sending_enabled: false });

    await sendClockOverrideDecisionEmail({
      org: { id: ORG_ID, name: 'Acme', logo_url: null, brand_color: '#0C2D3A' },
      to: 'tech@example.com',
      technicianName: 'Tech',
      decision: 'approved',
      decidedByName: 'Boss',
    });

    expect(resendSend).not.toHaveBeenCalled();
  });

  it('does NOT gate sendMfaCodeEmail — auth-critical, always sends regardless of the org toggle', async () => {
    (prisma.organization.findUnique as Mock).mockResolvedValue({ email_sending_enabled: false });

    await sendMfaCodeEmail({ to: 'user@example.com', code: '123456' });

    expect(resendSend).toHaveBeenCalledTimes(1);
  });

  // The Automation Center is the one sender an org is most likely to want to
  // kill in a hurry — it fires unattended, on a poller, to customers. It must
  // sit behind the same brake as every hand-triggered business email. (#906)
  it('gates sendAutomationEmail — the kill switch stops Automation Center sends', async () => {
    (prisma.organization.findUnique as Mock).mockResolvedValue({ email_sending_enabled: false });

    await sendAutomationEmail({
      organizationId: ORG_ID,
      to: 'customer@example.com',
      subject: 'Your appointment is tomorrow',
      text: 'See you then.',
      html: '<p>See you then.</p>',
    });

    expect(resendSend).not.toHaveBeenCalled();
  });

  it('sends automation email normally when the org has email sending enabled', async () => {
    (prisma.organization.findUnique as Mock).mockResolvedValue({ email_sending_enabled: true });

    await sendAutomationEmail({
      organizationId: ORG_ID,
      to: 'customer@example.com',
      subject: 'Your appointment is tomorrow',
      text: 'See you then.',
      html: '<p>See you then.</p>',
    });

    expect(resendSend).toHaveBeenCalledTimes(1);
  });

  // A skipped send that still mirrors into the Communication tab would show the
  // office a message the customer never got.
  it('does not mirror a killed automation email into the Communication tab', async () => {
    (prisma.organization.findUnique as Mock).mockResolvedValue({ email_sending_enabled: false });

    await sendAutomationEmail({
      organizationId: ORG_ID,
      to: 'customer@example.com',
      subject: 'Your appointment is tomorrow',
      text: 'See you then.',
      html: '<p>See you then.</p>',
      record: { organizationId: ORG_ID, customerId: null, jobId: null, jobLabel: null },
    });

    expect(persistTransactionalEmail).not.toHaveBeenCalled();
  });

  it('does NOT gate sendUserInviteEmail — auth-critical, always sends regardless of the org toggle', async () => {
    (prisma.organization.findUnique as Mock)
      // First call inside sendUserInviteEmail itself (branding lookup)
      .mockResolvedValueOnce({ name: 'Acme', logo_url: null, brand_color: '#0C2D3A' });

    await sendUserInviteEmail({
      to: 'user@example.com',
      firstName: 'Jane',
      inviteUrl: 'https://app.example/invite/abc',
      organizationId: ORG_ID,
    });

    expect(resendSend).toHaveBeenCalledTimes(1);
  });
  // "Reach sales" is a contractor writing TO ServWave, in the platform's own
  // voice, to an address this file owns. The kill switch exists so an org can
  // stop speaking to ITS OWN CUSTOMERS under its own name - it has no business
  // silencing a message addressed to us. Gating it locked the orgs most likely
  // to need sales out of the one channel for reaching sales: email is OFF BY
  // DEFAULT for every org since migration 20260809031000, so on staging 8 of 9
  // orgs, and in prod 3 of 5, could not send this at all.
  //
  // Same rule the AI Agentic Farm booking sender already follows: an internal
  // sales lead is not customer-facing business correspondence.
  it('does NOT gate sendSalesContactEmail - an internal sales lead is not customer-facing business email', async () => {
    (prisma.organization.findUnique as Mock).mockResolvedValue({
      email_sending_enabled: false,
      name: 'Kill Switch Contracting',
      plan: 'SCALE',
      is_demo: false,
      city: 'Richmond',
      state: 'VA',
      phone: null,
      ctm_account_id: '500001',
      _count: { users: 10 },
    });

    const result = await sendSalesContactEmail({
      organizationId: ORG_ID,
      to: 'info@servwave.com',
      subject: 'Raise call / text limits',
      message: 'We are close to our included allowance.',
      replyTo: 'owner@example.com',
      topic: 'limits',
      sender: { id: 'user-1', name: 'Owner', email: 'owner@example.com', role: 'ADMIN' },
    });

    expect(resendSend).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('sent');
  });

  // The bypass must be exactly one sender wide. If it ever widened to every
  // platform-voice send, an org that killed its email would still be mailing
  // out under a header it did not choose.
  it('still gates ordinary business email when the sales bypass is in place', async () => {
    (prisma.organization.findUnique as Mock).mockResolvedValue({ email_sending_enabled: false });

    await sendAutomationEmail({
      organizationId: ORG_ID,
      to: 'customer@example.com',
      subject: 'Your appointment is tomorrow',
      text: 'See you then.',
      html: '<p>See you then.</p>',
    });

    expect(resendSend).not.toHaveBeenCalled();
  });
});
