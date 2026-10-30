/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import CatalogDrawer from '../CatalogDrawer';
import { WIDGETS } from '../widgetRegistry';
import type { DashboardTileCategory, DashboardTileCategoryGroup, DashboardTileMeta } from '@/lib/api/dashboard';

const tile = (id: string, category: DashboardTileCategory): DashboardTileMeta => ({ id, category, mode: 'company', label: null, link: null });
const group = (id: DashboardTileCategory, label: string): DashboardTileCategoryGroup => ({ id, label });

/** What the server sends a person who holds View leads and nothing else (the catalog's own answer, written out). */
const LEADS_ONLY_TILES = [
  tile('kpi.close_rate', 'leads'), tile('kpi.open_leads', 'leads'), tile('lead_sources', 'leads'),
  tile('needs_attention', 'each_record'), tile('pipeline', 'each_record'), tile('recent_activity', 'each_record'),
];
const LEADS_ONLY_CATEGORIES = [group('leads', 'Leads'), group('each_record', 'Across your records')];

/** Every tile of the registry on offer, grouped by invented-but-distinct categories, the way an Admin's answer is. */
const ADMIN_CATEGORIES = [
  group('jobs', 'Jobs'), group('leads', 'Leads'), group('invoices_and_payments', 'Invoices and payments'),
  group('company_figures', 'Company figures'), group('communication', 'Communication'), group('each_record', 'Across your records'),
];
const CATEGORY_OF: Record<string, DashboardTileCategory> = {
  'kpi.revenue_mtd': 'invoices_and_payments', 'kpi.collected_today': 'invoices_and_payments', 'kpi.ar': 'invoices_and_payments',
  'kpi.avg_ticket': 'invoices_and_payments', 'kpi.deposits': 'invoices_and_payments', revenue_chart: 'invoices_and_payments',
  'kpi.recurring': 'company_figures', smart_insights: 'company_figures', revenue_by_job_type: 'company_figures',
  'kpi.close_rate': 'leads', 'kpi.open_leads': 'leads', lead_sources: 'leads',
  needs_attention: 'each_record', pipeline: 'each_record', recent_activity: 'each_record',
  recent_calls: 'communication',
};
const everyTile = Object.keys(WIDGETS).map((id) => tile(id, CATEGORY_OF[id] ?? 'jobs'));

const props = { open: true, layout: [], onAdd: vi.fn(), onClose: vi.fn() };

const originalMatchMedia = window.matchMedia;
/** Answers matchMedia the way a window of this width would (the hooks read min/max-width). */
function windowWidth(px: number) {
  window.matchMedia = vi.fn((query: string) => {
    const q = query.replace(/\s+/g, '');
    const widths = [...q.matchAll(/\((max|min)-width:([\d.]+)px\)/g)];
    const matches = widths.length > 0 && widths.every(([, k, v]) => (k === 'max' ? px <= Number(v) : px >= Number(v)));
    return {
      matches, media: query, onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    };
  }) as unknown as typeof window.matchMedia;
}
afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

