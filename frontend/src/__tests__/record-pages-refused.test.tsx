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

import CustomerDetailPage from '@/pages/v2/customers/CustomerDetailPage';
import { renderJobDetail, serveJobDetail, stubBrowser } from '@/__tests__/harness/jobDetailPage';
import { leadDetailElement, renderLeadDetail, serveLeadDetail } from '@/__tests__/harness/leadDetailPage';
import { InvoiceDetailUnderTest, renderInvoiceDetail, serveInvoiceDetail } from '@/__tests__/harness/invoiceDetailPage';
import { renderEstimateWorkspace, serveEstimateWorkspace } from '@/__tests__/harness/estimateWorkspacePage';

stubBrowser();

const RECORD_ID = 'r0000000-0000-0000-0000-000000000001';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: 'r0000000-0000-0000-0000-000000000001' }) };
});

const mockApi = vi.mocked(api);

/** A custom role with View off everywhere: it holds no read rule on any record type. */
const noViewAbility = buildAbility([]);

const refusal = (status: number) => ({ isAxiosError: true, message: 'Request failed', response: { status, data: { error: 'Forbidden' } } });

function refuse(url: string, status: number) {
  mockApi.get.mockImplementation(async (requested: string) => {
    if (requested === url) throw refusal(status);
    return { data: {} };
  });
}

/** `serve(status)` makes the server refuse the record with that status; the lead page's server is its harness's. */
const PAGES: Array<{ name: string; Page: () => JSX.Element; serve: (status: number) => void; notFound: RegExp }> = [
  {
    name: 'lead',
    Page: leadDetailElement as () => JSX.Element,
    serve: (status) => serveLeadDetail({ lead: () => { throw refusal(status); } }),
    notFound: /Lead not found/,
  },
  { name: 'customer', Page: CustomerDetailPage, serve: (status) => refuse(`/api/customers/${RECORD_ID}`, status), notFound: /Customer not found/ },
  {
    name: 'invoice',
    Page: InvoiceDetailUnderTest,
    serve: (status) => serveInvoiceDetail({ invoice: () => { throw refusal(status); } }),
    notFound: /Invoice not found/,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe.each(PAGES)('the $name page, as a role with View off', ({ Page, serve, notFound }) => {
  it('shows the "not authorized" screen when the server refuses the record', async () => {
    serve(403);
    renderWithProviders(<Page />, { ability: noViewAbility });

    expect(await screen.findByRole('heading', { name: /You don.t have access to this page/ })).toBeInTheDocument();
    expect(screen.queryByText(notFound)).toBeNull();
  });

  it('still says "not found" for a record the server does not have', async () => {
    serve(404);
    renderWithProviders(<Page />, { ability: noViewAbility });

    expect(await screen.findByText(notFound)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /You don.t have access to this page/ })).toBeNull();
  });
});

describe('the job page, as a role with View off', () => {
  const url = `/api/jobs/${RECORD_ID}`;
  /** The job detail harness's server refuses the job's own read with this status. */
  function refuseJob(status: number) {
    serveJobDetail({
      jobId: RECORD_ID,
      job: () => { throw { isAxiosError: true, message: 'Request failed', response: { status, data: { error: 'Forbidden' } } }; },
    });
    return renderJobDetail({ ability: noViewAbility });
  }

  it('shows the "not authorized" screen when the server refuses the record', async () => {
    refuseJob(403);

    expect(await screen.findByRole('heading', { name: /You don.t have access to this page/ })).toBeInTheDocument();
    expect(screen.queryByText(/Job not found/)).toBeNull();
    expect(mockApi.get.mock.calls.filter(([asked]) => asked === url)).not.toHaveLength(0);
  });

  it('still says "not found" for a record the server does not have', async () => {
    refuseJob(404);

    expect(await screen.findByText(/Job not found/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /You don.t have access to this page/ })).toBeNull();
  });
});

describe('the estimate page, as a role with View off', () => {
  it('shows the "not authorized" screen when the server refuses the estimate, not a screen of skeletons', async () => {
    serveEstimateWorkspace({ estimate: () => { throw refusal(403); } });
    renderEstimateWorkspace({ ability: noViewAbility });

    expect(await screen.findByRole('heading', { name: /You don.t have access to this page/ })).toBeInTheDocument();
  });
});

describe('a record the server allows', () => {
  it('opens an invoice for a role with View invoices off, through the server\'s creator rule', async () => {
    serveInvoiceDetail({
      invoice: {
        id: RECORD_ID, invoice_number: 'I00042', status: 'DRAFT', subtotal: 0, discount_amount: 0, tax_rate: 0, tax_amount: 0,
        tip: 0, deposit_credit: 0, total_amount: 0, amount_due: 0, public_token: null, sent_at: null, paid_at: null,
        due_date: null, voided_at: null, voided_reason: null, refunded_at: null, total_refunded: 0, refund_reason: null,
        refund_reason_category: null, line_items: [], scopes: [], net_collected: 0, payments: [], job: null,
        created_at: '2026-07-01T00:00:00.000Z', updated_at: '2026-07-01T00:00:00.000Z',
        customer: { id: 'c1', first_name: 'John', last_name: 'Doe', email: 'john@doe.com', phone: '5551234567' },
      },
    });
    renderInvoiceDetail({ id: RECORD_ID, ability: noViewAbility });

    expect((await screen.findAllByText(/I00042/)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('heading', { name: /You don.t have access to this page/ })).toBeNull();
  });

  it('opens a lead for a role with View leads off when the server returns it', async () => {
    serveLeadDetail({ lead: LEAD_FIXTURE });
    renderLeadDetail({ ability: noViewAbility });

    expect((await screen.findAllByText(String(LEAD_FIXTURE.lead_number))).length).toBeGreaterThan(0);
    expect(screen.queryByRole('heading', { name: /You don.t have access to this page/ })).toBeNull();
  });
});
