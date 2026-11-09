/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { buildAbility } from '@/lib/ability';
import type { DashboardResponse, DashboardTileCategory, DashboardTileMeta } from '@/lib/api/dashboard';
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

describe('dashboardClickTargets', () => {
  /**
   * Roles & Permissions S09.3 - a tile, row or stage is clickable only when the server sent it an address, and goes to
   * exactly that address. The page holds none of its own: every address in these answers is an invented one, so a page
   * that still sent anyone to a place it knew would land somewhere else and fail.
   *
   * The page is the routed one (pages/v2/dashboard/DashboardPage), against the JSON shape GET /api/dashboard sends.
   */

  const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);

  const CATEGORY: Record<string, DashboardTileCategory> = {
    'kpi.revenue_mtd': 'invoices_and_payments', 'kpi.collected_today': 'invoices_and_payments', 'kpi.ar': 'invoices_and_payments',
    'kpi.avg_ticket': 'invoices_and_payments', 'kpi.deposits': 'invoices_and_payments', revenue_chart: 'invoices_and_payments',
    'kpi.recurring': 'company_figures', smart_insights: 'company_figures', revenue_by_job_type: 'company_figures',
    'kpi.close_rate': 'leads', 'kpi.open_leads': 'leads', lead_sources: 'leads',
    needs_attention: 'each_record', pipeline: 'each_record', recent_activity: 'each_record',
  };
  /** The server's answer for one tile: an invented address (or none) for the tile as a whole. */
  const meta = (id: string, link: string | null): DashboardTileMeta => ({ id, category: CATEGORY[id] ?? 'jobs', mode: 'company', label: null, link });

  /** The tiles that are not on the default home page: a person adds them from the picker. */
  const OFF_BY_DEFAULT: Record<string, string> = { jobs_by_status: 'Jobs by Status', coming_up: 'Coming Up', recent_activity: 'Recent Activity' };

  const MONTH = { month: 'Oct', invoiced: 100, collected: 100, is_current: true };

  /** Shows where the page has been sent. */
  function Where() {
    return <p data-testid="where">{useLocation().pathname + useLocation().search}</p>;
  }
  const where = () => screen.getByTestId('where').textContent;

  async function open(id: string, link: string | null, data: unknown) {
    const body: DashboardResponse = {
      tiles: [meta(id, link)],
      categories: [{ id: CATEGORY[id] ?? 'jobs', label: 'Whatever' }],
      data: { [id]: data } as DashboardResponse['data'],
      generated_at: '2026-10-12T10:00:00.000Z',
    };
    serveDashboard(body);
    renderDashboard({ ability: ADMIN, beside: <Where /> });
    if (OFF_BY_DEFAULT[id]) {
      fireEvent.click(await screen.findByRole('button', { name: /Customize home page/ }));
      fireEvent.click(await screen.findByRole('button', { name: `Add ${OFF_BY_DEFAULT[id]}` }));
      fireEvent.click(screen.getByRole('button', { name: /Done/ }));
    }
  }

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  describe('a KPI tile', () => {
    const KPIS: Array<[string, string, unknown]> = [
      ['kpi.revenue_mtd', 'Monthly Revenue', { invoiced: 800, collected: 500, collected_last_month: 0, vs_last_month_pct: 0 }],
      ['kpi.collected_today', 'Collected Today', { amount: 100 }],
      ['kpi.recurring', 'Recurring (Plans)', { mrr: 1200, active_plans: 3 }],
      ['kpi.ar', 'Unpaid Balance', { total: 900, current: 900, over_30: 0, over_60: 0 }],
      ['kpi.close_rate', 'Close Rate', { rate: 50, won: 1, lost: 1, vs_last_period_pp: 0 }],
      ['kpi.jobs_today', 'Jobs Today', { total: 3, scheduled: 2, in_progress: 1, completed: 0, vs_yesterday: 0 }],
      ['kpi.open_leads', 'Open Leads', { count: 2, no_owner: 1 }],
      ['kpi.avg_ticket', 'Avg Ticket', { amount: 450, period_days: 30 }],
      ['kpi.jobs_week', 'Jobs This Week', { completed: 1, scheduled: 4 }],
      ['kpi.deposits', 'Deposits Awaiting', { amount: 200, count: 1 }],
    ];

    it.each(KPIS)('%s goes to the address the server sent, not one the page knows', async (id, title, data) => {
      await open(id, `/sent-by-server${id.replace('kpi', '')}`, data);
      // The tile is a control once the answer has landed (until then it is a skeleton).
      await waitFor(() => expect(screen.getByText(title).closest('button')).not.toBeNull());
      fireEvent.click(screen.getByText(title).closest('button')!);
      expect(where()).toBe(`/sent-by-server${id.replace('kpi', '')}`);
    });

    it.each(KPIS)('%s is not clickable, and goes nowhere, when the server sent no address', async (id, title, data) => {
      await open(id, null, data);
      const label = await screen.findByText(title);
      // Wait for the answer to land (the figure replaces the skeleton), so "not clickable" is not just "not loaded yet".
      await waitFor(() => expect(document.querySelector('[data-slot="kpi-value"]')).not.toBeNull());
      expect(label.closest('button')).toBeNull();
      fireEvent.click(label);
      expect(where()).toBe('/');
    });
  });

  describe('a tile that opens a list', () => {
    it('goes to the sent address from a scoreboard row, and nowhere without one', async () => {
      const rows = [{ user_id: 'u1', name: 'Pat Lee', jobs: 2 }];
      await open('tech_scoreboard', '/sent-board', rows);
      fireEvent.click((await screen.findByText('Pat Lee')).closest('button')!);
      expect(where()).toBe('/sent-board');
    });

    it('draws a scoreboard row without a click when the server sent no address', async () => {
      await open('dispatch_scoreboard', null, [{ user_id: 'u1', name: 'Pat Lee', jobs: 2 }]);
      const row = await screen.findByText('Pat Lee');
      expect(row.closest('button')).toBeNull();
      fireEvent.click(row);
      expect(where()).toBe('/');
    });

    it('goes to the sent address from Jobs by Status\' "View all", and offers none without one', async () => {
      await open('jobs_by_status', '/sent-jobs', [{ key: 'scheduled', label: 'Scheduled', count: 2 }]);
      fireEvent.click(await screen.findByRole('button', { name: 'View all' }));
      expect(where()).toBe('/sent-jobs');
    });

    it('offers no "View all" on Jobs by Status when the server sent no address', async () => {
      await open('jobs_by_status', null, [{ key: 'scheduled', label: 'Scheduled', count: 2 }]);
      await screen.findByText('Jobs by Status');
      expect(screen.queryByRole('button', { name: 'View all' })).not.toBeInTheDocument();
    });

    it('goes to the sent address from Revenue by Job Type\'s "Report" link, and offers none without one', async () => {
      const slices = [{ label: 'Install', pct: 100, revenue: 900 }];
      await open('revenue_by_job_type', '/sent-report', slices);
      fireEvent.click(await screen.findByRole('button', { name: 'Report' }));
      expect(where()).toBe('/sent-report');
    });

    it('offers no "Report" link on Revenue by Job Type when the server sent no address', async () => {
      await open('revenue_by_job_type', null, [{ label: 'Install', pct: 100, revenue: 900 }]);
      await screen.findByText('Revenue by Job Type');
      expect(screen.queryByRole('button', { name: 'Report' })).not.toBeInTheDocument();
    });

    it('opens the Monthly Revenue chart on the sent address, and draws it without a click when none was sent', async () => {
      await open('revenue_chart', '/sent-invoices', { months: [MONTH] });
      fireEvent.click(await screen.findByRole('button', { name: 'View all' }));
      expect(where()).toBe('/sent-invoices');
    });

    it('offers no way through from the Monthly Revenue chart when the server sent no address', async () => {
      await open('revenue_chart', null, { months: [MONTH] });
      await screen.findByText('Monthly Revenue');
      expect(screen.queryByRole('button', { name: 'View all' })).not.toBeInTheDocument();
    });
  });

  describe('Coming Up', () => {
    const jobs = [{ id: 'j1', in_label: 'in 2 hours', title: 'A job', address: '1 Main St', link: '/sent-job/j1' }];

    it('opens a row on the job the server named, and "View all" on the Schedule address it sent', async () => {
      await open('coming_up', '/sent-schedule', jobs);
      fireEvent.click((await screen.findByText('A job')).closest('button')!);
      expect(where()).toBe('/sent-job/j1');
      fireEvent.click(screen.getByRole('button', { name: 'View all' }));
      expect(where()).toBe('/sent-schedule');
    });

    it('still opens the job on a row when there is no Schedule address, and offers no "View all"', async () => {
      await open('coming_up', null, jobs);
      expect(screen.queryByRole('button', { name: 'View all' })).not.toBeInTheDocument();
      fireEvent.click((await screen.findByText('A job')).closest('button')!);
      expect(where()).toBe('/sent-job/j1');
    });
  });

  describe('Today\'s Schedule', () => {
    const lanes = [{
      user_id: 'u1', first_name: 'Pat', last_name: 'Lee',
      jobs: [
        { id: 'j1', job_number: 'J-1', status: 'SCHEDULED', scope_notes: null, scheduled_start: '2026-10-12T14:00:00Z', scheduled_end: null, customer_name: 'Acme Co', address: null, entity: 'job', link: '/sent-job/j1' },
        { id: 'l1', job_number: 'L-1', status: 'WALKTHROUGH_SCHEDULED', scope_notes: null, scheduled_start: '2026-10-12T15:00:00Z', scheduled_end: null, customer_name: 'Beta Co', address: null, entity: 'walkthrough', link: '/sent-lead/l1' },
      ],
    }];

    it('opens each entry on the record the server named, a job or a lead', async () => {
      await open('schedule_today', '/sent-calendar', lanes);
      fireEvent.click((await screen.findByText('Acme Co')).closest('button')!);
      expect(where()).toBe('/sent-job/j1');
      fireEvent.click(screen.getByText('Beta Co').closest('button')!);
      expect(where()).toBe('/sent-lead/l1');
    });

    it('sends "Full calendar" to the Schedule address the server sent, and offers none without one', async () => {
      await open('schedule_today', '/sent-calendar', lanes);
      fireEvent.click(await screen.findByRole('button', { name: 'Full calendar' }));
      expect(where()).toBe('/sent-calendar');
    });

    it('offers no "Full calendar" when the server sent no Schedule address', async () => {
      await open('schedule_today', null, lanes);
      await screen.findByText('Acme Co');
      expect(screen.queryByRole('button', { name: 'Full calendar' })).not.toBeInTheDocument();
    });
  });

  describe('Needs Attention', () => {
    it('opens an item on the address the server sent for it', async () => {
      const items = [{ id: 'a', type: 'overdue_invoice', severity: 'danger', title: 'Invoice 7 overdue', meta: 'late', badge: '1d', link: '/sent-invoice/7' }];
      await open('needs_attention', null, items);
      fireEvent.click((await screen.findByText('Invoice 7 overdue')).closest('button')!);
      expect(where()).toBe('/sent-invoice/7');
    });
  });

  describe('the Revenue Pipeline', () => {
    const stages = [
      { key: 'leads', label: 'Leads', kind: 'count', value: 4, link: '/sent-leads' },
      { key: 'invoiced', label: 'Invoiced', kind: 'amount', value: 900, link: null },
    ];

    it('goes to the address of a stage the server sent one for', async () => {
      await open('pipeline', null, stages);
      fireEvent.click((await screen.findByText('Leads')).closest('button')!);
      expect(where()).toBe('/sent-leads');
    });

    it('draws a stage with no address without a click', async () => {
      await open('pipeline', null, stages);
      const stage = await screen.findByText('Invoiced');
      expect(stage.closest('button')).toBeNull();
      fireEvent.click(stage);
      expect(where()).toBe('/');
    });
  });

  describe('Top Lead Sources', () => {
    it('opens a row on the address the server built for it, and draws a row with none without a click', async () => {
      await open('lead_sources', null, [
        { source: 'web', label: 'Web', lead_pct: 60, link: '/sent-leads?source=web' },
        { source: 'ad', label: 'Ad', lead_pct: 40, link: null },
      ]);
      fireEvent.click((await screen.findByText('Web')).closest('button')!);
      expect(where()).toBe('/sent-leads?source=web');
      const closed = screen.getByText('Ad');
      expect(closed.closest('button')).toBeNull();
      fireEvent.click(closed);
      expect(where()).toBe('/sent-leads?source=web');
    });
  });

  describe('Smart Insights', () => {
    const card = (id: string, link: string | null) => ({ id, icon: '💰', tone: 'info', text: `Card ${id}`, cta_label: `Go ${id}`, link, weight: 1 });

    it('opens a card on its address, and draws a card with none without a click or a call to action', async () => {
      await open('smart_insights', null, [card('a', '/sent-card-a'), card('b', null)]);
      fireEvent.click((await screen.findByText('Card a')).closest('button')!);
      expect(where()).toBe('/sent-card-a');
      expect(screen.getByText(/Go a/)).toBeInTheDocument();
      const closed = screen.getByText('Card b');
      expect(closed.closest('button')).toBeNull();
      expect(screen.queryByText(/Go b/)).not.toBeInTheDocument();
      fireEvent.click(closed);
      expect(where()).toBe('/sent-card-a');
    });
  });

  describe('Recent Activity', () => {
    it('keeps its rows without a link', async () => {
      const events = [{ id: 'e1', event_type: 'x', description: 'Something happened', created_at: new Date().toISOString(), creator_name: null, entity_deleted: false, entity_label: null }];
      await open('recent_activity', null, events);
      const row = await screen.findByText('Something happened');
      expect(within(row.closest('div')!.parentElement!).queryAllByRole('button')).toHaveLength(0);
    });
  });

  describe('the dashboard holds no address of its own', () => {
    /** Every source file of the dashboard page and its widgets (tests excluded). */
    const roots = [
      join(__dirname, '..'),
      join(__dirname, '../../../../components/dashboard'),
    ];
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== '__tests__') walk(path);
        } else if (/\.tsx?$/.test(name) && !/\.test\./.test(name)) sources.push(path);
      }
    };
    roots.forEach(walk);

    /** A quoted or template string that starts like an app address. */
    const ADDRESS = /(['"`])\/(jobs|leads|estimates|invoices|reports|schedule|service-plans|customers|settings|tasks|communication)\b/;

    it('reads the dashboard files', () => {
      expect(sources.length).toBeGreaterThan(15);
    });

    it('has no route path written into a widget, a registry or the page', () => {
      const offenders = sources
        // The quick-create menu is a different control: it creates records, it is not a tile, row or stage.
        .filter((file) => !file.endsWith('newMenu.tsx'))
        .flatMap((file) => readFileSync(file, 'utf8').split('\n').map((line, i) => ({ file, line, at: i + 1 })))
        .filter(({ line }) => !line.trim().startsWith('*') && !line.trim().startsWith('//') && ADDRESS.test(line))
        .map(({ file, at, line }) => `${file.split('/src/')[1]}:${at}  ${line.trim()}`);
      expect(offenders).toEqual([]);
    });
  });
});

