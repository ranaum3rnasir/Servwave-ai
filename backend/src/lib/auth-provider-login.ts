import { supabaseAdmin } from './supabase';
import { logger } from './logger';

/**
 * The person's login at the identity provider (Supabase Auth), found and removed by email (security finding H2, build item 10).
 *
 * The provider's account id is not the app user's id for an invited person (lib/auth-user.ts), so the account is found by
 * paging the provider's account list. The paging runs to the last page, however many accounts there are: the provider's
 * accounts belong to every company, and a cap (it used to stop at 50 pages of 200, 10,000 accounts) let Revoke silently miss
 * the person. Only whether the provider says there is a next page is read, never its page number (the SDK parses that from the
 * Link header one digit at a time).
 */

const PAGE_SIZE = 200;

/** The login could not be removed. Carries no provider text: callers answer with ServWave copy and log this. */
export class ProviderLoginRemovalError extends Error {
  constructor(readonly step: 'list' | 'delete', readonly cause?: unknown) {
    super(`provider login removal failed at ${step}`);
    this.name = 'ProviderLoginRemovalError';
  }
}

/** The provider says the account is already gone: removing it again is done, not a failure. */
function isAlreadyGone(error: unknown): boolean {
  const e = error as { status?: number; code?: string } | null;
  return e?.status === 404 || e?.code === 'user_not_found';
}

/** Remove one provider account by its id. Throws ProviderLoginRemovalError when the provider refuses or the call fails. */
export async function removeProviderAccount(accountId: string): Promise<void> {
  let error: unknown;
  try {
    ({ error } = await supabaseAdmin.auth.admin.deleteUser(accountId));
  } catch (err) {
    throw new ProviderLoginRemovalError('delete', err);
  }
  if (error && !isAlreadyGone(error)) throw new ProviderLoginRemovalError('delete', error);
}

/**
 * Find the login for this email and remove it. 'removed' when one was removed, 'none' when the provider holds none.
 * Throws ProviderLoginRemovalError when the list or the removal fails: the caller must not report success.
 */
export async function removeProviderLogin(email: string): Promise<'removed' | 'none'> {
  const target = email.toLowerCase();
  for (let page = 1; ; page++) {
    let data: { users?: { id: string; email?: string | null }[]; nextPage?: number | null } | null;
    let error: unknown;
    try {
      ({ data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: PAGE_SIZE }));
    } catch (err) {
      throw new ProviderLoginRemovalError('list', err);
    }
    if (error) throw new ProviderLoginRemovalError('list', error);
    const users = data?.users ?? [];
    const match = users.find((u) => u.email?.toLowerCase() === target);
    if (match) {
      await removeProviderAccount(match.id);
      return 'removed';
    }
    // The last page: an empty page, or no next page.
    if (users.length === 0 || data?.nextPage == null) return 'none';
  }
}

/**
 * The same, where a failure must not stop the caller: a deactivation, an erase or a delete has already turned the person's
 * sign-in off in the database (signInRefusal refuses them at every door), and the provider's account is a second lock.
 * Logged, never thrown. Returns whether the provider is now clear.
 */
export async function removeProviderLoginQuietly(email: string, why: string): Promise<boolean> {
  try {
    await removeProviderLogin(email);
    return true;
  } catch (err) {
    logger.error(`Identity provider login removal failed (${why}); the database already refuses this person`, {
      step: err instanceof ProviderLoginRemovalError ? err.step : 'unknown',
      cause: err instanceof ProviderLoginRemovalError ? err.cause : err,
    });
    return false;
  }
}
