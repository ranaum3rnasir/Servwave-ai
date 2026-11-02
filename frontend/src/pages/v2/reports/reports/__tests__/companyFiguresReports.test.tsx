/**
 * Roles & Permissions S01.16 - the routed report pages for a person without See company figures.
 *
 * The server leaves the money totals out of a report response (the keys are gone, never zero). The pages must then
 * show a dash where a total would be, never "$0" or "$NaN", and keep the counts and rates beside it. Each payload
 * is the with-figures payload with the money keys taken off, which is what the server sends.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';

import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import { buildReport, type ReportFilters } from '@/lib/reports/estimate-conversion-logic';
import { DEMO_ROWS } from '@/lib/reports/estimate-conversion-data';

// Charts measure their container; jsdom has none.
vi.mock('recharts', async (orig) => {
  const actual = await orig<typeof import('recharts')>();
  return { ...actual, ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div> };
});

const FILTERS: ReportFilters = {
  anchor: 'created', from: new Date('2026-01-01T00:00:00Z'), to: new Date('2026-12-31T00:00:00Z'),
  repId: 'all', source: 'all', jobType: 'all', model: 'decided',
} as ReportFilters;
const WITH_FIGURES = buildReport(DEMO_ROWS, FILTERS, new Date('2026-10-10T12:00:00Z'));

const MONEY_KEY = /Value$|^value$|^avgTicket/;
/** What the server sends a person without the switch: every dollar total and average ticket gone, counts and rates kept. */
function withoutMoney(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutMoney);
  if (node && typeof node === 'object') {
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>).filter(([k]) => !MONEY_KEY.test(k)).map(([k, v]) => [k, withoutMoney(v)]),
    );
  }
  return node;
}

let payload: unknown = WITH_FIGURES;
vi.mock('@/lib/reports/estimate-conversion-data', async (orig) => {
  const actual = await orig<typeof import('@/lib/reports/estimate-conversion-data')>();
  return {
    ...actual,
    useEstimateConversionReport: () => ({ data: payload, isLoading: false, isError: false }),
    useConversionDrilldown: () => ({ data: { total: 0, truncated: false, rows: [] }, isLoading: false }),
  };
});

let feesPayload: unknown = undefined;
vi.mock('@/lib/reports/payment-fees-data', () => ({
  usePaymentFeesReport: () => ({ data: feesPayload, isLoading: false }),
}));
vi.mock('@/lib/reports/payments-report-data', async (orig) => {
  const actual = await orig<typeof import('@/lib/reports/payments-report-data')>();
  return { ...actual, usePaymentsReport: () => ({ rows: [], now: new Date('2026-10-10T12:00:00Z'), isLoading: false }) };
});

import EstimateConversionReport from '../EstimateConversionReport';
import PaymentsReport from '../PaymentsReport';

// The payments page offers its fee tiles only to a person who can see company figures at all; the server then decides the sums.
// See company figures needs See prices.
const ABILITY = buildAbility([
  { action: 'read', subject: 'Report' },
  { action: 'read', subject: 'CompanyFigures' },
  { action: 'read', subject: 'Prices' },
]);

describe('Estimate conversion report (routed page) without See company figures', () => {
  beforeEach(() => {
    payload = WITH_FIGURES;
  });

  it('shows dollar totals with the figures', () => {
    renderWithProviders(<EstimateConversionReport />, { ability: ABILITY });
    expect(screen.getByText('Quoted Value').parentElement?.textContent).toMatch(/\$\d/);
    expect(screen.getByText('Sent $')).toBeInTheDocument();
    expect(screen.getByText('Sent vs Won by month')).toBeInTheDocument();
  });

  it('has no dollar tile, column or figure, keeps the counts and rates, and never draws a zero or NaN', () => {
    payload = withoutMoney(WITH_FIGURES);
    const { container } = renderWithProviders(<EstimateConversionReport />, { ability: ABILITY });
    for (const label of ['Quoted Value', 'Won Value', 'Avg ticket (won)', 'Avg ticket (lost)', 'Sent $', 'Won $', 'Lost $', 'Open $']) {
      expect(screen.queryByText(label), label).toBeNull();
    }
    expect(screen.getByText('Total Quotes').parentElement?.textContent).toContain(String(WITH_FIGURES.summary.totalCount));
    expect(screen.getByText('Conv. %')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\$\s?\d|NaN/);
  });

  it('draws the monthly chart as conversion only, since every bar of the quoted-and-won chart is company money', () => {
    payload = withoutMoney(WITH_FIGURES);
    renderWithProviders(<EstimateConversionReport />, { ability: ABILITY });
    expect(screen.queryByText('Sent vs Won by month')).toBeNull();
    expect(screen.getByText('Conversion by month')).toBeInTheDocument();
  });
});

describe('Payments report (routed page): the card-fee and tip tiles', () => {
  const FEES = { from: '2026-07-01', to: '2026-10-10', gross: 900, charged: 950, stripeFees: 30, platformFees: 5, net: 915, reconciledCount: 4, serviceFees: 33.5, serviceFeeCount: 4, tips: 12, tipCount: 2 };
  // What the server sends a person without the switch: the window and the counts, no dollar sum.
  const { gross: _g, charged: _c, stripeFees: _s, platformFees: _p, net: _n, serviceFees: _f, tips: _t, ...WITHOUT } = FEES;

  it('shows the tiles with the figures', () => {
    feesPayload = FEES;
    renderWithProviders(<PaymentsReport />, { ability: ABILITY });
    expect(screen.getByText('Card service fee')).toBeInTheDocument();
    expect(screen.getByText('Customer tips')).toBeInTheDocument();
  });

  it('draws neither tile, rather than a $0, when the server left the sums out', () => {
    feesPayload = WITHOUT;
    renderWithProviders(<PaymentsReport />, { ability: ABILITY });
    expect(screen.queryByText('Card service fee')).toBeNull();
    expect(screen.queryByText('Customer tips')).toBeNull();
  });
});
