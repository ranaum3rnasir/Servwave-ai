import { useId, useMemo, useState, type ReactNode } from 'react';
import { ListFilter } from 'lucide-react';

import { PRESETS as DATE_PRESETS, matchPreset } from '@/lib/date-range';
import type { StatusDomain } from '@/design-system/status-registry';
import type { FacetConfig, FacetOption, FilterState, FilterValue } from '@/lib/filters/types';
import { cn } from '@/ui-kit/lib/utils';
import { Badge } from '@/ui-kit/components/ui/badge';

import { DatePicker } from './datePicker';
import { StatusChip } from './statusChip';
import { Button } from '@/ui-kit/components/ui/button';
import { Checkbox } from '@/ui-kit/components/ui/checkbox';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui-kit/components/ui/popover';
import { SelectField, type SelectFieldOption } from '@/ui-kit/components/form/selectField';

/**
 * v2 filter popover - the kit rebuild of `components/filters/FilterBar` and its
 * three pane controls.
 *
 * MODULE-AGNOSTIC: it reads whatever `FacetConfig[]` registry it is handed and
 * names no entity. The one thing it cannot infer is which status vocabulary a
 * `status` facet's options belong to, so that arrives as `statusDomain` rather
 * than being hardcoded. leads and invoices shipped byte-identical copies of
 * this file that differed in exactly that one constant; they are one file here.
 *
 * The jobs, estimates and inventory modules keep their own popovers. Those have
 * really diverged - no range facet, a second deposit-status facet, a different
 * filter model entirely - so folding them in would mean a branch per caller
 * inside a shared file. See `pages/v2/_shared/README.md`.
 *
 * The FILTER MODEL is untouched: the same `FacetConfig[]` registry, the same
 * `FilterState`, the same `useFilterState` URL codec. Only the controls are
 * kit components. Two deliberate departures, both recorded in the branch
 * report:
 *   - the range facet keeps its two typed inputs (and their `"{label} From"` /
 *     `"{label} To"` aria labels, which a vitest test queries by) but loses the
 *     dual-handle slider: the kit ships no slider primitive.
 *   - the date facet keeps the preset list and the custom-range inputs, moved
 *     onto the kit Select.
 */

// DATE_PRESETS/matchPreset now live in @/lib/date-range (#1634) - this file had
// a byte-identical copy of both, one of four before consolidation. No facet
// rendered through this shared popover (customers/leads/invoices "created",
// invoices "due") is a scheduling fact, so nothing here passes `tz` -
// `matchPreset`/`.range()` below stay on the browser clock, unchanged.

/**
 * The date facet's own list: the eight shared presets plus "Custom…".
 *
 * Module scope, not a `useMemo` in the component - `PRESETS` is a module
 * constant, so this is one array for the module's lifetime and every DateFacet
 * shares it. Nine options, i.e. below `SEARCH_THRESHOLD`, so §4.2 keeps this on
 * the plain Select branch and the markup is unchanged; the count is still read
 * inside `SelectField`, so a tenth preset flips it to searchable on the commit
 * that adds it, with the `side`/`avoidCollisions` pin carried across intact.
 */
const RANGE_OPTIONS: SelectFieldOption[] = [
  ...DATE_PRESETS.map((p) => ({ value: p.key, label: p.label })),
  { value: 'custom', label: 'Custom…' },
];

/** Values a facet contributes to the badge counts: every multi value, or 1 per bounded range. */
export function facetSelectionCount(value: FilterValue | undefined): number {
  if (!value) return 0;
  if (value.kind === 'multi') return value.values.length;
  if (value.kind === 'range') return value.from != null || value.to != null ? 1 : 0;
  return value.from || value.to ? 1 : 0;
}

/** Static `facet.options` wins; `resolveOptions` only runs for a dynamic `optionSource`. */
function resolveFacetOptions(
  facet: FacetConfig,
  resolveOptions: (sourceId: string) => FacetOption[],
): FacetOption[] {
  if (facet.options) return facet.options;
  if (facet.optionSource) return resolveOptions(facet.optionSource);
  return [];
}

