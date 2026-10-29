import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, ListFilter } from 'lucide-react';

import { PRESETS as DATE_PRESETS, matchPreset } from '@/lib/date-range';
import type { StatusDomain } from '@/design-system/status-registry';
import type { FacetConfig, FacetOption, FilterState, FilterValue } from '@/lib/filters/types';
import { cn } from '@/ui-kit/lib/utils';
import { Badge } from '@/ui-kit/components/ui/badge';

import { DateField } from '@/ui-kit/components/form/dateField';
import { StatusChip } from './statusChip';
import { Button } from '@/ui-kit/components/ui/button';
import { Checkbox } from '@/ui-kit/components/ui/checkbox';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui-kit/components/ui/popover';
import { SelectField, type SelectFieldOption } from '@/ui-kit/components/form/selectField';
import {
  Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle,
} from '@/ui-kit/components/ui/sheet';
import {
  FILTER_COLLISION_PADDING, FILTER_CONTENT_HEIGHT, FILTER_SIDE_OFFSET, filterPlacement,
  type FilterPlacement,
} from '@/ui-kit/lib/filterPlacement';

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
 * Jobs, estimates, tasks and inventory use it too (mobile slice 64); their module copies are
 * deleted. What those lists vary arrives as a prop, never as a branch on the caller:
 *   - `renderOption` paints an option as something other than plain text (a module's own status
 *     chip, a second status-ish facet);
 *   - `renderFacet` swaps in a module's own pane for one facet (the tasks Category list, with
 *     its counts and colours);
 *   - `facetTimezones` gives a scheduling facet the org's zone.
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
  /** Paints an option as something other than plain text - see the status facet. `undefined` = plain. */
  renderOption?: (option: FacetOption) => ReactNode | undefined;
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
            className="text-brand hover:text-brand-emphasis -my-0.5 h-auto px-1.5 py-1 text-xs font-medium"
            onClick={allVisibleSelected ? deselectAllVisible : selectAllVisible}
          >
            {allVisibleSelected ? 'Clear all' : 'Select all'}
          </Button>
        )}
      </div>

      {showSearch && (
        <Input
          kind="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={`Search ${facet.label.toLowerCase()}...`}
          aria-label={`Search ${facet.label}`}
        />
      )}

      <div className="-mx-1.5 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain px-1.5">
        {visibleOptions.length === 0 ? (
          <p className="text-subtle-foreground py-6 text-center text-xs">
            No {facet.label.toLowerCase()} matches {`"${search}"`}
          </p>
        ) : (
          visibleOptions.map((option) => {
            const checked = selected.includes(option.value);
            const painted = renderOption?.(option);
            return (
              // The whole row is the label, so the hit target is the row rather
              // than a 16px box plus its text. A filter list is scanned and
              // clicked quickly; making people aim costs more than it saves.
              <Label
                key={option.value}
                htmlFor={`${rowId}-${option.value}`}
                className={cn(
                  // shrink-0: the list is a height-capped flex column, and rows without it were squeezed to
                  // about 21 px each, so their checkboxes covered one another (axe target-size).
                  'hover:bg-muted flex h-8 shrink-0 cursor-pointer items-center gap-2.5 rounded-md px-2 text-[13px] font-normal transition-colors',
                  checked && 'text-foreground font-medium',
                )}
              >
                <Checkbox
                  id={`${rowId}-${option.value}`}
                  checked={checked}
                  onCheckedChange={(c) => toggle(option.value, c === true)}
                  aria-label={option.label}
                />
                {painted ?? (
                  <>
                    {/* A tag's colour is runtime user data on the Tag row, so it is an inline
                        style and never a palette class. */}
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
          kind="quantity"
          min={domainMin}
          max={max}
          value={String(from)}
          onChange={(e) => handleFromChange(e.target.value)}
          aria-label={`${facet.label} From`}
        />
        <span className="text-muted-foreground">-</span>
        <Input
          kind="quantity"
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
  facet, value, onChange, tz,
}: {
  facet: FacetConfig;
  value: FilterValue | undefined;
  onChange: (next: FilterValue) => void;
  /** The org's zone, for a facet that is a scheduling fact. Undefined = the browser clock. */
  tz?: string;
}) {
  const from = value?.kind === 'dateRange' ? value.from : '';
  const to = value?.kind === 'dateRange' ? value.to : '';
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
          <DateField
            value={from}
            max={to || undefined}
            onChange={(v) => onChange({ kind: 'dateRange', from: v, to })}
            aria-label={`${facet.label} from`}
            className="min-w-0 flex-1"
          />
          <span className="text-muted-foreground">-</span>
          <DateField
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

export interface FacetControlContext {
  /** What the open panel shows for this facet: the draft on a phone sheet, the live value otherwise. */
  value: FilterValue | undefined;
  /** Writes this facet only, to the draft on a phone sheet and straight through otherwise. */
  onChange: (next: FilterValue) => void;
}

export interface FilterPopoverProps {
  /** STABLE reference - see `useFilterState`'s JSDoc. Never an inline literal. */
  registry: FacetConfig[];
  value: FilterState;
  onChange: (next: FilterState) => void;
  resolveOptions: (sourceId: string) => FacetOption[];
  /** Only a list with a `range` facet needs it (estimates' total). */
  resolveMax?: (sourceId: string) => number;
  /**
   * Which status vocabulary a facet keyed `status` is painted with. Pass this or `renderOption`
   * for a status facet: with neither, its options are plain text rather than a guessed palette.
   */
  statusDomain?: StatusDomain;
  /**
   * Paints a multi option as something other than plain text - a module's own status chip, or a
   * second status-ish facet. Return `undefined` to leave the option plain. Wins over `statusDomain`.
   */
  renderOption?: (facet: FacetConfig, option: FacetOption) => ReactNode | undefined;
  /**
   * Replaces one facet's pane. Return `undefined` to keep the standard control. It only runs for the
   * pane that is showing, so whatever it computes is taken only while someone is looking at it.
   */
  renderFacet?: (facet: FacetConfig, ctx: FacetControlContext) => ReactNode | undefined;
  /**
   * The org zone for a scheduling facet, by facet key (`{ scheduled: tz }`). A facet that is not
   * listed stays on the browser clock, as every list's "created" does.
   */
  facetTimezones?: Record<string, string | undefined>;
  /** A line under the title, e.g. how many of the list's rows the filter leaves showing. */
  subtitle?: string;
  /**
   * Applied constraints that live outside the facet list but belong to this filter: counted in the
   * button's badge, and cleared by `onClearAll`.
   */
  extraCount?: number;
  /** True when something outside the facet list is applied, so Clear all is offered for it too. */
  hasExtraConstraint?: boolean;
  /** Replaces Clear all's `onChange({})` when clearing must reach beyond the facet state. */
  onClearAll?: () => void;
}

/** The Filter button's rectangle and the window it sits in, read when the panel opens or the window resizes. */
function measurePlacement(trigger: HTMLElement | null): FilterPlacement {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const anchor = trigger?.getBoundingClientRect() ?? {
    top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0,
  };
  return filterPlacement({ viewport, anchor, contentHeight: FILTER_CONTENT_HEIGHT });
}

export function FilterPopover({
  registry, value, onChange, resolveOptions, resolveMax, statusDomain, renderOption, renderFacet,
  facetTimezones, subtitle, extraCount = 0, hasExtraConstraint = false, onClearAll,
}: FilterPopoverProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [placement, setPlacement] = useState<FilterPlacement>(() => measurePlacement(null));
  // Desktop: the facet beside the list. Phone: the facet drilled into, or null for the facet list.
  const [selectedKey, setSelectedKey] = useState<string | undefined>(registry[0]?.key);
  const [drillKey, setDrillKey] = useState<string | null>(null);
  // The phone sheet edits a draft and commits on Apply; the desktop popover edits live, as it always did.
  const [draft, setDraft] = useState<FilterState>(value);
  // Clear on the sheet empties the draft; whatever lives outside the facet list is cleared on Apply.
  const [draftCleared, setDraftCleared] = useState(false);

  const isSheet = placement.presentation === 'sheet';
  const shown = isSheet ? draft : value;
  const selectedFacet = registry.find((f) => f.key === selectedKey) ?? registry[0];

  const appliedCount = registry.reduce((sum, f) => sum + facetSelectionCount(value[f.key]), 0) + extraCount;
  const totalSelected = registry.reduce((sum, f) => sum + facetSelectionCount(shown[f.key]), 0);
  const activeFacetCount = registry.filter((f) => facetSelectionCount(shown[f.key]) > 0).length;

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setPlacement(measurePlacement(triggerRef.current));
      setDraft(value);
      setDraftCleared(false);
      setDrillKey(null);
    }
    setOpen(next);
  };

  // Rotating the phone or resizing the window re-decides popover versus sheet while it is open.
  useEffect(() => {
    if (!open) return undefined;
    const remeasure = () => setPlacement(measurePlacement(triggerRef.current));
    window.addEventListener('resize', remeasure);
    return () => window.removeEventListener('resize', remeasure);
  }, [open]);

  const setFacetValue = (facet: FacetConfig, next: FilterValue) => {
    if (isSheet) setDraft({ ...draft, [facet.key]: next });
    else onChange({ ...value, [facet.key]: next });
  };

  const clearAll = () => {
    if (isSheet) {
      setDraft({});
      setDraftCleared(true);
    } else if (onClearAll) onClearAll();
    else onChange({});
  };

  const apply = () => {
    if (draftCleared) onClearAll?.();
    onChange(draft);
    setOpen(false);
  };
  const canClear = totalSelected > 0 || (hasExtraConstraint && !draftCleared);

  const renderControl = (facet: FacetConfig) => {
    const custom = renderFacet?.(facet, {
      value: shown[facet.key],
      onChange: (v) => setFacetValue(facet, v),
    });
    if (custom !== undefined) return custom;
    switch (facet.kind) {
      case 'multi':
        return (
          <CheckboxFacet
            facet={facet}
            value={shown[facet.key]}
            onChange={(v) => setFacetValue(facet, v)}
            options={resolveFacetOptions(facet, resolveOptions)}
            // Statuses are painted as the badge the table shows, so picking one
            // and reading one are the same act of recognition. The kit's own
            // rule for StatusSelect: the options ARE the badge, so there is no
            // legend to memorise between here and the rows.
            renderOption={(option) => {
              const painted = renderOption?.(facet, option);
              if (painted !== undefined) return painted;
              return facet.key === 'status' && statusDomain
                ? <StatusChip domain={statusDomain} status={option.value} />
                : undefined;
            }}
          />
        );
      case 'range':
        return (
          <RangeFacet
            facet={facet}
            value={shown[facet.key]}
            onChange={(v) => setFacetValue(facet, v)}
            max={facet.maxSource && resolveMax ? resolveMax(facet.maxSource) : 0}
          />
        );
      case 'dateRange':
        return (
          <DateFacet
            facet={facet}
            value={shown[facet.key]}
            onChange={(v) => setFacetValue(facet, v)}
            tz={facetTimezones?.[facet.key]}
          />
        );
      default:
        return null;
    }
  };

  const summary = totalSelected === 0
    ? 'No filters applied'
    : `${totalSelected} selected across ${activeFacetCount} ${activeFacetCount === 1 ? 'filter' : 'filters'}`;

  const drillFacet = drillKey ? registry.find((f) => f.key === drillKey) : undefined;

  return (
    <>
      <Popover open={open && !isSheet} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <Button ref={triggerRef} variant="outline" size="sm" aria-expanded={open}>
            <ListFilter />
            Filter
            {appliedCount > 0 && <Badge variant="softBlue" size="pill">{appliedCount}</Badge>}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side={placement.side}
          sideOffset={FILTER_SIDE_OFFSET}
          collisionPadding={FILTER_COLLISION_PADDING}
          // The measured cap AND Radix's own live measurement: whichever is smaller wins, so the
          // panel stays inside a 720 px window and its list scrolls instead of leaving the screen.
          style={{ maxHeight: `min(${placement.maxHeight}px, var(--radix-popover-content-available-height))` }}
          className="flex w-[640px] max-w-[94vw] flex-col overflow-hidden p-0"
        >
          <div className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3">
            <div className="flex flex-col">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-semibold">Filters</span>
                {totalSelected > 0 && (
                  <Badge variant="softBlue" size="pill">{totalSelected}</Badge>
                )}
              </div>
              {subtitle && <span className="text-muted-foreground text-[11px]">{subtitle}</span>}
            </div>
            {/* Only offered when there is something to clear. A permanently
                visible destructive-ish action on an empty panel is noise. */}
            {canClear && (
              <Button
                variant="ghost"
                size="sm"
                className="h-auto px-1.5 py-0.5 text-xs font-medium"
                onClick={clearAll}
              >
                Clear all
              </Button>
            )}
          </div>

          {/* The box may shrink (min-h-0) when the window is short: the facet list and the value
              pane each scroll inside it, so the Done button is always on screen. */}
          <div className="grid h-[340px] min-h-0 flex-1 grid-cols-[188px_minmax(0,1fr)] overflow-hidden">
            <div role="tablist" aria-label="Filter facets" className="flex flex-col gap-0.5 overflow-y-auto overscroll-contain border-r p-2">
              {registry.map((facet) => {
                const count = facetSelectionCount(shown[facet.key]);
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
            <span className="text-muted-foreground text-xs">{summary}</span>
            <Button size="sm" onClick={() => handleOpenChange(false)}>Done</Button>
          </div>
        </PopoverContent>
      </Popover>

      {/* Below md (and on a phone held sideways): a bottom sheet. The facet list drills into ONE
          full-width value list, and Clear / Apply stay pinned under it. */}
      <Sheet open={open && isSheet} onOpenChange={(next) => { if (!next) handleOpenChange(false); }}>
        <SheetContent
          side="bottom"
          data-filter-sheet=""
          style={{ maxHeight: `${placement.maxHeight}px` }}
          className="max-h-none"
        >
          <SheetHeader className="flex-row items-center gap-2">
            {drillFacet && (
              <Button
                variant="ghost"
                size="sm"
                aria-label="Back to filters"
                className="-ml-2 shrink-0"
                onClick={() => setDrillKey(null)}
              >
                <ChevronLeft />
              </Button>
            )}
            <div className="min-w-0">
              <SheetTitle className="truncate">{drillFacet ? drillFacet.label : 'Filters'}</SheetTitle>
              <SheetDescription className="truncate">{summary}</SheetDescription>
            </div>
          </SheetHeader>

          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
            {drillFacet ? (
              <div className="flex min-h-0 flex-1 flex-col p-4">{renderControl(drillFacet)}</div>
            ) : (
              <ul aria-label="Filter facets" className="flex flex-col">
                {registry.map((facet) => {
                  const count = facetSelectionCount(shown[facet.key]);
                  return (
                    <li key={facet.key} className="border-b last:border-b-0">
                      <Button
                        variant="ghost"
                        onClick={() => setDrillKey(facet.key)}
                        className="flex h-auto min-h-12 rounded-none font-normal w-full items-center justify-between gap-3 px-4 py-2 text-left text-sm"
                      >
                        <span className="truncate">{facet.label}</span>
                        <span className="text-muted-foreground flex shrink-0 items-center gap-2">
                          {count > 0 && <Badge variant="softBlue" size="pill">{count}</Badge>}
                          <ChevronRight className="size-4" />
                        </span>
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <SheetFooter className="justify-between">
            <Button variant="ghost" onClick={clearAll} disabled={!canClear}>
              Clear
            </Button>
            <Button onClick={apply}>Apply</Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  );
}
