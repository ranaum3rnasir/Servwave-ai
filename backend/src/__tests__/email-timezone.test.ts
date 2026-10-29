import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// Capture array must exist before the hoisted vi.mock factory references it.
const { sentEmails } = vi.hoisted(() => ({ sentEmails: [] as Array<Record<string, string>> }));

// Override the global env mock (setup.ts) so the email module initializes a
// real Resend client instead of short-circuiting on a missing key.
vi.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'test',
    EMAIL_FROM: 'Alpha <noreply@test.com>',
    RESEND_API_KEY: 're_test_key',
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
let sendClockOverrideRequestedEmail: typeof import('../lib/email')['sendClockOverrideRequestedEmail'];

beforeAll(async () => {
  const real = await vi.importActual<typeof import('../lib/email')>('../lib/email');
  sendClockOverrideRequestedEmail = real.sendClockOverrideRequestedEmail;
});

beforeEach(() => {
  sentEmails.length = 0;
});

// 2026-06-08T15:00:00Z === 11:00 AM US Eastern (EDT). The bug rendered this as
// "3:00 PM" (server UTC). The fix must render "11:00 AM".
const easternElevenAM = new Date('2026-06-08T15:00:00Z');
const ORG_ID = '00000000-0000-0000-0000-000000000001';

function blob(e: Record<string, string>): string {
  return `${e.subject ?? ''} ${e.text ?? ''} ${e.html ?? ''}`;
}

describe('Scheduling emails render in the org timezone, not server UTC', () => {
  // The job-scheduled/rescheduled/en-route AND walkthrough-scheduled senders that
  // used to cover this were retired by the hard-coded → Automation Center migration
  // (their timezone rendering now lives in the automation merge-field pipeline,
  // covered by the automations test suite — see executors.test.ts / context tests).
  // formatDateTimeInZone (lib/timezone.ts) is shared, load-bearing infra used by
  // every transactional sender — re-pointed here at
  // sendClockOverrideRequestedEmail, one of the senders that stays hard-coded.
  it('clock override requested email shows 11:00 AM (org tz), not 3:00 PM (UTC)', async () => {
    await sendClockOverrideRequestedEmail({
      org: { id: ORG_ID, name: 'Acme', logo_url: null, brand_color: '#0C2D3A' },
      to: ['approver@example.com'],
      technicianName: 'Tech',
      requestedAt: easternElevenAM,
      distanceM: 500,
      nearestLabel: 'Haverhill, MA',
      timezone: 'America/New_York',
    });

    const all = sentEmails.map(blob).join(' ');
    expect(all).toContain('11:00 AM');
    expect(all).not.toContain('3:00 PM');
  });

  it('clock override requested email falls back to Eastern (not UTC) when timezone is omitted', async () => {
    await sendClockOverrideRequestedEmail({
      org: { id: ORG_ID, name: 'Acme', logo_url: null, brand_color: '#0C2D3A' },
      to: ['approver@example.com'],
      technicianName: 'Tech',
      requestedAt: easternElevenAM,
      distanceM: 500,
      nearestLabel: 'Haverhill, MA',
    });

    const all = sentEmails.map(blob).join(' ');
    expect(all).toContain('11:00 AM');
    expect(all).not.toContain('3:00 PM');
  });
});
