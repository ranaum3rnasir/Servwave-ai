/**
 * Handing a leaver's mailbox on (PRD 10, "Leaving, handover and returning"; S10.21).
 *
 * Both ways to deactivate a person (the deactivate action and the user update that sets a user inactive) accept a handover
 * target, resolved here the same way, and run `handOverMailbox` inside the transaction that flips `is_active`, so a person is
 * never left deactivated with a mailbox nobody holds. The target is the main mailbox, or an active person of the company;
 * with none given it is the main mailbox, so a deactivation is never blocked for want of an answer.
 *
 *   Handed to MAIN   every conversation in the mailbox moves into the main mailbox in ONE set-based write, a started one
 *                    reading origin "moved" (so the main mailbox's readers do not list it under "Linked to me") with the
 *                    mailbox it came from, a record conversation keeping origin "record" so it still follows its record
 *                    (a person with Invoices View off must not reach an invoice conversation through any mailbox). The
 *                    mailbox reads "merged", nobody holds it, and it keeps its owner and its address rows: the inbound
 *                    router follows `merged_into_mailbox_id` to deliver the leaver's addresses into the main mailbox, and
 *                    the later moves know whose mailbox went where. (Reactivating the person, S10.23, moves the addresses to
 *                    a fresh mailbox of theirs and leaves the merge as it is: lib/mailbox/reactivation.ts.)
 *   Handed to a PERSON  the person becomes the mailbox's holder and it reads "handed". Nothing moves: its conversations stay
 *                    in it and its addresses keep delivering into it. (Showing it as "<owner>'s mailbox" is the Email
 *                    page's rule on `holder_user_id`.)
 *
 * A leaver who HOLDS someone else's mailbox (one handed to them earlier) hands that one on in the same write, to the same
 * target: a mailbox is never left held by a person who can no longer sign in.
 *
 * LATER MOVES (S10.22), `moveMailbox`: a holder of Edit users hands a leaver's mailbox to another person or to the main
 * mailbox from the Users page. Person to person changes the holder. Person to main is the merge above. Main to a person
 * reverses the merge for that mailbox only: the conversations that came from it (`moved_from_mailbox_id`) go back into it, a
 * "moved" one reading "started" again (a user mailbox lists by mailbox, never by origin; a record conversation keeps
 * origin "record"), the mailbox reads "handed" with the person as holder, and the addresses, which never left the mailbox,
 * deliver into it again because it is no longer merged. What arrived in the main mailbox meanwhile stays there.
 * Whatever the number of conversations, a move is a fixed number of statements.
 *
 * PERMANENT DELETE (S10.24), `settleMailboxesBeforeDelete`: the one case where a mailbox could be left with nobody to hold it.
 *
 * Mail is kept for good: nothing here deletes a conversation, a message or an address. Every query goes through the
 * transaction's client (the hosted pool holds one connection).
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { logger } from '../logger';
import { mainMailboxIdOf } from './conversations';

type Tx = Prisma.TransactionClient;

export type HandoverTarget = { kind: 'main' } | { kind: 'person'; userId: string };

/** The body field both deactivation paths read: "main", or the id of the person who takes the mailbox. */
export const handoverToField = z.string().max(100).nullable().optional();

/** Said when the target is not "main" and not an active person of the company. Names no provider. */
export const HANDOVER_TARGET_REFUSED = 'Choose an active person in your company, or the main mailbox, to receive this email.';

/**
 * The target a request names, or null when it names none that exists. Nothing or "main" is the main mailbox; anything else
 * must be the id of an ACTIVE user of the same company who is not the person leaving.
 */
export async function resolveHandoverTarget(
  db: Pick<Tx, 'user'>,
  args: { organizationId: string; leaverId: string; raw: unknown },
): Promise<HandoverTarget | null> {
  const { raw } = args;
  if (raw === undefined || raw === null || raw === 'main') return { kind: 'main' };
  if (typeof raw !== 'string' || !z.string().uuid().safeParse(raw).success || raw === args.leaverId) return null;
  const person = await db.user.findFirst({
    where: { id: raw, organization_id: args.organizationId, is_active: true },
    select: { id: true },
  });
  return person ? { kind: 'person', userId: person.id } : null;
}

export type HandoverOutcome =
  | { handed: 'none' }
  | { handed: 'main'; mailboxIds: string[] }
  | { handed: 'person'; mailboxIds: string[]; userId: string };

