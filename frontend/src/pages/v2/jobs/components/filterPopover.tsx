import { useId, useMemo, useState, type ReactNode } from 'react';
import { ListFilter } from 'lucide-react';

import { PRESETS as DATE_PRESETS, matchPreset } from '@/lib/date-range';
import { useScheduleTimezone } from '@/lib/schedule-tz';
import type { FacetConfig, FacetOption, FilterState, FilterValue } from '@/lib/filters/types';
import { cn } from '@/ui-kit/lib/utils';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Checkbox } from '@/ui-kit/components/ui/checkbox';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui-kit/components/ui/popover';
import { SelectField, type SelectFieldOption } from '@/ui-kit/components/form/selectField';

import { DatePicker } from '../../_shared/datePicker';
import { StatusChip } from './statusChip';

/**
 * v2 filter popover for the jobs list - the kit rebuild of
 * `components/filters/FilterBar` and its pane controls.
 *
 * The FILTER MODEL is untouched: the same `FacetConfig[]` registry
 * (`lib/filters/registries/jobs`), the same `FilterState`, the same
 * `useFilterState` URL codec, so a deep link like
 * `?status=UNSCHEDULED&needs_invoice=true` decodes exactly as it does today.
 * Only the controls are kit components.
 *
 * A MODULE-LOCAL COPY of the shape `pages/v2/_shared/filterPopover.tsx` settled
 * on, and the _shared consolidation pass deliberately left it that way. Four
 * things differ from the shared control, none of them a constant that could
 * become a prop:
 *   - NO range facet and NO `resolveMax` prop at all (see below).
 *   - the `swatch` colour dot on checkbox options.
 *   - an `aria-label` on every option checkbox.
 *   - the local `statusChip`, whose job lifecycle palette the shared chip does
 *     not carry.
 * Folding this in would mean a branch per caller inside a shared file, which is
 * what `pages/v2/_shared/README.md` exists to keep out.
 *
 * Departures from the legacy FilterBar, all recorded in the module ledger:
 *   - the date facet keeps the preset list and the custom-range inputs, moved
 *     onto the kit Select. The `Today` preset a vitest spec queries by name is
 *     preserved.
 *   - NO range control. The jobs registry declares no `range` facet, and the
 *     legacy page acknowledged that by passing `resolveMax: () => 0` purely to
 *     satisfy a required prop. So `resolveMax` is not a prop here and the
 *     `range` branch renders nothing; add both back with the first range facet.
 *   - the rail's per-facet icons are gone; the legacy FilterBar had already
 *     dropped them, so `FacetConfig.icon` goes unread here too.
 */

// DATE_PRESETS/matchPreset now live in @/lib/date-range (#1634) - this file had
// a byte-identical copy of both, one of four before consolidation.

/**
 * The date facet's own list: the eight shared presets plus "Custom".
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
  { value: 'custom', label: 'Custom' },
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
      <div className="flex items-baseline justify-between gap-3">
        {/* role/aria-level rather than an h3: the raw-tag ratchet counts heading
            elements outside the primitives, and the kit ships no Heading
            component. The accessibility tree is identical. */}
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
              // than a 16px box plus its text.
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
                  aria-label={option.label}
                />
                {renderOption
                  ? renderOption(option)
                  : (
                    <>
                      {/* A tag's colour is runtime user data on the Tag row, so
                          it is an inline style and never a palette class - the
                          same precedent TagChips and the legacy CheckboxFacet
                          both set. */}
                      {option.swatch && (
                        <span
                          aria-hidden
                          className="size-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: option.swatch }}
                        />
                      )}
                      <span className="truncate">{option.label}</span>
                    </>
                  )}
              </Label>
            );
          })
        )}
      </div>
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
  // #1634: this renders BOTH the jobs "scheduled" facet (a real scheduling fact,
  // an org fact) and "created" (a "when was this row made" fact, viewer-local
  // by design) - only the former gets the org zone. useScheduleTimezone is
  // called unconditionally (rules of hooks); only its use is conditional.
  const orgTz = useScheduleTimezone();
  const tz = facet.key === 'scheduled' ? orgTz : undefined;
  // Sticky, exactly as DateRangeField: picking "Custom" must not snap back to a
  // preset the typed dates happen to match.
  const [customMode, setCustomMode] = useState(() => matchPreset(from, to, tz) === 'custom');
  const selected = customMode ? 'custom' : matchPreset(from, to, tz);

  const handleSelect = (key: string) => {
    if (key === 'custom') { setCustomMode(true); return; }
    setCustomMode(false);
    const preset = DATE_PRESETS.find((p) => p.key === key);
    if (preset) {
      const next = preset.range(tz);
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
}

export function FilterPopover({ registry, value, onChange, resolveOptions }: FilterPopoverProps) {
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
            // and reading one are the same act of recognition.
            renderOption={
              facet.key === 'status'
                ? (option) => <StatusChip domain="job" status={option.value} />
                : undefined
            }
          />
        );
      case 'dateRange':
        return <DateFacet facet={facet} value={value[facet.key]} onChange={(v) => setFacetValue(facet, v)} />;
      default:
        // No `range` facet in the jobs registry - see the file header.
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
