/**
 * Payments go-live slice 26 - the routed public invoice page (`/p/invoices/:id`): when allowed the
 * homeowner pays part of the invoice, adds a tip (a preset of the pre-tax amount being paid, a
 * custom figure, or none) and sees the exact total before paying.
 *
 * The page renders from the public payload's `payment_options`; the checkout door is the bare
 * `fetch` POST, stubbed here. Money expectations are worked by hand from the spec, never recomputed
 * with the page's own arithmetic.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/__tests__/helpers';

import PublicInvoicePage from '../PublicInvoicePage';

const LINK = '/p/invoices/inv-26?token=tok-26';

interface Options {
  allow_partial?: boolean;
  tips_enabled?: boolean;
  total?: number;
  tax?: number;
  due?: number;
  payable_now?: number;
  location?: Record<string, unknown> | null;
}

/** A sent invoice's public payload. Defaults: $100.00, no tax, partial and tips both on. */
function payload(o: Options = {}) {
  const total = o.total ?? 100;
  const tax = o.tax ?? 0;
  const due = o.due ?? total;
  return {
    invoice: {
      id: 'inv-26',
      invoice_number: 'I00026',
      status: 'SENT',
      kind: 'STANDARD',
      subtotal: total - tax,
      discount_amount: 0,
      tax_amount: tax,
      deposit_credit: 0,
      total_amount: total,
      amount_due: due,
      due_date: null,
      sent_at: '2026-10-01T14:00:00.000Z',
      paid_at: null,
      created_at: '2026-10-01T14:00:00.000Z',
      job: o.location
        ? { job_number: 'J1', estimate: null, charges: [], customer: { first_name: 'Robin', last_name: 'Homeowner' }, service_location: o.location }
        : null,
      customer: { first_name: 'Robin', last_name: 'Homeowner' },
      line_items: [{ id: 'l1', sequence: 1, description: 'Gate opener install', quantity: 1, unit_price: total - tax, is_taxable: false, line_total: total - tax }],
      payments: [],
    },
    organization: { name: 'Northside Doors', phone: '5550104477', timezone: 'America/New_York' },
    deposit_hold_reason: null,
    pay_state: 'PAYABLE',
    processing_amount: 0,
    payable_now: o.payable_now ?? due,
    available_payment_methods: ['CARD', 'ACH'],
    payment_instructions: {},
    payment_options: {
      allow_partial: o.allow_partial ?? true,
      tips: o.tips_enabled === false
        ? { enabled: false, presets: [], preset_amounts: [] }
        : { enabled: true, presets: [10, 15, 20], preset_amounts: [] },
    },
  };
}

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

const posts = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
const postedBody = (fetchMock: ReturnType<typeof vi.fn>) => JSON.parse(String((posts(fetchMock)[0]![1] as RequestInit).body));
const reads = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method !== 'POST').length;

const realLocation = window.location;
beforeEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...realLocation, get href() { return realLocation.href; }, set href(_next: string) { /* hosted checkout handoff */ } },
  });
});
afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  vi.unstubAllGlobals();
});

async function open(o: Options = {}) {
  const fetchMock = stubApi([payload(o)]);
  const view = renderWithProviders(<PublicInvoicePage />, { initialEntries: [LINK] });
  await screen.findByRole('button', { name: 'Pay by card' });
  return { fetchMock, ...view };
}

const amountField = () => screen.getByLabelText('Amount to pay') as HTMLInputElement;
const typeAmount = async (user: ReturnType<typeof userEvent.setup>, value: string) => {
  await user.clear(amountField());
  if (value) await user.type(amountField(), value);
};