/** Merge these mailboxes into the main one: ONE set-based write for their conversations, one for the mailboxes. */
async function mergeIntoMain(tx: Tx, organizationId: string, mailboxIds: string[]): Promise<boolean> {
  const mainId = await mainMailboxIdOf(tx, organizationId);
  if (!mainId) {
    // The register gives every company a main mailbox; if one is somehow missing, the mail stays where it is (kept) and the
    // deactivation still goes through.
    logger.warn('[mailbox handover] the company has no main mailbox - the mailboxes were left as they are', { organizationId, mailboxIds });
    return false;
  }
  // A SET expression reads the row as it was, so `moved_from_mailbox_id = mailbox_id` records the mailbox it came from.
  await tx.$executeRaw`
    UPDATE email_threads
       SET moved_from_mailbox_id = mailbox_id,
           mailbox_id = ${mainId}::uuid,
           origin = CASE WHEN origin = 'record' THEN origin ELSE 'moved' END
     WHERE mailbox_id = ANY(${mailboxIds}::uuid[]) AND organization_id = ${organizationId}::uuid`;
  // Their Needs review lists go with them (S10.18): a message held under one of these mailboxes is now held under the main one,
  // where the people who read it will find it, rather than waiting in a mailbox nobody holds. (Moving a mailbox back out later
  // returns its conversations but not these: they were the main mailbox's readers' to deal with in the meantime.)
  await tx.$executeRaw`
    UPDATE emails
       SET review_mailbox_id = ${mainId}::uuid
     WHERE review_mailbox_id = ANY(${mailboxIds}::uuid[]) AND organization_id = ${organizationId}::uuid`;
  await tx.mailbox.updateMany({
    where: { id: { in: mailboxIds }, organization_id: organizationId },
    data: { status: 'merged', merged_into_mailbox_id: mainId, holder_user_id: null },
  });
  return true;
}

/** Make this person the holder of these mailboxes (and stop them reading as merged). */
async function giveToPerson(tx: Tx, organizationId: string, mailboxIds: string[], userId: string): Promise<void> {
  await tx.mailbox.updateMany({
    where: { id: { in: mailboxIds }, organization_id: organizationId },
    data: { holder_user_id: userId, status: 'handed', merged_into_mailbox_id: null },
  });
}

/**
 * Hand the mailbox issued to this person on, and any mailbox handed to them earlier. Idempotent: a mailbox that is already
 * merged or handed to someone else is left alone (moving it again is a later move, `moveMailbox`), and a person with
 * nothing to hand on is a no-op.
 */
export async function handOverMailbox(
  tx: Tx,
  args: { organizationId: string; userId: string; target: HandoverTarget },
): Promise<HandoverOutcome> {
  const { organizationId, userId, target } = args;
  const boxes = await tx.mailbox.findMany({
    where: {
      organization_id: organizationId,
      kind: 'user',
      OR: [{ user_id: userId, status: { in: ['active', 'address_needed'] } }, { holder_user_id: userId, status: 'handed' }],
    },
    select: { id: true, user_id: true },
  });
  if (boxes.length === 0) return { handed: 'none' };
  // The leaver's own mailbox first, then the ones they held for others.
  const ids = [...boxes].sort((a, b) => Number(b.user_id === userId) - Number(a.user_id === userId)).map((b) => b.id);

  if (target.kind === 'person') {
    await giveToPerson(tx, organizationId, ids, target.userId);
    return { handed: 'person', mailboxIds: ids, userId: target.userId };
  }
  return (await mergeIntoMain(tx, organizationId, ids)) ? { handed: 'main', mailboxIds: ids } : { handed: 'none' };
}

/**
 * Before a person is deleted for good (S10.24, Delete users on a deactivated person with no blocking history): leave no mailbox
 * that the delete would strand. Deleting the user clears `user_id` and `holder_user_id` on their mailboxes (the foreign keys are
 * SET NULL, so no mailbox row ever blocks a delete), and a mailbox that is neither merged nor held by anyone else would then
 * sit unread with its address delivering into it. So a mailbox the person owns or holds that nobody ELSE holds, and that is
 * not already merged, is merged into the main mailbox here, in the caller's transaction, ahead of the delete. The usual case
 * does nothing: deactivating already handed everything on (`handOverMailbox`), a mailbox handed to a person stays with them,
 * and a merged one stays merged. The address rows are never touched: they stay in the register as reservations, delivering
 * wherever their mailbox now delivers, and the register never issues them again.
 */
