// V7-09c: an unapplied payment or refund as a view of the drawer host (spec 7.15), read by its key.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/__tests__/helpers';
import { toast } from '@/ui-kit/components/ui/sonner';

import { CardWithDrawer, findCard } from './attentionFixtures';
import { TabHarness, mockApi, urlSearch } from './paymentsFixtures';
import {
  CAPTURE_ID, PAYMENT_KEY, REFUND_KEY, invoiceRow, makeUnapplied, serveUnapplied,
} from './unappliedFixtures';

vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>()),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

const mockToast = vi.mocked(toast);
const user = () => userEvent.setup();
const open = (key = PAYMENT_KEY) => renderWithProviders(<TabHarness />, { initialEntries: [`/payments?d=item:${key}`] });
const footerOf = (dialog: HTMLElement) => dialog.querySelector('[data-slot="sheet-footer"]') as HTMLElement;
const dparam = () => new URLSearchParams(urlSearch()).get('d');

beforeEach(() => {
  mockApi.get.mockReset();
  mockApi.post.mockReset();
  mockToast.success.mockReset();
  mockToast.error.mockReset();
});

describe('an unapplied payment', () => {
  it('reads by key: title, amount, the Unapplied pill, and the amber alert as ONE element (bold short + long)', async () => {
    serveUnapplied();
    open();
    const dialog = await screen.findByRole('dialog', { name: 'Unapplied payment' });
    expect(mockApi.get).toHaveBeenCalledWith(`/api/payments-page/attention/${PAYMENT_KEY}`);
    expect(await within(dialog).findByText('$120.00', { selector: 'div' })).toBeInTheDocument();
    expect(within(dialog).getByText('Unapplied', { selector: 'span' })).toBeInTheDocument();
    const lead = within(dialog).getByText('Amount did not match.', { selector: 'b' });
    expect(lead.parentElement!.tagName).toBe('P');
    expect(lead.parentElement!.textContent).toBe('Amount did not match. The payment is $120.00 but INV-1301 is $150.00.');
  });

  it('shows the customer block when the server sends one, and no block when it does not', async () => {
    serveUnapplied();
    const first = open();
    const dialog = await screen.findByRole('dialog', { name: 'Unapplied payment' });
    expect(await within(dialog).findByRole('region', { name: 'Customer' })).toBeInTheDocument();
    first.unmount();
    serveUnapplied({ unapplied: makeUnapplied({ customer_block: null, meant_for: { invoice: null }, reason_short: 'Invoice not found' }) });
    open();
    const again = await screen.findByRole('dialog', { name: 'Unapplied payment' });
    await within(again).findByText('Invoice not found.');
    expect(within(again).queryByRole('region', { name: 'Customer' })).not.toBeInTheDocument();
  });

  it('"Meant for" is a new-tab link to the invoice with its status pill, and "Invoice total" sits beside it', async () => {
    serveUnapplied();
    open();
    const dialog = await screen.findByRole('dialog', { name: 'Unapplied payment' });
    const link = await within(dialog).findByRole('link', { name: /INV-1301/ });
    expect(link).toHaveAttribute('href', '/invoices/inv-meant');
    expect(link).toHaveAttribute('target', '_blank');
    const meant = within(dialog).getByText('Meant for').nextElementSibling as HTMLElement;
    expect(within(meant).getByText('Open')).toBeInTheDocument();
    expect(within(dialog).getByText('Invoice total').nextElementSibling).toHaveTextContent('$150.00');
  });

  it.each([['PAID', 'Paid'], ['VOIDED', 'Voided'], ['DRAFT', 'Open'], ['PARTIAL', 'Open']])('an invoice that is %s reads %s', async (status, word) => {
    serveUnapplied({ unapplied: makeUnapplied({ meant_for: { invoice: { id: 'inv-meant', number: 'INV-1301', status, total: 150 } } }) });
    open();
    const dialog = await screen.findByRole('dialog', { name: 'Unapplied payment' });
    const meant = (await within(dialog).findByText('Meant for')).nextElementSibling as HTMLElement;
    expect(within(meant).getByText(word)).toBeInTheDocument();
  });

  it('with no invoice: "Not tied to an invoice" and no "Invoice total"', async () => {
    serveUnapplied({ unapplied: makeUnapplied({ meant_for: { invoice: null }, customer_block: null }) });
    open();
    const dialog = await screen.findByRole('dialog', { name: 'Unapplied payment' });
    expect(await within(dialog).findByText('Not tied to an invoice')).toBeInTheDocument();
    expect(within(dialog).queryByText('Invoice total')).not.toBeInTheDocument();
  });

  it('"What the payer gave" lists Card, Description, Received and Reference, and leaves out any row the data lacks', async () => {
    serveUnapplied();
    const first = open();
    const dialog = await screen.findByRole('dialog', { name: 'Unapplied payment' });
    await within(dialog).findByRole('heading', { name: 'What the payer gave' });
    const terms = Array.from(dialog.querySelectorAll('dt')).map((t) => t.textContent);
    expect(terms).toEqual(['Meant for', 'Invoice total', 'Card', 'Description', 'Received', 'Reference']);
    expect(within(dialog).getByText('Card').nextElementSibling).toHaveTextContent('Visa •••• 4242');
    expect(within(dialog).getByText('Received').nextElementSibling).toHaveTextContent(/Oct 14, 2026, \d{1,2}:08 [AP]M/);
    expect(within(dialog).getByText('Reference').nextElementSibling).toHaveTextContent('RCV-48213AAA');
    first.unmount();
    serveUnapplied({ unapplied: makeUnapplied({ payer: { received_at: '2026-10-14T18:08:00.000Z', reference: 'RCV-48213AAA' } }) });
    open();
    const bare = await screen.findByRole('dialog', { name: 'Unapplied payment' });
    await within(bare).findByRole('heading', { name: 'What the payer gave' });
    expect(Array.from(bare.querySelectorAll('dt')).map((t) => t.textContent)).toEqual(['Meant for', 'Invoice total', 'Received', 'Reference']);
  });

  it('a suggested invoice\'s due date reads in the organization time zone, not UTC', async () => {
    // 02:00 UTC on Oct 21 is 7 pm on Oct 20 for the organization (America/Los_Angeles).
    serveUnapplied({ unapplied: makeUnapplied({ suggested_invoices: [invoiceRow(1, { id: 'inv-meant', number: 'INV-1301', meant: true, due_date: '2026-10-21T02:00:00.000Z' })] }) });
    open();
    const dialog = await screen.findByRole('dialog', { name: 'Unapplied payment' });
    const heading = await within(dialog).findByRole('heading', { name: 'Suggested invoices' });
    expect(within(heading.nextElementSibling as HTMLElement).getAllByRole('listitem')[0]).toHaveTextContent('Due Oct 20, 2026 · Door repair');
  });

  it('suggested invoices: the meant-for one first with its pill, due line, amount and a small Attach', async () => {
    serveUnapplied({
      unapplied: makeUnapplied({ suggested_invoices: [invoiceRow(1, { id: 'inv-meant', number: 'INV-1301', meant: true, amount: 150, balance: 150 }), invoiceRow(2)] }),
    });
    open();
    const dialog = await screen.findByRole('dialog', { name: 'Unapplied payment' });
    const heading = await within(dialog).findByRole('heading', { name: 'Suggested invoices' });
    const rows = within(heading.nextElementSibling as HTMLElement).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('INV-1301 · Dana Reyes');
    expect(within(rows[0]!).getByText('Meant for this payment')).toBeInTheDocument();
    expect(rows[0]).toHaveTextContent('Due Oct 20, 2026 · Door repair');
    expect(rows[0]).toHaveTextContent('$150.00');
    expect(within(rows[1]!).queryByText('Meant for this payment')).not.toBeInTheDocument();
    expect(within(rows[0]!).getByRole('button', { name: 'Attach' })).toBeEnabled();
  });

  it('the suggested list cannot be squeezed to its borders by a tall drawer body (shrink-0)', async () => {
    serveUnapplied();
    open();
    const dialog = await screen.findByRole('dialog', { name: 'Unapplied payment' });
    const heading = await within(dialog).findByRole('heading', { name: 'Suggested invoices' });
    expect((heading.nextElementSibling as HTMLElement).classList.contains('shrink-0')).toBe(true);
  });

  it('the meant-for link and its pill stay on one line', async () => {
    serveUnapplied();
    open();
    const dialog = await screen.findByRole('dialog', { name: 'Unapplied payment' });
    const link = await within(dialog).findByRole('link', { name: /INV-1301/ });
    expect((link.parentElement as HTMLElement).classList.contains('flex-wrap')).toBe(false);
    expect(link.classList.contains('whitespace-nowrap')).toBe(true);
  });

  it('a suggestion that owes less is a disabled Attach with its reason under it', async () => {
    serveUnapplied({
      unapplied: makeUnapplied({ suggested_invoices: [invoiceRow(1, { id: 'inv-meant', number: 'INV-1301', meant: true, can_attach: false, balance: 80, amount: 150 })] }),
    });
    open();
    const dialog = await screen.findByRole('dialog', { name: 'Unapplied payment' });
    const heading = await within(dialog).findByRole('heading', { name: 'Suggested invoices' });
    const row = within(heading.nextElementSibling as HTMLElement).getAllByRole('listitem')[0]!;
    expect(within(row).getByRole('button', { name: 'Attach' })).toBeDisabled();
    expect(row).toHaveTextContent('Only $80.00 is due, less than this $120.00 payment.');
  });

  it('no suggestions: the muted line points at Attach to invoice', async () => {
    serveUnapplied({ unapplied: makeUnapplied({ suggested_invoices: [] }) });
    open();
    const dialog = await screen.findByRole('dialog', { name: 'Unapplied payment' });
    expect(await within(dialog).findByText('No open invoice has this amount or was meant for it. Choose Attach to invoice to search them all.')).toBeInTheDocument();
  });

  it('the footer is one compact row: Attach to invoice (filled), Create invoice, Refund (red), Mark resolved, Close at the right', async () => {
    serveUnapplied();
    open();
    const dialog = await screen.findByRole('dialog', { name: 'Unapplied payment' });
    await within(dialog).findByRole('button', { name: 'Attach to invoice' });
    const footer = footerOf(dialog);
    const buttons = within(footer).getAllByRole('button');
    expect(buttons.map((b) => b.textContent?.replace(/\(opens in a new tab\)/, '').trim())).toEqual(['Attach to invoice', 'Create invoice', 'Refund', 'Mark resolved', 'Close']);
    expect(buttons[0]).toHaveClass('bg-primary');
    expect(buttons[2]).toHaveClass('bg-destructive-solid');
    expect(buttons.at(-1)).toHaveClass('ml-auto');
    expect(footer.className).toContain('sm:[&>button]:whitespace-nowrap');
    expect(footer.className).not.toContain('justify-end');
    expect(within(footer).getByRole('button', { name: 'Create invoice (opens in a new tab)' })).toBeInTheDocument();
  });

  it('a button the viewer cannot use is absent, not disabled', async () => {
    serveUnapplied({ unapplied: makeUnapplied({ actions: ['mark_resolved'] }) });
    open();
    const dialog = await screen.findByRole('dialog', { name: 'Unapplied payment' });
    await within(dialog).findByRole('button', { name: 'Mark resolved' });
    expect(within(footerOf(dialog)).getAllByRole('button').map((b) => b.textContent)).toEqual(['Mark resolved', 'Close']);
  });

  it('a resolved item shows "Resolved." with who and when, and no action buttons', async () => {
    serveUnapplied({
      unapplied: makeUnapplied({
        status: 'resolved', actions: [], suggested_invoices: [], resolved_at: '2026-10-15T15:00:00.000Z', resolved_by_name: 'Pat Admin',
        resolution: { text: 'Attached to INV-1301', note: null },
      }),
    });
    open();
    const dialog = await screen.findByRole('dialog', { name: 'Unapplied payment' });
    const lead = await within(dialog).findByText('Resolved.', { selector: 'b' });
    expect(lead.parentElement!.textContent).toMatch(/^Resolved\. Attached to INV-1301 · Pat Admin · Oct 15, 2026$/);
    expect(within(footerOf(dialog)).getAllByRole('button').map((b) => b.textContent)).toEqual(['Close']);
    expect(within(dialog).queryByRole('heading', { name: 'Suggested invoices' })).not.toBeInTheDocument();
  });
});

