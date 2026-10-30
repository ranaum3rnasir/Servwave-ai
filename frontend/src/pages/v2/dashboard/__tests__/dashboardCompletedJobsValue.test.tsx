/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * Roles & Permissions S09.17 - the Completed jobs value tile on the routed home page: what was invoiced on the jobs that
 * reached Completed this month, the number of those jobs, the word the server sends when the figure is the person's own
 * ("Yours"), a plain empty state, and the address the server sent.
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
const ID = 'completed_jobs_value';

const meta = (link: string | null, label: DashboardTileMeta['label'] = 'Yours'): DashboardTileMeta => ({
  id: ID, category: 'job_value', mode: label ? 'own' : 'company', label, link,
});
const answer = (link: string | null, data: unknown, label: DashboardTileMeta['label'] = 'Yours'): DashboardResponse => ({
  tiles: [meta(link, label)],
  categories: [{ id: 'job_value', label: 'Job value' }],
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

describe('the Completed jobs value tile', () => {
  it('shows the invoiced value and the number of jobs it covers', async () => {
    open(answer('/sent-jobs', { jobs: 3, value: 1250 }));
    const tile = (await screen.findByText('Completed jobs value')).closest('button') as HTMLElement;
    expect(within(tile).getByText('$1,250')).toBeInTheDocument();
    expect(within(tile).getByText('3 jobs')).toBeInTheDocument();
  });

  it('says "1 job" for a single job', async () => {
    open(answer('/sent-jobs', { jobs: 1, value: 80 }));
    const tile = (await screen.findByText('Completed jobs value')).closest('button') as HTMLElement;
    expect(within(tile).getByText('1 job')).toBeInTheDocument();
  });

  it('carries the label the server sent when the figure is the person\'s own, and none when it is the company\'s', async () => {
    open(answer('/sent-jobs', { jobs: 2, value: 300 }, 'Yours'));
    const tile = (await screen.findByText('Completed jobs value')).closest('button') as HTMLElement;
    expect(within(tile).getByText('Yours')).toBeInTheDocument();
  });

  it('shows no label for the company\'s figure', async () => {
    open(answer('/sent-jobs', { jobs: 2, value: 300 }, null));
    const tile = (await screen.findByText('Completed jobs value')).closest('button') as HTMLElement;
    expect(within(tile).queryByText('Yours')).not.toBeInTheDocument();
    expect(within(tile).queryByText(/Your team|Your location/)).not.toBeInTheDocument();
  });

  it('says so plainly when no job reached Completed this month', async () => {
    open(answer('/sent-jobs', { jobs: 0, value: 0 }));
    expect(await screen.findByText('No jobs completed this month')).toBeInTheDocument();
  });

  it('opens the address the server sent for the tile', async () => {
    open(answer('/sent-jobs?completed_this_month=true', { jobs: 1, value: 10 }));
    fireEvent.click((await screen.findByText('Completed jobs value')).closest('button')!);
    expect(where()).toBe('/sent-jobs?completed_this_month=true');
  });

  it('is drawn but is not a control when the server sent no address (no View jobs)', async () => {
    open(answer(null, { jobs: 1, value: 10 }));
    const label = await screen.findByText('Completed jobs value');
    expect(label.closest('button')).toBeNull();
    expect(screen.getByText('$10')).toBeInTheDocument();
  });

  it('claims nothing before the first answer lands', async () => {
    vi.mocked(api.get).mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<DashboardPage />, { ability: ADMIN });
    await screen.findByRole('button', { name: /Customize home page/ });
    expect(screen.queryByText('No jobs completed this month')).not.toBeInTheDocument();
  });

  it('is offered by the picker under the Job value category the server named, and added from there', async () => {
    serveDashboard(answer('/sent-jobs', { jobs: 0, value: 0 }), []);
    renderWithProviders(<DashboardPage />, { ability: ADMIN });
    fireEvent.click(await screen.findByRole('button', { name: /Customize home page/ }));
    const group = (await screen.findByText('Job value', { selector: '[data-testid="category-name"]' })).closest('[role="group"]') as HTMLElement;
    fireEvent.click(within(group).getByRole('button', { name: 'Add Completed jobs value' }));
    expect(await screen.findByText('No jobs completed this month')).toBeInTheDocument();
  });
});
