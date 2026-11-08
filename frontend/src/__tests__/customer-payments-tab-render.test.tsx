import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Routes, Route } from 'react-router-dom';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import CustomerDetailPage from '@/pages/CustomerDetailPage';

const mockApi = vi.mocked(api);

// Entity-redesign: Payment.collected_by is nullable (Stripe / deposit payments
// have no human collector), so the API returns collector:null for those. The
// customer Payments tab read `p.collector.first_name` unconditionally, which
// threw on render and tripped the error boundary ("Something went wrong") for
// any customer holding a collector-less payment. Regression for that crash.

const CUSTOMER = {
  id: 'c0000000-0000-0000-0000-000000000001',
  customer_number: 'C00001',
  first_name: 'Maria',
  last_name: 'Garcia',
  company_name: null,
  email: 'maria.garcia@example.com',
  extra_emails: [],
  phone: '4695550391',
  phone_ext: null,
  secondary_phone: null,
  secondary_phone_ext: null,
  ad_source: 'Google',
  allow_billing: false,
  tax_exempt: false,
  payment_type: null,
  notes: null,
  is_active: true,
  archived_at: null,
  created_at: '2026-04-01T00:00:00.000Z',
  service_locations: [],
  _count: { jobs: 1, leads: 1 },
  jobs: [
    {
      id: 'b0000000-0000-0000-0000-000000000001',
      job_number: 'J00001',
      status: 'COMPLETED',
      scope_notes: null,
      scheduled_start: null,
      completed_at: '2026-05-01T00:00:00.000Z',
      created_at: '2026-04-15T00:00:00.000Z',
      invoices: [
        {
          id: 'a0000000-0000-0000-0000-000000000001',
          invoice_number: 'I00001',
          status: 'PAID',
          total_amount: '530.00',
          amount_due: '0.00',
          due_date: null,
          created_at: '2026-05-01T00:00:00.000Z',
          payments: [
            {
              // Stripe deposit payment — no human collector.
              id: 'p0000000-0000-0000-0000-000000000001',
              amount: '530.00',
              method: 'CARD',
              paid_at: '2026-05-02T00:00:00.000Z',
              notes: null,
              collector: null,
            },
            {
              // On-site payment collected by a technician.
              id: 'p0000000-0000-0000-0000-000000000002',
              amount: '60.00',
              method: 'CASH',
              paid_at: '2026-05-03T00:00:00.000Z',
              notes: null,
              collector: { id: 'u1', first_name: 'Tina', last_name: 'Tech' },
            },
          ],
        },
      ],
    },
  ],
  // Customer-anchored invoice list (the new getById contract): the Invoices
  // and Payments tabs read customer.invoices[].payments, NOT the old
  // customer.jobs[].invoices[].payments. Same two payments as above so this
  // still guards the collector:null render crash.
  invoices: [
    {
      id: 'a0000000-0000-0000-0000-000000000001',
      invoice_number: 'I00001',
      status: 'PAID',
      kind: 'STANDARD',
      total_amount: '530.00',
      amount_due: '0.00',
      due_date: null,
      created_at: '2026-05-01T00:00:00.000Z',
      job_number: 'J00001',
      job_id: 'b0000000-0000-0000-0000-000000000001',
      payments: [
        {
          // Stripe deposit payment — no human collector.
          id: 'p0000000-0000-0000-0000-000000000001',
          amount: '530.00',
          method: 'CARD',
          paid_at: '2026-05-02T00:00:00.000Z',
          notes: null,
          collector: null,
        },
        {
          // On-site payment collected by a technician.
          id: 'p0000000-0000-0000-0000-000000000002',
          amount: '60.00',
          method: 'CASH',
          paid_at: '2026-05-03T00:00:00.000Z',
          notes: null,
          collector: { id: 'u1', first_name: 'Tina', last_name: 'Tech' },
        },
      ],
    },
  ],
};

const SUMMARY = {
  financials: {
    lifetime_revenue: 1590,
    total_invoiced: 1590,
    past_due_balance: 0,
    due_balance: 0,
    paid_invoice_count: 2,
    unpaid_invoice_count: 0,
  },
  estimates: { total: 0, pending: 0, approved: 0, total_value: 0 },
  deposits: { collected: 530, pending: 0 },
};

describe('CustomerDetailPage Payments tab with a collector-less payment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.get.mockResolvedValue({ data: { customer: CUSTOMER, summary: SUMMARY } });
  });

  it('renders the payments table without crashing the page', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <Routes>
        <Route path="/customers/:id" element={<CustomerDetailPage />} />
      </Routes>,
      { initialEntries: ['/customers/c0000000-0000-0000-0000-000000000001'] }
    );

    // Wait for the page to load (hero heading shows the customer name).
    await screen.findByRole('heading', { name: /Maria Garcia/ });

    // Open the Payments tab.
    await user.click(screen.getByRole('tab', { name: /payments/i }));

    // Both rows render inside the payments panel: the collector-less Stripe
    // payment shows a dash, and the tech-collected payment shows the collector's
    // name. If the page had crashed, the panel would never appear.
    const panel = await screen.findByRole('tabpanel');
    expect(within(panel).getByText('Tina Tech')).toBeInTheDocument();
    expect(within(panel).getByText('—')).toBeInTheDocument();
    expect(within(panel).getAllByText('I00001')).toHaveLength(2);
  });
});

// #352 — storage is digits-only canonical; the Contact Details card must render
// BOTH the primary and the secondary phone through the shared formatPhone
// (the secondary used to render raw, regressing to bare digits post-backfill).
describe('CustomerDetailPage Contact Details phone formatting (#352)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.get.mockResolvedValue({
      data: {
        customer: { ...CUSTOMER, phone: '4695550391', secondary_phone: '5559998888' },
        summary: SUMMARY,
      },
    });
  });

  it('renders digits-only primary AND secondary phones as (xxx) xxx-xxxx', async () => {
    renderWithProviders(
      <Routes>
        <Route path="/customers/:id" element={<CustomerDetailPage />} />
      </Routes>,
      { initialEntries: ['/customers/c0000000-0000-0000-0000-000000000001'] }
    );

    await screen.findByRole('heading', { name: /Maria Garcia/ });
    expect(screen.getByText(/\(469\) 555-0391/)).toBeInTheDocument();
    expect(screen.getByText(/\(555\) 999-8888/)).toBeInTheDocument();
  });
});
