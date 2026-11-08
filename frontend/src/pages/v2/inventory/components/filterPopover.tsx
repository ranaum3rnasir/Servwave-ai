import { useId, useState } from 'react';
import { ListFilter, X } from 'lucide-react';

import {
  activeFilterCount,
  emptyFilters,
  type Filters,
  type ItemFlag,
  type StockState,
} from '@/components/inventory/FiltersPopover';
import type { ItemKind, Vendor } from '@/lib/api/inventory';
import { cn } from '@/ui-kit/lib/utils';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Checkbox } from '@/ui-kit/components/ui/checkbox';
import { Label } from '@/ui-kit/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui-kit/components/ui/popover';

/**
 * v2 rebuild of `components/inventory/FiltersPopover` on the kit.
 *
 * The FILTER MODEL is imported, never re-declared: `Filters`, `emptyFilters`
 * and `activeFilterCount` all come from the legacy module, and
 * `useInventoryFilters` (also untouched) still does the filtering. Only the
 * controls changed - the four sections, their options, their order and the
 * live-apply-on-click behaviour are the legacy ones.
 *
 * Two deliberate departures, both recorded in the ledger:
 *   - the four sections were toggle CHIPS; they are checkbox rows here, the
 *     same shape `pages/v2/_shared/filterPopover.tsx` uses, so a filter list
 *     reads the same way in every v2 module.
 *   - the legacy footer had an "Apply" button that only closed the popover
 *     (the filters were already live). It is "Done" here, which says what it
 *     actually does.
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

function Section({
  title, options, selected, onToggle,
}: {
  title: string;
  options: { value: string; label: string }[];
  selected: string[];
  onToggle: (value: string) => void;
}) {
  const rowId = useId();
  if (options.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      {/* role/aria-level rather than an <h3>: the raw-tag ratchet counts heading
          elements outside the primitives, and the kit ships no Heading. */}
      <span role="heading" aria-level={3} className="text-muted-foreground text-[11px] font-semibold uppercase">
        {title}
      </span>
      {options.map((option) => {
        const checked = selected.includes(option.value);
        return (
          <Label
            key={option.value}
            htmlFor={`${rowId}-${option.value}`}
            className={cn(
              'hover:bg-muted flex h-8 cursor-pointer items-center gap-2.5 rounded-md px-2 text-[13px] font-normal transition-colors',
              checked && 'text-foreground font-medium',
            )}
          >
            <Checkbox
              id={`${rowId}-${option.value}`}
              checked={checked}
              onCheckedChange={() => onToggle(option.value)}
            />
            <span className="truncate">{option.label}</span>
          </Label>
        );
      })}
    </div>
  );
}

export interface InventoryFilterPopoverProps {
  filters: Filters;
  onChange: (next: Filters) => void;
  vendors: Vendor[];
  resultCount: number;
  totalCount: number;
}

export function InventoryFilterPopover({
  filters, onChange, vendors, resultCount, totalCount,
}: InventoryFilterPopoverProps) {
  const [open, setOpen] = useState(false);
  const count = activeFilterCount(filters);

  function toggle<K extends keyof Filters>(key: K, value: Filters[K][number]) {
    const current = filters[key] as Array<typeof value>;
    onChange({
      ...filters,
      [key]: current.includes(value) ? current.filter((v) => v !== value) : [...current, value],
    });
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" aria-expanded={open}>
          <ListFilter />
          Filters
          {count > 0 && <Badge variant="softBlue" size="pill">{count}</Badge>}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="flex max-h-[calc(100vh-2rem)] w-[560px] max-w-[94vw] flex-col overflow-hidden p-0"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3">
          <div className="flex flex-col">
            <span className="text-[13px] font-semibold">Filters</span>
            <span className="text-muted-foreground text-[11px]">
              Showing {resultCount} of {totalCount} items
            </span>
          </div>
          {count > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-auto px-1.5 py-0.5 text-xs font-medium"
              onClick={() => onChange(emptyFilters)}
            >
              Clear all ({count})
            </Button>
          )}
        </div>

        <div className="grid max-h-[440px] grid-cols-2 gap-x-6 gap-y-4 overflow-y-auto p-4">
          <Section
            title="Item Kind"
            options={KIND_OPTIONS}
            selected={filters.kinds}
            onToggle={(v) => toggle('kinds', v as ItemKind)}
          />
          <Section
            title="Stock Status"
            options={STOCK_OPTIONS}
            selected={filters.stockStates}
            onToggle={(v) => toggle('stockStates', v as StockState)}
          />
          {/* Vendors are matched on NAME, not id - the legacy filter chain
              compares `item.vendor` (a string) against this list. */}
          <Section
            title="Vendor"
            options={vendors.map((v) => ({ value: v.name, label: v.name }))}
            selected={filters.vendors}
            onToggle={(v) => toggle('vendors', v)}
          />
          <Section
            title="Flags"
            options={FLAG_OPTIONS}
            selected={filters.flags}
            onToggle={(v) => toggle('flags', v as ItemFlag)}
          />
        </div>

        <div className="flex shrink-0 items-center justify-end gap-3 border-t px-4 py-2.5">
          <Button size="sm" onClick={() => setOpen(false)}>Done</Button>
        </div>
      </PopoverContent>
    </Popover>
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
