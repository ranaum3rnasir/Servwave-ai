/**
 * Row selection and Export selected on the Spend Analytics leaderboard.
 *
 * DIVERGENCE FROM THE BRIEF: this page had NO CSV export in either layer, so
 * the export is new. It is written once and BOTH controls use it - the panel's
 * Export (the whole ranked, filtered leaderboard) and Export selected (the
 * ticked rows).
 *
 * There is no `/api/inventory/vendors/bulk-*` endpoint, so no write-shaped bulk
 * action (bulk archive, bulk re-category) is offered. Spend is a DERIVED view
 * anyway - `computeAllVendorSpend` over the PO list - so a "bulk edit" here
 * would have to write to vendors, not to the numbers on screen.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/__tests__/helpers';

const hoisted = vi.hoisted(() => {
  function vendor(n: number, name: string, category: string) {
    return {
      id: `e000000${n}-0000-0000-0000-000000000001`,
      name,
      category,
      paymentTerms: 'Net 30',
      leadTimeDays: 3,
      transmitMethod: 'email' as const,
      contactPersonName: `Rep ${n}`,
      status: 'active' as const,
    };
  }
  function po(n: number, vendorName: string, qty: number) {
    return {
      id: `f000000${n}-0000-0000-0000-000000000001`,
      poNumber: `PO-200${n}`,
      vendor: vendorName,
      status: 'received' as const,
      orderedAt: new Date().toISOString(),
      lines: [
        { itemSku: 'CAP-01', itemName: 'Run Capacitor', uom: 'ea', qtyOrdered: qty, qtyReceived: qty, unitCost: 10 },
      ],
    };
  }
  return {
    toCSV: vi.fn((_rows: Record<string, unknown>[]) => 'csv-content'),
    downloadCSV: vi.fn(),
    vendors: [vendor(1, 'Acme Supply', 'HVAC'), vendor(2, 'Border Parts', 'Electrical')],
    pos: [po(1, 'Acme Supply', 10), po(2, 'Border Parts', 4)],
    items: [{
      id: 'b0000001-0000-0000-0000-000000000001',
      sku: 'CAP-01', name: 'Run Capacitor', category: 'Capacitors',
      trade: 'hvac' as const, kind: 'material' as const, uom: 'ea',
      unitCost: 10, sellPrice: 25, serialized: false, hazmat: false,
      status: 'active' as const, vendor: 'Acme Supply', stock: [],
      updatedAt: '2026-07-01T00:00:00.000Z',
    }],
  };
});

vi.mock('@/lib/inventory/csv', () => ({
  toCSV: hoisted.toCSV,
  downloadCSV: hoisted.downloadCSV,
}));

/**
 * Seam-mocked with already-resolved stable data, the pattern
 * `src/__tests__/purchase-orders-deeplink.test.tsx` established. This page
 * seeds `vendors` with `const { data: seedVendors = [] } = useVendors()` plus
 * an unguarded `useEffect(() => setVendors(seedVendors), [seedVendors])`, so a
 * pending query mints a fresh `[]` each render and the seed effect re-fires
 * forever - which hangs jsdom rather than failing.
 */
vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  type Api = typeof import('@/lib/api/inventory');
  const stable = <T,>(data: T) => () => ({ data, isLoading: false, isError: false });
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    ...actual,
    useVendors: stable(hoisted.vendors as unknown as ReturnType<Api['useVendors']>['data']),
    usePurchaseOrders: stable(hoisted.pos as unknown as ReturnType<Api['usePurchaseOrders']>['data']),
    useInventoryItems: stable(hoisted.items as unknown as ReturnType<Api['useInventoryItems']>['data']),
    useUpsertVendor: mutation,
    useDeleteVendor: mutation,
  };
});

const { VendorsPage } = await import('../VendorsPage');

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

beforeEach(() => {
  vi.clearAllMocks();
});

async function renderAnalytics() {
  renderWithProviders(<VendorsPage />, { initialEntries: ['/inventory/vendors'] });
  await userEvent.click(await screen.findByRole('tab', { name: /Spend Analytics/ }));
  expect(await screen.findByText('Acme Supply')).toBeInTheDocument();
}

describe('vendor spend bulk selection', () => {
  it('lifts a ticked row into the bulk action bar', async () => {
    await renderAnalytics();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Acme Supply' }));

    const bar = await screen.findByRole('status');
    expect(within(bar).getByText('1 vendor selected')).toBeInTheDocument();
  });

  it('exports exactly the selected rows, not all of them', async () => {
    await renderAnalytics();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Border Parts' }));
    const bar = await screen.findByRole('status');
    await userEvent.click(within(bar).getByRole('button', { name: /export selected/i }));

    await waitFor(() => expect(hoisted.downloadCSV).toHaveBeenCalled());
    const rows = hoisted.toCSV.mock.calls[0]![0] as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ Vendor: 'Border Parts', Category: 'Electrical' });
    expect(hoisted.downloadCSV).toHaveBeenCalledWith(
      'csv-content',
      expect.stringMatching(/^vendor-spend-selected-\d{4}-\d{2}-\d{2}\.csv$/),
    );
  });

  it('the panel Export exports the whole ranked leaderboard', async () => {
    await renderAnalytics();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Border Parts' }));
    await screen.findByRole('status');

    await userEvent.click(screen.getByRole('button', { name: /^export$/i }));

    await waitFor(() => expect(hoisted.downloadCSV).toHaveBeenCalled());
    const rows = hoisted.toCSV.mock.calls[0]![0] as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(hoisted.downloadCSV).toHaveBeenCalledWith(
      'csv-content',
      expect.stringMatching(/^vendor-spend-\d{4}-\d{2}-\d{2}\.csv$/),
    );
  });

  it('drops the selection when the filter scope moves', async () => {
    await renderAnalytics();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Acme Supply' }));
    await screen.findByRole('status');

    await userEvent.type(screen.getByPlaceholderText('Search vendors…'), 'Border');

    await waitFor(() => {
      expect(screen.queryByText('1 vendor selected')).not.toBeInTheDocument();
    });
  });
});
