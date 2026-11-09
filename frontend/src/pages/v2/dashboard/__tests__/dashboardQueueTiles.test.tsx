/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { buildAbility } from '@/lib/ability';
import type { DashboardResponse, DashboardTileMeta } from '@/lib/api/dashboard';
import { serveDashboard, renderDashboard, serveNothing } from '@/__tests__/harness/dashboardPage';
import { useAuthStore } from '@/stores/auth.store';
import api from '@/lib/axios';

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

describe('dashboardMissingCrew', () => {
  /**
   * Roles & Permissions S09.13 - Missing crew on the routed home page: the tile (a count and the booked visit that starts
   * soonest with nobody on it) and the Needs Attention item "N visits with no crew" that replaced the line per visit.
   *
   * The page is the routed one (pages/v2/dashboard/DashboardPage), against the JSON shape GET /api/dashboard sends. The
   * addresses in these answers are invented ones, so a page that sent anyone somewhere it knew would fail.
   */

  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

  const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);
  const ID = 'missing_crew';

  const meta = (id: string, category: DashboardTileMeta['category'], link: string | null): DashboardTileMeta => ({ id, category, mode: 'company', label: null, link });
  const soonest = (over: Record<string, unknown> = {}) => ({
    id: 'job-1', kind: 'job', number: 'J-100', title: 'Customer One', starts_at: '2026-10-15T13:00:00.000Z', starts_label: 'Thu 9:00 AM', until: '3d', link: '/sent-job/1', ...over,
  });
  const answer = (link: string | null, data: Record<string, unknown>, tiles: DashboardTileMeta[] = [meta(ID, 'jobs', link)]): DashboardResponse => ({
    tiles,
    categories: [{ id: 'jobs', label: 'Jobs' }, { id: 'each_record', label: 'Across your records' }],
    data: data as DashboardResponse['data'],
    generated_at: '2026-10-12T10:00:00.000Z',
  });

  /** Shows where the page has been sent. */
  function Where() {
    return <p data-testid="where">{useLocation().pathname + useLocation().search}</p>;
  }
  const where = () => screen.getByTestId('where').textContent;

  /** The page of a person whose saved layout holds these tiles (as a Dispatcher's default holds Missing crew). */
  function open(body: DashboardResponse, shown: string[] = [ID]) {
    serveDashboard(body, shown.map((id) => ({ id, visible: true })));
    renderDashboard({ ability: ADMIN, beside: <Where /> });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  describe('the Missing crew tile', () => {
    it('shows how many booked visits have no crew and the soonest one with its number, customer, start and time until it', async () => {
      open(answer('/sent-schedule', { [ID]: { count: 4, soonest: soonest() } }));
      const tile = (await screen.findByRole('heading', { name: /Missing crew/ })).closest('[data-slot="card"]') as HTMLElement;
      expect(within(tile).getByText('4')).toBeInTheDocument();
      expect(within(tile).getByText('J-100')).toBeInTheDocument();
      expect(within(tile).getByText('Customer One')).toBeInTheDocument();
      expect(within(tile).getByText('Thu 9:00 AM')).toBeInTheDocument();
      expect(within(tile).getByText('in 3d')).toBeInTheDocument();
    });

    it('names a walkthrough as one, by its lead number', async () => {
      open(answer('/sent-schedule', { [ID]: { count: 1, soonest: soonest({ kind: 'lead', number: 'L-200', link: '/sent-lead/2', until: '5h' }) } }));
      expect(await screen.findByText('L-200')).toBeInTheDocument();
      expect(screen.getByText('Walkthrough · Thu 9:00 AM')).toBeInTheDocument();
      expect(screen.getByText('in 5h')).toBeInTheDocument();
    });

    it('opens the soonest record at the address the server sent', async () => {
      open(answer('/sent-schedule', { [ID]: { count: 1, soonest: soonest() } }));
      fireEvent.click((await screen.findByText('Customer One')).closest('button')!);
      expect(where()).toBe('/sent-job/1');
    });

    it('sends "View all" to the address the server sent for the tile (the Schedule\'s filter, for a person with Access Schedule)', async () => {
      open(answer('/sent-schedule?filter=sent', { [ID]: { count: 2, soonest: soonest() } }));
      fireEvent.click(await screen.findByRole('button', { name: 'View all' }));
      expect(where()).toBe('/sent-schedule?filter=sent');
    });

    it('offers no "View all" when the server sent no address for the tile (no Access Schedule), and the soonest record still opens', async () => {
      open(answer(null, { [ID]: { count: 1, soonest: soonest() } }));
      const row = await screen.findByText('Customer One');
      expect(screen.queryByRole('button', { name: 'View all' })).not.toBeInTheDocument();
      fireEvent.click(row.closest('button')!);
      expect(where()).toBe('/sent-job/1');
    });

    it('says so in one plain line when every booked visit has a crew', async () => {
      open(answer('/sent-schedule', { [ID]: { count: 0, soonest: null } }));
      expect(await screen.findByText('Every booked visit has a crew')).toBeInTheDocument();
    });

    it('claims nothing before the first answer lands', async () => {
      serveNothing();
      renderDashboard({ ability: ADMIN });
      await screen.findByRole('button', { name: /Customize home page/ });
      expect(screen.queryByText('Every booked visit has a crew')).not.toBeInTheDocument();
    });

    it('is offered by the picker under the Jobs category the server named, and added from there', async () => {
      serveDashboard(answer('/sent-schedule', { [ID]: { count: 0, soonest: null } }), []);
      renderDashboard({ ability: ADMIN });
      fireEvent.click(await screen.findByRole('button', { name: /Customize home page/ }));
      const group = (await screen.findByText('Jobs', { selector: '[data-testid="category-name"]' })).closest('[role="group"]') as HTMLElement;
      fireEvent.click(within(group).getByRole('button', { name: 'Add Missing crew' }));
      expect(await screen.findByText('Every booked visit has a crew')).toBeInTheDocument();
    });
  });

  describe('the Needs Attention item for visits with no crew', () => {
    const item = { id: 'missing-crew', type: 'missing_crew', severity: 'warning', title: '3 visits with no crew', meta: 'J-100 starts Thu 9:00 AM', badge: '3d', link: '/sent-schedule?filter=sent' };
    const NEEDS = 'needs_attention';

    it('shows its title and its soonest-visit line, and opens the address the server sent', async () => {
      open(answer(null, { [NEEDS]: [item] }, [meta(NEEDS, 'each_record', null)]), [NEEDS]);
      expect(await screen.findByText('3 visits with no crew')).toBeInTheDocument();
      expect(screen.getByText('J-100 starts Thu 9:00 AM')).toBeInTheDocument();
      fireEvent.click(screen.getByText('3 visits with no crew').closest('button')!);
      expect(where()).toBe('/sent-schedule?filter=sent');
    });

    it('opens the soonest record when the server sent that instead (no Access Schedule)', async () => {
      open(answer(null, { [NEEDS]: [{ ...item, link: '/sent-job/1' }] }, [meta(NEEDS, 'each_record', null)]), [NEEDS]);
      fireEvent.click((await screen.findByText('3 visits with no crew')).closest('button')!);
      expect(where()).toBe('/sent-job/1');
    });
  });
});

