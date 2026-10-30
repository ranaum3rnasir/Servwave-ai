/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * Roles & Permissions S09.1 fix - the home page's read computes only the tiles the layout shows. A layout change that
 * shows a tile the cached answer holds no figures for (Reset to the role's default, the one-time carry-over of a
 * browser layout) must read the dashboard again, not leave that tile waiting until the next scheduled read.
 *
 * The page is the routed one (pages/v2/dashboard/DashboardPage). The fake server answers the first dashboard read with
 * figures for Jobs Today only, and every later read with all tiles' figures.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

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

const meta = (id: string, category: DashboardTileMeta['category']): DashboardTileMeta => ({ id, category, mode: 'company', label: null, link: '/somewhere' });
const tiles = [meta('kpi.jobs_today', 'jobs'), meta('kpi.open_leads', 'leads')];
const categories: DashboardResponse['categories'] = [{ id: 'jobs', label: 'Jobs' }, { id: 'leads', label: 'Leads' }];
const jobsToday = { total: 3, scheduled: 2, in_progress: 1, completed: 0, vs_yesterday: 0 };
const openLeads = { count: 7, no_owner: 1 };
const partial: DashboardResponse = { tiles, categories, data: { 'kpi.jobs_today': jobsToday }, generated_at: '2026-10-12T10:00:00.000Z' };
const full: DashboardResponse = { tiles, categories, data: { 'kpi.jobs_today': jobsToday, 'kpi.open_leads': openLeads }, generated_at: '2026-10-12T10:00:01.000Z' };

/** The server as the home page meets it: the first dashboard read holds only what the layout then showed. */
function serveWithPartialFirstRead(...args: Parameters<typeof serveDashboard>) {
  const server = serveDashboard(...args);
  const served = mockApi.get.getMockImplementation()! as (...a: unknown[]) => Promise<unknown>;
  const reads = { dashboard: 0 };
  mockApi.get.mockImplementation(((url: string, ...rest: unknown[]) => {
    if (url !== '/api/dashboard') return served(url, ...rest);
    reads.dashboard += 1;
    return Promise.resolve({ data: reads.dashboard === 1 ? partial : full });
  }) as never);
  return { server, reads };
}

const loadingTiles = () => document.querySelectorAll('[aria-busy="true"]').length;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('the dashboard after a layout change that shows a tile it has no figures for', () => {
  it('reads the dashboard again after "Reset to my role\'s default", and draws the new tile\'s figures', async () => {
    const roleDefault = [{ id: 'kpi.jobs_today', visible: true }, { id: 'kpi.open_leads', visible: true }];
    const { server, reads } = serveWithPartialFirstRead(
      { ...partial },
      [{ id: 'kpi.jobs_today', visible: true }],
      roleDefault,
    );
    renderWithProviders(<DashboardPage />, { ability: ADMIN });
    await screen.findByText('Jobs Today');
    expect(reads.dashboard).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: /Customize home page/ }));
    fireEvent.click(await screen.findByRole('button', { name: "Reset to my role's default" }));
    await waitFor(() => expect(server.resets).toBe(1));

    await waitFor(() => expect(reads.dashboard).toBe(2));
    await waitFor(() => expect(screen.getByText('7')).toBeInTheDocument());
    expect(loadingTiles()).toBe(0);
  });

  it('reads the dashboard again after the one-time carry-over of a browser layout', async () => {
    const browserLayout = [{ id: 'kpi.jobs_today', visible: true }, { id: 'kpi.open_leads', visible: true }];
    localStorage.setItem(`alpha:dashboard-layout:v1:${ME}`, JSON.stringify(browserLayout));
    const { server, reads } = serveWithPartialFirstRead(
      { ...partial },
      [{ id: 'kpi.jobs_today', visible: true }],
      [{ id: 'kpi.jobs_today', visible: true }],
      { saved: false },
    );
    renderWithProviders(<DashboardPage />, { ability: ADMIN });

    await waitFor(() => expect(server.carryOvers).toHaveLength(1));
    await waitFor(() => expect(reads.dashboard).toBeGreaterThanOrEqual(2));
    expect(await screen.findByText('Open Leads')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('7')).toBeInTheDocument());
    expect(loadingTiles()).toBe(0);
  });
});
