/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * Roles & Permissions S09.5 - the routed dashboard carries a layout this browser kept over to the server, once.
 *
 * The page is the routed one (pages/v2/dashboard/DashboardPage). The server is a small fake behind the mocked axios
 * (`serveDashboard`): `GET /api/dashboard/layout` says whether a layout is saved (`saved`), and
 * `POST /api/dashboard/layout/carry-over` stores one only when none is. The browser copy is a real old-shape value
 * under the key the page always used: `alpha:dashboard-layout:v1:<person id>`.
 */
import { StrictMode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';

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
const SOMEONE_ELSE = '00000000-0000-0000-0000-000000000002';
const keyOf = (userId: string) => `alpha:dashboard-layout:v1:${userId}`;
const CARRY_OVER = '/api/dashboard/layout/carry-over';

const meta = (id: string, category: DashboardTileMeta['category']): DashboardTileMeta => ({ id, category, mode: 'company', label: null, link: '/somewhere' });
const answer: DashboardResponse = {
  tiles: [meta('kpi.jobs_today', 'jobs'), meta('kpi.jobs_week', 'jobs'), meta('kpi.open_leads', 'leads'), meta('coming_up', 'jobs')],
  categories: [{ id: 'jobs', label: 'Jobs' }, { id: 'leads', label: 'Leads' }],
  data: {
    'kpi.jobs_today': { total: 3, scheduled: 2, in_progress: 1, completed: 0, vs_yesterday: 0 },
    'kpi.jobs_week': { completed: 1, scheduled: 4 },
    'kpi.open_leads': { count: 2, no_owner: 1 },
    coming_up: [],
  },
  generated_at: '2026-10-12T10:00:00.000Z',
};
const ROLE_DEFAULT = [{ id: 'kpi.jobs_today', visible: true }, { id: 'kpi.jobs_week', visible: true }];
/** What this browser kept: Open Leads first and large, Jobs Today hidden. */
const BROWSER_LAYOUT = [
  { id: 'kpi.open_leads', visible: true, size: 'full', range: '7d' },
  { id: 'kpi.jobs_today', visible: false },
  { id: 'kpi.jobs_week', visible: true },
];
const titlesOnPage = () => screen.getAllByRole('button', { name: /^Hide / }).map((b) => b.getAttribute('aria-label')!.replace(/^Hide /, ''));
const openCustomize = () => fireEvent.click(screen.getByRole('button', { name: /Customize home page/ }));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('a person with a browser layout and none on the server', () => {
  it('saves the browser layout to the server on first open, draws it, and stops keeping it in the browser', async () => {
    localStorage.setItem(keyOf(ME), JSON.stringify(BROWSER_LAYOUT));
    const server = serveDashboard(answer, ROLE_DEFAULT, ROLE_DEFAULT, { saved: false });
    renderWithProviders(<DashboardPage />, { ability: ADMIN });

    await screen.findByText('Open Leads');
    expect(server.carryOvers).toEqual([BROWSER_LAYOUT]);
    expect(mockApi.post).toHaveBeenCalledWith(CARRY_OVER, { layout: BROWSER_LAYOUT });
    openCustomize();
    expect(titlesOnPage()).toEqual(['Open Leads', 'Jobs This Week']);
    expect(localStorage.getItem(keyOf(ME))).toBeNull();
    // Carrying over is not an edit: the layout is not saved a second time.
    expect(server.saves).toEqual([]);
  });

  it('does not draw the role default first, nor let the layout be edited, until the carry-over has landed', async () => {
    localStorage.setItem(keyOf(ME), JSON.stringify(BROWSER_LAYOUT));
    const server = serveDashboard(answer, ROLE_DEFAULT, ROLE_DEFAULT, { saved: false });
    let landed!: () => void;
    const held = new Promise<void>((resolve) => { landed = resolve; });
    const post = mockApi.post.getMockImplementation()!;
    mockApi.post.mockImplementation(((...args: unknown[]) => held.then(() => (post as (...a: unknown[]) => unknown)(...args))) as never);
    renderWithProviders(<DashboardPage />, { ability: ADMIN });

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Jobs This Week')).not.toBeInTheDocument();
    expect(screen.queryByText('Jobs Today')).not.toBeInTheDocument();
    await act(async () => landed());
    expect(await screen.findByText('Open Leads')).toBeInTheDocument();
    expect(server.layout).toEqual(BROWSER_LAYOUT);
  });

  it('shows the same layout on another device afterwards, and never reads that device\'s own old copy again', async () => {
    localStorage.setItem(keyOf(ME), JSON.stringify(BROWSER_LAYOUT));
    const server = serveDashboard(answer, ROLE_DEFAULT, ROLE_DEFAULT, { saved: false });
    const first = renderWithProviders(<DashboardPage />, { ability: ADMIN });
    await screen.findByText('Open Leads');
    first.unmount();

    // Another device: a fresh browser holding a different, older layout of its own. The server's layout wins.
    localStorage.clear();
    localStorage.setItem(keyOf(ME), JSON.stringify([{ id: 'kpi.jobs_today', visible: true }]));
    renderWithProviders(<DashboardPage />, { ability: ADMIN });
    await screen.findByText('Open Leads');
    openCustomize();
    expect(titlesOnPage()).toEqual(['Open Leads', 'Jobs This Week']);
    expect(server.carryOvers).toHaveLength(1);
    expect(localStorage.getItem(keyOf(ME))).not.toBeNull();
  });

  it('keeps saving ordinary edits afterwards, and a reset to the role default does not bring the carry-over back', async () => {
    localStorage.setItem(keyOf(ME), JSON.stringify(BROWSER_LAYOUT));
    const server = serveDashboard(answer, ROLE_DEFAULT, ROLE_DEFAULT, { saved: false });
    const first = renderWithProviders(<DashboardPage />, { ability: ADMIN });
    await screen.findByText('Open Leads');
    openCustomize();
    fireEvent.click(await screen.findByRole('button', { name: "Reset to my role's default" }));
    await waitFor(() => expect(server.resets).toBe(1));
    await waitFor(() => expect(titlesOnPage()).toEqual(['Jobs Today', 'Jobs This Week']));
    first.unmount();

    // Even if this browser still held its old copy, a layout is saved on the server, so it is not read or sent.
    localStorage.setItem(keyOf(ME), JSON.stringify(BROWSER_LAYOUT));
    renderWithProviders(<DashboardPage />, { ability: ADMIN });
    await screen.findByText('Jobs Today');
    expect(server.carryOvers).toHaveLength(1);
    // The two posts of the whole story are the one carry-over and the one reset; the old copy is never sent again.
    expect(mockApi.post.mock.calls.map(([url]) => url)).toEqual([CARRY_OVER, '/api/dashboard/layout/reset']);
  });

  it('sends it once when the page is opened twice at the same moment', async () => {
    localStorage.setItem(keyOf(ME), JSON.stringify(BROWSER_LAYOUT));
    const server = serveDashboard(answer, ROLE_DEFAULT, ROLE_DEFAULT, { saved: false });
    renderWithProviders(<StrictMode><DashboardPage /></StrictMode>, { ability: ADMIN });
    await screen.findByText('Open Leads');
    expect(server.carryOvers).toHaveLength(1);
  });

  it('carries over a layout kept before the later tiles existed, as it was, without adding to it', async () => {
    localStorage.setItem(keyOf(ME), JSON.stringify([{ id: 'kpi.jobs_week', visible: true, range: 'month' }]));
    const server = serveDashboard(answer, ROLE_DEFAULT, ROLE_DEFAULT, { saved: false });
    renderWithProviders(<DashboardPage />, { ability: ADMIN });
    await screen.findByText('Jobs This Week');
    expect(server.carryOvers).toEqual([[{ id: 'kpi.jobs_week', visible: true, range: 'month' }]]);
  });
});

describe('a person with nothing worth carrying over', () => {
  it('gets their role\'s default and sends nothing when the browser kept no layout', async () => {
    const server = serveDashboard(answer, ROLE_DEFAULT, ROLE_DEFAULT, { saved: false });
    renderWithProviders(<DashboardPage />, { ability: ADMIN });

    await screen.findByText('Jobs This Week');
    openCustomize();
    expect(titlesOnPage()).toEqual(['Jobs Today', 'Jobs This Week']);
    expect(mockApi.post).not.toHaveBeenCalled();
    expect(server.saves).toEqual([]);
  });

  it.each([
    ['text that is not JSON', '[{"id": "kpi.open_le'],
    ['an object, not a list', '{"id":"kpi.open_leads","visible":true}'],
    ['a list with no usable entry', '[{"id":"kpi.open_leads"},7,null]'],
  ])('falls back to the role default, without a crash and without sending anything, for a browser copy that is %s', async (_name, raw) => {
    localStorage.setItem(keyOf(ME), raw);
    serveDashboard(answer, ROLE_DEFAULT, ROLE_DEFAULT, { saved: false });
    renderWithProviders(<DashboardPage />, { ability: ADMIN });

    await screen.findByText('Jobs This Week');
    openCustomize();
    expect(titlesOnPage()).toEqual(['Jobs Today', 'Jobs This Week']);
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it('never carries one person\'s browser layout to another who signs in on the same browser', async () => {
    localStorage.setItem(keyOf(SOMEONE_ELSE), JSON.stringify(BROWSER_LAYOUT));
    serveDashboard(answer, ROLE_DEFAULT, ROLE_DEFAULT, { saved: false });
    renderWithProviders(<DashboardPage />, { ability: ADMIN });

    await screen.findByText('Jobs This Week');
    expect(mockApi.post).not.toHaveBeenCalled();
    expect(localStorage.getItem(keyOf(SOMEONE_ELSE))).not.toBeNull();
  });

  it('still draws the role default when browser storage cannot be read', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    serveDashboard(answer, ROLE_DEFAULT, ROLE_DEFAULT, { saved: false });
    renderWithProviders(<DashboardPage />, { ability: ADMIN });

    await screen.findByText('Jobs This Week');
    expect(mockApi.post).not.toHaveBeenCalled();
  });
});

describe('a person who already has a layout on the server', () => {
  it('never reads the browser copy again: nothing is sent and the copy is left as it is', async () => {
    localStorage.setItem(keyOf(ME), JSON.stringify(BROWSER_LAYOUT));
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    serveDashboard(answer, [{ id: 'kpi.jobs_week', visible: true }], ROLE_DEFAULT, { saved: true });
    renderWithProviders(<DashboardPage />, { ability: ADMIN });

    await screen.findByText('Jobs This Week');
    openCustomize();
    expect(titlesOnPage()).toEqual(['Jobs This Week']);
    expect(mockApi.post).not.toHaveBeenCalled();
    expect(getItem.mock.calls.map(([k]) => k)).not.toContain(keyOf(ME));
    expect(localStorage.getItem(keyOf(ME))).not.toBeNull();
  });
});

describe('when something goes wrong', () => {
  it('carries nothing over and saves nothing while the layout cannot be read', async () => {
    localStorage.setItem(keyOf(ME), JSON.stringify(BROWSER_LAYOUT));
    const server = serveDashboard(answer, ROLE_DEFAULT, ROLE_DEFAULT, { saved: false });
    const read = mockApi.get.getMockImplementation()!;
    mockApi.get.mockImplementation(((url: string) =>
      url === '/api/dashboard/layout' ? Promise.reject(new Error('Network Error')) : (read as (u: string) => unknown)(url)) as never);
    renderWithProviders(<DashboardPage />, { ability: ADMIN });

    await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/api/dashboard/layout'));
    await screen.findByText(/Customize home page/);
    expect(mockApi.post).not.toHaveBeenCalled();
    expect(mockApi.put).not.toHaveBeenCalled();
    expect(server.carryOvers).toEqual([]);
    expect(localStorage.getItem(keyOf(ME))).not.toBeNull();
  });

  it('draws the role default, and does not wait or send again, when the server found nothing usable in the browser copy', async () => {
    localStorage.setItem(keyOf(ME), JSON.stringify([{ id: 'tile.retired.long.ago', visible: true }]));
    serveDashboard(answer, ROLE_DEFAULT, ROLE_DEFAULT, { saved: false });
    // The server drops tiles it does not know, finds none left, stores nothing and says so.
    mockApi.post.mockResolvedValue({ data: { layout: ROLE_DEFAULT, saved: false } });
    renderWithProviders(<DashboardPage />, { ability: ADMIN });

    await screen.findByText('Jobs This Week');
    openCustomize();
    expect(titlesOnPage()).toEqual(['Jobs Today', 'Jobs This Week']);
    expect(mockApi.post).toHaveBeenCalledTimes(1);
  });

  it('draws the role default and keeps the browser copy when the carry-over fails, without trying again at once', async () => {
    localStorage.setItem(keyOf(ME), JSON.stringify(BROWSER_LAYOUT));
    serveDashboard(answer, ROLE_DEFAULT, ROLE_DEFAULT, { saved: false });
    mockApi.post.mockRejectedValue(new Error('Request failed with status code 500'));
    renderWithProviders(<DashboardPage />, { ability: ADMIN });

    await screen.findByText('Jobs This Week');
    openCustomize();
    expect(titlesOnPage()).toEqual(['Jobs Today', 'Jobs This Week']);
    expect(mockApi.post).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(keyOf(ME))).not.toBeNull();
  });
});
