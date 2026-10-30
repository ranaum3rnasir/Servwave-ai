/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * Roles & Permissions, pass 2 re-check - the home page's read computes only the tiles the layout shows, so ANY time the
 * layout shows a tile the dashboard answer holds no figures for, the page reads the dashboard again once the layout is
 * known: after the one-time carry-over, after Reset, after Customize adds a tile, and when the layout read itself
 * brings tiles the first dashboard read was built without. The in-flight ordering is the one a browser has: the
 * dashboard read starts WITH the layout read, before anything is carried over, and answers after.
 *
 * A tile whose figures are legitimately absent (the server could not build it) ends as "Couldn't load", never as a
 * spinner, and the page never reads again for the same layout.
 *
 * The page is the routed one (pages/v2/dashboard/DashboardPage).
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
const JOBS_ONLY = [{ id: 'kpi.jobs_today', visible: true }];
const BOTH = [{ id: 'kpi.jobs_today', visible: true }, { id: 'kpi.open_leads', visible: true }];

/**
 * The browser's ordering: the FIRST dashboard read is held until the test lets it go, and then answers with `first`
 * (built from the layout as it was when the read was sent); every later read answers with `later`.
 */
function holdFirstDashboardRead(first: DashboardResponse, later: DashboardResponse) {
  const served = mockApi.get.getMockImplementation()! as (...a: unknown[]) => Promise<unknown>;
  const reads = { dashboard: 0 };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  mockApi.get.mockImplementation(((url: string, ...rest: unknown[]) => {
    if (url !== '/api/dashboard') return served(url, ...rest);
    reads.dashboard += 1;
    return reads.dashboard === 1 ? gate.then(() => ({ data: first })) : Promise.resolve({ data: later });
  }) as never);
  return { reads, release };
}

