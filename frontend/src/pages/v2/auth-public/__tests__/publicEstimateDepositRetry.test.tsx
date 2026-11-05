/**
 * #2979 - a signed customer whose deposit is not paid can always pay it from the estimate page.
 *
 * Back from the payment page without paying, the warning sits ABOVE the status, and the "Select
 * Payment Method" list sits under the status. A later visit shows the same list without the
 * warning. Card and bank rows open the deposit's own checkout with the expected amount; they never
 * re-run the approval (which re-checked the terms the page no longer shows and refused every retry).
 *
 * The last block is the sweep: every way into a deposit checkout on the two public pages, and every
 * state that draws (or must not draw) the signed-not-paid list, pinned in one table.
 */
import { useEffect } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';

import { renderWithProviders } from '@/__tests__/helpers';

import PublicEstimatePage from '../PublicEstimatePage';
import PublicInvoicePage from '../PublicInvoicePage';

// The signature pad reports a signature at mount (the signing list needs one drawn).
function SignatureCanvasStub(props: { onEnd?: () => void }) {
  useEffect(() => {
    props.onEnd?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
vi.mock('react-signature-canvas', () => ({ default: SignatureCanvasStub }));

type DepositState = { pay_state: string; hold_reason: string | null; payable_now: number; processing_amount: number } | null;

interface Options {
  status?: 'SENT' | 'PENDING' | 'WON';
  policy?: 'REQUIRED_BEFORE_APPROVAL' | 'PAY_LATER';
  sent?: string[];
  deposit?: DepositState;
  signed?: boolean;
  terms?: string | null;
}

function payload(o: Options = {}) {
  const status = o.status ?? 'PENDING';
  const signed = o.signed ?? status !== 'SENT';
  return {
    estimate: {
      id: 'est-retry',
      estimate_number: 'E02979',
      status,
      tax_rate: 0, subtotal: 1000, tax_amount: 0, total_amount: 1000,
      scope_notes: '', line_items: [],
      send_config: { deposit_required: true, deposit_percentage: 50, deposit_amount: 500, payment_methods: o.sent ?? ['CARD', 'ACH', 'CHECK'], message_body: null },
      invoices: [{ id: 'dep-inv-retry', kind: 'DEPOSIT', status: 'SENT', total_amount: 500, amount_due: 500, public_token: 'dep-tok' }],
      lead: { customer: { first_name: 'Pat', last_name: 'Customer', company_name: null } },
      customer: null,
      signature_data: signed ? 'data:image/png;base64,abc' : null,
      signature_at: signed ? '2026-10-30T14:42:00.000Z' : null,
      approved_at: status === 'WON' ? '2026-10-30T14:42:00.000Z' : null,
      terms_accepted: o.terms ? true : null,
    },
    // Terms the customer accepted at signing: the page no longer shows the agree box once signed.
    organization: { name: 'Org', estimate_terms: o.terms === undefined ? 'Work is guaranteed for one year.' : o.terms, phone: '5551234567' },
    payment_instructions: {},
    payment_options: { deposit_policy: o.policy ?? 'REQUIRED_BEFORE_APPROVAL' },
    deposit: o.deposit === undefined
      ? { pay_state: 'PAYABLE', hold_reason: null, payable_now: 500, processing_amount: 0 }
      : o.deposit,
    expired: false,
  };
}

const INVOICE_PAGE = {
  invoice: {
    id: 'dep-inv-retry', invoice_number: 'D02979', status: 'SENT', kind: 'DEPOSIT',
    subtotal: 500, discount_amount: 0, tax_amount: 0, deposit_credit: 0, total_amount: 500, amount_due: 500,
    due_date: null, sent_at: '2026-10-30T00:00:00.000Z', paid_at: null, created_at: '2026-10-30T00:00:00.000Z',
    job: null, customer: { first_name: 'Pat', last_name: 'Customer' },
    line_items: [{ id: 'li-1', sequence: 1, description: 'Deposit', quantity: 1, unit_price: 500, is_taxable: false, line_total: 500 }],
    payments: [],
  },
  organization: { name: 'Org' },
  available_payment_methods: ['CARD'],
  payment_instructions: {},
};

function stubApi(page: unknown) {
  const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      return Promise.resolve({ ok: true, json: async () => ({ checkout_url: 'https://pay.example/session' }) });
    }
    return Promise.resolve({ ok: true, json: async () => page });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const posts = (m: ReturnType<typeof vi.fn>) => m.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
const postUrl = (m: ReturnType<typeof vi.fn>) => String(posts(m)[0]![0]);
const postBody = (m: ReturnType<typeof vi.fn>) => JSON.parse(String((posts(m)[0]![1] as RequestInit).body));

/** The routed estimate page, opened on `query`. */
function openEstimate(query = 'token=tok-retry') {
  return renderWithProviders(
    <Routes><Route path="/p/estimates/:id" element={<PublicEstimatePage />} /></Routes>,
    { initialEntries: [`/p/estimates/est-retry?${query}`] },
  );
}
function openInvoice() {
  return renderWithProviders(
    <Routes><Route path="/p/invoices/:id" element={<PublicInvoicePage />} /></Routes>,
    { initialEntries: ['/p/invoices/dep-inv-retry?token=dep-tok'] },
  );
}

let handedOffTo: string | null = null;
const realLocation = window.location;
beforeEach(() => {
  handedOffTo = null;
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...realLocation, get href() { return realLocation.href; }, set href(next: string) { handedOffTo = next; } },
  });
});
afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  vi.unstubAllGlobals();
});