function CheckboxFacet({
  facet, value, onChange, options, renderOption,
}: {
  facet: FacetConfig;
  value: FilterValue | undefined;
  onChange: (next: FilterValue) => void;
  options: FacetOption[];
  /** Paints an option as something other than plain text - see the status facet. */
  renderOption?: (option: FacetOption) => ReactNode;
}) {
  const [search, setSearch] = useState('');
  const rowId = useId();
  const showSearch = options.length > 6;

  const visibleOptions = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!showSearch || !q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, search, showSearch]);

  const selected = value?.kind === 'multi' ? value.values : [];
  const visibleValues = visibleOptions.map((o) => o.value);
  const allVisibleSelected = visibleValues.length > 0 && visibleValues.every((v) => selected.includes(v));

  const toggle = (optionValue: string, checked: boolean) => {
    onChange({
      kind: 'multi',
      values: checked ? [...selected, optionValue] : selected.filter((v) => v !== optionValue),
    });
  };

  const selectAllVisible = () => {
    const merged = [...selected];
    visibleValues.forEach((v) => { if (!merged.includes(v)) merged.push(v); });
    onChange({ kind: 'multi', values: merged });
  };

  const deselectAllVisible = () => {
    const visibleSet = new Set(visibleValues);
    onChange({ kind: 'multi', values: selected.filter((v) => !visibleSet.has(v)) });
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* The pane names what it is editing. Without it the checkbox list is
          orphaned from the facet you clicked, and on a narrow window the left
          column scrolls out of view entirely. */}
      <div className="flex items-baseline justify-between gap-3">
        {/* role/aria-level rather than an <h3>: the raw-tag ratchet counts
            heading elements outside the primitives, and the kit ships no
            Heading component. The accessibility tree is identical. */}
        <span role="heading" aria-level={3} className="text-foreground text-[13px] font-semibold">
          {facet.label}
        </span>
        {visibleValues.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="text-brand hover:text-brand-emphasis h-auto px-1.5 py-0.5 text-xs font-medium"
            onClick={allVisibleSelected ? deselectAllVisible : selectAllVisible}
          >
            {allVisibleSelected ? 'Clear all' : 'Select all'}
          </Button>
        )}
      </div>

      {showSearch && (
        <Input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={`Search ${facet.label.toLowerCase()}...`}
          aria-label={`Search ${facet.label}`}
        />
      )}

      <div className="-mx-1.5 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1.5">
        {visibleOptions.length === 0 ? (
          <p className="text-subtle-foreground py-6 text-center text-xs">
            No {facet.label.toLowerCase()} matches {`"${search}"`}
          </p>
        ) : (
          visibleOptions.map((option) => {
            const checked = selected.includes(option.value);
            return (
              // The whole row is the label, so the hit target is the row rather
              // than a 16px box plus its text. A filter list is scanned and
              // clicked quickly; making people aim costs more than it saves.
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
                  onCheckedChange={(c) => toggle(option.value, c === true)}
                />
                {renderOption
                  ? renderOption(option)
                  : <span className="truncate">{option.label}</span>}
              </Label>
            );
          })
        )}
      </div>
    </div>
  );
}

