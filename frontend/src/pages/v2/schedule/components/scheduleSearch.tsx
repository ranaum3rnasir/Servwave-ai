import { useState, useRef, useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Wrench, Calendar, CalendarClock, Loader2, MapPin } from 'lucide-react';

import api from '@/lib/axios';
import { formatCurrency } from '@/lib/utils';
import { formatInstant, useScheduleTimezone } from '@/lib/schedule-tz';
import {
  type SearchResult, type SearchResponse, statusDotClass, statusLabel, highlightMatch,
} from '@/components/layout/search-shared';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { SearchInput } from '@/ui-kit/components/form/searchInput';
import { Separator } from '@/ui-kit/components/ui/separator';

import { EM } from '../glyphs';

export type { SearchResult } from '@/components/layout/search-shared';

interface ScheduleSearchProps {
  onSelect: (result: SearchResult) => void;
  dateRange: { start: Date; end: Date };
  placeholder?: string;
  className?: string;
}

const LISTBOX_ID = 'schedule-search-listbox';

const SECTION_CONFIG: Record<string, { icon: typeof Wrench; label: string }> = {
  job: { icon: Wrench, label: 'Jobs' },
  lead: { icon: Calendar, label: 'Walkthroughs' },
  'calendar-entry': { icon: CalendarClock, label: 'Events' },
};

/**
 * The sidebar's scoped search: `GET /api/search?scope=schedule`, debounced 300ms,
 * arrow-key navigable. Selecting a result jumps the calendar to that date and
 * pulses the event for 3 seconds. Jobs, Walkthroughs and Events (Slice 09) render
 * as their own sections, in that order.
 *
 * The query, its cache key, the >= 2 character gate, the 30s staleTime, the
 * section split and the 5-result cap notice are all unchanged. Two things moved:
 *
 * 1. The field is the kit's SearchInput, which owns the magnifier, the clear
 *    affordance and the debounce - so the local debounce effect is gone. The
 *    combobox ARIA is passed through and overrides the kit's default
 *    `role="searchbox"`: this control owns a listbox, so it is a combobox, not a
 *    plain search box. The `Search schedule...` placeholder is preserved because
 *    an e2e page object locates this field by it.
 *
 * 2. Each result row was a raw button element carrying `role="option"`; it is a
 *    div now. That is not only the raw-tag ratchet. Under the
 *    `aria-activedescendant` pattern the options MUST NOT be focusable - focus
 *    stays on the input and the input names the active option. A focusable
 *    option added a tab stop per result and let focus leave the input while
 *    `aria-activedescendant` still claimed it was there. Arrow keys and Enter are
 *    unchanged; they were always handled on the input, never on the rows.
 */
