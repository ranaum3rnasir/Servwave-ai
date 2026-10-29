import type { ItemKind, Trade } from '@/lib/api/inventory';

/**
 * The inventory list's filter model: what the Filter popover and the category selector write and
 * `useInventoryFilters` reads. The control that edits it is the shared list filter
 * (`pages/v2/_shared/filterPopover`), through `pages/v2/inventory/components/inventoryFilter`.
 */

export type StockState = 'in_stock' | 'low_stock' | 'out_of_stock' | 'backorder';
export type ItemFlag = 'serialized' | 'hazmat';

export type Filters = {
  trades: Trade[];
  kinds: ItemKind[];
  stockStates: StockState[];
  vendors: string[];
  flags: ItemFlag[];
  /** Category names selected in the "Showing" → Categories pill */
  categories: string[];
};

export const emptyFilters: Filters = {
  trades: [],
  kinds: [],
  stockStates: [],
  vendors: [],
  flags: [],
  categories: [],
};

export function activeFilterCount(f: Filters): number {
  return (
    f.trades.length +
    f.kinds.length +
    f.stockStates.length +
    f.vendors.length +
    f.flags.length +
    f.categories.length
  );
}
