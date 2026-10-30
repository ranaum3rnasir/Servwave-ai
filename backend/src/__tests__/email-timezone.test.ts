import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';

// Capture array must exist before the hoisted vi.mock factory references it.
const { sentEmails } = vi.hoisted(() => ({ sentEmails: [] as Array<Record<string, string>> }));

// Override the global env mock (setup.ts) so the email module initializes a
// real Resend client instead of short-circuiting on a missing key.
vi.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'test',
    EMAIL_FROM: 'Alpha <noreply@test.com>',
    RESEND_API_KEY: 're_test_key',
    // PRD 10 (S10.12): the domain a sender's own address is built on; a document goes out from it.
    MAILBOX_DOMAIN: 'mail.test.com',
    FRONTEND_URL: 'http://localhost:5173',
  },
}));

// Capture every email payload Resend would send.
vi.mock('resend', () => ({
  Resend: class {
    emails = {
      send: vi.fn(async (payload: Record<string, string>) => {
        sentEmails.push(payload);
        return { id: 'mock-id' };
      }),
    };
  },
}));

// setup.ts mocks '../lib/email' globally; pull the REAL module here.
import { prisma } from '../lib/prisma';


// PRD 10 (S10.12): a document is sent by hand, from the sender's own mailbox (the id the suite-wide mailbox stub answers to).
const HAND_SENDER = { mailboxId: 'main-mailbox-id', userId: 'user-1' };
let sendStagePickupEmail: typeof import('../lib/email')['sendStagePickupEmail'];

beforeAll(async () => {
  const real = await vi.importActual<typeof import('../lib/email')>('../lib/email');
  sendStagePickupEmail = real.sendStagePickupEmail;
});

beforeEach(() => {
  sentEmails.length = 0;
  (prisma.organization.findUnique as Mock).mockResolvedValue({ email_sending_enabled: true, name: 'Acme' });
});

// 2026-06-08T15:00:00Z === 11:00 AM US Eastern (EDT). The bug rendered this as
// "3:00 PM" (server UTC). The fix must render "11:00 AM".
const easternElevenAM = '2026-06-08T15:00:00Z';
const ORG_ID = '00000000-0000-0000-0000-000000000001';

function blob(e: Record<string, string>): string {
  return `${e.subject ?? ''} ${e.text ?? ''} ${e.html ?? ''}`;
}

function pickupTicket(timezone?: string) {
  return {
    organizationId: ORG_ID,
    org: { id: ORG_ID, name: 'Acme', logo_url: null, brand_color: '#0C2D3A' },
    to: 'tech@example.com',
    jobNumber: 'J00001',
    customer: 'Cust',
    site: '1 Test Way',
    scheduledFor: easternElevenAM,
    lines: [],
    ...(timezone ? { timezone } : {}),
  };
}

describe('Scheduling emails render in the org timezone, not server UTC', () => {
  // The job-scheduled/rescheduled/en-route AND walkthrough-scheduled senders that
  // used to cover this were retired by the hard-coded → Automation Center migration
  // (their timezone rendering now lives in the automation merge-field pipeline,
  // covered by the automations test suite — see executors.test.ts / context tests).
  // The pickup ticket is a sender that stays hard-coded and prints a visit time.
  it('pickup ticket email shows 11:00 AM (org tz), not 3:00 PM (UTC)', async () => {
    await sendStagePickupEmail({ ...pickupTicket('America/New_York'), handSender: HAND_SENDER });

    const all = sentEmails.map(blob).join(' ');
    expect(all).toContain('11:00 AM');
    expect(all).not.toContain('3:00 PM');
  });

  it('pickup ticket email falls back to Eastern (not UTC) when timezone is omitted', async () => {
    await sendStagePickupEmail({ ...pickupTicket(), handSender: HAND_SENDER });

    const all = sentEmails.map(blob).join(' ');
    expect(all).toContain('11:00 AM');
    expect(all).not.toContain('3:00 PM');
  });
});
