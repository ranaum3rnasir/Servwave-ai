// SRVW-55 — the Payments report used to hide the Tip column, the Total tips KPI and the CSV
// Tip column for every real org behind a stale "no tip field in the schema" claim. Now that
// live payments (card, shipped SRVW-193/194, and manual, this card) carry tip_amount, a real
// org must see all three.
//
// Mounted on the ReportRoute that actually serves /reports/:slug - pages/v2/reports, per
// pages/v2/routes/reports.routes.tsx:65. The seams it reads moved too: the report's data
// hooks now live under lib/reports (they are shared by both report trees), so the mocks
// below name them there. Pointed at the old paths the vi.mock calls resolved to nothing,
// the fixture never reached the component, and the table rendered zero rows.
//
// One divergence on the new surface, the same one pages/v2/_shared/__tests__/loList.test.tsx
// records at its lines 15-22: the kit DataTable puts a role="separator" resize grip inside
// every <th>, and name-from-content folds that grip's aria-label into the column header's
// accessible name. So the header's name is literally "Tip Resize Tip column". The query
// still selects the columnheader by exact name - pinned, not loosened to a substring.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import { renderWithProviders } from './helpers';
import ReportRoute from '@/pages/v2/reports/ReportRoute';
import type { PaymentTxn } from '@/lib/reports/payments-report-data';

const hoisted = vi.hoisted(() => ({
  usePaymentsReport: vi.fn(),
}));

vi.mock('@/lib/reports/payments-report-data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/reports/payments-report-data')>();
  return { ...actual, usePaymentsReport: hoisted.usePaymentsReport };
});

// The card service fee summary block's own data source — stub it out, it is unrelated to tips.
vi.mock('@/lib/reports/payment-fees-data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/reports/payment-fees-data')>();
  return {
    ...actual,
    usePaymentFeesReport: () => ({
      data: { from: '', to: '', gross: 0, stripeFees: 0, platformFees: 0, net: 0, serviceFees: 0, count: 0 },
      isLoading: false,
      isError: false,
    }),
  };
});

// Real (non-demo) org — a stub here would mean the wiring regressed.
vi.mock('@/lib/useIsDemoOrg', () => ({ useIsDemoOrg: () => false }));

const TIPPED_ROW: PaymentTxn = {
  id: 'pay-tipped',
  date: Date.parse('2026-06-01T00:00:00.000Z'),
  amount: 200,
  tip: 30,
  method: 'Cash',
  category: 'Invoice',
  status: 'Succeeded',
  client: 'Acme Co',
  email: 'ap@acme.com',
  card: '',
  technician: 'Emanuel Dahan',
  txnKind: 'Keyed',
  confirmation: '',
  isDepositCredit: false,
};

function renderReport() {
  return renderWithProviders(
    <Routes>
      <Route path="/reports/:slug" element={<ReportRoute />} />
    </Routes>,
    { initialEntries: ['/reports/payments'] },
  );
}

const NOW = new Date('2026-06-07T12:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.usePaymentsReport.mockReturnValue({ rows: [TIPPED_ROW], now: NOW, isLoading: false });
});

describe('Payments report tips (SRVW-55)', () => {
  it('shows the Tip column with the tipped payment\'s amount, for a real org', async () => {
    renderReport();
    expect(
      await screen.findByRole('columnheader', { name: 'Tip Resize Tip column' }),
    ).toBeInTheDocument();
    // Both the row cell and the column footer sum read $30.00 for this single-row fixture.
    expect(screen.getAllByText('$30.00').length).toBeGreaterThan(0);
  });

  it('shows the Total tips KPI, for a real org', async () => {
    renderReport();
    expect(await screen.findByText('Total tips')).toBeInTheDocument();
  });

  it('renders a dash rather than $0.00 for an untipped row', async () => {
    hoisted.usePaymentsReport.mockReturnValue({ rows: [{ ...TIPPED_ROW, id: 'pay-untipped', tip: 0 }], now: NOW, isLoading: false });
    renderReport();
    await screen.findByRole('columnheader', { name: 'Tip Resize Tip column' });
    expect(screen.queryByText('$30.00')).not.toBeInTheDocument();
  });
});
