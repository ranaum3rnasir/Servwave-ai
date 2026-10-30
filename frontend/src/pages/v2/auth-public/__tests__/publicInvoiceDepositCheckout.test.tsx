/**
 * The routed public invoice page (`/p/invoices/:id`) for a job-less deposit invoice, and the copy
 * it shows when the checkout is refused. Re-pointed from the deleted, unrouted v1 page (payments
 * go-live slice 23), so these assertions now hold against what a customer actually opens.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/__tests__/helpers';

import PublicInvoicePage from '../PublicInvoicePage';

// The page bails without a token, so every render opens the link with one.
const LINK = { initialEntries: ['/p/invoices/dep-inv-1?token=tok-123'] };

// A job-less kind=DEPOSIT invoice: job is null, payer + lines live at the top level.
const DEPOSIT_RESPONSE = {
  invoice: {
    id: 'dep-inv-1',
    invoice_number: 'I00009',
    status: 'SENT',
    kind: 'DEPOSIT',
    subtotal: 300,
    discount_amount: 0,
    tax_amount: 0,
    deposit_credit: 0,
    total_amount: 300,
    amount_due: 300,
    due_date: null,
    sent_at: '2026-03-01T00:00:00.000Z',
    paid_at: null,
    created_at: '2026-03-01T00:00:00.000Z',
    job: null,
    customer: { first_name: 'Dana', last_name: 'Deposit', email: 'dana@example.com', phone: '5550001111' },
    line_items: [
      { id: 'li-1', sequence: 1, description: 'Project deposit', quantity: 1, unit_price: 300, is_taxable: false, line_total: 300 },
    ],
    payments: [],
  },
  organization: { name: 'Acme Services' },
  available_payment_methods: ['CARD'],
  payment_instructions: {},
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => DEPOSIT_RESPONSE,
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PublicInvoicePage — job-less DEPOSIT invoice', () => {
  it('renders the Bill-To payer and a card checkout button without throwing', async () => {
    renderWithProviders(<PublicInvoicePage />, LINK);

    // Bill-To comes from the top-level customer (job is null).
    await waitFor(() => {
      expect(screen.getByText('Dana Deposit')).toBeInTheDocument();
    });

    // The deposit's own line item renders in the document table.
    expect(screen.getByText('Project deposit')).toBeInTheDocument();

    // The card checkout button renders for a payable SENT invoice with amount due.
    expect(screen.getByRole('button', { name: 'Pay by card' })).toBeInTheDocument();
  });
});

// Task 2.6 — §6.5/§6.8: when an org is paused/restricted between send and view, the
// checkout POST 400s with the raw backend string ("Card payments are not enabled for
// this organization"). Before the fix this rendered verbatim in the error banner; the
// homeowner-facing copy must replace it with friendly wording (org name present).
describe('PublicInvoicePage — CARD-unavailable checkout copy (Task 2.6)', () => {
  it('shows friendly homeowner copy instead of the raw backend error when CARD is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return Promise.resolve({
            ok: false,
            json: async () => ({ error: 'Card payments are not enabled for this organization' }),
          });
        }
        return Promise.resolve({ ok: true, json: async () => DEPOSIT_RESPONSE });
      }),
    );

    renderWithProviders(<PublicInvoicePage />, LINK);

    // Slice 25 - Pay by card opens the checkout itself (no fee panel since D9 retired the card fee).
    await userEvent.click(await screen.findByRole('button', { name: 'Pay by card' }));

    // Friendly §6.8 copy renders, with the org name interpolated in.
    await waitFor(() => {
      expect(screen.getByText(/Acme Services isn't accepting card payments right now/i)).toBeInTheDocument();
    });

    // The raw backend string must never reach the homeowner.
    expect(screen.queryByText('Card payments are not enabled for this organization')).not.toBeInTheDocument();
  });

  it('falls back to a generic message (no raw backend string) for any other checkout error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return Promise.resolve({
            ok: false,
            json: async () => ({ error: 'Some unexpected internal detail the homeowner should never see' }),
          });
        }
        return Promise.resolve({ ok: true, json: async () => DEPOSIT_RESPONSE });
      }),
    );

    renderWithProviders(<PublicInvoicePage />, LINK);

    await userEvent.click(await screen.findByRole('button', { name: 'Pay by card' }));

    await waitFor(() => {
      expect(screen.getByText(/Something went wrong starting your payment/i)).toBeInTheDocument();
    });

    expect(
      screen.queryByText('Some unexpected internal detail the homeowner should never see')
    ).not.toBeInTheDocument();
  });
});
