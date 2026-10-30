// V7-07b: the failed bank payment, failed refund and failed payout as views of the drawer host. An item is read by its
// key (so a reload on a `d` address works, also for a person who only views payments).
import { beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/__tests__/helpers';
import type { AttentionItem, PaymentCustomerBlock } from '@/lib/api/paymentsPage';

import { makeItem, resolvedItem, serveAttention } from './attentionFixtures';
import { TabHarness, makeDetail, manyRows, mockApi, urlSearch } from './paymentsFixtures';
import { makePayout, servePayouts } from './payoutsFixtures';

const ROW1 = manyRows(3)[0]!;
const BLOCK: PaymentCustomerBlock = {
  restricted: false, id: 'c1', customer_number: 'C-1001', name: 'Dana Reyes', company: null, address: null,
  phone: '5551234567', email: 'dana@example.com', job: null, lead: null, invoice: { id: 'inv-1', number: 'INV-1001' },
};
const PAYOUT = makePayout(4, { status: 'FAILED' });
const dparam = () => new URLSearchParams(urlSearch()).get('d');
const user = () => userEvent.setup();

/** The attention routes (list and by-key) and the payment routes, plus the payouts routes for the failed payout. */
function serveItems(open: AttentionItem[], resolved: AttentionItem[] = []) {
  serveAttention({ open, resolved, rows: manyRows(3), detail: () => makeDetail(ROW1, { customer_block: BLOCK, can_refund: false }) });
  const att = mockApi.get.getMockImplementation()! as (u: string, c?: unknown) => unknown;
  servePayouts({ payouts: [PAYOUT] });
  const po = mockApi.get.getMockImplementation()! as (u: string, c?: unknown) => unknown;
  mockApi.get.mockImplementation(((url: string, config?: unknown) =>
    (typeof url === 'string' && (url.startsWith('/api/payments-page/attention') || /^\/api\/payments-page\/payments(\/|$)/.test(url)) ? att : po)(url, config)) as never);
}
const open = (entry: string) => renderWithProviders(<TabHarness />, { initialEntries: [entry] });
const footerOf = (dialog: HTMLElement) => dialog.querySelector('[data-slot="sheet-footer"]') as HTMLElement;

beforeEach(() => mockApi.get.mockReset());

describe('failed bank payment', () => {
  const item = () => makeItem(1, 'failed_payment', { payment_id: ROW1.id, detail: 'The bank returned the payment', compose: { subject: 'Bank payment failed - Invoice INV-1001', body: 'Hi' } });

  it('reads by key on a reload: the red alert as one element, the pill, the customer block and the key/value list', async () => {
    const it1 = item();
    serveItems([it1]);
    open(`/payments?d=payment:${ROW1.id},item:${it1.key}`);
    const dialog = await screen.findByRole('dialog', { name: 'Bank payment failed' });
    expect(mockApi.get).toHaveBeenCalledWith(`/api/payments-page/attention/${it1.key}`);
    const lead = await within(dialog).findByText('Bank payment failed.', { selector: 'b' });
    expect(lead.parentElement!.textContent).toBe('Bank payment failed. The bank returned the payment');
    expect(lead.parentElement!.tagName).toBe('P');
    expect(within(dialog).getByText('Failed', { selector: 'span,div' })).toBeInTheDocument();
    expect(await within(dialog).findByRole('region', { name: 'Customer' })).toBeInTheDocument();
    const terms = Array.from(dialog.querySelectorAll('dt')).map((t) => t.textContent);
    expect(terms).toEqual(['Failed on', 'Method', 'Payment']);
    expect(within(dialog).getByText('Credit card · Visa ending 4242')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: `View ${ROW1.reference}` })).toBeInTheDocument();
  });

  it('"View PMT-..." pushes the Payment: it is already underneath, so the stack cuts back to it', async () => {
    const it1 = item();
    serveItems([it1]);
    open(`/payments?d=payment:${ROW1.id},item:${it1.key}`);
    const dialog = await screen.findByRole('dialog', { name: 'Bank payment failed' });
    expect(within(dialog).getByRole('button', { name: 'Back to Payment' })).toBeInTheDocument();
    await user().click(await within(dialog).findByRole('button', { name: `View ${ROW1.reference}` }));
    await waitFor(() => expect(dparam()).toBe(`payment:${ROW1.id}`));
    expect(await screen.findByRole('dialog', { name: `Payment ${ROW1.reference}` })).toBeInTheDocument();
  });

  it('the footer has Contact customer (filled), Mark resolved and Close at the right; no Retry, no Mark settled', async () => {
    serveItems([item()]);
    const it1 = item();
    open(`/payments?d=payment:${ROW1.id},item:${it1.key}`);
    const dialog = await screen.findByRole('dialog', { name: 'Bank payment failed' });
    await within(dialog).findByRole('button', { name: 'Contact customer' });
    const buttons = within(footerOf(dialog)).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Contact customer', 'Mark resolved', 'Close']);
    expect(buttons.filter((b) => b.className.includes('bg-primary')).map((b) => b.textContent)).toEqual(['Contact customer']);
    expect(buttons.at(-1)).toHaveClass('ml-auto');
    expect(within(dialog).queryByRole('button', { name: /Retry|Mark settled/ })).not.toBeInTheDocument();
  });

  it('a bank return after it cleared says so, and "Failed on" is the item\'s date', async () => {
    const it1 = { ...item(), detail: 'The bank returned this payment after it had cleared.' };
    serveItems([it1]);
    open(`/payments?d=payment:${ROW1.id},item:${it1.key}`);
    const dialog = await screen.findByRole('dialog', { name: 'Bank payment failed' });
    expect(await within(dialog).findByText(/after it had cleared/)).toBeInTheDocument();
    expect(within(dialog).getByText('Failed on').nextElementSibling).toHaveTextContent('Oct 12, 2026');
  });

  it('a resolved item shows the info alert with who and when, and no action buttons', async () => {
    const done = resolvedItem(1, { payment_id: ROW1.id, resolved_by_name: 'Sam Ortiz', resolved_at: '2026-10-14T18:00:00.000Z' });
    serveItems([], [done]);
    open(`/payments?d=payment:${ROW1.id},item:${done.key}`);
    const dialog = await screen.findByRole('dialog', { name: 'Bank payment failed' });
    const alert = await within(dialog).findByText('Resolved.', { selector: 'b' });
    expect(alert.parentElement!.textContent).toBe('Resolved. Handled outside ServWave · Sam Ortiz · Oct 14, 2026');
    expect(within(footerOf(dialog)).getAllByRole('button').map((b) => b.textContent)).toEqual(['Close']);
  });

  it('a person who only views payments opens it (the server sent no actions): Close only', async () => {
    const it1 = { ...item(), actions: [] };
    serveItems([it1]);
    open(`/payments?d=payment:${ROW1.id},item:${it1.key}`);
    const dialog = await screen.findByRole('dialog', { name: 'Bank payment failed' });
    await within(dialog).findByText('Bank payment failed.', { selector: 'b' });
    expect(within(footerOf(dialog)).getAllByRole('button').map((b) => b.textContent)).toEqual(['Close']);
  });
});

