/**
 * Purchasing Audit Verdict PR 2 (S2.2): the Purchase Orders page after the
 * Pre-PO queue. Two tabs (Open = draft + ordered + partial, History = received
 * + closed + cancelled), KPI tiles Drafts / Ordered / Late / Arriving this
 * week, no "Show resolved", and an honest History: "Received on" prints the
 * real `receivedAt`, "Lead time" the server's `leadTimeDays` - in the grid
 * and in the CSV alike.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/__tests__/helpers';
import type { PurchaseOrder } from '@/lib/api/inventory';

const hoisted = vi.hoisted(() => {
  function po(n: number, status: PurchaseOrder['status'], over: Partial<PurchaseOrder> = {}): PurchaseOrder {
    return {
      id: `f000000${n}-0000-0000-0000-000000000001`,
      poNumber: `PO-300${n}`,
      vendor: 'Acme Supply',
      status,
      orderedAt: status === 'draft' ? null : '2026-07-01T12:00:00.000Z',
      orderedBy: status === 'draft' ? null : { id: 'u1', name: 'Dana Buyer' },
      expectedDate: '2026-07-20T00:00:00.000Z',
      receivedAt: null,
      leadTimeDays: null,
      notes: null,
      signatureData: null,
      signatureName: null,
      signatureAt: null,
      createdAt: '2026-06-30T12:00:00.000Z',
      lines: [
        { id: `l${n}`, itemSku: 'CAP-01', itemName: 'Run Capacitor', uom: 'ea', qtyOrdered: 4, qtyReceived: status === 'received' ? 4 : 0, unitCost: 12.5 },
      ],
      ...over,
    };
  }
  return {
    toCSV: vi.fn((_rows: Record<string, unknown>[]) => 'csv-content'),
    downloadCSV: vi.fn(),
    pos: [
      po(1, 'draft'),
      po(2, 'ordered'),
      po(3, 'partial', { lines: [{ id: 'l3', itemSku: 'CAP-01', itemName: 'Run Capacitor', uom: 'ea', qtyOrdered: 4, qtyReceived: 1, unitCost: 12.5 }] }),
      po(4, 'received', { receivedAt: '2026-07-12T15:00:00.000Z', leadTimeDays: 11 }),
      po(5, 'closed', { receivedAt: '2026-07-05T15:00:00.000Z', leadTimeDays: 4 }),
      po(6, 'cancelled'),
    ],
  };
});

vi.mock('@/lib/inventory/csv', () => ({
  toCSV: hoisted.toCSV,
  downloadCSV: hoisted.downloadCSV,
}));

// Seam mocked with stable, already-resolved data (see poBulkExport.test.tsx for
// why axios-level mocking hangs this page's seed effects).
vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const EMPTY: never[] = [];
  const stable = <T,>(data: T) => () => ({ data, isLoading: false, isError: false });
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    ...actual,
    usePurchaseOrders: stable(hoisted.pos),
    useInventoryJobs: stable(EMPTY),
    useVendors: stable(EMPTY),
    useInventoryItems: stable(EMPTY),
    useCategories: stable(EMPTY),
    useBrands: stable(EMPTY),
    useLocations: stable(EMPTY),
    useCreatePO: mutation,
    useReceivePO: mutation,
  };
});

const { default: PurchaseOrdersPage } = await import('../PurchaseOrdersPage');

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

beforeEach(() => {
  vi.clearAllMocks();
});

function renderPage(path = '/inventory/purchase-orders') {
  return renderWithProviders(<PurchaseOrdersPage />, { initialEntries: [path] });
}

/** The kit StatCard is a button whose name is "<label> <value>"; the grid's sort
 *  headers are buttons too ("Ordered"), so tiles are picked by their slot. */
function statCard(label: string) {
  const card = screen
    .getAllByRole('button')
    .find((b) => b.getAttribute('data-slot') === 'stat-card' && b.textContent?.startsWith(label));
  if (!card) throw new Error(`no stat card labelled ${label}`);
  return card;
}

