import type { Request } from 'express';
import type { Prisma } from '@prisma/client';
// Its own module, not lib/audit: suites that replace the audit writer must not take the client address with it.
import { getClientIp } from '../client-ip';

/**
 * Roles & Permissions, ticket 25 (finding M6): every change to a person's access leaves one audit row, written in the SAME
 * transaction as the change. Unlike `logAudit` (best effort, after the fact), a failure here throws, so the transaction rolls
 * back and a change with no record never happens. The table only takes new rows (migration M14), so the record can't be
 * edited or removed afterwards.
 *
 * What counts as access here: whether the person is an Admin, and the role they hold (the built-in role and the custom role).
 * A role's own switch edits and a person's switch overrides are recorded in the permission change log, in their own
 * transactions; they are not repeated here.
 */

/** What a person holds, as the record shows it before and after. */
export interface AccessHeld {
  role: string;
  custom_role_id: string | null;
  is_admin: boolean;
}

/** Who made the change, read from the request (the signed-in person, their address and where they called from). */
export interface AccessActor {
  id: string | null;
  email: string | null;
  ip: string | null;
  userAgent: string | null;
}

export function actorOf(req: Request): AccessActor {
  return {
    id: req.user?.id ?? null,
    email: req.user?.email ?? null,
    ip: getClientIp(req),
    userAgent: req.headers['user-agent'] ?? null,
  };
}

export type AccessAction = 'user.admin_granted' | 'user.admin_removed' | 'user.role_changed';

/**
 * The one action a change is recorded as. Becoming or stopping being an Admin is named for that, whatever else moved with it
 * (a move onto the Administrator role is both): the before and after carry the role either way. Null when nothing moved.
 * A new person has nothing before.
 */
export function accessActionFor(before: AccessHeld | null, after: AccessHeld): AccessAction | null {
  const wasAdmin = before?.is_admin ?? false;
  if (!wasAdmin && after.is_admin) return 'user.admin_granted';
  if (wasAdmin && !after.is_admin) return 'user.admin_removed';
  if (!before || before.role !== after.role || before.custom_role_id !== after.custom_role_id) return 'user.role_changed';
  return null;
}

const heldOf = (h: AccessHeld): AccessHeld => ({ role: h.role, custom_role_id: h.custom_role_id, is_admin: h.is_admin });

/**
 * Write the access row for this change inside `tx`. Writes nothing when nothing moved, and returns the action it wrote (the
 * caller tells the Owner when it is an Admin change, after the commit). Throws when the row can't be written.
 */
export async function recordAccessChange(
  tx: Prisma.TransactionClient,
  args: { organizationId: string; actor: AccessActor; targetId: string; before: AccessHeld | null; after: AccessHeld },
): Promise<AccessAction | null> {
  const action = accessActionFor(args.before, args.after);
  if (!action) return null;
  await tx.auditLog.create({
    data: {
      org_id: args.organizationId,
      actor_id: args.actor.id,
      actor_email: args.actor.email,
      action,
      resource_type: 'User',
      resource_id: args.targetId,
      metadata: { before: args.before ? heldOf(args.before) : null, after: heldOf(args.after) } as unknown as Prisma.InputJsonValue,
      ip_address: args.actor.ip,
      user_agent: args.actor.userAgent,
    },
  });
  return action;
}

/**
 * Write the Owner row for a change of the company's Owner inside `tx` (`owner.assigned`, the action migration M11 used for the
 * first Owners, so one query reads every Owner change). Throws when the row can't be written.
 */
export async function recordOwnerChange(
  tx: Prisma.TransactionClient,
  args: { organizationId: string; actor: AccessActor | null; before: string | null; after: string; by: string },
): Promise<void> {
  await tx.auditLog.create({
    data: {
      org_id: args.organizationId,
      actor_id: args.actor?.id ?? null,
      actor_email: args.actor?.email ?? null,
      action: 'owner.assigned',
      resource_type: 'User',
      resource_id: args.after,
      metadata: { before: { owner_user_id: args.before }, after: { owner_user_id: args.after }, by: args.by },
      ip_address: args.actor?.ip ?? null,
      user_agent: args.actor?.userAgent ?? null,
    },
  });
}
