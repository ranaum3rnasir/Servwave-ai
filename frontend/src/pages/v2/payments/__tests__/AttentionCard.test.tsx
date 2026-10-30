import { beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';

import { renderWithProviders } from '@/__tests__/helpers';

import { AttentionCard } from '../components/AttentionCard';
import { attentionCalls, makeItem, resolvedItem, serveAttention } from './attentionFixtures';
import { mockApi } from './paymentsFixtures';

function Where() {
  const { search } = useLocation();
  return <div data-testid="search">{search}</div>;
}
const open = (entry = '/payments') => renderWithProviders(<><AttentionCard /><Where /></>, { initialEntries: [entry] });
const search = () => screen.getByTestId('search').textContent ?? '';
const user = () => userEvent.setup();
const card = () => screen.findByRole('region', { name: /Needs attention/ });

beforeEach(() => mockApi.get.mockReset());

describe('visibility', () => {
  it('renders nothing while no item is open', async () => {
    serveAttention({ open: [], resolved: [resolvedItem(1)] });
    open();
    await waitFor(() => expect(attentionCalls().length).toBeGreaterThan(0));
    expect(screen.queryByRole('region', { name: /Needs attention/ })).not.toBeInTheDocument();
  });

  it('renders nothing when the route answers with nothing usable', async () => {
    mockApi.get.mockImplementation((() => Promise.resolve({ data: {} })) as never);
    open();
    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: /Needs attention/ })).not.toBeInTheDocument();
  });
});

describe('the list', () => {
  const twelve = () => Array.from({ length: 12 }, (_, i) => makeItem(i + 1, 'failed_payment', { actions: ['contact_customer', 'mark_resolved'] }));

  it('asks for five open items only, shows five of twelve, and offers "Show all 12"', async () => {
    serveAttention({ open: twelve(), resolved: [resolvedItem(50), resolvedItem(51)] });
    open();
    const region = await card();
    expect(attentionCalls()[0]).toMatchObject({ view: 'open', limit: 5 });
    expect(within(region).getAllByRole('listitem')).toHaveLength(5);
    expect(within(region).getByText('12')).toBeInTheDocument();
    expect(within(region).getByRole('button', { name: 'Show all 12' })).toBeInTheDocument();
    expect(within(region).getByRole('button', { name: 'Resolved items (2)' })).toBeInTheDocument();
  });

  it('has no "Show all" when everything is already shown', async () => {
    serveAttention({ open: [makeItem(1, 'failed_payment', { actions: [] }), makeItem(2, 'failed_payment', { actions: [] })] });
    open();
    const region = await card();
    expect(within(region).queryByRole('button', { name: /Show all/ })).not.toBeInTheDocument();
  });

  it('Show all and Resolved items land on the history table', async () => {
    const u = user();
    serveAttention({ open: twelve(), resolved: [resolvedItem(50)] });
    open('/payments?tab=payouts&payment=abc');
    const region = await card();
    await u.click(within(region).getByRole('button', { name: 'Show all 12' }));
    expect(search()).toContain('tab=payments');
    expect(search()).toContain('chip=attention');
    expect(search()).toContain('attView=open');
    expect(search()).not.toContain('payment=abc');
    await u.click(within(region).getByRole('button', { name: 'Resolved items (1)' }));
    expect(search()).toContain('attView=resolved');
  });
});

describe('the rows', () => {
  it('words each kind\'s secondary line', async () => {
    serveAttention({
      open: [
        makeItem(1, 'failed_payment'),
        makeItem(2, 'failed_refund'),
        makeItem(3, 'dispute'),
        makeItem(4, 'failed_payout'),
        makeItem(5, 'unmatched_payment'),
      ],
    });
    open();
    const region = await card();
    expect(within(region).getByText('Customer 1 · INV-1001 · $101.00 · The bank returned the payment')).toBeInTheDocument();
    expect(within(region).getByText('Customer 2 · INV-1002 · $102.00 · The refund did not reach the customer')).toBeInTheDocument();
    expect(within(region).getByText('Customer 3 · INV-1003 · $103.00 · Respond by Oct 20, 2026 (6 days left)')).toBeInTheDocument();
    expect(within(region).getByText('Payout PO-ABC4 · $104.00 · The bank account could not be credited')).toBeInTheDocument();
    expect(within(region).getByText('$105.00 · Not tied to an invoice')).toBeInTheDocument();
  });

  it('says "1 day left" for one day', async () => {
    serveAttention({ open: [makeItem(3, 'dispute', { days_left: 1 })] });
    open();
    expect(await screen.findByText(/\(1 day left\)/)).toBeInTheDocument();
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
    serveAttention({ open: [makeItem(1, 'failed_refund', { actions: ['mark_settled', 'refund_again'] })] });
    open();
    const row = within(await card()).getByRole('listitem');
    const buttons = within(row).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Mark settled', 'Refund again']);
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
  it('a payment item opens the payment drawer address', async () => {
    const u = user();
    const item = makeItem(1, 'failed_payment');
    serveAttention({ open: [item] });
    open('/payments?tab=payouts');
    await u.click(within(await card()).getByRole('link', { name: 'Bank payment failed' }));
    expect(search()).toContain(`payment=${item.payment_id}`);
    expect(search()).toContain('tab=payments');
  });

  it('a payout item opens the payout address', async () => {
    const u = user();
    serveAttention({ open: [makeItem(4, 'failed_payout')] });
    open();
    await u.click(within(await card()).getByRole('link', { name: 'Payout failed' }));
    expect(search()).toContain('tab=payouts');
    expect(search()).toContain('payout=po-4');
  });

  it('unmatched money has no drawer, so its title is plain text', async () => {
    serveAttention({ open: [makeItem(5, 'unmatched_payment')] });
    open();
    const row = within(await card()).getByRole('listitem');
    expect(within(row).getByText('Money received that is not on an invoice')).toBeInTheDocument();
    expect(within(row).queryByRole('link')).not.toBeInTheDocument();
  });
});

describe('layout at phone width', () => {
  it('keeps the title, the count and Resolved items in one header group, and the buttons in the text column', async () => {
    serveAttention({ open: [makeItem(1, 'failed_payment', { actions: ['contact_customer', 'mark_resolved'] })] });
    open();
    const region = await card();
    const header = region.querySelector('[data-slot="card-header"]') as HTMLElement;
    expect(within(header).getByRole('heading', { name: /Needs attention/ })).toBeInTheDocument();
    expect(within(header).getByText('1')).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: /Resolved items/ })).toBeInTheDocument();
    expect(header.className).toMatch(/flex-wrap/);
    const row = within(region).getByRole('listitem');
    const contact = within(row).getByRole('button', { name: 'Contact customer' });
    const column = contact.parentElement!.parentElement!;
    // The icon is a sibling of that column, never an ancestor-level neighbour of the buttons.
    expect(column).toContainElement(within(row).getByRole('link'));
    expect(column.querySelector('svg')).toBeNull();
    expect(column.parentElement).toBe(row);
  });
});
