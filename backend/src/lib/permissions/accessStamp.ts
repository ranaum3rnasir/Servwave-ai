import { createHash } from 'crypto';
import type { Role } from '@prisma/client';
import { prisma } from '../prisma';
import type { AppUser } from '../auth-user';
import { effectivePlan, orgFeatures } from '../entitlements/resolve';

/**
 * The access stamp: the version of a person's access, read from the database on every request (spec story 67, ticket 37).
 *
 * Each server keeps, for up to a minute, the people it signed in (middleware/authenticate.ts) and their resolved switches
 * (switches/cache.ts). A change used to clear only the memory of the server that made it, so another server kept letting a
 * deactivated or revoked person in, or kept their old switches, until its copy ran out. Now every request reads this stamp
 * and a copy is used only while the stamp it was made under still matches, so a change made on any server, or straight in the
 * database, is seen by every server on the person's next request.
 *
 * The stamp is made from the access itself, never from a counter a writer must remember to move:
 *  - `signIn`: what the sign-in copy carries that decides access: active, may sign in, the Admin flag, the role and custom
 *    role, the department and location, the company and its plan and features. `signInStampOf` makes it the same way from
 *    the person the sign-in read, so the copy and the database are compared field for field.
 *  - `switches`: the person's switches (the P17 stamp the browser also gets): their own stored values, the stored values of
 *    the role they are based on, that role's own row, which role they are based on, their department and the Admin flag.
 *    Values, not edit times, are digested, so a write that leaves no newer timestamp (a Reset deletes rows) still moves it.
 *    The Admin box holds no stored set: its stamp is the constant 'admin'.
 * One round trip, by primary key and the role's own rows.
 */
export interface AccessStamp {
  signIn: string;
  switches: string;
}

export const ADMIN_BOX_STAMP = 'admin';

type SignInFields = Pick<
  AppUser,
  'id' | 'organization_id' | 'is_active' | 'has_login' | 'is_admin' | 'role' | 'custom_role_id' | 'custom_role'
  | 'department_id' | 'location_id' | 'org_is_demo' | 'org_plan' | 'org_features'
>;

/** The sign-in part of the stamp, from a person as the sign-in reads them (resolveAppUser) or as `readAccessStamp` reads them. */
export function signInStampOf(u: SignInFields): string {
  const fields = [
    u.id, u.organization_id, u.is_active, u.has_login !== false, u.is_admin, u.role, u.custom_role_id ?? null,
    u.custom_role?.key ?? null, u.department_id ?? null, u.location_id ?? null, u.org_is_demo, u.org_plan,
    [...u.org_features].sort(),
  ];
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

interface Row {
  id: string;
  organization_id: string;
  role: Role;
  is_admin: boolean;
  is_active: boolean;
  has_login: boolean;
  custom_role_id: string | null;
  custom_role_key: string | null;
  department_id: string | null;
  location_id: string | null;
  org_found: boolean;
  is_demo: boolean | null;
  plan: string | null;
  trial_ends_at: Date | null;
  feature_overrides: unknown;
  switches: string;
}

/** The person's access stamp now, or null when there is no such person (or the request's company cannot see them). */
export async function readAccessStamp(userId: string): Promise<AccessStamp | null> {
  const rows = await prisma.$queryRaw<Row[]>`
    WITH me AS (
      SELECT u.id, u.organization_id, u.role, u.is_admin, u.is_active, u.has_login, u.department_id, u.location_id,
             u.based_on_role_key, u.custom_role_id, cr.key AS custom_role_key,
             coalesce(u.based_on_role_key, cr.key, u.role::text) AS role_key
        FROM users u
        LEFT JOIN custom_roles cr ON cr.id = u.custom_role_id
       WHERE u.id = ${userId}::uuid
    )
    SELECT me.id, me.organization_id, me.role, me.is_admin, me.is_active, me.has_login, me.custom_role_id, me.custom_role_key,
           me.department_id, me.location_id,
           (o.id IS NOT NULL) AS org_found, o.is_demo, o.plan::text AS plan, o.trial_ends_at, o.feature_overrides,
           CASE WHEN me.is_admin THEN ${ADMIN_BOX_STAMP}::text ELSE md5(concat_ws('|',
             me.role::text, coalesce(me.based_on_role_key, ''), coalesce(me.custom_role_id::text, ''),
             coalesce(me.department_id::text, ''),
             (SELECT concat_ws(':', count(*), md5(string_agg(s.switch_key || '=' || s.value::text, ',' ORDER BY s.switch_key)))
                FROM permission_user_switches s WHERE s.user_id = me.id),
             (SELECT concat_ws(':', count(*), md5(string_agg(s.switch_key || '=' || s.value::text, ',' ORDER BY s.switch_key)))
                FROM permission_role_switches s WHERE s.organization_id = me.organization_id AND s.role_key = me.role_key),
             (SELECT concat_ws(':', r.updated_at, r.archived_at, r.base_role::text, r.made_from_blank::text)
                FROM custom_roles r WHERE r.organization_id = me.organization_id AND r.key = me.role_key)
           )) END AS switches
      FROM me
      LEFT JOIN organizations o ON o.id = me.organization_id`;
  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (!row) return null;
  // The company's plan and features exactly as the sign-in derives them (lib/auth-user.ts): none found reads as no plan.
  const plan = { plan: row.plan ?? 'STARTER', trial_ends_at: row.trial_ends_at, feature_overrides: (row.feature_overrides ?? {}) as Record<string, unknown> | null };
  const person: SignInFields = {
    id: row.id, organization_id: row.organization_id, is_active: row.is_active, has_login: row.has_login, is_admin: row.is_admin,
    role: row.role, custom_role_id: row.custom_role_id, custom_role: row.custom_role_key ? { key: row.custom_role_key } : null,
    department_id: row.department_id, location_id: row.location_id,
    org_is_demo: row.org_found ? (row.is_demo ?? false) : false,
    org_plan: effectivePlan(plan), org_features: orgFeatures(plan),
  };
  return { signIn: signInStampOf(person), switches: row.switches };
}
