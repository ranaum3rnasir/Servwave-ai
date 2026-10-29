import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';

// Task 4.3 — the real sendPaymentsRateChangeNotice sender (setup.ts mocks
// ../lib/email for controller tests; here we pull the actual module, same
// pattern as email-payments-action-needed.test.ts).

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

let sendPaymentsRateChangeNotice: typeof import('../lib/email')['sendPaymentsRateChangeNotice'];

beforeAll(async () => {
  const real = await vi.importActual<typeof import('../lib/email')>('../lib/email');
  sendPaymentsRateChangeNotice = real.sendPaymentsRateChangeNotice;
});

beforeEach(() => {
  vi.clearAllMocks();
  resendSend.mockResolvedValue({ id: 'msg_1' });
  (prisma.organization.findUnique as Mock).mockResolvedValue({ email_sending_enabled: true });
});

const ORG_ID = '00000000-0000-0000-0000-000000000001';

const BASE_PARAMS = {
  organizationId: ORG_ID,
  to: 'admin@acme.com',
  orgName: 'Acme Plumbing',
  oldRate: '0.50%',
  newRate: '0.75%',
  effectiveDate: 'August 20, 2026',
};

describe('sendPaymentsRateChangeNotice (Task 4.3 — within-ceiling rate-change notice)', () => {
  it('sends a co-branded notice stating the old rate, new rate, effective date, and that no action is needed', async () => {
    await sendPaymentsRateChangeNotice({ ...BASE_PARAMS });

    expect(resendSend).toHaveBeenCalledTimes(1);
    const payload = resendSend.mock.calls[0][0];
    expect(payload.to).toBe('admin@acme.com');
    expect(payload.subject).toBe('Your ServWave Payments rate is changing.');
    expect(payload.text).toContain("Acme Plumbing's ServWave Payments processing rate is changing from 0.50% to 0.75%, effective August 20, 2026.");
    expect(payload.text).toContain('No action is needed');
    expect(payload.text).toContain('no re-acceptance is required');
    expect(payload.html).toContain('0.50%');
    expect(payload.html).toContain('0.75%');
    expect(payload.html).toContain('August 20, 2026');
    expect(payload.html).toContain('No action is needed');
    expect(payload.html).toContain('no re-acceptance is required');
    // Co-branding: the ServWave wordmark header (wrapHtml's default), not a raw Stripe identity.
    expect(payload.html).toContain('ServWave');
  });

  it('escapes a hostile orgName (B-06 output encoding)', async () => {
    await sendPaymentsRateChangeNotice({
      ...BASE_PARAMS,
      orgName: '<script>alert(1)</script>',
    });

    const html = resendSend.mock.calls[0][0].html as string;
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('short-circuits on the org email_sending_enabled toggle (no provider call)', async () => {
    (prisma.organization.findUnique as Mock).mockResolvedValue({ email_sending_enabled: false });

    await sendPaymentsRateChangeNotice({ ...BASE_PARAMS });

    expect(resendSend).not.toHaveBeenCalled();
  });

  it('never throws when the provider rejects the send', async () => {
    resendSend.mockResolvedValue({ error: { message: 'domain not verified' } });

    await expect(sendPaymentsRateChangeNotice({ ...BASE_PARAMS })).resolves.toBeUndefined();
  });
});
