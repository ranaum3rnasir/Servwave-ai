/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';

import type { DashboardTileData, DashboardTileMeta } from '@/lib/api/dashboard';
import type { WidgetRenderCtx } from '@/lib/dashboard/layoutTypes';

import { V2_WIDGETS } from '../../widgetRegistry';

// Roles & Permissions S09.1 - the server answers each person in their own figures: a money tile is the company's or the
// person's own ("Yours"), the revenue goal and the revenue column belong to company figures and are simply not sent
// without them. The routed page's widgets draw what they are sent: no goal line and no "$" on a scoreboard row when
// the server left the key off, and the label the server sent beside the title.

const companyData: DashboardTileData = {
  'kpi.revenue_mtd': { invoiced: 9000, collected: 7000, collected_last_month: 6000, vs_last_month_pct: 16, target: 55000, pct_of_goal: 13 },
  'kpi.collected_today': { amount: 800, jobs_done: 3 },
  revenue_chart: { target: 55000, months: [{ month: 'Oct', invoiced: 9000, collected: 7000, is_current: true }] },
  tech_scoreboard: [
    { user_id: 'u1', name: 'Tess Tech', revenue: 5000, jobs: 4 },
    { user_id: 'u2', name: 'Ula Tech', revenue: 100, jobs: 1 },
  ],
  dispatch_scoreboard: [{ user_id: 'u3', name: 'Dee Dispatch', revenue: 8000, jobs: 6 }],
  lead_sources: [{ source: 'google', label: 'Google', lead_pct: 60, revenue: 4000, link: null }],
};

/** What the server sends a person without See company figures: their own money, no goal, no revenue column. */
const ownData: DashboardTileData = {
  'kpi.revenue_mtd': { invoiced: 900, collected: 700, collected_last_month: 600, vs_last_month_pct: 16 },
  'kpi.collected_today': { amount: 80 },
  revenue_chart: { months: [{ month: 'Oct', invoiced: 900, collected: 700, is_current: true }] },
  tech_scoreboard: companyData.tech_scoreboard!.map(({ revenue: _r, ...e }) => e),
  dispatch_scoreboard: companyData.dispatch_scoreboard!.map(({ revenue: _r, ...e }) => e),
  lead_sources: companyData.lead_sources!.map(({ revenue: _r, ...e }) => e),
};

const YOURS: DashboardTileMeta = { id: 'kpi.revenue_mtd', category: 'invoices_and_payments', mode: 'own', label: 'Yours', link: null };
const ctx = (data: DashboardTileData, tile?: DashboardTileMeta): WidgetRenderCtx => ({ data, tile, range: 'all', navigate: () => undefined, isLoading: false });
const draw = (id: string, data: DashboardTileData, tile?: DashboardTileMeta) => V2_WIDGETS[id]!.render(ctx(data, tile));
const textOf = (id: string, data: DashboardTileData, tile?: DashboardTileMeta) => render(<>{draw(id, data, tile)}</>).container.textContent ?? '';

describe('the routed dashboard without company figures', () => {
  it('keeps each person and their job count on a scoreboard, in the order the server sent, with no dollar figure', () => {
    const { container } = render(<>{draw('tech_scoreboard', ownData)}</>);
    const text = container.textContent ?? '';
    expect(text).toContain('Tess Tech');
    expect(text).toContain('4 jobs');
    expect(text).toContain('Ula Tech');
    expect(text).toContain('1 job');
    expect(text).not.toMatch(/\$/);
    // Bars are drawn from job count: the 4-job row is full width and the 1-job row is the shortest bar (at its floor).
    const bars = Array.from(container.querySelectorAll<HTMLElement>('[style*="width"]')).map((b) => b.style.width);
    expect(bars).toEqual(['100%', '25%']);
  });

  it('shows the dispatch board the same way', () => {
    const text = textOf('dispatch_scoreboard', ownData);
    expect(text).toContain('Dee Dispatch');
    expect(text).toContain('6 jobs');
    expect(text).not.toMatch(/\$/);
  });

  it('shows the lead sources and their share with no revenue', () => {
    const text = textOf('lead_sources', ownData);
    expect(text).toContain('Google');
    expect(text).toContain('60%');
    expect(text).not.toMatch(/\$|revenue/);
  });

  it('still shows the dollar figures on the scoreboards and lead sources when the server sent them', () => {
    expect(textOf('tech_scoreboard', companyData)).toMatch(/\$5,000/);
    expect(textOf('lead_sources', companyData)).toMatch(/\$4,000/);
  });

  it('draws Monthly Revenue with no goal when the server sent none, and the invoiced figure in its place', () => {
    const own = textOf('kpi.revenue_mtd', ownData, YOURS);
    expect(own).toContain('$700');
    expect(own).toContain('$900 invoiced');
    expect(own).not.toMatch(/goal/);
    expect(textOf('kpi.revenue_mtd', companyData)).toMatch(/13% of \$55,000 goal/);
  });

  it('shows the label the server sent beside a money tile\'s title, and none for a company-mode tile', () => {
    expect(textOf('kpi.revenue_mtd', ownData, YOURS)).toContain('Yours');
    expect(textOf('kpi.revenue_mtd', companyData, { ...YOURS, mode: 'company', label: null })).not.toContain('Yours');
    const team = { id: 'revenue_chart', category: 'invoices_and_payments', mode: 'scope', label: 'Your team', link: null } as const;
    expect(textOf('revenue_chart', ownData, team)).toContain('Your team');
    expect(textOf('pipeline', { pipeline: [] }, { id: 'pipeline', category: 'each_record', mode: 'own', label: 'Yours', link: null })).toContain('Yours');
  });

  it('draws the jobs count under Collected Today only when the server sent it', () => {
    expect(textOf('kpi.collected_today', companyData)).toContain('3 jobs completed');
    expect(textOf('kpi.collected_today', ownData, YOURS)).not.toMatch(/jobs (done|completed)/);
  });

  it('draws the chart with no target line when the server sent no target', () => {
    const { container } = render(<>{draw('revenue_chart', ownData)}</>);
    expect(container.textContent).not.toContain('Target');
    expect(render(<>{draw('revenue_chart', companyData)}</>).container.textContent).toContain('Target');
  });
});
