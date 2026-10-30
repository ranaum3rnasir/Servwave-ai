/**
 * Payments go-live slice 32 fix (D2): the owner's payment email fan-out survives the mail service's
 * rate limit. The mail service answers HTTP 429 above 10 requests a second; an org with 13 active
 * admins used to lose the refused messages for good. Here the mail client enforces that limit in
 * (fake) time, and the real notifyOwners + real sender must still land exactly one email per admin.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';

const { resendSend } = vi.hoisted(() => ({ resendSend: vi.fn() }));

vi.mock('../config/env', () => ({
  env: { NODE_ENV: 'test', EMAIL_FROM: 'noreply@test.servwave.com', EMAIL_FROM_BUSINESS: 'noreply@mail.test.servwave.com', RESEND_API_KEY: 're_test_key', FRONTEND_URL: 'http://localhost:5173' },
}));
vi.mock('resend', () => ({ Resend: class { emails = { send: resendSend }; } }));
vi.mock('../lib/email', async () => await vi.importActual('../lib/email'));
// The in-app half goes through the billing alerts' two-lane chain (S06.28); this file is about the emails that follow it, so the
// chain is stood in for by what it answers: the people it told (none when the event is a replay).
vi.mock('../services/notifications/invoiceBillingAlerts', () => ({ alertInvoice: vi.fn(), isBillingAlertVerb: () => true }));
// The emails go to the holders of the alert's step switch (S06.29): who they are is proved in permission-no-record-alerts-db.test.ts;
// here the chain is stood in for by the addresses it answers, and the rate limit is the subject.
vi.mock('../services/notifications/stepHolderEmails', () => ({ stepHolderEmails: vi.fn() }));

import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { alertInvoice as emit } from '../services/notifications/invoiceBillingAlerts';
import { stepHolderEmails } from '../services/notifications/stepHolderEmails';
import { notifyOwners } from '../lib/owner-payment-notices';

const notice = {
  verb: 'billing.disputed',
  organizationId: '00000000-0000-0000-0000-000000000001',
  object: { type: 'INVOICE' as const, id: 'inv-1', label: 'I00042' },
  data: { amount: '$300.00', reason: 'Fraudulent', respond_by: 'October 20, 2026' },
  dedupKey: 'dispute:du_1',
  actionLabel: 'Open the invoice',
};
const admins = Array.from({ length: 13 }, (_, i) => ({ email: `admin${i + 1}@example.test` }));
const rateLimited = { data: null, error: { name: 'rate_limit_exceeded', statusCode: 429, message: 'Too many requests. You can only make 10 requests per second.' } };

async function run(): Promise<void> {
  const done = notifyOwners(notice);
  await vi.runAllTimersAsync();
  await done;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  (emit as Mock).mockResolvedValue(['admin-1']);
  (stepHolderEmails as Mock).mockResolvedValue(admins.map((a) => a.email));
  (prisma.organization.findUnique as Mock).mockResolvedValue({ email_sending_enabled: false, name: 'Acme Doors' });
  (prisma.emailSuppression.findFirst as Mock).mockResolvedValue(null);
});
afterEach(() => vi.useRealTimers());

describe('owner payment emails under the mail service rate limit', () => {
  it('13 admins each receive exactly one email when sends over 10 a second are refused with 429', async () => {
    const accepted: string[] = [];
    const stamps: number[] = [];
    resendSend.mockImplementation(async (msg: { to: string }) => {
      const now = Date.now();
      if (stamps.filter((t) => now - t < 1000).length >= 10) return rateLimited;
      stamps.push(now);
      accepted.push(msg.to);
      return { data: { id: `m${accepted.length}` }, error: null };
    });

    await run();

    expect([...accepted].sort()).toEqual(admins.map((a) => a.email).sort());
  });

  it('a refused send is retried and lands once, never twice', async () => {
    const seen = new Map<string, number>();
    resendSend.mockImplementation(async (msg: { to: string }) => {
      const n = (seen.get(msg.to) ?? 0) + 1;
      seen.set(msg.to, n);
      return n === 1 ? rateLimited : { data: { id: 'ok' }, error: null };
    });

    await run();

    for (const a of admins) expect(seen.get(a.email)).toBe(2);
  });

  it('a send that keeps being refused is logged, does not throw, and does not stop the others', async () => {
    resendSend.mockImplementation(async (msg: { to: string }) =>
      msg.to === 'admin3@example.test' ? rateLimited : { data: { id: 'ok' }, error: null });

    await expect(run()).resolves.toBeUndefined();

    expect((logger.error as Mock)).toHaveBeenCalled();
    const delivered = resendSend.mock.calls.map((c) => c[0].to).filter((to) => to !== 'admin3@example.test');
    expect(new Set(delivered).size).toBe(12);
    // bounded: the stuck one is not retried forever
    expect(resendSend.mock.calls.filter((c) => c[0].to === 'admin3@example.test').length).toBeLessThanOrEqual(5);
  });

  it('a suppressed address is skipped while the rest are sent', async () => {
    (prisma.emailSuppression.findFirst as Mock).mockImplementation(async ({ where }: { where: { email?: string } }) =>
      JSON.stringify(where).includes('admin5@example.test') ? { id: 's' } : null);
    resendSend.mockResolvedValue({ data: { id: 'ok' }, error: null });

    await run();

    const to = resendSend.mock.calls.map((c) => c[0].to);
    expect(to).not.toContain('admin5@example.test');
    expect(to).toHaveLength(12);
  });

  it('a replayed event sends nothing', async () => {
    (emit as Mock).mockResolvedValue([]);
    await run();
    expect(resendSend).not.toHaveBeenCalled();
  });
});
