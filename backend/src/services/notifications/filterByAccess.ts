/**
 * filterByAccess.ts — CASL row-scope recipient filter (Task 2.4)
 *
 * For each resolved notification recipient, verifies they can actually access
 * the notification's primary object row before including them. This prevents
 * leaking cross-org or out-of-scope row references through notification delivery.
 *
 * Fail-closed: missing user → DROP; the access check throws → DROP + warn.
 *
 * A constant number of reads however many recipients there are (see filterRecipientsByAccess).
 */

import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { isSuperUser } from '../../lib/permissions/effectiveRole';
import { scopeWhereForUser } from '../../lib/permissions/enforce';
import type { ScopeResource } from '../../lib/permissions/scopeWhereFor';
import { resolveSwitchesForPeople } from '../../lib/permissions/switches/store';
import { readersWithEntityAccess } from '../../lib/tasks/entityAccessCohort';
import { readersOfConversation, type ConversationKind } from '../../lib/communication/conversationReaders';

// Maps notification objectType (uppercase string) → CASL ScopeResource.
//
// LOGISTIC_ORDER is deliberately ABSENT: its notifications (lo.submitted →
// approve-grant holders ∪ ADMINs; lo.approved → the creator) go only to org-wide
// LO readers, so they must NOT be row-scope-filtered — an absent key means the
// passthrough below keeps every resolved recipient. REVISIT this if a row-scoped
// reader (e.g. a technician) is ever added as an LO recipient: add
// `LOGISTIC_ORDER: 'LogisticOrder'` here (the delegateMap entry already exists)
// so those recipients get access-checked.
//
// TASK is deliberately ABSENT for a different reason, and a permanent one (multi-assignee
// design §5). A task has no CASL row scope to check against: `taskVisibilityWhere` grants
// access precisely BY naming someone in `assignee_ids` / `watcher_ids`, so every recipient
// resolveRecipients can produce for a task verb is, by construction, already someone who
// can see the row. Adding `TASK: 'Task'` here would not tighten anything — there is no
// `Task` ScopeResource — it would only re-derive a fact the recipient list already encodes.
const SCOPE_TYPE_MAP: Record<string, ScopeResource> = {
  JOB: 'Job',
  ESTIMATE: 'Estimate',
  INVOICE: 'Invoice',
  LEAD: 'Lead',
};

// The communication alerts name a conversation, not a record row, and who may read it is not a row scope: it is the
// Communication scope's single-read rule (lib/communication/communicationScope.ts), the one the routes that open a call, a
// text conversation or an email conversation ask. Asked here for every recipient in one batched read, so the recipient
// list and the routes cannot disagree.
const COMMUNICATION_TYPES: Record<string, ConversationKind> = {
  CALL: 'call',
  MESSAGE_THREAD: 'text',
  EMAIL_THREAD: 'email',
};

/**
 * Filters a list of recipientIds down to those who have read access to the
 * given objectType/objectId row, using the same grant-derived row scope as
 * attachAbility + canAccessRow, asked for all of them together.
 *
 * - Non-scoped object types (anything not in SCOPE_TYPE_MAP) pass through
 *   unchanged — no DB call.
 * - Unknown user (missing from DB within org) → DROPPED (fail-closed).
 * - The scope check throwing for any recipient → DROPPED + logger.warn (fail-closed).
 * - Input order is preserved for kept ids.
 * - `opts.messageId` is for an alert about one message of a conversation: it narrows a text or an email conversation's question
 *   to that message, so a person is kept only if they read the message the alert quotes (see readersOfConversation). Calls
 *   ignore it. Without it the question is the conversation's: at least one of its messages opens for the person (what the
 *   routes that open a conversation answer). A customer's email reply does not come through here: its bell asks the readers
 *   question itself, about the reply AND the conversation the link opens (emailReplyAlerts.ts, M1).
 */
