// "Collected on top of the invoice" summary block on the Payments report (F5, slug
// "payments"), sourced from GET /api/reports/payment-fees.
//
// Two tiles, one card (Plan A, 2026-08-04, D-A5): the card service fee (customer-paid,
// the org never sees it - it splits between Stripe and ServWave) and the customer tip
// (customer-paid, the org keeps all of it). What they share is the property that defines
// this card - collected on top of the invoice face value, never entering invoice totals
// (D1/D10). This block used to also break the payment down into Gross / Stripe fee /
// ServWave platform fee / Net; it no longer does - what the processor and the platform
// each take is ours to reconcile, not the org's to read.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import { renderWithProviders } from './helpers';
import ReportRoute from '@/pages/reports/ReportRoute';
import type { PaymentFeesPayload } from '@/lib/reports/payment-fees-data';

const hoisted = vi.hoisted(() => ({
  usePaymentFeesReport: vi.fn(),
}));

vi.mock('@/lib/reports/payment-fees-data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/reports/payment-fees-data')>();
  return { ...actual, usePaymentFeesReport: hoisted.usePaymentFeesReport };
});

// The main transaction list's own data source — stub to an empty, settled
// result so this test only exercises the new fee-summary block, not the
// (unrelated, already-covered) transaction table.
vi.mock('@/lib/reports/payments-report-data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/reports/payments-report-data')>();
  return { ...actual, usePaymentsReport: () => ({ rows: [], now: new Date('2026-06-07T12:00:00.000Z'), isLoading: false }) };
});

// Real (non-demo) org — the catalog `live: true` flip is what lets the route
// through canShowReport; a stub here would mean the wiring regressed.
vi.mock('@/lib/useIsDemoOrg', () => ({ useIsDemoOrg: () => false }));

const PAYLOAD: PaymentFeesPayload = {
  from: '2025-07-17T00:00:00.000Z',
  to: '2026-07-17T00:00:00.000Z',
  gross: 6000,
  stripeFees: 180,
  platformFees: 30,
  net: 5790,
  reconciledCount: 12,
  serviceFees: 210,
  serviceFeeCount: 12,
  tips: 80,
  tipCount: 1,
};

function renderReport() {
  return renderWithProviders(
    <Routes>
      <Route path="/reports/:slug" element={<ReportRoute />} />
    </Routes>,
    { initialEntries: ['/reports/payments'] },
  );
}

async function findCard() {
  const heading = await screen.findByText('Collected on top of the invoice');
  return heading.closest('.shadow-card') as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.usePaymentFeesReport.mockReturnValue({ data: PAYLOAD, isLoading: false, isError: false });
});

describe('Collected on top of the invoice summary', () => {
  it('renders the collected service fee and the collected tip from the payload, each in its own tile', async () => {
    renderReport();
    const card = await findCard();

    expect(within(card).getByText('Card service fee')).toBeInTheDocument();
    expect(within(card).getByText('$210.00')).toBeInTheDocument();

    expect(within(card).getByText('Customer tips')).toBeInTheDocument();
    expect(within(card).getByText('$80.00')).toBeInTheDocument();
  });

  // The whole point of the change: the org sees what it collected, never how the
  // processor/platform costs behind it split. Guard each retired figure by label AND
  // by value, so re-adding a tile under a new name still reddens this.
  it('does not break the payment down into gross, net, or processing costs', async () => {
    renderReport();
    const card = await findCard();

    for (const label of [/gross/i, /^net$/i, /stripe/i, /platform fee/i]) {
      expect(within(card).queryByText(label)).toBeNull();
    }
    for (const value of ['$6,000.00', '-$180.00', '-$30.00', '$5,790.00']) {
      expect(within(card).queryByText(value)).toBeNull();
    }
  });

  // D-A6: count moved with the figure it describes - the fee tile's count is the
  // fee-contributing population, and the tip tile's count is the tip-contributing
  // population. A payload where they differ (12 vs 1, as PAYLOAD is here) must render
  // BOTH correctly, not one count borrowed for both tiles.
  it('shows each tile its own count, not a shared count borrowed from the other figure', async () => {
    renderReport();
    const card = await findCard();

    expect(within(card).getByText(/12 card payments/i)).toBeInTheDocument();
    expect(within(card).getByText(/1 payment tipped/i)).toBeInTheDocument();
  });

  // Only the fee is card-only. A tip can arrive in cash, so the tip tile must not say
  // "card" - the copy would contradict the number, since the extras query counts every
  // method. Found on live staging data 2026-08-04, where the first CASH tip was dropped.
  it('does not describe tips as card-only', async () => {
    renderReport();
    const card = await findCard();

    const tipSub = within(card).getByText(/payments? tipped/i);
    expect(tipSub.textContent).not.toMatch(/card/i);
  });

  // A fee-bearing, tip-less org (the common case pre-tipping-feature) must show a real
  // fee beside a real "12" and a zero tip beside a real "0" - never implying the tip
  // count also describes the fee, or vice versa.
  it('shows a zero tip count next to a zero tip amount for a fee-bearing, tip-less org', async () => {
    hoisted.usePaymentFeesReport.mockReturnValue({
      data: { ...PAYLOAD, tips: 0, tipCount: 0 },
      isLoading: false,
      isError: false,
    });
    renderReport();
    const card = await findCard();

    expect(within(card).getByText('$210.00')).toBeInTheDocument();
    expect(within(card).getByText(/12 card payments/i)).toBeInTheDocument();
    expect(within(card).getByText('$0.00')).toBeInTheDocument();
    expect(within(card).getByText(/0 payments tipped/i)).toBeInTheDocument();
  });

  it('renders honest zeros rather than fabricated numbers when there are no reconciled payments yet', async () => {
    hoisted.usePaymentFeesReport.mockReturnValue({
      data: {
        from: PAYLOAD.from, to: PAYLOAD.to, gross: 0, stripeFees: 0, platformFees: 0, net: 0,
        reconciledCount: 0, serviceFees: 0, serviceFeeCount: 0, tips: 0, tipCount: 0,
      },
      isLoading: false,
      isError: false,
    });
    renderReport();
    const card = await findCard();

    expect(within(card).getAllByText('$0.00')).toHaveLength(2);
    expect(within(card).getByText(/0 card payments · 3\.5%/i)).toBeInTheDocument();
  });

  // While the request is in flight both tiles must show a loading skeleton, not a bare
  // "$0.00" - which would misleadingly read as "this org collected nothing" instead of
  // "still loading".
  it('shows a loading skeleton on both tiles (not a misleading $0.00) while the request is in flight', async () => {
    hoisted.usePaymentFeesReport.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    renderReport();
    const card = await findCard();

    expect(within(card).getByText('Card service fee')).toBeInTheDocument();
    expect(within(card).getByText('Customer tips')).toBeInTheDocument();
    expect(within(card).queryByText(/\$\d/)).toBeNull();
  });
});
