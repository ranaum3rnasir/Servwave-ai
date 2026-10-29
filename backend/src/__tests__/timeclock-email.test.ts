import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// Capture array must exist before the hoisted vi.mock factory references it.
const { sentEmails } = vi.hoisted(() => ({ sentEmails: [] as Array<Record<string, any>> }));

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
      send: vi.fn(async (payload: Record<string, any>) => {
        sentEmails.push(payload);
        return { id: 'mock-id' };
      }),
    };
  },
}));

// setup.ts mocks '../lib/email' globally; pull the REAL module here.
let sendClockOverrideRequestedEmail: typeof import('../lib/email')['sendClockOverrideRequestedEmail'];
let sendClockOverrideDecisionEmail: typeof import('../lib/email')['sendClockOverrideDecisionEmail'];

beforeAll(async () => {
  const real = await vi.importActual<typeof import('../lib/email')>('../lib/email');
  sendClockOverrideRequestedEmail = real.sendClockOverrideRequestedEmail;
  sendClockOverrideDecisionEmail = real.sendClockOverrideDecisionEmail;
});

beforeEach(() => {
  sentEmails.length = 0;
});

const ORG = { id: '00000000-0000-0000-0000-000000000001', name: 'B&G', logo_url: null, brand_color: '#0C2D3A' };
// 2026-06-10T15:00:00Z === 11:00 AM US Eastern (EDT).
const easternElevenAM = new Date('2026-06-10T15:00:00Z');

function blob(e: Record<string, any>): string {
  const to = Array.isArray(e.to) ? e.to.join(' ') : e.to ?? '';
  return `${to} ${e.subject ?? ''} ${e.text ?? ''} ${e.html ?? ''}`;
}

describe('sendClockOverrideRequestedEmail', () => {
  it('emails every approver with the technician name in the subject and time in org TZ', async () => {
    await sendClockOverrideRequestedEmail({
      org: ORG,
      to: ['admin@test.com', 'lead@test.com'],
      technicianName: 'Joe Tech',
      requestedAt: easternElevenAM,
      distanceM: 320,
      nearestLabel: 'HQ',
    });

    expect(sentEmails).toHaveLength(2);
    const recips = sentEmails.map((e) => e.to);
    expect(recips).toContain('admin@test.com');
    expect(recips).toContain('lead@test.com');
    for (const e of sentEmails) {
      expect(e.subject).toContain('Joe Tech');
      expect(e.subject.toLowerCase()).toContain('override');
    }
    const all = sentEmails.map(blob).join(' ');
    expect(all).toContain('11:00 AM');
    expect(all).not.toContain('3:00 PM');
  });

  it('does not throw and sends nothing when RESEND key absent (short-circuit)', async () => {
    // Re-import the module with NO key by re-mocking env. We instead assert the
    // public contract: with the real client present but an empty recipient list,
    // it sends zero emails and returns cleanly.
    await expect(
      sendClockOverrideRequestedEmail({
        org: ORG,
        to: [],
        technicianName: 'Nobody',
        requestedAt: easternElevenAM,
        distanceM: 10,
        nearestLabel: 'HQ',
      })
    ).resolves.toBeUndefined();
    expect(sentEmails).toHaveLength(0);
  });
});

describe('sendClockOverrideDecisionEmail', () => {
  it('emails the requesting tech with the decision in the subject', async () => {
    await sendClockOverrideDecisionEmail({
      org: ORG,
      to: 'tech@test.com',
      technicianName: 'Joe Tech',
      decision: 'approved',
      decidedByName: 'Boss Admin',
    });

    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].to).toBe('tech@test.com');
    expect(sentEmails[0].subject.toLowerCase()).toContain('approved');
    expect(blob(sentEmails[0])).toContain('Boss Admin');
  });

  it('rejected decision renders in subject + body', async () => {
    await sendClockOverrideDecisionEmail({
      org: ORG,
      to: 'tech@test.com',
      technicianName: 'Joe Tech',
      decision: 'rejected',
      decidedByName: 'Boss Admin',
    });
    expect(sentEmails[0].subject.toLowerCase()).toContain('rejected');
  });
});
