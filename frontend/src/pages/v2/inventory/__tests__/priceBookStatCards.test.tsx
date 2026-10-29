/**
 * The Items tab's KPI tile row - which no longer exists.
 *
 * It lost its four tiles one ruling at a time. SRVW-223: "With Photo" counted
 * how many catalog items had a product photo, which is not a number anyone runs
 * the business on. SRVW-255: "In Catalog" / "Hidden from Catalog" duplicated the
 * Visibility dropdown in the toolbar below - one state (`filterVisibility`), two
 * controls, two vocabularies; the dropdown survived. And now "No Price Set",
 * which counted and filtered for items carrying neither price: `unit_price` is
 * `Decimal(12,2)` NOT NULL with no default and the create schema refuses a body
 * carrying neither price column, so an unpriced item is a state no row can reach
 * and $0.00 IS a price (Ran, 2026-09-18). The tile therefore reported 0 on a
 * healthy org, and its truthiness test would only ever have miscounted a genuine
 * zero. A control that filters for an unreachable state is dead UI, so the tile
 * and the whole row went with it.
 *
 * What this file pins now: no tile renders, the row itself is not left behind as
 * an empty grid, the Visibility dropdown is still the one visibility control, and
 * a $0.00 item is an ordinary priced row on the grid rather than something a
 * filter hides.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';

import { renderWithProviders } from '@/__tests__/helpers';

const hoisted = vi.hoisted(() => {
  function item(n: number, sku: string, name: string, opts: { photoUrl?: string; sellPrice?: number } = {}) {
    return {
      id: `d000000${n}-0000-0000-0000-000000000001`,
      sku,
      name,
      category: 'Cylinders',
      trade: 'locksmith' as const,
      kind: 'material' as const,
      uom: 'ea',
      unitCost: 8,
      sellPrice: opts.sellPrice,
      serialized: false,
      hazmat: false,
      status: 'active' as const,
      vendor: 'Acme Supply',
      stock: [],
      updatedAt: '2026-07-01T00:00:00.000Z',
      type: 'MATERIAL' as const,
      taxable: true,
      photoUrl: opts.photoUrl,
    };
  }
  return {
    items: [
      item(1, 'CYL-01', 'Mortise Cylinder', { photoUrl: 'https://example.com/a.jpg', sellPrice: 24 }),
      // A genuine $0.00 - the only kind of row the retired tile ever caught.
      item(2, 'CYL-02', 'Rim Cylinder', { sellPrice: 0 }),
    ],
  };
});

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
  const utils = renderWithProviders(<PriceBookPage />, { initialEntries: ['/inventory/price-book'] });
  expect(await screen.findByText('Mortise Cylinder')).toBeInTheDocument();
  return utils;
}

describe('price book Items tab KPI tiles', () => {
  it('does not render a With Photo tile', async () => {
    await renderPriceBook();

    expect(screen.queryByText('With Photo')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /product photo/i }),
    ).not.toBeInTheDocument();
  });

  it('renders no tile at all, and no empty tile row left behind', async () => {
    const { container } = await renderPriceBook();

    expect(screen.queryByText('In Catalog')).not.toBeInTheDocument();
    expect(screen.queryByText('Hidden from Catalog')).not.toBeInTheDocument();
    expect(screen.queryByText('No Price Set')).not.toBeInTheDocument();
    // The row itself, by the kit marker it would leave in the DOM - a tile
    // removed but its grid wrapper kept would pass the three queries above and
    // still hold a gap open on the page.
    expect(container.querySelector('[data-slot="stat-card-group"]')).toBeNull();
    expect(container.querySelector('[data-slot="stat-card"]')).toBeNull();
  });

  it('has no control that filters the grid for an unpriced item', async () => {
    await renderPriceBook();

    // By the tile's own accessible name. (A blanket `{ pressed: true }` sweep
    // would be wrong here: the grid's per-row Visibility toggle is a legitimate
    // aria-pressed button and has nothing to do with this row.)
    expect(
      screen.queryByRole('button', { name: /missing both list price and sell price/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /no price/i })).not.toBeInTheDocument();
  });

  it('the Visibility filter is a dropdown, not a pair of tiles', async () => {
    await renderPriceBook();

    expect(screen.getByRole('combobox', { name: /visibility/i })).toBeInTheDocument();
  });

  it('leaves a $0.00 item on the grid as an ordinary priced row', async () => {
    await renderPriceBook();

    // Both rows are showing, and the zero prints as a price rather than as an
    // absence the retired tile would have collected.
    expect(screen.getByText('Rim Cylinder')).toBeInTheDocument();
    const zeroRow = screen.getByText('CYL-02').closest('tr');
    expect(zeroRow).not.toBeNull();
    expect(within(zeroRow!).getByText('$0.00')).toBeInTheDocument();
    expect(screen.getByText('2 of 2 items')).toBeInTheDocument();
  });
});
