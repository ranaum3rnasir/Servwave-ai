/* =============================================================================
   ServWave Filters — barrel.
   Generic, registry-driven filter UI. `FilterBar` renders the facet controls for
   a filter registry; `AppliedChips` renders the active-filter summary row. The
   `controls/` facet components are the per-type editors FilterBar dispatches to.

   Filter *state and registries* live in `@/lib/filters` — this folder is the UI
   half only.
   ============================================================================= */

export { FilterBar } from './FilterBar';
export type { FilterBarProps } from './FilterBar';

export { AppliedChips } from './AppliedChips';
export type { AppliedChipsProps } from './AppliedChips';

export { RangeSlider } from './RangeSlider';
export type { RangeSliderProps, RangeSliderValue } from './RangeSlider';

export { CheckboxFacet } from './controls/CheckboxFacet';
export { DateFacet } from './controls/DateFacet';

export { RangeFacet } from './controls/RangeFacet';
export type { RangeFacetProps } from './controls/RangeFacet';

export type { FacetControlProps } from './controls/facetControlProps';
