/**
 * Payments go-live slice 25 - the routed public invoice page (`/p/invoices/:id`): the homeowner
 * chooses Pay by card or Pay by bank, and always sees the true state of the invoice.
 *
 * The page renders from the public payload's resolver answer (available_payment_methods) and its
 * pay_state; the checkout door is the bare `fetch` POST, stubbed here. Every payload below is the
 * shape the backend sends since this slice.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/__tests__/helpers';

import PublicInvoicePage from '../PublicInvoicePage';

const LINK = '/p/invoices/inv-25?token=tok-25';

function payload(over: Record<string, unknown> = {}, invoiceOver: Record<string, unknown> = {}) {
  return {
    invoice: {
      id: 'inv-25',
      invoice_number: 'I00025',
      status: 'SENT',
      kind: 'STANDARD',
      subtotal: 480,
      discount_amount: 0,
      tax_amount: 0,
      deposit_credit: 0,
      total_amount: 480,
      amount_due: 480,
      due_date: null,
      sent_at: '2026-10-01T14:00:00.000Z',
      paid_at: null,
      created_at: '2026-10-01T14:00:00.000Z',
      job: null,
      customer: { first_name: 'Robin', last_name: 'Homeowner' },
      line_items: [
        { id: 'l1', sequence: 1, description: 'Gate opener install', quantity: 1, unit_price: 480, is_taxable: false, line_total: 480 },
      ],
      payments: [],
      ...invoiceOver,
    },
    organization: { name: 'Northside Doors', phone: '5550104477', timezone: 'America/New_York' },
    deposit_hold_reason: null,
    pay_state: 'PAYABLE',
    processing_amount: 0,
    payable_now: 480,
    available_payment_methods: ['CARD', 'ACH'],
    payment_instructions: {},
    ...over,
  };
}

/** GETs answer `pages` in turn (the last one repeats); POSTs answer `checkout`. */
function stubApi(pages: unknown[], checkout?: { ok: boolean; body: unknown }) {
  let reads = 0;
  const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      return Promise.resolve({ ok: checkout?.ok ?? true, json: async () => checkout?.body ?? { checkout_url: 'https://pay.example/session' } });
    }
    const page = pages[Math.min(reads, pages.length - 1)];
    reads += 1;
    return Promise.resolve({ ok: true, json: async () => page });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The body of the one checkout POST the page sent. */
function postedBody(fetchMock: ReturnType<typeof vi.fn>) {
  const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
  return JSON.parse(String((post?.[1] as RequestInit).body));
}

// The page leaves for the hosted checkout by assigning location.href; record it instead.
let navigatedTo: string | null;
const realLocation = window.location;
beforeEach(() => {
  navigatedTo = null;
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      ...realLocation,
      get href() { return realLocation.href; },
      set href(next: string) { navigatedTo = next; },
    },
  });
});

afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  vi.unstubAllGlobals();
});

