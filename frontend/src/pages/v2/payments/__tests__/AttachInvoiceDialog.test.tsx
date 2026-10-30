// V7-09c: the Attach to invoice dialog (spec 7.16): search, a radio list with greyed-out rows, the note, the 409.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/__tests__/helpers';
import { toast } from '@/ui-kit/components/ui/sonner';

import { TabHarness, mockApi, urlSearch } from './paymentsFixtures';
import {
  CAPTURE_ID, PAYMENT_KEY, REFUND_KEY, invoiceRow, makeUnapplied, serveUnapplied, type UnappliedServe,
} from './unappliedFixtures';

vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>()),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

const mockToast = vi.mocked(toast);
const dparam = () => new URLSearchParams(urlSearch()).get('d');

// INV-1301 owes the same as the payment and was meant for it; 1302 owes more; 1303 owes less (greyed out); 1304 is paid-in-full later.
const MEANT = invoiceRow(1, { id: 'inv-meant', number: 'INV-1301', meant: true, same_amount: true, balance: 120, amount: 120 });
const MORE = invoiceRow(2, { id: 'inv-more', number: 'INV-1302', customer: 'Lee Park', same_amount: false, balance: 200, amount: 200, job_type: 'Window repair' });
const LESS = invoiceRow(3, { id: 'inv-less', number: 'INV-1303', customer: 'Sam Cole', same_amount: false, balance: 80, amount: 150, can_attach: false });

async function openDialog(over: UnappliedServe = {}, key = PAYMENT_KEY) {
  serveUnapplied({ invoices: [MEANT, MORE, LESS], ...over });
  const u = userEvent.setup();
  renderWithProviders(<TabHarness />, { initialEntries: [`/payments?d=item:${key}`] });
  const drawer = await screen.findByRole('dialog', { name: key === PAYMENT_KEY ? 'Unapplied payment' : 'Unapplied refund' });
  await u.click(await within(drawer).findByRole('button', { name: 'Attach to invoice' }));
  const dialog = await screen.findByRole('dialog', { name: 'Attach to invoice' });
  await within(dialog).findByRole('radiogroup', { name: 'Invoices' });
  return { u, dialog };
}
const radios = (dialog: HTMLElement) => within(dialog).getAllByRole('radio');

beforeEach(() => {
  mockApi.get.mockReset();
  mockApi.post.mockReset();
  mockToast.success.mockReset();
});