function RangeFacet({
  facet, value, onChange, max,
}: {
  facet: FacetConfig;
  value: FilterValue | undefined;
  onChange: (next: FilterValue) => void;
  max: number;
}) {
  const domainMin = facet.min ?? 0;
  const from = value?.kind === 'range' ? (value.from ?? domainMin) : domainMin;
  const to = value?.kind === 'range' ? value.to : null;

  const handleFromChange = (raw: string) => {
    if (raw === '') { onChange({ kind: 'range', from: domainMin, to }); return; }
    const num = Number(raw);
    if (Number.isNaN(num)) return;
    const ceiling = to ?? max;
    onChange({ kind: 'range', from: Math.min(Math.max(num, domainMin), ceiling), to });
  };

  const handleToChange = (raw: string) => {
    if (raw === '') { onChange({ kind: 'range', from, to: null }); return; }
    const num = Number(raw);
    if (Number.isNaN(num)) return;
    onChange({ kind: 'range', from, to: Math.max(Math.min(num, max), from) });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Input
          type="number"
          min={domainMin}
          max={max}
          value={String(from)}
          onChange={(e) => handleFromChange(e.target.value)}
          aria-label={`${facet.label} From`}
        />
        <span className="text-muted-foreground">-</span>
        <Input
          type="number"
          min={domainMin}
          max={max}
          value={to === null ? '' : String(to)}
          onChange={(e) => handleToChange(e.target.value)}
          placeholder={facet.unit ? `Any ${facet.unit}` : 'Any'}
          aria-label={`${facet.label} To`}
        />
      </div>
      {to === null && (
        <p className="text-muted-foreground text-xs">
          {from}{facet.unit ? ` ${facet.unit}` : ''} or more
        </p>
      )}
    </div>
  );
}

