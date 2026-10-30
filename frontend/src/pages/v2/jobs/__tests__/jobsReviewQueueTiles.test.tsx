/**
 * Roles & Permissions, PRD 6, S06.31 - the routed Jobs list carries the office review queue as two tiles.
 *
 * Office review is drawn for a holder of Office review and Ready to close for a holder of Close jobs; each tile shows the
 * count the Jobs list answered with and opens a filter the server knows by name (`in_office_review`, `ready_to_close`),
 * the query the count itself runs, so the number equals the rows. A tile is lit only while its filter is the only one
 * narrowing the list. A person who holds neither switch sees neither tile and is never offered either filter.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';

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
    status: 'OFFICE_REVIEW',
    scheduled_start: '2026-07-20T09:00:00.000Z',
    created_at: '2026-07-15T00:00:00.000Z',
    customer: { id: 'c1', first_name: 'John', last_name: 'Doe', company_name: null, customer_number: 'C00001' },
    assignees: [],
    service_location: null,
  }],
  pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
  users: [],
  departments: [],
  tags: [],
};

const BASE_STATS = { unassigned: 0, scheduled: 0, in_progress: 1, completed: 6, cancelled: 2, need_invoices: 3 };

const ability = buildAbility([
  { action: 'read', subject: 'Job' },
  { action: 'read', subject: 'Invoice' },
]);

type Params = Record<string, unknown>;
const lastJobsParams = (): Params => {
  const calls = mockApi.get.mock.calls.filter(([url]) => url === '/api/jobs');
  return (calls[calls.length - 1]?.[1] as { params: Params }).params;
};

/** The person's switches and the stats the Jobs list answers with. */
function answer(switches: Record<string, boolean>, stats: Record<string, number>) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/permission-switches/me') return { data: { admin_box: false, values: switches, rules: [] } };
    if (url === '/api/jobs') return { data: { ...JOB_LIST, stats: { ...BASE_STATS, ...stats } } };
    return { data: {} };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

const reviewTile = () => screen.getByRole('button', { name: /^office review/i });
const readyTile = () => screen.getByRole('button', { name: /^ready to close/i });
const queueTiles = () => screen.queryAllByRole('button', { name: /^(office review|ready to close)/i });

