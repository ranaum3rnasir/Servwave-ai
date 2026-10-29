import type { NotificationView } from '@/lib/api/notifications';

export interface GroupedNotifications {
  needsAction: NotificationView[];
  earlier: NotificationView[];
}

/**
 * Partitions a flat notification list into two display groups:
 *
 * - `needsAction` — items where `needs_action === true` AND `acted_at == null`.
 *   These are pinned at the top of the panel. Sorted newest-first.
 *
 * - `earlier` — everything else (informational items, or action items that
 *   have already been acted on). Sorted newest-first.
 */
export function groupNotifications(items: NotificationView[]): GroupedNotifications {
  const needsAction: NotificationView[] = [];
  const earlier: NotificationView[] = [];

  for (const item of items) {
    if (item.needs_action && item.acted_at == null) {
      needsAction.push(item);
    } else {
      earlier.push(item);
    }
  }

  const byNewest = (a: NotificationView, b: NotificationView) =>
    new Date(b.created_at).getTime() - new Date(a.created_at).getTime();

  needsAction.sort(byNewest);
  earlier.sort(byNewest);

  return { needsAction, earlier };
}