describe('dashboardCompletedJobsValue', () => {
  /**
   * Roles & Permissions S09.17 - the Completed jobs value tile on the routed home page: what was invoiced on the jobs that
   * reached Completed this month, the number of those jobs, the word the server sends when the figure is the person's own
   * ("Yours"), a plain empty state, and the address the server sent.
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
  const ID = 'completed_jobs_value';

  const meta = (link: string | null, label: DashboardTileMeta['label'] = 'Yours'): DashboardTileMeta => ({
    id: ID, category: 'job_value', mode: label ? 'own' : 'company', label, link,
  });
  const answer = (link: string | null, data: unknown, label: DashboardTileMeta['label'] = 'Yours'): DashboardResponse => ({
    tiles: [meta(link, label)],
    categories: [{ id: 'job_value', label: 'Job value' }],
    data: { [ID]: data } as DashboardResponse['data'],
    generated_at: '2026-10-12T10:00:00.000Z',
  });

  /** Shows where the page has been sent. */
  function Where() {
    return <p data-testid="where">{useLocation().pathname + useLocation().search}</p>;
  }
  const where = () => screen.getByTestId('where').textContent;

  /** The page of a person whose saved layout holds the tile (as a Technician's default does). */
  function open(body: DashboardResponse) {
    serveDashboard(body, [{ id: ID, visible: true }]);
    renderDashboard({ ability: ADMIN, beside: <Where /> });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  describe('the Completed jobs value tile', () => {
    it('shows the invoiced value and the number of jobs it covers', async () => {
      open(answer('/sent-jobs', { jobs: 3, value: 1250 }));
      const tile = (await screen.findByText('Completed jobs value')).closest('button') as HTMLElement;
      expect(within(tile).getByText('$1,250')).toBeInTheDocument();
      expect(within(tile).getByText('3 jobs')).toBeInTheDocument();
    });

    it('says "1 job" for a single job', async () => {
      open(answer('/sent-jobs', { jobs: 1, value: 80 }));
      const tile = (await screen.findByText('Completed jobs value')).closest('button') as HTMLElement;
      expect(within(tile).getByText('1 job')).toBeInTheDocument();
    });

    it('carries the label the server sent when the figure is the person\'s own, and none when it is the company\'s', async () => {
      open(answer('/sent-jobs', { jobs: 2, value: 300 }, 'Yours'));
      const tile = (await screen.findByText('Completed jobs value')).closest('button') as HTMLElement;
      expect(within(tile).getByText('Yours')).toBeInTheDocument();
    });

    it('shows no label for the company\'s figure', async () => {
      open(answer('/sent-jobs', { jobs: 2, value: 300 }, null));
      const tile = (await screen.findByText('Completed jobs value')).closest('button') as HTMLElement;
      expect(within(tile).queryByText('Yours')).not.toBeInTheDocument();
      expect(within(tile).queryByText(/Your team|Your location/)).not.toBeInTheDocument();
    });

    it('says so plainly when no job reached Completed this month', async () => {
      open(answer('/sent-jobs', { jobs: 0, value: 0 }));
      expect(await screen.findByText('No jobs completed this month')).toBeInTheDocument();
    });

    it('opens the address the server sent for the tile', async () => {
      open(answer('/sent-jobs?completed_this_month=true', { jobs: 1, value: 10 }));
      fireEvent.click((await screen.findByText('Completed jobs value')).closest('button')!);
      expect(where()).toBe('/sent-jobs?completed_this_month=true');
    });

    it('is drawn but is not a control when the server sent no address (no View jobs)', async () => {
      open(answer(null, { jobs: 1, value: 10 }));
      const label = await screen.findByText('Completed jobs value');
      expect(label.closest('button')).toBeNull();
      expect(screen.getByText('$10')).toBeInTheDocument();
    });

    it('claims nothing before the first answer lands', async () => {
      serveNothing();
      renderDashboard({ ability: ADMIN });
      await screen.findByRole('button', { name: /Customize home page/ });
      expect(screen.queryByText('No jobs completed this month')).not.toBeInTheDocument();
    });

    it('is offered by the picker under the Job value category the server named, and added from there', async () => {
      serveDashboard(answer('/sent-jobs', { jobs: 0, value: 0 }), []);
      renderDashboard({ ability: ADMIN });
      fireEvent.click(await screen.findByRole('button', { name: /Customize home page/ }));
      const group = (await screen.findByText('Job value', { selector: '[data-testid="category-name"]' })).closest('[role="group"]') as HTMLElement;
      fireEvent.click(within(group).getByRole('button', { name: 'Add Completed jobs value' }));
      expect(await screen.findByText('No jobs completed this month')).toBeInTheDocument();
    });
  });
});

describe('dashboardEstimatesToSend', () => {
  /**
   * Roles & Permissions S09.18 - the Estimates still to send tile on the routed home page: a count and the draft estimates
   * that have waited longest, each row showing the estimate's number, its customer and its total and opening the estimate at
   * the address the server sent, "View all" only when the server sent the Estimates list's address, and one plain line when
   * nothing is waiting.
   *
   * The page is the routed one (pages/v2/dashboard/DashboardPage), against the JSON shape GET /api/dashboard sends. The
   * addresses in these answers are invented ones, so a page that sent anyone somewhere it knew would fail.
   */

  const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);
  const ID = 'estimates_to_send';

  const meta = (link: string | null): DashboardTileMeta => ({ id: ID, category: 'estimates', mode: 'scope', label: null, link });
  const estimate = (n: number, total: number, title = `Customer ${n}`) => ({
    id: `est-${n}`, estimate_number: `E-${n}`, title, total, link: `/sent-estimate/${n}`,
  });
  const answer = (link: string | null, data: unknown): DashboardResponse => ({
    tiles: [meta(link)],
    categories: [{ id: 'estimates', label: 'Estimates' }],
    data: { [ID]: data } as DashboardResponse['data'],
    generated_at: '2026-10-12T10:00:00.000Z',
  });

  /** Shows where the page has been sent. */
  function Where() {
    return <p data-testid="where">{useLocation().pathname + useLocation().search}</p>;
  }
  const where = () => screen.getByTestId('where').textContent;

  /** The page of a person whose saved layout holds the tile (as a Technician's or a Sales person's default does). */
  function open(body: DashboardResponse) {
    serveDashboard(body, [{ id: ID, visible: true }]);
    renderDashboard({ ability: ADMIN, beside: <Where /> });
  }
  const tileOf = async () => (await screen.findByRole('heading', { name: /Estimates still to send/ })).closest('[data-slot="card"]') as HTMLElement;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  describe('the Estimates still to send tile', () => {
    it('shows how many drafts are waiting and one row per estimate the server sent, each with its number, customer and total', async () => {
      open(answer('/sent-estimates', { count: 7, estimates: [estimate(1, 1250), estimate(2, 80.5), estimate(3, 12)] }));
      const tile = await tileOf();
      expect(within(tile).getByText('7')).toBeInTheDocument();
      expect(within(tile).getByText('E-1')).toBeInTheDocument();
      expect(within(tile).getByText('Customer 1')).toBeInTheDocument();
      expect(within(tile).getByText('$1,250.00')).toBeInTheDocument();
      expect(within(tile).getByText('$80.50')).toBeInTheDocument();
      // The tile draws the rows it was sent and no wall: three rows, not seven.
      expect(within(tile).getAllByText(/^E-\d$/)).toHaveLength(3);
    });

    it('adds up nothing: a total is shown per estimate, never a sum across the rows', async () => {
      open(answer('/sent-estimates', { count: 2, estimates: [estimate(1, 100), estimate(2, 250)] }));
      const tile = await tileOf();
      expect(within(tile).queryByText('$350.00')).not.toBeInTheDocument();
    });

    it('opens a row on the estimate at the address the server sent', async () => {
      open(answer('/sent-estimates', { count: 2, estimates: [estimate(1, 10), estimate(2, 20)] }));
      fireEvent.click((await screen.findByText('Customer 2')).closest('button')!);
      expect(where()).toBe('/sent-estimate/2');
    });

    it('sends "View all" to the address the server sent for the tile', async () => {
      open(answer('/sent-estimates?status=sent', { count: 1, estimates: [estimate(1, 10)] }));
      fireEvent.click(await screen.findByRole('button', { name: 'View all' }));
      expect(where()).toBe('/sent-estimates?status=sent');
    });

    it('offers no "View all" when the server sent no address for the tile, and the rows still open their estimates', async () => {
      open(answer(null, { count: 1, estimates: [estimate(1, 10)] }));
      const row = await screen.findByText('Customer 1');
      expect(screen.queryByRole('button', { name: 'View all' })).not.toBeInTheDocument();
      fireEvent.click(row.closest('button')!);
      expect(where()).toBe('/sent-estimate/1');
    });

    it('says so in one plain line when no estimate is waiting, with no count and no rows', async () => {
      open(answer('/sent-estimates', { count: 0, estimates: [] }));
      expect(await screen.findByText('No estimates to send')).toBeInTheDocument();
      expect(within(await tileOf()).queryByText('0')).not.toBeInTheDocument();
    });

    it('keeps a long list to the rows it was sent, with the full count and "View all" for the rest', async () => {
      open(answer('/sent-estimates', { count: 23, estimates: [1, 2, 3, 4, 5].map((n) => estimate(n, n * 10)) }));
      const tile = await tileOf();
      expect(within(tile).getByText('23')).toBeInTheDocument();
      expect(within(tile).getAllByText(/^E-\d+$/)).toHaveLength(5);
      expect(within(tile).getByRole('button', { name: 'View all' })).toBeInTheDocument();
    });

    it('lets a long customer name shrink on a 360 px screen while the number and the total keep their room', async () => {
      const original = window.innerWidth;
      window.innerWidth = 360;
      try {
        open(answer('/sent-estimates', { count: 1, estimates: [estimate(1, 1234567.89, 'A Very Long Customer Name Incorporated Holdings Of The Region')] }));
        const row = (await screen.findByText('E-1')).closest('button') as HTMLElement;
        const name = within(row).getByText(/A Very Long Customer Name/);
        // The name is the one part that gives way: it truncates inside a shrinkable box, never pushing the row wider than the card.
        expect(name).toHaveClass('truncate');
        expect(name.parentElement).toHaveClass('min-w-0', 'flex-1');
        expect(within(row).getByText('E-1')).toHaveClass('shrink-0');
        expect(within(row).getByText('$1,234,567.89')).toHaveClass('shrink-0');
        expect(row).toHaveClass('w-full');
      } finally {
        window.innerWidth = original;
      }
    });

    it('claims nothing before the first answer lands', async () => {
      serveNothing();
      renderDashboard({ ability: ADMIN });
      await screen.findByRole('button', { name: /Customize home page/ });
      expect(screen.queryByText('No estimates to send')).not.toBeInTheDocument();
    });

    it('is offered by the picker under the Estimates category the server named, and added from there', async () => {
      serveDashboard(answer('/sent-estimates', { count: 0, estimates: [] }), []);
      renderDashboard({ ability: ADMIN });
      fireEvent.click(await screen.findByRole('button', { name: /Customize home page/ }));
      const group = (await screen.findByText('Estimates', { selector: '[data-testid="category-name"]' })).closest('[role="group"]') as HTMLElement;
      fireEvent.click(within(group).getByRole('button', { name: 'Add Estimates still to send' }));
      expect(await screen.findByText('No estimates to send')).toBeInTheDocument();
    });
  });
});

