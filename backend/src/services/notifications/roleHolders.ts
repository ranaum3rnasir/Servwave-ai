/**
 * roleHolders.ts — loads active users grouped by role for an organization.
 *
 * Used by emit() to populate the `roleHolders` context that resolveRecipients()
 * needs when the caller hasn't pre-supplied them via args.entity.roleHolders.
 */

import { prisma } from '../../lib/prisma';
import type { Prisma } from '@prisma/client';

export type RoleHolders = {
  ADMIN: string[];
  DISPATCHER: string[];
  SALES: string[];
  TECHNICIAN: string[];
};

/**
 * Load all active users in the org and group their IDs by role.
 *
 * @param organizationId - The org to query.
 * @param client - Optional Prisma client (or transaction client). Defaults to the singleton.
 */
export async function loadRoleHolders(
  organizationId: string,
  client: Pick<typeof prisma, 'user'> | Prisma.TransactionClient = prisma,
): Promise<RoleHolders> {
  const users = await client.user.findMany({
    where: { organization_id: organizationId, is_active: true },
    select: { id: true, role: true },
  });

  const result: RoleHolders = { ADMIN: [], DISPATCHER: [], SALES: [], TECHNICIAN: [] };
  for (const u of users) {
    const bucket = result[u.role as keyof RoleHolders];
    if (bucket) bucket.push(u.id);
  }
  return result;
}
