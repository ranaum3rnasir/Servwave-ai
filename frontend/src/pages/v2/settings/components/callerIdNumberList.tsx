import { useRef, useState, type Ref, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { Button } from '@/ui-kit/components/ui/button';
import { SearchInput } from '@/ui-kit/components/form/searchInput';
import { cn } from '@/ui-kit/lib/utils';

import { CallerIdTable, type CallerIdTableProps } from './callerIdTable';
import {
  callerIdCountLabel,
  filterCallerIdRows,
  pageOf,
  type CallerIdFilter,
} from './callerIdFinder';

const FILTERS: { value: CallerIdFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'unassigned', label: 'Nobody assigned' },
  { value: 'calls-only', label: 'Calls only' },
];

export interface CallerIdNumberListProps extends CallerIdTableProps {
  /** The search box, so the page can return focus to it when the row that
   *  had focus is no longer listed. */
  searchRef?: Ref<HTMLInputElement>;
}

/**
 * Caller ID slice 04: the numbers table with its toolbar (search, filter,
 * count) above and its pager below. It takes the whole list and owns the
 * search, filter and page; the table only ever gets the current page.
 */
export function CallerIdNumberList({ rows, onEdit, editButtonRef, searchRef }: CallerIdNumberListProps) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<CallerIdFilter>('all');
  const [requestedPage, setRequestedPage] = useState(1);

  const matches = filterCallerIdRows(rows, { query, filter });
  // Derived, not stored: a list that shrank under the current page (a save, a
  // refetch) lands on the last page that still has rows.
  const { page, pageCount, items } = pageOf(matches, requestedPage);
  const narrowed = query.trim() !== '' || filter !== 'all';

  const prevButton = useRef<HTMLButtonElement>(null);
  const nextButton = useRef<HTMLButtonElement>(null);
  // Reaching the first or last page disables the button just pressed, and a
  // disabled button drops keyboard focus to the page body. Render the new page
  // first, then hand focus to the other button.
  const goTo = (target: number, other: RefObject<HTMLButtonElement | null>) => {
    flushSync(() => setRequestedPage(target));
    if (target === 1 || target === pageCount) other.current?.focus();
  };

  return (
    <div className="space-y-3">
      <div role="search" className="flex flex-wrap items-center gap-2.5">
        <SearchInput
          ref={searchRef}
          aria-label="Search numbers"
          placeholder="Search by number, name or person"
          autoComplete="off"
          value={query}
          onValueChange={(next) => {
            setQuery(next);
            setRequestedPage(1);
          }}
          className="min-w-0 flex-[1_1_15rem]"
        />
        <div
          role="group"
          aria-label="Filter numbers"
          className="border-border bg-kit-card inline-flex rounded-md border p-0.5"
        >
          {FILTERS.map((f) => (
            <Button
              key={f.value}
              type="button"
              size="sm"
              variant={filter === f.value ? 'default' : 'ghost'}
              aria-pressed={filter === f.value}
              onClick={() => {
                setFilter(f.value);
                setRequestedPage(1);
              }}
              className={cn('px-2.5 sm:px-3', filter === f.value && 'shadow-none hover:shadow-none')}
            >
              {f.label}
            </Button>
          ))}
        </div>
        {/* Mounted with the first count, so a screen reader announces each
            change to it. */}
        <span
          data-testid="caller-id-count"
          aria-live="polite"
          aria-atomic="true"
          className="text-muted-foreground w-full text-[13px] sm:ml-auto sm:w-auto"
        >
          {callerIdCountLabel(matches.length, rows.length, narrowed)}
        </span>
      </div>

      <CallerIdTable
        rows={items}
        onEdit={onEdit}
        editButtonRef={editButtonRef}
        emptyMessage="No numbers match. Try a different search or filter."
      />

      {pageCount > 1 && (
        <nav
          aria-label="Pages of numbers"
          className="text-muted-foreground flex flex-wrap items-center justify-between gap-2 text-[13px]"
        >
          <span aria-live="polite" aria-atomic="true">
            Page {page} of {pageCount}
          </span>
          <span className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              ref={prevButton}
              aria-label="Previous page"
              disabled={page === 1}
              onClick={() => goTo(page - 1, nextButton)}
            >
              <ChevronLeft aria-hidden="true" />
              Previous
            </Button>
            <Button
              type="button"
              variant="outline"
              ref={nextButton}
              aria-label="Next page"
              disabled={page === pageCount}
              onClick={() => goTo(page + 1, prevButton)}
            >
              Next
              <ChevronRight aria-hidden="true" />
            </Button>
          </span>
        </nav>
      )}
    </div>
  );
}