const stillLoading = () => document.querySelectorAll('[aria-busy="true"]').length;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('a dashboard read still on its way when the layout changes under it', () => {
  it('reads again after the one-time carry-over lands before the first read answers, and draws the carried tile', async () => {
    localStorage.setItem(`alpha:dashboard-layout:v1:${ME}`, JSON.stringify(BOTH));
    const server = serveDashboard(partial, JOBS_ONLY, JOBS_ONLY, { saved: false });
    const { reads, release } = holdFirstDashboardRead(partial, full);
    renderWithProviders(<DashboardPage />, { ability: ADMIN });

    await waitFor(() => expect(server.carryOvers).toHaveLength(1));
    await screen.findByText('Open Leads'); // the layout is the carried one; the first dashboard read is still out
    expect(reads.dashboard).toBe(1);

    release();
    await waitFor(() => expect(reads.dashboard).toBe(2));
    expect(await screen.findByText('7')).toBeInTheDocument();
    await waitFor(() => expect(stillLoading()).toBe(0));
    expect(reads.dashboard).toBe(2);
  });

  it('reads again when the layout read itself brings a tile the first dashboard read was built without', async () => {
    const server = serveDashboard(partial, BOTH, BOTH);
    expect(server.saved).toBe(true);
    const { reads, release } = holdFirstDashboardRead(partial, full);
    renderWithProviders(<DashboardPage />, { ability: ADMIN });

    await screen.findByText('Open Leads');
    release();
    await waitFor(() => expect(reads.dashboard).toBe(2));
    expect(await screen.findByText('7')).toBeInTheDocument();
    expect(stillLoading()).toBe(0);
  });

  it('reads again after Reset when it lands while a read is still out', async () => {
    serveDashboard(partial, JOBS_ONLY, BOTH);
    const { reads, release } = holdFirstDashboardRead(partial, full);
    renderWithProviders(<DashboardPage />, { ability: ADMIN });

    await screen.findByText('Jobs Today');
    fireEvent.click(screen.getByRole('button', { name: /Customize home page/ }));
    fireEvent.click(await screen.findByRole('button', { name: "Reset to my role's default" }));
    await screen.findByText('Open Leads');
    release();

    await waitFor(() => expect(reads.dashboard).toBe(2));
    expect(await screen.findByText('7')).toBeInTheDocument();
    expect(stillLoading()).toBe(0);
  });

  it('reads again after Customize adds a tile (the picker is offered once the first read has answered)', async () => {
    serveDashboard(partial, JOBS_ONLY, JOBS_ONLY);
    const { reads, release } = holdFirstDashboardRead(partial, full);
    renderWithProviders(<DashboardPage />, { ability: ADMIN });

    await screen.findByText('Jobs Today');
    release();
    fireEvent.click(screen.getByRole('button', { name: /Customize home page/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add Open Leads' }));

    await waitFor(() => expect(reads.dashboard).toBe(2));
    expect(await screen.findByText('7')).toBeInTheDocument();
    expect(stillLoading()).toBe(0);
  });
});

describe('a tile added from Customize while the save is still on its way', () => {
  it('reads the dashboard again only after the save has answered, so the server builds the tile from the saved layout', async () => {
    const server = serveDashboard(partial, JOBS_ONLY, JOBS_ONLY);
    // The real server builds the home read from the SAVED layout row: the tile has figures only once the save committed.
    const served = mockApi.get.getMockImplementation()! as (...a: unknown[]) => Promise<unknown>;
    const reads = { dashboard: 0 };
    mockApi.get.mockImplementation(((url: string, ...rest: unknown[]) => {
      if (url !== '/api/dashboard') return served(url, ...rest);
      reads.dashboard += 1;
      const savedShows = server.layout.some((e) => e.id === 'kpi.open_leads' && e.visible);
      return Promise.resolve({ data: savedShows ? full : partial });
    }) as never);
    // The save commits 80 ms after it is sent, as a slow network would.
    const put = mockApi.put.getMockImplementation()! as (...a: unknown[]) => Promise<unknown>;
    mockApi.put.mockImplementation(((...a: unknown[]) => new Promise((resolve) => { setTimeout(() => resolve(put(...a)), 80); })) as never);
    renderWithProviders(<DashboardPage />, { ability: ADMIN });

    await screen.findByText('Jobs Today');
    fireEvent.click(screen.getByRole('button', { name: /Customize home page/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add Open Leads' }));

    expect(await screen.findByText('7')).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load Open Leads.")).not.toBeInTheDocument();
    await waitFor(() => expect(stillLoading()).toBe(0));
    expect(reads.dashboard).toBe(2);
  });
});

describe('a tile that goes missing again after its figures were fetched', () => {
  it('shows a loading placeholder, not "Couldn\'t load", while the second catch-up read is out', async () => {
    serveDashboard(full, BOTH, BOTH);
    const served = mockApi.get.getMockImplementation()! as (...a: unknown[]) => Promise<unknown>;
    // Read 1 lacks the tile, read 2 (the catch-up) brings it, read 3 (the catch-up after the figures were dropped) is held.
    const reads = { dashboard: 0 };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mockApi.get.mockImplementation(((url: string, ...rest: unknown[]) => {
      if (url !== '/api/dashboard') return served(url, ...rest);
      reads.dashboard += 1;
      if (reads.dashboard === 1) return Promise.resolve({ data: partial });
      if (reads.dashboard === 2) return Promise.resolve({ data: full });
      return gate.then(() => ({ data: full }));
    }) as never);
    const { queryClient } = renderWithProviders(<DashboardPage />, { ability: ADMIN });

    expect(await screen.findByText('7')).toBeInTheDocument();
    await waitFor(() => expect(stillLoading()).toBe(0));

    // A later read drops the tile's figures again; the page asks for them once more and says it is loading meanwhile.
    queryClient.setQueryData(['dashboard', {}], partial);
    await waitFor(() => expect(reads.dashboard).toBe(3));
    expect(screen.queryByText("Couldn't load Open Leads.")).not.toBeInTheDocument();
    expect(screen.queryByText('7')).not.toBeInTheDocument();

    release();
    expect(await screen.findByText('7')).toBeInTheDocument();
    expect(stillLoading()).toBe(0);
  });
});

describe('a tile whose figures are legitimately absent', () => {
  it('ends as "Couldn\'t load", reads again once for the layout and never loops', async () => {
    serveDashboard(partial, BOTH, BOTH);
    const reads = { dashboard: 0 };
    const served = mockApi.get.getMockImplementation()! as (...a: unknown[]) => Promise<unknown>;
    mockApi.get.mockImplementation(((url: string, ...rest: unknown[]) => {
      if (url !== '/api/dashboard') return served(url, ...rest);
      reads.dashboard += 1;
      return Promise.resolve({ data: partial });
    }) as never);
    renderWithProviders(<DashboardPage />, { ability: ADMIN });

    expect(await screen.findByText("Couldn't load Open Leads.")).toBeInTheDocument();
    expect(stillLoading()).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(reads.dashboard).toBe(2);
  });
});
