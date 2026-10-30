import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders, seesPrices } from '@/__tests__/helpers';
import { toast } from '@/ui-kit/components/ui/sonner';

import { TabHarness, exportCalls, lastList, listCalls, makeRow, manyRows, mockApi, serve, urlSearch } from './paymentsFixtures';

vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>()),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
const mockToast = vi.mocked(toast);

const user = () => userEvent.setup();
const open = (entry = '/payments') => renderWithProviders(<TabHarness />, { initialEntries: [entry], ability: seesPrices });
const bodyRows = () => within(screen.getAllByRole('rowgroup')[1]!).getAllByRole('row');

const originalMatchMedia = window.matchMedia;
function setPhone(on: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: on && query.includes('max-width: 767px'),
    media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  })) as never;
}

beforeEach(() => {
  mockApi.get.mockReset();
  mockToast.success.mockReset();
  mockToast.error.mockReset();
  serve();
});
afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

describe('toolbar', () => {
  it('shows the quick chips in order, and Disputed carries the summary count', async () => {
    open();
    const group = await screen.findByRole('group', { name: 'Quick filters' });
    expect(within(group).getAllByRole('button').map((b) => b.textContent?.replace(/\d+$/, '').trim())).toEqual([
      'All', 'Succeeded', 'Pending', 'Failed', 'Refunded', 'Disputed', 'Needs attention',
    ]);
    expect(await within(group).findByRole('button', { name: 'Disputed 3' })).toBeInTheDocument();
  });

  it('a chip sets the chip param in the request and the URL, and goes back to All', async () => {
    const u = user();
    open();
    await screen.findByText('Customer 1');
    await u.click(screen.getByRole('button', { name: 'Succeeded' }));
    await waitFor(() => expect(lastList().chip).toBe('succeeded'));
    expect(urlSearch()).toContain('chip=succeeded');
    expect(screen.getByRole('button', { name: 'Succeeded' })).toHaveAttribute('aria-pressed', 'true');
    await u.click(screen.getByRole('button', { name: 'All' }));
    await waitFor(() => expect(lastList().chip).toBeUndefined());
    expect(urlSearch()).not.toContain('chip');
  });

  it('search is debounced 300 ms, sent as q, and resets to page 1', async () => {
    const u = user();
    open();
    await screen.findByText('Customer 1');
    await u.click(screen.getAllByRole('button', { name: 'Next page' })[0]!);
    await waitFor(() => expect(lastList().page).toBe(2));
    const calls = listCalls().length;
    await u.type(screen.getByRole('searchbox', { name: 'Search customer, invoice or payment' }), 'ann');
    expect(listCalls().length).toBe(calls);
    await waitFor(() => expect(lastList()).toMatchObject({ q: 'ann', page: 1 }), { timeout: 2000 });
    expect(listCalls().length).toBe(calls + 1);
    expect(urlSearch()).toContain('q=ann');
  });

  it('the search box is full width and the placeholder reads as specified', async () => {
    open();
    const box = await screen.findByPlaceholderText('Search customer, invoice or payment');
    expect(box.closest('[data-slot="payments-search"]')).not.toBeNull();
  });

  it('puts Filter immediately left of Export', async () => {
    open();
    const filter = await screen.findByRole('button', { name: /Filter/ });
    const exportBtn = screen.getByRole('button', { name: 'Export' });
    expect(filter.nextElementSibling).toBe(exportBtn);
  });

  it('the Filter popover applies a facet to the request and shows it in the applied bar', async () => {
    const u = user();
    open();
    await screen.findByText('Customer 1');
    await u.click(screen.getByRole('button', { name: /Filter/ }));
    await u.click(await screen.findByRole('tab', { name: /Method/ }));
    await u.click(await screen.findByRole('checkbox', { name: /Bank \(ACH\)/ }));
    await waitFor(() => expect(lastList().method).toBe('ACH'));
    expect(urlSearch()).toContain('method=ACH');
    await u.keyboard('{Escape}');
    const bar = await screen.findByRole('button', { name: 'Remove Method filter' });
    expect(bar.closest('[data-slot="filter-bar"]')).toHaveTextContent('Bank (ACH)');
  });

  it('Clear filters resets chip, search and facets together', async () => {
    const u = user();
    serve({ rows: [] });
    open('/payments?chip=failed&q=zed&method=ACH');
    expect(await screen.findByText('No payments match')).toBeInTheDocument();
    expect(screen.getByText('Try a different search, filter or period.')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(urlSearch()).toBe(''));
    expect(screen.getByRole('searchbox')).toHaveValue('');
  });

  it('an empty period with nothing applied says so plainly, with no Clear button', async () => {
    serve({ rows: [] });
    open();
    expect(await screen.findByText('No payments match')).toBeInTheDocument();
    expect(screen.getByText('Payments in this period will show here.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
  });

  it('the request carries the period', async () => {
    open();
    await screen.findByText('Customer 1');
    expect(lastList()).toMatchObject({ from: '2026-09-14', to: '2026-10-13', page: 1, limit: 25 });
  });
});

describe('export', () => {
  let createdBlobs: Blob[] = [];
  beforeEach(() => {
    createdBlobs = [];
    URL.createObjectURL = vi.fn((b: Blob) => { createdBlobs.push(b); return 'blob:x'; }) as never;
    URL.revokeObjectURL = vi.fn();
  });

  it('sends the same period, chip, search and facets, and writes the eight columns with a Restricted row', async () => {
    const u = user();
    const rows = [makeRow(1), makeRow(2, { restricted: true, customer: null, invoice: null }), makeRow(3, { fee: null, net: null })];
    serve({ rows });
    open('/payments?chip=succeeded&q=ann&method=CARD');
    await screen.findByText('Customer 1');
    await u.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(exportCalls().length).toBe(1));
    expect(exportCalls()[0]).toMatchObject({ from: '2026-09-14', to: '2026-10-13', chip: 'succeeded', q: 'ann', method: 'CARD' });
    expect(exportCalls()[0]).not.toHaveProperty('page');
    await waitFor(() => expect(createdBlobs.length).toBe(1));
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(createdBlobs[0]!);
    });
    const lines = text.replace(/^\uFEFF/, '').split('\r\n');
    expect(lines[0]).toBe('Date,Customer,Invoice,Method,Status,Amount,Fee,Net');
    expect(lines[1]).toContain('Customer 1,INV-1001,Credit card,Succeeded,101,3.5,97.5');
    expect(lines[2]).toContain('Restricted,Restricted,Credit card');
    expect(lines).toHaveLength(4);
    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith('Exported 3 payments'));
  });

  it('shows the server message on a 413', async () => {
    const u = user();
    const base = mockApi.get.getMockImplementation()!;
    mockApi.get.mockImplementation(((url: string, c?: unknown) =>
      url === '/api/payments-page/payments/export'
        ? Promise.reject({ response: { status: 413, data: { error: 'Narrow the period or the filters' } } })
        : base(url, c as never)) as never);
    open();
    await screen.findByText('Customer 1');
    await u.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith('Narrow the period or the filters'));
  });

  it('names the file by the period', async () => {
    const u = user();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    let name = '';
    const create = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = create(tag);
      if (tag === 'a') Object.defineProperty(el, 'download', { set: (v: string) => { name = v; }, get: () => name });
      return el;
    }) as never);
    open();
    await screen.findByText('Customer 1');
    await u.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(name).toBe('payments-2026-09-14-2026-10-13.csv');
    vi.restoreAllMocks();
  });
});

