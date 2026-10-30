/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * Roles & Permissions S09.1 - the routed dashboard draws the answer it is sent, keyed by tile id: only the tiles the
 * server says this person has, the label the server sent beside a money tile's title, a picker that offers only those
 * tiles, and a plain line (with the customize button) when the person's access unlocks no tile.
 *
 * The page is the routed one (pages/v2/dashboard/DashboardPage), against the same JSON shape GET /api/dashboard sends.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import { buildAbility } from '@/lib/ability';
import type { DashboardResponse, DashboardTileMeta } from '@/lib/api/dashboard';
import { renderWithProviders, serveDashboard } from '@/__tests__/helpers';
import DashboardPage from '../DashboardPage';

// The dashboard seam reads VITE_DASHBOARD_USE_MOCK once, when its module loads: pin it to the live (mocked axios) path.
vi.hoisted(() => {
  vi.stubEnv('VITE_DASHBOARD_USE_MOCK', 'false');
});

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
    renderWithProviders(<DashboardPage />, { ability: ADMIN });

    // The default layout lists Open Leads, Unpaid Balance, the scoreboards and more: none of them is this person's.
    expect(await screen.findByText('Jobs Today')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Open Leads')).not.toBeInTheDocument());
    for (const absent of ['Unpaid Balance', 'Tech Scoreboard', 'Dispatch Scoreboard', 'Close Rate', 'Smart Insights']) {
      expect(screen.queryByText(absent), absent).not.toBeInTheDocument();
    }
  });

  it('shows the server\'s label next to a money tile\'s title, and none on a count tile', async () => {
    serve(answer);
    renderWithProviders(<DashboardPage />, { ability: ADMIN });

    const revenue = (await screen.findByText('Monthly Revenue')).closest('button')!;
    expect(revenue).toHaveTextContent('Yours');
    expect(screen.getByText('Jobs Today').closest('button')).not.toHaveTextContent('Yours');
    // The company's goal is not in the answer, so it is not drawn.
    expect(revenue).not.toHaveTextContent(/goal/);
  });

  it('shows no label on a company-mode money tile', async () => {
    serve({ ...answer, tiles: [meta('kpi.revenue_mtd', 'invoices_and_payments', 'company', null)] });
    renderWithProviders(<DashboardPage />, { ability: ADMIN });

    const revenue = (await screen.findByText('Monthly Revenue')).closest('button')!;
    expect(revenue).not.toHaveTextContent('Yours');
  });

  it('offers only the eligible tiles in Customize home page', async () => {
    serve(answer);
    renderWithProviders(<DashboardPage />, { ability: ADMIN });
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
    renderWithProviders(<DashboardPage />, { ability: ADMIN });
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
    renderWithProviders(<DashboardPage />, { ability: ADMIN });
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
    renderWithProviders(<DashboardPage />, { ability: ADMIN });

    expect(await screen.findByText('No tiles are available with your access.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Customize home page/ })).toBeInTheDocument();
    expect(screen.queryByText('Jobs Today')).not.toBeInTheDocument();
  });

  it('does not show the no-tiles line to a person who has tiles', async () => {
    serve(answer);
    renderWithProviders(<DashboardPage />, { ability: ADMIN });
    await screen.findByText('Jobs Today');

    expect(screen.queryByText('No tiles are available with your access.')).not.toBeInTheDocument();
  });
});