describe('an unapplied refund', () => {
  const refund = () => makeUnapplied({
    key: REFUND_KEY, kind: 'REFUND', reference: 'REF-1', reason_short: 'Refund has no invoice reference', reason_long: 'The refund was sent without an invoice reference.',
    suggested_invoices: [], actions: ['attach_to_invoice', 'mark_resolved'],
    payer: { received_at: '2026-10-14T18:08:00.000Z', reference: 'REF-1', method_label: 'Card', detail: 'Visa •••• 4242', description: 'Refund' },
  });

  it('is titled "Unapplied refund", says "Where the refund went" and "Sent", has no suggestions, and its footer has no Create invoice or Refund', async () => {
    serveUnapplied({ unapplied: refund() });
    open(REFUND_KEY);
    const dialog = await screen.findByRole('dialog', { name: 'Unapplied refund' });
    expect(await within(dialog).findByRole('heading', { name: 'Where the refund went' })).toBeInTheDocument();
    expect(within(dialog).getByText('Sent')).toBeInTheDocument();
    expect(within(dialog).queryByText('Received')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('heading', { name: 'Suggested invoices' })).not.toBeInTheDocument();
    expect(within(footerOf(dialog)).getAllByRole('button').map((b) => b.textContent)).toEqual(['Attach to invoice', 'Mark resolved', 'Close']);
  });
});

