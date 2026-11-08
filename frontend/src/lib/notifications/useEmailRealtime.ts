import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase, getAccessToken } from '@/lib/supabase';
import { useAuthStore } from '@/stores/auth.store';

/**
 * Refetch the email list the moment a customer replies, instead of waiting for
 * the query to go stale.
 *
 * Subscribes to the SAME private per-user channel the notification bell uses
 * (`org:{orgId}:user:{userId}`) but a different event: the backend pushes
 * `emails.changed` alongside `notifications.changed` when an inbound reply
 * lands. Two events rather than one so the Inbox does not refetch its whole
 * message list every time an unrelated notification fires.
 *
 * WHY A BROADCAST AND NOT A TABLE SUBSCRIPTION. A `postgres_changes`
 * subscription on `emails` would bypass the API's row-level visibility
 * (`commVisibilityWhere`) - the RLS policy enforces org isolation only, and it
 * keys off a session variable the backend sets on its own connection, so a
 * client subscription would match nothing anyway. The broadcast carries no
 * message content: it says "refetch", and the refetch goes back through the
 * API, which is where visibility is decided.
 *
 * Mount from the Inbox. The BELL is what has to work app-wide, and
 * useNotificationRealtime (mounted in Header) already covers that - this hook
 * only keeps an open message list fresh.
 */
export function useEmailRealtime(): void {
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const userId = user?.id ?? null;
  const orgId = user?.organization_id ?? null;

  useEffect(() => {
    if (!userId || !orgId) return;

    // Re-apply the current JWT so the private channel is authorised. The
    // Realtime policy is `topic LIKE 'org:%:user:' || auth.uid()`, so this is
    // what makes the subscription legal at all.
    const token = getAccessToken();
    if (token) {
      supabase.realtime.setAuth(token);
    }

    const invalidate = () => {
      queryClient.invalidateQueries({ queryKey: ['communication', 'emails'] });
    };

    const channel = supabase
      .channel(`org:${orgId}:user:${userId}`, { config: { private: true } })
      .on('broadcast', { event: 'emails.changed' }, invalidate)
      .subscribe();

    // Belt-and-suspenders, mirroring useNotificationRealtime: the app sets
    // refetchOnWindowFocus:false globally, so without this a reply that arrived
    // while the tab was backgrounded (or while the socket was dropped) would
    // stay invisible until the 5-minute staleTime expired.
    window.addEventListener('focus', invalidate);

    return () => {
      supabase.removeChannel(channel);
      window.removeEventListener('focus', invalidate);
    };
  }, [userId, orgId, queryClient]);
}
