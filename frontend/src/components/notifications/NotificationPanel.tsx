import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { Skeleton } from '@/components/ui/skeleton';
import { useNotifications, useReadAll } from '@/lib/api/notifications';
import { groupNotifications } from './groupNotifications';
import { NotificationItem } from './NotificationItem';

// ---------------------------------------------------------------------------
// NotificationPanel
// ---------------------------------------------------------------------------

interface NotificationPanelProps {
  /**
   * When true the panel's "Notifications" heading is visually hidden.
   * Use in the Sheet branch where SheetTitle already provides the accessible
   * heading — avoids a visible double-heading while keeping a11y intact.
   */
  hideHeaderTitle?: boolean;
  /**
   * Fill a height-capped column (the phone bottom sheet) instead of capping
   * the list at 28rem: the list takes the room left under the header and
   * scrolls inside it, so the panel never outgrows the visible screen.
   */
  fill?: boolean;
}

export function NotificationPanel({ hideHeaderTitle = false, fill = false }: NotificationPanelProps) {
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useNotifications();
  const readAll = useReadAll();

  // Flatten pages → items
  const items = data?.pages.flatMap((p) => p.items) ?? [];
  const { needsAction, earlier } = groupNotifications(items);

  const isEmpty = !isLoading && items.length === 0;

  return (
    <div className={fill ? 'flex min-h-0 flex-1 flex-col' : 'flex flex-col'}>
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <Heading level={2} className={hideHeaderTitle ? 'sr-only' : undefined}>
          Notifications
        </Heading>
        {/* ghost/subtle matches the raw's idle text-text-secondary and hover:text-text-primary
            exactly. size={null} suppresses the default 40px box - the raw had no box-model
            classes at all, just text-xs sized to line-height. Two disclosed deltas: ghost/subtle
            adds hover:bg-background-light (no hover bg before), and the base text-sm font-semibold
            replaces the raw's text-xs font-medium (SOFT ratchet has no slack to restore it). */}
        <Button
          type="button"
          variant="ghost"
          tone="subtle"
          size={null}
          // Mobile slice 75: a 20 px line is under the 24 px WCAG 2.5.8 floor; the box grows to 24 and
          // the negative margin keeps the header row exactly as tall as it was.
          className="-my-0.5 min-h-6"
          onClick={() => readAll.mutate(undefined)}
          disabled={readAll.isPending || items.length === 0}
        >
          Mark all read
        </Button>
      </div>

      {/* Body */}
      <div
        data-slot="notification-list"
        className={fill ? 'min-h-0 flex-1 overflow-y-auto overscroll-contain' : 'overflow-y-auto max-h-[28rem]'}
      >
        {isLoading && (
          <div className="flex flex-col gap-3 px-4 py-3">
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </div>
        )}

        {isEmpty && (
          <p className="px-4 py-6 text-center text-sm text-text-secondary">
            You&apos;re all caught up.
          </p>
        )}

        {/* Needs action group */}
        {needsAction.length > 0 && (
          <section>
            <div className="sticky top-0 bg-surface-light px-4 py-1.5">
              <p className="text-xs font-semibold text-text-soft uppercase tracking-wide">
                ⚡ Needs action &middot; {needsAction.length}
              </p>
            </div>
            {needsAction.map((item) => (
              <NotificationItem key={item.id} item={item} />
            ))}
          </section>
        )}

        {/* Earlier group */}
        {earlier.length > 0 && (
          <section>
            <div className="sticky top-0 bg-surface-light px-4 py-1.5">
              <p className="text-xs font-semibold text-text-soft uppercase tracking-wide">
                Earlier
              </p>
            </div>
            {earlier.map((item) => (
              <NotificationItem key={item.id} item={item} />
            ))}
          </section>
        )}

        {/* Show earlier — keyset pagination */}
        {hasNextPage && (
          <div className="flex justify-center px-4 py-3 border-t">
            {/* Same ghost/subtle + size={null} recipe as "Mark all read" above - idle/hover
                colours match exactly, hover:bg-background-light and text-sm font-semibold are
                the same two disclosed deltas. */}
            <Button
              type="button"
              variant="ghost"
              tone="subtle"
              size={null}
              className="gap-1.5"
              onClick={() => void fetchNextPage()}
              disabled={isFetchingNextPage}
            >
              {isFetchingNextPage ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Loading…
                </>
              ) : (
                'Show earlier'
              )}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skeleton loading row
// ---------------------------------------------------------------------------

function SkeletonRow() {
  return (
    <div className="flex gap-3">
      <Skeleton className="h-8 w-8 shrink-0" />
      <div className="flex flex-1 flex-col gap-1.5">
        <Skeleton className="h-3.5 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    </div>
  );
}