export async function settleMailboxesBeforeDelete(
  tx: Tx,
  args: { organizationId: string; userId: string },
): Promise<HandoverOutcome> {
  const { organizationId, userId } = args;
  const boxes = await tx.mailbox.findMany({
    where: {
      organization_id: organizationId,
      kind: 'user',
      status: { not: 'merged' },
      OR: [{ holder_user_id: userId }, { user_id: userId, holder_user_id: null }],
    },
    select: { id: true },
  });
  if (boxes.length === 0) return { handed: 'none' };
  const ids = boxes.map((b) => b.id);
  return (await mergeIntoMain(tx, organizationId, ids)) ? { handed: 'main', mailboxIds: ids } : { handed: 'none' };
}

export type MoveOutcome =
  | { moved: false; reason: 'no_mailbox' }
  | { moved: true; changed: false }
  | { moved: true; changed: true; mailboxIds: string[]; target: HandoverTarget };

/**
 * Hand a leaver's mailbox (every mailbox issued to them) to another person or to the main mailbox, later (S10.22). The
 * caller has checked that the owner is no longer active and that the target is the main mailbox or an active person.
 * A mailbox that is already where it is asked to go is left alone (nothing is written, so a repeat is harmless).
 */
export async function moveMailbox(
  tx: Tx,
  args: { organizationId: string; ownerId: string; target: HandoverTarget },
): Promise<MoveOutcome> {
  const { organizationId, ownerId, target } = args;
  const boxes = await tx.mailbox.findMany({
    where: { organization_id: organizationId, kind: 'user', user_id: ownerId },
    select: { id: true, status: true, holder_user_id: true },
  });
  if (boxes.length === 0) return { moved: false, reason: 'no_mailbox' };

  if (target.kind === 'main') {
    const ids = boxes.filter((b) => b.status !== 'merged').map((b) => b.id);
    if (ids.length === 0) return { moved: true, changed: false };
    return (await mergeIntoMain(tx, organizationId, ids)) ? { moved: true, changed: true, mailboxIds: ids, target } : { moved: true, changed: false };
  }

  const toMove = boxes.filter((b) => !(b.status === 'handed' && b.holder_user_id === target.userId));
  if (toMove.length === 0) return { moved: true, changed: false };
  const ids = toMove.map((b) => b.id);
  const merged = toMove.filter((b) => b.status === 'merged').map((b) => b.id);
  if (merged.length > 0) {
    // Reverse the merge for these mailboxes only: what came from them goes back, a "moved" conversation reading "started"
    // again. What was started in the main mailbox meanwhile has no `moved_from_mailbox_id` and stays there.
    await tx.$executeRaw`
      UPDATE email_threads
         SET mailbox_id = moved_from_mailbox_id,
             moved_from_mailbox_id = NULL,
             origin = CASE WHEN origin = 'moved' THEN 'started' ELSE origin END
       WHERE moved_from_mailbox_id = ANY(${merged}::uuid[]) AND organization_id = ${organizationId}::uuid`;
  }
  await giveToPerson(tx, organizationId, ids, target.userId);
  return { moved: true, changed: true, mailboxIds: ids, target };
}

/** Where a leaver's mailbox went, as the Users page shows it. */
export type MailboxHandoverState = { to: 'main' } | { to: 'person'; user_id: string; name: string };

/**
 * Where each of these deactivated people's mailbox is now: with a person (named) or merged into the main mailbox. One read
 * for the whole list, whatever its length. A person with no handed or merged mailbox is absent from the map; when one person
 * has several (an old one handed on, a later one), the most recently changed answers.
 */
export async function mailboxHandoverStates(
  db: Pick<PrismaClient, 'mailbox'>,
  userIds: string[],
): Promise<Map<string, MailboxHandoverState>> {
  const out = new Map<string, MailboxHandoverState>();
  if (userIds.length === 0) return out;
  const boxes = await db.mailbox.findMany({
    where: { kind: 'user', user_id: { in: userIds }, status: { in: ['handed', 'merged'] } },
    orderBy: { updated_at: 'asc' },
    select: { user_id: true, status: true, holder: { select: { id: true, first_name: true, last_name: true } } },
  });
  for (const box of boxes) {
    if (!box.user_id) continue;
    if (box.status === 'handed' && box.holder) {
      out.set(box.user_id, { to: 'person', user_id: box.holder.id, name: `${box.holder.first_name} ${box.holder.last_name}`.trim() });
    } else if (box.status === 'merged') {
      out.set(box.user_id, { to: 'main' });
    }
  }
  return out;
}
