import { Role } from '@prisma/client';
import { prisma } from './prisma';
import { orgFeatures, effectivePlan } from './entitlements/resolve';
import { isSpiderPilotOrg } from '../services/spider/gate';

export interface AppUser {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  // SRVW-138: the BASE role. Custom-role users keep a real Role here and inherit its
  // code-level behaviour; only their GRANTS come from the custom role.
  role: Role;
  // Roles & Permissions P15: the Admin flag. Selected with the role, always - see effectiveRole.isSuperUser.
  is_admin: boolean;
  custom_role_id?: string | null;
  // MUST be selected whenever custom_role_id is: grantRoleKey throws without it rather
  // than falling back to the base role's (possibly wider) grant set.
  custom_role?: { key: string } | null;
  is_active: boolean;
  has_login: boolean;
  organization_id: string;
  // True when the user's org is flagged is_demo — drives mock-first surfaces
  // (Reports) on the frontend. Flattened from the organization relation.
  org_is_demo: boolean;
  // Is on the Spider pilot list (SPIDER_PILOT_ORG_IDS, SPEC-5); the Spider gate also needs the feature.
  org_is_spider_pilot: boolean;
  // Effective plan (trial-aware) + resolved feature keys. Same query, no extra
  // round trip — the precedent org_is_demo set.
  org_plan: string;
  org_features: string[];
  // The company's Owner (AL-16), for the sign-in payload only: who the app shows as Owner. Read fresh at each sign-in and
  // deliberately NOT carried into the cached session (middleware/authenticate.ts): every Owner check reads the database
  // (lib/users/owner.ts). Null when the company has none.
  org_owner_user_id: string | null;
  department_id?: string | null;
  location_id?: string | null;
  phone?: string | null;
  phone_ext?: string | null;
}

const SELECT = {
  id: true,
  email: true,
  first_name: true,
  last_name: true,
  role: true,
  is_admin: true,
  custom_role_id: true,
  // Selected together with custom_role_id, always - see AppUser.custom_role.
  custom_role: { select: { key: true } },
  is_active: true,
  has_login: true,
  organization_id: true,
  department_id: true,
  location_id: true,
  phone: true,
  phone_ext: true,
  organization: {
    select: { is_demo: true, plan: true, trial_ends_at: true, feature_overrides: true, owner_user_id: true },
  },
} as const;

type UserRow = Omit<AppUser, 'org_is_demo' | 'org_is_spider_pilot' | 'org_plan' | 'org_features' | 'org_owner_user_id'> & {
  organization: {
    is_demo: boolean;
    plan: string;
    trial_ends_at: Date | null;
    feature_overrides: unknown;
    owner_user_id: string | null;
  } | null;
};

// Flatten the org relation into the AppUser shape. Fails closed on a missing
// relation: is_demo false (never leak mocks) and STARTER (never leak paid
// modules). orgFeatures/effectivePlan never throw on a drifted plan value.
function toAppUser(row: UserRow): AppUser {
  const { organization, ...rest } = row;
  const source = {
    plan: organization?.plan ?? 'STARTER',
    trial_ends_at: organization?.trial_ends_at ?? null,
    feature_overrides: (organization?.feature_overrides ?? {}) as Record<string, unknown> | null,
  };
  return {
    ...rest,
    org_is_demo: organization?.is_demo ?? false,
    org_is_spider_pilot: organization ? isSpiderPilotOrg(rest.organization_id) : false,
    org_plan: effectivePlan(source),
    org_features: orgFeatures(source),
    org_owner_user_id: organization?.owner_user_id ?? null,
  };
}

/**
 * Map a verified Supabase user to a Prisma app user.
 *
 * Looks up by Supabase id first (the normal case — Supabase account linking
 * preserves the id when an admin-created confirmed-email user signs in with
 * Google). Falls back to a CONFIRMED-email match so a Google identity still
 * resolves even if linking produced a new id. An unconfirmed email never
 * matches (guards against a Google account spoofing someone's address).
 *
 * Shared by the authenticate middleware and the Google finalize endpoint so
 * both resolve a user identically — including department_id/location_id, which
 * CASL scope filtering depends on.
 */
export async function resolveAppUser(supaUser: {
  id: string;
  email?: string | null;
  email_confirmed_at?: string | null;
}): Promise<AppUser | null> {
  const byId = await prisma.user.findUnique({ where: { id: supaUser.id }, select: SELECT });
  if (byId) return toAppUser(byId as UserRow);

  if (supaUser.email && supaUser.email_confirmed_at) {
    // Case-insensitive: providers hand back a lowercased email, but a legacy
    // row may have been stored mixed-case.
    const byEmail = await prisma.user.findFirst({
      where: { email: { equals: supaUser.email, mode: 'insensitive' } },
      select: SELECT,
    });
    if (byEmail) return toAppUser(byEmail as UserRow);
  }

  return null;
}

/**
 * Why this person may not sign in or hold a session, or null when they may (security finding H2). THE one sign-in check:
 * the authenticate middleware runs it on every session before any route, and every door that mints a session (password,
 * two-step code, refresh, Google, an invite link, a password reset) runs it before answering. A deactivated person is out,
 * and so is a person whose sign-in an Admin revoked: Revoke turns `has_login` off, and the login it removes at the identity
 * provider is a second lock, never the only one.
 *
 * `has_login` is NOT NULL in the database (and every reader here selects it), so `=== false` and `!has_login` agree on every
 * real row; the strict form keeps hand-built test users that omit the field signed in, as they always were.
 */
export type SignInRefusal = 'deactivated' | 'no_login';
export function signInRefusal(user: { is_active: boolean; has_login?: boolean }): SignInRefusal | null {
  if (!user.is_active) return 'deactivated';
  if (user.has_login === false) return 'no_login';
  return null;
}

/**
 * May this person still sign in RIGHT NOW? Read under a row lock, after a slow call to the identity provider that made them a
 * login (accepting an invite): an Admin who revoked or deactivated them while the call was in flight has changed the row, and
 * the caller then undoes the login it just made. Revoke and deactivate change the row BEFORE they look for the login at the
 * provider, so whichever way the two interleave, no login outlives the revoke.
 */
export async function stillMaySignIn(userId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ is_active: boolean; has_login: boolean }[]>`
      SELECT is_active, has_login FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
    const row = rows[0];
    return Boolean(row) && signInRefusal(row!) === null;
  });
}
