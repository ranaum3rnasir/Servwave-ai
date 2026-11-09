/// <reference types="@testing-library/jest-dom/vitest" />
import { StrictMode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import type { DashboardResponse, DashboardTileMeta } from '@/lib/api/dashboard';
import { serveDashboard, renderDashboard, type DashboardRoute } from '@/__tests__/harness/dashboardPage';
import { useAuthStore } from '@/stores/auth.store';

vi.hoisted(() => {
  vi.stubEnv('VITE_DASHBOARD_USE_MOCK', 'false');
});

// Each source used to be a file of its own, so each started from the setup file's signed-in user and bare client calls.
// `clearAllMocks` keeps implementations: reset them here, so a block states its own user and answers in its own `beforeEach`.
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAuthStore).mockReset();
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockReset();
  vi.mocked(api.patch).mockReset();
  vi.mocked(api.put).mockReset();
  vi.mocked(api.delete).mockReset();
});

describe('dashboardCarryOver', () => {
  /**
   * Roles & Permissions S09.5 - the routed dashboard carries a layout this browser kept over to the server, once.
   *
   * The page is the routed one (pages/v2/dashboard/DashboardPage). The server is a small fake behind the mocked axios
   * (`serveDashboard`): `GET /api/dashboard/layout` says whether a layout is saved (`saved`), and
   * `POST /api/dashboard/layout/carry-over` stores one only when none is. The browser copy is a real old-shape value
   * under the key the page always used: `alpha:dashboard-layout:v1:<person id>`.
   */

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
      renderDashboard({ ability: ADMIN });

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
      renderDashboard({ ability: ADMIN });

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
      const first = renderDashboard({ ability: ADMIN });
      await screen.findByText('Open Leads');
      first.unmount();

      // Another device: a fresh browser holding a different, older layout of its own. The server's layout wins.
      localStorage.clear();
      localStorage.setItem(keyOf(ME), JSON.stringify([{ id: 'kpi.jobs_today', visible: true }]));
      renderDashboard({ ability: ADMIN });
      await screen.findByText('Open Leads');
      openCustomize();
      expect(titlesOnPage()).toEqual(['Open Leads', 'Jobs This Week']);
      expect(server.carryOvers).toHaveLength(1);
      expect(localStorage.getItem(keyOf(ME))).not.toBeNull();
    });

    it('keeps saving ordinary edits afterwards, and a reset to the role default does not bring the carry-over back', async () => {
      localStorage.setItem(keyOf(ME), JSON.stringify(BROWSER_LAYOUT));
      const server = serveDashboard(answer, ROLE_DEFAULT, ROLE_DEFAULT, { saved: false });
      const first = renderDashboard({ ability: ADMIN });
      await screen.findByText('Open Leads');
      openCustomize();
      fireEvent.click(await screen.findByRole('button', { name: "Reset to my role's default" }));
      await waitFor(() => expect(server.resets).toBe(1));
      await waitFor(() => expect(titlesOnPage()).toEqual(['Jobs Today', 'Jobs This Week']));
      first.unmount();

      // Even if this browser still held its old copy, a layout is saved on the server, so it is not read or sent.
      localStorage.setItem(keyOf(ME), JSON.stringify(BROWSER_LAYOUT));
      renderDashboard({ ability: ADMIN });
      await screen.findByText('Jobs Today');
      expect(server.carryOvers).toHaveLength(1);
      // The two posts of the whole story are the one carry-over and the one reset; the old copy is never sent again.
      expect(mockApi.post.mock.calls.map(([url]) => url)).toEqual([CARRY_OVER, '/api/dashboard/layout/reset']);
    });

    it('sends it once when the page is opened twice at the same moment', async () => {
      localStorage.setItem(keyOf(ME), JSON.stringify(BROWSER_LAYOUT));
      const server = serveDashboard(answer, ROLE_DEFAULT, ROLE_DEFAULT, { saved: false });
      renderDashboard({ ability: ADMIN, wrap: (page) => <StrictMode>{page}</StrictMode> });
      await screen.findByText('Open Leads');
      expect(server.carryOvers).toHaveLength(1);
    });

    it('carries over a layout kept before the later tiles existed, as it was, without adding to it', async () => {
      localStorage.setItem(keyOf(ME), JSON.stringify([{ id: 'kpi.jobs_week', visible: true, range: 'month' }]));
      const server = serveDashboard(answer, ROLE_DEFAULT, ROLE_DEFAULT, { saved: false });
      renderDashboard({ ability: ADMIN });
      await screen.findByText('Jobs This Week');
      expect(server.carryOvers).toEqual([[{ id: 'kpi.jobs_week', visible: true, range: 'month' }]]);
    });
  });

  describe('a person with nothing worth carrying over', () => {
    it('gets their role\'s default and sends nothing when the browser kept no layout', async () => {
      const server = serveDashboard(answer, ROLE_DEFAULT, ROLE_DEFAULT, { saved: false });
      renderDashboard({ ability: ADMIN });

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
      renderDashboard({ ability: ADMIN });

      await screen.findByText('Jobs This Week');
      openCustomize();
      expect(titlesOnPage()).toEqual(['Jobs Today', 'Jobs This Week']);
      expect(mockApi.post).not.toHaveBeenCalled();
    });

    it('never carries one person\'s browser layout to another who signs in on the same browser', async () => {
      localStorage.setItem(keyOf(SOMEONE_ELSE), JSON.stringify(BROWSER_LAYOUT));
      serveDashboard(answer, ROLE_DEFAULT, ROLE_DEFAULT, { saved: false });
      renderDashboard({ ability: ADMIN });

      await screen.findByText('Jobs This Week');
      expect(mockApi.post).not.toHaveBeenCalled();
      expect(localStorage.getItem(keyOf(SOMEONE_ELSE))).not.toBeNull();
    });

    it('still draws the role default when browser storage cannot be read', async () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new DOMException('denied', 'SecurityError');
      });
      serveDashboard(answer, ROLE_DEFAULT, ROLE_DEFAULT, { saved: false });
      renderDashboard({ ability: ADMIN });

      await screen.findByText('Jobs This Week');
      expect(mockApi.post).not.toHaveBeenCalled();
    });
  });

  describe('a person who already has a layout on the server', () => {
    it('never reads the browser copy again: nothing is sent and the copy is left as it is', async () => {
      localStorage.setItem(keyOf(ME), JSON.stringify(BROWSER_LAYOUT));
      const getItem = vi.spyOn(Storage.prototype, 'getItem');
      serveDashboard(answer, [{ id: 'kpi.jobs_week', visible: true }], ROLE_DEFAULT, { saved: true });
      renderDashboard({ ability: ADMIN });

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
      const server = serveDashboard(answer, ROLE_DEFAULT, ROLE_DEFAULT, {
        saved: false,
        routes: [{ match: (url) => url === '/api/dashboard/layout', data: () => { throw new Error('Network Error'); } }],
      });
      renderDashboard({ ability: ADMIN });

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
      renderDashboard({ ability: ADMIN });

      await screen.findByText('Jobs This Week');
      openCustomize();
      expect(titlesOnPage()).toEqual(['Jobs Today', 'Jobs This Week']);
      expect(mockApi.post).toHaveBeenCalledTimes(1);
    });

    it('draws the role default and keeps the browser copy when the carry-over fails, without trying again at once', async () => {
      localStorage.setItem(keyOf(ME), JSON.stringify(BROWSER_LAYOUT));
      serveDashboard(answer, ROLE_DEFAULT, ROLE_DEFAULT, { saved: false });
      mockApi.post.mockRejectedValue(new Error('Request failed with status code 500'));
      renderDashboard({ ability: ADMIN });

      await screen.findByText('Jobs This Week');
      openCustomize();
      expect(titlesOnPage()).toEqual(['Jobs Today', 'Jobs This Week']);
      expect(mockApi.post).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem(keyOf(ME))).not.toBeNull();
    });
  });
});