describe('dashboardMissingLeadOwner', () => {
  /**
   * Roles & Permissions S09.11 - Missing lead owner on the routed home page: the tile (a count and the lead that has been
   * open longest with no Owner), the Needs Attention item "N leads with no owner" that replaced the unassigned-leads item,
   * and the "N with no owner" line under Open Leads.
   *
   * The page is the routed one (pages/v2/dashboard/DashboardPage), against the JSON shape GET /api/dashboard sends. The
   * addresses in these answers are invented ones, so a page that sent anyone somewhere it knew would fail.
   */

  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

  const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);
  const ID = 'missing_lead_owner';

  const meta = (id: string, category: DashboardTileMeta['category'], link: string | null): DashboardTileMeta => ({ id, category, mode: 'company', label: null, link });
  const oldest = (age_days: number) => ({ id: 'lead-1', lead_number: 'L-100', title: 'Customer One', age_days, link: '/sent-lead/1' });
  const answer = (link: string | null, data: Record<string, unknown>, tiles: DashboardTileMeta[] = [meta(ID, 'leads', link)]): DashboardResponse => ({
    tiles,
    categories: [{ id: 'leads', label: 'Leads' }, { id: 'each_record', label: 'Across your records' }],
    data: data as DashboardResponse['data'],
    generated_at: '2026-10-12T10:00:00.000Z',
  });

  /** Shows where the page has been sent. */
  function Where() {
    return <p data-testid="where">{useLocation().pathname + useLocation().search}</p>;
  }
  const where = () => screen.getByTestId('where').textContent;

  /** The page of a person whose saved layout holds these tiles (as a Dispatcher's default holds Missing lead owner). */
  function open(body: DashboardResponse, shown: string[] = [ID]) {
    serveDashboard(body, shown.map((id) => ({ id, visible: true })));
    renderDashboard({ ability: ADMIN, beside: <Where /> });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  describe('the Missing lead owner tile', () => {
    it('shows how many open leads have no owner and the oldest one with its number, customer and days open', async () => {
      open(answer('/sent-leads', { [ID]: { count: 4, oldest: oldest(9) } }));
      const tile = (await screen.findByRole('heading', { name: /Missing lead owner/ })).closest('[data-slot="card"]') as HTMLElement;
      expect(within(tile).getByText('4')).toBeInTheDocument();
      expect(within(tile).getByText('L-100')).toBeInTheDocument();
      expect(within(tile).getByText('Customer One')).toBeInTheDocument();
      expect(within(tile).getByText('9 days')).toBeInTheDocument();
    });

    it('opens the oldest lead at the address the server sent', async () => {
      open(answer('/sent-leads', { [ID]: { count: 1, oldest: oldest(1) } }));
      expect(await screen.findByText('1 day')).toBeInTheDocument();
      fireEvent.click(screen.getByText('Customer One').closest('button')!);
      expect(where()).toBe('/sent-lead/1');
    });

    it('sends "View all" to the address the server sent for the tile', async () => {
      open(answer('/sent-leads?filter=sent', { [ID]: { count: 2, oldest: oldest(3) } }));
      fireEvent.click(await screen.findByRole('button', { name: 'View all' }));
      expect(where()).toBe('/sent-leads?filter=sent');
    });

    it('offers no "View all" when the server sent no address for the tile, and the oldest lead still opens', async () => {
      open(answer(null, { [ID]: { count: 1, oldest: oldest(0) } }));
      const row = await screen.findByText('Customer One');
      expect(screen.queryByRole('button', { name: 'View all' })).not.toBeInTheDocument();
      expect(screen.getByText('Today')).toBeInTheDocument();
      fireEvent.click(row.closest('button')!);
      expect(where()).toBe('/sent-lead/1');
    });

    it('says so in one plain line when every open lead has an owner', async () => {
      open(answer('/sent-leads', { [ID]: { count: 0, oldest: null } }));
      expect(await screen.findByText('No leads without an owner')).toBeInTheDocument();
    });

    it('claims nothing before the first answer lands', async () => {
      serveNothing();
      renderDashboard({ ability: ADMIN });
      await screen.findByRole('button', { name: /Customize home page/ });
      expect(screen.queryByText('No leads without an owner')).not.toBeInTheDocument();
    });

    it('is offered by the picker under the Leads category the server named, and added from there', async () => {
      serveDashboard(answer('/sent-leads', { [ID]: { count: 0, oldest: null } }), []);
      renderDashboard({ ability: ADMIN });
      fireEvent.click(await screen.findByRole('button', { name: /Customize home page/ }));
      const group = (await screen.findByText('Leads', { selector: '[data-testid="category-name"]' })).closest('[role="group"]') as HTMLElement;
      fireEvent.click(within(group).getByRole('button', { name: 'Add Missing lead owner' }));
      expect(await screen.findByText('No leads without an owner')).toBeInTheDocument();
    });
  });

  describe('the line under Open Leads', () => {
    it('reads "N with no owner", and never says unassigned', async () => {
      const OPEN = 'kpi.open_leads';
      open(answer('/sent-leads', { [OPEN]: { count: 12, no_owner: 3 } }, [meta(OPEN, 'leads', '/sent-leads')]), [OPEN]);
      expect(await screen.findByText('3 with no owner')).toBeInTheDocument();
      expect(screen.queryByText(/unassigned/i)).not.toBeInTheDocument();
    });
  });

  describe('the Needs Attention item for leads with no owner', () => {
    const item = { id: 'missing-lead-owner', type: 'missing_lead_owner', severity: 'info', title: '3 leads with no owner', meta: 'Oldest: Customer One · 9 days open', badge: '3', link: '/sent-leads?filter=sent' };

    it('shows its title and its oldest-lead line, and opens the address the server sent', async () => {
      const NEEDS = 'needs_attention';
      open(answer(null, { [NEEDS]: [item] }, [meta(NEEDS, 'each_record', null)]), [NEEDS]);
      expect(await screen.findByText('3 leads with no owner')).toBeInTheDocument();
      expect(screen.getByText('Oldest: Customer One · 9 days open')).toBeInTheDocument();
      fireEvent.click(screen.getByText('3 leads with no owner').closest('button')!);
      expect(where()).toBe('/sent-leads?filter=sent');
    });
  });
});

