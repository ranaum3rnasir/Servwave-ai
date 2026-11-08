/**
 * TrackedItemSearch — the debounced tracked-item search dropdown shared by the Logistic Order
 * line picker (LOLinePicker) and the service-plan "Default materials" section (LO-5).
 *
 * Hits the browse endpoint with track_inventory=true (listPriceBookItems(q, { trackedOnly:true }))
 * so only stocked, in-catalog items come back carrying both sku and name — unlike `/search`, whose
 * Prisma `select` omits both. It owns its own query state, hands the chosen item to `onPick`, then
 * clears itself so the next search starts fresh.
 */
import { useEffect, useRef, useState } from 'react';
import { Search, Loader2 } from 'lucide-react';
import { listPriceBookItems, type PriceBookItem } from '@/lib/api/invoices';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/empty-state';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';

export interface TrackedItemSearchProps {
  /** Called with the chosen catalog item; the component clears its own query afterward. */
  onPick: (item: PriceBookItem) => void;
  placeholder?: string;
}

export function TrackedItemSearch({ onPick, placeholder }: TrackedItemSearchProps) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [results, setResults] = useState<PriceBookItem[]>([]);
  const [searching, setSearching] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    if (!debounced) {
      setResults([]);
      setSearching(false);
      return;
    }
    let active = true;
    setSearching(true);
    listPriceBookItems(debounced, { trackedOnly: true })
      .then((items) => {
        if (active) setResults(items);
      })
      .catch(() => {
        if (active) setResults([]);
      })
      .finally(() => {
        if (active) setSearching(false);
      });
    return () => {
      active = false;
    };
  }, [debounced]);

  const showResults = debounced.length > 0;

  const pick = (item: PriceBookItem) => {
    onPick(item);
    setQuery('');
    setDebounced('');
    setResults([]);
  };

  return (
    // onOpenChange fires on Escape and outside-click too, not just a result pick - without
    // it Radix's DismissableLayer swallows Escape without clearing anything, which would
    // stop the surrounding Dialog's own Escape-to-close from ever seeing the key.
    <Popover
      open={showResults}
      onOpenChange={(open) => {
        if (!open) {
          setQuery('');
          setDebounced('');
          setResults([]);
        }
      }}
    >
      <PopoverAnchor asChild>
        <div ref={anchorRef} className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
          <Input
            aria-label="Search tracked items"
            placeholder={placeholder ?? 'Search tracked items by name or SKU…'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9"
          />
          {searching && (
            <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-text-secondary" />
          )}
        </div>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        pad={0}
        className="max-h-64 w-[--radix-popover-trigger-width] overflow-auto"
        onOpenAutoFocus={(e) => e.preventDefault()}
        // There is no PopoverTrigger (the anchor is the input, not a trigger button), so
        // Radix's own trigger-click exception never fires and a click back into the input
        // reads as an outside interaction, closing the popover and wiping the query via
        // onOpenChange above. Guard it the same way Radix would for a real trigger.
        onInteractOutside={(e) => {
          if (anchorRef.current?.contains(e.target as Node)) {
            e.preventDefault();
          }
        }}
        // This list is portalled outside the surrounding Dialog's own scroll container, but
        // react-remove-scroll's lock still catches its wheel events - see
        // pages/v2/_shared/timeCombobox.tsx's identical guard.
        onWheel={(e) => e.stopPropagation()}
      >
        {results.length === 0 && !searching ? (
          <EmptyState density="flush" title="No tracked items match." />
        ) : (
          <ul>
            {results.map((item) => (
              <li key={item.id}>
                {/* Not converted to Button: dropdown/search-result
                    list-row target. */}
                <button
                  type="button"
                  onClick={() => pick(item)}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-background-light"
                >
                  <span className="min-w-0 truncate text-text-primary">{item.name}</span>
                  {item.sku && (
                    <code className="shrink-0 font-mono text-xs text-text-secondary">
                      {item.sku}
                    </code>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
