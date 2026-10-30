/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * Roles & Permissions, scenario pass 3 fixes on the routed home page: every Needs Attention item can be reached, a tile
 * title breaks between words only, and a count of one reads in the singular.
 *
 * The page is the routed one (pages/v2/dashboard/DashboardPage), against the JSON shape GET /api/dashboard sends.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';

import { buildAbility } from '@/lib/ability';
import type { DashboardResponse, DashboardTileMeta } from '@/lib/api/dashboard';
import { renderWithProviders, serveDashboard } from '@/__tests__/helpers';
import DashboardPage from '../DashboardPage';

vi.hoisted(() => {
  vi.stubEnv('VITE_DASHBOARD_USE_MOCK', 'false');
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);

const meta = (id: string, category: DashboardTileMeta['category'], label: DashboardTileMeta['label'] = null): DashboardTileMeta => ({
  id, category, mode: label ? 'own' : 'company', label, link: null,
});
function open(tiles: DashboardTileMeta[], data: Record<string, unknown>) {
  const body: DashboardResponse = {
    tiles,
    categories: [
      { id: 'jobs', label: 'Jobs' },
      { id: 'invoices_and_payments', label: 'Invoices and payments' },
      { id: 'job_value', label: 'Job value' },
      { id: 'company_figures', label: 'Company figures' },
    ],
    data: data as DashboardResponse['data'],
    generated_at: '2026-10-13T10:00:00.000Z',
  };
  serveDashboard(body, tiles.map((t) => ({ id: t.id, visible: true })));
  renderWithProviders(<DashboardPage />, { ability: ADMIN });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

type Severity = 'danger' | 'warning' | 'info';
const item = (n: number, severity: Severity, type = 'overdue_invoice') => ({
  id: `item-${n}`, type, severity, title: `Item ${n}`, meta: 'meta', badge: `${n}d`, link: `/sent/${n}`,
});

describe('Needs Attention reaches every item the answer holds', () => {
  const needsAttention = async () => (await screen.findByRole('heading', { name: 'Needs Attention' })).closest('[data-slot="card"]') as HTMLElement;
  const rows = (card: HTMLElement) => within(card).getAllByRole('button', { name: /^Item \d+/ });

  it('draws six rows and "Show N more" for the rest, and the control reveals every item in the server\'s order', async () => {
    // Danger, warning, info, the last one being the mildest, which the old six-row cap never drew.
    const items = [
      ...Array.from({ length: 8 }, (_, i) => item(i, 'danger')),
      ...Array.from({ length: 8 }, (_, i) => item(8 + i, 'warning', 'missing_crew')),
      ...Array.from({ length: 6 }, (_, i) => item(16 + i, 'info', 'missing_lead_owner')),
    ];
    open([meta('needs_attention', 'jobs')], { needs_attention: items });
    const card = await needsAttention();

    expect(rows(card)).toHaveLength(6);
    expect(within(card).queryByText('Item 21')).not.toBeInTheDocument();
    // The header count is the whole answer, not the six drawn.
    expect(within(card).getByText('22')).toBeInTheDocument();

    fireEvent.click(within(card).getByRole('button', { name: 'Show 16 more' }));

    expect(rows(card).map((r) => r.textContent?.match(/Item \d+/)?.[0])).toEqual(items.map((i) => i.title));
    expect(within(card).getByText('Item 21')).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /Show \d+ more/ })).not.toBeInTheDocument();
  });

  it('puts the six back with "Show fewer"', async () => {
    open([meta('needs_attention', 'jobs')], { needs_attention: Array.from({ length: 20 }, (_, i) => item(i, 'info')) });
    const card = await needsAttention();
    fireEvent.click(within(card).getByRole('button', { name: 'Show 14 more' }));
    expect(rows(card)).toHaveLength(20);

    fireEvent.click(within(card).getByRole('button', { name: 'Show fewer' }));

    expect(rows(card)).toHaveLength(6);
    expect(within(card).getByRole('button', { name: 'Show 14 more' })).toBeInTheDocument();
  });

  it('keeps a long expanded list inside the card, scrolling on its own', async () => {
    open([meta('needs_attention', 'jobs')], { needs_attention: Array.from({ length: 60 }, (_, i) => item(i, 'info')) });
    const card = await needsAttention();
    fireEvent.click(within(card).getByRole('button', { name: 'Show 54 more' }));

    const list = rows(card)[0]!.parentElement!;
    expect(rows(card)).toHaveLength(60);
    expect(list.className).toMatch(/max-h-/);
    expect(list.className).toMatch(/overflow-y-auto/);
  });

  it('offers no control when everything is already drawn', async () => {
    open([meta('needs_attention', 'jobs')], { needs_attention: Array.from({ length: 6 }, (_, i) => item(i, 'danger')) });
    const card = await needsAttention();
    expect(rows(card)).toHaveLength(6);
    expect(within(card).queryByRole('button', { name: /Show/ })).not.toBeInTheDocument();
  });
});

describe('a count of one reads in the singular', () => {
  const collected = (jobs_done: number) => ({ 'kpi.collected_today': { amount: 349, jobs_done } });

  it.each([[0, '0 jobs completed'], [1, '1 job completed'], [2, '2 jobs completed']])('Collected Today with %i jobs done reads "%s"', async (done, words) => {
    open([meta('kpi.collected_today', 'invoices_and_payments')], collected(done));
    expect(await screen.findByText(words)).toBeInTheDocument();
  });

  it.each([[1, '1 active plan'], [4, '4 active plans']])('Recurring with %i active plans reads "%s"', async (active_plans, words) => {
    open([meta('kpi.recurring', 'company_figures')], { 'kpi.recurring': { mrr: 900, active_plans } });
    expect(await screen.findByText(words)).toBeInTheDocument();
  });
});

describe('a tile title breaks between words only', () => {
  // jsdom has no layout; the real-browser proof is the verifier's 390 px screenshot. What a test can hold is the structure
  // that makes the break happen: the title and the scope chip wrap as a group, so the chip drops below the title instead of
  // squeezing the title (a sibling that never shrinks) down to a few letters.
  it('wraps the title and its scope chip as a group on the Completed jobs value tile', async () => {
    open([meta('completed_jobs_value', 'job_value', 'Yours')], { completed_jobs_value: { jobs: 3, value: 1250 } });
    const title = await screen.findByText('Completed jobs value');
    const group = title.parentElement!;

    expect(group).toHaveAttribute('data-slot', 'kpi-heading');
    expect(group.className).toContain('flex-wrap');
    expect(within(group).getByText('Yours')).toBeInTheDocument();
    expect(title.className).not.toMatch(/shrink-0|whitespace-nowrap/);
    expect(title.className).not.toMatch(/break-all/);
  });

  it('does the same for every KPI tile that carries a scope chip', async () => {
    const ids: Array<[string, DashboardTileMeta['category'], string, unknown]> = [
      ['kpi.collected_today', 'invoices_and_payments', 'Collected Today', { amount: 10, jobs_done: 1 }],
      ['jobs_this_month', 'jobs', 'Jobs this month', { jobs: 2, finished: 1, still_to_do: 1 }],
      ['completed_jobs_value', 'job_value', 'Completed jobs value', { jobs: 2, value: 10 }],
    ];
    open(ids.map(([id, category]) => meta(id, category, 'Your team')), Object.fromEntries(ids.map(([id, , , data]) => [id, data])));
    for (const [, , title] of ids) {
      const group = (await screen.findByText(title)).parentElement!;
      expect(group.className).toContain('flex-wrap');
      expect(within(group).getByText('Your team')).toBeInTheDocument();
    }
  });
});
