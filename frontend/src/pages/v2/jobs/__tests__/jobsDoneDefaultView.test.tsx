/**
 * Roles & Permissions, PRD 6, S06.30 - the routed Jobs list: Done leaves the default view, the status filter brings it
 * back, and the Completed tile opens the same set it counts.
 *
 * The default view is the server's (no status asked for), so the page asks for nothing special. The Completed tile
 * opens a filter the server knows by name (`completed_this_month`), never a status list the browser rebuilt: that list
 * would leave out Office review, Ready to close and Done, and the tile's number would disagree with its rows.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';
import { startOfMonthDay, endOfMonthDay } from '@/lib/date-range';
import { DEFAULT_SCHEDULE_TIMEZONE } from '@/lib/schedule-tz';

import JobsPage from '../JobsPage';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const mockApi = vi.mocked(api);

const JOB_LIST = {
  jobs: [{
    id: 'j0000000-0000-0000-0000-000000000001',
    job_number: 'J00001',
    status: 'IN_PROGRESS',
    scheduled_start: '2026-07-20T09:00:00.000Z',
    created_at: '2026-07-15T00:00:00.000Z',
    customer: { id: 'c1', first_name: 'John', last_name: 'Doe', company_name: null, customer_number: 'C00001' },
    assignees: [],
    service_location: null,
  }],
  pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
  stats: { unassigned: 0, scheduled: 0, in_progress: 1, completed: 6, cancelled: 2, need_invoices: 3 },
  users: [],
  departments: [],
  tags: [],
};

const ability = buildAbility([
  { action: 'read', subject: 'Job' },
  { action: 'read', subject: 'Invoice' },
]);

type Params = Record<string, unknown>;
const lastJobsParams = (): Params => {
  const calls = mockApi.get.mock.calls.filter(([url]) => url === '/api/jobs');
  return (calls[calls.length - 1]?.[1] as { params: Params }).params;
};

beforeEach(() => {
  vi.clearAllMocks();
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  mockApi.get.mockResolvedValue({ data: JOB_LIST });
});

const completedTile = () => screen.getByRole('button', { name: /^completed/i });

describe('Jobs list - the default view and Done', () => {
  it('asks for no status on a plain visit, so the server leaves Done out for every caller alike', async () => {
    renderWithProviders(<JobsPage />, { ability, initialEntries: ['/jobs'] });
    await screen.findByText('J00001');

    expect(lastJobsParams().status).toBeUndefined();
    expect(lastJobsParams().include_done).toBeUndefined();
  });

  it('offers Done, Office review and Ready to close in the Status filter, and asks for the one picked', async () => {
    renderWithProviders(<JobsPage />, { ability, initialEntries: ['/jobs'] });
    await screen.findByText('J00001');

    fireEvent.click(screen.getByRole('button', { name: /^filter$/i }));
    expect(await screen.findByRole('checkbox', { name: 'Office review' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Ready to close' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Done' }));

    await waitFor(() => expect(lastJobsParams().status).toBe('DONE'));
  });
});

describe('Jobs list - the Completed tile opens what it counts', () => {
  it('asks for the named completed-this-month filter, with no status list and no month range of its own', async () => {
    renderWithProviders(<JobsPage />, { ability, initialEntries: ['/jobs'] });
    await screen.findByText('J00001');

    fireEvent.click(completedTile());

    await waitFor(() => expect(lastJobsParams().completed_this_month).toBe('true'));
    expect(lastJobsParams().status).toBeUndefined();
    expect(lastJobsParams().scheduled_after).toBeUndefined();
    expect(lastJobsParams().scheduled_before).toBeUndefined();
    expect(lastJobsParams().needs_invoice).toBeUndefined();
  });

  it('shows itself pressed while the filter is the only thing narrowing the list, and a second click clears it', async () => {
    renderWithProviders(<JobsPage />, { ability, initialEntries: ['/jobs'] });
    await screen.findByText('J00001');

    fireEvent.click(completedTile());
    await waitFor(() => expect(completedTile()).toHaveAttribute('aria-pressed', 'true'));

    fireEvent.click(completedTile());
    await waitFor(() => expect(lastJobsParams().completed_this_month).toBeUndefined());
    expect(completedTile()).toHaveAttribute('aria-pressed', 'false');
  });

  it('is lit by a deep link carrying the filter', async () => {
    renderWithProviders(<JobsPage />, { ability, initialEntries: ['/jobs?completed_this_month=true'] });
    await screen.findByText('J00001');

    expect(lastJobsParams().completed_this_month).toBe('true');
    expect(completedTile()).toHaveAttribute('aria-pressed', 'true');
  });

  it('leaves the Need Invoices tile unlit while the Completed filter is on, and the other way round', async () => {
    renderWithProviders(<JobsPage />, { ability, initialEntries: ['/jobs'] });
    await screen.findByText('J00001');

    fireEvent.click(completedTile());
    await waitFor(() => expect(completedTile()).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.getByRole('button', { name: /need invoices/i })).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByRole('button', { name: /need invoices/i }));
    await waitFor(() => expect(lastJobsParams().needs_invoice).toBe('true'));
    expect(lastJobsParams().completed_this_month).toBeUndefined();
    expect(completedTile()).toHaveAttribute('aria-pressed', 'false');
  });

  it('is a filter in the Filter popover too, so the chip bar can name it and clear it', async () => {
    renderWithProviders(<JobsPage />, { ability, initialEntries: ['/jobs?completed_this_month=true'] });
    await screen.findByText('J00001');

    expect(screen.getAllByText(/completed this month/i).length).toBeGreaterThan(0);
  });

  it('keeps the Cancelled tile on its status and month range, which count the same rows', async () => {
    renderWithProviders(<JobsPage />, { ability, initialEntries: ['/jobs'] });
    await screen.findByText('J00001');

    fireEvent.click(screen.getByRole('button', { name: /^cancelled/i }));

    await waitFor(() => expect(lastJobsParams().status).toBe('CANCELLED'));
    expect(lastJobsParams().scheduled_after).toBe(startOfMonthDay(DEFAULT_SCHEDULE_TIMEZONE));
    expect(lastJobsParams().scheduled_before).toBe(endOfMonthDay(DEFAULT_SCHEDULE_TIMEZONE));
    expect(lastJobsParams().completed_this_month).toBeUndefined();
  });

  it('still takes an older Completed deep link (status and month range) as a plain status filter, not as the tile', async () => {
    const monthStart = startOfMonthDay(DEFAULT_SCHEDULE_TIMEZONE);
    const monthEnd = endOfMonthDay(DEFAULT_SCHEDULE_TIMEZONE);
    renderWithProviders(<JobsPage />, {
      ability,
      initialEntries: [`/jobs?status=COMPLETED&scheduled_after=${monthStart}&scheduled_before=${monthEnd}`],
    });
    await screen.findByText('J00001');

    expect(lastJobsParams().status).toBe('COMPLETED');
    expect(completedTile()).toHaveAttribute('aria-pressed', 'false');
  });
});
