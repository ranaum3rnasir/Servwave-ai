/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * Roles & Permissions S09.9 - the Unscheduled jobs tile on the routed home page: a count and the jobs that have waited
 * longest, each row opening the job at the address the server sent, "View all" only when the server sent the Jobs list's
 * address, and one plain line when nothing is waiting.
 *
 * The page is the routed one (pages/v2/dashboard/DashboardPage), against the JSON shape GET /api/dashboard sends. The
 * addresses in these answers are invented ones, so a page that sent anyone somewhere it knew would fail.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { useLocation } from 'react-router-dom';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import type { DashboardResponse, DashboardTileMeta } from '@/lib/api/dashboard';
import { renderWithProviders, serveDashboard } from '@/__tests__/helpers';
import DashboardPage from '../DashboardPage';

vi.hoisted(() => {
  vi.stubEnv('VITE_DASHBOARD_USE_MOCK', 'false');
});

const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);
const ID = 'unscheduled_jobs';

const meta = (link: string | null): DashboardTileMeta => ({ id: ID, category: 'jobs', mode: 'company', label: null, link });
const job = (n: number, age_days: number) => ({
  id: `job-${n}`, job_number: `J-${n}`, title: `Customer ${n}`, address: `${n} Main St, Testville`, age_days, link: `/sent-job/${n}`,
});
const answer = (link: string | null, data: unknown): DashboardResponse => ({
  tiles: [meta(link)],
  categories: [{ id: 'jobs', label: 'Jobs' }],
  data: { [ID]: data } as DashboardResponse['data'],
  generated_at: '2026-10-12T10:00:00.000Z',
});

/** Shows where the page has been sent. */
function Where() {
  return <p data-testid="where">{useLocation().pathname + useLocation().search}</p>;
}
const where = () => screen.getByTestId('where').textContent;

/** The page of a person whose saved layout holds the tile (as a Dispatcher's default does). */
function open(body: DashboardResponse) {
  serveDashboard(body, [{ id: ID, visible: true }]);
  renderWithProviders(<><DashboardPage /><Where /></>, { ability: ADMIN });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('the Unscheduled jobs tile', () => {
  it('shows how many jobs are waiting and one row per job the server sent, each with its number, customer, place and wait', async () => {
    open(answer('/sent-jobs', { count: 7, jobs: [job(1, 9), job(2, 1), job(3, 0)] }));
    const tile = (await screen.findByRole('heading', { name: /Unscheduled jobs/ })).closest('[data-slot="card"]') as HTMLElement;
    expect(within(tile).getByText('7')).toBeInTheDocument();
    expect(within(tile).getByText('J-1')).toBeInTheDocument();
    expect(within(tile).getByText('Customer 1')).toBeInTheDocument();
    expect(within(tile).getByText('1 Main St, Testville')).toBeInTheDocument();
    expect(within(tile).getByText('9 days')).toBeInTheDocument();
    expect(within(tile).getByText('1 day')).toBeInTheDocument();
    expect(within(tile).getByText('Today')).toBeInTheDocument();
    // The tile draws the jobs it was sent and no wall: three rows, not seven.
    expect(within(tile).getAllByText(/^J-\d$/)).toHaveLength(3);
  });

  it('opens a row on the job at the address the server sent', async () => {
    open(answer('/sent-jobs', { count: 2, jobs: [job(1, 3), job(2, 2)] }));
    fireEvent.click((await screen.findByText('Customer 2')).closest('button')!);
    expect(where()).toBe('/sent-job/2');
  });

  it('sends "View all" to the address the server sent for the tile', async () => {
    open(answer('/sent-jobs?status=sent', { count: 1, jobs: [job(1, 3)] }));
    fireEvent.click(await screen.findByRole('button', { name: 'View all' }));
    expect(where()).toBe('/sent-jobs?status=sent');
  });

  it('offers no "View all" when the server sent no address for the tile, and the rows still open their jobs', async () => {
    open(answer(null, { count: 1, jobs: [job(1, 3)] }));
    const row = await screen.findByText('Customer 1');
    expect(screen.queryByRole('button', { name: 'View all' })).not.toBeInTheDocument();
    fireEvent.click(row.closest('button')!);
    expect(where()).toBe('/sent-job/1');
  });

  it('says so in one plain line when no job is waiting, with no count and no rows', async () => {
    open(answer('/sent-jobs', { count: 0, jobs: [] }));
    expect(await screen.findByText('No unscheduled jobs')).toBeInTheDocument();
  });

  it('claims nothing before the first answer lands', async () => {
    vi.mocked(api.get).mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<DashboardPage />, { ability: ADMIN });
    await screen.findByRole('button', { name: /Customize home page/ });
    expect(screen.queryByText('No unscheduled jobs')).not.toBeInTheDocument();
  });

  it('is offered by the picker under the Jobs category the server named, and added from there', async () => {
    serveDashboard(answer('/sent-jobs', { count: 0, jobs: [] }), []);
    renderWithProviders(<DashboardPage />, { ability: ADMIN });
    fireEvent.click(await screen.findByRole('button', { name: /Customize home page/ }));
    const group = (await screen.findByText('Jobs', { selector: '[data-testid="category-name"]' })).closest('[role="group"]') as HTMLElement;
    fireEvent.click(within(group).getByRole('button', { name: 'Add Unscheduled jobs' }));
    expect(await screen.findByText('No unscheduled jobs')).toBeInTheDocument();
  });
});
