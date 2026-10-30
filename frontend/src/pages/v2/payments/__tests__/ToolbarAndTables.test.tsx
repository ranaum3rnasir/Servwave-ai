import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/__tests__/helpers';
import { INTENDED_X_SCROLLERS } from '@/ui-kit/lib/intendedScrollers';

import { buildAttentionColumns } from '../components/attentionColumns';
import { makeItem, resolvedItem, serveAttention } from './attentionFixtures';
import { TabHarness, makeRow, manyRows, mockApi, serve, urlSearch } from './paymentsFixtures';

vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>()),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

let switches: Record<string, boolean> = {};
vi.mock('@/lib/api/mySwitches', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/mySwitches')>()),
  useMySwitches: () => ({ admin_box: false, values: switches }),
}));

const user = () => userEvent.setup();
const open = (entry = '/payments') => renderWithProviders(<TabHarness />, { initialEntries: [entry] });
const bodyRows = () => within(screen.getAllByRole('rowgroup')[1]!).getAllByRole('row');
async function rowWith(text: string) {
  await screen.findByText(text);
  await waitFor(() => expect(bodyRows().some((r) => within(r).queryByText(text))).toBe(true));
  return bodyRows().find((r) => within(r).queryByText(text))!;
}
const headers = () => screen.getAllByRole('columnheader').map((h) => h.textContent?.trim());

beforeEach(() => {
  mockApi.get.mockReset();
  switches = {};
  serve();
});

describe('chips', () => {
  it('scroll sideways in their own named row, and the gate knows about it (C-24)', async () => {
    open();
    const group = await screen.findByRole('group', { name: 'Quick filters' });
    expect(group).toHaveAttribute('data-mobile-scroll-x', 'payments-quick-filters');
    expect(INTENDED_X_SCROLLERS).toContain('payments-quick-filters');
    for (const chip of within(group).getAllByRole('button')) {
      expect(chip.classList.contains('shrink-0')).toBe(true);
      expect(chip.classList.contains('rounded-full')).toBe(true);
      expect(chip.classList.contains('h-9')).toBe(true);
      expect(chip.classList.contains('max-sm:h-11')).toBe(true);
    }
  });

  it('has no Refund failed chip', async () => {
    open();
    const group = await screen.findByRole('group', { name: 'Quick filters' });
    expect(within(group).queryByRole('button', { name: /Refund failed/ })).not.toBeInTheDocument();
  });
});

describe('the Filter button and its facets', () => {
  it('names the count once something is applied', async () => {
    const u = user();
    open();
    expect(await screen.findByRole('button', { name: 'Filter' })).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Filter' }));
    await u.click(await screen.findByRole('tab', { name: /Method/ }));
    await u.click(await screen.findByRole('checkbox', { name: /Bank \(ACH\)/ }));
    expect(await screen.findByRole('button', { name: 'Filter, 1 applied' })).toBeInTheDocument();
  });

  it('calls the payout facet "Payout status" and offers Refund failed, Charged back and Voided under Status', async () => {
    const u = user();
    open();
    await u.click(await screen.findByRole('button', { name: 'Filter' }));
    expect(await screen.findByRole('tab', { name: /Payout status/ })).toBeInTheDocument();
    await u.click(await screen.findByRole('tab', { name: /Status/ }));
    for (const label of ['Refund failed', 'Charged back', 'Voided']) {
      expect(await screen.findByRole('checkbox', { name: new RegExp(label) })).toBeInTheDocument();
    }
  });

  const appliedStrip = async () => (await screen.findByRole('button', { name: 'Remove Method filter' })).closest('[data-slot="filter-bar"]')!;

  it('shows "shown of total" in the applied strip when there is no search and the chip is All', async () => {
    open('/payments?method=ACH');
    const strip = await appliedStrip();
    await waitFor(() => expect(strip).toHaveTextContent(/25\s*of\s*120/));
  });

  it('leaves the count out of the applied strip while a search is on', async () => {
    open('/payments?method=ACH&q=ann');
    const strip = await appliedStrip();
    await screen.findByText('Customer 1');
    expect(strip).not.toHaveTextContent(/of\s*120/);
  });

  it('leaves the count out of the applied strip while a status chip is on', async () => {
    open('/payments?method=ACH&chip=failed');
    const strip = await appliedStrip();
    await screen.findByText('Customer 1');
    expect(strip).not.toHaveTextContent(/of\s*120/);
  });
});

