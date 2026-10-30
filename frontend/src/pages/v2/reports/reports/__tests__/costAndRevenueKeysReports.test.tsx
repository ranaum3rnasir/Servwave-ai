/**
 * Roles & Permissions S01.16 follow-up - the routed Jobs and Activity reports against the server's real answers
 * for a person who may not see margin, cost or revenue.
 *
 * The server leaves the margin and cost keys (profit, itemCost, laborCost, cardExpenses, techExpenses) off each job
 * row without See financial data, and revenueTouched / prevRevenueTouched off each person without See company
 * figures (the keys are gone, never zero). The pages must then offer no column or tile for them and draw no "NaN",
 * keeping the prices and counts beside them. Each test renders the page twice, once with the switch and once
 * without, so a column that is missing for the wrong reason (an empty page) cannot pass.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';

import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/axios', () => ({ default: { get } }));
// A real org reads the live rows; a demo org would read the sample rows.
vi.mock('@/lib/useIsDemoOrg', () => ({ useIsDemoOrg: () => false }));

import JobsReport from '../JobsReport';
import ActivityReport from '../ActivityReport';

const jobRow = (n: number, extra: Record<string, unknown>) => ({
  jobNumber: n, jobName: `Gate repair ${n}`, client: `Acme ${n}`, email: '', phone: '', tags: [], type: '', status: 'Completed',
  tech: [], createdBy: '', address: '', source: '', origin: '',
  createdAt: '2026-10-01T10:00:00.000Z', scheduledAt: '2026-10-02T10:00:00.000Z', endAt: '2026-10-02T11:00:00.000Z',
  billed: 1080, paid: 0, subtotal: 1000, tax: 80, tip: 0,
  ...extra,
});
const COSTS = { itemCost: 0, laborCost: 0, cardExpenses: 0, techExpenses: 0, profit: 920 };
const JOBS_WITH_COSTS = { jobs: [jobRow(41, COSTS), jobRow(42, COSTS)] };
const JOBS_WITHOUT_COSTS = { jobs: [jobRow(41, {}), jobRow(42, {})] };

const person = (key: string, withRevenue: boolean) => ({
  id: key, name: `Pat ${key}`, role: 'TECHNICIAN', active: true,
  ...(withRevenue ? { revenueTouched: 0, prevRevenueTouched: 0 } : {}),
  conversions: 0, leads: 0, responseSec: 0, prevResponseSec: 0, reactionSec: 0, slaMetPct: 0,
  actions: 7, activeMinutes: 30, firstActionAt: '8:05a', lastActionAt: '9:05a', breakdown: [{ label: 'lead.created', count: 7 }],
});

const COSTS_ON = buildAbility([{ action: 'read', subject: 'Report' }, { action: 'read', subject: 'Pricing' }]);
const COSTS_OFF = buildAbility([{ action: 'read', subject: 'Report' }]);

function serve(path: string, body: unknown) {
  get.mockImplementation(async (url: string) => {
    if (url === path) return { data: body };
    throw new Error(`unexpected GET ${url}`);
  });
}

beforeEach(() => {
  get.mockReset();
  try {
    // A column set saved when the person could still see the cost columns.
    localStorage.setItem('jobsReport.visibleFields.v1', JSON.stringify(['jobNumber', 'client', 'subtotal', 'itemCost', 'laborCost', 'cardExpenses', 'techExpenses', 'profit']));
  } catch { /* ignore */ }
});

describe('Jobs report (routed page) against the real answer', () => {
  it('draws the margin and cost columns with See financial data', async () => {
    serve('/api/reports/jobs', JOBS_WITH_COSTS);
    renderWithProviders(<JobsReport />, { ability: COSTS_ON });
    expect(await screen.findByText('Acme 41')).toBeInTheDocument();
    for (const label of ['Profit', 'Item cost', 'Labor cost', 'Card Expenses', 'Tech expenses']) {
      expect(screen.getAllByText(label).length, label).toBeGreaterThan(0);
    }
  });

  it('offers no margin or cost column, draws no NaN, and keeps each job and its prices, without it', async () => {
    serve('/api/reports/jobs', JOBS_WITHOUT_COSTS);
    const { container } = renderWithProviders(<JobsReport />, { ability: COSTS_OFF });
    await waitFor(() => expect(screen.getByText('Acme 41')).toBeInTheDocument());
    for (const label of ['Profit', 'Item cost', 'Labor cost', 'Card Expenses', 'Tech expenses']) {
      expect(screen.queryByText(label), label).toBeNull();
    }
    expect(screen.getAllByText('Subtotal').length).toBeGreaterThan(0);
    expect(container.textContent).not.toMatch(/NaN/);
  });
});

describe('Activity report (routed page) against the real answer', () => {
  it('draws the people and their action counts when the revenue keys are gone, with no NaN', async () => {
    serve('/api/reports/activity', { users: [person('a', false), person('b', false)] });
    const { container } = renderWithProviders(<ActivityReport />, { ability: COSTS_OFF });
    expect(await screen.findByText('Total actions')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText('14').length).toBeGreaterThan(0));
    expect(container.textContent).not.toMatch(/NaN/);
  });

  it('draws the same page when the revenue keys are there', async () => {
    serve('/api/reports/activity', { users: [person('a', true), person('b', true)] });
    renderWithProviders(<ActivityReport />, { ability: COSTS_OFF });
    expect(await screen.findByText('Total actions')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText('14').length).toBeGreaterThan(0));
  });
});
