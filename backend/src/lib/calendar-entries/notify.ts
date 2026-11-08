import { prisma } from '../prisma';
import { logger } from '../logger';
import { emit } from '../../services/notifications/notificationService';
import {
  sendCalendarEntryScheduledEmail,
  sendCalendarEntryMovedEmail,
  sendCalendarEntryCancelledEmail,
  type OrganizationBrandingSubset,
} from '../email';
import { formatDateTimeInZone, DEFAULT_TIMEZONE } from '../timezone';
import type { EnrichedParticipant } from './participants';

/**
 * Calendar Entries (slice 07, spec §5 / §9 risk 3) — the three-outcome notification pipeline.
 *
 * THE #1550 GUARD: CalendarEntry has no status column at all, so template/verb selection can
 * only ever be a DIFF — never a status read. `classifyOutcome` is that diff, expressed once and
 * reused for both channels (customer email + user in-app):
 *
 *   - not previously known to this participant  → 'scheduled' (first notice, regardless of
 *     whether start/end also changed in this same save — spec: "a customer added to an existing
 *     entry gets the scheduled email on the next save, not moved: they were never told about
 *     the old time")
 *   - previously known AND start/end changed    → 'moved'
 *   - previously known AND start/end unchanged  → 'none' (nothing sent — a description/title
 *     edit alone must stay silent for anyone who already knows the entry)
 *
 * "Previously known" means something different per kind:
 *   - CUSTOMER: `notified_at` non-null on the OLD participant row — i.e. they were actually
 *     emailed before, not merely attached as a participant. Attaching without sending (no email
 *     on file, or the box left unticked) must not silently promote a later save to "moved".
 *   - USER: the OLD participant row existed at all — a teammate sees the entry on the board the
 *     moment they're added, so being on it before IS their prior notice, independently of any
 *     email. Deliberately NOT switched to `notified_at` when user email arrived (see below):
 *     that would reclassify every already-attached teammate as never-known and fire a round of
 *     "you've been added" mail for entries they have been looking at for weeks.
 *
 * PARTICIPANT EMAIL, BOTH KINDS (product-owner change, 2026-08-25 — "I actually wanted all
 * participants to be notified"). The notify checkbox used to govern customer email only, and a
 * teammate's in-app notice was the whole of their notification. Both kinds now take the
 * same three templates through the same classification above. The two channels are still not
 * symmetric, and that is deliberate: the IN-APP notice for user participants remains
 * unconditional (like every other domain event in this app — an assignment, a reschedule — a
 * teammate is told automatically, with no opt-out box), while the EMAIL for either kind is
 * gated on `notifyParticipantsEmail`. So unticking the box quiets the mail and never quiets
 * the board.
 */
export type NotifyOutcome = 'scheduled' | 'moved' | 'none';

export function classifyOutcome(wasKnownBefore: boolean, timeChanged: boolean): NotifyOutcome {
  if (!wasKnownBefore) return 'scheduled';
  return timeChanged ? 'moved' : 'none';
}

export interface OldParticipantState {
  notifiedAt: Date | null;
}

export function participantKey(
  kind: 'USER' | 'CUSTOMER',
  userId: string | null | undefined,
  customerId: string | null | undefined,
): string {
  return kind === 'USER' ? `USER:${userId}` : `CUSTOMER:${customerId}`;
}

/** Builds the "existed before, and if so was it ever actually notified" map this module needs
 *  from the OLD participant rows (loaded by the controller before it writes anything). Absent
 *  from this map == did not exist before == a brand new participant. */
export function buildOldParticipantMap(
  oldParticipants: { kind: 'USER' | 'CUSTOMER'; user_id: string | null; customer_id: string | null; notified_at: Date | null }[],
): Map<string, OldParticipantState> {
  const map = new Map<string, OldParticipantState>();
  for (const p of oldParticipants) {
    map.set(participantKey(p.kind, p.user_id, p.customer_id), { notifiedAt: p.notified_at });
  }
  return map;
}

