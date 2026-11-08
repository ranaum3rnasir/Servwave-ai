import { useState, useRef, useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Search,
  X,
  Wrench,
  Calendar,
  Repeat,
  Loader2,
  MapPin,
} from 'lucide-react';
import api from '@/lib/axios';
import { formatCurrency } from '@/lib/utils';
import { formatExactDay } from '@/lib/format-date';
import { type SearchResult, type SearchResponse, statusDotClass, statusLabel, highlightMatch } from '@/components/layout/search-shared';
import { EmptyState } from '@/components/ui/empty-state';
import { toInstant, type WallClock } from '@/lib/schedule-tz';

export type { SearchResult } from '@/components/layout/search-shared';

// ─── Types ──────────────────────────────────────────────

interface ScheduleSearchProps {
  onSelect: (result: SearchResult) => void;
  dateRange: { start: WallClock; end: WallClock };
  /** The org's scheduling timezone — dateRange is wall-clock space and results display in it. */
  tz: string;
  placeholder?: string;
  className?: string;
}

// `SearchResult.date` is a union of columns, so its kind follows entity_type: a service
// plan's is next_due, a calendar day and not an instant, so it is read in UTC. Every other
// type sends a timestamp (job scheduled_start, lead walkthrough scheduled_at or created_at,
// estimate/invoice created_at).
//
// Those instants read in the ORG's zone, not the viewer's - the one place this board departs
// from format-date.ts's "instants render local" rule, because two people opening the same
// board from different countries have to see one schedule rather than each their own. The
// date-only branch is deliberately untouched by that: a UTC-midnight calendar day read in
// any zone but UTC shows the day before.
function resultDate(entityType: SearchResult['entity_type'], date: string, tz: string): string {
  return entityType === 'service-plan'
    ? formatExactDay(date, { month: 'numeric', day: 'numeric', year: 'numeric' })
    : new Date(date).toLocaleDateString('en-US', { timeZone: tz });
}

// ─── Constants ──────────────────────────────────────────

const LISTBOX_ID = 'schedule-search-listbox';

// The board's three schedulable types (scheduleModel.ts EventType), in sidebar-bucket order.
const SECTION_CONFIG: Record<string, { icon: typeof Wrench; label: string }> = {
  job:            { icon: Wrench,   label: 'Jobs' },
  lead:           { icon: Calendar, label: 'Walkthroughs' },
  'service-plan': { icon: Repeat,   label: 'Service Plans' },
};

// ─── Component ──────────────────────────────────────────

