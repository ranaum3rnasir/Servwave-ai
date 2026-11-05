/**
 * #2981 - what a customer is told when a sign or pay try is refused, on BOTH public pages.
 *
 * - 429: "We are experiencing issues. Please try again in a few minutes or call us at {phone}." with the
 *   phone as a call link; with no phone on file the sentence ends after "a few minutes".
 * - 404 on an action: "This link is out of date. Please open the latest link we sent you, or call us at
 *   {phone}."
 * - Anything else keeps the page's generic message. No message names a vendor.
 */
import { useEffect } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/__tests__/helpers';

import PublicEstimatePage from '../PublicEstimatePage';
import PublicInvoicePage from '../PublicInvoicePage';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: 'doc-1' }),
    useSearchParams: () => [new URLSearchParams('token=tok'), vi.fn()],
  };
});

function SignatureCanvasStub(props: { onEnd?: () => void }) {
  useEffect(() => {
    props.onEnd?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
vi.mock('react-signature-canvas', () => ({ default: SignatureCanvasStub }));

const WAIT = /We are experiencing issues\. Please try again in a few minutes/;
const STALE = /This link is out of date\. Please open the latest link we sent you/;
const GENERIC = /Something went wrong starting your payment\. Please try again or contact us\./;

const estimatePage = (phone: string | null) => ({
  estimate: {
    id: 'doc-1', estimate_number: 'E00900', status: 'SENT',
    tax_rate: 0, subtotal: 1000, tax_amount: 0, total_amount: 1000, scope_notes: '', line_items: [],
    send_config: { deposit_required: true, deposit_percentage: 50, deposit_amount: 500, payment_methods: ['CARD', 'CHECK'], message_body: null },
    invoices: [{ id: 'dep-inv-flows', kind: 'DEPOSIT', status: 'SENT', total_amount: 500, amount_due: 500, public_token: 'dep-tok' }], lead: { customer: { first_name: 'Pat', last_name: 'Customer', company_name: null } }, customer: null,
    signature_data: null, signature_at: null, approved_at: null,
  },
  organization: { name: 'Org', estimate_terms: null, phone },
  payment_instructions: {},
  payment_options: { methods: ['CARD', 'CHECK'], online_methods: ['CARD'], tips: { enabled: false, presets: [] }, allow_partial: false, deposit_policy: 'REQUIRED_BEFORE_APPROVAL' },
  deposit: { pay_state: 'PAYABLE', hold_reason: null, payable_now: 500, processing_amount: 0 },
  expired: false,
});

const invoicePage = (phone: string | null) => ({
  invoice: {
    id: 'doc-1', invoice_number: 'I00009', status: 'SENT', kind: 'STANDARD',
    subtotal: 300, discount_amount: 0, tax_amount: 0, deposit_credit: 0, total_amount: 300, amount_due: 300,
    due_date: null, sent_at: '2026-03-01T00:00:00.000Z', paid_at: null, created_at: '2026-03-01T00:00:00.000Z',
    job: null,
    customer: { first_name: 'Dana', last_name: 'Deposit', email: 'dana@example.com', phone: '5550001111' },
    line_items: [{ id: 'li-1', sequence: 1, description: 'Work', quantity: 1, unit_price: 300, is_taxable: false, line_total: 300 }],
    payments: [],
  },
  organization: { name: 'Acme Services', phone, phone_ext: phone ? '12' : null },
  available_payment_methods: ['CARD'],
  payment_instructions: {},
});

function stub(page: unknown, post: { status: number; body: unknown }) {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init?: RequestInit) =>
    init?.method === 'POST'
      ? Promise.resolve({ ok: false, status: post.status, json: async () => post.body })
      : Promise.resolve({ ok: true, status: 200, json: async () => page })));
}

const payOnEstimate = async () => userEvent.setup().click(await screen.findByRole('button', { name: /pay with credit\/debit card/i }));
const payOnInvoice = async () => userEvent.click(await screen.findByRole('button', { name: 'Pay by card' }));

afterEach(() => vi.unstubAllGlobals());

describe.each([
  ['estimate page', PublicEstimatePage, estimatePage, payOnEstimate, GENERIC],
  ['invoice page', PublicInvoicePage, invoicePage, payOnInvoice, GENERIC],
] as const)('%s', (_name, Page, payload, pay, generic) => {
  it('429 shows the wait message with the company phone as a call link', async () => {
    stub(payload('5551234567'), { status: 429, body: { error: 'Too many requests', retryAfter: 600 } });
    renderWithProviders(<Page />, { initialEntries: ['/p/x/doc-1?token=tok'] });
    await pay();

    const alert = await screen.findByTestId('public-action-error');
    expect(alert).toHaveTextContent(/We are experiencing issues\. Please try again in a few minutes or call us at \(555\) 123-4567/);
    expect(within(alert).getByRole('link', { name: '(555) 123-4567' })).toHaveAttribute('href', 'tel:5551234567');
    expect(alert.textContent).not.toMatch(/redis|stripe|supabase|resend|render|vercel|too many requests/i);
  });

  it('429 with no phone on file ends the sentence after "a few minutes"', async () => {
    stub(payload(null), { status: 429, body: { error: 'Too many requests', retryAfter: 600 } });
    renderWithProviders(<Page />, { initialEntries: ['/p/x/doc-1?token=tok'] });
    await pay();

    const alert = await screen.findByTestId('public-action-error');
    expect(alert.textContent).toBe('We are experiencing issues. Please try again in a few minutes.');
    expect(within(alert).queryByRole('link')).not.toBeInTheDocument();
  });

  it('404 on the action says the link is out of date, with the phone as a call link', async () => {
    stub(payload('5551234567'), { status: 404, body: { error: 'Not found' } });
    renderWithProviders(<Page />, { initialEntries: ['/p/x/doc-1?token=tok'] });
    await pay();

    const alert = await screen.findByTestId('public-action-error');
    expect(alert).toHaveTextContent(STALE);
    expect(alert).toHaveTextContent(/or call us at \(555\) 123-4567/);
    expect(within(alert).getByRole('link', { name: '(555) 123-4567' })).toHaveAttribute('href', 'tel:5551234567');
  });

  it('any other failure keeps the generic message', async () => {
    stub(payload('5551234567'), { status: 500, body: { error: 'internal detail' } });
    renderWithProviders(<Page />, { initialEntries: ['/p/x/doc-1?token=tok'] });
    await pay();

    await waitFor(() => expect(screen.getByTestId('public-action-error')).toHaveTextContent(generic));
    expect(screen.queryByText(WAIT)).not.toBeInTheDocument();
    expect(screen.queryByText(STALE)).not.toBeInTheDocument();
  });
});