describe('dashboardCatchUp', () => {
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
   * (built from the layout as it was when the read was sent); every later read answers with `later`. `route` is handed
   * to the fake server.
   */
  function holdFirstDashboardRead(first: DashboardResponse, later: DashboardResponse) {
    const reads = { dashboard: 0 };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const route: DashboardRoute = {
      match: (url) => url === '/api/dashboard',
      data: () => {
        reads.dashboard += 1;
        return reads.dashboard === 1 ? gate.then(() => first) : later;
      },
    };
    return { reads, release, route };
  }

  const stillLoading = () => document.querySelectorAll('[aria-busy="true"]').length;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  describe('a dashboard read still on its way when the layout changes under it', () => {
    it('reads again after the one-time carry-over lands before the first read answers, and draws the carried tile', async () => {
      localStorage.setItem(`alpha:dashboard-layout:v1:${ME}`, JSON.stringify(BOTH));
      const { reads, release, route } = holdFirstDashboardRead(partial, full);
      const server = serveDashboard(partial, JOBS_ONLY, JOBS_ONLY, { saved: false, routes: [route] });
      renderDashboard({ ability: ADMIN });

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
      const { reads, release, route } = holdFirstDashboardRead(partial, full);
      const server = serveDashboard(partial, BOTH, BOTH, { routes: [route] });
      expect(server.saved).toBe(true);
      renderDashboard({ ability: ADMIN });

      await screen.findByText('Open Leads');
      release();
      await waitFor(() => expect(reads.dashboard).toBe(2));
      expect(await screen.findByText('7')).toBeInTheDocument();
      expect(stillLoading()).toBe(0);
    });

    it('reads again after Reset when it lands while a read is still out', async () => {
      const { reads, release, route } = holdFirstDashboardRead(partial, full);
      serveDashboard(partial, JOBS_ONLY, BOTH, { routes: [route] });
      renderDashboard({ ability: ADMIN });

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
      const { reads, release, route } = holdFirstDashboardRead(partial, full);
      serveDashboard(partial, JOBS_ONLY, JOBS_ONLY, { routes: [route] });
      renderDashboard({ ability: ADMIN });

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
      // The real server builds the home read from the SAVED layout row: the tile has figures only once the save committed.
      const reads = { dashboard: 0 };
      const server = serveDashboard(partial, JOBS_ONLY, JOBS_ONLY, {
        routes: [{
          match: (url) => url === '/api/dashboard',
          data: () => {
            reads.dashboard += 1;
            const savedShows = server.layout.some((e) => e.id === 'kpi.open_leads' && e.visible);
            return savedShows ? full : partial;
          },
        }],
      });
      // The save commits 80 ms after it is sent, as a slow network would.
      const put = mockApi.put.getMockImplementation()! as (...a: unknown[]) => Promise<unknown>;
      mockApi.put.mockImplementation(((...a: unknown[]) => new Promise((resolve) => { setTimeout(() => resolve(put(...a)), 80); })) as never);
      renderDashboard({ ability: ADMIN });

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
      // Read 1 lacks the tile, read 2 (the catch-up) brings it, read 3 (the catch-up after the figures were dropped) is held.
      const reads = { dashboard: 0 };
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      serveDashboard(full, BOTH, BOTH, {
        routes: [{
          match: (url) => url === '/api/dashboard',
          data: () => {
            reads.dashboard += 1;
            if (reads.dashboard === 1) return partial;
            if (reads.dashboard === 2) return full;
            return gate.then(() => full);
          },
        }],
      });
      const { queryClient } = renderDashboard({ ability: ADMIN });

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
      const reads = { dashboard: 0 };
      serveDashboard(partial, BOTH, BOTH, {
        routes: [{ match: (url) => url === '/api/dashboard', data: () => { reads.dashboard += 1; return partial; } }],
      });
      renderDashboard({ ability: ADMIN });

      expect(await screen.findByText("Couldn't load Open Leads.")).toBeInTheDocument();
      expect(stillLoading()).toBe(0);
      // The layout read is the second one; wait for it, then give a would-be loop one short tick to ask a third time.
      await waitFor(() => expect(reads.dashboard).toBe(2));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(reads.dashboard).toBe(2);
    });
  });
});

