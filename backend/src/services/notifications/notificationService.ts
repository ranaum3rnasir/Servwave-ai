/**
 * notificationService.ts — emit() orchestrator
 *
 * Ties together templates, resolveRecipients, and the DB writes
 * to create a Notification event row + NotificationRecipient rows per resolved
 * recipient. Always resolves — errors are swallowed and logged as warnings so
 * a failed notification never breaks the parent action.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { isKnownVerb, renderTemplate } from './templates';
import { resolveRecipients } from './resolveRecipients';
import { publishNotificationsChanged } from './realtimePublish';
import { filterRecipientsByAccess } from './filterByAccess';
import { conversationAlertAudience, type ConversationAlert, type ConversationSubject } from './conversationAlertRecipients';
import { conversationAlertKeys, isFallbackPeople, nobodyFallbackRows, type FallbackPeople } from './conversationAlertFallback';

/** The verb of the missed-call and voicemail alert: a voicemail is the same verb with `call_status: 'voicemail'` in its data. */
const CALL_MISSED_VERB = 'communication.call_missed';
/** The verb of the inbound-text alert. The caller names the text in `entity.message_id`; without it the conversation's latest inbound text is meant. */
const SMS_INBOUND_VERB = 'communication.sms_inbound';

/** The lookup that names the people of a call or text alert, or null for any other verb. */
function conversationAlertOf(args: EmitArgs): ConversationAlert | null {
  if (args.verb === CALL_MISSED_VERB) return { kind: 'call', organizationId: args.organizationId, callId: args.object.id };
  if (args.verb === SMS_INBOUND_VERB) {
    return { kind: 'text', organizationId: args.organizationId, threadId: args.object.id, messageId: args.entity?.message_id ?? null };
  }
  return null;
}

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
  /**
   * The alert is about the people it goes to and no one else (S06.27, "Unassigned from you"): they are named by the caller, and
   * the row-scope filter is not asked. A person taken off a job can no longer open it, so the filter would drop the one person
   * the alert exists for. The alert says nothing about the job but its number, which they saw when they were on it.
   */
  personal?: boolean;
  /**
   * The people named in `entity` have been through the single read of the conversation already, so the row-scope filter is not asked
   * a second time (a second look at an email conversation costs the same reads again). Only the customer-reply alert
   * (emailReplyAlerts.ts) sets it, for people it found among those who may read the conversation.
   */
  readersChecked?: boolean;
  /**
   * The people of a missed-call, voicemail or inbound-text alert, handed over by the never-silent fallback (conversationAlertFallback.ts)
   * and by nothing else: it makes the token, and `emit` ignores any other. The lookup of the conversation's people and the access filter
   * inside it are then skipped, because the fallback tells holders of Manage roles and permissions the lookup left out, in an alert
   * that carries no caller details when they cannot read the conversation.
   */
  fallbackPeople?: FallbackPeople;
  /** Optional: run inside the caller's existing transaction. */
  tx?: Prisma.TransactionClient;
}

// ── main export ───────────────────────────────────────────────────────────────

/**
 * The never-silent fallback of a missed call, voicemail or inbound text whose lookup named nobody: up to two alerts to the holders of
 * Manage roles and permissions, each its own row (see conversationAlertFallback.ts), sent through `emit` again with their people chosen.
 * Returns everyone told, or [] when the company has no such holder (the fallback logs that).
 */
async function sendToFallbackHolders(args: EmitArgs, alert: ConversationAlert, subject: ConversationSubject): Promise<string[]> {
  const rows = await nobodyFallbackRows(alert, subject, { data: args.data ?? {}, label: args.object.label });
  const told: string[] = [];
  for (const row of rows) {
    told.push(...await emit({
      ...args,
      object: { ...args.object, label: row.label },
      data: row.data,
      dedupKey: args.dedupKey ? args.dedupKey + row.keySuffix : undefined,
      fallbackPeople: row.people,
    }));
  }
  return told;
}

/**
 * Emit a notification for a verb/object pair.
 *
 * Best-effort: never throws. Any downstream failure is caught, logged as a
 * warning, and swallowed so the caller's business action is unaffected.
 *
 * The live-update ping to those people is queued, not awaited: emit() returns once the alert rows are written.
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

    // Step 5: Dedup — idempotent on dedup_key. A call or text alert may have been written under the event's own key (told to the people
    // the lookup named) or under either key of the never-silent fallback (told to the holders of Manage roles and permissions), and a
    // redelivery is the same event whichever it was.
    const conversationAlert = conversationAlertOf(args);
    if (args.dedupKey) {
      const existing = await client.notification.findFirst({
        where: {
          organization_id: args.organizationId,
          dedup_key: conversationAlert ? { in: conversationAlertKeys(args.dedupKey) } : args.dedupKey,
        },
      });
      if (existing) return [];
    }

    // Step 6b: A missed call, a voicemail or an inbound text is told to the people the record, the Communication scope, the company
    // number (and, for a text, the reply) name, already through the access filter (conversationAlertAudience). The read comes after
    // the dedup check above, so a webhook retry costs none of it. When it names nobody the fallback tells the holders of Manage roles
    // and permissions instead (sendToFallbackHolders), and those alerts come back through here with their people already chosen.
    let entity = args.entity ?? {};
    if (conversationAlert) {
      if (isFallbackPeople(args.fallbackPeople)) {
        entity = { ...entity, recipient_ids: [...args.fallbackPeople.ids] };
      } else {
        const audience = await conversationAlertAudience(conversationAlert);
        if (audience && audience.people.length === 0) return await sendToFallbackHolders(args, conversationAlert, audience.subject);
        entity = { ...entity, recipient_ids: audience?.people ?? [] };
      }
    }

    // Step 7: Resolve recipients (pure).
    const specs = resolveRecipients({
      verb: args.verb,
      organizationId: args.organizationId,
      actorId: args.actorId,
      entity,
    });

    // Step 8: Row-scope filter — drop recipients who cannot access the object row. A personal alert is about the people it goes to,
    // and a call or text alert's people have been through the filter already (the fallback's holders are told by design, without
    // caller details when they cannot read it), as a customer's email reply's people have been through the single read.
    const allowed = args.personal || args.readersChecked || conversationAlert
      ? specs.map((s) => s.userId)
      : await filterRecipientsByAccess(
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

    // Step 12: Queue the realtime ping. It runs after this returns and is never waited for: the alert rows above are what
    // a person finds in the bell, and the ping is only a hint to refetch (see realtimePublish.ts).
    const recipientIds = finalSpecs.map((s) => s.userId);
    void publishNotificationsChanged(recipientIds, args.organizationId);
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
