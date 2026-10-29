import { useMemo, type Dispatch, type SetStateAction } from 'react';
import { X } from 'lucide-react';

import {
  emptyFilters,
  type Filters,
  type ItemFlag,
  type StockState,
} from '@/lib/inventory/filters';
import type { ItemKind, Vendor } from '@/lib/api/inventory';
import type { FacetConfig, FacetOption, FilterState, FilterValue } from '@/lib/filters/types';
import { cn } from '@/ui-kit/lib/utils';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';

import { FilterPopover } from '../../_shared/filterPopover';

/**
 * The inventory list's filter: the shared list filter (`pages/v2/_shared/filterPopover`) over this
 * list's own model.
 *
 * The FILTER MODEL is imported, never re-declared: `Filters` and
 * `emptyFilters` come from the legacy module, and `useInventoryFilters` (also untouched)
 * still does the filtering. This file only translates that model to and from the shared filter's
 * facets: the four sections, their options and their order are the legacy ones, and a pick still
 * applies as you click. They are the shared filter's facet list now (one value list at a time, a
 * bottom sheet on a phone) instead of four columns in a fixed-width panel.
 *
 * `categories` and `trades` are not facets here: categories have their own selector beside the
 * filter and no UI writes trades. They still count in the button's badge and are still cleared by
 * Clear all, exactly as before (`extraCount`), and the translation leaves them as they are.
 */

// Two kinds, not five. `ItemKind` was narrowed from
// 'material' | 'service' | 'labor' | 'bundle' | 'fee' to just the first two, and
// AddItemDialog's own option list was cut to match, so Labor, Bundle and Fee
// name kinds nothing can be saved as any more. A filter that offers them can
// only ever return nothing.
const KIND_OPTIONS: { value: ItemKind; label: string }[] = [
  { value: 'material', label: 'Material' },
  { value: 'service', label: 'Service' },
];

const STOCK_OPTIONS: { value: StockState; label: string }[] = [
  { value: 'in_stock', label: 'In stock' },
  { value: 'low_stock', label: 'Low stock' },
  { value: 'out_of_stock', label: 'Out of stock' },
  { value: 'backorder', label: 'On backorder' },
];

const FLAG_OPTIONS: { value: ItemFlag; label: string }[] = [
  { value: 'serialized', label: 'Serialized' },
  { value: 'hazmat', label: 'Hazmat' },
];

function stockLabel(value: string): string {
  return STOCK_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

const FACET_KEYS = ['kinds', 'stockStates', 'vendors', 'flags'] as const;

const FILTER_FACETS: Record<(typeof FACET_KEYS)[number], FacetConfig> = {
  kinds: { key: 'kinds', label: 'Item Kind', icon: '', kind: 'multi', param: 'kinds', options: KIND_OPTIONS },
  stockStates: { key: 'stockStates', label: 'Stock Status', icon: '', kind: 'multi', param: 'stock', options: STOCK_OPTIONS },
  vendors: { key: 'vendors', label: 'Vendor', icon: '', kind: 'multi', param: 'vendors', optionSource: 'vendors' },
  flags: { key: 'flags', label: 'Flags', icon: '', kind: 'multi', param: 'flags', options: FLAG_OPTIONS },
};

/** The model as the shared filter's value. Only a section with something picked has a key. */
export function toFilterState(filters: Filters): FilterState {
  const state: FilterState = {};
  for (const key of FACET_KEYS) {
    if (filters[key].length > 0) state[key] = { kind: 'multi', values: [...filters[key]] };
  }
  return state;
}

const picked = (v: FilterValue | undefined): string[] => (v?.kind === 'multi' ? v.values : []);

/** The shared filter's value written onto the model; what the filter does not edit is kept. */
export function applyFilterState(prev: Filters, next: FilterState): Filters {
  return {
    ...prev,
    kinds: picked(next.kinds) as ItemKind[],
    stockStates: picked(next.stockStates) as StockState[],
    vendors: picked(next.vendors),
    flags: picked(next.flags) as ItemFlag[],
  };
}

export interface InventoryFilterPopoverProps {
  filters: Filters;
  onChange: Dispatch<SetStateAction<Filters>>;
  vendors: Vendor[];
  resultCount: number;
  totalCount: number;
}

export function InventoryFilterPopover({
  filters, onChange, vendors, resultCount, totalCount,
}: InventoryFilterPopoverProps) {
  // A Vendor facet with no vendors would be an empty pane, so it is left out until there are some.
  const registry = useMemo(
    () => FACET_KEYS.filter((key) => key !== 'vendors' || vendors.length > 0).map((key) => FILTER_FACETS[key]),
    [vendors.length],
  );
  const value = useMemo(() => toFilterState(filters), [filters]);
  // Vendors are matched on NAME, not id - the legacy filter chain compares `item.vendor` (a string)
  // against this list.
  const resolveOptions = (sourceId: string): FacetOption[] =>
    (sourceId === 'vendors' ? vendors.map((v) => ({ value: v.name, label: v.name })) : []);
  const outside = filters.categories.length + filters.trades.length;

  return (
    <FilterPopover
      registry={registry}
      value={value}
      onChange={(next) => onChange((prev) => applyFilterState(prev, next))}
      resolveOptions={resolveOptions}
      subtitle={`Showing ${resultCount} of ${totalCount} items`}
      extraCount={outside}
      hasExtraConstraint={outside > 0}
      onClearAll={() => onChange(emptyFilters)}
    />
  );
}

/**
 * The applied-filter strip. Same four dimensions the legacy `ActiveFilterChips`
 * showed (kinds / stockStates / vendors / flags - deliberately not categories,
 * which have their own selector, and not trades, which no UI writes), same
 * `Remove {label}` accessible names, same trailing "Clear all".
 */
export function InventoryFilterChips({
  filters, onChange, className,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
  className?: string;
}) {
  const chips: { key: keyof Filters; label: string; value: string }[] = [
    ...filters.kinds.map((v) => ({ key: 'kinds' as keyof Filters, label: `Kind: ${v}`, value: v })),
    ...filters.stockStates.map((v) => ({ key: 'stockStates' as keyof Filters, label: stockLabel(v), value: v })),
    ...filters.vendors.map((v) => ({ key: 'vendors' as keyof Filters, label: `Vendor: ${v}`, value: v })),
    ...filters.flags.map((v) => ({
      key: 'flags' as keyof Filters,
      label: v === 'serialized' ? 'Serialized' : 'Hazmat',
      value: v,
    })),
  ];

  if (chips.length === 0) return null;

  function remove(key: keyof Filters, value: string) {
    const current = filters[key] as string[];
    onChange({ ...filters, [key]: current.filter((v) => v !== value) });
  }

  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {chips.map((chip) => (
        <Badge key={`${chip.key}:${chip.value}`} variant="softBlue" size="pill" className="gap-0.5">
          {chip.label}
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-4"
            aria-label={`Remove ${chip.label}`}
            onClick={() => remove(chip.key, chip.value)}
          >
            <X />
          </Button>
        </Badge>
      ))}
      <Button
        variant="ghost"
        size="sm"
        className="h-auto px-1.5 py-0.5 text-xs font-medium"
        onClick={() => onChange(emptyFilters)}
      >
        Clear all
      </Button>
    </div>
  );
}
