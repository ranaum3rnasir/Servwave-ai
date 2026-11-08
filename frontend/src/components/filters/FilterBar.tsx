import { useState } from 'react';
import { ListFilter } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { CheckboxFacet } from './controls/CheckboxFacet';
import { RangeFacet } from './controls/RangeFacet';
import { DateFacet } from './controls/DateFacet';
import type { FacetConfig, FacetOption, FilterState, FilterValue } from '@/lib/filters/types';

export interface FilterBarProps {
  /** STABLE reference — see `useFilterState.ts`'s JSDoc. Never pass an inline literal. */
  registry: FacetConfig[];
  value: FilterState;
  onChange: (next: FilterState) => void;
  /** Resolves a dynamic `optionSource` id into a concrete option list. */
  resolveOptions: (sourceId: string) => FacetOption[];
  /** Resolves a `maxSource` id into a concrete domain ceiling for a range facet. */
  resolveMax: (sourceId: string) => number;
}

/**
 * Number of selected values a facet contributes to the rail badge / footer /
 * trigger totals. `multi` counts every selected value; `range`/`dateRange`
 * count as a single "1" once any bound is set (mirrors the approved mockup's
 * `selCount()`), since those kinds represent one filter, not a list.
 */
function facetSelectionCount(value: FilterValue | undefined): number {
  if (!value) return 0;
  if (value.kind === 'multi') return value.values.length;
  if (value.kind === 'range') return value.from != null || value.to != null ? 1 : 0;
  return value.from || value.to ? 1 : 0;
}

/** Static `facet.options` wins when present; `resolveOptions` only runs for a dynamic `optionSource`. */
function resolveFacetOptions(
  facet: FacetConfig,
  resolveOptions: (sourceId: string) => FacetOption[]
): FacetOption[] | undefined {
  if (facet.options) return facet.options;
  if (facet.optionSource) return resolveOptions(facet.optionSource);
  return undefined;
}

/**
 * Two-pane filter popover container: a left rail listing every facet in
 * `registry` (label + active-count badge), and a right pane rendering
 * whichever pane control (`CheckboxFacet` / `RangeFacet` / `DateFacet`)
 * matches the selected facet's `kind`. Supersedes the single-pane
 * `common/FilterPopover.tsx` chrome for pages migrated onto the generalized
 * filter registry (Task 9+); reuses the same `@/components/ui/popover`
 * Radix primitives and Done-button convention.
 *
 * Identity fields (id, name search, etc.) never appear as rail rows because
 * they are simply absent from `registry` — no special-casing needed here.
 *
 * Each control's own `onChange` only ever updates its own facet's slot:
 * `(facetValue) => onChange({ ...value, [facet.key]: facetValue })`. Global
 * "Clear all" is the one place that touches everything at once, via a
 * single `onChange({})` call.
 */
export function FilterBar({ registry, value, onChange, resolveOptions, resolveMax }: FilterBarProps) {
  const [open, setOpen] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | undefined>(registry[0]?.key);
  const selectedFacet = registry.find((f) => f.key === selectedKey) ?? registry[0];

  const totalSelected = registry.reduce((sum, f) => sum + facetSelectionCount(value[f.key]), 0);
  const activeFacetCount = registry.filter((f) => facetSelectionCount(value[f.key]) > 0).length;

  const setFacetValue = (facet: FacetConfig, next: FilterValue) => {
    onChange({ ...value, [facet.key]: next });
  };

  const clearAll = () => onChange({});

  const renderControl = (facet: FacetConfig) => {
    const facetValue = value[facet.key];
    switch (facet.kind) {
      case 'multi':
        return (
          <CheckboxFacet
            facet={facet}
            value={facetValue}
            onChange={(v) => setFacetValue(facet, v)}
            options={resolveFacetOptions(facet, resolveOptions)}
          />
        );
      case 'range':
        return (
          <RangeFacet
            facet={facet}
            value={facetValue}
            onChange={(v) => setFacetValue(facet, v)}
            min={facet.min}
            max={resolveMax(facet.maxSource!)}
          />
        );
      case 'dateRange':
        return <DateFacet facet={facet} value={facetValue} onChange={(v) => setFacetValue(facet, v)} />;
      default:
        return null;
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" aria-expanded={open}>
          <ListFilter className="mr-2 h-4 w-4" />
          Filter
          {totalSelected > 0 && (
            <span className="ml-1.5 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-on-fill leading-none">
              {totalSelected}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="flex w-[640px] max-w-[94vw] max-h-[calc(100vh-2rem)] flex-col overflow-hidden border p-0"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
          <p className="text-sm font-semibold text-text-primary">Filters</p>
          {totalSelected > 0 && (
            // ghost/subtle + size={null}: idle text-text-secondary and hover:text-text-primary
            // match exactly; size={null} keeps this an inline link, not a 40px box. Disclosed
            // deltas: ghost/subtle adds hover:bg-background-light (no hover bg before), and the
            // base text-sm font-semibold replaces the raw's text-xs font-medium.
            <Button type="button" variant="ghost" tone="subtle" size={null} onClick={clearAll}>
              Clear all ({totalSelected})
            </Button>
          )}
        </div>
        <div className="grid min-h-[352px] flex-1 grid-cols-[200px_1fr] overflow-hidden">
          <div
            role="tablist"
            aria-label="Filter facets"
            className="space-y-0.5 overflow-y-auto border-r border-border p-2"
          >
            {registry.map((facet) => {
              const count = facetSelectionCount(value[facet.key]);
              const selected = facet.key === selectedFacet?.key;
              return (
                // Vertical tab-list facet control (role="tab") - a segmented toggle, not
                // Button-shaped. Deferred.
                <button
                  key={facet.key}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => setSelectedKey(facet.key)}
                  className={`flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm font-medium transition-colors ${
                    selected
                      ? 'bg-background-light text-text-primary'
                      : 'text-text-secondary hover:bg-background-light'
                  }`}
                >
                  <span className="flex-1 truncate">{facet.label}</span>
                  {count > 0 && (
                    <span className="min-w-[18px] rounded-full bg-primary px-1.5 py-0.5 text-center text-[10px] font-semibold leading-none text-on-fill">
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <div className="min-w-0 overflow-y-auto p-4">{selectedFacet && renderControl(selectedFacet)}</div>
        </div>
        <div className="flex shrink-0 items-center justify-between border-t border-border bg-background-light px-4 py-2.5">
          <span className="text-xs text-text-secondary">
            {totalSelected} selected across {activeFacetCount} filters
          </span>
          {/* solid/brand, size="3xs": bg-primary, text-on-fill and the size rung's own text-xs
              all match exactly. Two disclosed deltas: solid/brand's hover:bg-primary-dark
              replaces the raw's hover:bg-primary/90 (same darken-on-hover intent, normalized
              to the token), and the radius corrects rounded-md to Button's own rounded-button. */}
          <Button type="button" variant="solid" tone="brand" size="3xs" onClick={() => setOpen(false)}>
            Done
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