export async function filterRecipientsByAccess(
  objectType: string,
  objectId: string,
  recipientIds: string[],
  organizationId: string,
  opts: { messageId?: string | null } = {},
): Promise<string[]> {
  const conversationKind = COMMUNICATION_TYPES[objectType.toUpperCase()];
  if (conversationKind) {
    return filterByConversationAccess(conversationKind, objectType, objectId, recipientIds, organizationId, opts.messageId ?? null);
  }

  const scopeResource = SCOPE_TYPE_MAP[objectType.toUpperCase()];

  // Non-scoped type → passthrough, no access check needed.
  if (!scopeResource) {
    return recipientIds;
  }

  // Load all recipient users in one query — only within the org.
  const users = await prisma.user.findMany({
    where: { id: { in: recipientIds }, organization_id: organizationId },
    // custom_role_id with its key: a recipient on a custom role is judged by that role's grants and
    // switches, not by the base role's (grantRoleKey throws if the key is missing).
    select: {
      id: true, role: true, organization_id: true, department_id: true, location_id: true,
      custom_role_id: true, is_admin: true, custom_role: { select: { key: true } },
    },
  });

  const userMap = new Map(users.map((u) => [u.id, u]));

  // Everyone's switches in a constant number of reads, and cached, so deriving each person's scope below reads
  // nothing more. Asked one person at a time this cost three reads per recipient once their switches had expired,
  // which on the hosted database (one connection) is the better part of a second for every ten people told.
  // A failure here is not an answer: each person is then judged on their own below and fails closed on their own.
  await resolveSwitchesForPeople(users.filter((u) => !isSuperUser(u))).catch(() => undefined);

  // Who can open the row without being asked of the database (the Admin box, or a scope that restricts nothing) and
  // who needs the row looked at. The first group is the same answer `canAccessRow` gives without a query.
  const open = new Set<string>();
  const needsRow: typeof users = [];
  for (const recipientId of recipientIds) {
    const user = userMap.get(recipientId);

    // Unknown user (not in org or not found) → DROP (fail-closed).
    if (!user) {
      logger.warn('[filterByAccess] recipient not found in org — dropping', {
        recipientId,
        organizationId,
        objectType,
        objectId,
      });
      continue;
    }

    try {
      const scope = await scopeWhereForUser(user, scopeResource);
      if (Object.keys(scope).length === 0) open.add(recipientId);
      else needsRow.push(user);
    } catch (err) {
      // Fail-closed: any error during the check → DROP + warn.
      logger.warn('[filterByAccess] access check threw — dropping recipient', {
        recipientId,
        organizationId,
        objectType,
        objectId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // The rest are asked together: people whose scope comes to the same condition share one look at the row, and the
  // ones whose condition names themselves (their own crew place, their own jobs) are told apart by a single read.
  // readersWithEntityAccess fails closed per person: a probe that throws leaves that person out.
  let withAccess = new Set<string>();
  if (needsRow.length) {
    try {
      ({ withAccess } = await readersWithEntityAccess(needsRow, { type: objectType.toUpperCase(), id: objectId }));
    } catch (err) {
      // Fail-closed: nobody who needed the row looked at is kept.
      logger.warn('[filterByAccess] access check threw — dropping recipients', {
        organizationId,
        objectType,
        objectId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return recipientIds.filter((id) => open.has(id) || withAccess.has(id));
}

/**
 * The communication half of the filter: keeps the recipients who may read the call, text conversation or email
 * conversation (readersOfConversation: the routes' own rule, for everyone in one batch).
 *
 * - Only active people of this company are asked; anyone else is DROPPED (fail-closed), a deactivated person included.
 * - The question failing for any reason DROPS everyone and warns: a communication alert names a customer, so a failure
 *   never lets it through.
 * - Show Phone and Show Text decide nothing here: they hide a menu entry, not access. Show Email decides for an email
 *   conversation: its mail routes refuse a person with it off, so no email alert goes to them (M7, ticket 36).
 * - Input order is preserved for kept ids.
 */
async function filterByConversationAccess(
  kind: ConversationKind,
  objectType: string,
  objectId: string,
  recipientIds: string[],
  organizationId: string,
  messageId: string | null,
): Promise<string[]> {
  if (recipientIds.length === 0) return [];
  try {
    const users = await prisma.user.findMany({
      where: { id: { in: recipientIds }, organization_id: organizationId, is_active: true },
      select: {
        id: true, role: true, organization_id: true, department_id: true, location_id: true,
        custom_role_id: true, is_admin: true, custom_role: { select: { key: true } },
      },
    });
    const readers = await readersOfConversation(users, kind, objectId, organizationId, { messageId });
    // Only the people asked can be kept: anyone not found among the company's active people is dropped.
    const asked = new Set(users.map((u) => u.id));
    return recipientIds.filter((id) => asked.has(id) && readers.has(id));
  } catch (err) {
    logger.warn('[filterByAccess] communication access check threw - dropping recipients', {
      organizationId,
      objectType,
      objectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
