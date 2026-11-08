import { useMemo, useState } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import type { FacetControlProps } from './facetControlProps';

/**
 * Pane control for `kind: 'multi'` facets: a search box (only shown once the
 * option list is large enough to need one — locked design: 6 or fewer
 * options don't need search) filtering a checkbox list, plus a per-section
 * "Clear <label>" affordance.
 *
 * Per-value counts aren't rendered: `FacetOption`/`FilterValue` (Task 5)
 * carry no count field, and inventing one here would mean widening a shared
 * type from a leaf control — out of scope for this task. See task-7-report.md.
 *
 * "Select all" / "Deselect all" (added post-review, see task-7-report.md
 * "Fix" section) is a toggle that operates on `visibleOptions` only — the
 * same search-filtered list the checkboxes render — not the full unfiltered
 * option list. Clicking it merges/removes just those visible values into/from
 * `value.values`, leaving any already-selected value that the search box is
 * currently hiding untouched.
 */
export function CheckboxFacet({ facet, value, onChange, options }: FacetControlProps) {
  const [search, setSearch] = useState('');
  const allOptions = options ?? facet.options ?? [];
  const showSearch = allOptions.length > 6;

  const visibleOptions = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!showSearch || !q) return allOptions;
    return allOptions.filter((o) => o.label.toLowerCase().includes(q));
  }, [allOptions, search, showSearch]);

  const selected = value?.kind === 'multi' ? value.values : [];

  const toggle = (optionValue: string, checked: boolean) => {
    const next = checked ? [...selected, optionValue] : selected.filter((v) => v !== optionValue);
    onChange({ kind: 'multi', values: next });
  };

  const clear = () => onChange({ kind: 'multi', values: [] });

  // "Select all" / "Deselect all" operate on `visibleOptions` (the
  // search-filtered set), not the full option list — selecting all only adds
  // the currently-visible values, preserving any already-selected value that
  // the search box is currently hiding.
  const visibleValues = visibleOptions.map((o) => o.value);
  const allVisibleSelected = visibleValues.length > 0 && visibleValues.every((v) => selected.includes(v));

  const selectAllVisible = () => {
    const merged = [...selected];
    visibleValues.forEach((v) => {
      if (!merged.includes(v)) merged.push(v);
    });
    onChange({ kind: 'multi', values: merged });
  };

  const deselectAllVisible = () => {
    const visibleSet = new Set(visibleValues);
    onChange({ kind: 'multi', values: selected.filter((v) => !visibleSet.has(v)) });
  };

  return (
    <div className="space-y-2">
      {showSearch && (
        <Input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={`Search ${facet.label.toLowerCase()}...`}
          aria-label={`Search ${facet.label}`}
          className="h-8 text-sm"
        />
      )}
      {visibleValues.length > 0 && (
        <button
          type="button"
          onClick={allVisibleSelected ? deselectAllVisible : selectAllVisible}
          className="text-xs font-medium text-text-secondary hover:text-text-primary"
        >
          {allVisibleSelected ? 'Deselect all' : 'Select all'}
        </button>
      )}
      <div className="max-h-64 space-y-1 overflow-y-auto">
        {visibleOptions.map((option) => {
          const checked = selected.includes(option.value);
          return (
            // Checkbox row (label wraps its control) - not a FormField-shape site, left raw.
            <label
              key={option.value}
              className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm text-text-primary hover:bg-background-light"
            >
              <Checkbox
                checked={checked}
                onCheckedChange={(c) => toggle(option.value, c === true)}
                aria-label={option.label}
              />
              {option.swatch && (
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: option.swatch }}
                />
              )}
              <span>{option.label}</span>
            </label>
          );
        })}
      </div>
      {selected.length > 0 && (
        <button
          type="button"
          onClick={clear}
          className="text-xs font-medium text-text-secondary hover:text-text-primary"
        >
          Clear {facet.label}
        </button>
      )}
    </div>
  );
}