async function loadOrgBranding(organizationId: string): Promise<{ org?: OrganizationBrandingSubset; timezone: string }> {
  const row = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { name: true, logo_url: true, brand_color: true, timezone: true },
  });
  return {
    org: row ? { id: organizationId, name: row.name, logo_url: row.logo_url, brand_color: row.brand_color } : undefined,
    timezone: row?.timezone || DEFAULT_TIMEZONE,
  };
}

export interface NotifyChangeArgs {
  organizationId: string;
  actorId: string | null;
  entryId: string;
  title: string;
  start: Date;
  isAllDay: boolean;
  /** True only when start or end actually differs from the stored row — the ONLY input this
   *  module reads about "what changed". Computed by the controller from the diff, never from a
   *  status value (there is none). */
  timeChanged: boolean;
  /** The participant set as it stands AFTER this save (display-enriched — carries email/name). */
  finalParticipants: EnrichedParticipant[];
  oldParticipants: Map<string, OldParticipantState>;
  /**
   * Request-level opt-in — governs the EMAIL channel for BOTH participant kinds. In-app
   * notifications for user participants are never gated by this: exactly like every other
   * domain event in this codebase (an assignment, a reschedule), a teammate is told
   * automatically, with no opt-out checkbox to suppress it. Absent/false ⇒ no participant
   * email is even attempted (mirrors notifyKeys()'s "no notify_customer key ⇒ silent"
   * convention elsewhere in this app).
   */
  notifyParticipantsEmail: boolean;
  /** Free text for the SCHEDULED outcome only (spec §5) — read for a scheduled send of either
   *  kind and completely ignored otherwise. MOVED has no equivalent parameter on its sender at
   *  all (see sendCalendarEntryMovedEmail in lib/email.ts), so there is nothing here that could
   *  reach it even by accident. */
  scheduledMessage?: string;
  /**
   * Suppresses the IN-APP channel for this call. Exactly one caller sets it: notifyMoved in
   * calendar-entry.controller.ts, which runs AFTER the time-changing PATCH has already emitted
   * every teammate's unconditional in-app "moved" notice. Without it, that route's own email
   * pass would emit a duplicate. Never a substitute for `notifyParticipantsEmail` — the two
   * channels are independent, and this one is a de-duplication fact about a specific caller,
   * not a user-facing preference.
   */
  suppressInAppNotice?: boolean;
}

export interface CustomerNotifyRecord {
  participant_id: string;
  customer_id: string;
  outcome: NotifyOutcome;
  status: string;
}

/** The USER-kind twin of CustomerNotifyRecord. Same shape, different id column — kept as a
 *  separate array rather than one polymorphic list so existing readers of `customers` (the
 *  slice-07 API contract and its tests) keep meaning exactly what they meant. */
export interface UserNotifyRecord {
  participant_id: string;
  user_id: string;
  outcome: NotifyOutcome;
  status: string;
}

export interface NotifyChangeResult {
  customers: CustomerNotifyRecord[];
  users: UserNotifyRecord[];
}

/** The greeting name for either kind. Customers carry a resolved `name` (customerLabel);
 *  users carry first/last. 'there' is the same neutral fallback every sender in this family
 *  already uses for a nameless recipient. */
