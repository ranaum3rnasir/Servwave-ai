import { createPrismaAbility, PrismaAbility } from '@casl/prisma';
import { AbilityBuilder } from '@casl/ability';
import type { Action, Subject } from './catalog';
import { substituteConditions } from './substituteConditions';
import { MATCH_NOTHING } from './scopeWhereFor';
import { getManagedCapability, capabilityAllowsRole } from './userCapabilities';
import { isSuperUser } from './effectiveRole';
import { logger } from '../logger';

export type AppAbility = PrismaAbility<[Action, Subject]>;

export type Grant = {
  action: string;
  subject: string;
  conditions?: Record<string, unknown> | null;
};

// Per-user permission override (RBAC Phase 2 → own-scoped in Phase B). The DB row stays bare
// (action+subject+effect); the own-condition is looked up from USER_CAPABILITIES at build time.
//   'allow' → grant a managed capability the role lacks. Emitted as a CONDITIONAL own-scoped `can`
//             (so it applies only to the user's own records), plus the paired own-scoped
//             `read <subject>` when the capability declares `impliesRead`.
//   'deny'  → revoke a capability the role grants (unconditional `cannot`, wins over the role `can`)
export type PermissionOverride = {
  action: string;
  subject: string;
  effect: 'allow' | 'deny';
};

// Cataloged-but-UNMANAGED (action, subject) pairs that keep their historic UNCONDITIONAL `can`.
// Deliberately NOT in USER_CAPABILITIES: putPermissions must keep 400ing these pairs so no NEW row
// can be minted through the API, and enforce.ts's overrideReadGrants must keep failing closed on
// them. Preserved exactly as-is, not tightened to own-scope - that is a separate card.
//   manage_lines Invoice - gates 4 invoice line/scope routes (invoice.routes.ts:44,57,63,68) and is
//                          how a restricted technician reaches them (inventory-van-restriction).
//   read Estimate        - the Phase B granted-tech estimate read (phaseB-controllers-estimate-
//                          ownscope). create/update Estimate are managed; a bare read is not.
export const GRANDFATHERED_UNMANAGED_ALLOWS: ReadonlyArray<{ action: string; subject: string }> = [
  { action: 'manage_lines', subject: 'Invoice' },
  { action: 'read', subject: 'Estimate' },
];
const GRANDFATHERED_KEYS = new Set(
  GRANDFATHERED_UNMANAGED_ALLOWS.map((g) => `${g.action}:${g.subject}`),
);

// SRVW-138: custom_role_id is consulted ONLY via isSuperUser, to decide whether the ADMIN
// short-circuit applies. The custom role's grants arrive already resolved in `grants`.
type AbilityUser = {
  id: string;
  role: string;
  custom_role_id?: string | null;
  department_id?: string | null;
  location_id?: string | null;
};

// Substitute {{userId}}/{{teamId}}/{{locationId}} in a condition template, FAIL-CLOSED on a
// null team/location token (emit match-nothing instead of the fail-open `*_id: null` match —
// mirrors scopeWhereFor). Shared by the role-grant loop and the per-user override loop.
function resolveConditions(
  conditions: Record<string, unknown> | null | undefined,
  user: AbilityUser,
): Record<string, unknown> | undefined {
  const needsTeam = JSON.stringify(conditions ?? null).includes('{{teamId}}');
  const needsLoc = JSON.stringify(conditions ?? null).includes('{{locationId}}');
  const failClosed =
    (needsTeam && (user.department_id ?? null) === null) ||
    (needsLoc && (user.location_id ?? null) === null);
  return failClosed
    ? { ...MATCH_NOTHING }
    : substituteConditions(conditions, {
        userId: user.id,
        teamId: user.department_id ?? null,
        locationId: user.location_id ?? null,
      });
}

