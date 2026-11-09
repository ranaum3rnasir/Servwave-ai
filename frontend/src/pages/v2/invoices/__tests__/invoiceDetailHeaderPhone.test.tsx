import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { seesPrices } from '@/__tests__/helpers';
import { MEDIA } from '@/ui-kit/lib/breakpoints';
import { catalogToggle } from '@/__tests__/support/backendSwitchCatalog';

import { mountInvoiceDetail } from '@/__tests__/harness/invoiceDetailPage';

/**
 * Mobile slice 55: the invoice header on the shared detail header.
 *
 * Before: the title column sat beside a `shrink-0` action cluster, so at 393 px the customer
 * name was squeezed to 0 px. Now below sm the header stacks: Back and the invoice + customer on
 * one row (the name truncates, its full value in a title), the amount due, the one primary
 * action full width and everything else inside "More actions".
 */

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const INVOICE_ID = 'i0000000-0000-0000-0000-000000000001';
const mockNavigate = vi.fn();

vi.mock('react-router-dom', async () => (await import('@/__tests__/harness/invoiceDetailRouter')).invoiceDetailRouter({ navigate: () => mockNavigate }));

const originalMatchMedia = window.matchMedia;

function setPhone(isPhone: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: isPhone && query === MEDIA.belowSm,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

const LONG_NAME = 'Bartholomew Featherstonehaugh-Cholmondeley';

function invoice(status: string) {
  return {
    id: INVOICE_ID,
    invoice_number: 'I00001',
    status,
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
    sent_at: status === 'DRAFT' ? null : '2026-01-16T00:00:00.000Z',
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
    // The server's answer for this invoice: every action the header can offer.
    actions: ['edit', 'send', 'delete', 'copy_payment_link', 'record_payment'],
    job: null,
    estimate: null,
    customer: {
      id: 'c0000000-0000-0000-0000-000000000001',
      first_name: 'Bartholomew',
      last_name: 'Featherstonehaugh-Cholmondeley',
      company_name: null,
      email: 'an.extremely.long.billing.address.for.testing@example-company-name.test',
      phone: '5125550125',
    },
  };
}

function mount(status: string) {
  mountInvoiceDetail({
    id: INVOICE_ID,
    invoice: invoice(status),
    // The customer's name links to their page, and their email is a mail link, for a person holding these two switches.
    routes: [{
      match: (url) => url === '/api/permission-switches/me',
      data: { admin_box: false, values: { [catalogToggle('View customers').key]: true, [catalogToggle('Copy customer email').key]: true } },
    }],
    entry: `/invoices/${INVOICE_ID}`,
    ability: seesPrices,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  Object.defineProperty(window, 'matchMedia', { writable: true, configurable: true, value: originalMatchMedia });
});

describe('invoice detail header on a phone (mobile slice 55)', () => {
  it('keeps the customer name on screen: it is the one shrinking item of its row, with its full value in a title', async () => {
    setPhone(true);
    mount('DRAFT');

    const link = await screen.findByRole('link', { name: LONG_NAME });
    expect(link.getAttribute('title')).toBe(LONG_NAME);
    expect(link.className).toContain('min-w-0');
    expect(link.className).toContain('truncate');

    // No `shrink-0` action cluster shares the heading's row any more: the header's own row is the
    // heading column (and the Back control) only.
    const header = screen.getByTestId('detail-header');
    const headingRow = link.closest('[role="heading"]')!.parentElement!.parentElement!;
    expect(within(headingRow).queryByRole('button', { name: /Send Invoice/ })).not.toBeInTheDocument();
    expect(header.contains(screen.getByRole('button', { name: 'Back to invoices' }))).toBe(true);
  });

  it('stacks: Back, one full-width primary, the amount due, and every other action inside More actions', async () => {
    setPhone(true);
    const user = userEvent.setup();
    mount('DRAFT');

    const send = await screen.findByRole('button', { name: /Send Invoice/ });
    expect(send.parentElement!.className).toContain('flex-col');
    expect(send.parentElement!.className).toContain('[&>button]:h-11');
    expect(screen.getByTestId('invoice-amount-due')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back to invoices' }));
    expect(mockNavigate).toHaveBeenCalledWith('/invoices');

    // The phone menu is a labelled, full-width button, not the icon.
    const more = screen.getByRole('button', { name: 'More actions' });
    expect(more.textContent).toContain('More actions');
    expect(more.className).toContain('w-full');
    await user.click(more);
    expect(await screen.findByRole('menuitem', { name: /Preview PDF/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Download PDF/ })).toBeInTheDocument();
  });

  it('lets a long email wrap instead of pushing the page sideways', async () => {
    setPhone(true);
    mount('DRAFT');
    const email = await screen.findByRole('link', {
      name: 'an.extremely.long.billing.address.for.testing@example-company-name.test',
    });
    expect(email.className).toContain('break-all');
    expect(email.className).toContain('whitespace-normal');
  });
});

describe('invoice Payments row (mobile slice 55)', () => {
  it('wraps, so Record payment and View all payments stay inside a 320 px card', async () => {
    setPhone(true);
    mount('SENT');
    const view = await screen.findByRole('button', { name: 'View all payments' });
    const actions = view.parentElement!;
    expect(actions.className).toContain('flex-wrap');
    expect(actions.parentElement!.className).toContain('flex-wrap');
  });
});

describe('invoice detail header from sm up (unchanged)', () => {
  it('keeps the old cluster: no Back control, Send Invoice beside an icon-only More actions menu', async () => {
    setPhone(false);
    mount('DRAFT');
    expect(await screen.findByRole('button', { name: /Send Invoice/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Back to invoices' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More actions' }).textContent?.trim()).toBe('');
    expect(screen.getByTestId('invoice-amount-due')).toBeInTheDocument();
  });
});
