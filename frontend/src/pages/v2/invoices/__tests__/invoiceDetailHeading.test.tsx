import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';

import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';

import InvoiceDetailPage from '../InvoiceDetailPage';

/**
 * The v2 invoice detail heading: invoice id, then the customer.
 *
 * The rule is `lib/customer-name`'s, reused rather than re-implemented: a
 * personal name when there is one, the company name when there is not. "No
 * personal name" has to mean blank-or-whitespace, not just null - a customer
 * whose `first_name` is a single space must not put a hole in the heading.
 *
 * The legacy suites in `src/__tests__` are the behavioural contract for the
 * legacy page and stay pointed at it. This file covers the v2 page only.
 */

// floating-ui, under Radix's dropdown, does `new ResizeObserver(...)`.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const INVOICE_ID = 'i0000000-0000-0000-0000-000000000001';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: INVOICE_ID }) };
});

const mockApi = vi.mocked(api);

type CustomerFixture = {
  first_name: string;
  last_name: string;
  company_name?: string | null;
};

/**
 * The narrowest invoice the detail page will render: no job, no estimate, no
 * money movement. Everything here exists to get past a null guard, not to
 * assert anything - the heading is the only surface under test.
 */
function invoiceWithCustomer(customer: CustomerFixture) {
  return {
    id: INVOICE_ID,
    invoice_number: 'I00001',
    status: 'DRAFT',
    kind: 'STANDARD',
    subtotal: 100,
    discount_amount: 0,
    tax_rate: 0,
    tax_amount: 0,
    tip: 0,
    deposit_credit: 0,
    total_amount: 100,
    amount_due: 100,
    net_collected: 0,
    public_token: null,
    sent_at: null,
    paid_at: null,
    due_date: null,
    voided_at: null,
    voided_reason: null,
    refunded_at: null,
    total_refunded: null,
    refund_reason: null,
    refund_reason_category: null,
    created_at: '2026-01-15T00:00:00.000Z',
    updated_at: '2026-01-15T00:00:00.000Z',
    line_items: [],
    scopes: [],
    payments: [],
    refunds: [],
    credits: [],
    tags: [],
    job: null,
    estimate: null,
    customer: {
      id: 'c0000000-0000-0000-0000-000000000001',
      email: 'billing@example.test',
      phone: '5125550125',
      ...customer,
    },
  };
}

function mountWith(customer: CustomerFixture) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/invoices/')) {
      return { data: { invoice: invoiceWithCustomer(customer) } };
    }
    return { data: {} };
  });

  renderWithProviders(<InvoiceDetailPage />, {
    initialEntries: [`/invoices/${INVOICE_ID}`],
  });
}

/**
 * The heading's text, with the decorative separator normalised back to " · ".
 *
 * The separator is its own aria-hidden span and the space either side of it is
 * a flex gap, so `textContent` butts it straight against its neighbours. Both
 * halves either side of it are still compared exactly.
 */
async function headingText(): Promise<string> {
  const heading = await screen.findByRole('heading', { level: 1 });
  return (heading.textContent ?? '')
    .replace(/·/g, ' · ')
    .replace(/\s+/g, ' ')
    .trim();
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('v2 InvoiceDetailPage heading', () => {
  it('shows the invoice id and the first + last name when both are present', async () => {
    mountWith({ first_name: 'Ada', last_name: 'Lovelace', company_name: 'Lovelace Mechanical' });

    expect(await headingText()).toBe('I00001 · Ada Lovelace');
  });

  it('falls back to the name it has when the first name is missing', async () => {
    mountWith({ first_name: '', last_name: 'Lovelace', company_name: 'Lovelace Mechanical' });

    expect(await headingText()).toBe('I00001 · Lovelace');
  });

  it('shows the company name when both personal names are missing', async () => {
    mountWith({ first_name: '', last_name: '', company_name: 'Lovelace Mechanical' });

    expect(await headingText()).toBe('I00001 · Lovelace Mechanical');
  });

  it('shows the company name when the personal names are whitespace only', async () => {
    mountWith({ first_name: '  ', last_name: '\t', company_name: 'Lovelace Mechanical' });

    expect(await headingText()).toBe('I00001 · Lovelace Mechanical');
  });
});
