import { logger } from './logger';

/**
 * The ONE place an auth-provider error from a password write becomes user-visible copy
 * (password reset spec §4.2, reused by the reset, retry and admin flows in §5.2 and §7).
 *
 * The provider's own `error.message` never reaches a response: it names the vendor's checks
 * in the vendor's words ("Password is known to be weak..."), and CLAUDE.md treats any API
 * error that reaches the UI as user-visible copy. The detail is logged server-side instead.
 * Never pass a password or token in `context`; only ids and a short label.
 */

/** Shown when the provider's leaked-password check rejects the new password. */
export const BREACHED_PASSWORD_MESSAGE =
  "This password has appeared in a known data breach, so it isn't safe to use. Choose a different one.";

/** Shown when the new password is the one the account already has. */
export const SAME_PASSWORD_MESSAGE = "Choose a password you haven't used here.";

/** Shown for every other provider failure while setting a password. */
export const PASSWORD_UPDATE_FAILED_MESSAGE =
  "We couldn't update your password. Try again or contact ServWave support.";

export interface MappedPasswordError {
  status: 400 | 422;
  body: { error: string; code?: 'weak_password' | 'same_password' };
}

interface ProviderErrorShape {
  name?: unknown;
  status?: unknown;
  code?: unknown;
  message?: unknown;
}

/** True for the provider's breached / weak password rejection (HTTP 422, code `weak_password`). */
export function isWeakPasswordError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as ProviderErrorShape;
  return e.code === 'weak_password' || e.name === 'AuthWeakPasswordError';
}

/**
 * True when the provider says the session behind a JWT no longer exists (`session_not_found`, which
 * the auth client turns into AuthSessionMissingError). A sign-out answered this way had nothing left
 * to end: whatever ended that session got there first. Callers decide what that proves.
 */
export function isSessionMissingError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as ProviderErrorShape;
  return e.name === 'AuthSessionMissingError' || e.code === 'session_not_found';
}

/**
 * True when the provider will not let this session change the password until the user proves
 * themselves again: its "secure password change" setting (`reauthentication_needed`, sessions older
 * than a day) or a second factor it holds (`insufficient_aal`).
 */
export function needsFreshSignInError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as ProviderErrorShape).code;
  return code === 'reauthentication_needed' || code === 'insufficient_aal';
}

/**
 * Map a provider error from setting a password to the response the browser gets, and log
 * the provider's detail. `where` names the flow for the log line (e.g. 'change-password').
 */
export function mapPasswordUpdateError(
  error: unknown,
  where: string,
  context: Record<string, string | undefined> = {},
): MappedPasswordError {
  const e = (error && typeof error === 'object' ? error : {}) as ProviderErrorShape;
  logger.warn(`Auth provider rejected a password update (${where})`, {
    ...context,
    providerStatus: typeof e.status === 'number' ? e.status : undefined,
    providerCode: typeof e.code === 'string' ? e.code : undefined,
    providerMessage: typeof e.message === 'string' ? e.message : String(error),
  });

  if (isWeakPasswordError(error)) {
    return { status: 422, body: { error: BREACHED_PASSWORD_MESSAGE, code: 'weak_password' } };
  }
  if (e.code === 'same_password') {
    return { status: 400, body: { error: SAME_PASSWORD_MESSAGE, code: 'same_password' } };
  }
  return { status: 400, body: { error: PASSWORD_UPDATE_FAILED_MESSAGE } };
}
