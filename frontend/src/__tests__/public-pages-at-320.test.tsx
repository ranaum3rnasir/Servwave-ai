/**
 * Mobile slice 28 - the public estimate and invoice, readable and actionable on a 320 px phone.
 *
 * What this file pins (the layout itself is measured in a real browser by
 * `e2e/mobile/public-pages.spec.ts`; jsdom has no layout):
 *
 *   1. A failed action is reported BESIDE the control that failed, as an alert, and takes focus.
 *      Before the slice every failure went to one banner at the top of the page, which at 320 px
 *      is a screen or more above the Approve button the customer just pressed, so the press
 *      looked like it did nothing.
 *   2. Below sm the invoice's line items are stacked rows (description, then quantity, unit price
 *      and amount, each labelled) instead of a four-column table that needs a sideways scroll.
 *      From sm up the table stays.
 *   3. The business's phone and email are a plain call link and a plain mail link. A customer has
 *      no ServWave dialer, so a `tel:` link is the whole contact action.
 *
 * Both pages are the routed v2 ones (`pages/v2/routes/auth-public.routes.tsx`).
 */

import { useEffect } from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import PublicEstimatePage from '@/pages/v2/auth-public/PublicEstimatePage';
import PublicInvoicePage from '@/pages/v2/auth-public/PublicInvoicePage';

const route = vi.hoisted(() => ({ id: 'est-320', token: 'tok-320' }));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: route.id }),
    useSearchParams: () => [new URLSearchParams(`token=${route.token}`), vi.fn()],
  };
});

// Reports "signed" on mount, so Approve is enabled the way it is for a customer who has signed.
vi.mock('react-signature-canvas', () => ({
  default: function SignedCanvas(props: { onEnd?: () => void }) {
    useEffect(() => {
      props.onEnd?.();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return null;
  },
}));

/** The card (kit `Card`) an element sits in. */
const cardOf = (el: HTMLElement) => el.closest('[data-slot="card"]') as HTMLElement | null;

/** Answer below sm (max-width: 639px) as a 320 px phone would, everything else as the default. */
function phoneWidth(isPhone: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: isPhone && /max-width:\s*639/.test(query),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

const ORG = {
  name: 'Neutral Home Services',
  phone: '5551234567',
  phone_ext: null,
  email: 'office.desk.for.everything@neutral-home-services.example',
  website: 'https://neutral-home-services.example/a/very/long/path/that/never/breaks',
  estimate_terms: null,
};

const ESTIMATE_RESPONSE = {
  estimate: {
    id: 'est-320',
    estimate_number: 'E00320',
    status: 'SENT',
    tax_rate: 0,
    subtotal: 1800,
    tax_amount: 0,
    total_amount: 1800,
    scope_notes: '',
    line_items: [
      { id: 'l1', sequence: 1, description: 'Spring replacement', quantity: 1, unit_price: 1800, is_taxable: false, line_total: 1800 },
    ],
    send_config: { deposit_required: false, payment_methods: [] },
    invoices: [],
    lead: { customer: { first_name: 'Pat', last_name: 'Neutral', company_name: null } },
    customer: null,
    signature_data: null,
    signature_at: null,
  },
  organization: ORG,
  payment_instructions: {},
  expired: false,
};

function invoiceResponse(org: Record<string, unknown> = { name: ORG.name, phone: ORG.phone, phone_ext: null, email: ORG.email }) {
  return {
    invoice: {
      id: 'inv-320', invoice_number: 'I00320', status: 'SENT', kind: 'INVOICE',
      subtotal: 300, discount_amount: 0, tax_amount: 0, deposit_credit: 0,
      total_amount: 300, amount_due: 300, due_date: null, sent_at: null,
      paid_at: null, created_at: '2026-01-01', customer: { first_name: 'Pat', last_name: 'Neutral' },
      line_items: [
        { id: 'a', sequence: 1, description: 'Service call', quantity: 1, unit_price: 180, is_taxable: true, line_total: 180 },
        { id: 'b', sequence: 2, description: 'Replacement part', quantity: 2, unit_price: 60, is_taxable: false, line_total: 120 },
      ],
      job: null, payments: [],
    },
    organization: org,
    available_payment_methods: ['CARD'],
    payment_instructions: {},
    service_fee_preview: 0,
  };
}

/** GETs answer with `body`; POST/PATCH answer with a failure carrying a raw backend string. */
function stubFetch(body: unknown) {
  const f = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') {
      return Promise.resolve({ ok: false, json: async () => ({ error: 'internal_error_xyz' }) });
    }
    return Promise.resolve({ ok: true, json: async () => body });
  });
  vi.stubGlobal('fetch', f);
  return f;
}

