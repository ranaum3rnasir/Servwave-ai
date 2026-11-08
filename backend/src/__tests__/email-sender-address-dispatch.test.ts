// Companion to email-sender-local-part-override.test.ts, one level up: that
// spec covers the derivation, this one proves dispatchEmail actually READS the
// stored override and puts it on the wire. The two are separate because a
// correct helper wired to nothing still sends the old address.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';

const { resendSend } = vi.hoisted(() => ({ resendSend: vi.fn() }));

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

let dispatchEmail: typeof import('../lib/email')['__dispatchEmailForTest'];

beforeAll(async () => {
  const real = await vi.importActual<typeof import('../lib/email')>('../lib/email');
  dispatchEmail = real.__dispatchEmailForTest;
});

const PAYLOAD = { to: 'customer@example.com', subject: 's', text: 't' } as never;
const ORG_ID = 'org-1';

/** The org row dispatchEmail reads, with whatever override is under test. */
function orgRow(email_sender_local_part: string | null) {
  return { email_sending_enabled: true, name: 'Northwind Services', email_sender_local_part };
}

beforeEach(() => {
  vi.clearAllMocks();
  resendSend.mockResolvedValue({ data: { id: 're_1' }, error: null });
});

describe('dispatchEmail - org sender local part', () => {
  it('sends from the derived address when the org has set no override', async () => {
    (prisma.organization.findUnique as Mock).mockResolvedValue(orgRow(null));

    const res = await dispatchEmail(ORG_ID, PAYLOAD);

    expect(res).toMatchObject({ fromAddress: 'northwindservices@mail.test.com' });
  });

  it('sends from the org own local part when one is set', async () => {
    (prisma.organization.findUnique as Mock).mockResolvedValue(orgRow('service'));

    const res = await dispatchEmail(ORG_ID, PAYLOAD);

    expect(res).toMatchObject({ fromAddress: 'service@mail.test.com' });
    expect(resendSend.mock.calls[0]![0].from).toBe('"Northwind Services" <service@mail.test.com>');
  });

  it('keeps the shared domain - the override is the local part only', async () => {
    // The whole point of the in-house model: an org never changes the domain,
    // so a value that looks like a full address must not become one.
    (prisma.organization.findUnique as Mock).mockResolvedValue(orgRow('service'));

    const res = await dispatchEmail(ORG_ID, PAYLOAD);

    expect((res as { fromAddress: string }).fromAddress.endsWith('@mail.test.com')).toBe(true);
  });

  it('leaves the display name alone - that is still the company name', async () => {
    // Changing the address must not change who the message says it is from.
    (prisma.organization.findUnique as Mock).mockResolvedValue(orgRow('service'));

    const res = await dispatchEmail(ORG_ID, PAYLOAD);

    expect(res).toMatchObject({ fromName: 'Northwind Services' });
  });

  it('names the Reply-To with the company name, not the local part', async () => {
    // Guards the interaction with the reply-address naming shipped in #1373.
    (prisma.organization.findUnique as Mock).mockResolvedValue(orgRow('service'));

    await dispatchEmail(ORG_ID, { ...(PAYLOAD as object), replyTo: 'tok@reply.test.com' } as never);

    expect(resendSend.mock.calls[0]![0].replyTo).toBe('"Northwind Services" <tok@reply.test.com>');
  });

  it('ignores the override on a platform-voice send, which is not the org speaking', async () => {
    (prisma.organization.findUnique as Mock).mockResolvedValue(orgRow('service'));

    const res = await dispatchEmail(ORG_ID, PAYLOAD, { senderIdentity: 'platform' });

    expect(res).toMatchObject({ fromAddress: 'no-reply@mail.test.com', fromName: null });
  });
});
