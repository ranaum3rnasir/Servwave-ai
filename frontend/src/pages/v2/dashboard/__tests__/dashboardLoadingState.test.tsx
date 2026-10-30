/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * Roles & Permissions S09.4 follow-up - while the server's layout is being read the routed dashboard draws plain
 * loading placeholders (it knows no tile yet, so it names none), then the person's tiles; a failed read leaves no
 * placeholder waiting for ever.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';

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

const meta = (id: string, category: DashboardTileMeta['category']): DashboardTileMeta => ({ id, category, mode: 'company', label: null, link: '/somewhere' });
const answer: DashboardResponse = {
  tiles: [meta('kpi.open_leads', 'leads')],
  categories: [{ id: 'leads', label: 'Leads' }],
  data: { 'kpi.open_leads': { count: 2, no_owner: 1 } },
  generated_at: '2026-10-12T10:00:00.000Z',
};

/** Makes the layout read wait until the test lets it go (or fail), the other reads answering as served. */
function holdLayoutRead() {
  serveDashboard(answer, [{ id: 'kpi.open_leads', visible: true }]);
  const served = mockApi.get.getMockImplementation()! as (...a: unknown[]) => Promise<unknown>;
  let release!: (ok: boolean) => void;
  const gate = new Promise<boolean>((resolve) => { release = resolve; });
  mockApi.get.mockImplementation(((url: string, ...rest: unknown[]) =>
    url === '/api/dashboard/layout'
      ? gate.then((ok) => (ok ? served(url, ...rest) : Promise.reject(new Error('Network Error'))))
      : served(url, ...rest)) as never);
  return release;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('the dashboard while its layout is read', () => {
  it('draws loading placeholders and no tile until the layout answers', async () => {
    const release = holdLayoutRead();
    renderWithProviders(<DashboardPage />, { ability: ADMIN });

    expect(await screen.findByRole('status')).toHaveTextContent('Loading your home page');
    // The tile list is known (the dashboard answer landed) but the layout is not: no tile is drawn.
    await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/api/dashboard', expect.anything()));
    expect(screen.queryByText('Open Leads')).not.toBeInTheDocument();

    release(true);
    expect(await screen.findByText('Open Leads')).toBeInTheDocument();
    expect(screen.queryByText('Loading your home page')).not.toBeInTheDocument();
  });

  it('stops showing placeholders when the layout cannot be read', async () => {
    const release = holdLayoutRead();
    renderWithProviders(<DashboardPage />, { ability: ADMIN });
    await screen.findByText('Loading your home page');

    release(false);
    await waitFor(() => expect(screen.queryByText('Loading your home page')).not.toBeInTheDocument());
    expect(screen.queryByText('Open Leads')).not.toBeInTheDocument();
  });
});