describe('dashboardJobsThisMonth', () => {
  /**
   * Roles & Permissions S09.16 - the Jobs this month tile on the routed home page: how many jobs have a visit this month,
   * and the line "N finished · M still to do" over those visits.
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
  const ID = 'jobs_this_month';

  const meta = (link: string | null): DashboardTileMeta => ({ id: ID, category: 'jobs', mode: 'scope', label: null, link });
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

  /** The page of a person whose saved layout holds the tile (as a Technician's default does). */
  function open(body: DashboardResponse) {
    serveDashboard(body, [{ id: ID, visible: true }]);
    renderDashboard({ ability: ADMIN, beside: <Where /> });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  describe('the Jobs this month tile', () => {
    it('shows the number of jobs and the line "N finished · M still to do"', async () => {
      open(answer('/sent-jobs', { jobs: 6, finished: 9, still_to_do: 4 }));
      const tile = (await screen.findByText('Jobs this month')).closest('button') as HTMLElement;
      expect(within(tile).getByText('6')).toBeInTheDocument();
      expect(within(tile).getByText('9 finished · 4 still to do')).toBeInTheDocument();
    });

    it('never calls a finished visit "Completed" or "Done"', async () => {
      open(answer('/sent-jobs', { jobs: 2, finished: 3, still_to_do: 1 }));
      const tile = (await screen.findByText('Jobs this month')).closest('button') as HTMLElement;
      expect(tile.textContent).not.toMatch(/completed|done/i);
    });

    it('says so plainly when no job has a visit this month', async () => {
      open(answer('/sent-jobs', { jobs: 0, finished: 0, still_to_do: 0 }));
      expect(await screen.findByText('No jobs this month')).toBeInTheDocument();
      expect(screen.queryByText(/finished/)).not.toBeInTheDocument();
    });

    it('opens the address the server sent for the tile', async () => {
      open(answer('/sent-jobs', { jobs: 1, finished: 0, still_to_do: 1 }));
      fireEvent.click((await screen.findByText('Jobs this month')).closest('button')!);
      expect(where()).toBe('/sent-jobs');
    });

    it('is drawn but is not a control when the server sent no address (no View jobs)', async () => {
      open(answer(null, { jobs: 1, finished: 0, still_to_do: 1 }));
      const label = await screen.findByText('Jobs this month');
      expect(label.closest('button')).toBeNull();
      expect(screen.getByText('0 finished · 1 still to do')).toBeInTheDocument();
    });

    it('claims nothing before the first answer lands', async () => {
      serveNothing();
      renderDashboard({ ability: ADMIN });
      await screen.findByRole('button', { name: /Customize home page/ });
      expect(screen.queryByText('No jobs this month')).not.toBeInTheDocument();
    });

    it('is offered by the picker under the Jobs category the server named, and added from there', async () => {
      serveDashboard(answer('/sent-jobs', { jobs: 0, finished: 0, still_to_do: 0 }), []);
      renderDashboard({ ability: ADMIN });
      fireEvent.click(await screen.findByRole('button', { name: /Customize home page/ }));
      const group = (await screen.findByText('Jobs', { selector: '[data-testid="category-name"]' })).closest('[role="group"]') as HTMLElement;
      fireEvent.click(within(group).getByRole('button', { name: 'Add Jobs this month' }));
      expect(await screen.findByText('No jobs this month')).toBeInTheDocument();
    });
  });
});
