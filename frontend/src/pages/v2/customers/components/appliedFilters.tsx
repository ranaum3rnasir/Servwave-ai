import { useMemo } from 'react';

import { formatDayLabel } from '@/lib/date-range';
import { formatCurrency } from '@/lib/utils';
import type { FacetConfig, FacetOption, FilterState } from '@/lib/filters/types';
import { FilterBar, type ActiveFilter } from '@/ui-kit/components/crm/filterBar';

/**
 * v2 port of `components/filters/AppliedChips` onto the kit's FilterBar.
 *
 * Same shape as `pages/v2/_shared/appliedFilters.tsx` - one removable chip per
 * active constraint, the field named on every chip, a 3-value collapse per
 * multi facet - with one addition the leads list has no equivalent of: the
 * Customers list carries three constraints that are deliberately NOT registry
 * facets (`open_leads`, `active_jobs`, `include_archived`; see the comment in
 * `lib/filters/registries/customers.ts`). They are real, user-visible filters,
 * so they get chips of their own here rather than being invisible - which is
 * exactly what the legacy page's standalone `FilterChip`s did.
 *
 * That is why this is a separate component rather than a reuse of the shared
 * `AppliedFilterBar`, and why the _shared consolidation pass deliberately left
 * it here: that one is module-agnostic by definition, and teaching it a
 * customers-only concept would put a per-caller branch inside a shared file.
 * `onClearAll` differs too - here it clears the standalone flags and the search
 * as well, where the shared bar just empties the facet state.
 */
const MULTI_CHIP_LIMIT = 3;

/** The non-registry constraints, in the order the legacy page rendered them. */
export interface StandaloneFilters {
  openLeads: boolean;
  activeJobs: boolean;
  includeArchived: boolean;
}

const STANDALONE_LABELS: Record<keyof StandaloneFilters, string> = {
  openLeads: 'Has open leads',
  activeJobs: 'Has active jobs',
  includeArchived: 'Including archived',
};

function optionLabel(
  facet: FacetConfig,
  raw: string,
  dynamicLabelMaps: Map<string, Map<string, string>>,
): string {
  const staticLabel = facet.options?.find((o) => o.value === raw)?.label;
  if (staticLabel != null) return staticLabel;
  const dynamicLabel = facet.optionSource ? dynamicLabelMaps.get(facet.optionSource)?.get(raw) : undefined;
  return dynamicLabel ?? raw;
}

function formatRangeBound(facet: FacetConfig, n: number): string {
  return facet.money ? formatCurrency(n) : String(n);
}

function rangeChipText(facet: FacetConfig, from: number | null, to: number | null): string | null {
  if (from == null && to == null) return null;
  if (from != null && to != null) return `${formatRangeBound(facet, from)}-${formatRangeBound(facet, to)}`;
  if (from != null) return `${formatRangeBound(facet, from)}+`;
  return `up to ${formatRangeBound(facet, to as number)}`;
}

function dateRangeChipText(from: string, to: string): string | null {
  if (!from && !to) return null;
  if (from && to) return `${formatDayLabel(from)} - ${formatDayLabel(to)}`;
  if (from) return `From ${formatDayLabel(from)}`;
  return `Until ${formatDayLabel(to)}`;
}

export interface CustomerFilterBarProps {
  /** STABLE reference - see `useFilterState`'s JSDoc. Never an inline literal. */
  registry: FacetConfig[];
  value: FilterState;
  onChange: (next: FilterState) => void;
  resolveOptions: (sourceId: string) => FacetOption[];
  standalone: StandaloneFilters;
  /** Clears exactly one standalone flag and resets paging - the legacy chip's own onRemove. */
  onRemoveStandalone: (key: keyof StandaloneFilters) => void;
  /** The legacy "Clear all" - facets AND standalone flags AND search AND page. */
  onClearAll: () => void;
  resultCount?: number;
  totalCount?: number;
  className?: string;
}

export function CustomerFilterBar({
  registry, value, onChange, resolveOptions, standalone, onRemoveStandalone,
  onClearAll, resultCount, totalCount, className,
}: CustomerFilterBarProps) {
  const dynamicLabelMaps = useMemo(() => {
    const maps = new Map<string, Map<string, string>>();
    for (const facet of registry) {
      if (facet.options || !facet.optionSource || maps.has(facet.optionSource)) continue;
      const options = resolveOptions(facet.optionSource);
      maps.set(facet.optionSource, new Map(options.map((o) => [o.value, o.label])));
    }
    return maps;
  }, [registry, resolveOptions]);

  const chips: ActiveFilter[] = [];
  for (const facet of registry) {
    const fv = value[facet.key];
    if (!fv) continue;

    if (fv.kind === 'multi') {
      if (fv.values.length === 0) continue;
      const shown = fv.values.slice(0, MULTI_CHIP_LIMIT);
      shown.forEach((raw) => {
        chips.push({
          id: `multi:${facet.key}:${raw}`,
          label: facet.label,
          value: optionLabel(facet, raw, dynamicLabelMaps),
        });
      });
      const remaining = fv.values.length - shown.length;
      if (remaining > 0) chips.push({ id: `facet:${facet.key}`, label: facet.label, value: `+${remaining} more` });
    } else if (fv.kind === 'range') {
      const text = rangeChipText(facet, fv.from, fv.to);
      if (text != null) chips.push({ id: `facet:${facet.key}`, label: facet.label, value: text });
    } else {
      const text = dateRangeChipText(fv.from, fv.to);
      if (text != null) chips.push({ id: `facet:${facet.key}`, label: facet.label, value: text });
    }
  }

  (Object.keys(STANDALONE_LABELS) as (keyof StandaloneFilters)[]).forEach((key) => {
    if (!standalone[key]) return;
    // The kit chip always prints "{label}: {value}", so these read "Customers:
    // Has open leads" rather than the bare "Has open leads" the legacy
    // FilterChip showed. The constraint named is the same one.
    chips.push({ id: `standalone:${key}`, label: 'Customers', value: STANDALONE_LABELS[key] });
  });

  /**
   * Removing one value of a multi facet filters just that value out and leaves
   * an emptied array in place (mirrors the checkbox control); removing a
   * "+N more", range or date chip clears the whole facet; a standalone chip
   * clears only its own flag.
   */
  const remove = (id: string) => {
    // Split on the FIRST TWO colons only - a facet value can contain one
    // (`ad_source` is free text written by the org).
    const firstColon = id.indexOf(':');
    const secondColon = firstColon === -1 ? -1 : id.indexOf(':', firstColon + 1);
    const kind = firstColon === -1 ? id : id.slice(0, firstColon);
    const key = firstColon === -1
      ? undefined
      : id.slice(firstColon + 1, secondColon === -1 ? undefined : secondColon);
    const raw = secondColon === -1 ? undefined : id.slice(secondColon + 1);
    if (!key) return;
    if (kind === 'standalone') {
      onRemoveStandalone(key as keyof StandaloneFilters);
      return;
    }
    if (kind === 'multi' && raw != null) {
      const current = value[key];
      const values = current?.kind === 'multi' ? current.values.filter((v) => v !== raw) : [];
      onChange({ ...value, [key]: { kind: 'multi', values } });
      return;
    }
    const next = { ...value };
    delete next[key];
    onChange(next);
  };

  return (
    <FilterBar
      className={className}
      filters={chips}
      onRemove={remove}
      onClearAll={onClearAll}
      resultCount={resultCount}
      totalCount={totalCount}
    />
  );
}
