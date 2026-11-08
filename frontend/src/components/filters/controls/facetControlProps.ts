import type { FacetConfig, FacetOption, FilterValue } from '@/lib/filters/types';

/**
 * Uniform props contract shared by every pane control (`CheckboxFacet`,
 * `RangeFacet`, `DateFacet`). `FilterBar` (later task) dispatches on
 * `facet.kind` and renders whichever control matches, passing this same
 * shape through — plus control-specific extras where a control needs data
 * the facet config alone can't resolve (see `RangeFacet`'s `max` prop).
 */
export interface FacetControlProps {
  facet: FacetConfig;
  value: FilterValue | undefined;
  onChange: (v: FilterValue) => void;
  /** Resolved option list (static `facet.options` or a resolved `facet.optionSource`). */
  options?: FacetOption[];
}
