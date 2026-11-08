/**
 * Row selection and Export selected on BOTH purchase-order grids.
 *
 * Open and History are both PurchaseOrder but print different columns, so
 * each gets its own selection scope and its own export mapping. One shared
 * mapping would have to null out half its columns per tab. (The Pre-PO grid
 * left with the estimate-reservation queue - Purchasing Audit Verdict PR 2.)
 *
 * DIVERGENCE FROM THE BRIEF: this page had NO CSV export in either layer, so
 * the export is new. It is written once per tab and BOTH controls use it - the
 * toolbar Export (whole filtered tab) and Export selected (the ticked rows).
 *
 * There is no `/api/inventory/purchase-orders/bulk-*` endpoint of any kind, so
 * no write-shaped bulk action (bulk send, bulk receive, bulk close) is offered.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/__tests__/helpers';

const hoisted = vi.hoisted(() => {
  function po(n: number, status: 'draft' | 'ordered' | 'received', vendor: string) {
    return {
      id: `f000000${n}-0000-0000-0000-000000000001`,
      poNumber: `PO-100${n}`,
      vendor,
      status,
      orderedAt: '2026-07-01T00:00:00.000Z',
      expectedDate: '2026-07-20T00:00:00.000Z',
      lines: [
        { itemSku: 'CAP-01', itemName: 'Run Capacitor', uom: 'ea', qtyOrdered: 4, qtyReceived: 0, unitCost: 12.5 },
      ],
    };
  }
  return {
    toCSV: vi.fn((_rows: Record<string, unknown>[]) => 'csv-content'),
    downloadCSV: vi.fn(),
    // One stable array, built inside vi.hoisted so the seam-mock factory below
    // closes over the same reference every render (see the seed-loop note).
    pos: [
      po(1, 'ordered', 'Acme Supply'),
      po(2, 'ordered', 'Border Parts'),
      po(3, 'received', 'Acme Supply'),
      po(4, 'draft', 'Border Parts'),
    ],
  };
});

vi.mock('@/lib/inventory/csv', () => ({
  toCSV: hoisted.toCSV,
  downloadCSV: hoisted.downloadCSV,
}));

/**
 * The inventory SEAM is mocked directly with already-resolved stable data -
 * the pattern `src/__tests__/purchase-orders-deeplink.test.tsx` established for
 * this exact page. Mocking axios instead leaves the hooks pending for the first
 * renders, and this page's `const { data = [] } = useX()` defaults mint a fresh
 * `[]` each render, re-firing its `setX(seedX)` seed effects forever and
 * hanging jsdom (verified on this branch: the worker is killed with no output).
 */
vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const EMPTY: never[] = [];
  const stable = <T,>(data: T) => () => ({ data, isLoading: false, isError: false });
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    ...actual,
    usePurchaseOrders: stable(hoisted.pos as unknown as import('@/lib/api/inventory').PurchaseOrder[]),
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

async function renderPOs() {
  renderWithProviders(<PurchaseOrdersPage />, { initialEntries: ['/inventory/purchase-orders'] });
  // Open is the default landing tab.
  expect(await screen.findByText('PO-1001')).toBeInTheDocument();
}

describe('open purchase orders', () => {
  it('lifts a ticked row into the bulk action bar', async () => {
    await renderPOs();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select PO-1001' }));

    const bar = await screen.findByRole('status');
    expect(within(bar).getByText('1 purchase order selected')).toBeInTheDocument();
  });

  it('exports exactly the selected rows, not all of them', async () => {
    await renderPOs();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select PO-1002' }));
    const bar = await screen.findByRole('status');
    await userEvent.click(within(bar).getByRole('button', { name: /export selected/i }));

    await waitFor(() => expect(hoisted.downloadCSV).toHaveBeenCalled());
    const rows = hoisted.toCSV.mock.calls[0]![0] as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ 'PO #': 'PO-1002', Vendor: 'Border Parts' });
    expect(hoisted.downloadCSV).toHaveBeenCalledWith(
      'csv-content',
      expect.stringMatching(/^purchase-orders-open-selected-\d{4}-\d{2}-\d{2}\.csv$/),
    );
  });

  it('the toolbar Export exports the whole filtered tab', async () => {
    await renderPOs();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select PO-1002' }));
    await screen.findByRole('status');

    await userEvent.click(screen.getByRole('button', { name: /^export$/i }));

    await waitFor(() => expect(hoisted.downloadCSV).toHaveBeenCalled());
    const rows = hoisted.toCSV.mock.calls[0]![0] as Record<string, unknown>[];
    // Two ordered + the draft: Open = draft + ordered + partial since PR 2.
    expect(rows).toHaveLength(3);
    expect(hoisted.downloadCSV).toHaveBeenCalledWith(
      'csv-content',
      expect.stringMatching(/^purchase-orders-open-\d{4}-\d{2}-\d{2}\.csv$/),
    );
  });

  it('drops the selection when the filter scope moves', async () => {
    await renderPOs();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select PO-1001' }));
    await screen.findByRole('status');

    await userEvent.type(screen.getByPlaceholderText('Search purchase orders…'), 'Border');

    await waitFor(() => {
      expect(screen.queryByText('1 purchase order selected')).not.toBeInTheDocument();
    });
  });
});

describe('purchase order history', () => {
  it('selects and exports only the ticked history row', async () => {
    await renderPOs();
    await userEvent.click(screen.getByRole('tab', { name: /History/ }));

    await userEvent.click(await screen.findByRole('checkbox', { name: 'Select PO-1003' }));
    const bar = await screen.findByRole('status');
    await userEvent.click(within(bar).getByRole('button', { name: /export selected/i }));

    await waitFor(() => expect(hoisted.downloadCSV).toHaveBeenCalled());
    const rows = hoisted.toCSV.mock.calls[0]![0] as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ 'PO #': 'PO-1003' });
    expect(hoisted.downloadCSV).toHaveBeenCalledWith(
      'csv-content',
      expect.stringMatching(/^purchase-orders-history-selected-\d{4}-\d{2}-\d{2}\.csv$/),
    );
  });
});