describe('the Payments table', () => {
  it('lists Date, Customer, Invoice, Method, Status, Amount, Fee, Net, with the year on the date', async () => {
    open();
    await screen.findByText('Customer 1');
    expect(headers()).toEqual(['Date', 'Customer', 'Invoice', 'Method', 'Status', 'Amount', 'Fee', 'Net']);
    expect(within(bodyRows()[0]!).getByText('Oct 12, 2026')).toBeInTheDocument();
  });

  it('puts the customer ID under the name as a new-tab link for a viewer with View customers', async () => {
    switches = { view_customers: true };
    const u = user();
    open();
    const link = await screen.findByRole('link', { name: /C-1001/ });
    expect(link).toHaveAttribute('href', '/customers/c1');
    expect(link).toHaveAttribute('target', '_blank');
    const cell = link.closest('td')!;
    expect(cell).toHaveTextContent('Customer 1');
    await u.click(link);
    expect(urlSearch()).not.toContain('payment=');
  });

  it('prints the customer ID as plain text for a viewer without View customers', async () => {
    open();
    await screen.findByText('Customer 1');
    expect(screen.queryByRole('link', { name: /C-1001/ })).not.toBeInTheDocument();
    expect(screen.getByText('C-1001')).toBeInTheDocument();
  });

  it('shows a Restricted row with no ID', async () => {
    serve({ rows: [makeRow(1, { restricted: true, customer: null, invoice: null })] });
    open();
    await screen.findAllByText('Restricted');
    const row = bodyRows()[0]!;
    expect(within(row).getAllByText('Restricted')).toHaveLength(2);
    expect(row).not.toHaveTextContent(/C-\d+/);
  });

  it('a failed-refund payment wears "Refund failed", never "Succeeded"; a failed payment has dashes for Fee and Net', async () => {
    serve({
      rows: [
        makeRow(1, { status: 'Refund failed' }),
        makeRow(2, { status: 'Failed', fee: null, net: null }),
      ],
    });
    open();
    await screen.findByText('Customer 1');
    const [first, second] = bodyRows();
    expect(within(first!).getByText('Refund failed')).toBeInTheDocument();
    expect(within(first!).queryByText('Succeeded')).not.toBeInTheDocument();
    expect(within(second!).getAllByText('—')).toHaveLength(2);
  });

  it('pages 120 payments 25 at a time on the server', async () => {
    const u = user();
    serve({ rows: manyRows(120) });
    open();
    await screen.findByText('Customer 1');
    expect(bodyRows()).toHaveLength(25);
    expect(screen.getAllByText(/Page 1 of 5/).length).toBeGreaterThan(0);
    await u.click(screen.getAllByRole('button', { name: 'Next page' })[0]!);
    await screen.findByText('Customer 26');
    expect(bodyRows()).toHaveLength(25);
  });
});

