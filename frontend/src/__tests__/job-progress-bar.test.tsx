/**
 * Roles & Permissions, PRD 6, S06.21 - the progress bar on the routed job page: seven steps, the marker, skipped steps.
 *
 * The page draws the bar from the job's own answer: its status, `actions` (the review is listed for a holder of Office
 * review while the job is in review) and `close_out_money` (the two money facts the server works out on a Done job). The
 * browser never reads a role name, never tests the status to decide who may open the panel, and never sums money.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { JOB_ID, mountJobDetail, stubBrowser } from './harness/jobDetailPage';
import { buildAbility } from '@/lib/ability';

stubBrowser();

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));

vi.mock('react-router-dom', async () => (await import('./harness/jobDetailRouter')).jobDetailRouter());

const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);
/** A crew member with invoices off: they read jobs and nothing about money. */
const crewAbility = buildAbility([{ action: 'read', subject: 'Job' }]);

const finishedVisit = (seq: number) => ({
  id: `${JOB_ID}-v${seq}`, visit_seq: seq, status: 'COMPLETED', purpose: 'WORK',
  scheduled_at: '2026-10-02T13:00:00.000Z', scheduled_end: '2026-10-02T15:00:00.000Z', is_all_day: false,
  en_route_at: null, on_site_at: null, started_at: null, completed_at: '2026-10-02T15:00:00.000Z', cancelled_at: null,
  customer_email_sent_at: null, notes: null, status_steps: [], assignees: [],
});

function Address() {
  const { pathname, search } = useLocation();
  return <output data-testid="address">{pathname + search}</output>;
}

const NEVER_INVOICED = { final_invoice: null, first_sent_at: null, total_invoiced: 0, total_paid: 0, invoices: [], payments: [] };
const SENT_UNPAID = { final_invoice: null, first_sent_at: '2026-10-03T12:00:00.000Z', total_invoiced: 500, total_paid: 100, invoices: [], payments: [] };

function mount(over: { job?: Record<string, unknown>; financials?: Record<string, unknown>; ability?: ReturnType<typeof buildAbility>; visits?: unknown[] } = {}) {
  const visits = over.visits ?? [finishedVisit(1)];
  return mountJobDetail({
    job: {
      job_number: 'J00021', status: 'OFFICE_REVIEW', completed_at: '2026-10-02T15:00:00.000Z', closed_at: null,
      visits, locked: true, locked_actions: [], actions: ['office_review', 'finish_review'],
      new_visit_closed_reason: 'Move this job back out of review first', close_out_money: null,
      ...over.job,
    },
    visits,
    ability: over.ability ?? adminAbility, entry: `/jobs/${JOB_ID}`, beside: <Address />,
    routes: [
      { match: (url) => url === `/api/jobs/${JOB_ID}/review`, data: { review: null } },
      { match: (url) => url.endsWith('/financials'), data: over.financials ?? NEVER_INVOICED },
    ],
  });
}

const bar = async () => {
  const created = await screen.findByRole('group', { name: 'Job Created' });
  return created.parentElement as HTMLElement;
};

beforeEach(() => {
  vi.clearAllMocks();
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false, media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
});
afterEach(() => vi.restoreAllMocks());

