/**
 * Payments go-live slice 02 (D9) - card payments carry no service fee, so the public invoice
 * payload no longer quotes one. The routed public invoice page must then say nothing about a
 * card service fee: a "Service fee (card payments only)" row with a dash still tells the
 * homeowner that paying by card costs extra.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/__tests__/helpers';

import PublicInvoicePage from '../PublicInvoicePage';

// The payload exactly as the backend sends it after slice 02: no service_fee_bps and no
// service_fee_preview.
const PAYLOAD = {
  invoice: {
    id: 'i1',
    invoice_number: 'I00001',
    status: 'SENT',
    kind: 'INVOICE',
    subtotal: 100,
    discount_amount: 0,
    tax_amount: 0,
    deposit_credit: 0,
    total_amount: 100,
    amount_due: 100,
    due_date: null,
    sent_at: null,
    paid_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    customer: null,
    line_items: [
      { id: 'l1', sequence: 1, description: 'Work', quantity: 1, unit_price: 100, is_taxable: false, line_total: 100 },
    ],
    job: null,
    payments: [],
  },
  organization: { name: 'Acme', timezone: 'America/New_York' },
  available_payment_methods: ['CARD', 'CHECK'],
  payment_instructions: { check: 'Mail it' },
  tip_preset_bps: [1000, 1500, 2000],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('public invoice page - no card service fee (payments go-live D9)', () => {
  it('shows no service-fee row when the payload quotes no fee', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => PAYLOAD }));

    const { container } = renderWithProviders(<PublicInvoicePage />, {
      initialEntries: ['/p/invoices/i1?token=t'],
    });
    await waitFor(() => expect(container.textContent).toContain('I00001'));

    expect(container.textContent).not.toMatch(/service fee/i);
  });

  it('quotes no fee and asks the checkout for the invoice amount alone, even when the payload quotes a fee', async () => {
    // A stale quote of the retired 3.5% fee on the $100.00 invoice.
    const stalePayload = { ...PAYLOAD, service_fee_preview: 3.5 };
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(init?.method === 'POST'
        ? { ok: false, json: async () => ({ error: 'stop before leaving the page' }) }
        : { ok: true, json: async () => stalePayload }));
    vi.stubGlobal('fetch', fetchMock);

    const { container } = renderWithProviders(<PublicInvoicePage />, {
      initialEntries: ['/p/invoices/i1?token=t'],
    });
    await waitFor(() => expect(container.textContent).toContain('I00001'));
    expect(container.textContent).not.toMatch(/service fee/i);
    expect(container.textContent).not.toContain('$103.50');

    // Slice 25 - Pay by card opens the checkout directly, for the amount on screen.
    await userEvent.click(screen.getByRole('button', { name: 'Pay by card' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ method: 'card', expected_amount: 100 });
    expect(container.textContent).not.toMatch(/service fee/i);
  });
});
