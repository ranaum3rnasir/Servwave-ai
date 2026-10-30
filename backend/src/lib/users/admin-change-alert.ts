import { prisma } from '../prisma';
import { logger } from '../logger';
import { sendAdminChangeAlertEmail, type AdminChange } from '../email';
import { ownerOfCompany } from './owner';
import type { AccessAction } from './access-audit';

/**
 * Roles & Permissions, ticket 25 (finding M6, story 64): the company's Owner is emailed whenever anyone becomes an Admin or
 * stops being one, whoever made the change (the Owner included), so they hear about it without looking.
 *
 * Called after the change has committed: a rolled-back change sends nothing. The Owner is read from the database, never the
 * sign-in cache. A company with no Owner, or an Owner who can't receive mail (deactivated, erased, no address), gets nothing.
 * Never throws: the change has already happened, and a mail that can't go out is logged.
 */
export async function alertOwnerOfAdminChange(args: {
  organizationId: string;
  action: AccessAction | null;
  targetId: string;
  actorId: string | null;
  at?: Date;
}): Promise<void> {
  const change: AdminChange | null =
    args.action === 'user.admin_granted' ? 'granted' : args.action === 'user.admin_removed' ? 'removed' : null;
  if (!change) return;
  try {
    const ownerId = await ownerOfCompany(args.organizationId);
    if (!ownerId) return;
    const ids = [...new Set([ownerId, args.targetId, ...(args.actorId ? [args.actorId] : [])])];
    const people = await prisma.user.findMany({
      where: { organization_id: args.organizationId, id: { in: ids } },
      select: { id: true, first_name: true, last_name: true, email: true, is_active: true, erased_at: true },
    });
    const byId = new Map(people.map((p) => [p.id, p]));
    const owner = byId.get(ownerId);
    if (!owner || !owner.is_active || owner.erased_at || !owner.email) return;
    const nameOf = (id: string | null) => {
      const p = id ? byId.get(id) : undefined;
      return p ? `${p.first_name} ${p.last_name}`.trim() : null;
    };
    await sendAdminChangeAlertEmail({
      to: owner.email,
      ownerFirstName: owner.first_name,
      personName: nameOf(args.targetId) ?? 'A person',
      // A change with no person behind it (a script, a migration) is the system's.
      actorName: nameOf(args.actorId) ?? 'ServWave',
      change,
      at: args.at ?? new Date(),
      organizationId: args.organizationId,
    });
  } catch (err) {
    logger.error(`Owner admin-change alert failed (org ${args.organizationId})`, { name: err instanceof Error ? err.name : typeof err });
  }
}
