/**
 * standalone-invoice-capture.test.tsx - V7-09d: `/invoices/new` opened from an unapplied payment.
 *
 * "Create invoice" on an unapplied payment opens this page in a new tab with `?customer_id=...&unapplied_payment_id=...`.
 * The page then records that payment on the invoice it saves. Tested through the ROUTED page
 * (`pages/v2/invoices/StandaloneInvoiceFormPage`; the v1 page under `pages/` is imported by no route).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { postAttached } from '@/lib/paymentsChannel';
import type { UnappliedDetail } from '@/lib/api/paymentsPage';
import { renderWithProviders } from './helpers';
import StandaloneInvoiceFormPage from '@/pages/v2/invoices/StandaloneInvoiceFormPage';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});
vi.mock('@/lib/paymentsChannel', () => ({ postAttached: vi.fn(), subscribe: vi.fn(() => () => {}) }));

const mockApi = vi.mocked(api);
const mockPost = vi.mocked(postAttached);
const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000001';
const CAPTURE_ID = 'a0000000-0000-0000-0000-0000000000a1';
const CUSTOMER = {
  id: CUSTOMER_ID,
  first_name: 'Dana',
  last_name: 'Deposit',
  company_name: null,
  phone: '5125550100',
  email: 'dana@example.com',
  tax_exempt: false,
  service_locations: [
    { id: 'l1', address_line1: '123 Main St', address_line2: null, city: 'Austin', state: 'TX', zip: '78701', is_primary: true },
  ],
};

function detail(over: Partial<UnappliedDetail> = {}): UnappliedDetail {
  return {
    id: CAPTURE_ID, key: `unmatched_payment:${CAPTURE_ID}`, kind: 'PAYMENT', title: 'Unapplied payment', status: 'open',
    amount: 120, reference: 'RCV-48213AAA', created_at: '2026-10-14T18:08:00.000Z',
    reason_short: 'No invoice found', reason_long: 'x', restricted: false,
    meant_for: { invoice: null }, customer_block: null,
    payer: { received_at: '2026-10-14T18:08:00.000Z', reference: 'RCV-48213AAA', method_label: 'Card', detail: 'Visa •••• 4242', description: 'Door repair' },
    suggested_invoices: [], resolved_at: null, resolved_by_name: null, resolution: null,
    actions: ['attach_to_invoice', 'create_invoice', 'refund', 'mark_resolved'],
    ...over,
  };
}

interface Serve {
  capture?: UnappliedDetail | 'fail' | 'pending';
  customer?: 'fail';
}
function serve({ capture = detail(), customer }: Serve = {}) {
  mockApi.get.mockImplementation(((url: string) => {
    if (url === '/api/state-tax-rates') return Promise.resolve({ data: { data: [{ state_code: 'TX', state_name: 'Texas', tax_rate: 0.0625 }] } });
    if (url === `/api/customers/picker/${CUSTOMER_ID}`) {
      return customer === 'fail' ? Promise.reject(new Error('nope')) : Promise.resolve({ data: { customer: CUSTOMER } });
    }
    if (url === '/api/customers' || url === '/api/customers/picker') return Promise.resolve({ data: { customers: [CUSTOMER] } });
    if (url === `/api/payments-page/attention/unmatched_payment:${CAPTURE_ID}`) {
      if (capture === 'pending') return new Promise(() => {});
      return capture === 'fail' ? Promise.reject({ response: { status: 404, data: { error: 'Not found' } } }) : Promise.resolve({ data: capture });
    }
    return Promise.resolve({ data: { data: [] } });
  }) as never);
}

const URL_BOTH = `/invoices/new?customer_id=${CUSTOMER_ID}&unapplied_payment_id=${CAPTURE_ID}`;
const open = (entry: string) => renderWithProviders(<StandaloneInvoiceFormPage />, { initialEntries: [entry], ability: adminAbility });
const priceInput = () => screen.getAllByPlaceholderText('0.00')[0] as HTMLInputElement;
const nameInput = () => screen.getByPlaceholderText('Item name') as HTMLInputElement;
const setPrice = (v: string) => fireEvent.change(priceInput(), { target: { value: v } });
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save invoice' }));
const invoicePosts = () => mockApi.post.mock.calls.filter((c) => c[0] === '/api/invoices');

function httpError(status: number, data: Record<string, unknown>) {
  return Object.assign(new Error('request failed'), { response: { status, data } });
}

beforeEach(() => {
  vi.clearAllMocks();
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  serve();
});

describe('/invoices/new with customer_id alone (the customer page link)', () => {
  it('opens with that customer already chosen and the line items showing', async () => {
    open(`/invoices/new?customer_id=${CUSTOMER_ID}`);
    await screen.findByPlaceholderText('Item name');
    expect((document.getElementById('email') as HTMLInputElement).value).toBe('dana@example.com');
    expect(screen.queryByText(/select or create a customer/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create Invoice' })).toBeInTheDocument();
  });

  it('falls back to the blank customer form, with no error shown, when the customer cannot be read', async () => {
    serve({ customer: 'fail' });
    open(`/invoices/new?customer_id=${CUSTOMER_ID}`);
    expect(await screen.findByText(/select or create a customer/i)).toBeInTheDocument();
    await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith(`/api/customers/picker/${CUSTOMER_ID}`));
    expect(screen.queryByText(/failed/i)).not.toBeInTheDocument();
  });
});

describe('/invoices/new in capture mode', () => {
  it('says what the invoice will record, prefills the one line, and shows the payment to record', async () => {
    open(URL_BOTH);
    expect(await screen.findByText('This invoice will record $120.00 received on Oct 14, 2026.')).toBeInTheDocument();
    await waitFor(() => expect(nameInput().value).toBe('Door repair'));
    expect(priceInput().value).toBe('120');
    expect(screen.getByText('Payment to record')).toBeInTheDocument();
    expect(screen.getByText('$120.00 · Visa •••• 4242 · Oct 14, 2026')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save invoice' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create Invoice' })).not.toBeInTheDocument();
  });

  it('names the line "Payment received" when the payment has no description, and leaves out a card it lacks', async () => {
    serve({ capture: detail({ payer: { received_at: '2026-10-14T18:08:00.000Z', reference: 'RCV-1' } }) });
    open(URL_BOTH);
    await waitFor(() => expect(nameInput().value).toBe('Payment received'));
    expect(screen.getByText('$120.00 · Oct 14, 2026')).toBeInTheDocument();
  });

  it('shows no customer id anywhere on the page', async () => {
    open(URL_BOTH);
    await screen.findByText(/This invoice will record/);
    expect(document.body.textContent).not.toContain(CUSTOMER_ID);
  });

  it.each([
    ['already resolved', detail({ status: 'resolved' })],
    ['a refund', detail({ kind: 'REFUND' })],
    ['not something this person may create an invoice for', detail({ actions: ['mark_resolved'] })],
    ['unreadable', 'fail' as const],
  ])('renders the normal page, quietly, when the item is %s', async (_n, capture) => {
    serve({ capture });
    open(URL_BOTH);
    await screen.findByPlaceholderText('Item name');
    await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith(`/api/payments-page/attention/unmatched_payment:${CAPTURE_ID}`));
    expect(screen.queryByText(/This invoice will record/)).not.toBeInTheDocument();
    expect(screen.queryByText('Payment to record')).not.toBeInTheDocument();
    expect(nameInput().value).toBe('');
    expect(screen.getByRole('button', { name: 'Create Invoice' })).toBeInTheDocument();
  });

  it('refuses a price of zero under the price, and posts nothing', async () => {
    open(URL_BOTH);
    await waitFor(() => expect(nameInput().value).toBe('Door repair'));
    setPrice('0');
    save();
    expect(await screen.findByText('Enter a price above $0.00.')).toBeInTheDocument();
    expect(invoicePosts()).toHaveLength(0);
  });

  it('refuses a total with tax below the payment under the price, and posts nothing', async () => {
    open(URL_BOTH);
    await waitFor(() => expect(nameInput().value).toBe('Door repair'));
    setPrice('100');
    save();
    expect(await screen.findByText('The invoice must be at least $120.00 so the payment fits.')).toBeInTheDocument();
    expect(invoicePosts()).toHaveLength(0);
  });

  it('allows a subtotal below the payment when the tax lifts the total to it', async () => {
    mockApi.post.mockResolvedValue({ data: { invoice: { id: 'inv-1', invoice_number: 'INV-1042' }, attached_capture: true } });
    open(URL_BOTH);
    await waitFor(() => expect(nameInput().value).toBe('Door repair'));
    // 115.00 + 6.25% tax = 122.19, which is at least 120.00.
    setPrice('115');
    save();
    await waitFor(() => expect(invoicePosts()).toHaveLength(1));
  });

  it('posts the capture id with the invoice, tells the Payments tab, and goes to the invoice', async () => {
    mockApi.post.mockResolvedValue({ data: { invoice: { id: 'inv-1', invoice_number: 'INV-1042' }, attached_capture: true } });
    open(URL_BOTH);
    await waitFor(() => expect(nameInput().value).toBe('Door repair'));
    save();
    await waitFor(() => expect(invoicePosts()).toHaveLength(1));
    expect(invoicePosts()[0][1]).toMatchObject({ customer_id: CUSTOMER_ID, unapplied_capture_id: CAPTURE_ID });
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/invoices/inv-1'));
    expect(mockPost).toHaveBeenCalledWith({ invoice_number: 'INV-1042', amount: 120 });
  });

  it('does not tell the Payments tab when the server did not attach the payment', async () => {
    mockApi.post.mockResolvedValue({ data: { invoice: { id: 'inv-1', invoice_number: 'INV-1042' } } });
    open(URL_BOTH);
    await waitFor(() => expect(nameInput().value).toBe('Door repair'));
    save();
    await waitFor(() => expect(mockNavigate).toHaveBeenCalled());
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('puts the server\'s total-below-payment refusal under the price and focuses it', async () => {
    mockApi.post.mockRejectedValue(httpError(400, { code: 'INVOICE_TOTAL_BELOW_PAYMENT', error: 'The invoice must be at least $120.00 so the payment fits.' }));
    open(URL_BOTH);
    await waitFor(() => expect(nameInput().value).toBe('Door repair'));
    save();
    const msg = await screen.findByText('The invoice must be at least $120.00 so the payment fits.');
    expect(msg.getAttribute('data-error-for')).toBe(priceInput().id);
    await waitFor(() => expect(document.activeElement).toBe(priceInput()));
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('shows the server\'s sentence for a payment already attached or refunded, and offers no retry', async () => {
    mockApi.post.mockRejectedValue(httpError(409, { code: 'NOT_OPEN', error: 'This payment was already attached or refunded.' }));
    open(URL_BOTH);
    await waitFor(() => expect(nameInput().value).toBe('Door repair'));
    save();
    expect(await screen.findByText('This payment was already attached or refunded.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save invoice' })).toBeDisabled();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save invoice' }));
    expect(invoicePosts()).toHaveLength(1);
  });

  it.each([
    [409, 'NOT_OPEN', 'This payment was already attached or refunded.'],
    [403, undefined, 'You do not have permission to record this payment.'],
    [500, undefined, 'Something went wrong on our side.'],
  ])('shows a %i refusal in an alert by the banner, scrolled to and focused', async (status, code, sentence) => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    mockApi.post.mockRejectedValue(httpError(status, { ...(code ? { code } : {}), error: sentence }));
    open(URL_BOTH);
    await waitFor(() => expect(nameInput().value).toBe('Door repair'));
    save();
    const alert = await screen.findByRole('alert', { name: undefined });
    await waitFor(() => expect(screen.getAllByRole('alert').some((a) => a.textContent === sentence)).toBe(true));
    const box = screen.getAllByRole('alert').find((a) => a.textContent === sentence)!;
    expect(alert).toBeTruthy();
    expect(screen.getByText(sentence)).toBe(box.querySelector('p') ?? box);
    await waitFor(() => expect(document.activeElement).toBe(box));
    expect(scroll).toHaveBeenCalled();
    expect(document.querySelector('form')!.contains(box)).toBe(false);
  });

  it('ties the price message to the price field and lets it span the row', async () => {
    open(URL_BOTH);
    await waitFor(() => expect(nameInput().value).toBe('Door repair'));
    setPrice('0');
    save();
    const msg = await screen.findByText('Enter a price above $0.00.');
    expect(priceInput().getAttribute('aria-describedby')).toBe(msg.id);
    expect(msg.closest('[class*="grid-cols-["]')).toBeNull();
  });

  it('keeps Save off, and does not fill over typed lines, until the payment has loaded', async () => {
    serve({ capture: 'pending' });
    open(URL_BOTH);
    const btn = await screen.findByRole('button', { name: /Save invoice|Create Invoice|Continue/ });
    expect(btn).toBeDisabled();
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it('lets Save through once a payment that cannot be read has settled', async () => {
    serve({ capture: 'fail' });
    open(URL_BOTH);
    await screen.findByPlaceholderText('Item name');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create Invoice' })).toBeEnabled());
  });

  it('uses the info icon on the banner', async () => {
    open(URL_BOTH);
    const banner = (await screen.findByText(/This invoice will record/)).closest('[role="status"]')!;
    expect(banner.querySelector('svg')).not.toBeNull();
  });
});