export default function ScheduleSearch({
  onSelect, dateRange, placeholder = 'Search schedule...', className = '',
}: ScheduleSearchProps) {
  const tz = useScheduleTimezone();
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);

  // API query - hardcoded scope=schedule, always sends dateRange
  const { data, isFetching } = useQuery<SearchResponse>({
    queryKey: ['schedule-search', debouncedQuery, dateRange.start.toISOString(), dateRange.end.toISOString()],
    queryFn: async () => {
      const { data } = await api.get('/api/search', {
        params: {
          q: debouncedQuery,
          scope: 'schedule',
          rangeStart: dateRange.start.toISOString(),
          rangeEnd: dateRange.end.toISOString(),
        },
      });
      return data;
    },
    enabled: debouncedQuery.length >= 2,
    staleTime: 30_000,
  });

  // Flatten results for keyboard nav - jobs + leads + calendar entries (Events), in section
  // render order. A bucket left out here renders rows that arrow-keys skip over entirely.
  const flatResults: SearchResult[] = data
    ? [...data.results.jobs, ...data.results.leads, ...data.results.calendarEntries]
    : [];

  const hasResults = flatResults.length > 0;
  const showDropdown = isOpen && debouncedQuery.length >= 2;

  // Precompute index map for O(1) lookup in render
  const indexMap = new Map(flatResults.map((r, i) => [r.id, i]));

  // Keep ref array in sync. Trimmed during render, not in an effect: React
  // attaches this render's row refs before any effect runs, so a trim deferred
  // to an effect would still leave the shrunk tail addressable in between - and
  // that tail is what `rowRefs.current[activeIndex]` scrolls to.
  // eslint-disable-next-line react-hooks/refs -- must trim before this render's ref callbacks attach; an effect runs after them
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate reset idiom: a new query invalidates the highlighted row index
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

  // The compiler declines to preserve this memo because `flatResults` is a fresh
  // array each render and it cannot prove nothing mutates it. Kept as written:
  // the deps are correct for the behaviour, and a rewrite here means reshaping
  // the keyboard-nav state, not deleting a `useCallback`.
  const handleKeyDown = useCallback(
    // eslint-disable-next-line react-hooks/preserve-manual-memoization -- deps are correct; compiler cannot prove `flatResults` is not mutated later
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
    // eslint-disable-next-line react-hooks/preserve-manual-memoization -- same site as above, reported a second time on the dependency itself
    [showDropdown, hasResults, flatResults, activeIndex, handleSelect],
  );

  function renderResultRow(result: SearchResult, globalIdx: number) {
    const isActive = globalIdx === activeIndex;
    const dot = result.status ? statusDotClass(result.entity_type, result.status) : null;
    const activeDescendantId = `schedule-result-${result.id}`;

    const meta: string[] = [];
    if (result.status) meta.push(statusLabel(result.entity_type, result.status));
    // Every `date` on this payload is a true instant, not a date-only day
    // (search.controller.ts .toISOString()s all three), so a bare
    // toLocaleDateString names the VIEWER's calendar day - a day out for any
    // instant at or after the org's UTC-offset boundary, while the board card
    // beside it is tz-pinned and disagrees. MV-TZ-09.
    if (result.date) {
      meta.push(formatInstant(result.date, tz, { year: 'numeric', month: 'numeric', day: 'numeric' }));
    }
    if (result.total != null) meta.push(formatCurrency(result.total));

    return (
      <div
        key={result.id}
        ref={(el) => { rowRefs.current[globalIdx] = el; }}
        id={activeDescendantId}
        role="option"
        aria-selected={isActive}
        className={`w-full cursor-pointer text-left px-3 py-2 transition-colors ${
          isActive ? 'bg-muted' : 'hover:bg-muted'
        }`}
        onMouseEnter={() => setActiveIndex(globalIdx)}
        onClick={() => handleSelect(result)}
      >
        <div className="flex items-start gap-2.5">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-[13px] font-semibold truncate">
                {highlightMatch(result.title, debouncedQuery)}
              </span>
            </div>
            <div className="flex items-center gap-1 mt-0.5 text-xs text-muted-foreground truncate">
              {result.subtitle && (
                <>
                  <span className="truncate">{highlightMatch(result.subtitle, debouncedQuery)}</span>
                  {meta.length > 0 && <span className="flex-shrink-0">&middot;</span>}
                </>
              )}
              {dot && <span className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${dot}`} />}
              {meta.length > 0 && (
                <span className="truncate flex-shrink-0">{meta.join(' · ')}</span>
              )}
            </div>
            {result.address && (
              <div className="flex items-center gap-1 mt-0.5 text-xs text-muted-foreground">
                <MapPin className="h-3 w-3 shrink-0" />
                <span className="truncate">{highlightMatch(result.address, debouncedQuery)}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  function renderSection(key: string, items: SearchResult[]) {
    if (!items.length) return null;
    const config = SECTION_CONFIG[key];
    if (!config) return null;
    return (
      <div key={key}>
        <div className="flex items-center gap-1.5 px-3 pt-3 pb-1.5 text-xs font-bold uppercase tracking-wide border-b mb-0.5">
          <config.icon className="h-3 w-3" />
          {config.label}
        </div>
        {items.map((r) => renderResultRow(r, indexMap.get(r.id) ?? -1))}
      </div>
    );
  }

  // Did any section hit the server cap (5 items)?
  const hitCap = data && [data.results.jobs, data.results.leads, data.results.calendarEntries].some((arr) => arr.length >= 5);

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <SearchInput
        ref={inputRef}
        value={query}
        onValueChange={(v) => {
          setQuery(v);
          // Clearing the field closes the dropdown at once rather than waiting
          // out the debounce - the same thing the legacy clear button did.
          if (v === '') {
            setDebouncedQuery('');
            setIsOpen(false);
          } else {
            setIsOpen(true);
          }
        }}
        onDebouncedChange={(v) => setDebouncedQuery(v.trim())}
        placeholder={placeholder}
        role="combobox"
        aria-expanded={showDropdown}
        aria-controls={LISTBOX_ID}
        aria-activedescendant={
          activeIndex >= 0 && flatResults[activeIndex]
            ? `schedule-result-${flatResults[activeIndex].id}`
            : undefined
        }
        aria-autocomplete="list"
        aria-haspopup="listbox"
        onFocus={() => setIsOpen(true)}
        onKeyDown={handleKeyDown}
      />

      {showDropdown && (
        <div
          id={LISTBOX_ID}
          role="listbox"
          className="absolute top-full left-0 right-0 mt-1 z-50 max-h-[420px] overflow-y-auto
                      rounded-xl border bg-kit-popover shadow-popover"
        >
          {isFetching && !hasResults ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : hasResults ? (
            <>
              <div className="py-1">
                {renderSection('job', data!.results.jobs)}
                {renderSection('lead', data!.results.leads)}
                {renderSection('calendar-entry', data!.results.calendarEntries)}
              </div>
              <Separator />
              <div className="px-3 py-2 text-[11px] text-muted-foreground">
                {hitCap
                  ? `5+ results ${EM} refine your search`
                  : `Showing ${flatResults.length} result${flatResults.length !== 1 ? 's' : ''}`}
              </div>
            </>
          ) : (
            <EmptyState title={`No results for “${debouncedQuery}”`} />
          )}
        </div>
      )}
    </div>
  );
}
