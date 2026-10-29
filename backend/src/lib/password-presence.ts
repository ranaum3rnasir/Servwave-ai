import { prisma } from './prisma';
import { logger } from './logger';
import { supabaseAdmin } from './supabase';

/**
 * Does the signed-in user have a password? (password reset spec §4.1 last bullet, slice 06.)
 *
 * A user who only ever signed in with Google has none, so the change form (which re-checks the
 * current password) cannot work for them; Login & Security offers "Set a password by email"
 * instead, and POST /api/users/me/password refuses them plainly.
 *
 * Decided from server-side data only, never from the request:
 *  1. The auth account's sign-in methods, read by the auth id from the VERIFIED token. An `email`
 *     identity is made when an account is created with a password (accepting an invite, an admin
 *     "create user"). An account whose methods are all something else (Google) started without one.
 *  2. The provider does not reliably add an `email` identity when a password is later set on such
 *     an account (via the reset link), so a ServWave record that we set one (`user.password_reset`,
 *     `user.password_changed` audit rows for this user) also counts. Every password write goes
 *     through the backend and is audited (spec §3.1).
 *
 * When the methods cannot be read, or the provider lists none, this answers true: the page then
 * shows the usual form, and the change endpoint still re-checks the current password, so a wrong
 * guess here costs convenience, never safety.
 *
 * The result is a yes/no for the page. The auth id and the provider's identity list never leave
 * the server.
 */

/** Audit actions that record ServWave setting a password for this user. */
const PASSWORD_SET_ACTIONS = ['user.password_reset', 'user.password_changed'];

export async function userHasPassword(user: { id: string; organization_id: string; auth_id?: string }): Promise<boolean> {
  if (!user.auth_id) return true;
  let providers: string[] | null = null;
  try {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(user.auth_id);
    const identities = data?.user?.identities;
    if (!error && Array.isArray(identities) && identities.length > 0) {
      providers = identities.map((i) => String(i?.provider ?? ''));
    } else if (error) {
      logger.warn('Sign-in methods could not be read', { userId: user.id, providerStatus: (error as { status?: number }).status });
    }
  } catch (err) {
    logger.warn('Sign-in methods lookup threw', { userId: user.id, name: err instanceof Error ? err.name : typeof err });
  }
  if (!providers || providers.includes('email')) return true;

  try {
    const setByUs = await prisma.auditLog.count({
      where: {
        org_id: user.organization_id,
        resource_type: 'User',
        resource_id: user.id,
        action: { in: PASSWORD_SET_ACTIONS },
      },
    });
    return setByUs > 0;
  } catch (err) {
    logger.warn('Password history lookup failed', { userId: user.id, name: err instanceof Error ? err.name : typeof err });
    return true;
  }
}
