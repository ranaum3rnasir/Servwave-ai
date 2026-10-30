import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';

// Payments go-live slice 28 — the deposit-received email names the hand-recorded bank transfer as
// a bank transfer: ACH means the online bank debit only. Pulls the real sender (setup.ts mocks
// ../lib/email for controller tests).

// Capture fn must exist before the hoisted vi.mock factory references it.
const { resendSend } = vi.hoisted(() => ({ resendSend: vi.fn() }));

// Override the global env mock (setup.ts) so the email module initializes a
// real Resend client instead of short-circuiting on a missing key.
vi.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'test',
    EMAIL_FROM: 'ServWave <noreply@test.com>',
    RESEND_API_KEY: 're_test_key',
    FRONTEND_URL: 'http://localhost:5173',
  },
}));

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: resendSend };
  },
}));

import { prisma } from '../lib/prisma';

let sendDepositReceivedConfirmation: typeof import('../lib/email')['sendDepositReceivedConfirmation'];

beforeAll(async () => {
  const real = await vi.importActual<typeof import('../lib/email')>('../lib/email');
  sendDepositReceivedConfirmation = real.sendDepositReceivedConfirmation;
});

beforeEach(() => {
  vi.clearAllMocks();
  resendSend.mockResolvedValue({ id: 'msg_1' });
  (prisma.organization.findUnique as Mock).mockResolvedValue({ email_sending_enabled: true });
});

const params = (paymentMethod: string) => ({
  organizationId: '00000000-0000-0000-0000-000000000001',
  to: 'pat@example.test',
  customerName: 'Pat',
  estimateNumber: 'EST-1',
  estimateId: 'est-1',
  depositAmount: 100,
  paymentMethod,
  receivedDate: 'Oct 10, 2026',
  companyName: 'Acme Plumbing',
});

describe('sendDepositReceivedConfirmation payment method', () => {
  it('a hand-recorded bank transfer reads "Bank transfer", never ACH', async () => {
    await sendDepositReceivedConfirmation(params('BANK_TRANSFER'));

    const payload = resendSend.mock.calls[0][0];
    expect(payload.text).toContain('received via Bank transfer on');
    expect(payload.html).toContain('Bank transfer');
    expect(payload.html).not.toContain('ACH');
  });
});