export function defineAbilityFor(
  user: AbilityUser,
  grants: Grant[],
  overrides: PermissionOverride[] = [],
): AppAbility {
  const { can, cannot, build } = new AbilityBuilder<AppAbility>(createPrismaAbility);

  // ADMIN is a superuser (`manage all`) and is NEVER affected by per-user overrides.
  // SRVW-138: an ADMIN-DERIVED custom role is NOT a superuser. It carries a seeded explicit
  // grant set that the admin subtracts from, so it must fall through to the grant loop -
  // short-circuiting it here would silently restore full access and make every subtraction
  // a no-op. isSuperUser is base-role ADMIN *and* no custom role.
  if (isSuperUser(user)) {
    can('manage', 'all' as Subject);
    return build();
  }

  for (const grant of grants) {
    const conds = resolveConditions(
      grant.conditions as Record<string, unknown> | null | undefined,
      user,
    );
    if (conds) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      can(grant.action as Action, grant.subject as Subject, conds as any);
    } else {
      can(grant.action as Action, grant.subject as Subject);
    }
  }

  // Per-user overrides layer on top of the role grant. Declared LAST so a deny `cannot`
  // wins over a role `can` (CASL: later inverted rules take precedence).
  //   deny  → unconditional `cannot` (full revoke).
  //   allow → CONDITIONAL own-scoped `can` (the capability's OWN_* condition, {{userId}}
  //           substituted) so the grant applies only to the user's own records; a write/advance
  //           capability also emits the paired own-scoped `read <subject>` (impliesRead) so the
  //           grantee can SEE the records they may now act on (scopeWhereFor reads only the read
  //           grant for a subject's row-scope). A conditional `can` STILL satisfies a bare-subject
  //           `can(action, subject)` route guard (canDo) — controllers do the real ownership
  //           narrowing, and for CREATE the controller parent-check is the only real enforcer.
  for (const ov of overrides) {
    if (ov.effect === 'deny') {
      cannot(ov.action as Action, ov.subject as Subject);
      continue;
    }
    const cap = getManagedCapability(ov.action, ov.subject);
    if (!cap) {
      // FAIL-CLOSED (SRVW-101). An override row whose (action, subject) is not in
      // USER_CAPABILITIES grants NOTHING unless it is on GRANDFATHERED_UNMANAGED_ALLOWS above.
      // This now matches enforce.ts's overrideReadGrants, which has always failed closed on the
      // identical input (`!cap -> skip`), so the CASL ability and the SQL read scope agree for
      // every pair outside the allow-list.
      //
      // The two grandfathered pairs keep their UNCONDITIONAL `can` because closing the branch
      // without them was attempted and REVERTED: it turns 4 invoice line/scope routes
      // (invoice.routes.ts:44,57,63,68) and the Phase B granted-tech estimate read into silent
      // 403s. A catalog check would NOT be a substitute for the explicit list - all three
      // historically-affected pairs are catalog entries, including the dangerous one.
      //
      // The exposure this closes: `process LogisticOrder` is cataloged-but-unmanaged (the
      // capability was deliberately not shipped), and its route IS mounted
      // (logistic-order.routes.ts:34) with no secondary role or ownership check, so a stored
      // ('process','LogisticOrder','allow') row used to confer the stock-deducting verb on ANY
      // role, incl. TECHNICIAN. putPermissions 400s such a row, but a migration can write one
      // (20260717040000 already INSERTs into user_permission_overrides), which is why the skip
      // is logged rather than silent.
      if (GRANDFATHERED_KEYS.has(`${ov.action}:${ov.subject}`)) {
        can(ov.action as Action, ov.subject as Subject);
      } else {
        logger.warn(
          `[permissions] per-user override ignored: action="${ov.action}" subject="${ov.subject}" user_id="${user.id}" - not a managed capability and not grandfathered, so it grants nothing. A row like this can only have been written by raw SQL or a migration.`,
        );
      }
      continue;
    }
    // Role-gated capability held by a role that may not hold it → emit NOTHING. The endpoint
    // refuses to persist such a row, so this only fires for a row written before the gate existed
    // (or straight into the DB); dropping it here keeps the CASL ability in step with the SQL
    // scope, where enforce.ts's overrideReadGrants applies the identical filter.
    if (!capabilityAllowsRole(cap, user.role)) continue;
    const ownConds = resolveConditions(cap.ownCondition, user);
    if (ownConds) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      can(ov.action as Action, ov.subject as Subject, ownConds as any);
      if (cap.impliesRead) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        can('read' as Action, ov.subject as Subject, ownConds as any);
      }
    } else {
      can(ov.action as Action, ov.subject as Subject);
      if (cap.impliesRead) {
        // #2042 security fix round 1 (F2) — no ownCondition means this is an ORG-WIDE authority
        // (e.g. `approve LogisticOrder`), but its implied read must not widen the role's OWN
        // read scope on the subject. Inherit the role's own persisted `read <subject>` condition
        // when it has one (SALES's job-scoped LogisticOrder read); stay unconditional when the
        // role's own read is itself unconditional (DISPATCHER) or absent. Matches
        // enforce.ts's overrideReadGrants, which applies the identical rule on the SQL side.
        const roleOwnRead = grants.find((g) => g.action === 'read' && g.subject === ov.subject);
        const roleReadConds = resolveConditions(roleOwnRead?.conditions, user);
        if (roleReadConds) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          can('read' as Action, ov.subject as Subject, roleReadConds as any);
        } else {
          can('read' as Action, ov.subject as Subject);
        }
      }
    }
  }

  return build();
}
