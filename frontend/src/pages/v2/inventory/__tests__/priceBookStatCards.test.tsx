/**
 * SRVW-223 - the Items tab's KPI tile row.
 *
 * "With Photo" counted how many catalog items had a product photo, which is
 * not a number anyone runs the business on. This guards its removal: the tile
 * no longer renders.
 *
 * SRVW-255 - "In Catalog" / "Hidden from Catalog" duplicated the Visibility
 * dropdown in the toolbar below - one state (`filterVisibility`), two
 * controls, two vocabularies. The dropdown survives; the two tiles are gone.
 * "No Price Set" is the only tile left and still filters the grid on its own.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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
      item(2, 'CYL-02', 'Rim Cylinder', {}),
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
  renderWithProviders(<PriceBookPage />, { initialEntries: ['/inventory/price-book'] });
  expect(await screen.findByText('Mortise Cylinder')).toBeInTheDocument();
}

describe('price book Items tab KPI tiles', () => {
  it('does not render a With Photo tile', async () => {
    await renderPriceBook();

    expect(screen.queryByText('With Photo')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /product photo/i }),
    ).not.toBeInTheDocument();
  });

  it('renders exactly the one remaining tile - the catalog chips are gone', async () => {
    await renderPriceBook();

    expect(screen.queryByText('In Catalog')).not.toBeInTheDocument();
    expect(screen.queryByText('Hidden from Catalog')).not.toBeInTheDocument();
    expect(screen.getByText('No Price Set')).toBeInTheDocument();
  });

  it('the Visibility filter is a dropdown, not a second pair of tiles', async () => {
    await renderPriceBook();

    expect(screen.getByRole('combobox', { name: /visibility/i })).toBeInTheDocument();
  });

  it('the No Price Set tile still filters the grid and clears the Visibility filter', async () => {
    await renderPriceBook();

    const noPriceTile = screen.getByRole('button', { name: /missing both list price and sell price/i });
    await userEvent.click(noPriceTile);

    await waitFor(() => {
      expect(screen.queryByText('Mortise Cylinder')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Rim Cylinder')).toBeInTheDocument();
    expect(noPriceTile).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('combobox', { name: /visibility/i })).toHaveTextContent('All visibility');
  });
});