function DateFacet({
  facet, value, onChange,
}: {
  facet: FacetConfig;
  value: FilterValue | undefined;
  onChange: (next: FilterValue) => void;
}) {
  const from = value?.kind === 'dateRange' ? value.from : '';
  const to = value?.kind === 'dateRange' ? value.to : '';
  // Sticky, exactly as DateRangeField: picking "Custom" must not snap back to a
  // preset the typed dates happen to match.
  const [customMode, setCustomMode] = useState(() => matchPreset(from, to) === 'custom');
  const selected = customMode ? 'custom' : matchPreset(from, to);

  const handleSelect = (key: string) => {
    if (key === 'custom') { setCustomMode(true); return; }
    setCustomMode(false);
    const preset = DATE_PRESETS.find((p) => p.key === key);
    if (preset) {
      const next = preset.range();
      onChange({ kind: 'dateRange', from: next.from, to: next.to });
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <SelectField
        value={selected}
        onValueChange={handleSelect}
        options={RANGE_OPTIONS}
        aria-label={`${facet.label} range`}
        // Always downward. Radix flips a Select up when the trigger sits near
        // the viewport bottom, and inside a 340px panel that detaches the menu
        // from its own control. `position` is not passed: the kit
        // `SelectContent` already defaults to `"popper"`, and `SelectField`
        // deliberately has no such prop because Popover - the branch above ten
        // options - has no `item-aligned` equivalent.
        side="bottom"
        avoidCollisions={false}
      />
      {selected === 'custom' && (
        <div className="flex items-center gap-2">
          <DatePicker
            value={from}
            max={to || undefined}
            onChange={(v) => onChange({ kind: 'dateRange', from: v, to })}
            aria-label={`${facet.label} from`}
            className="min-w-0 flex-1"
          />
          <span className="text-muted-foreground">-</span>
          <DatePicker
            value={to}
            min={from || undefined}
            onChange={(v) => onChange({ kind: 'dateRange', from, to: v })}
            aria-label={`${facet.label} to`}
            className="min-w-0 flex-1"
          />
        </div>
      )}
    </div>
  );
}

export interface FilterPopoverProps {
  /** STABLE reference - see `useFilterState`'s JSDoc. Never an inline literal. */
  registry: FacetConfig[];
  value: FilterState;
  onChange: (next: FilterState) => void;
  resolveOptions: (sourceId: string) => FacetOption[];
  resolveMax: (sourceId: string) => number;
  /**
   * Which status vocabulary a facet keyed `status` is painted with. Required,
   * not defaulted: a wrong guess here silently mislabels a live filter panel,
   * so every caller states its own domain.
   */
  statusDomain: StatusDomain;
}

export function FilterPopover({
  registry, value, onChange, resolveOptions, resolveMax, statusDomain,
}: FilterPopoverProps) {
  const [open, setOpen] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | undefined>(registry[0]?.key);
  const selectedFacet = registry.find((f) => f.key === selectedKey) ?? registry[0];

  const totalSelected = registry.reduce((sum, f) => sum + facetSelectionCount(value[f.key]), 0);
  const activeFacetCount = registry.filter((f) => facetSelectionCount(value[f.key]) > 0).length;

  const setFacetValue = (facet: FacetConfig, next: FilterValue) => {
    onChange({ ...value, [facet.key]: next });
  };

  const renderControl = (facet: FacetConfig) => {
    switch (facet.kind) {
      case 'multi':
        return (
          <CheckboxFacet
            facet={facet}
            value={value[facet.key]}
            onChange={(v) => setFacetValue(facet, v)}
            options={resolveFacetOptions(facet, resolveOptions)}
            // Statuses are painted as the badge the table shows, so picking one
            // and reading one are the same act of recognition. The kit's own
            // rule for StatusSelect: the options ARE the badge, so there is no
            // legend to memorise between here and the rows.
            renderOption={
              facet.key === 'status'
                ? (option) => <StatusChip domain={statusDomain} status={option.value} />
                : undefined
            }
          />
        );
      case 'range':
        return (
          <RangeFacet
            facet={facet}
            value={value[facet.key]}
            onChange={(v) => setFacetValue(facet, v)}
            max={facet.maxSource ? resolveMax(facet.maxSource) : 0}
          />
        );
      case 'dateRange':
        return <DateFacet facet={facet} value={value[facet.key]} onChange={(v) => setFacetValue(facet, v)} />;
      default:
        return null;
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" aria-expanded={open}>
          <ListFilter />
          Filter
          {totalSelected > 0 && <Badge variant="softBlue" size="pill">{totalSelected}</Badge>}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="flex max-h-[calc(100vh-2rem)] w-[640px] max-w-[94vw] flex-col overflow-hidden p-0"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold">Filters</span>
            {totalSelected > 0 && (
              <Badge variant="softBlue" size="pill">{totalSelected}</Badge>
            )}
          </div>
          {/* Only offered when there is something to clear. A permanently
              visible destructive-ish action on an empty panel is noise. */}
          {totalSelected > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-auto px-1.5 py-0.5 text-xs font-medium"
              onClick={() => onChange({})}
            >
              Clear all
            </Button>
          )}
        </div>

        {/* A fixed height, not a min-height. The old min-h left the facet column
            half empty on short lists and the panel still jumped when switching
            to a taller one; a stable box means the Done button never moves. */}
        <div className="grid h-[340px] flex-1 grid-cols-[188px_1fr] overflow-hidden">
          <div role="tablist" aria-label="Filter facets" className="flex flex-col gap-0.5 overflow-y-auto border-r p-2">
            {registry.map((facet) => {
              const count = facetSelectionCount(value[facet.key]);
              const active = facet.key === selectedFacet?.key;
              return (
                <Button
                  key={facet.key}
                  variant="ghost"
                  size="sm"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setSelectedKey(facet.key)}
                  className={cn(
                    'relative flex h-8 w-full items-center justify-between gap-2 rounded-md px-2.5 text-left text-[13px] font-normal transition-colors',
                    // The active facet is marked with a left rail, the same
                    // device the sidebar uses for the active page. One
                    // "you are here" language across the app beats a filled
                    // block here and a rail there.
                    active
                      ? 'before:bg-brand text-foreground bg-brand-subtle font-semibold before:absolute before:top-1.5 before:bottom-1.5 before:left-0 before:w-[3px] before:rounded-r-full before:content-[""]'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  <span className="truncate">{facet.label}</span>
                  {count > 0 && <Badge variant="softBlue" size="pill">{count}</Badge>}
                </Button>
              );
            })}
          </div>
          <div className="flex min-w-0 flex-col overflow-hidden p-4">
            {selectedFacet && renderControl(selectedFacet)}
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-between gap-3 border-t px-4 py-2.5">
          <span className="text-muted-foreground text-xs">
            {totalSelected === 0
              ? 'No filters applied'
              : `${totalSelected} selected across ${activeFacetCount} ${activeFacetCount === 1 ? 'filter' : 'filters'}`}
          </span>
          <Button size="sm" onClick={() => setOpen(false)}>Done</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
