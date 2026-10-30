/**
 * Payments go-live slice 32 (carry-over from the slice 30 staging acceptance): every email the
 * customer gets about their own money carries a resolvable Reply-To, as the receipt does. The
 * refund email went out without one; the three bank payment emails are pinned here so a reply to
 * any of them lands on the invoice's thread.
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
    FRONTEND_URL: 'http://localhost:5173',
  },
}));
vi.mock('resend', () => ({ Resend: class { emails = { send: resendSend }; } }));

import { prisma } from '../lib/prisma';

type Email = typeof import('../lib/email');
let email: Email;
beforeAll(async () => {
  email = await vi.importActual<Email>('../lib/email');
});

const ORG_ID = '00000000-0000-0000-0000-000000000001';
const RECORD = {
  organizationId: ORG_ID,
  customerId: 'c0000000-0000-0000-0000-000000000001',
  entityType: 'invoice' as const,
  entityId: 'i0000000-0000-0000-0000-000000000001',
};
const REPLY_ADDRESS = /^[A-Za-z0-9_-]{22}@reply\.test\.com$/;

function replyToAddress(): string | undefined {
  const raw = resendSend.mock.calls[0][0].replyTo;
  if (raw === undefined) return undefined;
  const one = Array.isArray(raw) ? raw[0] : raw;
  const angled = String(one ?? '').match(/<([^>]*)>/);
  return (angled ? angled[1] : String(one ?? '')).trim();
}

beforeEach(() => {
  vi.clearAllMocks();
  resendSend.mockResolvedValue({ data: { id: 're_ok' }, error: null });
  (prisma.organization.findUnique as Mock).mockResolvedValue({ email_sending_enabled: false, name: 'Acme Doors' });
  (prisma.emailSuppression.findFirst as Mock).mockResolvedValue(null);
  (prisma.replyToken.findFirst as Mock).mockResolvedValue(null);
  (prisma.replyToken.create as Mock).mockResolvedValue({});
  (prisma.emailThread.create as Mock).mockResolvedValue({ id: 'thread_1' });
  (prisma.email.create as Mock).mockResolvedValue({ id: 'email_1' });
});

const base = { organizationId: ORG_ID, to: 'cust@example.com', customerName: 'Cust', invoiceNumber: 'I00042', record: RECORD };

describe('Reply-To on the emails about the customer\'s money', () => {
  it('the receipt carries one (control)', async () => {
    await email.sendPaymentReceivedEmail({ ...base, amount: 50, method: 'CARD', newBalance: 0 });
    expect(replyToAddress()).toMatch(REPLY_ADDRESS);
  });

  it('the invoice refund email carries one', async () => {
    await email.sendInvoiceRefundNotification({ ...base, invoiceId: RECORD.entityId, refundAmount: 50 });
    expect(replyToAddress()).toMatch(REPLY_ADDRESS);
  });

  it('the bank payment "processing" email carries one', async () => {
    await email.sendBankPaymentProcessingEmail({ ...base, amount: 50 });
    expect(replyToAddress()).toMatch(REPLY_ADDRESS);
  });

  it('the bank payment "failed" email carries one', async () => {
    await email.sendBankPaymentFailedEmail({ ...base, amount: 50, payUrl: 'http://localhost:5173/p/invoices/x?token=t' });
    expect(replyToAddress()).toMatch(REPLY_ADDRESS);
  });
});

describe('the refund email is anchored by the invoice, whichever door sends it (D1)', () => {
  it('carries a Reply-To when the caller names only the invoice, not a full record', async () => {
    const { entityType: _t, entityId: _i, ...bare } = RECORD;
    await email.sendInvoiceRefundNotification({
      organizationId: ORG_ID, to: 'cust@example.com', customerName: 'Cust', invoiceNumber: 'I00042',
      invoiceId: RECORD.entityId, refundAmount: 50, record: bare,
    } as Parameters<typeof email.sendInvoiceRefundNotification>[0]);
    expect(replyToAddress()).toMatch(REPLY_ADDRESS);
  });
});
