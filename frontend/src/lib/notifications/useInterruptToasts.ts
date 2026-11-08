import { useEffect, useRef } from 'react';
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useNotifications } from '@/lib/api/notifications';
import { toast } from '@/components/ui/use-toast';
import { ToastAction, type ToastActionElement } from '@/components/ui/toast';
import { notificationDeepLink } from '@/components/notifications/NotificationItem';
import type { NotificationView } from '@/lib/api/notifications';

/** Maximum INTERRUPT toasts fired for a single burst of new items. */
const MAX_BURST_TOASTS = 3;

/** Returns the max `created_at` across all items, or empty string if none. */
function maxCreatedAt(items: NotificationView[]): string {
  if (items.length === 0) return '';
  return items.reduce(
    (m, item) => (item.created_at > m ? item.created_at : m),
    '',
  );
}

/**
 * Fires a shadcn toast for every NEW unseen INTERRUPT-priority notification.
 *
 * Dedup logic:
 * - On first data load the ref is initialised to the current max `created_at`
 *   WITHOUT toasting — existing items on mount never toast.
 * - On subsequent data changes, items with `created_at > ref` AND
 *   `priority === 'INTERRUPT'` AND `seen_at == null` are toasted (capped at
 *   MAX_BURST_TOASTS newest). Then `ref` is advanced to the new max.
 * - FEED items are never toasted, regardless of seen/unseen state.
 *
 * Mount once from NotificationBell (alongside useNotificationRealtime).
 */
export function useInterruptToasts(): void {
  const { data } = useNotifications();
  const navigate = useNavigate();

  /**
   * Tracks the maximum `created_at` we have already processed.
   * `null` = not yet initialised (first load pending).
   */
  const lastSeenRef = useRef<string | null>(null);

  useEffect(() => {
    if (!data?.pages) return;

    // Defensive: a page may arrive without a well-formed `items` array (empty/partial
    // response, or an in-flight first page) — never let a passive effect white-screen.
    const items: NotificationView[] = data.pages
      .flatMap((p) => p?.items ?? [])
      .filter(Boolean);
    const currentMax = maxCreatedAt(items);

    // --- First load: initialise the watermark without toasting. ---
    if (lastSeenRef.current === null) {
      lastSeenRef.current = currentMax;
      return;
    }

    // --- Subsequent loads: find genuinely new INTERRUPT+unseen items. ---
    const watermark = lastSeenRef.current;

    const newInterrupts = items
      .filter(
        (item) =>
          item.priority === 'INTERRUPT' &&
          item.seen_at == null &&
          item.created_at > watermark,
      )
      // Newest first so we toast the most recent ones when capping.
      .sort((a, b) => (a.created_at > b.created_at ? -1 : 1));

    // Advance watermark first so a React StrictMode double-fire is harmless.
    if (currentMax > watermark) {
      lastSeenRef.current = currentMax;
    }

    // Cap at MAX_BURST_TOASTS (toast the newest ones).
    const toToast = newInterrupts.slice(0, MAX_BURST_TOASTS);

    for (const item of toToast) {
      const isDestructive = item.category === 'SECURITY' || item.needs_action;
      const deepLink = notificationDeepLink(item);

      // Use React.createElement since this is a .ts file (no JSX transform).
      // ToastActionElement = React.ReactElement<typeof ToastAction>; the cast
      // from ReactElement<any> is safe because ToastAction IS the component.
      const action = React.createElement(
        ToastAction,
        { altText: 'View', onClick: () => navigate(deepLink) },
        'View',
      ) as unknown as ToastActionElement;

      toast({
        title: item.title,
        description: item.body ?? undefined,
        variant: isDestructive ? 'destructive' : 'default',
        action,
      });
    }
  }, [data, navigate]);
}
