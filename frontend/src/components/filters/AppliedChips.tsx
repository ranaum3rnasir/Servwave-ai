import { useMemo, type ReactNode } from 'react';
import { FilterChip } from '@/components/data/filter-chip';
import { formatCurrency } from '@/lib/utils';
import { formatDayLabel } from '@/lib/date-range';
import type { FacetConfig, FacetOption, FilterState } from '@/lib/filters/types';

export interface AppliedChipsProps {
  registry: FacetConfig[];
  value: FilterState;
  onChange: (next: FilterState) => void;
  /**
   * Resolves a dynamic `optionSource` id into a concrete option list — the
   * same function `FilterBar` already receives. Optional so callers/tests
   * with only static-`options` facets keep working unchanged; when omitted,
   * a facet with an `optionSource` (and no static `options`) falls back to
   * rendering the raw stored value, same as before this prop existed.
   */
  resolveOptions?: (sourceId: string) => FacetOption[];
}

/**
 * Above this many selected values for one `multi` facet, collapse the tail
 * into a single "+N more" chip instead of one chip per value — otherwise a
 * facet with a dozen selections would flood the strip. The approved mockup
 * doesn't collapse (it renders every value), but that's a mockup with a
 * handful of seed values, not a defensive real-world chip strip; 3 keeps a
 * couple of concrete values visible (so a glance still tells you *what's*
 * filtered) while capping the strip's growth.
 */
const MULTI_CHIP_LIMIT = 3;

/**
 * Static `facet.options` wins when present (mirrors `FilterBar`'s
 * `resolveFacetOptions`). Otherwise, if the facet has a dynamic
 * `optionSource` and a resolved value->label map was built for it (see
 * `dynamicLabelMaps` below), use that. Falls back to the raw stored value —
 * never crashes, never renders blank — when neither resolves (no
 * `resolveOptions` prop, unknown source, or a value with no matching option,
 * e.g. a stale/removed user).
 */
function optionLabel(
  facet: FacetConfig,
  raw: string,
  dynamicLabelMaps: Map<string, Map<string, string>>
): string {
  const staticLabel = facet.options?.find((o) => o.value === raw)?.label;
  if (staticLabel != null) return staticLabel;
  const dynamicLabel = facet.optionSource ? dynamicLabelMaps.get(facet.optionSource)?.get(raw) : undefined;
  return dynamicLabel ?? raw;
}

function formatRangeBound(facet: FacetConfig, n: number): string {
  return facet.money ? formatCurrency(n) : String(n);
}

/** `"3-8"` / `"3+"` (open-ended upper) / `"up to 8"` (open-ended lower) / null if neither bound is set. */
function rangeChipText(facet: FacetConfig, from: number | null, to: number | null): string | null {
  if (from == null && to == null) return null;
  if (from != null && to != null) return `${formatRangeBound(facet, from)}-${formatRangeBound(facet, to)}`;
  if (from != null) return `${formatRangeBound(facet, from)}+`;
  return `up to ${formatRangeBound(facet, to as number)}`;
}

/** Readable date-range chip text, e.g. `"Jan 1 – Feb 1"`, using this repo's existing `formatDayLabel`. */
function dateRangeChipText(from: string, to: string): string | null {
  if (!from && !to) return null;
  if (from && to) return `${formatDayLabel(from)} – ${formatDayLabel(to)}`;
  if (from) return `From ${formatDayLabel(from)}`;
  return `Until ${formatDayLabel(to)}`;
}

