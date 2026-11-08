/**
 * Purchasing Audit Verdict PR 1 (S1.1): the Purchase Orders page stops
 * implying that ServWave sends POs. Open-tab row actions keep Preview and
 * Receive but lose Email; the History grid loses the Variance column and shows
 * "—" for "Received on" when the PO carries no receipt stamp (a closed-without-
 * receipt or cancelled PO; the real `receivedAt` prints since PR 2); the CSV
 * keeps the "Received on" header and emits an empty cell for those; header and
 * empty-state copy speak of receipt, not sending.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/__tests__/helpers';

const hoisted = vi.hoisted(() => {
  function po(n: number, status: 'draft' | 'ordered' | 'received', vendor: string) {
    return {
      id: `f000000${n}-0000-0000-0000-000000000001`,
      poNumber: `PO-200${n}`,
      vendor,
      status,
      orderedAt: '2026-07-01T00:00:00.000Z',
      expectedDate: '2026-07-20T00:00:00.000Z',
      lines: [
        { itemSku: 'CAP-01', itemName: 'Run Capacitor', uom: 'ea', qtyOrdered: 4, qtyReceived: status === 'received' ? 4 : 0, unitCost: 12.5 },
      ],
    };
  }
  return {
    toCSV: vi.fn((_rows: Record<string, unknown>[]) => 'csv-content'),
    downloadCSV: vi.fn(),
    pos: [
      po(1, 'ordered', 'Acme Supply'),
      po(3, 'received', 'Acme Supply'),
      po(4, 'draft', 'Border Parts'),
    ],
    none: [] as never[],
  };
});

vi.mock('@/lib/inventory/csv', () => ({
  toCSV: hoisted.toCSV,
  downloadCSV: hoisted.downloadCSV,
}));

// Seam mocked with stable, already-resolved data (see poBulkExport.test.tsx for
// why axios-level mocking hangs this page's seed effects).
let posForRender: unknown = hoisted.pos;
vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const EMPTY: never[] = [];
  const stable = <T,>(data: T) => () => ({ data, isLoading: false, isError: false });
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    ...actual,
    usePurchaseOrders: () => ({ data: posForRender as import('@/lib/api/inventory').PurchaseOrder[], isLoading: false, isError: false }),
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
  posForRender = hoisted.pos;
});

describe('purchase orders page — nothing here sends (S1.1)', () => {
  it('Open-tab row actions offer Preview and Receive, never Email', async () => {
    renderWithProviders(<PurchaseOrdersPage />, { initialEntries: ['/inventory/purchase-orders'] });
    expect(await screen.findByText('PO-2001')).toBeInTheDocument();

    // Two Open rows (an ordered PO and a draft): both preview, only the
    // ordered one receives - a draft has nothing to receive against yet.
    expect(screen.getAllByRole('button', { name: 'Preview PO' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Receive items' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /email|send/i })).toBeNull();
  });

  it('header copy speaks of receipt, not of sending', async () => {
    renderWithProviders(<PurchaseOrdersPage />, { initialEntries: ['/inventory/purchase-orders'] });
    await screen.findByText('PO-2001');

    expect(screen.getByText('Track every order from draft to receipt.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/you've sent|open orders with vendors|send to vendor/i);
  });

  it('the Open empty state has no sending language', async () => {
    posForRender = hoisted.none;
    renderWithProviders(<PurchaseOrdersPage />, { initialEntries: ['/inventory/purchase-orders'] });

    expect(await screen.findByText('Nothing open. Every order has been received or closed.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/sent/i);
  });

  it('History has no Variance column and shows "—" for Received on', async () => {
    renderWithProviders(<PurchaseOrdersPage />, { initialEntries: ['/inventory/purchase-orders'] });
    await screen.findByText('PO-2001');
    await userEvent.click(screen.getByRole('tab', { name: /History/ }));
    const row = (await screen.findByText('PO-2003')).closest('tr')!;

    expect(screen.queryByText('Variance')).toBeNull();
    expect(screen.getByText('Received on')).toBeInTheDocument();
    // No receivedAt on the fixture: Received on AND Lead time print the placeholder;
    // the fake expected-date proxy is gone.
    expect(within(row).getAllByText('—')).toHaveLength(2);
    expect(within(row).queryByText('Jul 20')).toBeNull();
  });

  it('the History CSV keeps the "Received on" header and emits an empty value', async () => {
    renderWithProviders(<PurchaseOrdersPage />, { initialEntries: ['/inventory/purchase-orders'] });
    await screen.findByText('PO-2001');
    await userEvent.click(screen.getByRole('tab', { name: /History/ }));
    await screen.findByText('PO-2003');

    await userEvent.click(screen.getByRole('button', { name: /^export$/i }));

    await waitFor(() => expect(hoisted.downloadCSV).toHaveBeenCalled());
    const rows = hoisted.toCSV.mock.calls[0]![0] as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveProperty('Received on', '');
    expect(rows[0]).toMatchObject({ 'PO #': 'PO-2003' });
  });
});
