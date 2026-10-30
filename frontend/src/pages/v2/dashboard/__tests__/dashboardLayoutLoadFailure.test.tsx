/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * Roles & Permissions, pass 2 re-check - a layout read that fails is not drawn as an empty page. The home page says it
 * could not load, with the same Retry a failed data read shows; Retry reads the layout again; and Customize is not
 * offered while the layout is unknown, because a save made over a layout the page never saw would wipe the person's
 * saved one.
 *
 * The page is the routed one (pages/v2/dashboard/DashboardPage).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import type { DashboardResponse, DashboardTileMeta } from '@/lib/api/dashboard';
import { renderWithProviders, serveDashboard } from '@/__tests__/helpers';
import DashboardPage from '../DashboardPage';

vi.hoisted(() => {
  vi.stubEnv('VITE_DASHBOARD_USE_MOCK', 'false');
});

const mockApi = vi.mocked(api);
const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);
const ME = '00000000-0000-0000-0000-000000000001';

const meta = (id: string): DashboardTileMeta => ({ id, category: 'jobs', mode: 'company', label: null, link: '/somewhere' });
const answer: DashboardResponse = {
  tiles: [meta('kpi.jobs_today')],
  categories: [{ id: 'jobs', label: 'Jobs' }],
  data: { 'kpi.jobs_today': { total: 3, scheduled: 2, in_progress: 1, completed: 0, vs_yesterday: 0 } },
  generated_at: '2026-10-12T10:00:00.000Z',
};
const LAYOUT = [{ id: 'kpi.jobs_today', visible: true }];

/** The layout read fails until the test lets it through. */
function layoutReadFails() {
  const server = serveDashboard(answer, LAYOUT);
  const served = mockApi.get.getMockImplementation()! as (...a: unknown[]) => Promise<unknown>;
  const state = { failing: true, reads: 0 };
  mockApi.get.mockImplementation(((url: string, ...rest: unknown[]) => {
    if (url !== '/api/dashboard/layout') return served(url, ...rest);
    state.reads += 1;
    return state.failing ? Promise.reject(new Error('Network Error')) : served(url, ...rest);
  }) as never);
  return { server, state };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('when the layout read fails', () => {
  it('says the home page could not be loaded, with a Retry, and offers no Customize', async () => {
    layoutReadFails();
    renderWithProviders(<DashboardPage />, { ability: ADMIN });

    expect(await screen.findByText("Couldn't load your home page.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Customize home page/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument(); // not left on its loading placeholders
  });

  it('reads the layout again on Retry and draws the tiles when it answers', async () => {
    const { state } = layoutReadFails();
    renderWithProviders(<DashboardPage />, { ability: ADMIN });
    const retry = await screen.findByRole('button', { name: 'Retry' });

    state.failing = false;
    fireEvent.click(retry);

    expect(await screen.findByText('Jobs Today')).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load your home page.")).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Customize home page/ })).toBeInTheDocument();
    expect(state.reads).toBeGreaterThan(1);
  });

  it('saves nothing and carries nothing over, so the saved layout cannot be replaced by one the page never saw', async () => {
    localStorage.setItem(`alpha:dashboard-layout:v1:${ME}`, JSON.stringify([{ id: 'kpi.jobs_today', visible: false }]));
    const { server } = layoutReadFails();
    renderWithProviders(<DashboardPage />, { ability: ADMIN });
    await screen.findByText("Couldn't load your home page.");

    expect(mockApi.put).not.toHaveBeenCalled();
    expect(mockApi.post).not.toHaveBeenCalled();
    expect(server.saves).toEqual([]);
    expect(localStorage.getItem(`alpha:dashboard-layout:v1:${ME}`)).not.toBeNull();
  });

  it('keeps drawing the layout it already has when a later read of it fails', async () => {
    serveDashboard(answer, LAYOUT);
    const served = mockApi.get.getMockImplementation()! as (...a: unknown[]) => Promise<unknown>;
    let failing = false;
    mockApi.get.mockImplementation(((url: string, ...rest: unknown[]) =>
      url === '/api/dashboard/layout' && failing ? Promise.reject(new Error('Network Error')) : served(url, ...rest)) as never);
    const { queryClient } = renderWithProviders(<DashboardPage />, { ability: ADMIN });
    await screen.findByText('Jobs Today');

    failing = true;
    await act(async () => { await queryClient.refetchQueries({ queryKey: ['dashboard-layout'] }); });
    expect(queryClient.getQueryState(['dashboard-layout', ME])?.status).toBe('error');
    expect(screen.getByText('Jobs Today')).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load your home page.")).not.toBeInTheDocument();
  });
});
