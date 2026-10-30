// Payments go-live slice 35 (conductor note from slice 28 staging acceptance): the Payments report in a DEMO org
// used to render a seeded mock, so the labels the build changed (Voided, Partly refunded, method in words, the
// refund "By" user) could not be read in the browser. It now reads the org's real rows like any other org.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import { renderWithProviders } from './helpers';
import api from '@/lib/axios';
import PaymentsReport from '@/pages/v2/reports/reports/PaymentsReport';

vi.mock('@/lib/useIsDemoOrg', () => ({ useIsDemoOrg: () => true }));
vi.mock('@/lib/axios', () => ({ default: { get: vi.fn() } }));
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

const mockGet = vi.mocked(api.get);

beforeEach(() => {
  vi.clearAllMocks();
  mockGet.mockResolvedValue({
    data: {
      payments: [{
        id: 'live-1', date: Date.now(), amount: 321, tip: 0, method: 'Bank (ACH)', category: 'Invoice',
        status: 'Partly refunded', client: 'Live Customer', email: 'live@example.com', card: '', technician: '',
        txnKind: 'Online', confirmation: 'Approved', isDepositCredit: false,
      }],
    },
  });
});

function renderReport() {
  return renderWithProviders(
    <Routes>
      <Route path="/reports/:slug" element={<PaymentsReport />} />
    </Routes>,
    { initialEntries: ['/reports/payments'] },
  );
}

describe('Payments report in a demo org', () => {
  it('reads the org\'s real payments from the server', async () => {
    renderReport();
    expect(await screen.findAllByText("$321.00")).not.toHaveLength(0);
    expect(mockGet).toHaveBeenCalledWith('/api/reports/payments');
  });

  it('does not call itself sample data', async () => {
    const { container } = renderReport();
    await screen.findAllByText("$321.00");
    expect(container.textContent).not.toMatch(/sample data/i);
  });
});
