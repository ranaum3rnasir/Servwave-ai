import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/__tests__/helpers';

import { attentionCalls, makeItem, resolvedItem, serveAttention } from './attentionFixtures';
import { TabHarness, listCalls, manyRows, mockApi, urlSearch } from './paymentsFixtures';

vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>()),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

const user = () => userEvent.setup();
/** The cells re-render once the company's time zone arrives; this waits for that so a click lands on a live node. */
async function settledText(text: string) {
  await screen.findByText(text);
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
  return screen.getByText(text);
}
const open = (entry = '/payments?chip=attention') => renderWithProviders(<TabHarness />, { initialEntries: [entry] });
const bodyRows = () => within(screen.getAllByRole('rowgroup')[1]!).getAllByRole('row');
const lastAttention = () => attentionCalls().filter((c) => c.limit === 25).at(-1)!;

const openItems = (n: number) => Array.from({ length: n }, (_, i) => makeItem(i + 1, 'failed_payment', { actions: [] }));
const resolvedItems = (n: number) => Array.from({ length: n }, (_, i) => resolvedItem(i + 100));

beforeEach(() => mockApi.get.mockReset());

describe('the chip and the segmented control', () => {
  it('adds a Needs attention chip with the open count, which turns the table into the items view', async () => {
    const u = user();
    serveAttention({ open: openItems(4), resolved: resolvedItems(2) });
    open('/payments');
    const chip = await screen.findByRole('button', { name: 'Needs attention 4' });
    expect(screen.queryByRole('group', { name: 'Item status' })).not.toBeInTheDocument();
    await u.click(chip);
    expect(urlSearch()).toContain('chip=attention');
    const seg = await screen.findByRole('group', { name: 'Item status' });
    expect(within(seg).getByRole('button', { name: 'Open (4)' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(seg).getByRole('button', { name: 'Resolved (2)' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('Open and Resolved switch the request and the URL', async () => {
    const u = user();
    serveAttention({ open: openItems(4), resolved: resolvedItems(2) });
    open();
    await screen.findByRole('group', { name: 'Item status' });
    await waitFor(() => expect(lastAttention()).toMatchObject({ view: 'open', page: 1, limit: 25 }));
    await u.click(screen.getByRole('button', { name: 'Resolved (2)' }));
    await waitFor(() => expect(lastAttention()).toMatchObject({ view: 'resolved' }));
    expect(urlSearch()).toContain('attView=resolved');
    await u.click(screen.getByRole('button', { name: 'Open (4)' }));
    await waitFor(() => expect(lastAttention()).toMatchObject({ view: 'open' }));
  });

  it('a deep link restores the Resolved view', async () => {
    serveAttention({ open: openItems(1), resolved: resolvedItems(3) });
    open('/payments?chip=attention&attView=resolved');
    expect(await screen.findByRole('button', { name: 'Resolved (3)' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(lastAttention()).toMatchObject({ view: 'resolved' }));
    expect(await screen.findAllByText('Marked resolved')).toHaveLength(3);
  });

  it('replaces the payments list, the Filter popover and Export', async () => {
    serveAttention({ open: openItems(2) });
    open();
    await screen.findByRole('group', { name: 'Item status' });
    expect(listCalls()).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /^Filter/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Export' })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Type' })).toBeInTheDocument();
  });
});

describe('the table', () => {
  it('shows the columns and what happened, with who resolved it and when', async () => {
    serveAttention({ open: [], resolved: [resolvedItem(7)] });
    open('/payments?chip=attention&attView=resolved');
    const headers = (await screen.findAllByRole('columnheader')).map((h) => h.textContent);
    expect(headers).toEqual(['Date', 'What happened', 'Customer', 'Invoice', 'Amount', 'Status']);
    await settledText('Bank payment failed');
    const row = bodyRows()[0]!;
    expect(within(row).getByText('Bank payment failed')).toBeInTheDocument();
    expect(within(row).getByText('Customer 7')).toBeInTheDocument();
    expect(within(row).getByText('INV-1007')).toBeInTheDocument();
    expect(within(row).getByText('$107.00')).toBeInTheDocument();
    expect(within(row).getByText('Marked resolved')).toBeInTheDocument();
    expect(within(row).getByText('Oct 10, 2026 by Pat Admin')).toBeInTheDocument();
  });

  it('shows Open as the status of an open item', async () => {
    serveAttention({ open: openItems(1) });
    open();
    expect(await settledText('Open')).toBeInTheDocument();
  });

  it('a restricted row shows the lock and names no one', async () => {
    serveAttention({ open: [makeItem(1, 'failed_payment', { restricted: true, customer: null, invoice: null, payment_id: null, actions: [] })] });
    open();
    await settledText('Bank payment failed');
    const row = bodyRows()[0]!;
    expect(within(row).getAllByText('Restricted')).toHaveLength(2);
  });

  it('pages on the server: 25 per page, the next page is requested, never sliced here', async () => {
    const u = user();
    serveAttention({ open: openItems(300) });
    open();
    await waitFor(() => expect(bodyRows()).toHaveLength(25));
    expect(lastAttention()).toMatchObject({ page: 1, limit: 25 });
    await u.click(screen.getAllByRole('button', { name: 'Next page' })[0]!);
    await waitFor(() => expect(lastAttention()).toMatchObject({ page: 2, limit: 25 }));
    await waitFor(() => expect(within(bodyRows()[0]!).getByText('Customer 26')).toBeInTheDocument());
  });

  it('search is sent as q', async () => {
    const u = user();
    serveAttention({ open: openItems(30) });
    open();
    await screen.findByRole('group', { name: 'Item status' });
    await u.type(screen.getByRole('searchbox', { name: /Search/ }), 'Customer 12');
    await waitFor(() => expect(lastAttention()).toMatchObject({ q: 'Customer 12' }));
    await waitFor(() => expect(bodyRows()).toHaveLength(1));
  });

  it('the type select narrows by type', async () => {
    const u = user();
    serveAttention({ open: [makeItem(1, 'failed_payment', { actions: [] }), makeItem(2, 'dispute', { actions: [] })] });
    open();
    await u.click(await screen.findByRole('combobox', { name: 'Type' }));
    await u.click(await screen.findByRole('option', { name: 'Disputes' }));
    await waitFor(() => expect(lastAttention()).toMatchObject({ type: ['dispute'] }));
    expect(urlSearch()).toContain('type=dispute');
  });

  it('says so when nothing needs attention, and when nothing is resolved yet', async () => {
    serveAttention({ open: [], resolved: [] });
    open();
    expect(await screen.findByText('Nothing needs attention')).toBeInTheDocument();
  });

  it('says "No resolved items yet" for an empty history', async () => {
    serveAttention({ open: openItems(1), resolved: [] });
    open('/payments?chip=attention&attView=resolved');
    expect(await screen.findByText('No resolved items yet')).toBeInTheDocument();
  });

  it('past the API\'s cap it shows the server\'s message and how to narrow', async () => {
    serveAttention({ open: openItems(5), tooDeep: true });
    open('/payments?chip=attention');
    // 45 pages of 25 is offset 1,100: the route refuses it.
    const u = user();
    await screen.findByRole('group', { name: 'Item status' });
    // jump by serving a refusal for any page past the first
    mockApi.get.mockImplementation(((url: string) => {
      if (url === '/api/payments-page/attention') {
        return Promise.reject({ response: { status: 400, data: { error: 'Narrow with search or a type filter' } } });
      }
      return Promise.resolve({ data: {} });
    }) as never);
    await u.type(screen.getByRole('searchbox', { name: /Search/ }), 'x');
    expect(await screen.findByText('Narrow with search or a type filter')).toBeInTheDocument();
    expect(screen.getByText('Search or choose a type to narrow')).toBeInTheDocument();
  });
});

describe('opening a row', () => {
  it('a payment row opens the payment drawer', async () => {
    const u = user();
    const item = makeItem(1, 'failed_payment', { actions: [] });
    serveAttention({ open: [item], rows: manyRows(3) });
    open();
    await u.click(await screen.findByText('Customer 1'));
    expect(urlSearch()).toContain(`payment=${item.payment_id}`);
    expect(await screen.findByRole('dialog', { name: 'Customer 1' })).toBeInTheDocument();
  });

  it('a payout row addresses the payout drawer', async () => {
    const u = user();
    serveAttention({ open: [makeItem(4, 'failed_payout', { actions: [] })] });
    open();
    await u.click(await settledText('Payout failed'));
    expect(urlSearch()).toContain('tab=payouts');
    expect(urlSearch()).toContain('payout=po-4');
  });

  it('unmatched money has no drawer', async () => {
    const u = user();
    serveAttention({ open: [makeItem(5, 'unmatched_payment', { actions: [] })] });
    open();
    await u.click(await screen.findByText('Money received that is not on an invoice'));
    expect(urlSearch()).not.toContain('payment=');
    expect(urlSearch()).not.toContain('payout=');
  });
});

describe('the payment drawer\'s action slot', () => {
  it('receives the open actions that belong to that payment', async () => {
    const rows = manyRows(3);
    const mine = makeItem(1, 'failed_payment', { payment_id: rows[0]!.id, actions: ['contact_customer', 'mark_resolved'] });
    const other = makeItem(2, 'failed_payment', { payment_id: rows[1]!.id, actions: ['mark_resolved'] });
    serveAttention({ open: [mine, other], rows });
    open(`/payments?payment=${rows[0]!.id}`);
    const dialog = await screen.findByRole('dialog', { name: 'Customer 1' });
    expect(await within(dialog).findByRole('button', { name: 'Contact customer' })).toBeInTheDocument();
    expect(within(dialog).getAllByRole('button', { name: 'Mark resolved' })).toHaveLength(1);
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('finds the payment\'s item even when it is far down a long open backlog', async () => {
    const rows = manyRows(3);
    const filler = Array.from({ length: 60 }, (_, i) => makeItem(i + 10, 'failed_payment', { actions: ['mark_resolved'] }));
    const mine = makeItem(1, 'failed_payment', { payment_id: rows[0]!.id, actions: ['contact_customer'] });
    serveAttention({ open: [...filler, mine], rows });
    open(`/payments?payment=${rows[0]!.id}`);
    const dialog = await screen.findByRole('dialog', { name: 'Customer 1' });
    expect(await within(dialog).findByRole('button', { name: 'Contact customer' })).toBeInTheDocument();
  });
});

describe('page size', () => {
  it('has no rows-per-page control and keeps asking for 25', async () => {
    serveAttention({ open: openItems(30) });
    open();
    await screen.findAllByText(/Showing/);
    await waitFor(() => expect(lastAttention()).toMatchObject({ limit: 25 }));
    expect(screen.queryByRole('combobox', { name: 'Rows per page' })).not.toBeInTheDocument();
    expect(screen.queryByText('Rows')).not.toBeInTheDocument();
  });
});
