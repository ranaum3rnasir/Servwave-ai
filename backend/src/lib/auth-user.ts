import { Role } from '@prisma/client';
import { prisma } from './prisma';
import { orgFeatures, effectivePlan } from './entitlements/resolve';

export interface AppUser {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  // SRVW-138: the BASE role. Custom-role users keep a real Role here and inherit its
  // code-level behaviour; only their GRANTS come from the custom role.
  role: Role;
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
  // Effective plan (trial-aware) + resolved feature keys. Same query, no extra
  // round trip — the precedent org_is_demo set.
  org_plan: string;
  org_features: string[];
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
    select: { is_demo: true, plan: true, trial_ends_at: true, feature_overrides: true },
  },
} as const;

type UserRow = Omit<AppUser, 'org_is_demo' | 'org_plan' | 'org_features'> & {
  organization: {
    is_demo: boolean;
    plan: string;
    trial_ends_at: Date | null;
    feature_overrides: unknown;
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
    org_plan: effectivePlan(source),
    org_features: orgFeatures(source),
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