describe('public invoice - the amount to pay', () => {
  // Slice 21's check, moved here: the invoice allowed to take partial payments shows the field,
  // its sibling does not.
  it('shows the partial-amount field, filled with what is payable now, when partial payment is allowed', async () => {
    await open({ allow_partial: true });

    expect(amountField().value).toBe('100.00');
  });

  it('shows no amount field on an invoice that does not take a partial payment', async () => {
    await open({ allow_partial: false });

    expect(screen.queryByLabelText('Amount to pay')).not.toBeInTheDocument();
  });

  it('refuses an amount under $1 inline and holds the Pay buttons', async () => {
    const user = userEvent.setup();
    await open();

    await typeAmount(user, '0.50');

    expect(screen.getByText('The smallest payment is $1.00.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pay by card' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Pay by bank' })).toBeDisabled();
  });

  it('refuses an amount above what can be paid now, naming that figure', async () => {
    const user = userEvent.setup();
    await open({ total: 150, due: 150, payable_now: 90 });

    await typeAmount(user, '90.01');

    expect(screen.getByText('That is more than the $90.00 that can be paid now.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pay by card' })).toBeDisabled();
  });

  it('a tip on top of the whole payable amount never trips the balance message', async () => {
    // V7-12 pin: the balance cap is on the amount; a tip is a separate line and is not counted against it.
    const user = userEvent.setup();
    await open({ total: 100, due: 100, payable_now: 100 });

    await typeAmount(user, '100');
    await user.click(screen.getByRole('button', { name: 'Custom' }));
    await user.type(screen.getByLabelText('Tip amount'), '10');

    expect(screen.queryByText(/more than the/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pay by card' })).toBeEnabled();
  });

  it('refuses an empty or non-numeric amount, and accepts $1.00 and the whole payable amount', async () => {
    const user = userEvent.setup();
    await open();

    await typeAmount(user, '');
    expect(screen.getByText('Enter an amount to pay.')).toBeInTheDocument();
    await typeAmount(user, 'abc');
    expect(screen.getByText('Enter an amount to pay.')).toBeInTheDocument();

    await typeAmount(user, '1');
    expect(screen.getByRole('button', { name: 'Pay by card' })).toBeEnabled();
    await typeAmount(user, '100');
    expect(screen.getByRole('button', { name: 'Pay by card' })).toBeEnabled();
    expect(screen.queryByText(/smallest payment|more than the/)).not.toBeInTheDocument();
  });
});

describe('public invoice - the tip', () => {
  it('offers the three presets, computed on the pre-tax share, with Custom and No tip', async () => {
    // $108.75 with $8.75 tax: pre-tax $100.00, so 10/15/20% tip $10.00 / $15.00 / $20.00.
    await open({ total: 108.75, tax: 8.75 });

    expect(screen.getByRole('button', { name: /10%.*\$10\.00/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /15%.*\$15\.00/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /20%.*\$20\.00/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Custom' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'No tip' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('recomputes the presets on the pre-tax part of the amount being paid when a smaller amount is typed', async () => {
    // $40.00 of a $108.75 invoice (tax $8.75): 40 x 100 / 108.75 = $36.78 pre-tax share; 15% = $5.52.
    const user = userEvent.setup();
    await open({ total: 108.75, tax: 8.75 });

    await typeAmount(user, '40');

    expect(screen.getByRole('button', { name: /15%.*\$5\.52/ })).toBeInTheDocument();
  });

  it('shows no tip controls when the business has tips off', async () => {
    await open({ tips_enabled: false });

    expect(screen.queryByRole('button', { name: 'No tip' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Custom' })).not.toBeInTheDocument();
  });

  it('takes a custom tip and refuses one above the invoice total or below zero', async () => {
    const user = userEvent.setup();
    await open();
    await user.click(screen.getByRole('button', { name: 'Custom' }));
    const tip = screen.getByLabelText('Tip amount');

    await user.type(tip, '100.01');
    expect(screen.getByText('A tip can be at most $100.00.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pay by card' })).toBeDisabled();

    await user.clear(tip);
    await user.type(tip, '-5');
    expect(screen.getByText('Enter a tip of $0.00 or more.')).toBeInTheDocument();

    await user.clear(tip);
    await user.type(tip, '7.25');
    expect(screen.queryByText(/A tip can be at most|Enter a tip/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pay by card' })).toBeEnabled();
  });
});

describe('public invoice - the total line and what checkout receives', () => {
  it('says "You\'ll be charged" the amount plus the tip, and sends both to checkout', async () => {
    // Acceptance: $40 of $100 with a 15% preset tip ($6.00) -> $46.00.
    const user = userEvent.setup();
    const { fetchMock } = await open();

    await typeAmount(user, '40');
    await user.click(screen.getByRole('button', { name: /15%/ }));

    expect(screen.getByText("You'll be charged $46.00")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Pay by card' }));

    await waitFor(() => expect(posts(fetchMock)).toHaveLength(1));
    expect(postedBody(fetchMock)).toEqual({ method: 'card', expected_amount: 100, amount: 40, tip: 6 });
  });

  it('a custom tip adds to the total line and rides to checkout', async () => {
    const user = userEvent.setup();
    const { fetchMock } = await open();

    await user.click(screen.getByRole('button', { name: 'Custom' }));
    await user.type(screen.getByLabelText('Tip amount'), '7.25');

    expect(screen.getByText("You'll be charged $107.25")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Pay by bank' }));
    await waitFor(() => expect(posts(fetchMock)).toHaveLength(1));
    expect(postedBody(fetchMock)).toEqual({ method: 'bank', expected_amount: 100, tip: 7.25 });
  });

  it('paying the whole amount with no tip sends neither an amount nor a tip', async () => {
    const user = userEvent.setup();
    const { fetchMock } = await open();

    expect(screen.getByText("You'll be charged $100.00")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Pay by card' }));

    await waitFor(() => expect(posts(fetchMock)).toHaveLength(1));
    expect(postedBody(fetchMock)).toEqual({ method: 'card', expected_amount: 100 });
  });

  it('No tip returns the total to the amount alone', async () => {
    const user = userEvent.setup();
    await open();

    await user.click(screen.getByRole('button', { name: /20%/ }));
    expect(screen.getByText("You'll be charged $120.00")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'No tip' }));

    expect(screen.getByText("You'll be charged $100.00")).toBeInTheDocument();
  });
});

describe('public invoice - refusals from the checkout door', () => {
  it('re-reads the invoice when the options it offered were withdrawn, instead of a dead end', async () => {
    const user = userEvent.setup();
    const first = payload();
    const second = payload({ allow_partial: false, tips_enabled: false });
    const fetchMock = stubApi([first, second], { ok: false, body: { error: 'Tips are not accepted on this invoice', code: 'PAYMENT_OPTIONS_CHANGED' } });
    renderWithProviders(<PublicInvoicePage />, { initialEntries: [LINK] });
    await screen.findByRole('button', { name: 'Pay by card' });

    await user.click(screen.getByRole('button', { name: /15%/ }));
    await user.click(screen.getByRole('button', { name: 'Pay by card' }));

    await waitFor(() => expect(reads(fetchMock)).toBe(2));
    await waitFor(() => expect(screen.queryByLabelText('Amount to pay')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'No tip' })).not.toBeInTheDocument();
  });

  it('answers a fraction of a cent in dollars and cents, not with the minimum', async () => {
    const user = userEvent.setup();
    stubApi([payload()], { ok: false, body: { error: 'Enter an amount in dollars and cents.', code: 'AMOUNT_NOT_WHOLE_CENTS' } });
    renderWithProviders(<PublicInvoicePage />, { initialEntries: [LINK] });
    await screen.findByRole('button', { name: 'Pay by card' });

    await user.click(screen.getByRole('button', { name: 'Pay by card' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Enter an amount in dollars and cents.');
  });

  it('shows a bad figure the server caught inline, in the page\'s own words', async () => {
    const user = userEvent.setup();
    const fetchMock = stubApi([payload()], { ok: false, body: { error: 'The smallest payment is $1.00', code: 'AMOUNT_BELOW_MINIMUM' } });
    renderWithProviders(<PublicInvoicePage />, { initialEntries: [LINK] });
    await screen.findByRole('button', { name: 'Pay by card' });

    await user.click(screen.getByRole('button', { name: 'Pay by card' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The smallest payment is $1.00.');
    expect(reads(fetchMock)).toBe(1);
  });
});

describe('public invoice - the address', () => {
  it('prints the service address with its street line (Ran 2026-10-08)', async () => {
    stubApi([payload({ location: { address_line1: '12 Maple Street', address_line2: 'Unit 4', city: 'Testville', state: 'MA', zip: '02108' } })]);
    renderWithProviders(<PublicInvoicePage />, { initialEntries: [LINK] });

    expect(await screen.findByText('12 Maple Street')).toBeInTheDocument();
    expect(screen.getByText('Unit 4')).toBeInTheDocument();
    expect(screen.getByText('Testville, MA 02108')).toBeInTheDocument();
  });
});
