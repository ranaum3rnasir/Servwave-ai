/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen, waitFor, within, act } from '@testing-library/react';
import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import type { DashboardResponse, DashboardTileMeta } from '@/lib/api/dashboard';
import { serveDashboard, renderDashboard } from '@/__tests__/harness/dashboardPage';
import { emulateDevice, DESKTOP, TABLET } from '@/__tests__/support/deviceShape';
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

describe('dashboardLoadFailure', () => {
  /**
   * Roles & Permissions PRD 9, scenario pass 2 - the home page tells "the answer is zero" from "no answer".
   *
   * When GET /api/dashboard fails, or the server marks one tile as one it could not build, the tile says so in one plain
   * line with a way to try again. It never draws the zero a figure falls back to ("Close Rate 0%", "Open Leads 0"), which
   * reads as data. A real answer of zero (S09.2's plain lines) is untouched.
   *
   * The page is the routed one (pages/v2/dashboard/DashboardPage).
   */

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
    const state = { failing: true, reads: 0 };
    const server = serveDashboard(answer(GOOD), LAYOUT, undefined, {
      routes: [{
        match: (url) => url === '/api/dashboard',
        data: (url: string) => {
          state.reads += 1;
          if (state.failing) throw new Error('Request failed with status code 500');
          return server.read(url);
        },
      }],
    });
    return state;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  describe('when the dashboard read fails', () => {
    it('says each tile could not be loaded, with a retry, and draws no zero', async () => {
      dashboardFails();
      renderDashboard({ ability: ADMIN });

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
      renderDashboard({ ability: ADMIN });
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
      renderDashboard({ ability: ADMIN });

      expect(await screen.findByText("Couldn't load Close Rate.")).toBeInTheDocument();
      expect(await screen.findByText('Open Leads')).toBeInTheDocument();
      expect(screen.queryByText("Couldn't load Open Leads.")).not.toBeInTheDocument();
      expect(screen.queryByText(/0%/)).not.toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
    });

    it('keeps the plain empty line for a real answer of zero', async () => {
      serveDashboard(answer({ ...GOOD, 'kpi.open_leads': { count: 0, no_owner: 0 } }), LAYOUT);
      renderDashboard({ ability: ADMIN });

      expect(await screen.findByText('No open leads')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    });
  });

  describe('the home page asks only for what it shows', () => {
    it('sends the home-page read, so the server computes the shown tiles only', async () => {
      serveDashboard(answer(GOOD), LAYOUT);
      renderDashboard({ ability: ADMIN });
      await screen.findByText('Open Leads');
      const read = mockApi.get.mock.calls.find((c) => c[0] === '/api/dashboard');
      expect(read?.[1]).toMatchObject({ params: { shown: 1 } });
    });

    it('reads the dashboard again when a tile with no figures yet is added from the picker, and shows it as loading meanwhile', async () => {
      // The picker offers kpi.jobs_week (eligible) but the first answer holds no figures for it: it was not on the page.
      serveDashboard(answer(GOOD, ['kpi.close_rate', 'kpi.open_leads', 'kpi.jobs_week']), LAYOUT);
      renderDashboard({ ability: ADMIN });
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
      renderDashboard({ ability: ADMIN });
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
});

describe('dashboardLoadingState', () => {
  /**
   * Roles & Permissions S09.4 follow-up - while the server's layout is being read the routed dashboard draws plain
   * loading placeholders (it knows no tile yet, so it names none), then the person's tiles; a failed read leaves no
   * placeholder waiting for ever.
   */

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
    let release!: (ok: boolean) => void;
    const gate = new Promise<boolean>((resolve) => { release = resolve; });
    const server = serveDashboard(answer, [{ id: 'kpi.open_leads', visible: true }], undefined, {
      routes: [{
        match: (url) => url === '/api/dashboard/layout',
        data: (url: string) => gate.then((ok) => { if (!ok) throw new Error('Network Error'); return server.read(url); }),
      }],
    });
    return release;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  describe('the dashboard while its layout is read', () => {
    it('draws loading placeholders and no tile until the layout answers', async () => {
      const release = holdLayoutRead();
      renderDashboard({ ability: ADMIN });

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
      renderDashboard({ ability: ADMIN });
      await screen.findByText('Loading your home page');

      release(false);
      await waitFor(() => expect(screen.queryByText('Loading your home page')).not.toBeInTheDocument());
      expect(screen.queryByText('Open Leads')).not.toBeInTheDocument();
    });
  });
});

describe('dashboardLayoutLoadFailure', () => {
  /**
   * Roles & Permissions, pass 2 re-check - a layout read that fails is not drawn as an empty page. The home page says it
   * could not load, with the same Retry a failed data read shows; Retry reads the layout again; and Customize is not
   * offered while the layout is unknown, because a save made over a layout the page never saw would wipe the person's
   * saved one.
   *
   * The page is the routed one (pages/v2/dashboard/DashboardPage).
   */

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
    const state = { failing: true, reads: 0 };
    const server = serveDashboard(answer, LAYOUT, undefined, {
      routes: [{
        match: (url) => url === '/api/dashboard/layout',
        data: (url: string) => {
          state.reads += 1;
          if (state.failing) throw new Error('Network Error');
          return server.read(url);
        },
      }],
    });
    return { server, state };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  describe('when the layout read fails', () => {
    it('says the home page could not be loaded, with a Retry, and offers no Customize', async () => {
      layoutReadFails();
      renderDashboard({ ability: ADMIN });

      expect(await screen.findByText("Couldn't load your home page.")).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Customize home page/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('status')).not.toBeInTheDocument(); // not left on its loading placeholders
    });

    it('reads the layout again on Retry and draws the tiles when it answers', async () => {
      const { state } = layoutReadFails();
      renderDashboard({ ability: ADMIN });
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
      renderDashboard({ ability: ADMIN });
      await screen.findByText("Couldn't load your home page.");

      expect(mockApi.put).not.toHaveBeenCalled();
      expect(mockApi.post).not.toHaveBeenCalled();
      expect(server.saves).toEqual([]);
      expect(localStorage.getItem(`alpha:dashboard-layout:v1:${ME}`)).not.toBeNull();
    });

    it('keeps drawing the layout it already has when a later read of it fails', async () => {
      let failing = false;
      serveDashboard(answer, LAYOUT, undefined, {
        routes: [{ match: (url) => url === '/api/dashboard/layout' && failing, data: () => { throw new Error('Network Error'); } }],
      });
      const { queryClient } = renderDashboard({ ability: ADMIN });
      await screen.findByText('Jobs Today');

      failing = true;
      await act(async () => { await queryClient.refetchQueries({ queryKey: ['dashboard-layout'] }); });
      expect(queryClient.getQueryState(['dashboard-layout', ME])?.status).toBe('error');
      expect(screen.getByText('Jobs Today')).toBeInTheDocument();
      expect(screen.queryByText("Couldn't load your home page.")).not.toBeInTheDocument();
    });
  });
});
