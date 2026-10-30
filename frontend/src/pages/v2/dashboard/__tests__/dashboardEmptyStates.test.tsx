/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * Roles & Permissions S09.2 - every existing tile with nothing to show says so in one plain line, in the PRD's words
 * ("No jobs today", "No open leads"), instead of a blank, a zero or an empty chart. Nothing is claimed before the
 * first answer lands, and a tile that has something to show shows it.
 *
 * The page is the routed one (pages/v2/dashboard/DashboardPage), against the JSON shape GET /api/dashboard sends for
 * a tile with nothing in it (the shapes are the backend builders' own empty results).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import type { DashboardResponse, DashboardTileCategory, DashboardTileMeta } from '@/lib/api/dashboard';
import { renderWithProviders, serveDashboard } from '@/__tests__/helpers';
import DashboardPage from '../DashboardPage';

vi.hoisted(() => {
  vi.stubEnv('VITE_DASHBOARD_USE_MOCK', 'false');
});

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
  renderWithProviders(<DashboardPage />, { ability: ADMIN });
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
    mockApi.get.mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<DashboardPage />, { ability: ADMIN });
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
