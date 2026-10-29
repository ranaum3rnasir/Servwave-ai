/**
 * email-calendar-entry-senders.test.ts — slice 07 (spec §5)
 *
 * Direct tests of the three lib/email.ts senders, UNMOCKED (setup.ts mocks the whole `lib/email`
 * module for controller tests; this file pulls in the real implementation via importActual, the
 * same pattern email-visit-cancelled.test.ts and email-transactional-reply-token.test.ts use),
 * so the actual Resend dispatch payload is captured.
 *
 * Two things this file exists to prove that no controller-level test (with lib/email mocked)
 * ever could:
 *
 *   1. All three senders set `replyTo` on the dispatch payload — the assertion that would have
 *      caught #1594→#1603 (every transactional sender before that fix went out with no Reply-To
 *      at all, so a customer reply bounced silently against a receiving-disabled domain).
 *   2. MOVED and CANCELLED render FIXED wording — there is no `message` parameter on either
 *      sender's signature for a caller to even attempt to override (spec §5: a dispatcher who
 *      has to hand-write the reschedule notice skips the compose step, which is #1550 arriving
 *      through the UI instead of through a status check).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';

const { resendSend } = vi.hoisted(() => ({ resendSend: vi.fn() }));

vi.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'test',
    EMAIL_FROM: 'noreply@test.servwave.com',
    EMAIL_FROM_BUSINESS: 'noreply@mail.test.servwave.com',
    EMAIL_REPLY_DOMAIN: 'reply.test.com',
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

type Email = typeof import('../lib/email');
let email: Email;

beforeAll(async () => {
  email = await vi.importActual<Email>('../lib/email');
});

const ORG_ID = '00000000-0000-0000-0000-000000000001';
const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000001';
const ENTRY_ID = 'ce000000-0000-0000-0000-000000000001';
const REPLY_DOMAIN = 'reply.test.com';
const NY = 'America/New_York';
// 13:00Z is 9:00 AM New York in September (EDT). The whole point of picking a UTC instant that
// is NOT the wall-clock hour is that the server runs in UTC — an unzoned render would say 1:00 PM.
const NEW_START = new Date('2026-09-15T13:00:00.000Z');

const RECORD = {
  organizationId: ORG_ID,
  customerId: CUSTOMER_ID,
  entityType: 'calendar_entry',
  entityId: ENTRY_ID,
};

/** The Reply-To Resend was actually handed, unwrapped from any display name. */
function replyToAddress(): string | undefined {
  const raw = resendSend.mock.calls[0][0].replyTo;
  if (raw === undefined) return undefined;
  const one = Array.isArray(raw) ? raw[0] : raw;
  const angled = String(one ?? '').match(/<([^>]*)>/);
  return (angled ? angled[1] : String(one ?? '')).trim();
}

beforeEach(() => {
  vi.clearAllMocks();
  resendSend.mockResolvedValue({ data: { id: 're_ok' }, error: null });
  (prisma.organization.findUnique as Mock).mockResolvedValue({
    email_sending_enabled: true,
    name: 'Acme Plumbing',
  });
  (prisma.replyToken.findFirst as Mock).mockResolvedValue(null);
  (prisma.replyToken.create as Mock).mockResolvedValue({});
  (prisma.emailThread.create as Mock).mockResolvedValue({ id: 'thread_1' });
  (prisma.email.create as Mock).mockResolvedValue({ id: 'email_1' });
});

describe('sendCalendarEntryScheduledEmail', () => {
  it('sets a resolvable Reply-To on the dispatch payload', async () => {
    await email.sendCalendarEntryScheduledEmail({
      organizationId: ORG_ID, to: 'jane@example.com', customerName: 'Jane Doe',
      entryTitle: 'Meet the Smiths', start: NEW_START, timezone: NY, record: RECORD,
    });

    expect(resendSend).toHaveBeenCalledTimes(1);
    expect(replyToAddress()).toMatch(new RegExp(`^[A-Za-z0-9_-]{22}@${REPLY_DOMAIN.replace('.', '\\.')}$`));
  });

  it('renders the composer\'s free text in place of the boilerplate', async () => {
    await email.sendCalendarEntryScheduledEmail({
      organizationId: ORG_ID, to: 'jane@example.com', customerName: 'Jane Doe',
      entryTitle: 'Meet the Smiths', start: NEW_START, timezone: NY,
      message: 'Looking forward to meeting you at the Smiths’ place!',
    });

    const sent = resendSend.mock.calls[0][0];
    expect(sent.html).toContain('Looking forward to meeting you at the Smiths');
    expect(sent.text).toContain('Looking forward to meeting you at the Smiths');
  });

  it('falls back to a plain default line when no message is supplied', async () => {
    await email.sendCalendarEntryScheduledEmail({
      organizationId: ORG_ID, to: 'jane@example.com', customerName: 'Jane Doe',
      entryTitle: 'Meet the Smiths', start: NEW_START, timezone: NY,
    });

    const sent = resendSend.mock.calls[0][0];
    expect(sent.html).toContain("You've been added to");
    expect(sent.html).toContain('Meet the Smiths');
  });

  it('subject names the entry', async () => {
    await email.sendCalendarEntryScheduledEmail({
      organizationId: ORG_ID, to: 'jane@example.com', customerName: 'Jane Doe',
      entryTitle: 'Meet the Smiths', start: NEW_START, timezone: NY,
    });

    expect(resendSend.mock.calls[0][0].subject).toBe("You're Invited: Meet the Smiths");
  });
});

