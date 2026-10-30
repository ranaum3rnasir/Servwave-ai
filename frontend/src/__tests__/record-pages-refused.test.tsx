/**
 * Roles & Permissions, PRD 2, S02.23 - record pages are decided by the server.
 *
 * Renders the REAL routed record pages (the files `pages/v2/routes/*.routes.tsx` mount at the `:id` paths), as a
 * custom role with View off on the module (no read rule). When the server refuses (403) the page shows the existing
 * "not authorized" screen; a 404 stays "not found"; and when the server's answer allows the record (the creator rule
 * opening a person's own invoice with View invoices off) the page opens, because no page decides this by itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders, LEAD_FIXTURE } from './helpers';

import LeadDetailPage from '@/pages/v2/leads/LeadDetailPage';
import CustomerDetailPage from '@/pages/v2/customers/CustomerDetailPage';
import JobDetailPage from '@/pages/v2/jobs/JobDetailPage';
import InvoiceDetailPage from '@/pages/v2/invoices/InvoiceDetailPage';
import EstimateWorkspacePage from '@/pages/v2/estimates/EstimateWorkspacePage';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const RECORD_ID = 'r0000000-0000-0000-0000-000000000001';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: 'r0000000-0000-0000-0000-000000000001' }) };
});

const mockApi = vi.mocked(api);

/** A custom role with View off everywhere: it holds no read rule on any record type. */
const noViewAbility = buildAbility([]);

const PAGES: Array<{ name: string; Page: () => JSX.Element; url: string; notFound: RegExp }> = [
  { name: 'lead', Page: LeadDetailPage, url: `/api/leads/${RECORD_ID}`, notFound: /Lead not found/ },
  { name: 'customer', Page: CustomerDetailPage, url: `/api/customers/${RECORD_ID}`, notFound: /Customer not found/ },
  { name: 'job', Page: JobDetailPage, url: `/api/jobs/${RECORD_ID}`, notFound: /Job not found/ },
  { name: 'invoice', Page: InvoiceDetailPage, url: `/api/invoices/${RECORD_ID}`, notFound: /Invoice not found/ },
];

function refuse(url: string, status: number) {
  mockApi.get.mockImplementation(async (requested: string) => {
    if (requested === url) throw { isAxiosError: true, message: 'Request failed', response: { status, data: { error: 'Forbidden' } } };
    return { data: {} };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe.each(PAGES)('the $name page, as a role with View off', ({ Page, url, notFound }) => {
  it('shows the "not authorized" screen when the server refuses the record', async () => {
    refuse(url, 403);
    renderWithProviders(<Page />, { ability: noViewAbility });

    expect(await screen.findByRole('heading', { name: /You don.t have access to this page/ })).toBeInTheDocument();
    expect(screen.queryByText(notFound)).toBeNull();
  });

  it('still says "not found" for a record the server does not have', async () => {
    refuse(url, 404);
    renderWithProviders(<Page />, { ability: noViewAbility });

    expect(await screen.findByText(notFound)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /You don.t have access to this page/ })).toBeNull();
  });
});

describe('the estimate page, as a role with View off', () => {
  it('shows the "not authorized" screen when the server refuses the estimate, not a screen of skeletons', async () => {
    refuse(`/api/estimates/${RECORD_ID}`, 403);
    renderWithProviders(<EstimateWorkspacePage />, { ability: noViewAbility });

    expect(await screen.findByRole('heading', { name: /You don.t have access to this page/ })).toBeInTheDocument();
  });
});

describe('a record the server allows', () => {
  it('opens an invoice for a role with View invoices off, through the server\'s creator rule', async () => {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url === `/api/invoices/${RECORD_ID}`) {
        return {
          data: {
            invoice: {
              id: RECORD_ID, invoice_number: 'I00042', status: 'DRAFT', subtotal: 0, discount_amount: 0, tax_rate: 0, tax_amount: 0,
              tip: 0, deposit_credit: 0, total_amount: 0, amount_due: 0, public_token: null, sent_at: null, paid_at: null,
              due_date: null, voided_at: null, voided_reason: null, refunded_at: null, total_refunded: 0, refund_reason: null,
              refund_reason_category: null, line_items: [], scopes: [], net_collected: 0, payments: [], job: null,
              created_at: '2026-07-01T00:00:00.000Z', updated_at: '2026-07-01T00:00:00.000Z',
              customer: { id: 'c1', first_name: 'John', last_name: 'Doe', email: 'john@doe.com', phone: '5551234567' },
            },
          },
        };
      }
      return { data: [] };
    });
    renderWithProviders(<InvoiceDetailPage />, { ability: noViewAbility });

    expect((await screen.findAllByText(/I00042/)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('heading', { name: /You don.t have access to this page/ })).toBeNull();
  });

  it('opens a lead for a role with View leads off when the server returns it', async () => {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url === `/api/leads/${RECORD_ID}`) return { data: { lead: LEAD_FIXTURE } };
      if (url.includes('/api/users')) return { data: { users: [] } };
      if (url.includes('/api/tags')) return { data: { tags: [] } };
      return { data: {} };
    });
    renderWithProviders(<LeadDetailPage />, { ability: noViewAbility });

    expect((await screen.findAllByText(String(LEAD_FIXTURE.lead_number))).length).toBeGreaterThan(0);
    expect(screen.queryByRole('heading', { name: /You don.t have access to this page/ })).toBeNull();
  });
});
