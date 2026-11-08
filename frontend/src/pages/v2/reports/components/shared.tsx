import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Download, Search, SlidersHorizontal, X } from 'lucide-react';

import { Button } from '@/ui-kit/components/ui/button';
import { Input } from '@/ui-kit/components/ui/input';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui-kit/components/ui/dropdownMenu';
import { SelectField } from '@/ui-kit/components/form/selectField';
import { cn } from '@/ui-kit/lib/utils';

/**
 * The report building blocks, on the kit.
 *
 * The pure ones - the deterministic PRNG, the delta pill and the inline
 * sparkline - are RE-EXPORTED from their shared homes (`@/lib/reports/random`
 * and `@/components/reports/ReportIndicators`) rather than copied. None
 * of them touches a `@/components/ui/...` primitive: `hashStr`/`mulberry32`/
 * `rangeRnd` are arithmetic, `Delta` is two spans and a lucide arrow, and
 * `Sparkline` is a bare `<svg>` whose stroke is a chart colour handed in by the
 * caller. Rebuilding them would fork logic for no gain, and recolouring the
 * sparkline would be a chart change, not a restyle.
 *
 * The interactive ones below are rebuilt, because each one was assembled from
 * the legacy Button, the legacy SelectField and raw `<button>`/`<input>` tags.
 */
export { hashStr, mulberry32, rangeRnd } from '@/lib/reports/random';
export { Delta, Sparkline } from '@/components/reports/ReportIndicators';
export type { FacetGroup } from '@/lib/reports/types';

import type { FacetGroup } from '@/lib/reports/types';

/** Lower-cased plural of a filter label ("Status" -> "statuses", "Rep" -> "reps"). */
function pluralLower(label: string): string {
  const l = label.toLowerCase();
  return /(s|x|z|ch|sh)$/.test(l) ? `${l}es` : `${l}s`;
}

/**
 * Multi-select dropdown filter; an empty selection means "all".
 *
 * The hand-rolled popover - a `useState` open flag, a ref and a `mousedown`
 * listener on `document` - is replaced wholesale by the kit's `DropdownMenu`,
 * which is the same Radix menu the app's own dropdown wraps. `onSelect`
 * defaults to closing the menu on Radix's checkbox item, so it is prevented
 * here to keep the legacy behaviour of ticking several options in one visit.
 */
