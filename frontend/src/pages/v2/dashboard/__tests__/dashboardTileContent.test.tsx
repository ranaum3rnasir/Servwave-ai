import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { buildAbility } from '@/lib/ability';
import type { DashboardResponse, DashboardTileMeta, TechSchedule, DashboardTileCategory } from '@/lib/api/dashboard';
import { serveDashboard, renderDashboard, serveNothing } from '@/__tests__/harness/dashboardPage';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';

vi.hoisted(() => {
  vi.stubEnv('VITE_DASHBOARD_USE_MOCK', 'false');
});

// Each test starts from the setup file's signed-in user and bare client calls: reset them here, so a test states its own user
// and answers in its own `beforeEach` (`clearAllMocks` keeps implementations).
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAuthStore).mockReset();
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockReset();
  vi.mocked(api.patch).mockReset();
  vi.mocked(api.put).mockReset();
  vi.mocked(api.delete).mockReset();
});

describe('dashboardTiles', () => {
  /**
   * Roles & Permissions S09.1 - the routed dashboard draws the answer it is sent, keyed by tile id: only the tiles the
   * server says this person has, the label the server sent beside a money tile's title, a picker that offers only those
   * tiles, and a plain line (with the customize button) when the person's access unlocks no tile.
   *
   * The page is the routed one (pages/v2/dashboard/DashboardPage), against the same JSON shape GET /api/dashboard sends.
   */

  // The dashboard seam reads VITE_DASHBOARD_USE_MOCK once, when its module loads: pin it to the live (mocked axios) path.

  const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);

  const meta = (id: string, category: DashboardTileMeta['category'], mode: DashboardTileMeta['mode'] = 'scope', label: DashboardTileMeta['label'] = null): DashboardTileMeta => ({
    id, category, mode, label, link: '/somewhere',
  });

  /** A technician-like answer: the counts of their own work, an own-money tile labelled Yours, nothing else. */
  const answer: DashboardResponse = {
    tiles: [
      meta('kpi.jobs_today', 'jobs'),
      meta('kpi.revenue_mtd', 'invoices_and_payments', 'own', 'Yours'),
      meta('coming_up', 'jobs'),
    ],
    data: {
      'kpi.jobs_today': { total: 3, scheduled: 2, in_progress: 1, completed: 0, vs_yesterday: 0 },
      'kpi.revenue_mtd': { invoiced: 900, collected: 700, collected_last_month: 600, vs_last_month_pct: 16 },
      coming_up: [],
    },
    categories: [{ id: 'jobs', label: 'Jobs' }, { id: 'invoices_and_payments', label: 'Invoices and payments' }],
    generated_at: '2026-10-11T10:00:00.000Z',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  // The answer, and the layout the server keeps for this person (the factory one unless a test gives its own).
  const serve = (body: DashboardResponse) => serveDashboard(body);

  describe('the routed dashboard page', () => {
    it('draws only the tiles the server sent, whatever the saved layout lists', async () => {
      serve(answer);
      renderDashboard({ ability: ADMIN });

      // The default layout lists Open Leads, Unpaid Balance, the scoreboards and more: none of them is this person's.
      expect(await screen.findByText('Jobs Today')).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByText('Open Leads')).not.toBeInTheDocument());
      for (const absent of ['Unpaid Balance', 'Tech Scoreboard', 'Dispatch Scoreboard', 'Close Rate', 'Smart Insights']) {
        expect(screen.queryByText(absent), absent).not.toBeInTheDocument();
      }
    });

    it('shows the server\'s label next to a money tile\'s title, and none on a count tile', async () => {
      serve(answer);
      renderDashboard({ ability: ADMIN });

      const revenue = (await screen.findByText('Monthly Revenue')).closest('button')!;
      expect(revenue).toHaveTextContent('Yours');
      expect(screen.getByText('Jobs Today').closest('button')).not.toHaveTextContent('Yours');
      // The company's goal is not in the answer, so it is not drawn.
      expect(revenue).not.toHaveTextContent(/goal/);
    });

    it('shows no label on a company-mode money tile', async () => {
      serve({ ...answer, tiles: [meta('kpi.revenue_mtd', 'invoices_and_payments', 'company', null)] });
      renderDashboard({ ability: ADMIN });

      const revenue = (await screen.findByText('Monthly Revenue')).closest('button')!;
      expect(revenue).not.toHaveTextContent('Yours');
    });

    it('offers only the eligible tiles in Customize home page', async () => {
      serve(answer);
      renderDashboard({ ability: ADMIN });
      await screen.findByText('Jobs Today');

      fireEvent.click(screen.getByRole('button', { name: /Customize home page/ }));

      // Coming Up is eligible and not on the page yet: it is offered. Tiles the person cannot have are not.
      expect(await screen.findByRole('button', { name: 'Add Coming Up' })).toBeInTheDocument();
      for (const absent of ['Add Dispatch Scoreboard', 'Add Unpaid Balance', 'Add Recent Activity', 'Add Revenue by Job Type']) {
        expect(screen.queryByRole('button', { name: absent }), absent).not.toBeInTheDocument();
      }
    });

    // S09.2: the picker groups by the category names the server sent, not by the old display groups.
    it('groups the picker by the category names the server sent, and only the categories this person has a tile in', async () => {
      serve({
        ...answer,
        tiles: [meta('kpi.open_leads', 'leads'), meta('kpi.close_rate', 'leads'), meta('needs_attention', 'each_record'), meta('coming_up', 'jobs')],
        categories: [{ id: 'jobs', label: 'Jobs' }, { id: 'leads', label: 'Leads' }, { id: 'each_record', label: 'Across your records' }],
        data: { 'kpi.open_leads': { count: 1, no_owner: 0 }, 'kpi.close_rate': { rate: 0, won: 0, lost: 0, vs_last_period_pp: 0 }, needs_attention: [], coming_up: [] },
      });
      renderDashboard({ ability: ADMIN });
      await screen.findByText('Open Leads');

      fireEvent.click(screen.getByRole('button', { name: /Customize home page/ }));
      const picker = (await screen.findByRole('button', { name: 'Close widget catalog' })).closest('aside')!;

      const groupNames = within(picker).getAllByRole('group').map((g) => within(g).getByTestId('category-name').textContent);
      expect(groupNames).toEqual(['Jobs', 'Leads', 'Across your records']);
      // The tile sits under its own category, and the old display groups are gone.
      expect(within(within(picker).getByRole('group', { name: 'Jobs' })).getByText('Coming Up')).toBeInTheDocument();
      for (const retired of ['KPI', 'Operations', 'Financial', 'Sales', 'Pipeline', 'Team']) {
        expect(within(picker).queryByText(retired), retired).not.toBeInTheDocument();
      }
      expect(within(picker).queryByText('Invoices and payments')).not.toBeInTheDocument();
    });

    it('shows a person with only View leads just the Leads tiles and the all-records tiles in the picker', async () => {
      serve({
        ...answer,
        tiles: [
          meta('kpi.close_rate', 'leads'), meta('kpi.open_leads', 'leads'), meta('lead_sources', 'leads'),
          meta('needs_attention', 'each_record'), meta('pipeline', 'each_record'), meta('recent_activity', 'each_record'),
        ],
        categories: [{ id: 'leads', label: 'Leads' }, { id: 'each_record', label: 'Across your records' }],
        data: { 'kpi.open_leads': { count: 1, no_owner: 0 }, 'kpi.close_rate': { rate: 0, won: 0, lost: 0, vs_last_period_pp: 0 }, lead_sources: [], needs_attention: [], pipeline: [], recent_activity: [] },
      });
      renderDashboard({ ability: ADMIN });
      await screen.findByText('Open Leads');

      fireEvent.click(screen.getByRole('button', { name: /Customize home page/ }));
      const picker = (await screen.findByRole('button', { name: 'Close widget catalog' })).closest('aside')!;
      expect(within(picker).getAllByRole('group').map((g) => within(g).getByTestId('category-name').textContent)).toEqual(['Leads', 'Across your records']);
      for (const absent of ['Add Jobs Today', 'Add Unpaid Balance', 'Add Tech Scoreboard', 'Add Smart Insights', 'Add Recent Calls']) {
        expect(within(picker).queryByRole('button', { name: absent }), absent).not.toBeInTheDocument();
      }
    });

    it('says plainly that no tiles are available when the person\'s access unlocks none, and keeps the customize button', async () => {
      serve({ tiles: [], categories: [], data: {}, generated_at: answer.generated_at });
      renderDashboard({ ability: ADMIN });

      expect(await screen.findByText('No tiles are available with your access.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Customize home page/ })).toBeInTheDocument();
      expect(screen.queryByText('Jobs Today')).not.toBeInTheDocument();
    });

    it('does not show the no-tiles line to a person who has tiles', async () => {
      serve(answer);
      renderDashboard({ ability: ADMIN });
      await screen.findByText('Jobs Today');

      expect(screen.queryByText('No tiles are available with your access.')).not.toBeInTheDocument();
    });
  });
});

