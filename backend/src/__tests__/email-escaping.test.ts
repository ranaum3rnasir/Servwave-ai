import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';

const { sentEmails } = vi.hoisted(() => ({ sentEmails: [] as Array<Record<string, string>> }));

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
    emails = {
      send: vi.fn(async (payload: Record<string, string>) => {
        sentEmails.push(payload);
        return { id: 'mock-id' };
      }),
    };
  },
}));

// The estimate senders render a PDF from the DB; the *Html builders we want to
// snapshot don't need it. sendInvoiceEmail also renders one (stubbed below) so it
// keeps working as a pure-params sender for this suite's purposes.
vi.mock('../lib/pdf', () => ({
  generateInvoicePdf: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fake')),
}));

import { prisma } from '../lib/prisma';

let email: typeof import('../lib/email');

beforeAll(async () => {
  email = await vi.importActual<typeof import('../lib/email')>('../lib/email');
});

beforeEach(() => {
  sentEmails.length = 0;
  // renderInvoicePdfBuffer's own lookups, ahead of the stubbed generateInvoicePdf above.
  (prisma.invoice.findUnique as Mock).mockResolvedValue({ organization_id: ORG_ID, payments: [] });
  (prisma.organization.findUnique as Mock).mockResolvedValue({ email_sending_enabled: true, name: 'Acme' });
});

// A name field carrying an in-brand-phishing link + an onerror image + a script.
const XSS = 'Acme <a href="https://evil/verify">Update card</a><img src=x onerror=alert(1)><script>alert(2)</script>';
const ESCAPED_LINK = '&lt;a href=&quot;https://evil/verify&quot;&gt;';
const ORG_ID = '00000000-0000-0000-0000-000000000001';

function htmlOf(predicate: (e: Record<string, string>) => boolean): string {
  const e = sentEmails.find(predicate);
  expect(e, 'expected a captured email').toBeTruthy();
  return e!.html;
}