describe('the Attach to invoice dialog', () => {
  it('says what it records, offers a search and the list, and has Cancel and Attach payment', async () => {
    const { dialog } = await openDialog();
    expect(within(dialog).getByText('Record the $120.00 payment from Dana Reyes on an invoice.')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Find an invoice')).toHaveAttribute('placeholder', 'Number or customer');
    expect(await within(dialog).findByText('INV-1301 · Dana Reyes')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Attach payment' })).toBeInTheDocument();
  });

  it('without a customer name the sentence leaves "from ..." out', async () => {
    const { dialog } = await openDialog({ unapplied: makeUnapplied({ customer_block: null, meant_for: { invoice: null } }) });
    expect(within(dialog).getByText('Record the $120.00 payment on an invoice.')).toBeInTheDocument();
  });

  it('rows read "Due Oct 20 · job" with the amount at the right, and tag the meant-for invoice', async () => {
    const { dialog } = await openDialog();
    const meant = (await within(dialog).findByRole('radio', { name: /INV-1301/ }));
    expect(meant).toHaveTextContent('Due Oct 20 · Door repair · Meant for this payment');
    expect(meant).toHaveTextContent('$120.00');
    expect(within(dialog).getByRole('radio', { name: /INV-1302/ })).toHaveTextContent('Due Oct 20 · Window repair');
  });

  it('a due date reads in the organization time zone, not UTC (a due time after 5 pm Pacific is still that day)', async () => {
    // 02:00 UTC on Oct 21 is 7 pm on Oct 20 for the organization (America/Los_Angeles).
    const late = invoiceRow(5, { id: 'inv-late', number: 'INV-1305', due_date: '2026-10-21T02:00:00.000Z', job_type: 'Gate repair' });
    const { dialog } = await openDialog({ invoices: [MEANT, late] });
    expect(await within(dialog).findByRole('radio', { name: /INV-1305/ })).toHaveTextContent('Due Oct 20 · Gate repair');
  });

  // The note under the list says what the invoice will show afterwards, from its real amount due, not from the room left
  // after a bank debit that is still clearing.
  it('the "still due" note counts from the amount due, even when a clearing bank debit takes room (220 due, 100 clearing, 120 payment)', async () => {
    const clearing = invoiceRow(6, { id: 'inv-clearing', number: 'INV-1306', meant: true, balance: 220, payable_now: 120, amount: 220, same_amount: false });
    const { dialog } = await openDialog({ invoices: [clearing] });
    await waitFor(() => expect(within(dialog).getByRole('radio', { name: /INV-1306/ })).toHaveAttribute('aria-checked', 'true'));
    expect(within(dialog).getByText('INV-1306 will show $100.00 still due.')).toBeInTheDocument();
    expect(within(dialog).queryByText(/will show as paid/)).not.toBeInTheDocument();
  });

  it('a row that cannot take the payment says how much it can take now (the room after a clearing debit), not its amount due', async () => {
    const tight = invoiceRow(7, { id: 'inv-tight', number: 'INV-1307', balance: 150, payable_now: 50, amount: 150, can_attach: false, same_amount: false });
    const { dialog } = await openDialog({ invoices: [MEANT, tight] });
    expect(await within(dialog).findByText('Only $50.00 is due, less than this $120.00 payment.')).toBeInTheDocument();
  });

  it('the meant-for invoice is chosen when it can take the payment, with the "will show as paid" note', async () => {
    const { dialog } = await openDialog();
    const meant = await within(dialog).findByRole('radio', { name: /INV-1301/ });
    await waitFor(() => expect(meant).toHaveAttribute('aria-checked', 'true'));
    expect(within(dialog).getByText('INV-1301 will show as paid.')).toBeInTheDocument();
  });

  it('nothing is chosen when the meant-for invoice owes less', async () => {
    const { dialog } = await openDialog({ invoices: [{ ...MEANT, can_attach: false, balance: 80, payable_now: 80 }, MORE] });
    await within(dialog).findByRole('radio', { name: /INV-1301/ });
    expect(radios(dialog).filter((r) => r.getAttribute('aria-checked') === 'true')).toHaveLength(0);
  });

  it('choosing an invoice that owes more says it will show the rest still due, and never says "more than"', async () => {
    const { u, dialog } = await openDialog();
    await u.click(await within(dialog).findByRole('radio', { name: /INV-1302/ }));
    expect(within(dialog).getByText('INV-1302 will show $80.00 still due.')).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(/more than/);
  });

  it('a refund says "The refund will show on ..." and the buttons say Attach refund', async () => {
    const detail = makeUnapplied({ key: REFUND_KEY, kind: 'REFUND', suggested_invoices: [], actions: ['attach_to_invoice', 'mark_resolved'] });
    const { u, dialog } = await openDialog({ unapplied: detail, invoices: [MEANT, MORE] }, REFUND_KEY);
    expect(within(dialog).getByText('Record the $120.00 refund to Dana Reyes on an invoice.')).toBeInTheDocument();
    await u.click(await within(dialog).findByRole('radio', { name: /INV-1302/ }));
    expect(within(dialog).getByText('The refund will show on INV-1302.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Attach refund' })).toBeInTheDocument();
  });

  it('greyed-out rows: a disabled radio, aria-disabled, its own reason, and one note under the list', async () => {
    const { u, dialog } = await openDialog();
    const less = await within(dialog).findByRole('radio', { name: /INV-1303/ });
    expect(less).toBeDisabled();
    expect(less).toHaveAttribute('aria-disabled', 'true');
    expect(less.closest('li')!.classList.contains('opacity-60')).toBe(false);
    expect(less.classList.contains('opacity-60')).toBe(true);
    expect(less.closest('li')).toHaveTextContent('Only $80.00 is due, less than this $120.00 payment.');
    expect(within(dialog).getByText('Greyed-out invoices owe less than this payment. Refund the extra first, then attach what is left.')).toBeInTheDocument();
    await u.click(less);
    expect(less).toHaveAttribute('aria-checked', 'false');
  });

  it('the greyed-out note is absent when every row can take the payment', async () => {
    const { dialog } = await openDialog({ invoices: [MEANT, MORE] });
    await within(dialog).findByRole('radio', { name: /INV-1301/ });
    expect(within(dialog).queryByText(/Greyed-out invoices/)).not.toBeInTheDocument();
  });

  it('arrow keys move between the rows that can be chosen and skip the greyed-out one', async () => {
    const { u, dialog } = await openDialog({ invoices: [MEANT, LESS, MORE] });
    const meant = await within(dialog).findByRole('radio', { name: /INV-1301/ });
    await waitFor(() => expect(meant).toHaveAttribute('aria-checked', 'true'));
    meant.focus();
    await u.keyboard('{ArrowDown}');
    expect(within(dialog).getByRole('radio', { name: /INV-1302/ })).toHaveAttribute('aria-checked', 'true');
    expect(within(dialog).getByRole('radio', { name: /INV-1303/ })).toHaveAttribute('aria-checked', 'false');
  });

  it('the search asks the server, by number or customer, after a short pause; an empty answer reads "No invoice matches"', async () => {
    const { u, dialog } = await openDialog();
    await u.type(within(dialog).getByLabelText('Find an invoice'), 'Lee');
    await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith(`/api/payments-needing-attention/${CAPTURE_ID}/invoices`, { params: { q: 'Lee' } }));
    await waitFor(() => expect(within(dialog).queryByRole('radio', { name: /INV-1301/ })).not.toBeInTheDocument());
    expect(within(dialog).getByRole('radio', { name: /INV-1302/ })).toBeInTheDocument();
    await u.clear(within(dialog).getByLabelText('Find an invoice'));
    await u.type(within(dialog).getByLabelText('Find an invoice'), 'zzz');
    expect(await within(dialog).findByText('No invoice matches')).toBeInTheDocument();
  });

  it('Attach payment with nothing chosen says "Choose an invoice." and posts nothing', async () => {
    const { u, dialog } = await openDialog({ invoices: [{ ...MEANT, can_attach: false, balance: 80, payable_now: 80 }, MORE] });
    await within(dialog).findByRole('radio', { name: /INV-1302/ });
    await u.click(within(dialog).getByRole('button', { name: 'Attach payment' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Choose an invoice.');
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it('attaching posts the invoice, toasts the whole amount, and closes both drawers', async () => {
    mockApi.post.mockResolvedValue({ data: { item: { status: 'RESOLVED' }, invoice: { id: 'inv-meant', number: 'INV-1301' } } });
    const { u, dialog } = await openDialog();
    await waitFor(() => expect(within(dialog).getByRole('radio', { name: /INV-1301/ })).toHaveAttribute('aria-checked', 'true'));
    await u.click(within(dialog).getByRole('button', { name: 'Attach payment' }));
    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith(`/api/payments-needing-attention/${CAPTURE_ID}/attach`, { invoice_id: 'inv-meant' }, { silentErrors: true }));
    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith('Payment of $120.00 attached to INV-1301'));
    await waitFor(() => expect(dparam()).toBeNull());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('a refund toast says "Refund of ... attached to ..."', async () => {
    mockApi.post.mockResolvedValue({ data: { item: {}, invoice: { id: 'inv-more', number: 'INV-1302' } } });
    const detail = makeUnapplied({ key: REFUND_KEY, kind: 'REFUND', suggested_invoices: [], actions: ['attach_to_invoice'] });
    const { u, dialog } = await openDialog({ unapplied: detail, invoices: [MORE] }, REFUND_KEY);
    await u.click(await within(dialog).findByRole('radio', { name: /INV-1302/ }));
    await u.click(within(dialog).getByRole('button', { name: 'Attach refund' }));
    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith('Refund of $120.00 attached to INV-1302'));
  });

  it('a 409 for a balance that dropped shows the balance sentence under the list, asks the list again, and shows no success', async () => {
    mockApi.post.mockRejectedValue({
      isAxiosError: true,
      response: { status: 409, data: { code: 'INVOICE_BALANCE_BELOW_PAYMENT', error: 'x', balance: 50, amount: 120 } },
    });
    const { u, dialog } = await openDialog();
    await waitFor(() => expect(within(dialog).getByRole('radio', { name: /INV-1301/ })).toHaveAttribute('aria-checked', 'true'));
    const before = mockApi.get.mock.calls.filter(([url]) => String(url).endsWith('/invoices')).length;
    await u.click(within(dialog).getByRole('button', { name: 'Attach payment' }));
    expect(await within(dialog).findByText('Only $50.00 is due on INV-1301, less than this $120.00 payment.')).toBeInTheDocument();
    await waitFor(() => expect(mockApi.get.mock.calls.filter(([url]) => String(url).endsWith('/invoices')).length).toBeGreaterThan(before));
    expect(mockToast.success).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Attach to invoice' })).toBeInTheDocument();
  });

  it('any other refusal shows the server\'s sentence as it is, and no success', async () => {
    mockApi.post.mockRejectedValue({ isAxiosError: true, response: { status: 409, data: { code: 'NOT_OPEN', error: 'This payment was already attached, refunded or resolved.' } } });
    const { u, dialog } = await openDialog();
    await waitFor(() => expect(within(dialog).getByRole('radio', { name: /INV-1301/ })).toHaveAttribute('aria-checked', 'true'));
    await u.click(within(dialog).getByRole('button', { name: 'Attach payment' }));
    expect(await within(dialog).findByText('This payment was already attached, refunded or resolved.')).toBeInTheDocument();
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  it('a suggested invoice\'s Attach opens the dialog with that invoice chosen', async () => {
    serveUnapplied({ unapplied: makeUnapplied({ suggested_invoices: [invoiceRow(2, { id: 'inv-more', number: 'INV-1302' })] }), invoices: [MEANT, invoiceRow(2, { id: 'inv-more', number: 'INV-1302' })] });
    const u = userEvent.setup();
    renderWithProviders(<TabHarness />, { initialEntries: [`/payments?d=item:${PAYMENT_KEY}`] });
    const drawer = await screen.findByRole('dialog', { name: 'Unapplied payment' });
    const heading = await within(drawer).findByRole('heading', { name: 'Suggested invoices' });
    await u.click(within(heading.nextElementSibling as HTMLElement).getByRole('button', { name: 'Attach' }));
    const dialog = await screen.findByRole('dialog', { name: 'Attach to invoice' });
    expect(await within(dialog).findByRole('radio', { name: /INV-1302/ })).toHaveAttribute('aria-checked', 'true');
  });

  it('reopening starts clean: the search, the choice and any error are gone', async () => {
    const { u, dialog } = await openDialog({ invoices: [{ ...MEANT, can_attach: false, balance: 80, payable_now: 80 }, MORE] });
    await u.type(within(dialog).getByLabelText('Find an invoice'), 'Lee');
    await u.click(within(dialog).getByRole('button', { name: 'Attach payment' }));
    expect(within(dialog).getByRole('alert')).toBeInTheDocument();
    await u.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Attach to invoice' })).not.toBeInTheDocument());
    await u.click(await within(screen.getByRole('dialog', { name: 'Unapplied payment' })).findByRole('button', { name: 'Attach to invoice' }));
    const again = await screen.findByRole('dialog', { name: 'Attach to invoice' });
    expect(within(again).getByLabelText('Find an invoice')).toHaveValue('');
    expect(within(again).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('no text names the payment processor', async () => {
    const { dialog } = await openDialog();
    await within(dialog).findByRole('radio', { name: /INV-1301/ });
    expect(dialog.textContent).not.toMatch(/stripe/i);
  });
});
