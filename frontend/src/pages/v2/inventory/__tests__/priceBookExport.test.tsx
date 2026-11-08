/**
 * The Price Book Items grid's CSV export.
 *
 * DIVERGENCE FROM THE BRIEF, recorded here because it changes what "reuse the
 * existing exporter" can mean: this page had NO CSV export of any kind, in
 * either layer. So the export is new. It goes through the shared
 * `toCSV`/`downloadCSV` writer, which `src/__tests__/csv-export-guard.test.ts`
 * requires of every exporter.
 *
 * The grid used to carry a row-selection column feeding an "Export selected"
 * bulk bar. Both are gone - there is no other bulk action on this page, so the
 * tick column cost a column on every row to duplicate a control the toolbar
 * already has. The last case below is the regression guard for that.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/__tests__/helpers';

const hoisted = vi.hoisted(() => {
  function item(n: number, sku: string, name: string) {
    return {
      id: `d000000${n}-0000-0000-0000-000000000001`,
      sku,
      name,
      category: 'Cylinders',
      trade: 'locksmith' as const,
      kind: 'material' as const,
      uom: 'ea',
      unitCost: 8,
      sellPrice: 24,
      listPrice: 30,
      serialized: false,
      hazmat: false,
      status: 'active' as const,
      vendor: 'Acme Supply',
      stock: [],
      updatedAt: '2026-07-01T00:00:00.000Z',
      type: 'MATERIAL' as const,
      taxable: true,
    };
  }
  return {
    toCSV: vi.fn((_rows: Record<string, unknown>[]) => 'csv-content'),
    downloadCSV: vi.fn(),
    // Built inside `vi.hoisted` so the seam-mock factory below closes over ONE
    // stable array - a fresh array per render is the exact seed loop this file
    // exists to avoid.
    items: [item(1, 'CYL-01', 'Mortise Cylinder'), item(2, 'CYL-02', 'Rim Cylinder')],
  };
});

vi.mock('@/lib/inventory/csv', () => ({
  toCSV: hoisted.toCSV,
  downloadCSV: hoisted.downloadCSV,
}));

/**
 * The inventory SEAM is mocked directly, with already-resolved stable data -
 * the pattern `src/__tests__/purchase-orders-deeplink.test.tsx` established and
 * `price-book-persistence.test.tsx` follows.
 *
 * Mocking axios instead hangs jsdom outright (verified on this branch: the
 * worker is killed after ~100s with no test output). This page seeds five local
 * mirrors with `const { data: x = [] } = useX()` plus an unguarded
 * `useEffect(() => setX(x), [x])`, so while a query is pending the `= []`
 * default mints a fresh array every render and the seed effect re-fires
 * forever. Stable references from the first render sidestep it without
 * touching product code.
 */
vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const EMPTY: never[] = [];
  const stable = <T,>(data: T) => () => ({ data, isLoading: false, isError: false });
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    ...actual,
    useInventoryItems: stable(hoisted.items as unknown as import('@/lib/api/inventory').Item[]),
    useBrands: stable(EMPTY),
    useItemGroups: stable(EMPTY),
    useCategories: stable(EMPTY),
    useVendors: stable(EMPTY),
    useLocations: stable(EMPTY),
    useUpsertItem: mutation,
    useUpsertBrand: mutation,
    useUpsertItemGroup: mutation,
    useUpsertCategory: mutation,
    useUpsertVendor: mutation,
    useDeleteBrand: mutation,
    useDeleteItemGroup: mutation,
    useDeleteCategory: mutation,
    useSetThresholds: mutation,
  };
});

// Imported AFTER the seam mock is declared; vi.mock is hoisted, so the page
// picks up the stubs.
const { PriceBookPage } = await import('../PriceBookPage');

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

beforeEach(() => {
  vi.clearAllMocks();
});

async function renderPriceBook() {
  renderWithProviders(<PriceBookPage />, { initialEntries: ['/inventory/price-book'] });
  expect(await screen.findByText('Mortise Cylinder')).toBeInTheDocument();
}

describe('price book export', () => {
  it('the toolbar Export exports the whole filtered set', async () => {
    await renderPriceBook();

    await userEvent.click(screen.getByRole('button', { name: /^export$/i }));

    await waitFor(() => expect(hoisted.downloadCSV).toHaveBeenCalled());
    const rows = hoisted.toCSV.mock.calls[0]![0] as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ SKU: 'CYL-01', Item: 'Mortise Cylinder' });
    expect(hoisted.downloadCSV).toHaveBeenCalledWith(
      'csv-content',
      expect.stringMatching(/^price-book-\d{4}-\d{2}-\d{2}\.csv$/),
    );
  });

  it('exports only what the active filter leaves on screen', async () => {
    await renderPriceBook();

    await userEvent.type(screen.getByPlaceholderText('Search price book…'), 'Rim');
    await waitFor(() => {
      expect(screen.queryByText('Mortise Cylinder')).not.toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: /^export$/i }));

    await waitFor(() => expect(hoisted.downloadCSV).toHaveBeenCalled());
    const rows = hoisted.toCSV.mock.calls[0]![0] as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ SKU: 'CYL-02', Item: 'Rim Cylinder' });
  });

  it('has no row-selection column', async () => {
    await renderPriceBook();

    expect(screen.queryByRole('checkbox', { name: 'Select CYL-01' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /select all/i })).not.toBeInTheDocument();
  });
});
