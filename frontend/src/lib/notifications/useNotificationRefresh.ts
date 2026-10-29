import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '@/stores/auth.store';
import { NOTIFICATIONS_KEY } from '@/lib/api/notifications';

/**
 * Refetches the notifications the moment the window regains focus.
 *
 * The bell's queries already poll every 30 s while the tab is showing (NOTIFICATIONS_POLL_MS in
 * lib/api/notifications.ts); this is the other half of "feels live": coming back to the tab shows
 * the current count at once instead of up to 30 s later. There is no live socket (mobile slice 75
 * follow-up): a failed socket makes every browser print the provider's address in the console.
 *
 * Mount once from the bell. Does nothing when not signed in.
 */
export function useNotificationRefresh(): void {
  const queryClient = useQueryClient();
  const userId = useAuthStore((s) => s.user?.id ?? null);

  useEffect(() => {
    if (!userId) return;
    const handleFocus = () => {
      queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
    };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [userId, queryClient]);
}
