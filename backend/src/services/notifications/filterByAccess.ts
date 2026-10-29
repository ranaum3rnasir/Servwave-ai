/**
 * filterByAccess.ts — CASL row-scope recipient filter (Task 2.4)
 *
 * For each resolved notification recipient, verifies they can actually access
 * the notification's primary object row before including them. This prevents
 * leaking cross-org or out-of-scope row references through notification delivery.
 *
 * Fail-closed: missing user → DROP; canAccessRow throws → DROP + warn.
 */

import type { Request } from 'express';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { canAccessRow } from '../../lib/permissions/enforce';
import { getCachedGrants, setCachedGrants } from '../../lib/permissions/permissionCache';
import { loadUserOverrides } from '../../lib/permissions/loadUserOverrides';
import { defineAbilityFor } from '../../lib/permissions/defineAbility';
import type { ScopeResource } from '../../lib/permissions/scopeWhereFor';

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

// Prisma delegate type matching RowDelegate in enforce.ts (which canAccessRow's `delegate`
// parameter is typed against - #2042 widened it with a `count` member).
type RowDelegate = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  findFirst(args: any): Promise<{ id: string } | null>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  count(args: any): Promise<number>;
};

/**
 * Filters a list of recipientIds down to those who have read access to the
 * given objectType/objectId row, using the same CASL ability + scopeWhereFor
 * path as attachAbility + canAccessRow.
 *
 * - Non-scoped object types (anything not in SCOPE_TYPE_MAP) pass through
 *   unchanged — no DB call.
 * - Unknown user (missing from DB within org) → DROPPED (fail-closed).
 * - canAccessRow throws for any recipient → DROPPED + logger.warn (fail-closed).
 * - Input order is preserved for kept ids.
 */
export async function filterRecipientsByAccess(
  objectType: string,
  objectId: string,
  recipientIds: string[],
  organizationId: string,
): Promise<string[]> {
  const scopeResource = SCOPE_TYPE_MAP[objectType.toUpperCase()];

  // Non-scoped type → passthrough, no access check needed.
  if (!scopeResource) {
    return recipientIds;
  }

  // Delegate map: matches the scope resource to its Prisma delegate.
  const delegateMap: Record<ScopeResource, RowDelegate> = {
    Lead: prisma.lead,
    Job: prisma.job,
    Estimate: prisma.estimate,
    Invoice: prisma.invoice,
    // LO-1: present so this map stays EXHAUSTIVE over ScopeResource (that exhaustiveness is the
    // compile-time guarantee that a new scoped subject can't silently reach an undefined
    // delegate). Currently unreachable — SCOPE_TYPE_MAP has no LOGISTIC_ORDER objectType, so no
    // notification resolves to this resource yet; wiring one up is all that's needed.
    LogisticOrder: prisma.logisticOrder,
    // #2042: present so this map stays EXHAUSTIVE over ScopeResource, same reasoning as
    // LogisticOrder above. Currently unreachable — SCOPE_TYPE_MAP has no PURCHASE_ORDER
    // objectType, so no notification resolves to this resource yet.
    PurchaseOrder: prisma.purchaseOrder,
    // #2041: present so this map stays EXHAUSTIVE over ScopeResource, same reasoning as
    // LogisticOrder/PurchaseOrder above. Currently unreachable — SCOPE_TYPE_MAP has no CUSTOMER
    // objectType, so no notification resolves to this resource yet.
    Customer: prisma.customer,
  };
  const delegate = delegateMap[scopeResource];

  // Load all recipient users in one query — only within the org.
  const users = await prisma.user.findMany({
    where: { id: { in: recipientIds }, organization_id: organizationId },
    select: { id: true, role: true, organization_id: true, department_id: true, location_id: true },
  });

  const userMap = new Map(users.map((u) => [u.id, u]));

  const kept: string[] = [];

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
      // Build ability using the exact same pattern as attachAbility.ts.
      let ability;
      if (user.role === 'ADMIN') {
        ability = defineAbilityFor(user, []);
      } else {
        let grants = getCachedGrants(organizationId, user.role);
        if (!grants) {
          const rows = await prisma.rolePermission.findMany({
            where: { organization_id: organizationId, role: user.role },
            select: { action: true, subject: true, conditions: true },
          });
          grants = rows.map((r) => ({
            action: r.action,
            subject: r.subject,
            conditions: r.conditions as Record<string, unknown> | null,
          }));
          setCachedGrants(organizationId, user.role, grants);
        }

        const overrides = await loadUserOverrides(user.id);
        ability = defineAbilityFor(user, grants, overrides);
      }

      // Construct minimal req that canAccessRow needs: { user, ability }.
      const req = { user, ability } as unknown as Request;

      if (await canAccessRow(req, scopeResource, delegate, objectId)) {
        kept.push(recipientId);
      }
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

  return kept;
}