describe('B-06 / F-18: transactional emails HTML-escape user-controlled fields', () => {
  it('clock override requested escapes technicianName and nearestLabel', async () => {
    await email.sendClockOverrideRequestedEmail({
      org: { id: ORG_ID, name: 'Acme', logo_url: null, brand_color: '#0C2D3A' },
      to: ['approver@example.com'],
      technicianName: XSS,
      requestedAt: new Date('2026-07-01T15:00:00Z'),
      distanceM: 500,
      nearestLabel: XSS,
      timezone: 'America/New_York',
    });
    const html = htmlOf((e) => e.to === 'approver@example.com');
    expect(html).toContain(ESCAPED_LINK);
    expect(html).not.toContain('<a href="https://evil/verify">');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<script>alert(2)</script>');
  });

  it('deposit received confirmation escapes customerName', async () => {
    await email.sendDepositReceivedConfirmation({
      organizationId: ORG_ID,
      to: 'cust@example.com',
      customerName: XSS,
      estimateNumber: 'E00001',
      depositAmount: 100,
      paymentMethod: 'CARD',
      receivedDate: '2026-07-01',
      companyName: 'Co',
    });
    const html = htmlOf((e) => e.to === 'cust@example.com');
    expect(html).toContain(ESCAPED_LINK);
    expect(html).not.toContain('<a href="https://evil/verify">');
  });

  it('refund notification escapes the reason', async () => {
    await email.sendRefundNotification({
      organizationId: ORG_ID,
      to: 'cust@example.com',
      customerName: XSS,
      estimateNumber: 'E00001',
      refundAmount: 100,
      reason: XSS,
      companyName: 'Co',
    });
    const html = htmlOf((e) => e.to === 'cust@example.com');
    expect(html).toContain(ESCAPED_LINK);
    expect(html).not.toContain('<a href="https://evil/verify">');
  });

  it('invoice email escapes customerName (regression: message was escaped but name was not)', async () => {
    await email.sendInvoiceEmail({
      invoiceId: 'inv-1',
      organizationId: ORG_ID,
      to: 'cust@example.com',
      customerName: XSS,
      invoiceNumber: 'I00001',
      total: 100,
      amountDue: 100,
      dueDate: '2026-07-01',
      publicUrl: 'https://app.example/p/x',
    });
    const html = htmlOf((e) => e.to === 'cust@example.com');
    expect(html).toContain(ESCAPED_LINK);
    expect(html).not.toContain('<a href="https://evil/verify">');
  });

  it('payment received escapes customerName', async () => {
    await email.sendPaymentReceivedEmail({
      organizationId: ORG_ID,
      to: 'cust@example.com',
      customerName: XSS,
      invoiceNumber: 'I00001',
      amount: 50,
      method: 'CARD',
      newBalance: 0,
    });
    const html = htmlOf((e) => e.to === 'cust@example.com');
    expect(html).toContain(ESCAPED_LINK);
    expect(html).not.toContain('<a href="https://evil/verify">');
  });

  it('wrapHtml drops a non-https logo_url and never emits it as <img src>', async () => {
    // performer/owner internal walkthrough-completed goes through wrapHtml; use a
    // sender that takes org branding to exercise the logo path:
    await email.sendClockOverrideDecisionEmail({
      org: { id: ORG_ID, name: 'Acme', logo_url: 'javascript:alert(1)', brand_color: '#0C2D3A' },
      to: 'tech@example.com',
      technicianName: 'Tech',
      decision: 'approved',
      decidedByName: 'Boss',
    });
    const html = htmlOf((e) => e.to === 'tech@example.com');
    expect(html).not.toContain('javascript:alert(1)');
    expect(html).not.toContain('<img');           // fell back to the text wordmark
    expect(html).toContain('Acme');
  });

  it('#217: invoice email renders dueDate in the passed org timezone (HTML + text)', async () => {
    // 2026-07-01T02:00:00Z is still June 30 in Eastern — the email must show the
    // org-zone calendar day, not the server's UTC day.
    await email.sendInvoiceEmail({
      invoiceId: 'inv-1',
      organizationId: ORG_ID,
      to: 'tz-invoice@example.com',
      customerName: 'Cust',
      invoiceNumber: 'I00099',
      total: 100,
      amountDue: 100,
      dueDate: '2026-07-01T02:00:00.000Z',
      publicUrl: 'https://app.example/p/x',
      timezone: 'America/New_York',
    });
    const captured = sentEmails.find((e) => e.to === 'tz-invoice@example.com');
    expect(captured, 'expected a captured email').toBeTruthy();
    expect(captured!.html).toContain('June 30, 2026');
    expect(captured!.html).not.toContain('July 1, 2026');
    expect(captured!.text).toContain('June 30, 2026');
    expect(captured!.text).not.toContain('July 1, 2026');
  });

  it('#217: invoice email falls back to DEFAULT_TIMEZONE (Eastern) when no timezone passed', async () => {
    await email.sendInvoiceEmail({
      invoiceId: 'inv-1',
      organizationId: ORG_ID,
      to: 'tz-default@example.com',
      customerName: 'Cust',
      invoiceNumber: 'I00098',
      total: 100,
      amountDue: 100,
      dueDate: '2026-07-01T02:00:00.000Z',
      publicUrl: 'https://app.example/p/x',
    });
    const captured = sentEmails.find((e) => e.to === 'tz-default@example.com');
    expect(captured, 'expected a captured email').toBeTruthy();
    expect(captured!.html).toContain('June 30, 2026');
    expect(captured!.html).not.toContain('July 1, 2026');
  });

  it('#217: invoice email renders dueDate in a non-Eastern org timezone', async () => {
    // 2026-07-01T05:00:00Z is July 1 in Eastern (01:00) but still June 30 in LA (22:00).
    await email.sendInvoiceEmail({
      invoiceId: 'inv-1',
      organizationId: ORG_ID,
      to: 'tz-la@example.com',
      customerName: 'Cust',
      invoiceNumber: 'I00097',
      total: 100,
      amountDue: 100,
      dueDate: '2026-07-01T05:00:00.000Z',
      publicUrl: 'https://app.example/p/x',
      timezone: 'America/Los_Angeles',
    });
    const captured = sentEmails.find((e) => e.to === 'tz-la@example.com');
    expect(captured, 'expected a captured email').toBeTruthy();
    expect(captured!.html).toContain('June 30, 2026');
    expect(captured!.html).not.toContain('July 1, 2026');
  });

  // #217's two approval-confirmation timezone tests were removed along with
  // sendApprovalConfirmationToCustomer itself (#992/#994) - it duplicated the customer-facing
  // "Estimate {n} - Approved" email that sendEstimateApprovedNotification already sends.

  it('a benign name still renders normally (no over-escaping of plain text)', async () => {
    await email.sendPaymentReceivedEmail({
      organizationId: ORG_ID,
      to: 'ok@example.com',
      customerName: "O'Brien & Sons",
      invoiceNumber: 'I00002',
      amount: 10,
      method: 'CASH',
      newBalance: 0,
    });
    const html = htmlOf((e) => e.to === 'ok@example.com');
    expect(html).toContain('O&#39;Brien &amp; Sons');   // escaped, but human-readable
    expect(html).toContain('Payment Received');           // boilerplate intact
  });
});
