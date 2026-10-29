import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import InvoicesPage from '@/pages/InvoicesPage';

const mockApi = vi.mocked(api);

// Entity-redesign §6/§8: invoices can be job-less (kind=DEPOSIT / orphan).
// The backend returns job:null for those and supplies the customer directly on
// the invoice. The list page must render those rows instead of crashing the
// whole route (which blanked the Invoices screen). Regression for that crash.

const JOBLESS_DEPOSIT = {
  id: 'a0000000-0000-0000-0000-000000000006',
  invoice_number: 'I00006',
  status: 'SENT',
  kind: 'DEPOSIT',
  subtotal: '500.00',
  discount_amount: '0.00',
  tax_amount: '0.00',
  deposit_credit: '0.00',
  total_amount: '500.00',
  amount_due: '500.00',
  due_date: null,
  sent_at: '2026-06-01T00:00:00.000Z',
  paid_at: null,
  created_at: '2026-06-01T00:00:00.000Z',
  job: null,
  customer: {
    id: 'c0000000-0000-0000-0000-000000000001',
    first_name: 'Dana',
    last_name: 'Deposit',
    company_name: 'Deposit Co',
  },
};

const STANDARD_WITH_JOB = {
  id: 'a0000000-0000-0000-0000-000000000001',
  invoice_number: 'I00001',
  status: 'SENT',
  kind: 'STANDARD',
  subtotal: '1000.00',
  discount_amount: '0.00',
  tax_amount: '0.00',
  deposit_credit: '0.00',
  total_amount: '1000.00',
  amount_due: '1000.00',
  due_date: null,
  sent_at: '2026-06-02T00:00:00.000Z',
  paid_at: null,
  created_at: '2026-06-02T00:00:00.000Z',
  job: {
    id: 'b0000000-0000-0000-0000-000000000001',
    job_number: 'J00001',
    customer: {
      id: 'c0000000-0000-0000-0000-000000000002',
      first_name: 'Jorge',
      last_name: 'Jobful',
      company_name: null,
    },
  },
  customer: {
    id: 'c0000000-0000-0000-0000-000000000002',
    first_name: 'Jorge',
    last_name: 'Jobful',
    company_name: null,
  },
};

describe('InvoicesPage renders job-less (deposit) invoices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.get.mockResolvedValue({
      data: {
        invoices: [JOBLESS_DEPOSIT, STANDARD_WITH_JOB],
        pagination: { total: 2 },
        stats: { due: { total: 1500, count: 2 }, overdue: { total: 0, count: 0 }, unsent: 0 },
      },
    });
  });

  it('shows the deposit invoice row without crashing the page', async () => {
    renderWithProviders(<InvoicesPage />);

    // If the route crashed, this row would never appear (blank page).
    expect(await screen.findByText('I00006')).toBeInTheDocument();
    // Customer name comes from the invoice's direct customer when job is null.
    expect(screen.getByText('Dana Deposit')).toBeInTheDocument();
    // The standard invoice with a job still renders alongside it.
    expect(screen.getByText('I00001')).toBeInTheDocument();
    expect(screen.getByText('Jorge Jobful')).toBeInTheDocument();
  });
});
