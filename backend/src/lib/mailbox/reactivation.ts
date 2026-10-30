/**
 * A reactivated person gets their mailbox back (PRD 10, "Leaving, handover and returning"; S10.23).
 *
 * Run inside the transaction that flips `is_active` to true, on the transaction's client only (the hosted pool holds one
 * connection), so a person is never active with the mailbox half returned. Setting a person active again is a single path: the
 * user update (the deactivate action is its counterpart). What comes back depends on where the mailbox went when they left:
 *
 *   LIVE         the person still has an active (or "address needed") mailbox, as a person deactivated before the hand-over
 *                existed does: nothing to do.
 *   HANDED       the mailbox still exists as a separate mailbox, held by an interim holder (handed on at the deactivation, or
 *                later by S10.22). It is the person's again: they hold it, it reads "active" (or "address needed" if it never
 *                had an address), and the interim holder loses it on their next request, since every read follows
 *                `holder_user_id`. Its conversations and addresses never moved, so nothing else is written.
 *   MERGED       the mailbox was merged into the main one. The merge is NOT reversed: the moved-in conversations stay in the
 *                main mailbox. The person gets a FRESH mailbox, and the addresses of the merged one move to it in the same
 *                transaction, the primary staying primary. An address has one row in the register (its local part is unique)
 *                and the row names one mailbox, so it points at the fresh mailbox from then on: the router, which resolves an
 *                address through that row, can never send one address to two mailboxes, and no address ever reaches a second
 *                person. The merged mailbox keeps its owner, its status and `merged_into_mailbox_id` (its lineage), so history
 *                and a later move still know whose mailbox went where; it just no longer carries addresses.
 *   NOTHING      no mailbox history at all (a person made inactive before mailboxes were issued, who got none): the mailbox every
 *                new user gets, `first.last.company` or "address needed". Inactive users get none until reactivated.
 *
 * A person with several old mailboxes (deactivated and reactivated before) has at most one that is live or handed; that one
 * comes back, and the merged ones stay merged. Whatever the number of conversations, a reactivation is a fixed number of
 * statements: it never touches a conversation.
 */
import type { Prisma } from '@prisma/client';
import { issueUserMailbox, lockRegister } from './register';

type Tx = Prisma.TransactionClient;

export type ReactivationOutcome =
  | { returned: 'none' }
  | { returned: 'handed'; mailboxId: string; formerHolderId: string | null }
  | { returned: 'fresh'; mailboxId: string; mergedMailboxIds: string[]; addressCount: number }
  | { returned: 'issued'; mailboxId: string; addressNeeded: boolean };

export async function reactivateMailbox(
  tx: Tx,
  user: { id: string; organization_id: string; first_name: string; last_name: string },
): Promise<ReactivationOutcome> {
  // The register's own lock first, as every writer of addresses does: the fresh mailbox takes over addresses and a new one may
  // be issued, and two such writers must not interleave.
  await lockRegister(tx);
  const boxes = await tx.mailbox.findMany({
    where: { organization_id: user.organization_id, kind: 'user', user_id: user.id },
    orderBy: [{ created_at: 'desc' }, { id: 'asc' }],
    select: { id: true, status: true, holder_user_id: true, addresses: { select: { id: true, is_primary: true, issued_at: true } } },
  });

  if (boxes.some((b) => b.status === 'active' || b.status === 'address_needed')) return { returned: 'none' };

  const handed = boxes.find((b) => b.status === 'handed');
  if (handed) {
    await tx.mailbox.update({
      where: { id: handed.id },
      data: {
        holder_user_id: user.id,
        status: handed.addresses.some((a) => a.is_primary) ? 'active' : 'address_needed',
        merged_into_mailbox_id: null,
      },
      select: { id: true },
    });
    return { returned: 'handed', mailboxId: handed.id, formerHolderId: handed.holder_user_id };
  }

  const merged = boxes.filter((b) => b.status === 'merged');
  const addresses = merged.flatMap((b) => b.addresses);
  if (addresses.length > 0) {
    const fresh = await tx.mailbox.create({
      data: { organization_id: user.organization_id, kind: 'user', user_id: user.id, holder_user_id: user.id, status: 'active' },
      select: { id: true },
    });
    // The newest merged mailbox that had a primary address names the primary (boxes are newest first); a mailbox that had
    // addresses but no primary falls back to the most recently issued one.
    const newestFirst = [...addresses].sort((a, b) => b.issued_at.getTime() - a.issued_at.getTime());
    const primary = addresses.find((a) => a.is_primary) ?? newestFirst[0]!;
    // Demote while moving, then promote the one primary: the register allows one primary address per mailbox.
    await tx.mailboxAddress.updateMany({
      where: { id: { in: addresses.map((a) => a.id) }, organization_id: user.organization_id },
      data: { mailbox_id: fresh.id, is_primary: false },
    });
    await tx.mailboxAddress.update({ where: { id: primary.id }, data: { is_primary: true }, select: { id: true } });
    return { returned: 'fresh', mailboxId: fresh.id, mergedMailboxIds: merged.map((b) => b.id), addressCount: addresses.length };
  }

  // Nothing to carry over (no mailbox yet, or a merged one that never had an address): issue the way a new user's is.
  const issued = await issueUserMailbox(tx, user);
  return { returned: 'issued', mailboxId: issued.mailboxId, addressNeeded: issued.status === 'address_needed' };
}