describe('Jobs list - the office review queue tiles', () => {
  it('draws both tiles, with the counts the list answered, for a holder of both switches', async () => {
    answer({ office_review: true, close_jobs: true }, { office_review: 4, ready_to_close: 7 });
    renderWithProviders(<JobsPage />, { ability, initialEntries: ['/jobs'] });
    await screen.findByText('J00001');

    await waitFor(() => expect(reviewTile()).toHaveTextContent('4'));
    expect(readyTile()).toHaveTextContent('7');
  });

  it('draws only Office review for a holder of Office review alone', async () => {
    answer({ office_review: true }, { office_review: 4 });
    renderWithProviders(<JobsPage />, { ability, initialEntries: ['/jobs'] });
    await screen.findByText('J00001');

    await waitFor(() => expect(reviewTile()).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /^ready to close/i })).toBeNull();
  });

  it('draws only Ready to close for a holder of Close jobs alone', async () => {
    answer({ close_jobs: true }, { ready_to_close: 7 });
    renderWithProviders(<JobsPage />, { ability, initialEntries: ['/jobs'] });
    await screen.findByText('J00001');

    await waitFor(() => expect(readyTile()).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /^office review/i })).toBeNull();
  });

  it('draws neither tile for a person who holds neither switch, whatever the stats carry', async () => {
    answer({ complete_jobs: true }, { office_review: 4, ready_to_close: 7 });
    renderWithProviders(<JobsPage />, { ability, initialEntries: ['/jobs'] });
    await screen.findByText('J00001');
    await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/api/permission-switches/me'));

    expect(queueTiles()).toEqual([]);
  });

  it('opens the named office review filter, with no status list of its own', async () => {
    answer({ office_review: true, close_jobs: true }, { office_review: 4, ready_to_close: 7 });
    renderWithProviders(<JobsPage />, { ability, initialEntries: ['/jobs'] });
    await screen.findByText('J00001');
    await waitFor(() => expect(reviewTile()).toBeInTheDocument());

    fireEvent.click(reviewTile());

    await waitFor(() => expect(lastJobsParams().in_office_review).toBe('true'));
    expect(lastJobsParams().status).toBeUndefined();
    expect(lastJobsParams().ready_to_close).toBeUndefined();
  });

  it('opens the named ready-to-close filter', async () => {
    answer({ office_review: true, close_jobs: true }, { office_review: 4, ready_to_close: 7 });
    renderWithProviders(<JobsPage />, { ability, initialEntries: ['/jobs'] });
    await screen.findByText('J00001');
    await waitFor(() => expect(readyTile()).toBeInTheDocument());

    fireEvent.click(readyTile());

    await waitFor(() => expect(lastJobsParams().ready_to_close).toBe('true'));
    expect(lastJobsParams().status).toBeUndefined();
    expect(lastJobsParams().in_office_review).toBeUndefined();
  });

  it('shows itself pressed while its filter is the only thing narrowing the list, and a second click clears it', async () => {
    answer({ office_review: true, close_jobs: true }, { office_review: 4, ready_to_close: 7 });
    renderWithProviders(<JobsPage />, { ability, initialEntries: ['/jobs'] });
    await screen.findByText('J00001');
    await waitFor(() => expect(reviewTile()).toBeInTheDocument());

    fireEvent.click(reviewTile());
    await waitFor(() => expect(reviewTile()).toHaveAttribute('aria-pressed', 'true'));
    expect(readyTile()).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(reviewTile());
    await waitFor(() => expect(lastJobsParams().in_office_review).toBeUndefined());
    expect(reviewTile()).toHaveAttribute('aria-pressed', 'false');
  });

  it('is lit by a deep link carrying the filter, and leaves the status tiles unlit', async () => {
    answer({ office_review: true }, { office_review: 4 });
    renderWithProviders(<JobsPage />, { ability, initialEntries: ['/jobs?in_office_review=true'] });
    await screen.findByText('J00001');

    await waitFor(() => expect(reviewTile()).toHaveAttribute('aria-pressed', 'true'));
    expect(lastJobsParams().in_office_review).toBe('true');
    expect(screen.getByRole('button', { name: /^completed/i })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: /need invoices/i })).toHaveAttribute('aria-pressed', 'false');
  });

  it('puts the lit tile out when another filter narrows the list further', async () => {
    answer({ office_review: true }, { office_review: 4 });
    renderWithProviders(<JobsPage />, { ability, initialEntries: ['/jobs?in_office_review=true&status=OFFICE_REVIEW'] });
    await screen.findByText('J00001');
    await waitFor(() => expect(reviewTile()).toBeInTheDocument());

    expect(reviewTile()).toHaveAttribute('aria-pressed', 'false');
  });

  it('never decodes or sends a queue filter from a deep link for a person who does not hold its switch', async () => {
    answer({ office_review: true }, { office_review: 4 });
    renderWithProviders(<JobsPage />, { ability, initialEntries: ['/jobs?ready_to_close=true'] });
    await screen.findByText('J00001');
    await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/api/permission-switches/me'));

    await waitFor(() => expect(lastJobsParams().ready_to_close).toBeUndefined());
  });

  it('offers the queue filters in the Filter popover only for the switches the person holds', async () => {
    answer({ office_review: true }, { office_review: 4 });
    renderWithProviders(<JobsPage />, { ability, initialEntries: ['/jobs'] });
    await screen.findByText('J00001');
    await waitFor(() => expect(reviewTile()).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /^filter$/i }));

    // The popover lists the facets first; the queue facets are among them only for the switches held.
    fireEvent.click(await screen.findByText('Office review queue'));
    expect(await screen.findByRole('checkbox', { name: 'Office review queue' })).toBeInTheDocument();
    expect(screen.queryByText('Ready to close queue')).toBeNull();
  });

  it('leaves the Completed tile on its own filter while a queue tile is lit', async () => {
    answer({ office_review: true, close_jobs: true }, { office_review: 4, ready_to_close: 7 });
    renderWithProviders(<JobsPage />, { ability, initialEntries: ['/jobs'] });
    await screen.findByText('J00001');
    await waitFor(() => expect(readyTile()).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /^completed/i }));
    await waitFor(() => expect(lastJobsParams().completed_this_month).toBe('true'));

    expect(lastJobsParams().ready_to_close).toBeUndefined();
    expect(readyTile()).toHaveAttribute('aria-pressed', 'false');
  });
});
