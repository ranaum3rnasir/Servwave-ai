/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * Roles & Permissions S09.16 - the Jobs this month tile on the routed home page: how many jobs have a visit this month,
 * and the line "N finished · M still to do" over those visits.
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

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);
const ID = 'jobs_this_month';

const meta = (link: string | null): DashboardTileMeta => ({ id: ID, category: 'jobs', mode: 'scope', label: null, link });
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

/** The page of a person whose saved layout holds the tile (as a Technician's default does). */
function open(body: DashboardResponse) {
  serveDashboard(body, [{ id: ID, visible: true }]);
  renderWithProviders(<><DashboardPage /><Where /></>, { ability: ADMIN });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('the Jobs this month tile', () => {
  it('shows the number of jobs and the line "N finished · M still to do"', async () => {
    open(answer('/sent-jobs', { jobs: 6, finished: 9, still_to_do: 4 }));
    const tile = (await screen.findByText('Jobs this month')).closest('button') as HTMLElement;
    expect(within(tile).getByText('6')).toBeInTheDocument();
    expect(within(tile).getByText('9 finished · 4 still to do')).toBeInTheDocument();
  });

  it('never calls a finished visit "Completed" or "Done"', async () => {
    open(answer('/sent-jobs', { jobs: 2, finished: 3, still_to_do: 1 }));
    const tile = (await screen.findByText('Jobs this month')).closest('button') as HTMLElement;
    expect(tile.textContent).not.toMatch(/completed|done/i);
  });

  it('says so plainly when no job has a visit this month', async () => {
    open(answer('/sent-jobs', { jobs: 0, finished: 0, still_to_do: 0 }));
    expect(await screen.findByText('No jobs this month')).toBeInTheDocument();
    expect(screen.queryByText(/finished/)).not.toBeInTheDocument();
  });

  it('opens the address the server sent for the tile', async () => {
    open(answer('/sent-jobs', { jobs: 1, finished: 0, still_to_do: 1 }));
    fireEvent.click((await screen.findByText('Jobs this month')).closest('button')!);
    expect(where()).toBe('/sent-jobs');
  });

  it('is drawn but is not a control when the server sent no address (no View jobs)', async () => {
    open(answer(null, { jobs: 1, finished: 0, still_to_do: 1 }));
    const label = await screen.findByText('Jobs this month');
    expect(label.closest('button')).toBeNull();
    expect(screen.getByText('0 finished · 1 still to do')).toBeInTheDocument();
  });

  it('claims nothing before the first answer lands', async () => {
    vi.mocked(api.get).mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<DashboardPage />, { ability: ADMIN });
    await screen.findByRole('button', { name: /Customize home page/ });
    expect(screen.queryByText('No jobs this month')).not.toBeInTheDocument();
  });

  it('is offered by the picker under the Jobs category the server named, and added from there', async () => {
    serveDashboard(answer('/sent-jobs', { jobs: 0, finished: 0, still_to_do: 0 }), []);
    renderWithProviders(<DashboardPage />, { ability: ADMIN });
    fireEvent.click(await screen.findByRole('button', { name: /Customize home page/ }));
    const group = (await screen.findByText('Jobs', { selector: '[data-testid="category-name"]' })).closest('[role="group"]') as HTMLElement;
    fireEvent.click(within(group).getByRole('button', { name: 'Add Jobs this month' }));
    expect(await screen.findByText('No jobs this month')).toBeInTheDocument();
  });
});
