/**
 * The Needs attention card's behaviours that used to be asserted against the Settings list (payments go-live slice 11,
 * re-homed through P8 and written here against P7's card at the integration step). Where the new card words or places a
 * thing differently (the date lives in the history table, the confirm is a dialog, a failed refund shows inside it),
 * the assertion follows the new screen and keeps the rule it protected.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';
import { catalogToggle } from '@/__tests__/support/backendSwitchCatalog';
import { toast } from '@/ui-kit/components/ui/sonner';
import type { AttentionItem } from '@/lib/api/paymentsPage';

import PaymentsPage from '../PaymentsPage';
import { makeItem, resolvedItem, serveAttention, findCard } from './attentionFixtures';
import { mockApi } from './paymentsFixtures';

vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>()),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
const mockToast = vi.mocked(toast);
const mockPost = vi.mocked(mockApi.post);

const OWNER = buildAbility(catalogToggle('Manage payout account').grants.map((g) => ({ action: g.action, subject: g.subject }) as never));

function serve(open: AttentionItem[], resolved: AttentionItem[] = []) {
  serveAttention({ open, resolved });
  const base = mockApi.get.getMockImplementation()!;
  mockApi.get.mockImplementation(((url: string, config?: unknown) => {
    if (url === '/api/organization/stripe/status') {
      return Promise.resolve({ data: { connected: true, terms_accepted: true, stripe_charges_enabled: true, stripe_payouts_enabled: true } });
    }
    return (base as (...a: unknown[]) => unknown)(url, config);
  }) as never);
}
const page = (entry = '/payments') => renderWithProviders(<PaymentsPage />, { initialEntries: [entry], ability: OWNER });
const card = () => findCard();
const user = () => userEvent.setup();
/** With nothing open the card is gone; the chip then shows the table, and its Resolved toggle the history. */
const openResolved = async (u: ReturnType<typeof user>) => {
  await u.click(await screen.findByRole('button', { name: /^Needs attention/ }));
  await u.click(await screen.findByRole('button', { name: /^Resolved \(1\)/ }));
};

const unmatchedPayment = (over: Partial<AttentionItem> = {}) =>
  makeItem(5, 'unmatched_payment', { actions: ['refund', 'mark_resolved'], amount: 75, ...over });
const unmatchedRefund = () => makeItem(6, 'unmatched_refund', { actions: ['mark_resolved'], amount: 42 });

beforeEach(() => {
  mockApi.get.mockReset();
  mockPost.mockReset();
  mockToast.success.mockReset();
  mockToast.error.mockReset();
});

describe('a row', () => {
  it('shows the amount, the plain-words reason, the invoice and a Refund button for a refundable payment', async () => {
    serve([unmatchedPayment(), makeItem(1, 'failed_payment', { actions: ['contact_customer'] })]);
    page();
    const rows = within(await card()).getAllByRole('listitem');
    const money = rows.find((r) => r.textContent?.includes('Money received that is not on an invoice'))!;
    expect(money).toHaveTextContent('$75.00');
    expect(money).toHaveTextContent('Not tied to an invoice');
    expect(within(money).getByRole('button', { name: 'Refund' })).toBeInTheDocument();
    const failed = rows.find((r) => r.textContent?.includes('INV-1001'))!;
    expect(failed).toHaveTextContent('The bank returned the payment');
    expect(within(failed).getByRole('link', { name: 'Bank payment failed' })).toBeInTheDocument();
  });

  it('says "Not tied to an invoice" once, for money that belongs to no invoice', async () => {
    serve([unmatchedPayment()]);
    page();
    const row = within(await card()).getByRole('listitem');
    expect(row.textContent!.match(/Not tied to an invoice/g)).toHaveLength(1);
    // The title opens the item's own drawer (V7-09c); nothing else in the row is a link.
    expect(within(row).getAllByRole('link').map((l) => l.textContent)).toEqual(['Money received that is not on an invoice']);
  });

  it('a refund that went out for a payment ServWave never recorded has nothing to send back', async () => {
    serve([unmatchedRefund()]);
    page();
    const row = within(await card()).getByRole('listitem');
    expect(row).toHaveTextContent('Refund sent that is not on an invoice');
    expect(within(row).queryByRole('button', { name: 'Refund' })).not.toBeInTheDocument();
    expect(within(row).getAllByRole('button').map((b) => b.textContent)).toEqual(['Mark resolved']);
  });
});

