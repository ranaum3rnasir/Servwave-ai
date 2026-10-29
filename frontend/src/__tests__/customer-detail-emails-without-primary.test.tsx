// CustomerDetailPage contact card — the emails block was gated entirely behind
// `customer.email`, so a customer whose only addresses live in extra_emails[]
// showed NO email at all: the card rendered a phone row and nothing else.
//
// That gate predates the per-address automated-mail opt-in, but the opt-in makes
// it consequential — an opted-in secondary can be the only address receiving the
// org's automated mail while being invisible on the customer's own page, along
// with its "Auto-emails" tag. Reproduced live on staging (customer with
// ops@/archive@ and no primary rendered zero addresses).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import CustomerDetailPage from '@/pages/CustomerDetailPage';
import { buildAbility } from '@/lib/ability';

const mockApi = vi.mocked(api);

const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000001';

function customer(overrides: Record<string, unknown> = {}) {
  return {
    id: CUSTOMER_ID,
    customer_number: 'C00001',
    first_name: 'Maria',
    last_name: 'Garcia',
    company_name: null,
    email: null,
    extra_emails: [],
    phone: '4695550391',
    phone_ext: null,
    secondary_phone: null,
    secondary_phone_ext: null,
    ad_source: null,
    allow_billing: false,
    tax_exempt: false,
    payment_type: null,
    notes: null,
    is_active: true,
    archived_at: null,
    created_at: '2026-04-01T00:00:00.000Z',
    service_locations: [],
    _count: { jobs: 0, leads: 0 },
    jobs: [],
    invoices: [],
    ...overrides,
  };
}

const SUMMARY = {
  financials: {
    lifetime_revenue: 0,
    total_invoiced: 0,
    past_due_balance: 0,
    due_balance: 0,
    paid_invoice_count: 0,
    unpaid_invoice_count: 0,
  },
  estimates: { total: 0, pending: 0, approved: 0, total_value: 0 },
  deposits: { collected: 0, pending: 0 },
};

function render(cust: Record<string, unknown>) {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/estimates') return Promise.resolve({ data: { estimates: [] } });
    if (url === '/api/leads') return Promise.resolve({ data: { leads: [] } });
    return Promise.resolve({ data: { customer: cust, summary: SUMMARY } });
  });
  renderWithProviders(
    <Routes>
      <Route path="/customers/:id" element={<CustomerDetailPage />} />
    </Routes>,
    { initialEntries: [`/customers/${CUSTOMER_ID}`] },
  );
  // Editable record IDs (2026-08-19 plan) - the h1 now also carries the customer number
  // ("C00001 · Maria Garcia"), so match by substring rather than the old exact string.
  return screen.findByRole('heading', { name: /Maria Garcia/ });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CustomerDetailPage — emails with no primary on file', () => {
  it('lists the extra emails when the customer has no primary email', async () => {
    await render(
      customer({
        email: null,
        extra_emails: [
          { id: 'ce1', email: 'ops@example.com', label: null, receives_emails: true },
          { id: 'ce2', email: 'archive@example.com', label: null, receives_emails: false },
        ],
      }),
    );

    expect(await screen.findByText('ops@example.com')).toBeInTheDocument();
    expect(screen.getByText('archive@example.com')).toBeInTheDocument();
  });

  it('still tags the opted-in address when there is no primary to anchor the block', async () => {
    await render(
      customer({
        email: null,
        extra_emails: [{ id: 'ce1', email: 'ops@example.com', label: null, receives_emails: true }],
      }),
    );

    expect(await screen.findByText('Auto-emails')).toBeInTheDocument();
  });

  it('renders the primary alongside the extras when both exist', async () => {
    await render(
      customer({
        email: 'maria@example.com',
        extra_emails: [{ id: 'ce1', email: 'ops@example.com', label: null, receives_emails: true }],
      }),
    );

    expect(await screen.findByText('maria@example.com')).toBeInTheDocument();
    expect(screen.getByText('ops@example.com')).toBeInTheDocument();
  });

  it('renders no email row at all when the customer has neither', async () => {
    await render(customer({ email: null, extra_emails: [] }));

    expect(screen.queryByText(/@example\.com/)).not.toBeInTheDocument();
    // The empty array must not leak a stray "0" from an && on .length.
    expect(screen.queryByText('0', { selector: 'div.space-y-1' })).not.toBeInTheDocument();
  });
});

// Editable record IDs (2026-08-19 plan) - RecordNumberEditor wired into the hero header's
// customer-number render, gated on ability.can('renumber', 'Customer').
describe('CustomerDetailPage - record number editor gating', () => {
  function renderWithAbility(ability?: ReturnType<typeof buildAbility>) {
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/api/estimates') return Promise.resolve({ data: { estimates: [] } });
      if (url === '/api/leads') return Promise.resolve({ data: { leads: [] } });
      return Promise.resolve({ data: { customer: customer(), summary: SUMMARY } });
    });
    renderWithProviders(
      <Routes>
        <Route path="/customers/:id" element={<CustomerDetailPage />} />
      </Routes>,
      { initialEntries: [`/customers/${CUSTOMER_ID}`], ability },
    );
  }

  it('shows the edit affordance for a user with the renumber grant', async () => {
    renderWithAbility(buildAbility([{ action: 'manage', subject: 'all' }]));

    expect(await screen.findByRole('button', { name: /edit id/i })).toBeInTheDocument();
  });

  it('hides the edit affordance for a user without the renumber grant', async () => {
    renderWithAbility();

    await screen.findAllByText('C00001');
    expect(screen.queryByRole('button', { name: /edit id/i })).toBeNull();
  });
});
