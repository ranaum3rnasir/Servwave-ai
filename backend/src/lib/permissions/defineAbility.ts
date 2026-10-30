import { createPrismaAbility, PrismaAbility } from '@casl/prisma';
import { AbilityBuilder } from '@casl/ability';
import type { Action, Subject } from './catalog';
import { substituteConditions } from './substituteConditions';
import { MATCH_NOTHING } from './scopeWhereFor';
import { isSuperUser } from './effectiveRole';

export type AppAbility = PrismaAbility<[Action, Subject]>;

export type Grant = {
  action: string;
  subject: string;
  conditions?: Record<string, unknown> | null;
};

// SRVW-138: custom_role_id is consulted ONLY via isSuperUser, to decide whether the ADMIN
// short-circuit applies. The custom role's grants arrive already resolved in `grants`.
type AbilityUser = {
  id: string;
  role: string;
  /** The Admin flag (P15). */
  is_admin: boolean;
  custom_role_id?: string | null;
  department_id?: string | null;
  location_id?: string | null;
};

// Substitute {{userId}}/{{teamId}} in a condition template, FAIL-CLOSED on a
// null team token (emit match-nothing instead of the fail-open `*_id: null` match —
// mirrors scopeWhereFor).
function resolveConditions(
  conditions: Record<string, unknown> | null | undefined,
  user: AbilityUser,
): Record<string, unknown> | undefined {
  const needsTeam = JSON.stringify(conditions ?? null).includes('{{teamId}}');
  const failClosed = needsTeam && (user.department_id ?? null) === null;
  return failClosed
    ? { ...MATCH_NOTHING }
    : substituteConditions(conditions, {
        userId: user.id,
        teamId: user.department_id ?? null,
      });
}

export function defineAbilityFor(user: AbilityUser, grants: Grant[]): AppAbility {
  const { can, build } = new AbilityBuilder<AppAbility>(createPrismaAbility);

  // The Admin box (built-in Admin, no custom role) is a superuser (`manage all`) with no switches.
  // SRVW-138: an ADMIN-DERIVED custom role is NOT a superuser. It is an ordinary switch set that starts with
  // everything on, so it falls through to the grant loop - short-circuiting it here would silently restore full
  // access and make every switch an admin turns off a no-op. isSuperUser is base-role ADMIN *and* no custom role.
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

  return build();
}
