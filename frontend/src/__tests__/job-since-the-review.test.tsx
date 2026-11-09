/**
 * Roles & Permissions, PRD 6, S06.20 - "Since the review" on the routed job page.
 *
 * A job in Ready to close has had its review finished. An unusual change sends it back to Office review; an ordinary one
 * (a payment, an invoice sent, a note, a line added at its price) does not, and the review lists it under "Since the review".
 * The job's own Ready to close block says whether this person may read it (`review_changes`); the list is the server's
 * (`review.since_review`). The browser never works any of it out from the status or the times.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { JOB_ID, mountJobDetail, stubBrowser } from './harness/jobDetailPage';
import type { ReadyToCloseAnswer } from '@/components/jobs/review/ReadyToCloseBanner';
import type { JobReview, ReviewItem } from '@/lib/api/jobReview';

stubBrowser();

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));

vi.mock('react-router-dom', async () => (await import('./harness/jobDetailRouter')).jobDetailRouter());

const mockApi = vi.mocked(api);

const readyToClose = (over: Partial<ReadyToCloseAnswer> = {}): ReadyToCloseAnswer => ({
  amount_owed: 0, mark_done: 'offered', mark_done_reason: null, confirm_amount: false, review_changes: true, ...over,
});

const sinceItem = (over: Partial<ReviewItem> & { key: string }): ReviewItem => ({
  group: 'payments', kind: 'payment', title: 'Invoice INV-1', summary: 'Payment recorded $50.00 via Cash', changes: [],
  by: 'Sam Office', at: '2026-10-05T14:14:00.000Z', checked: false, checked_by: null, checked_at: null,
  unusual: false, unusual_kind: null, unusual_reason: null, latest_entry_id: `e-${over.key}`,
  ...over,
});

function reviewAnswer(since: ReviewItem[] | null): JobReview {
  return {
    summary: {
      key: 'summary', title: 'Job details', checked: true, checked_by: 'Dana Rivera', checked_at: '2026-10-04T10:00:00.000Z', latest_entry_id: 'e-1',
      job_number: 'J00020', job_type: null, customer: { name: 'John Doe', company_name: null }, service_address: null, visits: [], lines: [],
      discount_amount: 0, total: 0, invoices: [], balance: 0, file_count: 0, note_count: 0,
    },
    groups: [],
    version: 'v1',
    totals: { items: 1, checked: 1, unusual: 0 },
    round: null,
    since_review: since,
  };
}

const VISIT = {
  id: `${JOB_ID}-v1`, visit_seq: 1, status: 'COMPLETED', purpose: 'WORK',
  scheduled_at: '2026-10-02T13:00:00.000Z', scheduled_end: '2026-10-02T15:00:00.000Z', is_all_day: false,
  en_route_at: null, on_site_at: null, started_at: null, completed_at: '2026-10-02T15:00:00.000Z', cancelled_at: null,
  customer_email_sent_at: null, notes: null, status_steps: [], assignees: [],
};

function mount(over: { job?: Record<string, unknown>; review?: JobReview | null } = {}) {
  return mountJobDetail({
    job: {
      job_number: 'J00020', status: 'READY_TO_CLOSE', completed_at: '2026-10-02T15:00:00.000Z', visits: [VISIT],
      locked: true, locked_actions: [], actions: ['mark_done'],
      new_visit_closed_reason: 'Reopen this job first', ready_to_close: readyToClose(),
      ...over.job,
    },
    visits: [VISIT],
    routes: [{
      match: (url) => url === `/api/jobs/${JOB_ID}/review`,
      data: () => {
        if (over.review === null) throw new Error('boom');
        return { review: over.review ?? reviewAnswer([]) };
      },
    }],
  });
}

const reviewCalls = () => mockApi.get.mock.calls.filter(([url]) => String(url).endsWith('/review'));

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('"Since the review" on a Ready to close job', () => {
  it('is offered in the Ready to close banner when the job says the person may read the review, and nothing is read until it is opened', async () => {
    mount();
    const banner = await screen.findByRole('region', { name: 'Ready to close' });
    expect(within(banner).getByRole('button', { name: 'Since the review' })).toBeEnabled();
    expect(within(banner).getByRole('button', { name: 'Mark Done' })).toBeEnabled();
    expect(reviewCalls()).toHaveLength(0);
  });

  it('is not offered when the job does not say so, and the review is never asked for', async () => {
    mount({ job: { ready_to_close: readyToClose({ review_changes: false }) } });
    const banner = await screen.findByRole('region', { name: 'Ready to close' });
    expect(within(banner).queryByRole('button', { name: 'Since the review' })).not.toBeInTheDocument();
    expect(reviewCalls()).toHaveLength(0);
  });

  it('lists the ordinary changes the server sent, each with its words, who and when, and nothing to check or finish', async () => {
    const answer = reviewAnswer([
      sinceItem({ key: 'payment:p1' }),
      sinceItem({ key: 'note:n1', group: 'notes', kind: 'note', title: 'Note', summary: 'Added: Customer paid by check', by: 'Lee Tech' }),
    ]);
    mount({ review: answer });
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Since the review' }));

    const panel = await screen.findByRole('dialog', { name: 'Since the review' });
    expect(await within(panel).findByText('J00020 · 2 changes')).toBeInTheDocument();
    const list = within(panel).getByRole('region', { name: 'Changes since the review' });
    expect(within(list).getByText('Invoice INV-1')).toBeInTheDocument();
    expect(within(list).getByText('Payment recorded $50.00 via Cash')).toBeInTheDocument();
    expect(within(list).getByText(/Sam Office, Oct 5/)).toBeInTheDocument();
    expect(within(list).getByText('Added: Customer paid by check')).toBeInTheDocument();
    expect(within(list).getByText(/Lee Tech, Oct 5/)).toBeInTheDocument();
    // The review is over: no check, no Finish review.
    expect(within(panel).queryByRole('button', { name: /^Check/ })).not.toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Finish review' })).not.toBeInTheDocument();
    expect(within(panel).getByText(/did not send the job back/)).toBeInTheDocument();
    expect(reviewCalls()).toHaveLength(1);
  });

  it('says nothing has changed when the server sent an empty list', async () => {
    mount({ review: reviewAnswer([]) });
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Since the review' }));
    const panel = await screen.findByRole('dialog', { name: 'Since the review' });
    expect(await within(panel).findByText('Nothing has changed since the review was finished.')).toBeInTheDocument();
    expect(within(panel).queryByRole('region', { name: 'Changes since the review' })).not.toBeInTheDocument();
  });

  it('waits for a review that carries the list: one read while the job was still in Office review (no list) is not the answer', async () => {
    mount({ review: reviewAnswer(null) });
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Since the review' }));
    const panel = await screen.findByRole('dialog', { name: 'Since the review' });
    expect(await within(panel).findByRole('status', { name: 'Loading the changes' })).toBeInTheDocument();
    expect(within(panel).queryByText('Nothing has changed since the review was finished.')).not.toBeInTheDocument();
  });

  it('offers a retry when the list could not be loaded', async () => {
    mount({ review: null });
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Since the review' }));
    const panel = await screen.findByRole('dialog', { name: 'Since the review' });
    expect(await within(panel).findByText('The changes could not be loaded.')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Try again' })).toBeEnabled();
  });

  it('draws a bounded number of rows and a "Show more" for the rest', async () => {
    const many = Array.from({ length: 30 }, (_, i) => sinceItem({ key: `payment:p${i}`, title: `Invoice INV-${i}` }));
    mount({ review: reviewAnswer(many) });
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Since the review' }));
    const panel = await screen.findByRole('dialog', { name: 'Since the review' });
    await within(panel).findByRole('region', { name: 'Changes since the review' });
    expect(within(panel).getAllByRole('listitem')).toHaveLength(25);
    await userEvent.setup().click(within(panel).getByRole('button', { name: 'Show 5 more (5 left)' }));
    await waitFor(() => expect(within(panel).getAllByRole('listitem')).toHaveLength(30));
  });
});

describe('after an unusual change the job is back in Office review', () => {
  it('draws the Office review banner with its counts and no Ready to close banner or "Since the review", from what the server sends', async () => {
    mount({ job: { status: 'OFFICE_REVIEW', ready_to_close: null, actions: ['office_review', 'finish_review'] }, review: { ...reviewAnswer(null), totals: { items: 3, checked: 1, unusual: 1 } } });
    const banner = await screen.findByRole('region', { name: 'Office review' });
    expect(await within(banner).findByText('Office review · 3 items · 1 checked')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Ready to close' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Since the review' })).not.toBeInTheDocument();
  });
});
