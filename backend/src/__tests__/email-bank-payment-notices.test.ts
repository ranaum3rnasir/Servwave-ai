/**
 * Payments go-live slice 31: what a customer who pays by bank is told. A "processing" notice when
 * the debit starts, a "didn't go through" notice with a link to pay again when it fails, and a
 * refund email whose timing line follows how the money went back. All of them reach the customer
 * whatever the org's outgoing-email switch says, stop at the hard-bounce list, and name no vendor.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';

const { resendSend } = vi.hoisted(() => ({ resendSend: vi.fn() }));

vi.mock('../config/env', () => ({
  env: { NODE_ENV: 'test', EMAIL_FROM: 'Alpha <noreply@test.com>', RESEND_API_KEY: 're_test_key', FRONTEND_URL: 'http://localhost:5173' },
}));
vi.mock('resend', () => ({ Resend: class { emails = { send: resendSend }; } }));
vi.mock('../lib/comm-persist', () => ({ persistTransactionalEmail: vi.fn().mockResolvedValue(undefined) }));

import { prisma } from '../lib/prisma';

let email: typeof import('../lib/email');
beforeAll(async () => {
  email = await vi.importActual<typeof import('../lib/email')>('../lib/email');
});

const ORG_ID = '00000000-0000-0000-0000-000000000001';
const VENDOR_NAMES = /stripe|connect|plaid|resend|supabase|render\.com|\bach\b/i;
const PAY_URL = 'http://localhost:5173/p/invoices/abc?token=tok';

beforeEach(() => {
  vi.clearAllMocks();
  resendSend.mockResolvedValue({ data: { id: 'msg_1' }, error: null });
  (prisma.organization.findUnique as Mock).mockResolvedValue({ email_sending_enabled: false, name: 'Acme Doors' });
  (prisma.emailSuppression.findFirst as Mock).mockResolvedValue(null);
});

const base = { organizationId: ORG_ID, to: 'cust@example.com', customerName: 'Cust', invoiceNumber: 'I00042', amount: 250 };
const processing = () => email.sendBankPaymentProcessingEmail(base);
const failed = (payUrl?: string) => email.sendBankPaymentFailedEmail({ ...base, ...(payUrl ? { payUrl } : {}) });
const sent = () => resendSend.mock.calls[0][0] as { html: string; text: string; subject: string };

describe('bank payment processing email', () => {
  it('says the payment is processing, takes a few business days, and a receipt follows when it clears', async () => {
    await processing();
    const { html, text } = sent();
    for (const body of [html, text]) {
      expect(body).toContain('$250.00');
      expect(body).toContain('I00042');
      expect(body).toMatch(/processing/i);
      expect(body).toContain('It usually takes a few business days.');
      expect(body).toContain("We'll send your receipt when it clears.");
    }
  });

  it('is sent with the org kill switch off, and a hard-bounced address still blocks it', async () => {
    await processing();
    expect(resendSend).toHaveBeenCalledTimes(1);
    resendSend.mockClear();
    (prisma.emailSuppression.findFirst as Mock).mockResolvedValue({ id: 's1' });
    await processing();
    expect(resendSend).not.toHaveBeenCalled();
  });
});

describe('bank payment failed email: what it reports back', () => {
  it('reports sent with the org kill switch off', async () => {
    expect(await failed(PAY_URL)).toMatchObject({ status: 'sent' });
  });

  it('reports skipped for a hard-bounced address and sends nothing', async () => {
    (prisma.emailSuppression.findFirst as Mock).mockResolvedValue({ id: 's1' });
    expect(await failed(PAY_URL)).toEqual({ status: 'skipped', reason: 'suppressed' });
    expect(resendSend).not.toHaveBeenCalled();
  });

  it('reports failed when the send throws, instead of looking like a success', async () => {
    resendSend.mockRejectedValue(new Error('network down'));
    expect(await failed(PAY_URL)).toMatchObject({ status: 'failed' });
  });
});

describe('bank payment failed email', () => {
  it('says it did not go through and links to the public invoice page to pay again', async () => {
    await failed(PAY_URL);
    const { html, text } = sent();
    for (const body of [html, text]) {
      expect(body).toContain('$250.00');
      expect(body).toContain('I00042');
      expect(body).toContain("didn't go through");
      expect(body).toContain(PAY_URL);
    }
  });

  it('is sent with the org kill switch off, and a hard-bounced address still blocks it', async () => {
    await failed(PAY_URL);
    expect(resendSend).toHaveBeenCalledTimes(1);
    resendSend.mockClear();
    (prisma.emailSuppression.findFirst as Mock).mockResolvedValue({ id: 's1' });
    await failed(PAY_URL);
    expect(resendSend).not.toHaveBeenCalled();
  });
});

describe('refund email timing follows how the money went back', () => {
  const refund = (timing?: 'card' | 'bank' | 'none') => email.sendInvoiceRefundNotification({ invoiceId: 'inv-1',
    organizationId: ORG_ID, to: 'cust@example.com', customerName: 'Cust', invoiceNumber: 'I00042', refundAmount: 25,
    ...(timing ? { timing } : {}),
  });

  it('a card refund carries the card line and not the bank line', async () => {
    await refund('card');
    const { html, text } = sent();
    for (const body of [html, text]) {
      expect(body).toContain('Refunds to cards usually appear in 5-10 business days.');
      expect(body).not.toMatch(/3 business days/);
    }
  });

  it('a bank refund carries the bank line and not the card line', async () => {
    await refund('bank');
    const { html, text } = sent();
    for (const body of [html, text]) {
      expect(body).toContain('about 3 business days after the payment clears');
      expect(body).toMatch(/can(&#39;|')t be cancelled/);
      expect(body).not.toMatch(/5-10 business days/);
    }
  });

  it('a refund recorded by hand carries no timing line at all', async () => {
    await refund('none');
    const { html, text } = sent();
    for (const body of [html, text]) {
      expect(body).not.toMatch(/business days/);
    }
  });
});

describe('no vendor name in any bank notice', () => {
  it('names none in processing, failed or the bank refund email', async () => {
    await processing();
    await failed(PAY_URL);
    await email.sendInvoiceRefundNotification({ invoiceId: 'inv-1',
      organizationId: ORG_ID, to: 'cust@example.com', customerName: 'Cust', invoiceNumber: 'I00042', refundAmount: 25, timing: 'bank',
    });
    expect(resendSend).toHaveBeenCalledTimes(3);
    for (const call of resendSend.mock.calls) {
      const { html, text, subject } = call[0] as { html: string; text: string; subject: string };
      // The pay link's host/path is a URL, not copy; strip it before the scan.
      expect(`${subject}\n${text}\n${html}`.split(PAY_URL).join('')).not.toMatch(VENDOR_NAMES);
    }
  });
});
