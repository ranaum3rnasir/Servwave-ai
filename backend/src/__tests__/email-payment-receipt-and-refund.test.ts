/**
 * Payments go-live slice 30: the customer's receipt and refund emails reach them even when the
 * org's outgoing-email kill switch is off (the default), still stop at the hard-bounce list,
 * itemise the money, and name no vendor.
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
const VENDOR_NAMES = /stripe|connect|plaid|resend|supabase|render\.com/i;

beforeEach(() => {
  vi.clearAllMocks();
  resendSend.mockResolvedValue({ data: { id: 'msg_1' }, error: null });
  (prisma.organization.findUnique as Mock).mockResolvedValue({ email_sending_enabled: false, name: 'Acme Doors' });
  (prisma.emailSuppression.findFirst as Mock).mockResolvedValue(null);
});

const receipt = (over: Record<string, unknown> = {}) => email.sendPaymentReceivedEmail({
  organizationId: ORG_ID,
  to: 'cust@example.com',
  customerName: 'Cust',
  invoiceNumber: 'I00042',
  amount: 100,
  method: 'CARD',
  newBalance: 0,
  ...over,
} as Parameters<typeof email.sendPaymentReceivedEmail>[0]);

const refund = () => email.sendInvoiceRefundNotification({ invoiceId: 'inv-1',
  timing: 'card',
  organizationId: ORG_ID,
  to: 'cust@example.com',
  customerName: 'Cust',
  invoiceNumber: 'I00042',
  refundAmount: 25,
});

describe('receipt and refund emails with the org kill switch off', () => {
  it('sends the payment receipt', async () => {
    await receipt();
    expect(resendSend).toHaveBeenCalledTimes(1);
  });

  it('sends the refund email', async () => {
    await refund();
    expect(resendSend).toHaveBeenCalledTimes(1);
  });

  it('a suppressed (hard-bounced) address still blocks the receipt', async () => {
    (prisma.emailSuppression.findFirst as Mock).mockResolvedValue({ id: 's1' });
    await receipt();
    expect(resendSend).not.toHaveBeenCalled();
  });

  it('a suppressed address still blocks the refund email', async () => {
    (prisma.emailSuppression.findFirst as Mock).mockResolvedValue({ id: 's1' });
    await refund();
    expect(resendSend).not.toHaveBeenCalled();
  });

  it('other business email stays behind the kill switch', async () => {
    await email.sendDepositPaymentConfirmation({
      organizationId: ORG_ID, to: 'cust@example.com', customerName: 'Cust', estimateNumber: 'E1', estimateId: 'est-1',
      depositAmount: 10, totalCharged: 10, paymentMethod: 'Credit Card', companyName: 'Acme',
    } as Parameters<typeof email.sendDepositPaymentConfirmation>[0]);
    expect(resendSend).not.toHaveBeenCalled();
  });
});

describe('receipt body', () => {
  const sent = () => resendSend.mock.calls[0][0] as { html: string; text: string };

  it('itemises invoice number, amount applied, tip, total charged and the method shown as Link', async () => {
    await receipt({ amount: 100, tip: 15, methodDisplay: 'Link', newBalance: 0 });
    const { html, text } = sent();
    for (const body of [html, text]) {
      expect(body).toContain('I00042');
      expect(body).toContain('$100.00');
      expect(body).toContain('$15.00');
      expect(body).toContain('$115.00');
      expect(body).toContain('Link');
    }
    expect(html).toMatch(/Amount applied/i);
    expect(html).toMatch(/Tip/);
    expect(html).toMatch(/Total charged/i);
  });

  it('leaves the tip line out when there is none, and totals the amount alone', async () => {
    await receipt({ amount: 80, newBalance: 20 });
    const { html } = sent();
    expect(html).not.toMatch(/>Tip</);
    expect(html).toContain('Total charged');
    expect(html).toContain('$80.00');
  });

  it('names no vendor in the receipt or the refund email', async () => {
    await receipt({ tip: 5, methodDisplay: 'Link' });
    await refund();
    expect(resendSend).toHaveBeenCalledTimes(2);
    for (const call of resendSend.mock.calls) {
      const { html, text, subject } = call[0] as { html: string; text: string; subject: string };
      expect(`${subject}\n${text}\n${html}`).not.toMatch(VENDOR_NAMES);
    }
  });
});

describe('refund body', () => {
  it('states the amount and the 5-10 business day card timing', async () => {
    await refund();
    const { html, text } = resendSend.mock.calls[0][0] as { html: string; text: string };
    for (const body of [html, text]) {
      expect(body).toContain('$25.00');
      expect(body).toContain('Refunds to cards usually appear in 5-10 business days.');
    }
  });
});
