import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';

// Task 1.9 — the real sendPaymentsActionNeededEmail sender (setup.ts mocks
// ../lib/email for controller tests; here we pull the actual module, same
// pattern as email-po-sender.test.ts / email-org-toggle.test.ts).

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

let sendPaymentsActionNeededEmail: typeof import('../lib/email')['sendPaymentsActionNeededEmail'];

beforeAll(async () => {
  const real = await vi.importActual<typeof import('../lib/email')>('../lib/email');
  sendPaymentsActionNeededEmail = real.sendPaymentsActionNeededEmail;
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
  fixUrl: 'http://localhost:5173/settings/payments',
};

describe('sendPaymentsActionNeededEmail (Task 1.9 — co-branded action-needed email)', () => {
  it('sends with the §6.8 subject, a "Finish setup" CTA deep-linking to fixUrl, and ServWave (not raw Stripe) header branding', async () => {
    await sendPaymentsActionNeededEmail({ ...BASE_PARAMS });

    expect(resendSend).toHaveBeenCalledTimes(1);
    const payload = resendSend.mock.calls[0][0];
    expect(payload.to).toBe('admin@acme.com');
    // §6.8: "Action needed | Status card / email subject | Stripe needs one more thing to keep your payments running."
    expect(payload.subject).toBe('Stripe needs one more thing to keep your payments running.');
    // Personalized body copy (brief Step 3): "Stripe needs one more thing to keep {orgName}'s card payments running."
    expect(payload.text).toContain("Stripe needs one more thing to keep Acme Plumbing's card payments running.");
    expect(payload.text).toContain(BASE_PARAMS.fixUrl);
    expect(payload.html).toContain("Stripe needs one more thing to keep <strong>Acme Plumbing</strong>'s card payments running.");
    expect(payload.html).toContain(`href="${BASE_PARAMS.fixUrl}"`);
    expect(payload.html).toContain('Finish setup');
    // Co-branding: the ServWave wordmark header (wrapHtml's default), not a raw Stripe identity.
    expect(payload.html).toContain('ServWave');
    // Raw Stripe requirement codes must NEVER reach the contractor-facing copy -
    // the specific to-do always lives on Stripe's own screens behind the CTA.
    expect(payload.text).not.toContain('individual.');
    expect(payload.text).not.toContain('requirements.');
    expect(payload.html).not.toContain('individual.');
    expect(payload.html).not.toContain('requirements.');
    // The old "What Stripe needs: <raw code>" detail box is gone entirely - no
    // leftover label and no stringified-undefined placeholder in its place.
    expect(payload.html).not.toContain('What Stripe needs');
    expect(payload.html).not.toContain('undefined');
    expect(payload.text).not.toContain('undefined');
  });

  it('escapes a hostile orgName (B-06 output encoding)', async () => {
    await sendPaymentsActionNeededEmail({
      ...BASE_PARAMS,
      orgName: '<script>alert(1)</script>',
    });

    const html = resendSend.mock.calls[0][0].html as string;
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('short-circuits on the org email_sending_enabled toggle (no provider call)', async () => {
    (prisma.organization.findUnique as Mock).mockResolvedValue({ email_sending_enabled: false });

    await sendPaymentsActionNeededEmail({ ...BASE_PARAMS });

    expect(resendSend).not.toHaveBeenCalled();
  });

  it('never throws when the provider rejects the send', async () => {
    resendSend.mockResolvedValue({ error: { message: 'domain not verified' } });

    await expect(sendPaymentsActionNeededEmail({ ...BASE_PARAMS })).resolves.toBeUndefined();
  });
});
