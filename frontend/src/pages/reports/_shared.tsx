import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Check, X, Search, Download, SlidersHorizontal } from 'lucide-react';
import { SelectField } from '@/components/form/SelectField';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { FacetGroup } from '@/lib/reports/types';

/**
 * Shared interactive building blocks for the legacy report pages: a
 * multi-select dropdown filter, a faceted filter, a toolbar, a pager and a
 * filter-panel trigger.
 *
 * The pure pieces that used to live here moved out so a report's data module
 * and the /v2 rebuilds can reach them without importing a page:
 * `hashStr`/`mulberry32`/`rangeRnd` -> `@/lib/reports/random`, `Delta` and
 * `Sparkline` -> `@/components/reports/ReportIndicators`, `FacetGroup` ->
 * `@/lib/reports/types`.
 */

// Lower-cased plural of a filter label ("Status" → "statuses", "Rep" → "reps").
function pluralLower(label: string): string {
  const l = label.toLowerCase();
  return /(s|x|z|ch|sh)$/.test(l) ? `${l}es` : `${l}s`;
}

// ── Multi-select dropdown filter (empty selection = "all") ────────────────────
export function MultiSelectFilter({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const toggle = (opt: string) =>
    onChange(selected.includes(opt) ? selected.filter((o) => o !== opt) : [...selected, opt]);

  const summary = selected.length === 0 ? `All ${pluralLower(label)}` : `${selected.length} ${selected.length > 1 ? pluralLower(label) : label.toLowerCase()}`;

  return (
    <div className="relative" ref={ref}>
      {/* variant="outline" tone="neutral" matches border/bg/hover exactly.
          size="3xs" is the closest rung (h-6/text-xs) to the original's
          ~28px/text-xs geometry - not exact, disclosed. Dropped, not
          restored: shadow-sm (no shadow slot on this cell) and font-medium
          (base ships font-semibold). outline/neutral sets no idle text
          colour, so {summary} keeps it on its own span - nothing in the
          ambient tree would otherwise supply text-text-primary. */}
      <Button
        type="button"
        onClick={() => setOpen((o) => !o)}
        variant="outline"
        tone="neutral"
        size="3xs"
        className="gap-1.5 px-2.5"
      >
        <span className="text-text-primary">{summary}</span>
        <ChevronDown className="h-3.5 w-3.5 text-text-secondary" />
      </Button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 max-h-72 w-56 overflow-auto rounded-lg border border-border bg-surface-light p-1 shadow-lg">
          {/* dropdown-menu-item / listbox-option row - not Button-shaped, left raw */}
          <button
            type="button"
            onClick={() => onChange([])}
            className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-xs font-medium text-text-primary hover:bg-background-light"
          >
            All {pluralLower(label)}
            {selected.length === 0 && <Check className="h-3.5 w-3.5 text-primary" />}
          </button>
          <div className="my-1 border-t border-border" />
          {options.map((opt) => (
            // dropdown-menu-item / listbox-option row - not Button-shaped, left raw
            <button
              key={opt}
              type="button"
              onClick={() => toggle(opt)}
              className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-xs text-text-primary hover:bg-background-light"
            >
              {opt}
              {selected.includes(opt) && <Check className="h-3.5 w-3.5 text-primary" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Workiz-style faceted filter ───────────────────────────────────────────────
// One "Filter results" input that shows active selections as removable chips and
// opens a multi-column picker (Category / Merchant / User / Card / With / Without).
// Parent owns the per-facet state; this is a controlled presentation layer.

export function FacetFilter({
  groups,
  onToggle,
  onClear,
  placeholder = 'Filter results',
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
        className="flex min-h-9 w-full cursor-text flex-wrap items-center gap-1.5 rounded-lg border border-border bg-surface-light px-2.5 py-1.5 focus-within:ring-2 focus-within:ring-primary/20"
      >
        {chips.map((c) => (
          <span key={`${c.groupKey}:${c.value}`} className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
            <span className="text-primary/60">{c.label}:</span>
            {c.value}
            {/* small close-X affordance inside a chip - not Button-shaped, left raw */}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onToggle(c.groupKey, c.value); }}
              className="rounded-full p-0.5 hover:bg-primary/20"
              aria-label={`Remove ${c.label} ${c.value}`}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          placeholder={chips.length === 0 ? placeholder : ''}
          className="h-6 min-w-[120px] flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-secondary focus:outline-none"
        />
        {chips.length > 0 && (
          // small close-X affordance - no Button size cell matches its ~24px
          // footprint (icon rung is 40px square, a real size grow) - left raw
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onClear(); setQuery(''); }}
            className="shrink-0 rounded p-1 text-text-secondary hover:bg-background-light"
            aria-label="Clear all filters"
          >
            <X className="h-4 w-4" />
          </button>
        )}
        <ChevronDown className="h-4 w-4 shrink-0 text-text-secondary" />
      </div>
      {open && (
        <div className="absolute left-0 z-30 mt-1 flex w-full min-w-[680px] gap-3 overflow-x-auto rounded-lg border border-border bg-surface-light p-3 shadow-lg">
          {groups.map((g) => {
            const opts = q ? g.options.filter((o) => o.toLowerCase().includes(q)) : g.options;
            if (opts.length === 0) return null;
            return (
              <div key={g.key} className="min-w-[140px] flex-1">
                <p className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">{g.label}</p>
                <div className="max-h-64 space-y-0.5 overflow-y-auto">
                  {opts.map((o) => {
                    const active = g.selected.includes(o);
                    return (
                      // dropdown-menu-item / listbox-option row - not Button-shaped, left raw
                      <button
                        key={o}
                        type="button"
                        onClick={() => onToggle(g.key, o)}
                        className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-background-light ${active ? 'font-medium text-primary' : 'text-text-primary'}`}
                      >
                        <span className="truncate">{o}</span>
                        {active && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                      </button>
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

// ── Report list-toolbar (search + rows-per-page + Export + Fields) ────────────
// Two genuinely distinct shapes share this export, switched on `variant`:
//  - 'default' (Jobs/Leads/Sales): the full row — search input, rows-per-page
//    SelectField, Export button, optional Fields button.
//  - 'compact' (AR Aging/Invoices/Job Profitability/Payments/Weekly Rep
//    Diagnostic): a single standalone "Export CSV" button dropped into
//    ReportShell's `actions` prop. It is a smaller h-9/rounded-md button with a
//    fixed label, not a shrunk version of the default row's Export button
//    (which is h-10/rounded-lg/"Export") — keep the two visually distinct.
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
      // variant="outline" tone="neutral" matches border/bg/hover exactly;
      // size="sm" matches h-9/px-3 exactly too. Dropped, not restored:
      // font-medium (base ships font-semibold) and rounded-md 6px (base
      // always ships rounded-button, 14px). outline/neutral sets no idle
      // text colour, so the icon + label carry text-text-primary directly -
      // nothing in the ambient tree (ReportShell's actions slot) supplies it.
      <Button
        onClick={props.onExport}
        variant="outline"
        tone="neutral"
        size="sm"
        className={cn('gap-1.5', props.className)}
      >
        <Download className="h-4 w-4 text-text-primary" />
        <span className="text-text-primary">Export CSV</span>
      </Button>
    );
  }

  const {
    search,
    onSearchChange,
    searchPlaceholder = 'Search',
    pageSize,
    onPageSizeChange,
    pageSizeOptions,
    onExport,
    exportLabel = 'Export',
    onFields,
    fieldsLabel = 'Fields',
    className,
  } = props;

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <div className="relative flex-1 min-w-[200px]">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
        <input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={searchPlaceholder}
          className="h-10 w-full rounded-lg border border-border pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
      </div>
      <SelectField
        aria-label="Rows per page"
        className="h-9"
        value={String(pageSize)}
        onValueChange={(v) => onPageSizeChange(Number(v))}
        options={pageSizeOptions.map((n) => ({ value: String(n), label: String(n) }))}
      />
      {/* variant="outline" tone="neutral" matches border/bg/hover exactly;
          size="default" (h-10) matches; className overrides px-4->px-3 and
          gap-2->gap-1.5 (both layout) to match the original exactly. Dropped,
          not restored: font-medium (base ships font-semibold) and rounded-lg
          6px (base always ships rounded-button, 14px). outline/neutral sets
          no idle text colour, so the icon + label carry text-text-primary
          directly - nothing in the ambient tree supplies it. */}
      <Button
        onClick={onExport}
        variant="outline"
        tone="neutral"
        className="gap-1.5 px-3"
      >
        <Download className="h-4 w-4 text-text-primary" />
        <span className="text-text-primary">{exportLabel}</span>
      </Button>
      {onFields && (
        <Button
          onClick={onFields}
          variant="outline"
          tone="neutral"
          className="gap-1.5 px-3"
        >
          <SlidersHorizontal className="h-4 w-4 text-text-primary" />
          <span className="text-text-primary">{fieldsLabel}</span>
        </Button>
      )}
    </div>
  );
}

// ── Report pager ────────────────────────────────────────────────────────────
// Two genuinely distinct pager styles share this export, switched on `variant`:
//  - 'default' (Jobs/Leads/Sales): text-sm "Showing X–Y of Z" + "N / total"
//    counter, px-3 py-1.5 buttons.
//  - 'compact' (Invoices/Payments): text-xs, an emptyLabel swapped in for the
//    "Showing" text when there are zero rows, "Page N of total" counter, and
//    tighter px-2.5 py-1 buttons with an explicit hover state. `page` is
//    always the caller-clamped 0-indexed page for both variants.
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
  page,
  pageCount,
  pageSize,
  totalItems,
  onPageChange,
  variant = 'default',
  emptyLabel = 'No results',
  className,
}: ReportPagerProps) {
  if (variant === 'compact') {
    const start = page * pageSize;
    return (
      <div className={cn('mt-3 flex items-center justify-between text-xs text-text-secondary', className)}>
        <span>
          {totalItems === 0 ? emptyLabel : `Showing ${start + 1}–${Math.min(start + pageSize, totalItems)} of ${totalItems}`}
        </span>
        <div className="flex items-center gap-1.5">
          {/* variant="outline" tone="neutral" matches border/bg/hover exactly;
              size="3xs" (h-6/text-xs) matches the original's ~24px/text-xs
              geometry; className overrides px-2->px-2.5 (layout) to match
              exactly. Dropped, not restored: font-medium (base ships
              font-semibold), rounded-md 6px (base always ships
              rounded-button, 14px), and disabled:opacity-40 (base ships its
              own disabled:opacity-50 - a real, if small, delta). The ambient
              wrapper (the "Showing..." row) supplies text-text-secondary, not
              text-text-primary, so the original explicit idle colour is kept
              on its own span rather than dropped to the ambient muted tone. */}
          <Button
            onClick={() => onPageChange(Math.max(0, page - 1))}
            disabled={page === 0}
            variant="outline"
            tone="neutral"
            size="3xs"
            className="px-2.5"
          >
            <span className="text-text-primary">Prev</span>
          </Button>
          <span>
            Page {page + 1} of {pageCount}
          </span>
          <Button
            onClick={() => onPageChange(Math.min(pageCount - 1, page + 1))}
            disabled={page >= pageCount - 1}
            variant="outline"
            tone="neutral"
            size="3xs"
            className="px-2.5"
          >
            <span className="text-text-primary">Next</span>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={cn('flex items-center justify-between text-sm text-text-secondary', className)}>
      <span>
        Showing {totalItems === 0 ? 0 : page * pageSize + 1}–{Math.min((page + 1) * pageSize, totalItems)} of {totalItems}
      </span>
      <div className="flex items-center gap-2">
        {/* variant="outline" tone="neutral" matches border/bg/hover exactly;
            size="sm"'s px-3 matches exactly, but the original set no explicit
            height (only py-1.5, implicit ~34px) - size="sm" now renders an
            explicit h-9 (36px), close but not exact, unlike the sites
            elsewhere in this file that already had a matching height class.
            Dropped, not restored: rounded-md 6px (base always ships
            rounded-button, 14px) and disabled:opacity-40 (base ships its own
            disabled:opacity-50 - a real, if small, delta). The original set
            no font-weight class at all (inherited normal 400 from the
            ambient text-sm row), so the base's font-semibold is a bigger,
            disclosed delta here than on the sites that already had
            font-medium. No idle text colour needed: neither button set one,
            so both already relied on (and still correctly inherit through)
            the ambient wrapper's text-text-secondary. */}
        <Button
          disabled={page === 0}
          onClick={() => onPageChange(Math.max(0, page - 1))}
          variant="outline"
          tone="neutral"
          size="sm"
        >
          Prev
        </Button>
        <span className="tabular-nums">
          {page + 1} / {pageCount}
        </span>
        <Button
          disabled={page + 1 >= pageCount}
          onClick={() => onPageChange(Math.min(pageCount - 1, page + 1))}
          variant="outline"
          tone="neutral"
          size="sm"
        >
          Next
        </Button>
      </div>
    </div>
  );
}

// ── Report filter-select trigger ───────────────────────────────────────────
// The FilterPanel trigger + chrome shared by Jobs/Leads/Sales: a bordered
// h-11 button that shows "Select…"/"Filter results" (or "N filters applied"
// once something's picked), an absolutely-positioned panel below it, outside-
// click-to-close, and an optional "N filters applied · Clear all" footer bar.
// The panel body itself (the filter grid, whose column count genuinely
// differs per report) is NOT part of this shape and stays a `children` slot.
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
  label,
  activeCount,
  open,
  onToggle,
  onClose,
  onClear,
  children,
  className,
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
      {/* variant="outline" tone="neutral" matches border/bg/hover exactly;
          size="lg" matches h-11 exactly; className overrides px-8->px-3 plus
          the w-full/justify-between layout (all layout-only). Dropped, not
          restored: shadow-sm (no shadow slot on this cell) and rounded-lg 6px
          (base always ships rounded-button, 14px). The original had no
          font-weight class (inherited normal 400) - base's font-semibold is
          a real, disclosed delta. outline/neutral sets no idle text colour
          and the original's own idle colour was the MUTED text-text-secondary
          - the inner span's empty-string fallback branch is filled in with
          text-text-secondary explicitly so the label doesn't render near-
          black once the button itself stops supplying it. */}
      <Button
        type="button"
        onClick={onToggle}
        variant="outline"
        tone="neutral"
        size="lg"
        className="w-full justify-between px-3"
      >
        <span className={activeCount ? 'text-text-primary' : 'text-text-secondary'}>
          {activeCount ? `${activeCount} filter${activeCount > 1 ? 's' : ''} applied` : label}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-text-secondary" />
      </Button>
      {open && (
        <div className="absolute left-0 z-30 mt-1 w-full overflow-hidden rounded-xl border border-border bg-surface-light shadow-lg">
          {children}
          {onClear && activeCount > 0 && (
            <div className="flex items-center justify-between border-t border-border bg-background-light px-4 py-2">
              <span className="text-xs text-text-secondary">
                {activeCount} filter{activeCount > 1 ? 's' : ''} applied
              </span>
              {/* variant="link" tone="brand" (text-primary + hover:underline)
                  is a byte-for-byte match of this button's original recipe.
                  size="3xs" is the closest rung (text-xs matches) but is not
                  an exact geometric match - the original had no padding/
                  height at all (content-sized inline text); 3xs's own h-6/
                  px-2 add a fixed 24px box and ~8px of horizontal padding
                  that were not there before, disclosed rather than fought
                  with layout overrides. Dropped, not restored: font-medium
                  (base ships font-semibold). */}
              <Button type="button" onClick={onClear} variant="link" tone="brand" size="3xs">
                Clear all
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