/**
 * Renders one removable chip per non-empty facet value in `registry`/`value`
 * order. Each chip's remove control only ever updates its own facet's slot
 * in `FilterState` — never any other facet's value.
 *
 * - `multi`: one chip per selected value (label `"{facet.label}: {value}"`),
 *   collapsing beyond `MULTI_CHIP_LIMIT` into a trailing "+N more" chip.
 *   Removing an individual value chip filters just that value out of the
 *   facet's `values` array (mirrors `CheckboxFacet`'s own uncheck behavior —
 *   an emptied array is left in place as `{kind:'multi', values:[]}`, not
 *   deleted). Removing the "+N more" chip clears the whole facet (there's no
 *   single value it represents), same as a range/dateRange chip's removal.
 * - `range`: `"3-8"` / `"3+"` (open-ended, `to: null`) / `"up to 8"`
 *   (open-ended low end, `from: null`) — the last case isn't reachable by
 *   dragging/typing in `RangeFacet` itself (it always resets a blank "From"
 *   to the domain floor, never `null`), but IS reachable via a bookmarked/
 *   shared URL carrying only an `_max` param (see `urlCodec.ts`'s
 *   `decodeFilters`), so it's handled here defensively.
 * - `dateRange`: a formatted range via `formatDayLabel` (this repo's existing
 *   date-chip formatter). `date-range.ts` also exports `dateChipLabel`, but
 *   that helper bakes the facet label into its own return value
 *   (`"Created: Jun 1, 2026"`); reusing it here would double the label given
 *   this component's own uniform `"{facet.label}: {value}"` chip shape, so
 *   `formatDayLabel` is used directly instead.
 */
export function AppliedChips({ registry, value, onChange, resolveOptions }: AppliedChipsProps) {
  // Build one value->label map per distinct dynamic `optionSource` used by a
  // facet in `registry` (not per chip, not per facet) — `resolveOptions` is
  // already memoized by the caller, but a linear `.find` per chip would still
  // rescan the resolved list on every chip; a map is built once per source
  // per render instead.
  const dynamicLabelMaps = useMemo(() => {
    const maps = new Map<string, Map<string, string>>();
    if (!resolveOptions) return maps;
    for (const facet of registry) {
      if (facet.options || !facet.optionSource || maps.has(facet.optionSource)) continue;
      const options = resolveOptions(facet.optionSource);
      maps.set(facet.optionSource, new Map(options.map((o) => [o.value, o.label])));
    }
    return maps;
  }, [registry, resolveOptions]);

  const removeFacet = (key: string) => {
    const next = { ...value };
    delete next[key];
    onChange(next);
  };

  const removeMultiValue = (facet: FacetConfig, raw: string) => {
    const current = value[facet.key];
    const values = current?.kind === 'multi' ? current.values.filter((v) => v !== raw) : [];
    onChange({ ...value, [facet.key]: { kind: 'multi', values } });
  };

  const chips: ReactNode[] = [];

  for (const facet of registry) {
    const fv = value[facet.key];
    if (!fv) continue;

    if (fv.kind === 'multi') {
      if (fv.values.length === 0) continue;
      const shown = fv.values.slice(0, MULTI_CHIP_LIMIT);
      shown.forEach((raw) => {
        chips.push(
          <FilterChip
            key={`${facet.key}:${raw}`}
            label={`${facet.label}: ${optionLabel(facet, raw, dynamicLabelMaps)}`}
            onRemove={() => removeMultiValue(facet, raw)}
          />
        );
      });
      const remaining = fv.values.length - shown.length;
      if (remaining > 0) {
        chips.push(
          <FilterChip
            key={`${facet.key}:more`}
            label={`+${remaining} more`}
            onRemove={() => removeFacet(facet.key)}
          />
        );
      }
    } else if (fv.kind === 'range') {
      const text = rangeChipText(facet, fv.from, fv.to);
      if (text == null) continue;
      chips.push(
        <FilterChip key={facet.key} label={`${facet.label}: ${text}`} onRemove={() => removeFacet(facet.key)} />
      );
    } else if (fv.kind === 'dateRange') {
      const text = dateRangeChipText(fv.from, fv.to);
      if (text == null) continue;
      chips.push(
        <FilterChip key={facet.key} label={`${facet.label}: ${text}`} onRemove={() => removeFacet(facet.key)} />
      );
    }
  }

  if (chips.length === 0) return null;

  return <div className="flex flex-wrap items-center gap-2">{chips}</div>;
}
