/**
 * MV-NOTIF-10. The visit-cancelled email misses two of the plan's assertions.
 *
 * It rendered no Technician row at all - the plan asks for the crew to read "Our team",
 * and that string appeared nowhere in the text or the HTML part. A second QA run with a
 * deliberately crewless visit produced the same output, which rules out the reading that
 * "Our team" is only an empty-crew fallback: notifyCustomerOfSchedule computes
 * technicianName and simply never handed it to the cancelled branch, and
 * jobVisitCancelledHtml took no crew parameter, so no crew row could ever render.
 *
 * It also printed the window as its START instant only ("Was Scheduled For October 15,
 * 2026 at 9:00 AM"), never as the 9:00 to 11:00 AM window.
 *
 * The four assertions that already held are pinned here too, so a fix to these two
 * cannot quietly move them.
 *
 * Follows email-timezone.test.ts: setup.ts mocks lib/email globally, so the REAL module
 * is pulled in and Resend is captured at the wire.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

const { sentEmails } = vi.hoisted(() => ({ sentEmails: [] as Array<Record<string, string>> }));

vi.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'test',
    EMAIL_FROM: 'Alpha <noreply@test.com>',
    RESEND_API_KEY: 're_test_key',
    FRONTEND_URL: 'http://localhost:5173',
  },
}));

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

let sendJobVisitCancelledEmail: typeof import('../lib/email')['sendJobVisitCancelledEmail'];

beforeAll(async () => {
  const real = await vi.importActual<typeof import('../lib/email')>('../lib/email');
  sendJobVisitCancelledEmail = real.sendJobVisitCancelledEmail;
});

beforeEach(() => {
  sentEmails.length = 0;
});

const NY = 'America/New_York';
const ORG_ID = '00000000-0000-0000-0000-000000000001';
// 13:00Z is 9:00 AM New York in October (EDT); 15:00Z is 11:00 AM. The whole point of
// picking these is that the server runs in UTC, so an unzoned render says 1:00 PM.
const START = new Date('2026-10-15T13:00:00.000Z');
const END = new Date('2026-10-15T15:00:00.000Z');

async function send(over: Record<string, unknown> = {}) {
  await sendJobVisitCancelledEmail({
    organizationId: ORG_ID,
    to: 'customer@example.com',
    customerName: 'Ada',
    jobNumber: 'J00233',
    visitSeq: 2,
    cancelledStart: START,
    cancelledEnd: END,
    technicianName: 'Our team',
    reason: 'Parts delayed',
    timezone: NY,
    ...over,
  } as Parameters<typeof sendJobVisitCancelledEmail>[0]);
  return sentEmails[0]!;
}

describe('sendJobVisitCancelledEmail', () => {
  it('names the crew the plan asks for', async () => {
    const sent = await send();
    expect(sent.html).toContain('Our team');
  });

  it('names a real crew when the trip carried one', async () => {
    const sent = await send({ technicianName: 'Sam Reyes' });
    expect(sent.html).toContain('Sam Reyes');
  });

  it('prints the WINDOW, not just the start instant', async () => {
    const sent = await send();
    expect(sent.html).toContain('9:00 AM');
    expect(sent.html).toContain('11:00 AM');
  });

  it('falls back to the start alone when the trip carries no end', async () => {
    const sent = await send({ cancelledEnd: null });
    expect(sent.html).toContain('9:00 AM');
    expect(sent.html).not.toContain('11:00 AM');
  });

  it('renders on the ORG clock rather than the server UTC', async () => {
    const sent = await send();
    expect(sent.html).not.toContain('1:00 PM');
    expect(sent.html).not.toMatch(/\dZ/);
  });

  it('keeps the four assertions that already held', async () => {
    const sent = await send();
    expect(sent.subject).toBe('Visit Cancelled: J00233 - Visit 2');
    expect(sent.html).toContain('Visit Cancelled: J00233 - Visit 2');
    expect(sent.html).toContain('rest of your service is unaffected');
    expect(sent.html).toContain('Parts delayed');
  });

  // SRVW-243 header-brand fix - see email-record-matches-send.test.ts for the full writeup.
  // jobVisitCancelledHtml is the fifth of the five senders that never threaded org into
  // wrapHtml, so a cancellation notice told the customer "ServWave" cancelled their visit
  // rather than the org they actually hired.
  describe('SRVW-243 header-brand fix', () => {
    const ORG = { id: ORG_ID, name: 'Acme Plumbing', logo_url: null, brand_color: '#0C2D3A' };
    const FALLBACK_HEADER = '<span style="color:#ffffff;font-size:20px;font-weight:700;">ServWave</span>';

    it('renders the org name in the header when the org row is present', async () => {
      const sent = await send({ org: ORG });
      expect(sent.html).toContain('<span style="color:#ffffff;font-size:20px;font-weight:700;">Acme Plumbing</span>');
      expect(sent.html).not.toContain(FALLBACK_HEADER);
    });

    it('falls back to the ServWave wordmark only when org is genuinely absent', async () => {
      const sent = await send();
      expect(sent.html).toContain(FALLBACK_HEADER);
      expect(sent.html).not.toContain('Acme Plumbing');
    });
  });
});
