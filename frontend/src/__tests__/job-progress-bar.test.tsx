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
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import JobDetailPage from '@/pages/v2/jobs/JobDetailPage';
import { buildAbility } from '@/lib/ability';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));

const JOB_ID = 'j0000000-0000-0000-0000-000000000021';
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: JOB_ID }), useNavigate: () => vi.fn() };
});

const mockApi = vi.mocked(api);
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
  const job = {
    id: JOB_ID, job_number: 'J00021', status: 'OFFICE_REVIEW', scope_notes: null, estimated_duration: null, completion_notes: null,
    scheduled_start: '2026-10-02T13:00:00.000Z', scheduled_end: '2026-10-02T15:00:00.000Z', started_at: null,
    completed_at: '2026-10-02T15:00:00.000Z', cancelled_at: null, cancelled_reason: null, closed_at: null,
    created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z',
    customer: { id: 'c1', first_name: 'John', last_name: 'Doe', company_name: null, email: 'j@d.com', phone: '5551234567' },
    assignees: [], visits, service_location: null, estimate: null, invoices: [], linked_estimates: [], tags: [],
    source_plan_id: null, source_plan: null, locked: true, locked_actions: [], actions: ['office_review', 'finish_review'],
    new_visit_closed_reason: 'Move this job back out of review first', close_out_money: null,
    ...over.job,
  };
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === `/api/jobs/${JOB_ID}/review`) return { data: { review: null } } as never;
    if (url === `/api/jobs/${JOB_ID}/visits`) return { data: { visits } } as never;
    if (url.endsWith('/financials')) return { data: over.financials ?? NEVER_INVOICED } as never;
    if (url.endsWith('/scopes')) return { data: { scopes: [], billing: { total: 0, invoiced: 0, remaining: 0 } } } as never;
    if (url.endsWith('/line-items')) return { data: { lines: [], billing: { total: 0, invoiced: 0, remaining: 0 } } } as never;
    if (url.includes(`/api/jobs/${JOB_ID}`)) return { data: { job } } as never;
    return { data: {} } as never;
  });
  return renderWithProviders(<><JobDetailPage /><Address /></>, { ability: over.ability ?? adminAbility, initialEntries: [`/jobs/${JOB_ID}`] });
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