const WARNING = 'Payment was not completed. You can try again below.';
const STATUS = 'Approved - Deposit Pending';

/** True when `first` comes before `second` in the document. */
const before = (first: HTMLElement, second: HTMLElement) =>
  !!(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('back from the payment page without paying', () => {
  it('shows the warning above the status, and the card and bank rows under the status', async () => {
    stubApi(payload());
    openEstimate('token=tok-retry&payment=cancelled');

    const warning = await screen.findByText(WARNING);
    const status = screen.getByText(STATUS);
    const list = screen.getByText('Select Payment Method');
    const card = screen.getByRole('button', { name: /pay with credit\/debit card/i });
    const bank = screen.getByRole('button', { name: /pay by bank account/i });

    expect(before(warning, status)).toBe(true);
    expect(before(status, list)).toBe(true);
    expect(before(list, card)).toBe(true);
    expect(before(card, bank)).toBe(true);
    // #2980 - every method the estimate was sent with, check included; the list after signing has no Decline.
    expect(before(bank, screen.getByRole('button', { name: /pay by check/i }))).toBe(true);
    expect(screen.queryByRole('button', { name: /decline/i })).not.toBeInTheDocument();
  });

  it('a later visit shows the same rows without the warning', async () => {
    stubApi(payload());
    openEstimate();

    expect(await screen.findByText(STATUS)).toBeInTheDocument();
    expect(screen.getByText('Select Payment Method')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /pay with credit\/debit card/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /pay by bank account/i })).toBeInTheDocument();
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
  });

  it('a card retry opens the deposit checkout with the expected amount, never the approval', async () => {
    const m = stubApi(payload());
    openEstimate('token=tok-retry&payment=cancelled');

    await userEvent.setup().click(await screen.findByRole('button', { name: /pay with credit\/debit card/i }));

    await waitFor(() => expect(handedOffTo).toBe('https://pay.example/session'));
    expect(posts(m)).toHaveLength(1);
    expect(postUrl(m)).toContain('/api/invoices/dep-inv-retry/public/checkout?token=dep-tok');
    expect(postBody(m)).toEqual({ method: 'card', expected_amount: 500, return_to: 'estimate' });
  });

  it('a bank retry opens the deposit checkout by bank', async () => {
    const m = stubApi(payload());
    openEstimate();

    await userEvent.setup().click(await screen.findByRole('button', { name: /pay by bank account/i }));

    await waitFor(() => expect(handedOffTo).toBe('https://pay.example/session'));
    expect(postUrl(m)).toContain('/api/invoices/dep-inv-retry/public/checkout');
    expect(postBody(m)).toMatchObject({ method: 'bank', expected_amount: 500 });
  });
});

/**
 * Every way into a deposit checkout, and every state of the signed-not-paid list. `click` is the
 * row's button; `door` is where it must post (`approve` = the signing door, `checkout` = the
 * deposit's own door), or `none` when the state must draw no payment rows at all.
 */
type Entry = {
  name: string;
  open: () => void;
  click?: RegExp;
  door: 'approve' | 'checkout' | 'none';
  body?: Record<string, unknown>;
  shows?: string;
};

const PAY_ROWS = /pay with credit\/debit card|pay by bank account|pay deposit by|pay by card/i;

