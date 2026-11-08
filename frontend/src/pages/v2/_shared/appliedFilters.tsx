import { useMemo, type ReactNode } from 'react';

import { formatDayLabel } from '@/lib/date-range';
import { formatCurrency } from '@/lib/utils';
import type { FacetConfig, FacetOption, FilterState } from '@/lib/filters/types';
import { FilterBar, type ActiveFilter } from '@/ui-kit/components/crm/filterBar';

/**
 * v2 port of `components/filters/AppliedChips` onto the kit's FilterBar, which
 * already renders one removable chip per active constraint and names the field
 * on each ("Status: Won"). The chip vocabulary, the 3-value collapse and the
 * per-chip removal semantics are carried over unchanged from the legacy
 * component, including the asymmetry that removing ONE value of a multi facet
 * leaves an emptied array in place while removing a range, date or "+N more"
 * chip deletes the facet key outright.
 *
 * MODULE-AGNOSTIC: it reads whatever `FacetConfig[]` registry it is handed and
 * knows no entity. Leads, jobs, estimates and invoices each shipped their own
 * copy of this file because the parallel module branches could not create a
 * shared location; the four were code-identical apart from the exported name,
 * so they are one file here.
 *
 * `pages/v2/customers/components/appliedFilters.tsx` is deliberately NOT folded
 * in. The customers list carries three constraints that are not registry facets
 * at all, so its chip set and its "Clear all" mean something different. See
 * `pages/v2/_shared/README.md`.
 */
const MULTI_CHIP_LIMIT = 3;

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

export interface AppliedFilterBarProps {
  registry: FacetConfig[];
  value: FilterState;
  onChange: (next: FilterState) => void;
  resolveOptions: (sourceId: string) => FacetOption[];
  /** Controls rendered above the chip strip - the Filter trigger, paging. */
  children?: ReactNode;
  resultCount?: number;
  totalCount?: number;
  className?: string;
}

export function AppliedFilterBar({
  registry, value, onChange, resolveOptions, children, resultCount, totalCount, className,
}: AppliedFilterBarProps) {
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

  /**
   * Removing one value of a multi facet filters just that value out and leaves
   * an emptied array in place (mirrors the checkbox control); removing a
   * "+N more", range or date chip clears the whole facet.
   */
  const remove = (id: string) => {
    // Split on the FIRST TWO colons only. A facet value can contain one:
    // `job_type` and `ad_source` are free text written by the org through the
    // inline "+ Add new type" field, so a type named "HVAC: Install" is legal.
    // A plain `id.split(':')` truncated the value at its own colon, the
    // filter-out matched nothing, and the chip's x silently did nothing.
    const firstColon = id.indexOf(':');
    const secondColon = firstColon === -1 ? -1 : id.indexOf(':', firstColon + 1);
    const kind = firstColon === -1 ? id : id.slice(0, firstColon);
    const key = firstColon === -1
      ? undefined
      : id.slice(firstColon + 1, secondColon === -1 ? undefined : secondColon);
    const raw = secondColon === -1 ? undefined : id.slice(secondColon + 1);
    if (!key) return;
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
      onClearAll={() => onChange({})}
      resultCount={resultCount}
      totalCount={totalCount}
    >
      {children}
    </FilterBar>
  );
}
