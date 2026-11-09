import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';

import { renderWithProviders } from '@/__tests__/helpers';

import { attentionCalls, makeItem, resolvedItem, serveAttention, findCard, CardWithDrawer } from './attentionFixtures';
import { mockApi } from './paymentsFixtures';
import { makeUnapplied, serveUnapplied } from './unappliedFixtures';

function Where() {
  const { search } = useLocation();
  return <div data-testid="search">{search}</div>;
}
const open = (entry = '/payments') => renderWithProviders(<><CardWithDrawer /><Where /></>, { initialEntries: [entry] });
const search = () => screen.getByTestId('search').textContent ?? '';
const user = () => userEvent.setup();
const card = () => findCard();

let switches: Record<string, boolean> = {};
vi.mock('@/lib/api/shared/mySwitches', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/shared/mySwitches')>()),
  useMySwitches: () => ({ admin_box: false, values: switches }),
}));

// Only the clock is faked: timers, promises and the query cache keep running for real.
const NOW = '2026-10-14T19:00:00.000Z';
beforeEach(() => {
  mockApi.get.mockReset();
  switches = {};
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(NOW) });
});
afterEach(() => vi.useRealTimers());

describe('always on the page', () => {
  it('stays with one "Nothing needs attention" row while nothing is open', async () => {
    serveAttention({ open: [], resolved: [resolvedItem(1)] });
    open();
    const region = await card();
    expect(within(region).getByText('Nothing needs attention')).toBeInTheDocument();
    expect(within(region).getByRole('button', { name: 'Resolved items (1)' })).toBeInTheDocument();
    expect(within(region).queryByText('0')).not.toBeInTheDocument();
  });

  it('shows its frame with three skeleton rows while loading', async () => {
    mockApi.get.mockImplementation((() => new Promise(() => {})) as never);
    open();
    const region = await screen.findByRole('region', { name: /Needs attention/ });
    expect(within(region).getByRole('status', { name: /Loading what needs attention/ })).toBeInTheDocument();
    expect(region.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThanOrEqual(3);
    expect(within(region).queryByRole('button', { name: /Resolved items/ })).not.toBeInTheDocument();
  });

  it('keeps its frame when the load fails, with the red alert and a Retry that asks again', async () => {
    const u = user();
    serveAttention({ open: [makeItem(1, 'failed_payment')], failFirst: 1 });
    open();
    const region = await screen.findByRole('region', { name: /Needs attention/ });
    expect(await within(region).findByRole('alert')).toHaveTextContent('Couldn’t load what needs attention.');
    expect(within(region).getByRole('heading', { name: /Needs attention/ })).toBeInTheDocument();
    await u.click(within(region).getByRole('button', { name: 'Retry' }));
    expect(await within(region).findByRole('listitem')).toBeInTheDocument();
  });

  it('is not hidden, shrunk or re-sorted by the Needs attention chip', async () => {
    serveAttention({ open: [makeItem(1, 'failed_payment'), makeItem(2, 'dispute')] });
    open('/payments?tab=payments&chip=attention&attView=resolved');
    const region = await card();
    expect(within(region).getAllByRole('listitem')).toHaveLength(2);
  });
});

describe('the list', () => {
  const twelve = () => Array.from({ length: 12 }, (_, i) => makeItem(i + 1, 'failed_payment', { actions: ['contact_customer', 'mark_resolved'] }));

  it('fetches up to 50 open items, shows six of twelve, and offers "View all 12"', async () => {
    serveAttention({ open: twelve(), resolved: [resolvedItem(50), resolvedItem(51)] });
    open();
    const region = await card();
    expect(attentionCalls()[0]).toMatchObject({ view: 'open', limit: 50 });
    expect(within(region).getAllByRole('listitem')).toHaveLength(6);
    expect(within(region).getByText('12')).toBeInTheDocument();
    expect(within(region).getByRole('button', { name: 'View all 12' })).toBeInTheDocument();
    expect(within(region).getByRole('button', { name: 'Resolved items (2)' })).toBeInTheDocument();
  });

  it('shows six of nine open across all six kinds: the most urgent of each kind, then "View all 9"', async () => {
    serveAttention({
      open: [
        makeItem(1, 'unmatched_refund'), makeItem(2, 'unmatched_payment'), makeItem(3, 'failed_payout'),
        makeItem(4, 'failed_refund'), makeItem(5, 'failed_payment'), makeItem(6, 'dispute'),
        makeItem(7, 'failed_payment'), makeItem(8, 'failed_payment'), makeItem(9, 'dispute'),
      ],
    });
    open();
    const region = await card();
    const titles = within(region).getAllByRole('listitem').map((row) => within(row).getByText(/./, { selector: 'a, span.cursor-default, div.font-semibold *' }).textContent);
    expect(titles).toEqual([
      'Dispute needs a response', 'Bank payment failed', 'Refund failed', 'Payout failed',
      'Money received that is not on an invoice', 'Refund sent that is not on an invoice',
    ]);
    expect(within(region).getByRole('button', { name: 'View all 9' })).toBeInTheDocument();
  });

  it('has no "View all" when six or fewer are open', async () => {
    serveAttention({ open: Array.from({ length: 6 }, (_, i) => makeItem(i + 1, 'failed_payment', { actions: [] })) });
    open();
    const region = await card();
    expect(within(region).getAllByRole('listitem')).toHaveLength(6);
    expect(within(region).queryByRole('button', { name: /View all/ })).not.toBeInTheDocument();
  });

  it('"View all" and "Resolved items" switch the table to the chip without leaving the page', async () => {
    const u = user();
    serveAttention({ open: twelve(), resolved: [resolvedItem(50)] });
    open('/payments?tab=payouts');
    const region = await card();
    await u.click(within(region).getByRole('button', { name: 'View all 12' }));
    expect(search()).toContain('tab=payments');
    expect(search()).toContain('chip=attention');
    expect(search()).toContain('attView=open');
    expect(search()).not.toContain('d=');
    await u.click(within(region).getByRole('button', { name: 'Resolved items (1)' }));
    expect(search()).toContain('attView=resolved');
  });
});

describe('the rows', () => {
  const lineOf = (region: HTMLElement, title: string) =>
    (within(region).getByText(title).closest('li') as HTMLElement).querySelector('div.text-text-secondary')!.textContent;

  it('words each kind\'s secondary line, with the customer ID in plain text for a viewer who cannot open customers', async () => {
    serveAttention({
      open: [
        makeItem(1, 'failed_payment'),
        makeItem(2, 'failed_refund'),
        makeItem(3, 'dispute'),
        makeItem(4, 'failed_payout'),
        makeItem(5, 'unmatched_payment', { customer: { id: 'c5', name: 'Pat Payer', customer_number: 'C-1005' }, invoice: { id: 'i5', number: 'INV-1005' } }),
      ],
    });
    open();
    const region = await card();
    expect(lineOf(region, 'Bank payment failed')).toBe('Customer 1 · C-1001 · INV-1001 · $101.00 · The bank returned the payment');
    expect(lineOf(region, 'Refund failed')).toBe('Customer 2 · C-1002 · INV-1002 · $102.00 · The refund did not reach the customer');
    expect(lineOf(region, 'Dispute needs a response')).toBe('Customer 3 · C-1003 · INV-1003 · $103.00 · Respond by Oct 20, 2026 (6 days left)');
    expect(lineOf(region, 'Payout failed')).toBe('Payout PO-ABC4 · $104.00 · The bank account could not be credited');
    expect(lineOf(region, 'Money received that is not on an invoice')).toBe('Pat Payer · C-1005 · $105.00 · Meant for INV-1005 · Not tied to an invoice');
    expect(within(region).queryByRole('link', { name: /C-1001/ })).not.toBeInTheDocument();
  });

  it('leaves out any part the data lacks, never a placeholder', async () => {
    serveAttention({ open: [makeItem(1, 'failed_payment', { customer: { id: 'c1', name: 'Customer 1', customer_number: '' }, invoice: null, detail: '' })] });
    open();
    const region = await card();
    expect(lineOf(region, 'Bank payment failed')).toBe('Customer 1 · $101.00');
  });

  it('shows the customer ID as a new-tab link to the customer for a viewer with View customers', async () => {
    switches = { view_customers: true };
    serveAttention({ open: [makeItem(1, 'failed_payment')] });
    open();
    const link = within(await card()).getByRole('link', { name: /C-1001/ });
    expect(link).toHaveAttribute('href', '/customers/c1');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('does not open the payment drawer when the customer ID is clicked', async () => {
    switches = { view_customers: true };
    const u = user();
    serveAttention({ open: [makeItem(1, 'failed_payment')] });
    open('/payments');
    await u.click(within(await card()).getByRole('link', { name: /C-1001/ }));
    expect(search()).not.toContain('payment=');
  });

  it('counts the time left from the deadline: hours in red and bold under 48 hours, days otherwise, "Past due" after', async () => {
    serveAttention({
      open: [
        makeItem(1, 'dispute', { respond_by: '2026-10-15T07:00:00.000Z' }),
        makeItem(2, 'dispute', { respond_by: '2026-10-14T18:00:00.000Z' }),
        makeItem(3, 'dispute', { respond_by: '2026-10-15T19:00:00.000Z' }),
      ],
    });
    open();
    const region = await card();
    const [past, soon, day] = within(region).getAllByRole('listitem');
    const left = (row: HTMLElement | undefined, text: string) => within(row!).getByText(text);
    expect(left(soon, '12 hours left').className).toMatch(/text-destructive/);
    expect(left(soon, '12 hours left').className).toMatch(/font-bold/);
    expect(within(past!).getByText('Past due').className).not.toMatch(/font-bold/);
    expect(within(day!).getByText('24 hours left')).toBeInTheDocument();
  });

  it('shows a Restricted item with a lock, no names and no buttons', async () => {
    serveAttention({
      open: [makeItem(1, 'failed_payment', { restricted: true, customer: null, invoice: null, payment_id: null, detail: '', actions: [] })],
    });
    open();
    const region = await card();
    const row = within(region).getByRole('listitem');
    expect(within(row).getAllByText('Restricted').length).toBeGreaterThan(0);
    expect(within(row).queryByRole('button')).not.toBeInTheDocument();
    expect(within(row).queryByRole('link')).not.toBeInTheDocument();
    expect(row).not.toHaveTextContent('Customer 1');
  });

  it('renders no buttons for a view-only caller (empty actions)', async () => {
    serveAttention({ open: [makeItem(1, 'failed_payment', { actions: [] }), makeItem(2, 'failed_refund', { actions: [] })] });
    open();
    const region = await card();
    const rows = within(region).getAllByRole('listitem');
    for (const row of rows) expect(within(row).queryByRole('button')).not.toBeInTheDocument();
    expect(within(region).getByRole('button', { name: /Resolved items/ })).toBeInTheDocument();
  });

  it('lists the buttons in the server\'s order, the first filled and the rest outlined', async () => {
    serveAttention({ open: [makeItem(1, 'failed_refund', { actions: ['mark_resolved', 'refund_again'] })] });
    open();
    const row = within(await card()).getByRole('listitem');
    const buttons = within(row).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Mark resolved', 'Refund again']);
    expect(buttons[0]!.className).toMatch(/bg-primary/);
    expect(buttons[1]!.className).not.toMatch(/bg-primary/);
  });

  it('shows Respond on a dispute the server lists it for', async () => {
    serveAttention({ open: [makeItem(3, 'dispute', { actions: ['respond'] })] });
    open();
    const row = within(await card()).getByRole('listitem');
    expect(within(row).getByRole('button', { name: 'Respond' })).toBeInTheDocument();
  });

  it('every button is at least 44px tall on a phone', async () => {
    serveAttention({ open: [makeItem(1, 'failed_payment', { actions: ['contact_customer', 'mark_resolved'] })] });
    open();
    const row = within(await card()).getByRole('listitem');
    for (const b of within(row).getAllByRole('button')) expect(b.className).toMatch(/max-sm:min-h-11/);
  });
});

describe('title links', () => {
  it('a payment item opens its Payment then the item', async () => {
    const u = user();
    const item = makeItem(1, 'failed_payment');
    serveAttention({ open: [item] });
    open('/payments?tab=payouts');
    await u.click(within(await card()).getByRole('link', { name: 'Bank payment failed' }));
    // Payment first, then the item on top, so Back is always useful.
    expect(new URLSearchParams(search()).get('d')).toBe(`payment:${item.payment_id},item:${item.key}`);
    expect(await screen.findByRole('button', { name: 'Back to Payment' })).toBeInTheDocument();
  });

  it('a payout item opens its Payout then the item', async () => {
    const u = user();
    const item = makeItem(4, 'failed_payout');
    serveAttention({ open: [item] });
    open();
    await u.click(within(await card()).getByRole('link', { name: 'Payout failed' }));
    expect(new URLSearchParams(search()).get('d')).toBe(`payout:po-4,item:${item.key}`);
  });

  it('unmatched money opens its own drawer alone (no payment underneath)', async () => {
    const u = user();
    const item = makeItem(5, 'unmatched_payment');
    serveUnapplied({ unapplied: makeUnapplied({ key: item.key }) });
    open();
    await u.click(within(await card()).getByRole('link', { name: 'Money received that is not on an invoice' }));
    expect(new URLSearchParams(search()).get('d')).toBe(`item:${item.key}`);
  });

  it('a restricted unapplied item has no drawer, so its title is plain text', async () => {
    serveAttention({ open: [makeItem(5, 'unmatched_payment', { restricted: true })] });
    open();
    const row = within(await card()).getByRole('listitem');
    expect(within(row).getByText('Money received that is not on an invoice')).toBeInTheDocument();
    expect(within(row).queryByRole('link')).not.toBeInTheDocument();
  });
});

describe('layout at phone width', () => {
  it('keeps the title, the count and Resolved items in one header group, and the actions on their own full-width line', async () => {
    serveAttention({ open: [makeItem(1, 'failed_payment', { actions: ['contact_customer', 'mark_resolved'] })] });
    open();
    const region = await card();
    const header = region.querySelector('[data-slot="card-header"]') as HTMLElement;
    expect(within(header).getByRole('heading', { name: /Needs attention/ })).toBeInTheDocument();
    expect(within(header).getByText('1')).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: /Resolved items/ })).toBeInTheDocument();
    expect(header.className).toMatch(/flex-wrap/);
    const row = within(region).getByRole('listitem');
    expect(row.className).toMatch(/flex-wrap/);
    const actions = within(row).getByRole('button', { name: 'Contact customer' }).parentElement!;
    expect(actions.parentElement).toBe(row);
    expect(actions.className).toMatch(/max-sm:w-full/);
  });

  it('gives the title link a 44px target on a phone', async () => {
    serveAttention({ open: [makeItem(1, 'failed_payment')] });
    open();
    expect(within(await card()).getByRole('link', { name: 'Bank payment failed' }).className).toMatch(/max-sm:min-h-11/);
  });
});

describe('the row as a whole', () => {
  it('opens the payment drawer when the row (not only its title) is clicked, and not when a button is', async () => {
    const u = user();
    const item = makeItem(1, 'failed_payment', { actions: ['contact_customer', 'mark_resolved'] });
    serveAttention({ open: [item] });
    open('/payments?tab=payouts');
    const row = within(await card()).getByRole('listitem');
    await u.click(within(row).getByRole('button', { name: 'Mark resolved' }));
    expect(search()).not.toContain('d=');
    await u.keyboard('{Escape}');
    await u.click(within(row).getByText(/The bank returned the payment/));
    expect(new URLSearchParams(search()).get('d')).toMatch(new RegExp(`^payment:${item.payment_id}`));
  });

  it('draws a red tile for a failed payment and an amber one for unapplied money', async () => {
    serveAttention({ open: [makeItem(1, 'failed_payment'), makeItem(5, 'unmatched_payment')] });
    open();
    const [failed, unapplied] = within(await card()).getAllByRole('listitem').map((r) => r.querySelector('span.rounded-\\[10px\\]') as HTMLElement);
    expect(failed!.className).toMatch(/status-red/);
    expect(unapplied!.className).toMatch(/status-amber/);
  });
});