describe('the Needs attention toolbar', () => {
  it('has the Open/Resolved switch with counts and no Type select, Filter or Export', async () => {
    serveAttention({ open: [makeItem(1)], resolved: [resolvedItem(2), resolvedItem(3)] });
    open('/payments?chip=attention');
    const seg = await screen.findByRole('group', { name: 'Item status' });
    expect(await within(seg).findByRole('button', { name: 'Open (1)' })).toHaveAttribute('aria-pressed', 'true');
    expect(await within(seg).findByRole('button', { name: 'Resolved (2)' })).toHaveAttribute('aria-pressed', 'false');
    for (const b of within(seg).getAllByRole('button')) expect(b.classList.contains('max-sm:h-11')).toBe(true);
    expect(screen.queryByRole('combobox', { name: 'Type' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Filter/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Export' })).not.toBeInTheDocument();
  });
});

describe('the Needs attention table', () => {
  it('lists Date, Item, Customer, Invoice, Status, Amount, Actions', async () => {
    serveAttention({ open: [makeItem(1)] });
    open('/payments?chip=attention');
    await rowWith('Bank payment failed');
    expect(headers()).toEqual(['Date', 'Item', 'Customer', 'Invoice', 'Status', 'Amount', 'Actions']);
  });

  it('shows the title, its detail, the customer with an ID link, the invoice and a Failed pill', async () => {
    switches = { view_customers: true };
    serveAttention({ open: [makeItem(1)] });
    open('/payments?chip=attention');
    const row = await rowWith('Bank payment failed');
    expect(within(row).getByText('The bank returned the payment')).toBeInTheDocument();
    expect(within(row).getByText('Customer 1')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: /C-1001/ })).toHaveAttribute('target', '_blank');
    expect(within(row).getByText('INV-1001')).toBeInTheDocument();
    expect(within(row).getByText('Failed')).toBeInTheDocument();
    expect(within(row).getByText('$101.00')).toBeInTheDocument();
  });

  it('gives an open row the same buttons as the card, and pressing one does not open the row', async () => {
    const u = user();
    serveAttention({ open: [makeItem(1)] });
    open('/payments?chip=attention');
    const row = await rowWith('Bank payment failed');
    await u.click(within(row).getByRole('button', { name: 'Mark resolved' }));
    expect(await screen.findByRole('dialog', { name: 'Mark as resolved' })).toBeInTheDocument();
    expect(urlSearch()).not.toContain('payment=');
  });

  it('names who resolved a resolved item, prints "Resolved: " once and shows a Resolved pill', async () => {
    serveAttention({ open: [], resolved: [resolvedItem(7)] });
    open('/payments?chip=attention&attView=resolved');
    const row = await rowWith('Bank payment failed');
    expect(within(row).getAllByText('Resolved: Handled outside ServWave')).toHaveLength(1);
    expect(within(row).getByText('Resolved')).toBeInTheDocument();
    expect(within(row).getByText('Pat Admin')).toBeInTheDocument();
    expect(within(row).queryByRole('button')).not.toBeInTheDocument();
  });

  it('puts "Meant for" under the invoice of unapplied money and a Unapplied pill', async () => {
    serveAttention({
      open: [makeItem(5, 'unmatched_payment', {
        actions: [], customer: { id: 'c5', name: 'Customer 5', customer_number: 'C-1005' }, invoice: { id: 'inv-5', number: 'INV-1005' },
      })],
    });
    open('/payments?chip=attention');
    const row = await rowWith('Money received that is not on an invoice');
    const cell = within(row).getByText('INV-1005').closest('td')!;
    expect(cell).toHaveTextContent('Meant for');
    expect(within(row).getByText('Unapplied')).toBeInTheDocument();
  });

  it('shows a dispute\'s own status and a failed refund as Refund failed', async () => {
    serveAttention({
      open: [
        makeItem(1, 'dispute', { dispute_status: 'UNDER_REVIEW', actions: [] }),
        makeItem(2, 'failed_refund', { actions: [] }),
      ],
    });
    open('/payments?chip=attention');
    await rowWith('Dispute needs a response');
    const [dispute, refund] = bodyRows();
    expect(within(dispute!).getByText('Under review')).toBeInTheDocument();
    expect(within(refund!).getAllByText('Refund failed').length).toBeGreaterThan(0);
  });

  it('a restricted row shows the lock, no ID and no actions', async () => {
    serveAttention({ open: [makeItem(1, 'failed_payment', { restricted: true, customer: null, invoice: null, payment_id: null })] });
    open('/payments?chip=attention');
    const row = await rowWith('Bank payment failed');
    expect(within(row).getAllByText('Restricted')).toHaveLength(2);
    expect(within(row).queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('the Needs attention table fits its box (fix round 1)', () => {
  it('declares column sizes that sum to no more than the 1280px box (1014px) and give Actions room for its buttons', () => {
    const cols = buildAttentionColumns({ timeZone: 'UTC' });
    const sizes = Object.fromEntries(cols.map((c) => [c.id, c.size ?? 0])) as Record<string, number>;
    expect(Object.values(sizes).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1014);
    expect(sizes.actions).toBeGreaterThanOrEqual(300);
  });

  it('right-aligns the Actions header and the resolved-by name', async () => {
    serveAttention({ open: [], resolved: [resolvedItem(7)] });
    open('/payments?chip=attention&attView=resolved');
    await rowWith('Bank payment failed');
    expect(screen.getByText('Actions').classList.contains('text-right')).toBe(true);
    expect(screen.getByText('Pat Admin').classList.contains('text-right')).toBe(true);
  });
});

describe('empty states', () => {
  it('Needs attention, Open, nothing there: the check state with no button', async () => {
    serveAttention({ open: [], resolved: [] });
    open('/payments?chip=attention');
    expect(await screen.findByText('Nothing needs attention', { selector: 'h3' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
  });

  it('a search with no match says "No payments match" in the items table, and Clear filters goes back to All', async () => {
    const u = user();
    serveAttention({ open: [makeItem(1)] });
    open('/payments?chip=attention&q=zzz');
    expect(await screen.findByText('No payments match')).toBeInTheDocument();
    expect(screen.getByText('Try a different search, filter or period.')).toBeInTheDocument();
    expect(screen.queryByText('No items match')).not.toBeInTheDocument();
    expect(screen.queryByText(/Showing/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Page 0 of 0/)).not.toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(urlSearch()).toBe(''));
  });

  it('the Resolved view with nothing in it keeps "No resolved items yet"', async () => {
    serveAttention({ open: [makeItem(1)], resolved: [] });
    open('/payments?chip=attention&attView=resolved');
    expect(await screen.findByText('No resolved items yet')).toBeInTheDocument();
  });
});