describe('purchase orders page — Open and History only (S2.2)', () => {
  it('has exactly two tabs and no Pre-PO / Show resolved', async () => {
    renderPage();
    await screen.findByText('PO-3001');

    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      expect.stringMatching(/^Open/),
      expect.stringMatching(/^History/),
    ]);
    expect(screen.queryByRole('tab', { name: /pre-po/i })).toBeNull();
    expect(screen.queryByText('Show resolved')).toBeNull();
  });

  it('Open holds drafts, ordered and partial; History holds received, closed and cancelled', async () => {
    renderPage();
    await screen.findByText('PO-3001');
    expect(screen.getByText('PO-3002')).toBeInTheDocument();
    expect(screen.getByText('PO-3003')).toBeInTheDocument();
    expect(screen.queryByText('PO-3004')).toBeNull();
    expect(screen.queryByText('PO-3006')).toBeNull();

    await userEvent.click(screen.getByRole('tab', { name: /History/ }));
    await screen.findByText('PO-3004');
    expect(screen.getByText('PO-3005')).toBeInTheDocument();
    expect(screen.getByText('PO-3006')).toBeInTheDocument();
    expect(screen.queryByText('PO-3001')).toBeNull();
  });

  it('a draft row prints no ordered date; an ordered row prints it', async () => {
    renderPage();
    const draftRow = (await screen.findByText('PO-3001')).closest('tr')!;
    const orderedRow = screen.getByText('PO-3002').closest('tr')!;
    expect(within(draftRow).getByText('Draft')).toBeInTheDocument();
    expect(within(draftRow).queryByText('Jul 1')).toBeNull();
    expect(within(orderedRow).getByText('Ordered')).toBeInTheDocument();
    expect(within(orderedRow).getByText('Jul 1')).toBeInTheDocument();
  });

  it('KPI tiles read Drafts / Ordered / Late / Arriving this week, and Drafts filters the Open grid', async () => {
    renderPage();
    await screen.findByText('PO-3001');

    expect(statCard('Drafts')).toHaveTextContent('1');
    expect(statCard('Ordered')).toHaveTextContent('1');
    // Expected 2026-07-20 is in the past for the ordered + partial rows; the
    // draft and the History rows never count.
    expect(statCard('Late')).toHaveTextContent('2');
    expect(statCard('Arriving this week')).toHaveTextContent('0');
    expect(screen.queryByText('Pre-PO pending')).toBeNull();
    expect(screen.queryByText('Open POs')).toBeNull();

    await userEvent.click(statCard('Drafts'));
    expect(screen.getByText('PO-3001')).toBeInTheDocument();
    expect(screen.queryByText('PO-3002')).toBeNull();
  });

  it('deep links: ?status=draft lands on Open, ?status=cancelled on History', async () => {
    const { unmount } = renderPage('/inventory/purchase-orders?status=draft');
    expect(await screen.findByText('PO-3001')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Open/ })).toHaveAttribute('aria-selected', 'true');
    unmount();

    renderPage('/inventory/purchase-orders?status=cancelled');
    expect(await screen.findByText('PO-3006')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /History/ })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('purchase orders page — honest History (S2.2)', () => {
  it('prints the real received-on date and the server lead time; blank when missing', async () => {
    renderPage();
    await screen.findByText('PO-3001');
    await userEvent.click(screen.getByRole('tab', { name: /History/ }));

    const received = (await screen.findByText('PO-3004')).closest('tr')!;
    expect(within(received).getByText('Jul 12')).toBeInTheDocument();
    expect(within(received).getByText('11d')).toBeInTheDocument();
    expect(within(received).queryByText('Jul 20')).toBeNull(); // never the expected date

    const cancelled = screen.getByText('PO-3006').closest('tr')!;
    expect(within(cancelled).getByText('Cancelled')).toBeInTheDocument();
    expect(within(cancelled).getAllByText('—')).toHaveLength(2); // Received on + Lead time
  });

  it('the History CSV carries Received on and Lead time (days) from the same fields', async () => {
    renderPage();
    await screen.findByText('PO-3001');
    await userEvent.click(screen.getByRole('tab', { name: /History/ }));
    await screen.findByText('PO-3004');

    await userEvent.click(screen.getByRole('button', { name: /^export$/i }));

    await waitFor(() => expect(hoisted.downloadCSV).toHaveBeenCalled());
    const rows = hoisted.toCSV.mock.calls[0]![0] as Record<string, unknown>[];
    const byPo = Object.fromEntries(rows.map((r) => [r['PO #'], r]));
    expect(byPo['PO-3004']).toMatchObject({ 'Received on': 'Jul 12', 'Lead time (days)': 11 });
    expect(byPo['PO-3006']).toMatchObject({ 'Received on': '', 'Lead time (days)': '' });
  });
});