export default function ScheduleSearch({ onSelect, dateRange, tz, placeholder = 'Search schedule...', className = '' }: ScheduleSearchProps) {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Debounce
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  // dateRange is a WallClock window (the org-zone day/week/month boundary) — convert back
  // to the real instant before it leaves the browser, same as the scheduler's own fetch.
  const rangeStart = toInstant(dateRange.start, tz).toISOString();
  const rangeEnd = toInstant(dateRange.end, tz).toISOString();

  // API query — hardcoded scope=schedule, always sends dateRange
  const { data, isFetching } = useQuery<SearchResponse>({
    queryKey: ['schedule-search', debouncedQuery, rangeStart, rangeEnd],
    queryFn: async () => {
      const { data } = await api.get('/api/search', {
        params: {
          q: debouncedQuery,
          scope: 'schedule',
          rangeStart,
          rangeEnd,
        },
      });
      return data;
    },
    enabled: debouncedQuery.length >= 2,
    staleTime: 30_000,
  });

  // Flatten results for keyboard nav — the three board types, in section order
  const flatResults: SearchResult[] = data
    ? [...data.results.jobs, ...data.results.leads, ...data.results.servicePlans]
    : [];

  const hasResults = flatResults.length > 0;
  const showDropdown = isOpen && debouncedQuery.length >= 2;

  // Precompute index map for O(1) lookup in render
  const indexMap = new Map(flatResults.map((r, i) => [r.id, i]));

  // Keep ref array in sync
  rowRefs.current.length = flatResults.length;

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Reset active index on results change
  useEffect(() => {
    setActiveIndex(-1);
  }, [debouncedQuery]);

  // Scroll active item into view
  useEffect(() => {
    if (activeIndex >= 0 && rowRefs.current[activeIndex]) {
      rowRefs.current[activeIndex]!.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex]);

  const handleSelect = useCallback(
    (result: SearchResult) => {
      onSelect(result);
      setQuery('');
      setDebouncedQuery('');
      setIsOpen(false);
    },
    [onSelect],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!showDropdown || !hasResults) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => (i < flatResults.length - 1 ? i + 1 : 0));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => (i > 0 ? i - 1 : flatResults.length - 1));
      } else if (e.key === 'Enter' && activeIndex >= 0 && flatResults[activeIndex]) {
        e.preventDefault();
        handleSelect(flatResults[activeIndex]);
      } else if (e.key === 'Escape') {
        setIsOpen(false);
        inputRef.current?.blur();
      }
    },
    [showDropdown, hasResults, flatResults, activeIndex, handleSelect],
  );

  // ─── Render helpers ────────────────────────────────────

  function renderResultRow(result: SearchResult, globalIdx: number) {
    const isActive = globalIdx === activeIndex;
    const dot = result.status ? statusDotClass(result.entity_type, result.status) : null;
    const activeDescendantId = `schedule-result-${result.id}`;

    const meta: string[] = [];
    if (result.status) meta.push(statusLabel(result.entity_type, result.status));
    if (result.date) meta.push(resultDate(result.entity_type, result.date, tz));
    if (result.total != null) meta.push(formatCurrency(result.total));

    // Raw by design: an ARIA listbox `option` row (combobox result), a list-row
    // click target, not a Button.
    return (
      <button
        key={result.id}
        ref={(el) => { rowRefs.current[globalIdx] = el; }}
        id={activeDescendantId}
        role="option"
        aria-selected={isActive}
        className={`w-full text-left px-3 py-2 transition-colors ${
          isActive ? 'bg-background-light' : 'hover:bg-background-light'
        }`}
        onMouseEnter={() => setActiveIndex(globalIdx)}
        onClick={() => handleSelect(result)}
      >
        <div className="flex items-start gap-2.5">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-medium text-text-primary truncate">
                {highlightMatch(result.title, debouncedQuery)}
              </span>
            </div>
            <div className="flex items-center gap-1 mt-0.5 text-xs text-text-secondary truncate">
              {result.subtitle && (
                <>
                  <span className="truncate">{highlightMatch(result.subtitle, debouncedQuery)}</span>
                  {meta.length > 0 && <span className="flex-shrink-0">·</span>}
                </>
              )}
              {dot && <span className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${dot}`} />}
              {meta.length > 0 && (
                <span className="truncate flex-shrink-0">{meta.join(' · ')}</span>
              )}
            </div>
            {/* Address line */}
            {result.address && (
              <div className="flex items-center gap-1 mt-0.5 text-xs text-text-secondary">
                <MapPin className="h-3 w-3 shrink-0" />
                <span className="truncate">{highlightMatch(result.address, debouncedQuery)}</span>
              </div>
            )}
          </div>
        </div>
      </button>
    );
  }

  function renderSection(key: string, items: SearchResult[]) {
    if (!items.length) return null;
    const config = SECTION_CONFIG[key];
    if (!config) return null;
    return (
      <div key={key}>
        <div className="flex items-center gap-1.5 px-3 pt-3 pb-1.5 text-xs font-bold text-text-primary uppercase tracking-wide border-b border-border/40 mb-0.5">
          <config.icon className="h-3 w-3" />
          {config.label}
        </div>
        {items.map((r) => renderResultRow(r, indexMap.get(r.id) ?? -1))}
      </div>
    );
  }

  // Check if any section hit the server cap (5 items)
  const hitCap = data && [data.results.jobs, data.results.leads, data.results.servicePlans].some((arr) => arr.length >= 5);

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      {/* Input */}
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded={showDropdown}
          aria-controls={LISTBOX_ID}
          aria-activedescendant={activeIndex >= 0 && flatResults[activeIndex] ? `schedule-result-${flatResults[activeIndex].id}` : undefined}
          aria-autocomplete="list"
          aria-haspopup="listbox"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className="h-9 w-full rounded-lg border border-border bg-background-light pl-9 pr-8 text-sm
                     text-text-primary placeholder:text-text-secondary outline-none
                     focus:border-primary/40 focus:ring-1 focus:ring-primary/20 focus:bg-surface-light transition-colors"
        />
        {/* Raw by design: a small close-X affordance absolutely positioned inside
            the search input, the same shape as a chip/toast dismiss control. */}
        {query && (
          <button
            onClick={() => { setQuery(''); setDebouncedQuery(''); setIsOpen(false); }}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-text-secondary hover:text-text-primary"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Dropdown */}
      {showDropdown && (
        <div
          id={LISTBOX_ID}
          role="listbox"
          className="absolute top-full left-0 right-0 mt-1 z-50 max-h-[420px] overflow-y-auto
                      rounded-xl border border-border bg-surface-light shadow-lg"
        >
          {isFetching && !hasResults ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-4 w-4 animate-spin text-text-secondary" />
            </div>
          ) : hasResults ? (
            <>
              <div className="py-1 divide-y divide-border/30">
                {renderSection('job', data!.results.jobs)}
                {renderSection('lead', data!.results.leads)}
                {renderSection('service-plan', data!.results.servicePlans)}
              </div>
              <div className="px-3 py-2 text-[11px] text-text-secondary border-t border-border/40">
                {hitCap
                  ? '5+ results — refine your search'
                  : `Showing ${flatResults.length} result${flatResults.length !== 1 ? 's' : ''}`}
              </div>
            </>
          ) : (
            <EmptyState density="compact" title={`No results for “${debouncedQuery}”`} />
          )}
        </div>
      )}
    </div>
  );
}