beforeEach(() => {
  phoneWidth(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('public estimate at 320 (mobile slice 28)', () => {
  beforeEach(() => {
    route.id = 'est-320';
    route.token = 'tok-320';
  });

  it('a failed approval is announced beside Approve and takes focus', async () => {
    stubFetch(ESTIMATE_RESPONSE);
    renderWithProviders(<PublicEstimatePage />);

    const approve = await screen.findByRole('button', { name: /approve estimate/i });
    await waitFor(() => expect(approve).toBeEnabled());
    await userEvent.click(approve);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/something went wrong/i);
    // Beside the button: in the same card as Approve, not in a banner at the top of the page.
    expect(cardOf(approve)).not.toBeNull();
    expect(cardOf(approve)).toContainElement(alert);
    // Focused, so a screen reader and a scrolled-away sighted customer both land on it.
    await waitFor(() => expect(alert).toHaveFocus());
    // One report of the failure, not a second copy at the top.
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('a failed decline is announced beside Decline and takes focus', async () => {
    stubFetch(ESTIMATE_RESPONSE);
    renderWithProviders(<PublicEstimatePage />);

    const decline = await screen.findByRole('button', { name: /^decline$/i });
    await userEvent.click(decline);
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /decline estimate/i }));

    const alert = await screen.findByRole('alert');
    expect(cardOf(decline)).toContainElement(alert);
    await waitFor(() => expect(alert).toHaveFocus());
    // The raw backend string never reaches the homeowner.
    expect(alert).not.toHaveTextContent('internal_error_xyz');
  });

  it("the business's phone and email are a call link and a mail link", async () => {
    stubFetch(ESTIMATE_RESPONSE);
    renderWithProviders(<PublicEstimatePage />);

    const call = await screen.findByRole('link', { name: /\(555\) 123-4567/ });
    expect(call).toHaveAttribute('href', 'tel:5551234567');
    const mail = screen.getByRole('link', { name: ORG.email });
    expect(mail).toHaveAttribute('href', `mailto:${ORG.email}`);
  });
});

describe('public invoice at 320 (mobile slice 28)', () => {
  beforeEach(() => {
    route.id = 'inv-320';
    route.token = 'tok-inv-320';
  });

  it('below sm the line items are stacked, labelled rows, not a sideways table', async () => {
    phoneWidth(true);
    stubFetch(invoiceResponse());
    renderWithProviders(<PublicInvoicePage />);

    const list = await screen.findByRole('list', { name: /line items/i });
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    // Description first, then each figure under its own label.
    const second = within(rows[1]);
    expect(second.getByText('Replacement part')).toBeInTheDocument();
    expect(second.getByText('Qty')).toBeInTheDocument();
    expect(second.getByText('2')).toBeInTheDocument();
    expect(second.getByText('Unit Price')).toBeInTheDocument();
    expect(second.getByText('$60.00')).toBeInTheDocument();
    expect(second.getByText('Amount')).toBeInTheDocument();
    expect(second.getByText('$120.00')).toBeInTheDocument();
  });

  it('from sm up the line items stay a table', async () => {
    phoneWidth(false);
    stubFetch(invoiceResponse());
    renderWithProviders(<PublicInvoicePage />);

    const table = await screen.findByRole('table');
    expect(within(table).getByText('Replacement part')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: /line items/i })).not.toBeInTheDocument();
  });

  it('a failed card checkout is announced beside the Pay button and takes focus', async () => {
    stubFetch(invoiceResponse());
    renderWithProviders(<PublicInvoicePage />);

    // Payments go-live slice 25: Pay by card opens the checkout itself; no fee panel in between.
    const pay = await screen.findByRole('button', { name: 'Pay by card' });
    await userEvent.click(pay);

    const alert = await screen.findByRole('alert');
    expect(cardOf(pay)).toContainElement(alert);
    await waitFor(() => expect(alert).toHaveFocus());
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it("the business's phone and email are a call link and a mail link", async () => {
    stubFetch(invoiceResponse());
    renderWithProviders(<PublicInvoicePage />);

    const call = await screen.findByRole('link', { name: /\(555\) 123-4567/ });
    expect(call).toHaveAttribute('href', 'tel:5551234567');
    expect(screen.getByRole('link', { name: ORG.email })).toHaveAttribute('href', `mailto:${ORG.email}`);
  });
});
