import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase, getAccessToken } from '@/lib/supabase';
import { useAuthStore } from '@/stores/auth.store';
import { NOTIFICATIONS_KEY } from '@/lib/api/notifications';

/**
 * Subscribes to the user's private Supabase realtime channel and triggers a
 * notifications refetch whenever the backend broadcasts `notifications.changed`.
 *
 * Also invalidates on window focus as a belt-and-suspenders fallback.
 *
 * Mount once from AppLayout (or the bell component). Does nothing when not authed.
 */
export function useNotificationRealtime(): void {
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const userId = user?.id ?? null;
  const orgId = user?.organization_id ?? null;

  useEffect(() => {
    if (!userId || !orgId) return;

    // Re-apply the current JWT so the private channel is authorised.
    const token = getAccessToken();
    if (token) {
      supabase.realtime.setAuth(token);
    }

    // Subscribe to the private per-user channel.
    const channel = supabase
      .channel(`org:${orgId}:user:${userId}`, { config: { private: true } })
      .on('broadcast', { event: 'notifications.changed' }, () => {
        queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
      })
      .subscribe();

    // Belt-and-suspenders: also refetch on window focus.
    const handleFocus = () => {
      queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
    };
    window.addEventListener('focus', handleFocus);

    return () => {
      supabase.removeChannel(channel);
      window.removeEventListener('focus', handleFocus);
    };
  }, [userId, orgId, queryClient]);
}
