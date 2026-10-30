/**
 * Where an email conversation lives (PRD 10, S10.4). Every conversation (an `email_threads` row) belongs
 * to exactly one mailbox and says how it came to be there:
 *
 *   started   started here by a person (the compose dialog);
 *   migrated  there before go-live (set by the migration, never by a writer);
 *   moved     moved in from another mailbox (a later slice);
 *   record    opened by a send to a customer about one record (an estimate, an invoice, a job...).
 *
 * A conversation goes into the mailbox its first message went out from: the company's main mailbox for
 * mail that arrives on the company address and for an automated send, the writer's own mailbox for an
 * email written by hand (S10.11) and for a hand-sent estimate or invoice (S10.12); each changes only
 * which mailbox id these functions are given. Loose system email (a send
 * that names no record) has no conversation, so it belongs to no mailbox and never comes through here.
 */
import type { Prisma, PrismaClient } from '@prisma/client';

type Db = Pick<PrismaClient, 'mailbox'>;

/** How a conversation came to be in its mailbox. */
export type ConversationOrigin = 'started' | 'migrated' | 'moved' | 'record';

/** The record a "record" conversation belongs to: the same vocabulary as a reply token's entity. */
export interface ConversationRecord {
  type: string;
  id: string;
}

/**
 * The id of the company's main mailbox. Null only for a company that has none, which the register
 * (S10.1) rules out for every company; a conversation written then is left unplaced for the migration's
 * placement step to pick up, rather than refusing the send.
 */
export async function mainMailboxIdOf(db: Db, organizationId: string): Promise<string | null> {
  const row = await db.mailbox.findFirst({
    where: { organization_id: organizationId, kind: 'main' },
    select: { id: true },
  });
  return row?.id ?? null;
}

/**
 * Data for a conversation started here: origin "started", owned by its starter if it has one. It sits in `mailboxId`
 * (the mailbox the first message went out from: a hand-written email starts one in its writer's own mailbox, S10.11)
 * and, when no mailbox is given, in the company's main mailbox (mail that arrives on the company address).
 */
export async function startedConversationData(
  db: Db,
  organizationId: string,
  assignedToUserId: string | null,
  mailboxId?: string | null,
): Promise<Prisma.EmailThreadUncheckedCreateInput> {
  return {
    organization_id: organizationId,
    assigned_to_user_id: assignedToUserId,
    mailbox_id: mailboxId ?? (await mainMailboxIdOf(db, organizationId)),
    origin: 'started',
  };
}

/**
 * The first person to reply in a main-mailbox conversation that has no assignee takes it (PRD 10, S10.11). One
 * conditional write, so two people replying at the same moment cannot both win: the second finds an assignee already
 * and changes nothing. A conversation whose assignee has left counts as having none (the inbox reads it that way), and
 * a conversation in any other mailbox is left alone. Returns whether this call made the person its assignee.
 */
export async function takeConversationOnFirstReply(
  db: Pick<PrismaClient, 'emailThread'>,
  args: { organizationId: string; threadId: string; userId: string },
): Promise<boolean> {
  const taken = await db.emailThread.updateMany({
    where: {
      id: args.threadId,
      organization_id: args.organizationId,
      mailbox: { kind: 'main' },
      OR: [{ assigned_to_user_id: null }, { assigned_to: { is_active: false } }],
    },
    data: { assigned_to_user_id: args.userId },
  });
  return taken.count > 0;
}

/**
 * Data for the conversation a send to a customer opens about one record: origin "record", in the mailbox the send went out
 * from. An automated send names none and so opens it in the company's main mailbox; a document a person sends by hand
 * (S10.12) names that person's own mailbox.
 */
export async function recordConversationData(
  db: Db,
  organizationId: string,
  record: ConversationRecord,
  mailboxId?: string | null,
): Promise<Prisma.EmailThreadUncheckedCreateInput> {
  return {
    organization_id: organizationId,
    mailbox_id: mailboxId ?? (await mainMailboxIdOf(db, organizationId)),
    origin: 'record',
    record_type: record.type,
    record_id: record.id,
  };
}
