import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';

// Capture fn must exist before the hoisted vi.mock factory references it.
const { resendSend } = vi.hoisted(() => ({ resendSend: vi.fn() }));

// Override the global env mock (setup.ts) so the email module initializes a
// real Resend client instead of short-circuiting on a missing key.
vi.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'test',
    EMAIL_FROM: 'Alpha <noreply@test.com>',
    EMAIL_FROM_BUSINESS: 'no-reply@mail.test.com',
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

// setup.ts mocks '../lib/email' globally; pull the REAL module (including the
// test-only handle) here — same pattern as email-org-toggle.test.ts.
let dispatchEmail: typeof import('../lib/email')['__dispatchEmailForTest'];

beforeAll(async () => {
  const real = await vi.importActual<typeof import('../lib/email')>('../lib/email');
  dispatchEmail = real.__dispatchEmailForTest;
});

const PAYLOAD = { from: 'a@b.com', to: 'c@d.com', subject: 's', text: 't' } as any;

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.organization.findUnique as Mock).mockResolvedValue({ email_sending_enabled: true });
});

describe('dispatchEmail', () => {
  it('returns {status:"failed"} when Resend responds with an error object', async () => {
    resendSend.mockResolvedValue({ data: null, error: { message: 'domain not verified' } });
    const res = await dispatchEmail('org-1', PAYLOAD);
    expect(res).toEqual({ status: 'failed', error: 'domain not verified' });
  });

  // The provider id is the ONLY correlation key a Resend delivery webhook
  // carries. Throwing it away here makes every later delivery event unmatchable
  // to the row it belongs to, so the sent result has to carry it out.
  it('returns {status:"sent"} carrying the Resend message id when Resend succeeds', async () => {
    resendSend.mockResolvedValue({ data: { id: 're_1' }, error: null });
    const res = await dispatchEmail('org-1', PAYLOAD);
    expect(res).toEqual({
      status: 'sent',
      providerMessageId: 're_1',
      fromAddress: 'no-reply@mail.test.com',
      fromName: null,
    });
  });

  // resend@6 types `data` as possibly null even on the success branch. A null
  // envelope with no error is still a send that happened - it must NOT be
  // reported as failed just because we have nothing to correlate on later.
  it('reports a null-envelope success as sent with a null provider id, not as failed', async () => {
    resendSend.mockResolvedValue({ data: null, error: null });
    const res = await dispatchEmail('org-1', PAYLOAD);
    expect(res).toEqual({
      status: 'sent',
      providerMessageId: null,
      fromAddress: 'no-reply@mail.test.com',
      fromName: null,
    });
  });

  // Anti-drift: the address the result reports is the same expression the From
  // header was built from, so a persisted mirror can never disagree with what
  // was transmitted (BUG B).
  it('reports the business-subdomain address it actually transmitted from', async () => {
    resendSend.mockResolvedValue({ data: { id: 're_2' }, error: null });
    (prisma.organization.findUnique as Mock).mockResolvedValue({
      email_sending_enabled: true,
      name: 'Acme Plumbing',
    });

    const res = await dispatchEmail('org-1', PAYLOAD);

    expect(resendSend.mock.calls[0]![0].from).toBe('"Acme Plumbing" <acmeplumbing@mail.test.com>');
    expect(res).toMatchObject({ fromAddress: 'acmeplumbing@mail.test.com' });
  });

  it('reports the display name it actually put in the header, sanitized', async () => {
    resendSend.mockResolvedValue({ data: { id: 're_3' }, error: null });
    // Control characters and runaway whitespace: what the header carries is the
    // CLEANED name, so that is what the result must report. Reporting org.name
    // raw would let a mirrored row record a name the recipient never saw.
    (prisma.organization.findUnique as Mock).mockResolvedValue({
      email_sending_enabled: true,
      name: '  Acme\r\n  Plumbing  ',
    });

    const res = await dispatchEmail('org-1', PAYLOAD);

    expect(resendSend.mock.calls[0]![0].from).toBe('"Acme Plumbing" <acmeplumbing@mail.test.com>');
    expect(res).toMatchObject({ fromName: 'Acme Plumbing' });
  });

  it('reports a null fromName for a platform-voice send, which carries no org name', async () => {
    resendSend.mockResolvedValue({ data: { id: 're_4' }, error: null });
    (prisma.organization.findUnique as Mock).mockResolvedValue({
      email_sending_enabled: true,
      name: 'Acme Plumbing',
    });

    const res = await dispatchEmail('org-1', PAYLOAD, { senderIdentity: 'platform' });

    expect(resendSend.mock.calls[0]![0].from).toBe('no-reply@mail.test.com');
    expect(res).toMatchObject({ fromName: null });
  });

  it('returns {status:"skipped",reason:"org_disabled"} when the org kill-switch is off', async () => {
    (prisma.organization.findUnique as Mock).mockResolvedValue({ email_sending_enabled: false });
    const res = await dispatchEmail('org-1', PAYLOAD);
    expect(res).toEqual({ status: 'skipped', reason: 'org_disabled' });
    expect(resendSend).not.toHaveBeenCalled();
  });
});

describe('dispatchFailureStatus', () => {
  it('calls an org-disabled skip a 409, not a gateway failure', async () => {
    const real = await vi.importActual<typeof import('../lib/email')>('../lib/email');
    // Nothing upstream went wrong - the org asked for this - so telling the
    // caller to retry would be telling them to retry something that cannot
    // succeed until they turn email back on.
    expect(real.dispatchFailureStatus({ status: 'skipped', reason: 'org_disabled' })).toBe(409);
  });

  it('calls a missing key and a provider rejection 502', async () => {
    const real = await vi.importActual<typeof import('../lib/email')>('../lib/email');
    expect(real.dispatchFailureStatus({ status: 'skipped', reason: 'no_api_key' })).toBe(502);
    expect(real.dispatchFailureStatus({ status: 'failed', error: 'nope' })).toBe(502);
  });
});
