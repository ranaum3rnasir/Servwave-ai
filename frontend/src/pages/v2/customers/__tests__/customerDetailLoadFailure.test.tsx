import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';

import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';

import CustomerDetailPage from '../CustomerDetailPage';

/**
 * Mobile slice 68 (PRD story 140): a customer page that fails to load says so and offers Retry.
 *
 * It used to render "Customer not found." for ANY failed detail query, so a dropped connection
 * on a phone read as "your customer is gone". A real 404 (a customer the viewer's scope excludes)
 * keeps that copy (customerDetailPageNotFound.test.tsx); every other failure is an error with a
 * Retry. The same goes for the Estimates tab, which read a failed request as "No estimates yet.".
 *
 * The copy is fixed text: the server's own message never reaches the screen.
 */

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000068';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: CUSTOMER_ID }) };
});

const mockApi = vi.mocked(api);

const DETAIL = {
  customer: {
    id: CUSTOMER_ID, customer_number: 'C00068', first_name: 'Rita', last_name: 'Vance', name: 'Rita Vance',
    company_name: null, email: 'rita@example.test', phone: '5551230000', phone_ext: null, secondary_phone: null,
    ad_source: null, allow_billing: false, tax_exempt: false, payment_type: null, extra_emails: [],
    custom_fields: {}, created_at: '2026-01-01T00:00:00.000Z', archived_at: null, is_active: true, tags: [],
    service_locations: [], _count: { leads: 0, jobs: 0 }, jobs: [], activity_notes: [], orphan_invoices: [], invoices: [],
  },
  summary: {
    financials: { lifetime_revenue: 0, total_invoiced: 0, past_due_balance: 0, due_balance: 0, paid_invoice_count: 0, unpaid_invoice_count: 0 },
    estimates: { total: 0, pending: 0, approved: 0, total_value: 0 },
    deposits: { collected: 0, pending: 0 },
    leads: { open: 0, active: 0 },
    tasks: { open: 0 },
  },
};

const ESTIMATE = {
  id: 'est-1', estimate_number: 'EST-0068', status: 'DRAFT', total_amount: 250,
  created_at: '2026-02-01T00:00:00.000Z', lead: null,
};

/** An axios-shaped failure whose server message names a vendor: it must never be shown. */
function serverError(status: number) {
  return { isAxiosError: true, message: 'Request failed', response: { status, data: { error: 'Supabase upstream timeout' } } };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CustomerDetailPage - a failed load is an error with Retry (slice 68)', () => {
  it('a 500 on the customer shows an error and Retry, never "Customer not found."; Retry recovers', async () => {
    let failing = true;
    mockApi.get.mockImplementation(async (url: string) => {
      if (url === '/api/organization') return { data: { id: 'org-1', timezone: 'America/Los_Angeles' } };
      if (url.startsWith('/api/customers/')) {
        if (failing) throw serverError(500);
        return { data: DETAIL };
      }
      return { data: { leads: [], jobs: [], pagination: { total: 0 } } };
    });

    renderWithProviders(<CustomerDetailPage />, { initialEntries: [`/customers/${CUSTOMER_ID}`] });

    expect(await screen.findByText("Couldn't load this customer.")).toBeInTheDocument();
    expect(screen.queryByText('Customer not found.')).toBeNull();
    // Fixed copy: the server's own words (and any vendor name in them) are not shown.
    expect(document.body.textContent ?? '').not.toMatch(/supabase|timeout/i);

    failing = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: /Rita Vance/ })).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load this customer.")).toBeNull();
  });

  it('a network failure with no response is an error with Retry too', async () => {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/customers/')) throw Object.assign(new Error('Network Error'), { isAxiosError: true });
      return { data: {} };
    });

    renderWithProviders(<CustomerDetailPage />, { initialEntries: [`/customers/${CUSTOMER_ID}`] });

    expect(await screen.findByText("Couldn't load this customer.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('Estimates tab: a failed request is an error with Retry, never "No estimates yet."', async () => {
    let failing = true;
    mockApi.get.mockImplementation(async (url: string) => {
      if (url === '/api/organization') return { data: { id: 'org-1', timezone: 'America/Los_Angeles' } };
      if (url === '/api/estimates') {
        if (failing) throw serverError(503);
        return { data: { estimates: [ESTIMATE] } };
      }
      if (url.startsWith('/api/customers/')) return { data: DETAIL };
      return { data: { leads: [], jobs: [], pagination: { total: 0 } } };
    });

    renderWithProviders(<CustomerDetailPage />, { initialEntries: [`/customers/${CUSTOMER_ID}`] });

    fireEvent.click(await screen.findByRole('tab', { name: 'Estimates' }));
    expect(await screen.findByText("Couldn't load this customer's estimates.")).toBeInTheDocument();
    expect(screen.queryByText('No estimates yet.')).toBeNull();
    expect(document.body.textContent ?? '').not.toMatch(/supabase|timeout/i);

    failing = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('EST-0068')).toBeInTheDocument());
    expect(screen.queryByText("Couldn't load this customer's estimates.")).toBeNull();
  });
});
