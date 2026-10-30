/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * Roles & Permissions PRD 9, scenario pass 2 - the home page tells "the answer is zero" from "no answer".
 *
 * When GET /api/dashboard fails, or the server marks one tile as one it could not build, the tile says so in one plain
 * line with a way to try again. It never draws the zero a figure falls back to ("Close Rate 0%", "Open Leads 0"), which
 * reads as data. A real answer of zero (S09.2's plain lines) is untouched.
 *
 * The page is the routed one (pages/v2/dashboard/DashboardPage).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import type { DashboardResponse, DashboardTileMeta } from '@/lib/api/dashboard';
import { renderWithProviders, serveDashboard } from '@/__tests__/helpers';
import { emulateDevice, DESKTOP, TABLET } from '@/__tests__/support/deviceShape';
import DashboardPage from '../DashboardPage';

vi.hoisted(() => {
  vi.stubEnv('VITE_DASHBOARD_USE_MOCK', 'false');
});

const mockApi = vi.mocked(api);
const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);

const meta = (id: string): DashboardTileMeta => ({ id, category: 'leads', mode: 'company', label: null, link: '/somewhere' });
const LAYOUT = [{ id: 'kpi.close_rate', visible: true }, { id: 'kpi.open_leads', visible: true }];

const answer = (data: Record<string, unknown>, ids = ['kpi.close_rate', 'kpi.open_leads']): DashboardResponse => ({
  tiles: ids.map(meta),
  categories: [{ id: 'leads', label: 'Leads' }],
  data: data as DashboardResponse['data'],
  generated_at: '2026-10-12T10:00:00.000Z',
});
const GOOD = { 'kpi.close_rate': { rate: 100, won: 5, lost: 0, vs_last_period_pp: 0 }, 'kpi.open_leads': { count: 5, no_owner: 0 } };

/** Serves the layout as usual and makes the dashboard read fail until the test lets it through. */
function dashboardFails() {
  serveDashboard(answer(GOOD), LAYOUT);
  const served = mockApi.get.getMockImplementation()! as (...a: unknown[]) => Promise<unknown>;
  const state = { failing: true, reads: 0 };
  mockApi.get.mockImplementation(((url: string, ...rest: unknown[]) => {
    if (url !== '/api/dashboard') return served(url, ...rest);
    state.reads += 1;
    return state.failing ? Promise.reject(new Error('Request failed with status code 500')) : served(url, ...rest);
  }) as never);
  return state;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('when the dashboard read fails', () => {
  it('says each tile could not be loaded, with a retry, and draws no zero', async () => {
    dashboardFails();
    renderWithProviders(<DashboardPage />, { ability: ADMIN });

    expect(await screen.findByText("Couldn't load Close Rate.")).toBeInTheDocument();
    expect(screen.getByText("Couldn't load Open Leads.")).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(2);
    // None of what the tiles draw from an empty answer.
    expect(screen.queryByText(/0%/)).not.toBeInTheDocument();
    expect(screen.queryByText(/0 won/)).not.toBeInTheDocument();
    expect(screen.queryByText(/with no owner/)).not.toBeInTheDocument();
    expect(screen.queryByText('No open leads')).not.toBeInTheDocument();
  });

  it('reads again on Retry and draws the real figures when it answers', async () => {
    const state = dashboardFails();
    renderWithProviders(<DashboardPage />, { ability: ADMIN });
    const retry = (await screen.findAllByRole('button', { name: 'Retry' }))[0]!;

    state.failing = false;
    fireEvent.click(retry);

    expect(await screen.findByText('100%')).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load Close Rate.")).not.toBeInTheDocument();
    expect(state.reads).toBeGreaterThan(1);
  });
});

describe('when the server marks one tile as one it could not build', () => {
  it('says so on that tile only, and draws the others from their answers', async () => {
    serveDashboard(answer({ ...GOOD, 'kpi.close_rate': { error: true } }), LAYOUT);
    renderWithProviders(<DashboardPage />, { ability: ADMIN });

    expect(await screen.findByText("Couldn't load Close Rate.")).toBeInTheDocument();
    expect(await screen.findByText('Open Leads')).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load Open Leads.")).not.toBeInTheDocument();
    expect(screen.queryByText(/0%/)).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
  });

  it('keeps the plain empty line for a real answer of zero', async () => {
    serveDashboard(answer({ ...GOOD, 'kpi.open_leads': { count: 0, no_owner: 0 } }), LAYOUT);
    renderWithProviders(<DashboardPage />, { ability: ADMIN });

    expect(await screen.findByText('No open leads')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });
});

describe('the home page asks only for what it shows', () => {
  it('sends the home-page read, so the server computes the shown tiles only', async () => {
    serveDashboard(answer(GOOD), LAYOUT);
    renderWithProviders(<DashboardPage />, { ability: ADMIN });
    await screen.findByText('Open Leads');
    const read = mockApi.get.mock.calls.find((c) => c[0] === '/api/dashboard');
    expect(read?.[1]).toMatchObject({ params: { shown: 1 } });
  });

  it('reads the dashboard again when a tile with no figures yet is added from the picker, and shows it as loading meanwhile', async () => {
    // The picker offers kpi.jobs_week (eligible) but the first answer holds no figures for it: it was not on the page.
    serveDashboard(answer(GOOD, ['kpi.close_rate', 'kpi.open_leads', 'kpi.jobs_week']), LAYOUT);
    renderWithProviders(<DashboardPage />, { ability: ADMIN });
    await screen.findByText('Open Leads');
    const reads = () => mockApi.get.mock.calls.filter((c) => c[0] === '/api/dashboard').length;
    const before = reads();

    fireEvent.click(await screen.findByRole('button', { name: /Customize home page/ }));
    fireEvent.click(await screen.findByRole('button', { name: /^Add Jobs This Week$/ }));

    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    // Never a zero for a tile whose figures have not arrived.
    expect(screen.queryByText('No jobs this week')).not.toBeInTheDocument();
  });
});

describe('the edit banner only promises what the device has', () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());

  const bannerOn = async () => {
    serveDashboard(answer(GOOD), LAYOUT);
    renderWithProviders(<DashboardPage />, { ability: ADMIN });
    fireEvent.click(await screen.findByRole('button', { name: /Customize home page/ }));
    return screen.findByText(/^Edit mode/);
  };

  it('says drag where there are no arrows (a mouse)', async () => {
    restore = emulateDevice(DESKTOP);
    const banner = await bannerOn();
    expect(banner).toHaveTextContent('drag to reorder');
    expect(banner).not.toHaveTextContent(/arrows/);
  });

  it('says drag or use the arrows where the arrows are shown (a touch screen wider than a phone)', async () => {
    restore = emulateDevice({ ...TABLET, viewportWidth: 1100 });
    const banner = await bannerOn();
    expect(within(banner.parentElement!).getByText(/drag or use the arrows to reorder/)).toBeInTheDocument();
  });
});
