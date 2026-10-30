/**
 * Payments go-live slice 32: the email an owner gets for a payment event (a dispute, a failed bank
 * payment, a failed refund, money that could not be applied). Sent from the platform's own voice,
 * past the org's customer-email switch (it is about the owner's own money), stopped only by the
 * hard-bounce list; carries the same words as the in-app notification and a link to act, and names
 * no vendor.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';

const { resendSend } = vi.hoisted(() => ({ resendSend: vi.fn() }));

vi.mock('../config/env', () => ({
  env: { NODE_ENV: 'test', EMAIL_FROM: 'noreply@test.servwave.com', EMAIL_FROM_BUSINESS: 'noreply@mail.test.servwave.com', RESEND_API_KEY: 're_test_key', FRONTEND_URL: 'http://localhost:5173' },
}));
vi.mock('resend', () => ({ Resend: class { emails = { send: resendSend }; } }));

import { prisma } from '../lib/prisma';

let email: typeof import('../lib/email');
beforeAll(async () => {
  email = await vi.importActual<typeof import('../lib/email')>('../lib/email');
});

const VENDOR_NAMES = /stripe|connect\b|plaid|resend|supabase|render\.com|\bach\b/i;
const params = {
  organizationId: '00000000-0000-0000-0000-000000000001',
  to: 'owner@example.com',
  subject: 'Payment disputed for I00042',
  heading: 'Payment disputed for I00042',
  lines: ['Reason: Fraudulent. Respond by October 20, 2026.'],
  actionUrl: 'http://localhost:5173/invoices/abc',
  actionLabel: 'Open the invoice',
};
const sent = () => resendSend.mock.calls[0][0] as { to: string; html: string; text: string; subject: string; from: string };

beforeEach(() => {
  vi.clearAllMocks();
  resendSend.mockResolvedValue({ data: { id: 'msg_1' }, error: null });
  (prisma.organization.findUnique as Mock).mockResolvedValue({ email_sending_enabled: false, name: 'Acme Doors' });
  (prisma.emailSuppression.findFirst as Mock).mockResolvedValue(null);
});

describe('owner payment notice email', () => {
  it('carries the subject, every line, and a link to act on, in the html and the text', async () => {
    await email.sendOwnerPaymentNoticeEmail(params);
    const mail = sent();
    expect(mail.to).toBe('owner@example.com');
    expect(mail.subject).toBe('Payment disputed for I00042');
    for (const body of [mail.html, mail.text]) {
      expect(body).toContain('Reason: Fraudulent. Respond by October 20, 2026.');
      expect(body).toContain('http://localhost:5173/invoices/abc');
    }
    expect(mail.html).toContain('Open the invoice');
  });

  it('speaks as the platform, not as the org, and is sent with the customer-email switch off', async () => {
    await email.sendOwnerPaymentNoticeEmail(params);
    expect(resendSend).toHaveBeenCalledTimes(1);
    expect(sent().from).not.toContain('Acme');
  });

  it('a hard-bounced address still blocks it', async () => {
    (prisma.emailSuppression.findFirst as Mock).mockResolvedValue({ id: 's1' });
    await email.sendOwnerPaymentNoticeEmail(params);
    expect(resendSend).not.toHaveBeenCalled();
  });

  it('escapes what it was given, and names no vendor', async () => {
    await email.sendOwnerPaymentNoticeEmail({ ...params, lines: ['A refund to <b>Pat & Co</b> failed.'] });
    const mail = sent();
    expect(mail.html).not.toContain('<b>Pat');
    expect(mail.html).toContain('&lt;b&gt;Pat');
    expect(`${mail.subject} ${mail.html} ${mail.text}`).not.toMatch(VENDOR_NAMES);
  });

  it('never throws when the provider rejects it', async () => {
    resendSend.mockResolvedValue({ data: null, error: { message: 'domain not verified' } });
    await expect(email.sendOwnerPaymentNoticeEmail(params)).resolves.toBeUndefined();
  });
});
