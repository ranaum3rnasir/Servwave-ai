import { describe, it, expect } from 'vitest';
import {
  resolveInboundSmsJob,
  SMS_ROUTER_RECENCY_WINDOW_DAYS,
  CLOSED_JOB_STATUSES,
  type JobTextCandidate,
} from '../lib/sms-reply-router';

// Fixed "now" so every case is deterministic.
const NOW = new Date('2026-06-10T12:00:00Z');

const DAY_MS = 24 * 60 * 60 * 1000;
function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

function candidate(overrides: Partial<JobTextCandidate> = {}): JobTextCandidate {
  return {
    jobId: 'j0000000-0000-0000-0000-000000000001',
    jobLabel: 'J-1850 · 665 Fifth Ave',
    lastOutboundAt: daysAgo(1),
    jobStatus: 'SCHEDULED',
    ...overrides,
  };
}

describe('sms-reply-router constants', () => {
  it('exposes the 30-day recency window', () => {
    expect(SMS_ROUTER_RECENCY_WINDOW_DAYS).toBe(30);
  });

  it('treats COMPLETED and CANCELLED as closed', () => {
    expect(CLOSED_JOB_STATUSES).toEqual(['COMPLETED', 'CANCELLED']);
  });
});

describe('resolveInboundSmsJob — best-effort recency-gated routing', () => {
  // PRD hard cases, table-driven.
  const cases: Array<{
    name: string;
    recentJobTexts: JobTextCandidate[];
    expected: { jobId: string; jobLabel: string | null } | null;
  }> = [
    {
      name: 'two live jobs → the most-recently-texted-from job wins',
      recentJobTexts: [
        candidate({ jobId: 'job-1850', jobLabel: 'J-1850 · 665 Fifth Ave', lastOutboundAt: daysAgo(5), jobStatus: 'IN_PROGRESS' }),
        candidate({ jobId: 'job-1872', jobLabel: 'J-1872 · 12 Bleecker St', lastOutboundAt: daysAgo(1), jobStatus: 'SCHEDULED' }),
      ],
      expected: { jobId: 'job-1872', jobLabel: 'J-1872 · 12 Bleecker St' },
    },
    {
      name: 'all candidates stale (outside the recency window) → null (Unrouted tray)',
      recentJobTexts: [
        candidate({ jobId: 'job-old-1', lastOutboundAt: daysAgo(31), jobStatus: 'SCHEDULED' }),
        candidate({ jobId: 'job-old-2', lastOutboundAt: daysAgo(90), jobStatus: 'IN_PROGRESS' }),
      ],
      expected: null,
    },
    {
      name: 'all candidate jobs closed → null (Unrouted tray)',
      recentJobTexts: [
        candidate({ jobId: 'job-done', lastOutboundAt: daysAgo(1), jobStatus: 'COMPLETED' }),
        candidate({ jobId: 'job-cancelled', lastOutboundAt: daysAgo(2), jobStatus: 'CANCELLED' }),
      ],
      expected: null,
    },
    {
      name: 'no prior job texts (cold inbound) → null (Unrouted tray)',
      recentJobTexts: [],
      expected: null,
    },
    {
      name: 'single live candidate → that job',
      recentJobTexts: [
        candidate({ jobId: 'job-solo', jobLabel: 'J-1900 · 9 Pine St', lastOutboundAt: daysAgo(10), jobStatus: 'ON_SITE' }),
      ],
      expected: { jobId: 'job-solo', jobLabel: 'J-1900 · 9 Pine St' },
    },
    {
      name: 'a closed-but-recent job loses to an older-but-live one',
      recentJobTexts: [
        candidate({ jobId: 'job-closed-recent', lastOutboundAt: daysAgo(1), jobStatus: 'COMPLETED' }),
        candidate({ jobId: 'job-live-older', jobLabel: 'J-1860 · 4 Oak Ln', lastOutboundAt: daysAgo(20), jobStatus: 'EN_ROUTE' }),
      ],
      expected: { jobId: 'job-live-older', jobLabel: 'J-1860 · 4 Oak Ln' },
    },
    {
      name: 'boundary: exactly at the window edge counts as inside',
      recentJobTexts: [
        candidate({
          jobId: 'job-edge',
          jobLabel: 'J-1880 · 77 Elm St',
          lastOutboundAt: daysAgo(SMS_ROUTER_RECENCY_WINDOW_DAYS),
          jobStatus: 'UNSCHEDULED',
        }),
      ],
      expected: { jobId: 'job-edge', jobLabel: 'J-1880 · 77 Elm St' },
    },
  ];

  it.each(cases)('$name', ({ recentJobTexts, expected }) => {
    expect(resolveInboundSmsJob({ now: NOW, recentJobTexts })).toEqual(expected);
  });

  it('passes a null jobLabel through unchanged on the winning candidate', () => {
    const result = resolveInboundSmsJob({
      now: NOW,
      recentJobTexts: [candidate({ jobId: 'job-no-label', jobLabel: null })],
    });
    expect(result).toEqual({ jobId: 'job-no-label', jobLabel: null });
  });

  it('one millisecond past the window edge is outside → null', () => {
    const justPast = new Date(NOW.getTime() - SMS_ROUTER_RECENCY_WINDOW_DAYS * DAY_MS - 1);
    const result = resolveInboundSmsJob({
      now: NOW,
      recentJobTexts: [candidate({ jobId: 'job-just-past', lastOutboundAt: justPast })],
    });
    expect(result).toBeNull();
  });

  it('does not mutate the input candidate array', () => {
    const input = [
      candidate({ jobId: 'job-a', lastOutboundAt: daysAgo(3) }),
      candidate({ jobId: 'job-b', lastOutboundAt: daysAgo(1) }),
    ];
    const snapshot = input.map((c) => ({ ...c }));
    resolveInboundSmsJob({ now: NOW, recentJobTexts: input });
    expect(input).toEqual(snapshot);
  });
});