describe('Refund', () => {
  it('asks first with an amount field starting at the whole amount, and calls nothing until Refund; Cancel calls nothing and closes', async () => {
    serve([unmatchedPayment()]);
    page();
    const u = user();
    await u.click(within(within(await card()).getByRole('listitem')).getByRole('button', { name: 'Refund' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Amount')).toHaveValue('75.00');
    expect(within(dialog).getByText('$75.00 left to refund')).toBeInTheDocument();
    expect(mockPost).not.toHaveBeenCalled();
    await u.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('after a confirmed Refund the item leaves the card and the history reads Refunded with no button', async () => {
    const item = unmatchedPayment();
    const open = [item];
    const resolved: AttentionItem[] = [];
    serve(open, resolved);
    mockPost.mockImplementation((() => {
      open.splice(0, 1);
      resolved.push({ ...item, status: 'resolved', actions: [], resolved_at: '2026-10-12T20:00:00.000Z', resolved_by_name: 'Pat Admin', resolution: { text: 'Refunded', note: null } });
      return Promise.resolve({ data: { item: {} } });
    }) as never);
    page();
    const u = user();
    await u.click(within(within(await card()).getByRole('listitem')).getByRole('button', { name: 'Refund' }));
    await u.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Refund' }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(within(screen.getByRole('region', { name: /Needs attention/ })).getByText('Nothing needs attention')).toBeInTheDocument());
    await openResolved(u);
    const cell = await within(await screen.findByRole('table')).findByText('Resolved: Refunded');
    const row = cell.closest('tr')!;
    expect(within(row).queryByRole('button')).not.toBeInTheDocument();
  });

  it('a refund the server could not send shows its ServWave-worded message in the dialog, no success toast, and stays open', async () => {
    const message = "This refund couldn't be sent through ServWave Payments. Try again in a moment, or contact ServWave support.";
    serve([unmatchedPayment()]);
    mockPost.mockRejectedValue({ response: { status: 502, data: { error: message } } });
    page();
    const u = user();
    const region = await card();
    await u.click(within(within(region).getByRole('listitem')).getByRole('button', { name: 'Refund' }));
    const dialog = await screen.findByRole('dialog');
    await u.click(within(dialog).getByRole('button', { name: 'Refund' }));
    expect(await within(dialog).findByText(message)).toBeInTheDocument();
    expect(mockToast.success).not.toHaveBeenCalled();
    expect(within(dialog).getByRole('button', { name: 'Refund' })).toBeEnabled();
    expect(region).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(/stripe/i);
  });
});

describe('Mark resolved', () => {
  it('on unmatched money is one confirm, and the history then reads Resolved with no button', async () => {
    const item = unmatchedRefund();
    const open = [item];
    const resolved: AttentionItem[] = [];
    serve(open, resolved);
    mockPost.mockImplementation((() => {
      open.splice(0, 1);
      resolved.push({ ...item, status: 'resolved', actions: [], resolved_at: '2026-10-12T20:00:00.000Z', resolved_by_name: 'Pat Admin', resolution: { text: 'Handled outside ServWave', note: null } });
      return Promise.resolve({ data: { item: {} } });
    }) as never);
    page();
    const u = user();
    await u.click(within(within(await card()).getByRole('listitem')).getByRole('button', { name: 'Mark resolved' }));
    await u.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Mark resolved' }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(within(screen.getByRole('region', { name: /Needs attention/ })).getByText('Nothing needs attention')).toBeInTheDocument());
    await openResolved(u);
    expect(mockPost.mock.calls[0]![0]).toBe(`/api/payments-needing-attention/${item.key.split(':')[1]}/resolve`);
    const cell = await within(await screen.findByRole('table')).findByText('Resolved: Handled outside ServWave', { selector: 'span' });
    expect(within(cell.closest('tr')!).queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('the card as a whole', () => {
  it('an empty list says Nothing needs attention on the card, which stays on the page', async () => {
    serve([]);
    page('/payments?chip=attention');
    expect(within(await findCard()).getByText('Nothing needs attention')).toBeInTheDocument();
  });

  it('never names the processor anywhere on the card, in its dialogs or in the refund toast', async () => {
    serve([unmatchedPayment()]);
    mockPost.mockResolvedValue({ data: { item: {} } });
    page();
    const u = user();
    const region = await card();
    expect(region.textContent).not.toMatch(/stripe/i);
    await u.click(within(within(region).getByRole('listitem')).getByRole('button', { name: 'Refund' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).not.toMatch(/stripe/i);
    await u.click(within(dialog).getByRole('button', { name: 'Refund' }));
    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith('Refunded $75.00'));
    expect(String(mockToast.success.mock.calls[0]![0])).not.toMatch(/stripe/i);
  });

  it('a caller without the refund permission is served items with no actions: the card shows them and offers no button', async () => {
    serve([unmatchedPayment({ actions: [] }), makeItem(1, 'failed_payment', { actions: [] })]);
    page();
    const region = await card();
    for (const row of within(region).getAllByRole('listitem')) expect(within(row).queryByRole('button')).not.toBeInTheDocument();
    expect(within(region).queryByRole('button', { name: /^(Refund|Mark resolved|Contact customer)/ })).not.toBeInTheDocument();
  });

  it('has no description line under its header', async () => {
    serve([unmatchedPayment()]);
    page();
    const region = await card();
    const header = within(region).getByRole('heading', { name: /Needs attention/ }).closest('[data-slot="card-header"]') ?? region.firstElementChild!;
    expect(header.querySelector('p')).toBeNull();
    expect(header.textContent).toBe('Needs attention1Resolved items (0)');
  });
});

describe('dates read in the company time zone', () => {
  it('shows an item at 03:30 UTC on the 13th as the 12th (Los Angeles), and the resolved date the same way', async () => {
    const open = makeItem(1, 'failed_payment', { actions: [], date: '2026-10-13T03:30:00.000Z' });
    const done = resolvedItem(2, { date: '2026-10-13T03:30:00.000Z', resolved_at: '2026-10-14T02:00:00.000Z' });
    serve([open], [done]);
    page('/payments?chip=attention');
    const dateCell = await screen.findByText('Oct 12, 2026');
    expect(dateCell).toBeInTheDocument();
    expect(screen.queryByText('Oct 13, 2026')).not.toBeInTheDocument();
    await user().click(screen.getByRole('button', { name: 'Resolved (1)' }));
    // The table shows the item's own date (in the company's zone) and, in Actions, who resolved it.
    expect(await screen.findByText('Pat Admin')).toBeInTheDocument();
    expect(screen.getByText('Oct 12, 2026')).toBeInTheDocument();
    expect(screen.queryByText('Oct 13, 2026')).not.toBeInTheDocument();
  });
});
