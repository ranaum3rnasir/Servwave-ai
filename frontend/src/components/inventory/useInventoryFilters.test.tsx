import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Item } from '@/lib/api/inventory';
import { emptyFilters, type Filters } from '@/components/inventory/FiltersPopover';
import { useInventoryFilters, useInventoryStats } from './useInventoryFilters';

// Minimal Item factory — only the fields the filter/stats chain reads.
function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: 'i-default',
    sku: 'SKU-0',
    name: 'Default Item',
    category: 'General',
    trade: 'door',
    kind: 'material',
    uom: 'ea',
    unitCost: 10,
    sellPrice: 20,
    serialized: false,
    hazmat: false,
    status: 'active',
    vendor: 'Acme',
    stock: [{ locationId: 'loc-1', onHand: 5, min: 2 }],
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

const inStockMaterial = makeItem({
  id: 'm-in',
  sku: 'BOLT-1',
  name: 'Deadbolt',
  category: 'Locks',
  vendor: 'LockCo',
  mpn: 'MPN-100',
  upc: 'UPC-999',
  kind: 'material',
  stock: [{ locationId: 'loc-1', onHand: 8, min: 2 }],
});
const lowStockMaterial = makeItem({
  id: 'm-low',
  sku: 'HINGE-2',
  name: 'Hinge',
  category: 'Hardware',
  vendor: 'HingeCo',
  kind: 'material',
  stock: [{ locationId: 'loc-1', onHand: 1, min: 5 }],
});
const serviceItem = makeItem({
  id: 'l-1',
  sku: 'LABOR-1',
  name: 'Install Labor',
  category: 'Labor',
  kind: 'service',
  stock: [],
});
// Was kind: 'bundle'. Bundle and fee are retired; this fixture stays because
// the grid used to drop it, and the assertion below is what stops that
// regression returning under a different kind name.
const kitItem = makeItem({
  id: 'b-1',
  sku: 'BUNDLE-1',
  name: 'Door Kit',
  category: 'Kits',
  kind: 'service',
  stock: [],
});
const backorderMaterial = makeItem({
  id: 'm-back',
  sku: 'BACK-1',
  name: 'Backordered Lock',
  category: 'Locks',
  kind: 'material',
  status: 'on_backorder',
  stock: [{ locationId: 'loc-1', onHand: 0, min: 3 }],
});

const allItems = [inStockMaterial, lowStockMaterial, serviceItem, kitItem, backorderMaterial];

describe('useInventoryFilters', () => {
  it('hides no item on the basis of its kind', () => {
    // This assertion is inverted from what it used to be. The old allowlist -
    // material|labor|service - dropped every bundle and fee item, which the
    // Add Item dialog happily let you create, so those items saved and then
    // could not be found. With kind narrowed to material|service the grid shows
    // everything the org owns.
    const { result } = renderHook(() =>
      useInventoryFilters({ allItems, search: '', activeLoc: 'all', filters: emptyFilters }),
    );
    const ids = result.current.filteredItems.map((i) => i.id);
    expect(ids).toEqual(allItems.map((i) => i.id));
  });

  it('search matches against sku/name/category/vendor/mpn/upc', () => {
    const bySku = renderHook(() =>
      useInventoryFilters({ allItems, search: 'BOLT-1', activeLoc: 'all', filters: emptyFilters }),
    );
    expect(bySku.result.current.filteredItems.map((i) => i.id)).toEqual(['m-in']);

    const byVendor = renderHook(() =>
      useInventoryFilters({ allItems, search: 'hingeco', activeLoc: 'all', filters: emptyFilters }),
    );
    expect(byVendor.result.current.filteredItems.map((i) => i.id)).toEqual(['m-low']);

    const byMpn = renderHook(() =>
      useInventoryFilters({ allItems, search: 'mpn-100', activeLoc: 'all', filters: emptyFilters }),
    );
    expect(byMpn.result.current.filteredItems.map((i) => i.id)).toEqual(['m-in']);

    const byUpc = renderHook(() =>
      useInventoryFilters({ allItems, search: 'UPC-999', activeLoc: 'all', filters: emptyFilters }),
    );
    expect(byUpc.result.current.filteredItems.map((i) => i.id)).toEqual(['m-in']);
  });

  it('re-filters when the finish map resolves after the search was typed', () => {
    // The finishes query is independent of the four inputs the operator touches,
    // so on a slow response the map lands AFTER the last keystroke. `search` and
    // `filters` are useState values with stable references, and `allItems` and
    // `activeLoc` do not move either - so this rerender changes ONE thing, which
    // is exactly the case that used to leave the memo serving its stale result.
    const withFinish = makeItem({
      id: 'm-finish',
      sku: 'PULL-9',
      name: 'Cabinet Pull',
      finishId: 'fin-1',
    });
    const items = [...allItems, withFinish];
    const filters: Filters = { ...emptyFilters };

    // Render 1 mirrors the page before `useFinishes` resolves: an empty Map,
    // which is what the page's own memo builds from `data ?? []`.
    const { result, rerender } = renderHook(
      ({ finishNameById }: { finishNameById: Map<string, string> }) =>
        useInventoryFilters({
          allItems: items,
          search: 'satin',
          activeLoc: 'all',
          filters,
          finishNameById,
        }),
      { initialProps: { finishNameById: new Map<string, string>() } },
    );
    expect(result.current.filteredItems).toEqual([]);

    rerender({ finishNameById: new Map([['fin-1', 'Satin Chrome']]) });
    expect(result.current.filteredItems.map((i) => i.id)).toEqual(['m-finish']);
  });

  it('per-location stock-state branch (activeLoc set) keeps low_stock items at that location', () => {
    const filters: Filters = { ...emptyFilters, stockStates: ['low_stock'] };
    const { result } = renderHook(() =>
      useInventoryFilters({ allItems, search: '', activeLoc: 'loc-1', filters }),
    );
    const ids = result.current.filteredItems.map((i) => i.id);
    expect(ids).toContain('m-low'); // onHand 1 < min 5 at loc-1
    expect(ids).not.toContain('m-in'); // onHand 8 >= min 2, not low
  });

  it('cross-location stock-state branch (activeLoc all) keeps backorder items', () => {
    const filters: Filters = { ...emptyFilters, stockStates: ['backorder'] };
    const { result } = renderHook(() =>
      useInventoryFilters({ allItems, search: '', activeLoc: 'all', filters }),
    );
    const ids = result.current.filteredItems.map((i) => i.id);
    expect(ids).toEqual(['m-back']);
  });
});

describe('useInventoryStats', () => {
  it('computes totalSkus/lowStock/backorder/value over material items only', () => {
    const { result } = renderHook(() => useInventoryStats(allItems));
    // material items: m-in, m-low, m-back (labor + bundle excluded)
    expect(result.current.totalSkus).toBe(3);
    // low stock: m-low (1<5) and m-back (0<3)
    expect(result.current.lowStock).toBe(2);
    // backorder: m-back
    expect(result.current.backorder).toBe(1);
    // value: m-in 8*10=80, m-low 1*10=10, m-back 0*10=0 → 90
    expect(result.current.value).toBe(90);
  });
});