describe('dashboardWording', () => {
  /**
   * Roles & Permissions S09.14 - the words on the routed home page: "Unassigned" is gone, and the tiles use PRD 6's
   * completion words. Collected Today counts "jobs completed", the pipeline stage reads "Job completed", and a Today's
   * Schedule pill says "Completed" for a job in Completed, Office review or Ready to close, and "Done" only for a job
   * whose status is Done.
   *
   * The page is the routed one (pages/v2/dashboard/DashboardPage), against the JSON shape GET /api/dashboard sends.
   * The last block reads the dashboard's source files, so a word put back in any of them fails here.
   */

  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

  const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);

  const meta = (id: string, category: DashboardTileMeta['category']): DashboardTileMeta => ({ id, category, mode: 'company', label: null, link: null });
  const answer = (tiles: DashboardTileMeta[], data: Record<string, unknown>): DashboardResponse => ({
    tiles,
    categories: [{ id: 'jobs', label: 'Jobs' }, { id: 'invoices_and_payments', label: 'Invoices and payments' }],
    data: data as DashboardResponse['data'],
    generated_at: '2026-10-12T10:00:00.000Z',
  });
  function open(tileIds: Array<[string, DashboardTileMeta['category']]>, data: Record<string, unknown>) {
    serveDashboard(answer(tileIds.map(([id, category]) => meta(id, category)), data), tileIds.map(([id]) => ({ id, visible: true })));
    renderDashboard({ ability: ADMIN });
  }

  const entry = (id: string, status: string, customer: string) => ({
    id, job_number: `J-${id}`, status, scope_notes: null, scheduled_start: '2026-10-12T14:00:00.000Z', scheduled_end: '2026-10-12T15:00:00.000Z',
    customer_name: customer, address: null, entity: 'job' as const, link: `/jobs/${id}`,
  });
  const pillOf = (customer: string) => screen.getByText(customer).closest('button')!.querySelector('span.uppercase')!.textContent;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  describe('Collected Today', () => {
    it('reads "N jobs completed" under the amount, never "jobs done"', async () => {
      open([['kpi.collected_today', 'invoices_and_payments']], { 'kpi.collected_today': { amount: 1200, jobs_done: 5 } });
      expect(await screen.findByText('5 jobs completed')).toBeInTheDocument();
      expect(screen.queryByText(/jobs done/i)).not.toBeInTheDocument();
    });
  });

  describe('the Revenue Pipeline', () => {
    it('draws the stage the server calls "Job completed" under that name', async () => {
      open([['pipeline', 'jobs']], {
        pipeline: [
          { key: 'leads', label: 'Leads', kind: 'count', value: 3, link: null },
          { key: 'job', label: 'Job completed', kind: 'amount', value: 2900, link: null },
        ],
      });
      expect(await screen.findByText('Job completed')).toBeInTheDocument();
      expect(screen.queryByText('Job done')).not.toBeInTheDocument();
    });
  });

  describe("Today's Schedule", () => {
    const lanes = (): TechSchedule[] => [
      {
        user_id: 'u-1', first_name: 'Ann', last_name: 'Ames',
        jobs: [
          entry('a1', 'COMPLETED', 'Completed Customer'),
          entry('a2', 'OFFICE_REVIEW', 'Review Customer'),
          entry('a3', 'READY_TO_CLOSE', 'Ready Customer'),
          entry('a4', 'DONE', 'Done Customer'),
          entry('a5', 'SCHEDULED', 'Scheduled Customer'),
          entry('a6', 'IN_PROGRESS', 'Working Customer'),
        ],
      },
      { user_id: null, first_name: 'No crew', last_name: '', jobs: [entry('n1', 'SCHEDULED', 'Crewless Customer')] },
    ];

    it('says "Completed" for a job in Completed, Office review or Ready to close, and "Done" only for a Done job', async () => {
      open([['schedule_today', 'jobs']], { schedule_today: lanes() });
      await screen.findByText('Completed Customer');
      expect(pillOf('Completed Customer')).toBe('Completed');
      expect(pillOf('Review Customer')).toBe('Completed');
      expect(pillOf('Ready Customer')).toBe('Completed');
      expect(pillOf('Done Customer')).toBe('Done');
      expect(pillOf('Scheduled Customer')).toBe('Scheduled');
      expect(pillOf('Working Customer')).toBe('In Progress');
    });

    it('paints every finished job in the finished colours, whichever close-out status it is in', async () => {
      open([['schedule_today', 'jobs']], { schedule_today: lanes() });
      await screen.findByText('Completed Customer');
      for (const customer of ['Completed Customer', 'Review Customer', 'Ready Customer', 'Done Customer']) {
        expect(screen.getByText(customer).closest('button')!.className, customer).toContain('bg-sage-50');
      }
      expect(screen.getByText('Scheduled Customer').closest('button')!.className).not.toContain('bg-sage-50');
    });

    it('names the lane the server calls "No crew" and draws no "Unassigned" anywhere on the page', async () => {
      open([['schedule_today', 'jobs']], { schedule_today: lanes() });
      expect(await screen.findByText('No crew')).toBeInTheDocument();
      expect(screen.queryByText(/unassigned/i)).not.toBeInTheDocument();
    });
  });

  describe('the dashboard\'s source files', () => {
    const root = join(__dirname, '../../../..');
    const folders = ['pages/v2/dashboard', 'components/dashboard', 'lib/api/_mock/dashboard'];

    function sourceFiles(dir: string): string[] {
      return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path);
        return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
      });
    }

    it('finds the files it is meant to guard', () => {
      const files = folders.flatMap((folder) => sourceFiles(join(root, folder)));
      expect(files.some((f) => f.endsWith('pages/v2/dashboard/DashboardPage.tsx'))).toBe(true);
      expect(files.some((f) => f.endsWith('components/dashboard/widgetRegistry.tsx'))).toBe(true);
      expect(files.some((f) => f.endsWith('lib/api/_mock/dashboard/seed.ts'))).toBe(true);
    });

    it('holds the word "unassigned" in no dashboard file: the empty slot is named for what is missing', () => {
      const hits = folders
        .flatMap((folder) => sourceFiles(join(root, folder)))
        .flatMap((file) => readFileSync(file, 'utf8').split('\n').flatMap((line, i) => (/unassign/i.test(line) ? [`${file.replace(root, 'src')}:${i + 1}: ${line.trim()}`] : [])));
      expect(hits).toEqual([]);
    });

    it('says "jobs done" and "Job done" in no dashboard file', () => {
      const hits = folders
        .flatMap((folder) => sourceFiles(join(root, folder)))
        .flatMap((file) => readFileSync(file, 'utf8').split('\n').flatMap((line, i) => (/jobs done|job done/i.test(line) ? [`${file.replace(root, 'src')}:${i + 1}: ${line.trim()}`] : [])));
      expect(hits).toEqual([]);
    });
  });
});