describe('sendCalendarEntryMovedEmail', () => {
  it('sets a resolvable Reply-To on the dispatch payload', async () => {
    await email.sendCalendarEntryMovedEmail({
      organizationId: ORG_ID, to: 'jane@example.com', customerName: 'Jane Doe',
      entryTitle: 'Meet the Smiths', newStart: NEW_START, timezone: NY, record: RECORD,
    });

    expect(replyToAddress()).toMatch(new RegExp(`^[A-Za-z0-9_-]{22}@${REPLY_DOMAIN.replace('.', '\\.')}$`));
  });

  it('states the new time in fixed wording', async () => {
    await email.sendCalendarEntryMovedEmail({
      organizationId: ORG_ID, to: 'jane@example.com', customerName: 'Jane Doe',
      entryTitle: 'Meet the Smiths', newStart: NEW_START, timezone: NY,
    });

    const sent = resendSend.mock.calls[0][0];
    expect(sent.subject).toBe('Event Moved: Meet the Smiths');
    expect(sent.html).toContain('has been moved to a new time');
    expect(sent.html).toContain('9:00 AM');
    expect(sent.html).not.toContain('1:00 PM'); // proves it rendered on the ORG clock, not server UTC
  });

  it('has no `message` parameter to plumb free text through — an extra field on the call is silently ignored', async () => {
    // A caller cannot express "custom wording" through this sender's type at all; this proves
    // that even a loosely-typed caller (e.g. spread-in body fields) gains nothing by trying.
    await (email.sendCalendarEntryMovedEmail as (p: unknown) => Promise<unknown>)({
      organizationId: ORG_ID, to: 'jane@example.com', customerName: 'Jane Doe',
      entryTitle: 'Meet the Smiths', newStart: NEW_START, timezone: NY,
      message: 'This custom wording must never appear anywhere in the email.',
    });

    const sent = resendSend.mock.calls[0][0];
    expect(sent.html).not.toContain('This custom wording must never appear');
    expect(sent.text).not.toContain('This custom wording must never appear');
  });
});

describe('sendCalendarEntryCancelledEmail', () => {
  it('sets a resolvable Reply-To on the dispatch payload', async () => {
    await email.sendCalendarEntryCancelledEmail({
      organizationId: ORG_ID, to: 'jane@example.com', customerName: 'Jane Doe',
      entryTitle: 'Meet the Smiths', cancelledStart: NEW_START, timezone: NY, record: RECORD,
    });

    expect(replyToAddress()).toMatch(new RegExp(`^[A-Za-z0-9_-]{22}@${REPLY_DOMAIN.replace('.', '\\.')}$`));
  });

  it('renders fixed cancellation wording', async () => {
    await email.sendCalendarEntryCancelledEmail({
      organizationId: ORG_ID, to: 'jane@example.com', customerName: 'Jane Doe',
      entryTitle: 'Meet the Smiths', cancelledStart: NEW_START, timezone: NY,
    });

    const sent = resendSend.mock.calls[0][0];
    expect(sent.subject).toBe('Cancelled: Meet the Smiths');
    expect(sent.html).toContain('has been cancelled');
  });

  it('has no `message` parameter — an extra field on the call is silently ignored', async () => {
    await (email.sendCalendarEntryCancelledEmail as (p: unknown) => Promise<unknown>)({
      organizationId: ORG_ID, to: 'jane@example.com', customerName: 'Jane Doe',
      entryTitle: 'Meet the Smiths', cancelledStart: NEW_START, timezone: NY,
      message: 'This custom wording must never appear anywhere in the email.',
    });

    const sent = resendSend.mock.calls[0][0];
    expect(sent.html).not.toContain('This custom wording must never appear');
  });
});
