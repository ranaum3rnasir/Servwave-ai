/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.1 - automated mail takes the company address from the
   mailbox address register, on this environment's mailbox domain.

   Through dispatchEmail (the one choke point that owns the From header) and orgSendingIdentity (the
   compose box's "Sending as" line), with the organization row they read faked. The real-database
   counterpart is email-from-register-db.test.ts.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';

const { resendSend } = vi.hoisted(() => ({ resendSend: vi.fn() }));

vi.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'test',
    EMAIL_FROM: 'Alpha <noreply@test.com>',
    EMAIL_FROM_BUSINESS: 'no-reply@mail.test.com',
    MAILBOX_DOMAIN: 'staging.mail.test.com',
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

let real: typeof import('../lib/email');

beforeAll(async () => {
  real = await vi.importActual<typeof import('../lib/email')>('../lib/email');
});

const PAYLOAD = { to: 'customer@example.com', subject: 's', text: 't' } as never;

/** The organization row as the register hands it over: the main mailbox's primary address nested in. */
function orgRow(over: { name?: string; column?: string | null; registered?: string | null } = {}) {
  const registered = over.registered === undefined ? 'acme' : over.registered;
  return {
    email_sending_enabled: true,
    name: over.name ?? 'Acme Doors',
    email_sender_local_part: over.column === undefined ? 'acme' : over.column,
    mailboxes: registered ? [{ addresses: [{ local_part: registered }] }] : [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resendSend.mockResolvedValue({ data: { id: 're_1' }, error: null });
});

describe('dispatchEmail - the From address comes from the register', () => {
  it('sends from the register’s main address on the mailbox domain, and reports the same address', async () => {
    (prisma.organization.findUnique as Mock).mockResolvedValue(orgRow());

    const res = await real.__dispatchEmailForTest('org-1', PAYLOAD);

    expect(res).toMatchObject({ status: 'sent', fromAddress: 'acme@staging.mail.test.com' });
    expect(resendSend.mock.calls[0]![0].from).toBe('"Acme Doors" <acme@staging.mail.test.com>');
  });

  it('does not move when the company is renamed: the name changed, the address the register issued did not', async () => {
    (prisma.organization.findUnique as Mock).mockResolvedValue(
      orgRow({ name: 'Totally New Name Inc', column: null, registered: 'acme' }),
    );

    const res = await real.__dispatchEmailForTest('org-1', PAYLOAD);

    expect(res).toMatchObject({ fromAddress: 'acme@staging.mail.test.com', fromName: 'Totally New Name Inc' });
  });

  it('prefers the register over the stored part when they disagree', async () => {
    (prisma.organization.findUnique as Mock).mockResolvedValue(orgRow({ column: 'stale', registered: 'issued' }));

    const res = await real.__dispatchEmailForTest('org-1', PAYLOAD);

    expect(res).toMatchObject({ fromAddress: 'issued@staging.mail.test.com' });
  });

  it('asks the database for the register in the same read as the rest of the organization', async () => {
    (prisma.organization.findUnique as Mock).mockResolvedValue(orgRow());

    await real.__dispatchEmailForTest('org-1', PAYLOAD);

    const select = (prisma.organization.findUnique as Mock).mock.calls[0]![0].select;
    expect(select.mailboxes).toMatchObject({ where: { kind: 'main' } });
  });

  it('still sends from the stored part for a company the register has not reached yet', async () => {
    (prisma.organization.findUnique as Mock).mockResolvedValue(orgRow({ column: 'service', registered: null }));

    const res = await real.__dispatchEmailForTest('org-1', PAYLOAD);

    expect(res).toMatchObject({ fromAddress: 'service@staging.mail.test.com' });
  });

  it('keeps the platform’s own notices on the shared no-reply address, outside the register', async () => {
    (prisma.organization.findUnique as Mock).mockResolvedValue(orgRow());

    const res = await real.__dispatchEmailForTest('org-1', PAYLOAD, { senderIdentity: 'platform' });

    expect(res).toMatchObject({ fromAddress: 'no-reply@mail.test.com' });
  });
});

describe('orgSendingIdentity - the compose box shows the address the send will use', () => {
  it('reports the register’s address, its part and its domain', async () => {
    (prisma.organization.findUnique as Mock).mockResolvedValue(orgRow({ name: 'Renamed Co', column: null }));

    const identity = await real.orgSendingIdentity('org-1');

    expect(identity).toMatchObject({
      address: 'acme@staging.mail.test.com',
      localPart: 'acme',
      senderDomain: 'staging.mail.test.com',
    });
  });
});