const ENTRIES: Entry[] = [
  { name: 'signing list, card (first approval)', open: () => { stubApi(payload({ status: 'SENT', terms: null })); openEstimate(); }, click: /pay with credit\/debit card/i, door: 'approve', body: { payment_method: 'CARD' } },
  { name: 'signing list, bank (first approval)', open: () => { stubApi(payload({ status: 'SENT', terms: null })); openEstimate(); }, click: /pay by bank account/i, door: 'approve', body: { payment_method: 'ACH' } },
  { name: 'signed, not paid: card', open: () => { stubApi(payload()); openEstimate(); }, click: /pay with credit\/debit card/i, door: 'checkout', body: { method: 'card', expected_amount: 500, return_to: 'estimate' } },
  { name: 'signed, not paid: bank', open: () => { stubApi(payload()); openEstimate(); }, click: /pay by bank account/i, door: 'checkout', body: { method: 'bank', expected_amount: 500, return_to: 'estimate' } },
  { name: 'cancelled return: card', open: () => { stubApi(payload()); openEstimate('token=tok-retry&payment=cancelled'); }, click: /pay with credit\/debit card/i, door: 'checkout', body: { method: 'card', expected_amount: 500, return_to: 'estimate' } },
  { name: 'signed, not paid, card only sent', open: () => { stubApi(payload({ sent: ['CARD', 'CHECK'] })); openEstimate(); }, click: /pay with credit\/debit card/i, door: 'checkout', body: { method: 'card' } },
  { name: '"Deposit due" card (pay later), card', open: () => { stubApi(payload({ status: 'WON', policy: 'PAY_LATER' })); openEstimate(); }, click: /pay deposit by card/i, door: 'checkout', body: { method: 'card', expected_amount: 500, return_to: 'estimate' } },
  { name: '"Deposit due" card (bank debit failed), bank', open: () => { stubApi(payload({ status: 'WON' })); openEstimate(); }, click: /pay deposit by bank/i, door: 'checkout', body: { method: 'bank', expected_amount: 500, return_to: 'estimate' } },
  { name: 'deposit invoice page, card', open: () => { stubApi(INVOICE_PAGE); openInvoice(); }, click: /^pay by card$/i, door: 'checkout', body: { method: 'card' } },
  { name: 'signed, deposit held (recalled)', open: () => { stubApi(payload({ deposit: { pay_state: 'CHANGED', hold_reason: 'ESTIMATE_IN_DRAFT', payable_now: 500, processing_amount: 0 } })); openEstimate(); }, door: 'none', shows: 'This deposit is on hold while the estimate is being updated.' },
  { name: 'signed, deposit held (figure moved)', open: () => { stubApi(payload({ deposit: { pay_state: 'CHANGED', hold_reason: 'SUPERSEDED', payable_now: 500, processing_amount: 0 } })); openEstimate('token=tok-retry&payment=cancelled'); }, door: 'none', shows: 'This deposit request is out of date because the estimate has changed.' },
  { name: 'signed, bank payment processing', open: () => { stubApi(payload({ deposit: { pay_state: 'PROCESSING', hold_reason: null, payable_now: 0, processing_amount: 500 } })); openEstimate(); }, door: 'none', shows: STATUS },
  { name: 'success return before the payment is booked', open: () => { stubApi(payload()); openEstimate('token=tok-retry&payment=success&method=card'); }, door: 'none', shows: 'Payment received! Your estimate has been approved.' },
  { name: 'PENDING set by hand, never signed', open: () => { stubApi(payload({ signed: false })); openEstimate(); }, door: 'none', shows: STATUS },
];

describe('every way into a deposit checkout', () => {
  it.each(ENTRIES)('$name', async (entry) => {
    entry.open();

    if (entry.door === 'none') {
      expect(await screen.findByText(new RegExp(entry.shows!.replace(/[.!?()]/g, '\\$&')))).toBeInTheDocument();
      expect(screen.queryAllByRole('button', { name: PAY_ROWS })).toHaveLength(0);
      expect(screen.queryByText('Select Payment Method')).not.toBeInTheDocument();
      return;
    }

    const m = vi.mocked(fetch) as unknown as ReturnType<typeof vi.fn>;
    await userEvent.setup().click(await screen.findByRole('button', { name: entry.click! }));

    await waitFor(() => expect(handedOffTo).toBe('https://pay.example/session'));
    expect(posts(m)).toHaveLength(1);
    expect(postUrl(m)).toContain(entry.door === 'approve' ? '/api/estimates/est-retry/approve' : '/public/checkout');
    expect(postUrl(m)).not.toContain(entry.door === 'approve' ? '/public/checkout' : '/approve');
    expect(postBody(m)).toMatchObject(entry.body!);
  });
});