describe('public invoice - the method buttons follow the resolver', () => {
  it('offers Pay by card and Pay by bank when both are resolved', async () => {
    stubApi([payload()]);
    renderWithProviders(<PublicInvoicePage />, { initialEntries: [LINK] });

    expect(await screen.findByRole('button', { name: 'Pay by card' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pay by bank' })).toBeInTheDocument();
  });

  // Slice 21's acceptance, moved here: an invoice made bank-only through its Payment options card.
  it('a bank-only invoice offers Pay by bank alone', async () => {
    stubApi([payload({ available_payment_methods: ['ACH'] })]);
    const { container } = renderWithProviders(<PublicInvoicePage />, { initialEntries: [LINK] });

    expect(await screen.findByRole('button', { name: 'Pay by bank' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /card/i })).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\bACH\b/);
  });

  it('a card-only invoice offers Pay by card alone, with the manual methods under it', async () => {
    stubApi([payload({ available_payment_methods: ['CARD', 'CHECK'], payment_instructions: { check: 'Mail it.' } })]);
    renderWithProviders(<PublicInvoicePage />, { initialEntries: [LINK] });

    expect(await screen.findByRole('button', { name: 'Pay by card' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pay by bank' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Pay by Check/ })).toBeInTheDocument();
  });

  it('Pay by card opens a card checkout for the amount on screen', async () => {
    const fetchMock = stubApi([payload()]);
    renderWithProviders(<PublicInvoicePage />, { initialEntries: [LINK] });

    await userEvent.click(await screen.findByRole('button', { name: 'Pay by card' }));

    await waitFor(() => expect(navigatedTo).toBe('https://pay.example/session'));
    expect(postedBody(fetchMock)).toEqual({ method: 'card', expected_amount: 480 });
  });

  it('Pay by bank opens a bank checkout for what can be paid now', async () => {
    const fetchMock = stubApi([payload({ payable_now: 400, processing_amount: 80 })]);
    renderWithProviders(<PublicInvoicePage />, { initialEntries: [LINK] });

    await userEvent.click(await screen.findByRole('button', { name: 'Pay by bank' }));

    await waitFor(() => expect(navigatedTo).toBe('https://pay.example/session'));
    expect(postedBody(fetchMock)).toEqual({ method: 'bank', expected_amount: 400 });
  });
});

describe('public invoice - a bank payment in flight', () => {
  it('says the bank payment is processing and offers no checkout while it covers the amount due', async () => {
    stubApi([payload({ pay_state: 'PROCESSING', processing_amount: 480, payable_now: 0 })]);
    renderWithProviders(<PublicInvoicePage />, { initialEntries: [LINK] });

    expect(await screen.findByText('Your bank payment is processing. It usually takes a few business days.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Pay by/ })).not.toBeInTheDocument();
    expect(within(screen.getByTestId('public-invoice-totals')).getByTestId('public-invoice-processing')).toHaveTextContent('Processing$480.00');
  });

  it('shows the amount still processing beside the amount due, and pays only the rest', async () => {
    stubApi([payload({ processing_amount: 80, payable_now: 400 })]);
    renderWithProviders(<PublicInvoicePage />, { initialEntries: [LINK] });

    await screen.findByRole('button', { name: 'Pay by card' });
    expect(screen.getByTestId('public-invoice-processing')).toHaveTextContent('Processing$80.00');
    expect(screen.queryByText(/Your bank payment is processing/)).not.toBeInTheDocument();
  });
});

describe('public invoice - closed states offer no checkout', () => {
  // The same invoice, payable, shows both pay buttons: the control that makes "no Pay by button"
  // below mean something.
  async function payableShowsBothButtons() {
    stubApi([payload()]);
    const { unmount } = renderWithProviders(<PublicInvoicePage />, { initialEntries: [LINK] });
    expect(await screen.findByRole('button', { name: 'Pay by card' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pay by bank' })).toBeInTheDocument();
    unmount();
  }

  it('a paid invoice says so and drops the pay buttons it showed while payable', async () => {
    await payableShowsBothButtons();
    stubApi([payload({ pay_state: 'PAID', payable_now: 0 }, { status: 'PAID', amount_due: 0, paid_at: '2026-10-02T15:00:00.000Z' })]);
    renderWithProviders(<PublicInvoicePage />, { initialEntries: [LINK] });

    expect(await screen.findByText('Paid in Full')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Pay by/ })).not.toBeInTheDocument();
  });

  it('a voided invoice says so and drops the pay buttons it showed while payable', async () => {
    await payableShowsBothButtons();
    stubApi([payload({ pay_state: 'VOIDED' }, { status: 'VOIDED' })]);
    renderWithProviders(<PublicInvoicePage />, { initialEntries: [LINK] });

    expect(await screen.findByText(/This invoice has been voided/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Pay by/ })).not.toBeInTheDocument();
  });

  it('a deposit whose estimate changed says it is out of date', async () => {
    stubApi([payload({ pay_state: 'CHANGED', deposit_hold_reason: 'SUPERSEDED' }, { kind: 'DEPOSIT' })]);
    renderWithProviders(<PublicInvoicePage />, { initialEntries: [LINK] });

    expect(await screen.findByText(/This deposit request is out of date because the estimate has changed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Pay by/ })).not.toBeInTheDocument();
  });

  it('a deposit whose estimate is being updated says it is on hold', async () => {
    stubApi([payload({ pay_state: 'CHANGED', deposit_hold_reason: 'ESTIMATE_IN_DRAFT' }, { kind: 'DEPOSIT' })]);
    renderWithProviders(<PublicInvoicePage />, { initialEntries: [LINK] });

    expect(await screen.findByText(/This deposit is on hold while the estimate is being updated/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Pay by/ })).not.toBeInTheDocument();
  });

  it('any other closed invoice says it cannot be paid online', async () => {
    stubApi([payload({ pay_state: 'CLOSED' }, { status: 'REFUNDED', amount_due: 0 })]);
    renderWithProviders(<PublicInvoicePage />, { initialEntries: [LINK] });

    expect(await screen.findByText(/This invoice can't be paid online/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Pay by/ })).not.toBeInTheDocument();
  });
});

describe('public invoice - back from the checkout', () => {
  it('a card payment returns to a confirmation that it was received, with no checkout on it', async () => {
    stubApi([payload()]);
    renderWithProviders(<PublicInvoicePage />, { initialEntries: [`${LINK}&payment=success&method=card`] });

    expect(await screen.findByRole('heading', { name: 'Payment received' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Pay by/ })).not.toBeInTheDocument();
  });

  it('a bank payment returns to a confirmation that it is processing', async () => {
    stubApi([payload()]);
    renderWithProviders(<PublicInvoicePage />, { initialEntries: [`${LINK}&payment=success&method=bank`] });

    expect(await screen.findByRole('heading', { name: 'Your bank payment is processing' })).toBeInTheDocument();
    expect(screen.getByText('It usually takes a few business days.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Pay by/ })).not.toBeInTheDocument();
  });

  it('View invoice leaves the confirmation for the invoice as it now stands', async () => {
    // The first read is the page the customer returns to; the second, after the payment landed.
    const fetchMock = stubApi([
      payload(),
      payload({ pay_state: 'PROCESSING', processing_amount: 480, payable_now: 0 }),
    ]);
    renderWithProviders(<PublicInvoicePage />, { initialEntries: [`${LINK}&payment=success&method=bank`] });

    await userEvent.click(await screen.findByRole('button', { name: 'View invoice' }));

    expect(await screen.findByText('Your bank payment is processing. It usually takes a few business days.')).toBeInTheDocument();
    expect(screen.getByText('I00025')).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method !== 'POST')).toHaveLength(2);
  });

  it('a cancelled checkout returns to the invoice, payable again', async () => {
    stubApi([payload()]);
    renderWithProviders(<PublicInvoicePage />, { initialEntries: [`${LINK}&payment=cancelled`] });

    expect(await screen.findByText('Payment was cancelled. You can try again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pay by card' })).toBeInTheDocument();
  });
});

describe('public invoice - a refused checkout says why', () => {
  // Slice 16: a refusal that carries its own homeowner message shows that message.
  it('shows the door\'s own homeowner message when online payment is unavailable', async () => {
    stubApi([payload()], { ok: false, body: { code: 'ONLINE_PAYMENT_UNAVAILABLE', error: "Paying online isn't available for this invoice." } });
    renderWithProviders(<PublicInvoicePage />, { initialEntries: [LINK] });

    await userEvent.click(await screen.findByRole('button', { name: 'Pay by bank' }));

    expect(await screen.findByRole('alert')).toHaveTextContent("Paying online isn't available for this invoice.");
    expect(navigatedTo).toBeNull();
  });

  it('a bank refusal names bank payment, never card payments', async () => {
    stubApi([payload()], { ok: false, body: { error: 'Bank payment is not available' } });
    renderWithProviders(<PublicInvoicePage />, { initialEntries: [LINK] });

    await userEvent.click(await screen.findByRole('button', { name: 'Pay by bank' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Northside Doors isn't accepting bank payments right now/);
  });

  it('an invoice that changed since it was opened is re-read and shown as it now stands', async () => {
    // Opened at $480; a $100 check was recorded before the customer pressed Pay.
    const fetchMock = stubApi(
      [payload(), payload({ payable_now: 380 }, { status: 'PARTIAL', amount_due: 380 })],
      { ok: false, body: { code: 'INVOICE_CHANGED', error: 'This invoice has changed since it was opened.' } },
    );
    renderWithProviders(<PublicInvoicePage />, { initialEntries: [LINK] });

    await userEvent.click(await screen.findByRole('button', { name: 'Pay by card' }));

    expect(await screen.findByText(/This invoice changed since you opened it/)).toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByTestId('public-invoice-totals')).getByText('$380.00')).toBeInTheDocument());
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method !== 'POST')).toHaveLength(2);
    expect(navigatedTo).toBeNull();
  });

  it('an invoice paid in the meantime is re-read and says it is paid', async () => {
    stubApi(
      [payload(), payload({ pay_state: 'PAID', payable_now: 0 }, { status: 'PAID', amount_due: 0 })],
      { ok: false, body: { code: 'INVOICE_NOT_PAYABLE', error: 'Invoice is not payable' } },
    );
    renderWithProviders(<PublicInvoicePage />, { initialEntries: [LINK] });

    await userEvent.click(await screen.findByRole('button', { name: 'Pay by card' }));

    expect(await screen.findByText('Paid in Full')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Pay by/ })).not.toBeInTheDocument();
  });
});

describe('public invoice - paying when no online method is offered', () => {
  // Slice 16: a card taken over the phone is a manual method, labelled as one, with the number.
  it('labels a card taken over the phone as a manual method and gives the business number', async () => {
    stubApi([payload({ available_payment_methods: ['EXTERNAL_CARD', 'CHECK'], payment_instructions: { check: 'Mail it.' } })]);
    renderWithProviders(<PublicInvoicePage />, { initialEntries: [LINK] });

    await userEvent.click(await screen.findByRole('button', { name: /Pay by card over the phone/ }));

    expect(screen.getByText(/Call us at \(555\) 010-4477 to pay by card\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pay by card' })).not.toBeInTheDocument();
  });

  it('offers no card-over-the-phone row when the business has no phone to call', async () => {
    stubApi([payload({
      available_payment_methods: ['EXTERNAL_CARD', 'CHECK'],
      payment_instructions: { check: 'Mail it.' },
      organization: { name: 'Northside Doors', phone: null, timezone: 'America/New_York' },
    })]);
    const { container } = renderWithProviders(<PublicInvoicePage />, { initialEntries: [LINK] });

    expect(await screen.findByRole('button', { name: /Pay by Check/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /card/i })).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/call our office/i);
  });

  // Slice 21 review: an invoice whose override holds only methods the account cannot take is
  // offered nothing; the page says how to pay instead of showing no way at all.
  it('tells the homeowner how to pay when the invoice offers no method at all', async () => {
    stubApi([payload({ available_payment_methods: [] })]);
    renderWithProviders(<PublicInvoicePage />, { initialEntries: [LINK] });

    expect(await screen.findByText(/To pay this invoice, please contact Northside Doors/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Pay by/ })).not.toBeInTheDocument();
  });
});

describe('public invoice - ServWave copy only', () => {
  it('names no payment processor anywhere on the page, in any state', async () => {
    // Each state's own copy is on screen before the page is read, so the check covers it.
    for (const [p, shown] of [
      [payload(), () => screen.findByRole('button', { name: 'Pay by bank' })],
      [payload({ pay_state: 'PROCESSING', processing_amount: 480, payable_now: 0 }), () => screen.findByText(/Your bank payment is processing/)],
      [payload({ available_payment_methods: ['EXTERNAL_CARD'] }), () => screen.findByText('Pay by card over the phone')],
    ] as const) {
      stubApi([p]);
      const { container, unmount } = renderWithProviders(<PublicInvoicePage />, { initialEntries: [LINK] });
      await shown();
      expect(container.textContent).not.toMatch(/stripe|plaid|\bACH\b/i);
      unmount();
    }
  });
});