describe('dashboardEmptyStates', () => {
  /**
   * Roles & Permissions S09.2 - every existing tile with nothing to show says so in one plain line, in the PRD's words
   * ("No jobs today", "No open leads"), instead of a blank, a zero or an empty chart. Nothing is claimed before the
   * first answer lands, and a tile that has something to show shows it.
   *
   * The page is the routed one (pages/v2/dashboard/DashboardPage), against the JSON shape GET /api/dashboard sends for
   * a tile with nothing in it (the shapes are the backend builders' own empty results).
   */

  const mockApi = vi.mocked(api);
  const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);

  const CATEGORY: Record<string, DashboardTileCategory> = {
    'kpi.revenue_mtd': 'invoices_and_payments', 'kpi.collected_today': 'invoices_and_payments', 'kpi.ar': 'invoices_and_payments',
    'kpi.avg_ticket': 'invoices_and_payments', 'kpi.deposits': 'invoices_and_payments', revenue_chart: 'invoices_and_payments',
    'kpi.recurring': 'company_figures', smart_insights: 'company_figures', revenue_by_job_type: 'company_figures',
    'kpi.close_rate': 'leads', 'kpi.open_leads': 'leads', lead_sources: 'leads',
    needs_attention: 'each_record', pipeline: 'each_record', recent_activity: 'each_record', recent_calls: 'communication',
  };
  const meta = (id: string): DashboardTileMeta => ({ id, category: CATEGORY[id] ?? 'jobs', mode: 'company', label: null, link: '/somewhere' });

  /** The tiles that are not on the default home page: a person adds them from the picker. */
  const OFF_BY_DEFAULT = ['jobs_by_status', 'coming_up', 'recent_activity', 'service_areas', 'recent_calls'];

  const MONTHS_EMPTY = ['May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct'].map((month, i) => ({ month, invoiced: 0, collected: 0, is_current: i === 5 }));

  interface Case {
    id: string;
    /** What the server sends when the tile has nothing in it. */
    empty: unknown;
    line: string;
    /** What it sends when the tile has something. */
    full: unknown;
  }

  const CASES: Case[] = [
    { id: 'kpi.jobs_today', empty: { total: 0, scheduled: 0, in_progress: 0, completed: 0, vs_yesterday: 0 }, line: 'No jobs today', full: { total: 3, scheduled: 2, in_progress: 1, completed: 0, vs_yesterday: 0 } },
    { id: 'kpi.jobs_week', empty: { completed: 0, scheduled: 0 }, line: 'No jobs this week', full: { completed: 1, scheduled: 4 } },
    { id: 'kpi.open_leads', empty: { count: 0, no_owner: 0 }, line: 'No open leads', full: { count: 2, no_owner: 1 } },
    { id: 'kpi.close_rate', empty: { rate: 0, won: 0, lost: 0, vs_last_period_pp: 0 }, line: 'No closed leads in the last 30 days', full: { rate: 50, won: 1, lost: 1, vs_last_period_pp: 0 } },
    { id: 'kpi.revenue_mtd', empty: { invoiced: 0, collected: 0, collected_last_month: 0, vs_last_month_pct: 0 }, line: 'No payments or invoices this month', full: { invoiced: 800, collected: 500, collected_last_month: 0, vs_last_month_pct: 0 } },
    { id: 'kpi.collected_today', empty: { amount: 0 }, line: 'No payments today', full: { amount: 100 } },
    { id: 'kpi.ar', empty: { total: 0, current: 0, over_30: 0, over_60: 0 }, line: 'Nothing unpaid', full: { total: 900, current: 900, over_30: 0, over_60: 0 } },
    { id: 'kpi.avg_ticket', empty: { amount: 0, period_days: 30 }, line: 'No paid invoices in the last 30 days', full: { amount: 450, period_days: 30 } },
    { id: 'kpi.deposits', empty: { amount: 0, count: 0 }, line: 'No deposits awaiting', full: { amount: 200, count: 1 } },
    { id: 'kpi.recurring', empty: null, line: 'No active plans', full: { mrr: 1200, active_plans: 3 } },
    { id: 'smart_insights', empty: [], line: 'No insights right now', full: [{ id: 'x', icon: '💰', tone: 'info', text: 'Something to look at', cta_label: 'Look', link: '/invoices', weight: 1 }] },
    { id: 'needs_attention', empty: [], line: 'All clear - nothing needs attention', full: [{ id: 'a', type: 'overdue_invoice', severity: 'danger', title: 'An invoice', meta: 'late', badge: '1d', link: '/invoices' }] },
    { id: 'schedule_today', empty: [], line: 'Nothing scheduled', full: [{ user_id: 'u1', first_name: 'Pat', last_name: 'Lee', jobs: [] }] },
    { id: 'revenue_chart', empty: { months: MONTHS_EMPTY }, line: 'No invoices or payments in this period', full: { months: MONTHS_EMPTY.map((m) => ({ ...m, collected: 100 })) } },
    { id: 'pipeline', empty: [{ key: 'leads', label: 'Leads', kind: 'count', value: 0, link: '/leads' }, { key: 'estimates', label: 'Estimates', kind: 'amount', value: 0, link: '/estimates' }], line: 'Nothing in the pipeline yet', full: [{ key: 'leads', label: 'Leads', kind: 'count', value: 4, link: '/leads' }] },
    { id: 'tech_scoreboard', empty: [], line: 'No jobs to rank yet', full: [{ user_id: 'u1', name: 'Pat Lee', jobs: 2 }] },
    { id: 'dispatch_scoreboard', empty: [], line: 'No jobs to rank yet', full: [{ user_id: 'u1', name: 'Pat Lee', jobs: 2 }] },
    { id: 'lead_sources', empty: [], line: 'No leads yet', full: [{ source: 'web', label: 'Web', lead_pct: 100, link: '/somewhere' }] },
    { id: 'jobs_by_status', empty: [], line: 'No jobs yet', full: [{ key: 'scheduled', label: 'Scheduled', count: 2 }] },
    { id: 'revenue_by_job_type', empty: [], line: 'No revenue by job type yet', full: [{ label: 'Install', pct: 100, revenue: 900 }] },
    { id: 'coming_up', empty: [], line: 'No upcoming jobs', full: [{ id: 'j1', in_label: 'in 2 hours', title: 'A job', address: '1 Main St', link: '/somewhere' }] },
    { id: 'recent_activity', empty: [], line: 'No recent activity', full: [{ id: 'e1', event_type: 'x', description: 'Something happened', created_at: new Date().toISOString(), creator_name: null, entity_deleted: false, entity_label: null }] },
  ];

  const answerFor = (id: string, data: unknown): DashboardResponse => ({
    tiles: [meta(id)],
    categories: [{ id: CATEGORY[id] ?? 'jobs', label: 'Whatever' }],
    data: { [id]: data } as DashboardResponse['data'],
    generated_at: '2026-10-12T10:00:00.000Z',
  });

  /** Opens the page with this one tile on it (adding it from the picker when it is not on the default home page). */
  async function openWith(id: string, body: DashboardResponse) {
    serveDashboard(body);
    renderDashboard({ ability: ADMIN });
    if (OFF_BY_DEFAULT.includes(id)) {
      fireEvent.click(await screen.findByRole('button', { name: /Customize home page/ }));
      fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^Add ${TITLE[id] ?? id}$`) }));
    }
  }

  const TITLE: Record<string, string> = {
    jobs_by_status: 'Jobs by Status', coming_up: 'Coming Up', recent_activity: 'Recent Activity',
    service_areas: 'Service Areas', recent_calls: 'Recent Calls',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  describe('a tile with nothing to show says so in one plain line', () => {
    it.each(CASES.map((c) => [c.id, c.line, c] as const))('%s: "%s"', async (_id, line, c) => {
      await openWith(c.id, answerFor(c.id, c.empty));
      expect(await screen.findByText(line)).toBeInTheDocument();
    });

    it.each(CASES.map((c) => [c.id, c.line, c] as const))('%s shows its figures, not "%s", when it has something', async (_id, line, c) => {
      await openWith(c.id, answerFor(c.id, c.full));
      // Wait for the answer to land (the loading state is not the empty state either).
      await waitFor(() => expect(mockApi.get).toHaveBeenCalled());
      await waitFor(() => expect(screen.queryByText(line)).not.toBeInTheDocument());
      expect(screen.queryByText(line)).not.toBeInTheDocument();
    });

    it.each(['service_areas', 'recent_calls'])('the placeholder %s says plainly that it is not built yet', async (id) => {
      const body: DashboardResponse = { tiles: [meta(id)], categories: [{ id: CATEGORY[id] ?? 'jobs', label: 'Whatever' }], data: {}, generated_at: '2026-10-12T10:00:00.000Z' };
      await openWith(id, body);
      expect(await screen.findByText('Coming soon')).toBeInTheDocument();
      expect(screen.queryByText(/connect data/i)).not.toBeInTheDocument();
    });

    it('claims nothing before the first answer lands', async () => {
      serveNothing();
      renderDashboard({ ability: ADMIN });
      await screen.findByRole('button', { name: /Customize home page/ });

      for (const c of CASES) expect(screen.queryByText(c.line), c.line).not.toBeInTheDocument();
    });

    it('puts the empty line inside the tile it belongs to, beside its title', async () => {
      await openWith('kpi.open_leads', answerFor('kpi.open_leads', { count: 0, no_owner: 0 }));
      const line = await screen.findByText('No open leads');
      const tile = line.closest('button')!;
      expect(within(tile).getByText('Open Leads')).toBeInTheDocument();
      // No zero is drawn as the figure.
      expect(within(tile).queryByText('0')).not.toBeInTheDocument();
    });

    it('names no vendor in any empty line', () => {
      for (const c of CASES) expect(c.line, c.id).not.toMatch(/ctm|supabase|render|stripe|twilio|resend|quickbooks/i);
    });
  });
});