describe('dashboardUnscheduledJobs', () => {
  /**
   * Roles & Permissions S09.9 - the Unscheduled jobs tile on the routed home page: a count and the jobs that have waited
   * longest, each row opening the job at the address the server sent, "View all" only when the server sent the Jobs list's
   * address, and one plain line when nothing is waiting.
   *
   * The page is the routed one (pages/v2/dashboard/DashboardPage), against the JSON shape GET /api/dashboard sends. The
   * addresses in these answers are invented ones, so a page that sent anyone somewhere it knew would fail.
   */

  const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);
  const ID = 'unscheduled_jobs';

  const meta = (link: string | null): DashboardTileMeta => ({ id: ID, category: 'jobs', mode: 'company', label: null, link });
  const job = (n: number, age_days: number) => ({
    id: `job-${n}`, job_number: `J-${n}`, title: `Customer ${n}`, address: `${n} Main St, Testville`, age_days, link: `/sent-job/${n}`,
  });
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

  /** The page of a person whose saved layout holds the tile (as a Dispatcher's default does). */
  function open(body: DashboardResponse) {
    serveDashboard(body, [{ id: ID, visible: true }]);
    renderDashboard({ ability: ADMIN, beside: <Where /> });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  describe('the Unscheduled jobs tile', () => {
    it('shows how many jobs are waiting and one row per job the server sent, each with its number, customer, place and wait', async () => {
      open(answer('/sent-jobs', { count: 7, jobs: [job(1, 9), job(2, 1), job(3, 0)] }));
      const tile = (await screen.findByRole('heading', { name: /Unscheduled jobs/ })).closest('[data-slot="card"]') as HTMLElement;
      expect(within(tile).getByText('7')).toBeInTheDocument();
      expect(within(tile).getByText('J-1')).toBeInTheDocument();
      expect(within(tile).getByText('Customer 1')).toBeInTheDocument();
      expect(within(tile).getByText('1 Main St, Testville')).toBeInTheDocument();
      expect(within(tile).getByText('9 days')).toBeInTheDocument();
      expect(within(tile).getByText('1 day')).toBeInTheDocument();
      expect(within(tile).getByText('Today')).toBeInTheDocument();
      // The tile draws the jobs it was sent and no wall: three rows, not seven.
      expect(within(tile).getAllByText(/^J-\d$/)).toHaveLength(3);
    });

    it('opens a row on the job at the address the server sent', async () => {
      open(answer('/sent-jobs', { count: 2, jobs: [job(1, 3), job(2, 2)] }));
      fireEvent.click((await screen.findByText('Customer 2')).closest('button')!);
      expect(where()).toBe('/sent-job/2');
    });

    it('sends "View all" to the address the server sent for the tile', async () => {
      open(answer('/sent-jobs?status=sent', { count: 1, jobs: [job(1, 3)] }));
      fireEvent.click(await screen.findByRole('button', { name: 'View all' }));
      expect(where()).toBe('/sent-jobs?status=sent');
    });

    it('offers no "View all" when the server sent no address for the tile, and the rows still open their jobs', async () => {
      open(answer(null, { count: 1, jobs: [job(1, 3)] }));
      const row = await screen.findByText('Customer 1');
      expect(screen.queryByRole('button', { name: 'View all' })).not.toBeInTheDocument();
      fireEvent.click(row.closest('button')!);
      expect(where()).toBe('/sent-job/1');
    });

    it('says so in one plain line when no job is waiting, with no count and no rows', async () => {
      open(answer('/sent-jobs', { count: 0, jobs: [] }));
      expect(await screen.findByText('No unscheduled jobs')).toBeInTheDocument();
    });

    it('claims nothing before the first answer lands', async () => {
      serveNothing();
      renderDashboard({ ability: ADMIN });
      await screen.findByRole('button', { name: /Customize home page/ });
      expect(screen.queryByText('No unscheduled jobs')).not.toBeInTheDocument();
    });

    it('is offered by the picker under the Jobs category the server named, and added from there', async () => {
      serveDashboard(answer('/sent-jobs', { count: 0, jobs: [] }), []);
      renderDashboard({ ability: ADMIN });
      fireEvent.click(await screen.findByRole('button', { name: /Customize home page/ }));
      const group = (await screen.findByText('Jobs', { selector: '[data-testid="category-name"]' })).closest('[role="group"]') as HTMLElement;
      fireEvent.click(within(group).getByRole('button', { name: 'Add Unscheduled jobs' }));
      expect(await screen.findByText('No unscheduled jobs')).toBeInTheDocument();
    });
  });
});