// #371 (hardening) - same bug class as the sidebar overflow: a long widget title
// in the w-64 catalog drawer row would push the ✓/＋ affordance out of view.
// jsdom cannot measure layout overflow, so the tests pin the CSS contract:
// title span `min-w-0 truncate` so the flex item shrinks + ellipsizes.
describe('CatalogDrawer', () => {
  it('truncates widget titles so the add (＋) affordance always stays in view', () => {
    render(<CatalogDrawer {...props} tiles={everyTile} categories={ADMIN_CATEGORIES} />);

    const title = screen.getByText('Dispatch Scoreboard');
    expect(title).toHaveClass('truncate');
    expect(title).toHaveClass('min-w-0');
    // Full name stays discoverable on hover once truncated.
    expect(title).toHaveAttribute('title', 'Dispatch Scoreboard');

    // The matching add button (aria-label) is present alongside the title.
    expect(
      screen.getByRole('button', { name: 'Add Dispatch Scoreboard' })
    ).toBeInTheDocument();
  });

  // PRD 9: the picker offers only the tiles the server says this person has.
  it('lists only the tiles the person is eligible for', () => {
    render(<CatalogDrawer {...props} tiles={[tile('kpi.jobs_today', 'jobs'), tile('coming_up', 'jobs')]} categories={[group('jobs', 'Jobs')]} />);

    expect(screen.getByRole('button', { name: 'Add Jobs Today' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Coming Up' })).toBeInTheDocument();
    expect(screen.queryByText('Dispatch Scoreboard')).not.toBeInTheDocument();
    expect(screen.queryByText('Unpaid Balance')).not.toBeInTheDocument();
  });

  it('says so, and offers nothing, for a person with no eligible tile', () => {
    render(<CatalogDrawer {...props} tiles={[]} categories={[]} />);

    expect(screen.queryByRole('button', { name: /^Add / })).not.toBeInTheDocument();
    expect(screen.getByText('No tiles are available with your access.')).toBeInTheDocument();
  });
});

describe('CatalogDrawer groups by the category the server sent (S09.2)', () => {
  it('puts each tile under its category\'s name, and the old display groups are gone', () => {
    render(<CatalogDrawer {...props} tiles={everyTile} categories={ADMIN_CATEGORIES} />);

    const leads = screen.getByRole('group', { name: 'Leads' });
    expect(within(leads).getByRole('button', { name: 'Add Open Leads' })).toBeInTheDocument();
    expect(within(leads).queryByRole('button', { name: 'Add Jobs Today' })).not.toBeInTheDocument();
    const jobs = screen.getByRole('group', { name: 'Jobs' });
    expect(within(jobs).getByRole('button', { name: 'Add Jobs Today' })).toBeInTheDocument();
    const across = screen.getByRole('group', { name: 'Across your records' });
    for (const name of ['Needs Attention', 'Revenue Pipeline', 'Recent Activity']) {
      expect(within(across).getByRole('button', { name: `Add ${name}` }), name).toBeInTheDocument();
    }
    for (const retired of ['KPI', 'Operations', 'Financial', 'Sales', 'Pipeline', 'Team']) {
      expect(screen.queryByText(retired), retired).not.toBeInTheDocument();
    }
  });

  it('shows the groups in the order the server sent them', () => {
    render(<CatalogDrawer {...props} tiles={everyTile} categories={ADMIN_CATEGORIES} />);

    const names = screen.getAllByRole('group').map((g) => within(g).getByTestId('category-name').textContent);
    expect(names).toEqual(ADMIN_CATEGORIES.map((c) => c.label));
  });

  it('shows a person with only View leads just the Leads tiles and the all-records tiles', () => {
    render(<CatalogDrawer {...props} tiles={LEADS_ONLY_TILES} categories={LEADS_ONLY_CATEGORIES} />);

    expect(screen.getAllByRole('group').map((g) => within(g).getByTestId('category-name').textContent)).toEqual(['Leads', 'Across your records']);
    const added = screen.getAllByRole('button', { name: /^Add / }).map((b) => b.getAttribute('aria-label'));
    expect(added.sort()).toEqual(
      ['Add Close Rate', 'Add Top Lead Sources', 'Add Needs Attention', 'Add Open Leads', 'Add Recent Activity', 'Add Revenue Pipeline'].sort(),
    );
    for (const absent of ['Jobs', 'Invoices and payments', 'Company figures']) {
      expect(screen.queryByText(absent), absent).not.toBeInTheDocument();
    }
  });

  it('does not show a category that has no eligible tile, even if it is listed', () => {
    render(<CatalogDrawer {...props} tiles={[tile('kpi.jobs_today', 'jobs')]} categories={[group('jobs', 'Jobs'), group('leads', 'Leads'), group('costs', 'Costs')]} />);

    expect(screen.getAllByRole('group')).toHaveLength(1);
    expect(screen.queryByText('Leads')).not.toBeInTheDocument();
    expect(screen.queryByText('Costs')).not.toBeInTheDocument();
  });

  it('ignores a tile the page has no widget for, and drops a group that leaves empty', () => {
    render(<CatalogDrawer {...props} tiles={[tile('kpi.jobs_today', 'jobs'), tile('not_a_widget', 'leads')]} categories={[group('jobs', 'Jobs'), group('leads', 'Leads')]} />);

    expect(screen.queryByText('Leads')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Jobs Today' })).toBeInTheDocument();
  });

  it('marks a tile already on the page, and adds one by its id', () => {
    const onAdd = vi.fn();
    render(<CatalogDrawer {...props} onAdd={onAdd} layout={[{ id: 'kpi.open_leads', visible: true }]} tiles={LEADS_ONLY_TILES} categories={LEADS_ONLY_CATEGORIES} />);

    expect(screen.queryByRole('button', { name: 'Add Open Leads' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add Close Rate' }));
    expect(onAdd).toHaveBeenCalledWith('kpi.close_rate');
  });

  it('search keeps the groups, hides the ones with no match, and says when nothing matches', () => {
    render(<CatalogDrawer {...props} tiles={everyTile} categories={ADMIN_CATEGORIES} />);
    const search = screen.getByRole('searchbox', { name: 'Search widgets' });

    fireEvent.change(search, { target: { value: 'close rate' } });
    expect(screen.getAllByRole('group')).toHaveLength(1);
    expect(within(screen.getByRole('group', { name: 'Leads' })).getByRole('button', { name: 'Add Close Rate' })).toBeInTheDocument();

    fireEvent.change(search, { target: { value: 'zzzz' } });
    expect(screen.queryAllByRole('group')).toHaveLength(0);
    expect(screen.getByText('No tiles match your search.')).toBeInTheDocument();
  });

  // Ran rejected a screen on this run because a list did not scale: with every tile on offer (the Admin case) the
  // picker scrolls inside itself, on a phone and on a desktop, rather than growing past the screen.
  it.each([
    ['a desktop', 1280, 'aside'],
    ['a phone', 393, '[role="dialog"]'],
  ])('with every tile on offer on %s, the picker has its own scroll and keeps every group reachable', (_name, width, selector) => {
    windowWidth(width);
    render(<CatalogDrawer {...props} tiles={everyTile} categories={ADMIN_CATEGORIES} />);

    const panel = document.querySelector(selector) as HTMLElement;
    expect(panel).not.toBeNull();
    expect(panel.className).toMatch(/overflow-y-auto/);
    expect(panel.className).toMatch(/max-h-/);
    expect(panel.className).toMatch(/overscroll-contain/);
    expect(within(panel).getAllByRole('group')).toHaveLength(ADMIN_CATEGORIES.length);
    expect(within(panel).getAllByRole('button', { name: /^Add / })).toHaveLength(everyTile.length);
    // The search stays inside the scrolling panel, so a long list never pushes it off the screen.
    expect(within(panel).getByRole('searchbox', { name: 'Search widgets' })).toBeInTheDocument();
  });
});
