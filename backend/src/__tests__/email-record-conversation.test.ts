/*
 * PRD 10 / S10.4, S10.12 - the estimate and invoice sends open (or reuse) their record's conversation with origin "record"
 * in the mailbox of the person who pressed Send (the sender's own, never the company's main mailbox), and record that person.
 *
 * email-record-conversation-db.test.ts proves the same against a real database with a notice sender;
 * these are the estimate and invoice senders themselves, whose PDF rendering needs rows the database
 * suite does not build, so they run on the mocked client like the neighbouring send-path suites.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';

const { resendSend } = vi.hoisted(() => ({ resendSend: vi.fn() }));

vi.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'test',
    EMAIL_FROM: 'noreply@test.servwave.com',
    EMAIL_FROM_BUSINESS: 'noreply@mail.test.servwave.com',
    EMAIL_REPLY_DOMAIN: 'reply.test.com',
    RESEND_API_KEY: 're_test_key',
    MAILBOX_DOMAIN: 'mail.test.com',
    FRONTEND_URL: 'http://localhost:5173',
  },
}));

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: resendSend };
  },
}));

vi.mock('../lib/pdf', () => ({
  generateEstimatePdf: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fake')),
  generateInvoicePdf: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fake')),
}));

import { prisma } from '../lib/prisma';

type Email = typeof import('../lib/email');
let email: Email;

beforeAll(async () => {
  email = await vi.importActual<Email>('../lib/email');
});

const ORG_ID = '00000000-0000-0000-0000-000000000001';
const SENDER_MAILBOX_ID = 'a0000000-0000-0000-0000-00000000000a';
const SENDER_ID = 'b0000000-0000-0000-0000-00000000000b';
const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000001';
const ESTIMATE_ID = 'e0000000-0000-0000-0000-000000000001';
const INVOICE_ID = 'f0000000-0000-0000-0000-000000000001';
const HAND_SENDER = { mailboxId: SENDER_MAILBOX_ID, userId: SENDER_ID };
const ORG = { id: ORG_ID, name: 'Acme Plumbing', logo_url: null, brand_color: '#0C2D3A' };
const WHEN = new Date('2026-08-18T13:00:00Z');

const ESTIMATE_ROW = {
  estimate_number: 'E00001', status: 'SENT', created_at: WHEN, subtotal: 1200, tax_rate: 0,
  tax_amount: 0, total_amount: 1200, signature_data: null, signature_at: null,
  snapshot_terms: null, snapshot_notes: null, snapshot_payment_terms: null,
  organization_id: ORG_ID,
  lead: {
    service_address_line1: null, service_address_line2: null, service_city: null,
    service_state: null, service_zip: null,
    customer: { first_name: 'Jane', last_name: 'Doe', company_name: null, email: 'jane@example.com', phone: null, service_locations: [] },
  },
  line_items: [],
};

function sendEstimate(record: Record<string, unknown>) {
  return email.sendEstimateEmail({
    estimateId: ESTIMATE_ID, org: ORG, to: 'jane@example.com', customerName: 'Jane Doe', estimateNumber: 'E00001',
    total: '$1,200.00', publicUrl: 'http://localhost:5173/e/tok',
    record: { organizationId: ORG_ID, customerId: CUSTOMER_ID, entityType: 'estimate', entityId: ESTIMATE_ID, ...record },
    handSender: HAND_SENDER,
  } as never);
}

function sendInvoice(record: Record<string, unknown>) {
  return email.sendInvoiceEmail({
    invoiceId: INVOICE_ID, organizationId: ORG_ID, to: 'jane@example.com', customerName: 'Jane Doe', invoiceNumber: 'I00042',
    total: 500, amountDue: 500, dueDate: '2026-07-01', publicUrl: 'https://app.example/i/tok',
    record: { organizationId: ORG_ID, customerId: CUSTOMER_ID, entityType: 'invoice', entityId: INVOICE_ID, ...record },
    handSender: HAND_SENDER,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  resendSend.mockResolvedValue({ data: { id: 're_ok' }, error: null });
  (prisma.email.create as Mock).mockResolvedValue({ id: 'email_1' });
  (prisma.replyToken.findFirst as Mock).mockResolvedValue(null);
  // The sender's own mailbox, with its primary address.
  (prisma.mailbox.findFirst as Mock).mockResolvedValue({
    id: SENDER_MAILBOX_ID, status: 'active', addresses: [{ local_part: 'jane.smith.acme' }],
    user: { first_name: 'Jane', last_name: 'Smith' }, organization: { name: 'Acme Plumbing' },
  });
  (prisma.organization.findUnique as Mock).mockResolvedValue({ email_sending_enabled: true, name: 'Acme Plumbing' });
  (prisma.estimate.findUnique as Mock).mockResolvedValue(ESTIMATE_ROW);
  (prisma.invoice.findUnique as Mock).mockResolvedValue({ organization_id: ORG_ID, payments: [] });
});

describe.each([
  ['estimate', ESTIMATE_ID, sendEstimate],
  ['invoice', INVOICE_ID, sendInvoice],
] as const)('a %s send opens its record conversation', (kind, recordId, send) => {
  it('in the sender\'s own mailbox, with origin "record" and the record it belongs to', async () => {
    await send({});

    expect(prisma.emailThread.create).toHaveBeenCalledTimes(1);
    expect((prisma.emailThread.create as Mock).mock.calls[0][0].data).toEqual({
      organization_id: ORG_ID,
      mailbox_id: SENDER_MAILBOX_ID,
      origin: 'record',
      record_type: kind,
      record_id: recordId,
    });
    // The main mailbox is never looked up for a hand send: the only mailbox read is the sender's own.
    for (const [args] of (prisma.mailbox.findFirst as Mock).mock.calls) {
      expect(args.where).not.toMatchObject({ kind: 'main' });
    }
  });

  it('reuses the conversation a live reply token already carries, without opening another', async () => {
    (prisma.replyToken.findFirst as Mock).mockResolvedValue({
      token: 'ReUsEdToKeN0123456789', thread_id: 'thread-existing', expires_at: null, revoked_at: null,
    });

    await send({});

    expect(prisma.emailThread.create).not.toHaveBeenCalled();
    expect((prisma.email.create as Mock).mock.calls[0][0].data.thread_id).toBe('thread-existing');
  });

  it('records the person who pressed Send on the stored email and on the reply token', async () => {
    await send({});

    expect((prisma.email.create as Mock).mock.calls[0][0].data.sent_by_user_id).toBe(SENDER_ID);
    expect((prisma.replyToken.create as Mock).mock.calls[0][0].data.created_by_user_id).toBe(SENDER_ID);
  });

  it('is refused, and opens nothing, when the sender has no address of their own', async () => {
    (prisma.mailbox.findFirst as Mock).mockResolvedValue(null);

    const result = await send({});

    expect(result).toEqual({ status: 'skipped', reason: 'address_needed' });
    expect(resendSend).not.toHaveBeenCalled();
    expect(prisma.email.create).not.toHaveBeenCalled();
    expect(prisma.emailThread.create).not.toHaveBeenCalled();
  });
});