export function MultiSelectFilter({
  label, options, selected, onChange,
}: {
  label: string;
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const toggle = (opt: string) =>
    onChange(selected.includes(opt) ? selected.filter((o) => o !== opt) : [...selected, opt]);

  const summary = selected.length === 0
    ? `All ${pluralLower(label)}`
    : `${selected.length} ${selected.length > 1 ? pluralLower(label) : label.toLowerCase()}`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          {summary}
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-72 w-56 overflow-y-auto">
        <DropdownMenuCheckboxItem
          checked={selected.length === 0}
          onCheckedChange={() => onChange([])}
          onSelect={(e) => e.preventDefault()}
        >
          All {pluralLower(label)}
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        {options.map((opt) => (
          <DropdownMenuCheckboxItem
            key={opt}
            checked={selected.includes(opt)}
            onCheckedChange={() => toggle(opt)}
            onSelect={(e) => e.preventDefault()}
          >
            {opt}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Faceted filter: one text field that shows the active selections as removable
 * chips and opens a multi-column picker.
 *
 * The kit's `crm/filterBar` is a row of independent single-select dropdowns
 * with no free-text field and no multi-column panel, so it cannot stand in
 * here; the panel is rebuilt out of kit primitives instead (ledger row). The
 * parent still owns per-facet state - this is a controlled presentation layer,
 * exactly as before.
 */
export function FacetFilter({
  groups, onToggle, onClear, placeholder = 'Filter results',
}: {
  groups: FacetGroup[];
  onToggle: (groupKey: string, value: string) => void;
  onClear: () => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const q = query.trim().toLowerCase();
  const chips = groups.flatMap((g) => g.selected.map((value) => ({ groupKey: g.key, label: g.label, value })));

  return (
    <div className="relative w-full" ref={ref}>
      <div
        onClick={() => setOpen(true)}
        className="flex min-h-10 w-full cursor-text flex-wrap items-center gap-1.5 rounded-md border border-input bg-kit-card px-2.5 py-1.5"
      >
        {chips.map((c) => (
          <span
            key={`${c.groupKey}:${c.value}`}
            className="bg-brand-subtle text-brand-emphasis inline-flex items-center gap-1 rounded-[5px] px-2 py-0.5 text-[11.5px] font-medium"
          >
            <span className="opacity-70">{c.label}:</span>
            {c.value}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-4"
              onClick={(e) => { e.stopPropagation(); onToggle(c.groupKey, c.value); }}
              aria-label={`Remove ${c.label} ${c.value}`}
            >
              <X />
            </Button>
          </span>
        ))}
        <Input
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          placeholder={chips.length === 0 ? placeholder : ''}
          className="h-6 min-w-[120px] flex-1 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
        />
        {chips.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={(e) => { e.stopPropagation(); onClear(); setQuery(''); }}
            aria-label="Clear all filters"
          >
            <X />
          </Button>
        )}
        <ChevronDown className="text-muted-foreground size-4 shrink-0" />
      </div>
      {open && (
        <div className="bg-kit-popover text-kit-popover-foreground z-30 absolute left-0 mt-1 flex w-full min-w-[680px] gap-3 overflow-x-auto rounded-lg border p-3 shadow-popover">
          {groups.map((g) => {
            const opts = q ? g.options.filter((o) => o.toLowerCase().includes(q)) : g.options;
            if (opts.length === 0) return null;
            return (
              <div key={g.key} className="min-w-[140px] flex-1">
                <p className="text-muted-foreground mb-1.5 px-1 text-[11px] font-semibold tracking-wide uppercase">{g.label}</p>
                <div className="max-h-64 space-y-0.5 overflow-y-auto">
                  {opts.map((o) => {
                    const active = g.selected.includes(o);
                    return (
                      <Button
                        key={o}
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => onToggle(g.key, o)}
                        className="w-full justify-between gap-2"
                        aria-pressed={active}
                      >
                        <span className="truncate">{o}</span>
                        {active && <Check className="shrink-0" />}
                      </Button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * The report list-toolbar. Two genuinely different shapes behind one export,
 * exactly as the legacy component had them:
 *
 *  - 'default' (Jobs/Leads/Sales): search box, rows-per-page, Export, Fields.
 *  - 'compact' (AR Aging/Invoices/Job Profitability/Payments/Weekly Rep
 *    Diagnostic): a single "Export CSV" button for `ReportShell`'s actions slot.
 *
 * On the kit both variants collapse to the same two Button sizes, so the
 * deliberate visual distinction the legacy comment defended (h-10/rounded-lg vs
 * h-9/rounded-md) is gone - the kit has one Button geometry per size rung and
 * radius is not a call-site decision. Recorded as a shape difference.
 */
type ReportToolbarDefaultProps = {
  variant?: 'default';
  search: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder?: string;
  pageSize: number;
  onPageSizeChange: (n: number) => void;
  pageSizeOptions: number[];
  onExport: () => void;
  exportLabel?: string;
  onFields?: () => void;
  fieldsLabel?: string;
  className?: string;
};

type ReportToolbarCompactProps = {
  variant: 'compact';
  onExport: () => void;
  className?: string;
};

export type ReportToolbarProps = ReportToolbarDefaultProps | ReportToolbarCompactProps;

export function ReportToolbar(props: ReportToolbarProps) {
  if (props.variant === 'compact') {
    return (
      <Button onClick={props.onExport} variant="outline" size="sm" className={props.className}>
        <Download />
        Export CSV
      </Button>
    );
  }

  const {
    search, onSearchChange, searchPlaceholder = 'Search',
    pageSize, onPageSizeChange, pageSizeOptions,
    onExport, exportLabel = 'Export', onFields, fieldsLabel = 'Fields', className,
  } = props;

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <div className="min-w-[200px] flex-1">
        <Input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
          startIcon={<Search className="size-4" />}
        />
      </div>
      <SelectField
        value={String(pageSize)}
        onValueChange={(v) => onPageSizeChange(Number(v))}
        aria-label="Rows per page"
        className="w-[84px]"
        options={pageSizeOptions.map((n) => ({ value: String(n), label: String(n) }))}
      />
      <Button onClick={onExport} variant="outline">
        <Download />
        {exportLabel}
      </Button>
      {onFields && (
        <Button onClick={onFields} variant="outline">
          <SlidersHorizontal />
          {fieldsLabel}
        </Button>
      )}
    </div>
  );
}

/**
 * The report pager, both legacy variants preserved.
 *
 * Kept rather than handed to the kit's `DataTablePagination`: these reports
 * page a DERIVED array in page state (a filtered, sorted, sliced projection of
 * mock or aggregated data), not a server response, and several of them page a
 * list that is not the table on the page. `page` is 0-indexed and
 * caller-clamped for both variants, as before.
 */
export interface ReportPagerProps {
  page: number;
  pageCount: number;
  pageSize: number;
  totalItems: number;
  onPageChange: (page: number) => void;
  variant?: 'default' | 'compact';
  emptyLabel?: string;
  className?: string;
}

export function ReportPager({
  page, pageCount, pageSize, totalItems, onPageChange,
  variant = 'default', emptyLabel = 'No results', className,
}: ReportPagerProps) {
  const compact = variant === 'compact';
  const start = page * pageSize;

  return (
    <div
      className={cn(
        'text-muted-foreground flex items-center justify-between',
        compact ? 'mt-3 text-xs' : 'text-sm',
        className,
      )}
    >
      <span>
        {compact && totalItems === 0
          ? emptyLabel
          : `Showing ${totalItems === 0 ? 0 : start + 1}-${Math.min(start + pageSize, totalItems)} of ${totalItems}`}
      </span>
      <div className="flex items-center gap-2">
        <Button
          onClick={() => onPageChange(Math.max(0, page - 1))}
          disabled={page === 0}
          variant="outline"
          size="sm"
        >
          Prev
        </Button>
        <span className="tabular-nums">
          {compact ? `Page ${page + 1} of ${pageCount}` : `${page + 1} / ${pageCount}`}
        </span>
        <Button
          onClick={() => onPageChange(Math.min(pageCount - 1, page + 1))}
          disabled={page + 1 >= pageCount}
          variant="outline"
          size="sm"
        >
          Next
        </Button>
      </div>
    </div>
  );
}

/**
 * The filter-panel trigger shared by Jobs/Leads/Sales: a full-width button that
 * reads "Select..." until something is picked and "N filters applied" after,
 * with the panel below it and an optional clear footer. The panel BODY differs
 * per report (its column count genuinely does), so it stays a `children` slot.
 *
 * Not the kit's `Popover`: the panel is a full-width block anchored to the
 * trigger's own width, and the three call sites drive `open` from their own
 * state so a KPI click can close it. Radix's Popover measures and portals,
 * which loses the width coupling.
 */
export interface ReportSelectTriggerProps {
  label: string;
  activeCount: number;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onClear?: () => void;
  children: ReactNode;
  className?: string;
}

export function ReportSelectTrigger({
  label, activeCount, open, onToggle, onClose, onClear, children, className,
}: ReportSelectTriggerProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [onClose]);

  return (
    <div className={cn('relative', className)} ref={ref}>
      <Button
        type="button"
        onClick={onToggle}
        variant="outline"
        size="lg"
        className="w-full justify-between"
      >
        <span className={activeCount ? undefined : 'text-muted-foreground'}>
          {activeCount ? `${activeCount} filter${activeCount > 1 ? 's' : ''} applied` : label}
        </span>
        <ChevronDown className="shrink-0" />
      </Button>
      {open && (
        <div className="bg-kit-popover text-kit-popover-foreground z-30 absolute left-0 mt-1 w-full overflow-hidden rounded-lg border shadow-popover">
          {children}
          {onClear && activeCount > 0 && (
            <div className="bg-muted flex items-center justify-between border-t px-4 py-2">
              <span className="text-muted-foreground text-xs">
                {activeCount} filter{activeCount > 1 ? 's' : ''} applied
              </span>
              <Button type="button" onClick={onClear} variant="link" size="sm">
                Clear all
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