export function participantGreetingName(p: EnrichedParticipant): string {
  if (p.kind === 'CUSTOMER') return p.name || 'there';
  return `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim() || 'there';
}

/**
 * Called after CREATE and after UPDATE (both share one shape: "here is the final participant
 * set and whether the time changed"). Never throws — a notification failure must not fail the
 * create/update it rides on, matching notificationService.emit()'s own contract.
 */
export async function notifyCalendarEntryChange(args: NotifyChangeArgs): Promise<NotifyChangeResult> {
  const customers: CustomerNotifyRecord[] = [];
  const users: UserNotifyRecord[] = [];
  const notifiedParticipantIds: string[] = [];
  const usersByOutcome: Record<'scheduled' | 'moved', string[]> = { scheduled: [], moved: [] };

  try {
    const { org, timezone } = await loadOrgBranding(args.organizationId);

    for (const p of args.finalParticipants) {
      const key = participantKey(p.kind, p.user_id, p.customer_id);
      const old = args.oldParticipants.get(key);
      const wasKnownBefore = p.kind === 'CUSTOMER' ? Boolean(old?.notifiedAt) : old !== undefined;
      const outcome = classifyOutcome(wasKnownBefore, args.timeChanged);
      if (outcome === 'none') continue;

      // The in-app channel, user participants only, and NEVER gated on
      // `notifyParticipantsEmail` — see the module doc. Queued here and emitted once per
      // outcome after the loop, so N teammates cost one emit, not N.
      if (p.kind === 'USER' && p.user_id && !args.suppressInAppNotice) usersByOutcome[outcome].push(p.user_id);

      // The email channel, BOTH kinds (product-owner change, 2026-08-25).
      if (!args.notifyParticipantsEmail) continue;

      const recipientId = p.kind === 'CUSTOMER' ? p.customer_id : p.user_id;
      if (!recipientId) continue;

      const push = (status: string) => {
        if (p.kind === 'CUSTOMER') customers.push({ participant_id: p.id, customer_id: recipientId, outcome, status });
        else users.push({ participant_id: p.id, user_id: recipientId, outcome, status });
      };

      if (!p.email) {
        push('no_recipient');
        continue;
      }

      // A staff recipient gets NO `record`: TransactionalEmailRecord anchors a send to a
      // customer conversation (it is what puts the mail on the customer center and mints the
      // Reply-To token). An internal "you're on this entry" notice has no such conversation to
      // join, and stamping one against the entry's customer would file a teammate's mail under
      // that customer's history. Unreplyable by construction, like every other internal alert.
      const record = p.kind === 'CUSTOMER'
        ? {
            organizationId: args.organizationId,
            customerId: recipientId,
            entityType: 'calendar_entry',
            entityId: args.entryId,
          }
        : undefined;
      const customerName = participantGreetingName(p);

      const result = outcome === 'scheduled'
        ? await sendCalendarEntryScheduledEmail({
            organizationId: args.organizationId,
            org,
            to: p.email,
            customerName,
            entryTitle: args.title,
            start: args.start,
            isAllDay: args.isAllDay,
            timezone,
            message: args.scheduledMessage,
            ...(record ? { record } : {}),
          })
        : await sendCalendarEntryMovedEmail({
            organizationId: args.organizationId,
            org,
            to: p.email,
            customerName,
            entryTitle: args.title,
            newStart: args.start,
            isAllDay: args.isAllDay,
            timezone,
            ...(record ? { record } : {}),
          });

      push(result.status);
      if (result.status === 'sent') notifiedParticipantIds.push(p.id);
    }

    for (const outcome of ['scheduled', 'moved'] as const) {
      const userIds = usersByOutcome[outcome];
      if (userIds.length === 0) continue;
      await emit({
        verb: `calendar_entry.${outcome}`,
        organizationId: args.organizationId,
        actorId: args.actorId,
        object: { type: 'CALENDAR_ENTRY', id: args.entryId, label: args.title },
        entity: { participant_user_ids: userIds },
        data: outcome === 'moved' ? { new_start_label: formatDateTimeInZone(args.start, timezone) } : {},
      });
    }

    // notified_at now stamps for EITHER kind — it means exactly "an email for this entry
    // actually left for this participant", and that is true of a teammate too once user email
    // exists. It is what notifyMoved's idempotency guard filters on, so leaving it null for
    // users would make a double-clicked toast resend to every teammate while correctly
    // skipping every customer. It does NOT feed the USER half of classifyOutcome, which still
    // asks "did the participant row exist before" (module doc) — a long-standing teammate who
    // has never been emailed is still 'known', not a new invite.
    if (notifiedParticipantIds.length > 0) {
      await prisma.calendarEntryParticipant.updateMany({
        where: { id: { in: notifiedParticipantIds } },
        data: { notified_at: new Date() },
      });
    }
  } catch (err) {
    logger.error('[calendar-entries] notifyCalendarEntryChange failed — swallowing', err);
  }

  return { customers, users };
}

export interface NotifyDeletedArgs {
  organizationId: string;
  actorId: string | null;
  entryId: string;
  title: string;
  start: Date;
  isAllDay: boolean;
  /** The participant set as it stood immediately before the hard delete — the row and its
   *  participants are already gone (cascade) by the time this runs. */
  participants: EnrichedParticipant[];
  /** Request-level opt-in — governs the EMAIL channel for both kinds, same as
   *  NotifyChangeArgs.notifyParticipantsEmail. User participants always get the in-app
   *  cancellation notice regardless (see notify.ts module doc). */
  notifyParticipantsEmail: boolean;
}

/**
 * Called after DELETE. Unlike notifyCalendarEntryChange there is no outcome to classify — a
 * delete is unconditionally news to everyone still attached, so every user participant gets the
 * in-app notice and every participant of EITHER kind with an email on file gets the
 * cancellation email (subject to notifyParticipantsEmail). No notified_at bookkeeping: the
 * participant rows are already gone by the time this runs (ON DELETE CASCADE), so there is
 * nothing left to stamp.
 */
export async function notifyCalendarEntryDeleted(args: NotifyDeletedArgs): Promise<{
  customers: { participant_id: string; customer_id: string; status: string }[];
  users: { participant_id: string; user_id: string; status: string }[];
}> {
  const customers: { participant_id: string; customer_id: string; status: string }[] = [];
  const users: { participant_id: string; user_id: string; status: string }[] = [];
  const userIds: string[] = [];

  try {
    const { org, timezone } = await loadOrgBranding(args.organizationId);

    for (const p of args.participants) {
      // In-app, user participants only, never gated — as in notifyCalendarEntryChange.
      if (p.kind === 'USER' && p.user_id) userIds.push(p.user_id);

      if (!args.notifyParticipantsEmail) continue;
      const recipientId = p.kind === 'CUSTOMER' ? p.customer_id : p.user_id;
      if (!recipientId) continue;

      const push = (status: string) => {
        if (p.kind === 'CUSTOMER') customers.push({ participant_id: p.id, customer_id: recipientId, status });
        else users.push({ participant_id: p.id, user_id: recipientId, status });
      };

      if (!p.email) {
        push('no_recipient');
        continue;
      }

      // No `record` for a staff recipient — see notifyCalendarEntryChange's own note.
      const record = p.kind === 'CUSTOMER'
        ? {
            organizationId: args.organizationId,
            customerId: recipientId,
            entityType: 'calendar_entry',
            entityId: args.entryId,
          }
        : undefined;

      const result = await sendCalendarEntryCancelledEmail({
        organizationId: args.organizationId,
        org,
        to: p.email,
        customerName: participantGreetingName(p),
        entryTitle: args.title,
        cancelledStart: args.start,
        isAllDay: args.isAllDay,
        timezone,
        ...(record ? { record } : {}),
      });
      push(result.status);
    }

    if (userIds.length > 0) {
      await emit({
        verb: 'calendar_entry.cancelled',
        organizationId: args.organizationId,
        actorId: args.actorId,
        object: { type: 'CALENDAR_ENTRY', id: args.entryId, label: args.title },
        entity: { participant_user_ids: userIds },
        data: {},
      });
    }
  } catch (err) {
    logger.error('[calendar-entries] notifyCalendarEntryDeleted failed — swallowing', err);
  }

  return { customers, users };
}
