import type { Prisma, PrismaClient } from '@prisma/client';
import { recordOwnerChange } from './access-audit';

/**
 * Roles & Permissions AL-16 (ticket 24): the person a new company is set up for becomes its Owner. Onboarding (the first-admin
 * script), the seeds, the demo company and the e2e company all go through here, right after that person is created.
 *
 * It writes only when the company has no Owner yet, so it never replaces one: moving ownership is Make Owner's alone. The
 * database ties the Owner to the same company, so a person from another company is refused there.
 *
 * The assignment is recorded (ticket 25, M6: an `owner.assigned` row, no actor, by "new company") in the same transaction as the
 * write, so an Owner is never set unrecorded. Given a client, it opens that transaction; given a transaction, it writes in it.
 *
 * Kept free of the app's own client (it takes the one to write with) so a seed or a script can call it with its own.
 */
export async function setFirstOwner(
  db: PrismaClient | Prisma.TransactionClient,
  organizationId: string,
  userId: string,
): Promise<void> {
  const write = async (tx: Prisma.TransactionClient) => {
    const { count } = await tx.organization.updateMany({ where: { id: organizationId, owner_user_id: null }, data: { owner_user_id: userId } });
    if (count === 1) await recordOwnerChange(tx, { organizationId, actor: null, before: null, after: userId, by: 'new company' });
  };
  if ('$transaction' in db) await db.$transaction(write);
  else await write(db);
}
