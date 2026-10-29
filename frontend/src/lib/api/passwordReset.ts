import api from '@/lib/axios';

/**
 * The signed-out password reset (password reset spec §5.2).
 *
 * `requestResetLink` always resolves the same way for any well-formed email: the server never says
 * whether an account exists. `setPasswordFromLink` sends the reset link's token in the POST body
 * only, never in a URL, so it stays out of request logs.
 *
 * Both pass `silentErrors`: the pages show every failure inline, so the app-wide 429/500 toast would
 * only repeat it (final review item 7).
 */
export async function requestResetLink(email: string): Promise<void> {
  await api.post('/api/auth/password/forgot', { email }, { silentErrors: true });
}

/** Inline copy for a rate-limited request on the forgot and reset pages (the limiter's own body is generic). */
export const TOO_MANY_ATTEMPTS_MESSAGE = 'Too many attempts. Wait a few minutes, then try again.';

/** Whether the request was refused by a rate limit. */
export function isRateLimited(err: unknown): boolean {
  return (err as { response?: { status?: number } } | null)?.response?.status === 429;
}

/**
 * Resolves once the password is set. `otherSessionsSignedOut` is true only when the server confirms
 * every other session was signed out; anything else is reported as not signed out.
 */
export async function setPasswordFromLink(token: string, newPassword: string): Promise<{ otherSessionsSignedOut: boolean }> {
  const { data } = await api.post('/api/auth/password/reset', { token, password: newPassword }, { silentErrors: true });
  return { otherSessionsSignedOut: (data as { sessions_signed_out?: unknown } | undefined)?.sessions_signed_out === true };
}

/** The server's code for an unknown, used or expired reset link. */
export const INVALID_RESET_LINK_CODE = 'invalid_reset_link';

/** The server's code for a password refused as breached. */
export const WEAK_PASSWORD_CODE = 'weak_password';

/**
 * After a breached password, the server spends the link but may hand back a replacement token for
 * the same user (spec §5.2), so the user can try another password without a new email. Returns it
 * only for that answer; anything else, including a token on any other error, yields null. The
 * caller keeps it in memory only: never in the URL, storage or the page.
 */
export function replacementTokenFrom(err: unknown): string | null {
  const data = (err as { response?: { status?: number; data?: { code?: unknown; token?: unknown } } })?.response?.data;
  if (data?.code !== WEAK_PASSWORD_CODE) return null;
  return typeof data.token === 'string' && data.token.length > 0 ? data.token : null;
}
