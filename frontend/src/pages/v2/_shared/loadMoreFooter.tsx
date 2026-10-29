import { useEffect, useRef } from 'react';

import { Button } from '@/ui-kit/components/ui/button';
import { Spinner } from '@/ui-kit/components/ui/spinner';

import { LoadError } from './loadError';

/**
 * The end of a list that loads one server page at a time (mobile slice 72).
 *
 * Scrolling the list to its end asks for the next page: a watcher on this element does it as it
 * comes within a screen of view. A visible "Load more" does the same thing by tap, for a reader
 * who cannot scroll (a keyboard, a switch) or a browser with no way to watch for the end - the
 * button is always there while pages remain, the scroll is only the shortcut.
 *
 * A failed page keeps the rows already loaded and says so here with a Retry, rather than turning
 * the whole list into an error.
 */
export function LoadMoreFooter({
  loaded, total, hasMore, loading, failed, onLoadMore, noun,
}: {
  /** Rows on screen. */
  loaded: number;
  /** Every row the filters match, across all pages. */
  total: number;
  hasMore: boolean;
  /** The next page is on its way. */
  loading: boolean;
  /** The next page failed. */
  failed: boolean;
  onLoadMore: () => void;
  /** Plural noun for the count line, e.g. "tasks". */
  noun: string;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  // A failed page is not retried by scrolling (it would loop on a dead connection); Retry is a tap.
  const watching = hasMore && !loading && !failed;

  useEffect(() => {
    const el = sentinel.current;
    if (!watching || !el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) onLoadMore(); },
      // A screen early, so the next page is usually there before the reader reaches the end.
      { rootMargin: '0px 0px 400px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [watching, onLoadMore, loaded]);

  // The last page is on screen: nothing to ask for, and the list's own count says how many there are.
  if (!hasMore && !failed) return null;

  return (
    <div data-slot="load-more" className="px-4 py-3">
      {failed ? (
        <LoadError title={`Couldn't load more ${noun}.`} onRetry={onLoadMore} retrying={loading} className="py-4" />
      ) : (
        <div className="flex flex-col items-center gap-2">
          <p className="text-muted-foreground text-[12px] tabular-nums" aria-live="polite">
            Showing {loaded} of {total} {noun}
          </p>
          <Button variant="outline" size="sm" onClick={onLoadMore} disabled={loading}>
            {loading && <Spinner size="sm" label={null} />}
            {loading ? 'Loading' : 'Load more'}
          </Button>
        </div>
      )}
      {/* The watched edge: after the button, so the reader reaches it by scrolling past the rows. */}
      <div ref={sentinel} aria-hidden className="h-px" />
    </div>
  );
}
