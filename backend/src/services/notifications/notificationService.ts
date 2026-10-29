/**
 * notificationService.ts — emit() orchestrator
 *
 * Ties together templates, resolveRecipients, roleHolders, and the DB writes
 * to create a Notification event row + NotificationRecipient rows per resolved
 * recipient. Always resolves — errors are swallowed and logged as warnings so
 * a failed notification never breaks the parent action.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { isKnownVerb, renderTemplate } from './templates';
import { resolveRecipients } from './resolveRecipients';
import { loadRoleHolders } from './roleHolders';
import { publishNotificationsChanged } from './realtimePublish';
import { filterRecipientsByAccess } from './filterByAccess';

// ── public interface ──────────────────────────────────────────────────────────

export interface EmitArgs {
  verb: string;
  organizationId: string;
  actorId: string | null;
  /** The primary object this notification is about. */
  object: { type: string; id: string; label?: string };
  /** Pre-loaded entity relations needed by resolveRecipients (assignees, owners, etc). */
  entity: Record<string, any>;
  /** Extra display data merged into Notification.data. */
  data?: Record<string, any>;
  /** Idempotency key — duplicate emits with the same key are no-ops. */
  dedupKey?: string;
  /** Optional: run inside the caller's existing transaction. */
  tx?: Prisma.TransactionClient;
}

// ── main export ───────────────────────────────────────────────────────────────

/**
 * Emit a notification for a verb/object pair.
 *
 * Best-effort: never throws. Any downstream failure is caught, logged as a
 * warning, and swallowed so the caller's business action is unaffected.
 *
 * Returns the recipient ids actually notified — after the row-scope filter and
 * the actor drop — or [] on any skip or failure. A caller that wants to push a
 * SECOND signal to the same people (the inbox-list refresh riding alongside an
 * inbound-email notification) reuses this rather than re-resolving recipients,
 * so the two sets cannot drift apart.
 */
export async function emit(args: EmitArgs): Promise<string[]> {
  // Step 1: Silently skip deferred / unknown verbs — they're expected.
  if (!isKnownVerb(args.verb)) return [];

  // Step 2: Wrap everything in a try/catch — swallow ALL errors.
  try {
    // Step 3: Resolve the Prisma client (transaction-aware).
    const client = args.tx ?? prisma;

    // Step 4: Build the data bag and render the template.
    const data = { ...(args.data ?? {}), object_label: args.object.label };
    const tpl = renderTemplate(args.verb, data);

    // Step 5: Dedup — idempotent on dedup_key.
    if (args.dedupKey) {
      const existing = await client.notification.findFirst({
        where: { organization_id: args.organizationId, dedup_key: args.dedupKey },
      });
      if (existing) return [];
    }

    // Step 6: Load role holders if not pre-supplied.
    const roleHolders =
      args.entity?.roleHolders ?? (await loadRoleHolders(args.organizationId, client));

    // Step 7: Resolve recipients (pure).
    const specs = resolveRecipients({
      verb: args.verb,
      organizationId: args.organizationId,
      actorId: args.actorId,
      entity: args.entity ?? {},
      roleHolders,
    });

    // Step 8: Row-scope filter — drop recipients who cannot access the object row.
    const allowed = await filterRecipientsByAccess(
      args.object.type,
      args.object.id,
      specs.map((s) => s.userId),
      args.organizationId,
    );
    const finalSpecs = specs.filter((s) => allowed.includes(s.userId));

    // Step 9: Nothing to do if no recipients.
    if (finalSpecs.length === 0) return [];

    // Step 10: Create the EVENT row. object_type comes from the template (authoritative).
    const notif = await client.notification.create({
      data: {
        organization_id: args.organizationId,
        actor_id: args.actorId,
        verb: args.verb,
        category: tpl.category,
        priority: tpl.priority,
        needs_action: tpl.needs_action,
        object_type: tpl.object_type,
        object_id: args.object.id,
        object_label: args.object.label ?? null,
        title: tpl.title,
        body: tpl.body ?? null,
        data,
        action_type: tpl.action_type ?? null,
        dedup_key: args.dedupKey ?? null,
      },
    });

    // Step 11: Bulk-insert RECIPIENT rows (per-recipient priority + needs_action).
    await client.notificationRecipient.createMany({
      data: finalSpecs.map((s) => ({
        notification_id: notif.id,
        organization_id: args.organizationId,
        recipient_id: s.userId,
        priority: s.priority,
        needs_action: s.needs_action,
      })),
    });

    // Step 12: Fire the realtime ping.
    const recipientIds = finalSpecs.map((s) => s.userId);
    await publishNotificationsChanged(recipientIds, args.organizationId);
    return recipientIds;
  } catch (e) {
    logger.warn('[notificationService] emit failed — swallowing to protect caller', {
      verb: args.verb,
      organizationId: args.organizationId,
      error: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
}
