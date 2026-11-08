/**
 * realtimePublish.ts — Supabase Realtime broadcast publisher
 *
 * Publishes a signal to each recipient's private channel so connected clients
 * know to refetch. The payload carries no content, only "something changed" —
 * the refetch goes back through the API, which is where row visibility is
 * enforced. That is the reason this is a BROADCAST rather than a
 * `postgres_changes` subscription: a client subscribed straight to the table
 * would bypass `commVisibilityWhere` (RLS enforces org isolation only, not the
 * per-role anchor scoping), so the server has to decide who hears what.
 *
 * Channel topic format: org:{organizationId}:user:{recipientId}. The Realtime
 * authorization policy on `realtime.messages` is
 * `topic LIKE 'org:%:user:' || auth.uid()`, so per-user topics are the only
 * ones a client can subscribe to — an org-wide topic would be rejected.
 *
 * Best-effort: one failure never stops the others. Never throws. Never calls
 * supabaseAdmin.auth.* (would poison the shared service-role client).
 */

import { supabaseAdmin } from '../../lib/supabase';
import { logger } from '../../lib/logger';

/** Fan a single broadcast event out to one private channel per recipient. */
async function publishToRecipients(
  event: string,
  recipientIds: string[],
  organizationId: string,
): Promise<void> {
  for (const recipientId of recipientIds) {
    const topic = `org:${organizationId}:user:${recipientId}`;
    try {
      const channel = supabaseAdmin.channel(topic, { config: { private: true } });
      try {
        await channel.send({
          type: 'broadcast',
          event,
          payload: { type: event },
        });
      } catch (err) {
        logger.warn(
          `realtimePublish: failed to publish ${event} for recipient ${recipientId} on topic ${topic} — skipping. err=${String(err)}`,
        );
      } finally {
        await supabaseAdmin.removeChannel(channel).catch(() => {/* cleanup failure swallowed */});
      }
    } catch {
      // outer guard: channel construction itself failed; nothing to clean up
    }
  }
}

export async function publishNotificationsChanged(
  recipientIds: string[],
  organizationId: string,
): Promise<void> {
  return publishToRecipients('notifications.changed', recipientIds, organizationId);
}

/**
 * Tell connected clients their EMAIL LIST is stale — separate from
 * `notifications.changed` so the Inbox does not refetch its whole message list
 * every time an unrelated notification (a job assignment, an overdue invoice)
 * fires. Same channel, different event.
 */
export async function publishEmailsChanged(
  recipientIds: string[],
  organizationId: string,
): Promise<void> {
  return publishToRecipients('emails.changed', recipientIds, organizationId);
}