describe('failed refund', () => {
  const item = () => makeItem(2, 'failed_refund', { payment_id: ROW1.id, payment_reference: ROW1.reference, amount: 41, detail: 'the card is closed' });

  it('reads the red alert, the amount on the right, the dates and the original payment', async () => {
    const it1 = item();
    serveItems([it1]);
    open(`/payments?d=payment:${ROW1.id},item:${it1.key}`);
    const dialog = await screen.findByRole('dialog', { name: 'Refund failed' });
    const lead = await within(dialog).findByText('Refund failed.', { selector: 'b' });
    expect(lead.parentElement!.textContent).toBe('Refund failed. $41.00 could not be returned: the card is closed.');
    const terms = Array.from(dialog.querySelectorAll('dt')).map((t) => t.textContent);
    expect(terms).toEqual(['Refund amount', 'Failed on', 'Original payment']);
    expect(within(dialog).getByText('Refund amount').nextElementSibling).toHaveTextContent('$41.00');
    expect(await within(dialog).findByRole('button', { name: `View ${ROW1.reference} · $101.00` })).toBeInTheDocument();
  });

  it('the footer offers Refund again and Mark resolved, never a plain Refund (one filled button)', async () => {
    const it1 = item();
    serveItems([it1]);
    open(`/payments?d=payment:${ROW1.id},item:${it1.key}`);
    const dialog = await screen.findByRole('dialog', { name: 'Refund failed' });
    await within(dialog).findByRole('button', { name: 'Refund again' });
    expect(within(dialog).queryByRole('button', { name: 'Refund' })).not.toBeInTheDocument();
    const buttons = within(footerOf(dialog)).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Refund again', 'Mark resolved', 'Close']);
    expect(buttons.filter((b) => b.className.includes('bg-primary'))).toHaveLength(1);
  });
});

describe('failed payout', () => {
  const item = () => makeItem(4, 'failed_payout', { payout_id: PAYOUT.id, payout_reference: PAYOUT.reference, detail: 'The bank account could not be credited', actions: ['update_bank_account'] });

  it('reads the alert, has no customer block, and lists payout, date, destination and the payment count', async () => {
    const it1 = item();
    serveItems([it1]);
    open(`/payments?d=payout:${PAYOUT.id},item:${it1.key}`);
    const dialog = await screen.findByRole('dialog', { name: 'Payout failed' });
    const lead = await within(dialog).findByText('Payout failed.', { selector: 'b' });
    expect(lead.parentElement!.textContent).toBe('Payout failed. The bank account could not be credited.');
    expect(within(dialog).queryByRole('region', { name: 'Customer' })).not.toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByText('Payments in it').nextElementSibling).toHaveTextContent('3'));
    const terms = Array.from(dialog.querySelectorAll('dt')).map((t) => t.textContent);
    expect(terms).toEqual(['Payout', 'Date', 'Destination', 'Payments in it']);
    expect(within(dialog).getByText('Destination').nextElementSibling).toHaveTextContent('Chase ending 4242');
    expect(within(footerOf(dialog)).getAllByRole('button').map((b) => b.textContent)).toEqual(['Update bank account', 'Close']);
  });

  it('"View PO-..." goes back to the Payout underneath', async () => {
    const it1 = item();
    serveItems([it1]);
    open(`/payments?d=payout:${PAYOUT.id},item:${it1.key}`);
    const dialog = await screen.findByRole('dialog', { name: 'Payout failed' });
    expect(within(dialog).getByRole('button', { name: 'Back to Payout' })).toBeInTheDocument();
    await user().click(await within(dialog).findByRole('button', { name: `View ${PAYOUT.reference}` }));
    await waitFor(() => expect(dparam()).toBe(`payout:${PAYOUT.id}`));
  });
});

describe('an item that cannot be read', () => {
  it('says so with Retry and Close, titled from its kind', async () => {
    serveItems([]);
    open('/payments?d=item:failed_payment:00000000-0000-4000-9000-0000000000ff');
    const dialog = await screen.findByRole('dialog', { name: 'Bank payment failed' });
    expect(await within(dialog).findByText('Couldn’t load this item.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });
});