describe('dashboardRefreshAfterLayoutChange', () => {
  /**
   * Roles & Permissions S09.1 fix - the home page's read computes only the tiles the layout shows. A layout change that
   * shows a tile the cached answer holds no figures for (Reset to the role's default, the one-time carry-over of a
   * browser layout) must read the dashboard again, not leave that tile waiting until the next scheduled read.
   *
   * The page is the routed one (pages/v2/dashboard/DashboardPage). The fake server answers the first dashboard read with
   * figures for Jobs Today only, and every later read with all tiles' figures.
   */

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
  function serveWithPartialFirstRead(...[body, layout, roleDefault, options]: Parameters<typeof serveDashboard>) {
    const reads = { dashboard: 0 };
    const server = serveDashboard(body, layout, roleDefault, {
      ...options,
      routes: [{ match: (url) => url === '/api/dashboard', data: () => { reads.dashboard += 1; return reads.dashboard === 1 ? partial : full; } }],
    });
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
      renderDashboard({ ability: ADMIN });
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
      renderDashboard({ ability: ADMIN });

      await waitFor(() => expect(server.carryOvers).toHaveLength(1));
      await waitFor(() => expect(reads.dashboard).toBeGreaterThanOrEqual(2));
      expect(await screen.findByText('Open Leads')).toBeInTheDocument();
      await waitFor(() => expect(screen.getByText('7')).toBeInTheDocument());
      expect(loadingTiles()).toBe(0);
    });
  });
});