describe('the progress bar on the job page (S06.21)', () => {
  it('draws the seven steps with the marker on Office review while the job is in Office review', async () => {
    mount();
    const rail = within(await bar());
    await waitFor(() => {
      expect(rail.getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual([
        'Job Created', 'Visit 1', 'Completed', 'Office review', 'Invoice Sent', 'Payment Received', 'Done',
      ]);
    });
    expect(rail.getByRole('group', { name: 'Office review' })).toHaveAttribute('aria-current', 'step');
  });

  it('reads Ready to close on the same step once the review is finished', async () => {
    mount({ job: { status: 'READY_TO_CLOSE', actions: [] } });
    const rail = within(await bar());
    expect(rail.getByRole('group', { name: 'Ready to close' })).toHaveAttribute('aria-current', 'step');
    expect(rail.queryByRole('group', { name: 'Office review' })).not.toBeInTheDocument();
  });

  it('opens the review panel from the Office review step for the holder the job lists the review for', async () => {
    mount();
    const rail = within(await bar());
    await userEvent.setup().click(await rail.findByRole('button', { name: /office review/i }));
    expect(await screen.findByRole('dialog', { name: 'Office review' })).toBeInTheDocument();
    expect(screen.getByTestId('address').textContent).toBe(`/jobs/${JOB_ID}?panel=review`);
  });

  it('does nothing extra for a person the job does not list the review for: the step is not a button', async () => {
    mount({ job: { actions: ['edit'] } });
    const rail = within(await bar());
    expect(rail.getByRole('group', { name: 'Office review' })).toBeInTheDocument();
    expect(rail.queryByRole('button', { name: /office review/i })).not.toBeInTheDocument();
  });

  it('shows Payment received skipped, in words, on a job closed with money owed', async () => {
    mount({
      job: { status: 'DONE', closed_at: '2026-10-20T09:00:00.000Z', actions: [], close_out_money: { money_owed: true, zero_total: false } },
      financials: SENT_UNPAID,
    });
    const rail = within(await bar());
    const payment = within(rail.getByRole('group', { name: 'Payment Received' }));
    expect(await payment.findByText('Skipped')).toBeInTheDocument();
    expect(rail.getByRole('group', { name: 'Done' })).toHaveAttribute('aria-current', 'step');
    expect(within(rail.getByRole('group', { name: 'Invoice Sent' })).queryByText('Skipped')).not.toBeInTheDocument();
  });

  it('shows no step skipped on a Done job whose total is zero', async () => {
    mount({
      job: { status: 'DONE', closed_at: '2026-10-20T09:00:00.000Z', actions: [], close_out_money: { money_owed: false, zero_total: true } },
    });
    const rail = within(await bar());
    await rail.findByRole('group', { name: 'Done' });
    expect(rail.queryByText('Skipped')).not.toBeInTheDocument();
  });

  it('shows a crew member with invoices off the same steps and the same Skipped word, and no Payment received button', async () => {
    mount({
      ability: crewAbility,
      job: { status: 'DONE', closed_at: '2026-10-20T09:00:00.000Z', actions: [], close_out_money: { money_owed: true, zero_total: false } },
      financials: { ...SENT_UNPAID, invoices: [], payments: [] },
    });
    const rail = within(await bar());
    // The trips are asked for once the job's own answer is in, so their steps join the bar a moment after it first draws.
    await waitFor(() => {
      expect(rail.getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual([
        'Job Created', 'Visit 1', 'Completed', 'Office review', 'Invoice Sent', 'Payment Received', 'Done',
      ]);
    });
    expect(await within(rail.getByRole('group', { name: 'Payment Received' })).findByText('Skipped')).toBeInTheDocument();
    // Their step shows the job's own money facts (prices follow the record) and offers nothing to do about payment.
    expect(rail.queryByRole('button', { name: /payment received/i })).not.toBeInTheDocument();
    expect(rail.queryByRole('button', { name: /done|skipped/i })).not.toBeInTheDocument();
  });

  it('says a visit still live after the job was completed is skipped, and leaves a cancelled one grey', async () => {
    const live = { ...finishedVisit(2), status: 'SCHEDULED', completed_at: null };
    const cancelled = { ...finishedVisit(3), status: 'CANCELLED', completed_at: null, cancelled_at: '2026-10-02T16:00:00.000Z' };
    mount({ visits: [finishedVisit(1), live, cancelled] });
    const rail = within(await bar());
    expect(await within(await rail.findByRole('group', { name: 'Visit 2' })).findByText('Skipped')).toBeInTheDocument();
    expect(within(rail.getByRole('group', { name: 'Visit 3' })).queryByText('Skipped')).not.toBeInTheDocument();
  });
});