describe('a restricted or missing item', () => {
  it('an item the caller cannot read answers an error with Retry', async () => {
    serveUnapplied();
    const base = mockApi.get.getMockImplementation()! as (u: string, c?: unknown) => unknown;
    mockApi.get.mockImplementation(((url: string, c?: unknown) =>
      url === `/api/payments-page/attention/${PAYMENT_KEY}` ? Promise.reject({ response: { status: 404, data: { error: 'Item not found' } } }) : base(url, c)) as never);
    open();
    const dialog = await screen.findByRole('dialog', { name: 'Unapplied payment' });
    expect(await within(dialog).findByText('Couldn’t load this item.')).toBeInTheDocument();
  });

  it('a restricted item shows the reason and amount, a locked customer block and no buttons', async () => {
    serveUnapplied({
      unapplied: makeUnapplied({ restricted: true, customer_block: { customer: null, restricted: true }, meant_for: { invoice: null }, payer: null, suggested_invoices: [], actions: [], reference: null }),
    });
    open();
    const dialog = await screen.findByRole('dialog', { name: 'Unapplied payment' });
    expect(await within(dialog).findByRole('region', { name: 'Customer' })).toBeInTheDocument();
    expect(within(footerOf(dialog)).getAllByRole('button').map((b) => b.textContent)).toEqual(['Close']);
  });
});