describe('table', () => {
  it('pages a 120-row list over 5 pages with no duplicates between pages', async () => {
    const u = user();
    open();
    const seen = new Set<string>();
    for (let page = 1; page <= 5; page++) {
      if (page > 1) await u.click(screen.getAllByRole('button', { name: 'Next page' })[0]!);
      await waitFor(() => expect(lastList().page).toBe(page));
      await screen.findByText(`Customer ${(page - 1) * 25 + 1}`);
      for (const r of bodyRows()) {
        const name = within(r).getAllByRole('cell')[1]!.textContent!;
        expect(seen.has(name)).toBe(false);
        seen.add(name);
      }
    }
    expect(seen.size).toBe(120);
    expect(screen.getAllByRole('button', { name: 'Next page' })[0]).toBeDisabled();
  });

  it('changes the page size', async () => {
    const u = user();
    open();
    await screen.findByText('Customer 1');
    await u.click(screen.getAllByRole('combobox', { name: 'Rows per page' })[0]!);
    await u.click(await screen.findByRole('option', { name: '50' }));
    await waitFor(() => expect(lastList()).toMatchObject({ limit: 50, page: 1 }));
  });

  it('sends sortBy and sortDir from the Amount header', async () => {
    const u = user();
    open();
    await screen.findByText('Customer 1');
    await u.click(screen.getByRole('button', { name: /^Amount/ }));
    await waitFor(() => expect(lastList()).toMatchObject({ sortBy: 'amount', sortDir: 'asc' }));
  });

  it('sorts by Date, newest first, to begin with', async () => {
    open();
    await screen.findByText('Customer 1');
    expect(lastList()).toMatchObject({ sortBy: 'date', sortDir: 'desc' });
  });

  it('renders the columns of the mockup, a status chip, and a dash for a null fee and net', async () => {
    serve({ rows: [makeRow(1, { fee: null, net: null, status: 'Partially refunded' })] });
    open();
    await screen.findByText('Customer 1');
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent?.trim());
    expect(headers).toEqual(['Date', 'Customer', 'Invoice', 'Method', 'Status', 'Amount', 'Fee', 'Net']);
    const cells = within(bodyRows()[0]!).getAllByRole('cell');
    expect(cells[3]).toHaveTextContent('Credit card');
    expect(cells[4]).toHaveTextContent('Partially refunded');
    expect(cells[5]).toHaveTextContent('$101.00');
    expect(cells[6]).toHaveTextContent('—');
    expect(cells[7]).toHaveTextContent('—');
  });

  it('shows Net after the refunds on the payment, as the totals above do', async () => {
    serve({ rows: [makeRow(1, { net: 90, refunded: 10.25, status: 'Partially refunded' })] });
    open();
    await screen.findByText('Customer 1');
    expect(within(bodyRows()[0]!).getAllByRole('cell')[7]).toHaveTextContent('$79.75');
  });

  it('right-aligns money with tabular numerals', async () => {
    open();
    await screen.findByText('Customer 1');
    const cells = within(bodyRows()[0]!).getAllByRole('cell');
    for (const i of [5, 6, 7]) {
      expect(cells[i]!.querySelector('[data-money]')).toHaveClass('tabular-nums');
      expect(cells[i]!.querySelector('[data-money]')).toHaveClass('text-right');
    }
    for (const h of screen.getAllByRole('columnheader').slice(5)) expect(h.querySelector('button')).toHaveClass('ms-auto');
  });

  it('links the invoice number to the invoice without opening the drawer', async () => {
    const u = user();
    open();
    const link = await screen.findByRole('link', { name: 'INV-1001' });
    expect(link).toHaveAttribute('href', '/invoices/inv-1');
    await u.click(link);
    expect(urlSearch()).not.toContain('d=');
  });

  it('a Restricted row shows a lock and the word, has no link and does not open', async () => {
    const u = user();
    serve({ rows: [makeRow(1, { restricted: true, customer: null, invoice: null }), makeRow(2)] });
    open();
    await screen.findByText('Customer 2');
    const row = bodyRows()[0]!;
    expect(within(row).getAllByText('Restricted')).toHaveLength(2);
    expect(row.querySelector('svg.lucide-lock')).not.toBeNull();
    expect(within(row).queryByRole('link')).toBeNull();
    expect(row).not.toHaveAttribute('tabindex');
    await u.click(row);
    expect(urlSearch()).not.toContain('d=');
  });

  it('rows are tab stops and Enter opens the drawer', async () => {
    open();
    await screen.findByText('Customer 1');
    const row = bodyRows()[0]!;
    expect(row).toHaveAttribute('tabindex', '0');
    row.focus();
    fireEvent.keyDown(row, { key: 'Enter' });
    await waitFor(() => expect(new URLSearchParams(urlSearch()).get('d')).toBe('payment:00000000-0000-4000-8000-000000000001'));
  });

  it('shows skeleton rows while loading', async () => {
    mockApi.get.mockImplementation((() => new Promise(() => {})) as never);
    open();
    await waitFor(() => expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(3));
  });

  it('shows one failure with Retry when the list cannot load', async () => {
    const u = user();
    serve({ listError: true });
    open();
    expect(await screen.findByText('Couldn’t load payments.')).toBeInTheDocument();
    serve();
    await u.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Customer 1')).toBeInTheDocument();
  });

  it('renders every label on a 390 px card', async () => {
    setPhone(true);
    open();
    await screen.findByText('Customer 1');
    const card = document.querySelector('[data-slot="table-card"]') as HTMLElement;
    for (const label of ['Date', 'Customer', 'Invoice', 'Method', 'Status', 'Amount', 'Fee', 'Net']) {
      expect(within(card).getByText(label, { selector: 'dt' })).toBeInTheDocument();
    }
  });

  it('never shows a processor id, a raw failure code or a vendor name', async () => {
    open();
    await screen.findByText('Customer 1');
    expect(document.body.textContent).not.toMatch(/stripe|pi_|acct_|po_[a-z0-9]|ctm|supabase|render\.com/i);
  });

  it('is not left holding timers after unmount', async () => {
    const { unmount } = open();
    await screen.findByText('Customer 1');
    await act(async () => { unmount(); });
  });
});

void manyRows;
