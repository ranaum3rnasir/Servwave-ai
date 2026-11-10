import { describe, it, expect } from 'vitest';
import {
  pickReplyTie,
  SMS_ROUTER_RECENCY_WINDOW_DAYS,
  CLOSED_JOB_STATUSES,
  CLOSED_LEAD_STATUSES,
  type ReplyTextCandidate,
} from '../lib/sms-reply-router';

// The rule over the texts it is handed. Which texts are read, and the whole rule through the incoming-text webhook on a
// real database, is sms-reply-tie-db.test.ts.

// Fixed "now" so every case is deterministic.
const NOW = new Date('2026-06-10T12:00:00Z');

const DAY_MS = 24 * 60 * 60 * 1000;
function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

const fromJob = (id: string, sentAt: Date, status = 'SCHEDULED', label: string | null = `J-${id}`): ReplyTextCandidate =>
  ({ sentAt, lead: null, job: { id, label, status } });
const fromLead = (id: string, sentAt: Date, status = 'CONTACTED'): ReplyTextCandidate => ({ sentAt, lead: { id, status }, job: null });

const tie = (t: { leadId?: string; jobId?: string; jobLabel?: string | null }) =>
  ({ leadId: t.leadId ?? null, jobId: t.jobId ?? null, jobLabel: t.jobLabel ?? (t.jobId ? `J-${t.jobId}` : null) });

describe('sms-reply-router constants', () => {
  it('exposes the 30-day recency window', () => {
    expect(SMS_ROUTER_RECENCY_WINDOW_DAYS).toBe(30);
  });

  // Ran, 2026-11-05: a job is closed only when Done or Cancelled; a lead when converted (Won) or Lost.
  it('treats Done and Cancelled as a closed job, and Won and Lost as a closed lead', () => {
    expect([...CLOSED_JOB_STATUSES].sort()).toEqual(['CANCELLED', 'DONE']);
    expect([...CLOSED_LEAD_STATUSES].sort()).toEqual(['LOST', 'WON']);
  });
});

describe('pickReplyTie: the latest text we sent with an open lead or job, within the window', () => {
  const cases: Array<{ name: string; sentTexts: ReplyTextCandidate[]; expected: ReturnType<typeof tie> | null }> = [
    {
      name: 'two live jobs: the most recently texted-from job wins',
      sentTexts: [fromJob('job-1850', daysAgo(5), 'IN_PROGRESS'), fromJob('job-1872', daysAgo(1))],
      expected: tie({ jobId: 'job-1872' }),
    },
    {
      name: 'a lead texted after a job: the lead wins',
      sentTexts: [fromJob('job-1850', daysAgo(5)), fromLead('lead-7', daysAgo(1))],
      expected: tie({ leadId: 'lead-7' }),
    },
    {
      name: 'a text carrying a lead and a job ties the reply to both',
      sentTexts: [{ sentAt: daysAgo(1), lead: { id: 'lead-7', status: 'ESTIMATED' }, job: { id: 'job-9', label: 'J-9', status: 'SCHEDULED' } }],
      expected: tie({ leadId: 'lead-7', jobId: 'job-9', jobLabel: 'J-9' }),
    },
    {
      name: 'a text carrying a Won lead and an open job ties the reply to the job only',
      sentTexts: [{ sentAt: daysAgo(1), lead: { id: 'lead-7', status: 'WON' }, job: { id: 'job-9', label: 'J-9', status: 'SCHEDULED' } }],
      expected: tie({ jobId: 'job-9', jobLabel: 'J-9' }),
    },
    {
      name: 'every text outside the recency window: nothing',
      sentTexts: [fromJob('job-old-1', daysAgo(31)), fromLead('lead-old', daysAgo(90))],
      expected: null,
    },
    {
      name: 'every record closed: nothing',
      sentTexts: [fromJob('job-done', daysAgo(1), 'DONE'), fromJob('job-cancelled', daysAgo(2), 'CANCELLED'), fromLead('lead-lost', daysAgo(3), 'LOST')],
      expected: null,
    },
    {
      name: 'no texts we sent: nothing',
      sentTexts: [],
      expected: null,
    },
    {
      name: 'a closed-but-recent record loses to an older open one',
      sentTexts: [fromLead('lead-lost', daysAgo(1), 'LOST'), fromJob('job-live-older', daysAgo(20), 'COMPLETED')],
      expected: tie({ jobId: 'job-live-older' }),
    },
    {
      name: 'boundary: exactly at the window edge counts as inside',
      sentTexts: [fromJob('job-edge', daysAgo(SMS_ROUTER_RECENCY_WINDOW_DAYS), 'UNSCHEDULED')],
      expected: tie({ jobId: 'job-edge' }),
    },
    {
      name: 'a null job label is passed through',
      sentTexts: [fromJob('job-no-label', daysAgo(1), 'SCHEDULED', null)],
      expected: { leadId: null, jobId: 'job-no-label', jobLabel: null },
    },
  ];

  it.each(cases)('$name', ({ sentTexts, expected }) => {
    expect(pickReplyTie({ at: NOW, sentTexts })).toEqual(expected);
  });

  // Completed, Office review and Ready to close are open work: a reply still lands on the job.
  it.each(['COMPLETED', 'OFFICE_REVIEW', 'READY_TO_CLOSE'])('a job in %s still takes the reply', (status) => {
    expect(pickReplyTie({ at: NOW, sentTexts: [fromJob('job-x', daysAgo(1), status)] })).toEqual(tie({ jobId: 'job-x' }));
  });

  it('one millisecond past the window edge is outside: nothing', () => {
    const justPast = new Date(NOW.getTime() - SMS_ROUTER_RECENCY_WINDOW_DAYS * DAY_MS - 1);
    expect(pickReplyTie({ at: NOW, sentTexts: [fromJob('job-just-past', justPast)] })).toBeNull();
  });

  it('does not mutate the input', () => {
    const input = [fromJob('job-a', daysAgo(3)), fromJob('job-b', daysAgo(1))];
    const snapshot = structuredClone(input);
    pickReplyTie({ at: NOW, sentTexts: input });
    expect(input).toEqual(snapshot);
  });
});