describe('Create invoice', () => {
  it('opens /invoices/new in a new tab from the click, with the customer and the capture id, and shows no dialog', async () => {
    serveUnapplied();
    const win = vi.spyOn(window, 'open').mockReturnValue({ opener: {} } as unknown as Window);
    open();
    const dialog = await screen.findByRole('dialog', { name: 'Unapplied payment' });
    await user().click(await within(dialog).findByRole('button', { name: /Create invoice/ }));
    expect(win).toHaveBeenCalledTimes(1);
    expect(win.mock.calls[0]![0]).toBe(`/invoices/new?customer_id=cust-9&unapplied_payment_id=${CAPTURE_ID}`);
    expect(win.mock.calls[0]![1]).toBe('_blank');
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(mockToast.error).not.toHaveBeenCalled();
    win.mockRestore();
  });

  it('a blocked tab says so: "Your browser blocked the new tab. Allow pop-ups for this site."', async () => {
    serveUnapplied();
    const win = vi.spyOn(window, 'open').mockReturnValue(null);
    open();
    const dialog = await screen.findByRole('dialog', { name: 'Unapplied payment' });
    await user().click(await within(dialog).findByRole('button', { name: /Create invoice/ }));
    expect(mockToast.error).toHaveBeenCalledWith('Your browser blocked the new tab. Allow pop-ups for this site.');
    win.mockRestore();
  });
});

describe('the card row for unapplied money', () => {
  it('shows Attach to invoice (filled) and Create invoice, with Refund and Mark resolved behind More', async () => {
    serveUnapplied();
    const u = user();
    renderWithProviders(<><CardWithDrawer /></>, { initialEntries: ['/payments'] });
    const row = within(await findCard()).getByRole('listitem');
    const buttons = within(row).getAllByRole('button');
    expect(buttons.map((b) => b.textContent?.replace(/\s*\(opens in a new tab\)/, ''))).toEqual(['Attach to invoice', 'Create invoice', 'More']);
    expect(buttons[0]).toHaveClass('bg-primary');
    await u.click(buttons[2]!);
    expect(within(await screen.findByRole('menu')).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Refund', 'Mark resolved']);
  });

  it('Attach to invoice on the card opens the dialog without opening the drawer', async () => {
    serveUnapplied({ invoices: [invoiceRow(1)] });
    const u = user();
    renderWithProviders(<CardWithDrawer />, { initialEntries: ['/payments'] });
    await u.click(within(within(await findCard()).getByRole('listitem')).getByRole('button', { name: 'Attach to invoice' }));
    expect(await screen.findByRole('dialog', { name: 'Attach to invoice' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Unapplied payment' })).not.toBeInTheDocument();
  });
});

describe('opening and the stack', () => {
  it('Mark resolved posts the resolve route and closes the drawer', async () => {
    serveUnapplied();
    mockApi.post.mockResolvedValue({ data: { item: {} } });
    open();
    const u = user();
    const dialog = await screen.findByRole('dialog', { name: 'Unapplied payment' });
    await u.click(await within(dialog).findByRole('button', { name: 'Mark resolved' }));
    await u.click(await within(await screen.findByRole('dialog', { name: 'Mark as resolved' })).findByRole('button', { name: 'Mark resolved' }));
    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith(`/api/payments-needing-attention/${CAPTURE_ID}/resolve`, { reason: 'Handled outside ServWave' }, { silentErrors: true }));
    await waitFor(() => expect(dparam()).toBeNull());
  });

  it('no text names the payment processor', async () => {
    serveUnapplied();
    open();
    const dialog = await screen.findByRole('dialog', { name: 'Unapplied payment' });
    await within(dialog).findByRole('heading', { name: 'What the payer gave' });
    expect(dialog.textContent).not.toMatch(/stripe/i);
  });
});
