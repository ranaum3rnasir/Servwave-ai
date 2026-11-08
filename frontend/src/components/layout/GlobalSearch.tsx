import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Search,
  X,
  Briefcase,
  User,
  Filter,
  FileText,
  Loader2,
  MapPin,
} from 'lucide-react';
import api from '@/lib/axios';
import { formatCurrency } from '@/lib/utils';
import { formatExactDay } from '@/lib/format-date';
import { type SearchResult, type SearchResponse, statusDotClass, statusLabel, highlightMatch } from './search-shared';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import { EmptyState } from '@/components/ui/empty-state';

// Re-export for backwards compat
export type { SearchResult } from './search-shared';

// ─── Types ──────────────────────────────────────────────

interface GlobalSearchProps {
  onSelect?: (result: SearchResult) => void;
  placeholder?: string;
  className?: string;
}

// `SearchResult.date` is a union of columns, so its kind follows entity_type: a service
// plan's is next_due, a calendar day and not an instant, so it is read in UTC. Every other
// type sends a timestamp (job scheduled_start, lead walkthrough scheduled_at or created_at,
// estimate/invoice created_at), which stays in local time.
function resultDate(entityType: SearchResult['entity_type'], date: string): string {
  return entityType === 'service-plan'
    ? formatExactDay(date, { month: 'numeric', day: 'numeric', year: 'numeric' })
    : new Date(date).toLocaleDateString('en-US');
}

// ─── Constants ──────────────────────────────────────────

const LISTBOX_ID = 'global-search-listbox';

const ENTITY_CONFIG: Record<string, { icon: typeof Briefcase; label: string; path: string }> = {
  job:      { icon: Briefcase, label: 'Jobs',      path: '/jobs' },
  customer: { icon: User,      label: 'Customers', path: '/customers' },
  lead:     { icon: Filter,    label: 'Leads',     path: '/leads' },
  estimate: { icon: FileText,  label: 'Estimates', path: '/estimates' },
};

// ─── Component ──────────────────────────────────────────

export default function GlobalSearch({ onSelect, placeholder = 'Search...', className = '' }: GlobalSearchProps) {
  const navigate = useNavigate();
  const requestLeave = useSettingsGuard((s) => s.requestLeave);
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

  // API query
  const { data, isFetching } = useQuery<SearchResponse>({
    queryKey: ['global-search', debouncedQuery],
    queryFn: async () => {
      const { data } = await api.get('/api/search', { params: { q: debouncedQuery } });
      return data;
    },
    enabled: debouncedQuery.length >= 2,
    staleTime: 30_000,
  });

  // Flatten results for keyboard nav
  const flatResults: SearchResult[] = data
    ? [
        ...data.results.jobs,
        ...data.results.customers,
        ...data.results.leads,
        ...data.results.estimates,
      ]
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
      if (onSelect) {
        onSelect(result);
      } else {
        const config = ENTITY_CONFIG[result.entity_type];
        if (config) requestLeave(() => navigate(`${config.path}/${result.id}`));
      }
      setQuery('');
      setDebouncedQuery('');
      setIsOpen(false);
    },
    [onSelect, navigate, requestLeave],
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

  // No Ctrl+F / Cmd+F binding. It used to focus this field and call
  // preventDefault, which took the browser's own find-on-page away from every
  // screen in the app - the one shortcut a user is most certain of. The hint
  // that advertised it came out with it, since a hint for a key that no longer
  // does anything is worse than no hint.

  // ─── Render helpers ────────────────────────────────────

  function renderResultRow(result: SearchResult, globalIdx: number) {
    const isActive = globalIdx === activeIndex;
    const dot = result.status ? statusDotClass(result.entity_type, result.status) : null;
    const activeDescendantId = `search-result-${result.id}`;

    const meta: string[] = [];
    if (result.status) meta.push(statusLabel(result.entity_type, result.status));
    if (result.date) meta.push(resultDate(result.entity_type, result.date));
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
            {/* Line 1: Title */}
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-medium text-text-primary truncate">
                {highlightMatch(result.title, debouncedQuery)}
              </span>
            </div>
            {/* Line 2: Subtitle + metadata */}
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
            {/* Line 3: Address */}
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
    const config = ENTITY_CONFIG[key];
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
  const hitCap = data && Object.values(data.results).some((arr) => arr.length >= 5);

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
          aria-activedescendant={activeIndex >= 0 && flatResults[activeIndex] ? `search-result-${flatResults[activeIndex].id}` : undefined}
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
                     focus:border-primary/40 focus:ring-2 focus:ring-primary/20 focus:bg-surface-light transition-colors"
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
                {renderSection('customer', data!.results.customers)}
                {renderSection('lead', data!.results.leads)}
                {renderSection('estimate', data!.results.estimates)}
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
