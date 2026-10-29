import { AuthApiError, AuthSessionMissingError, AuthWeakPasswordError, type AuthError } from '@supabase/supabase-js';
import { env } from '../config/env';

/**
 * Set a signed-in user's new password AS THAT USER'S OWN SESSION (password reset spec §4.2,
 * decision §9.2), by calling the auth provider's user endpoint (PUT /auth/v1/user) with the JWT the
 * browser sent us.
 *
 * Why not `supabaseAdmin.auth.admin.updateUserById`: the provider's admin update ends EVERY session
 * of the user, the caller's included (Supabase Auth `adminUserUpdate` -> `user.UpdatePassword(tx,
 * nil)` -> `Logout(tx, userID)`; seen on staging 2026-10-25, #2866). The user endpoint passes the
 * caller's session id instead (`UpdatePassword(tx, &session.ID)` -> `LogoutAllExceptMe`), so in the
 * same transaction that sets the password it ends every OTHER session and keeps this device signed
 * in.
 *
 * The auth client has no call for this: its `updateUser` only acts on a session stored in that
 * client, and the backend holds only the access token. So this is the same request the auth client
 * would send, made directly; refusals come back as the auth client's own error classes, so
 * lib/auth-provider-errors.ts maps them like every other password write.
 *
 * `current_password` goes along so a provider set to require it (its "require current password"
 * setting) is satisfied; the caller has already re-checked it on a fresh client.
 *
 * Never throws. Never logs. A network failure comes back as an error with a fixed message, so
 * nothing the request carried (the JWT, the password) can surface through it.
 */
export async function updatePasswordAsOwnSession(
  jwt: string,
  attrs: { password: string; currentPassword: string },
): Promise<{ error: AuthError | null }> {
  let res: Response;
  try {
    res = await fetch(`${env.SUPABASE_URL.replace(/\/+$/, '')}/auth/v1/user`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${jwt}`,
        // The response shape the auth client asks for (error `code` in the body).
        'X-Supabase-Api-Version': '2024-01-01',
      },
      body: JSON.stringify({ password: attrs.password, current_password: attrs.currentPassword }),
    });
  } catch {
    return { error: new AuthApiError('Auth provider unreachable', 0, 'request_failed') };
  }
  if (res.ok) return { error: null };

  let data: { code?: unknown; error_code?: unknown; msg?: unknown; message?: unknown; weak_password?: { reasons?: unknown } } = {};
  try {
    data = (await res.json()) as typeof data;
  } catch {
    // No JSON body: the status alone decides.
  }
  const code = typeof data.code === 'string' ? data.code : typeof data.error_code === 'string' ? data.error_code : undefined;
  const message = typeof data.msg === 'string' ? data.msg : typeof data.message === 'string' ? data.message : `HTTP ${res.status}`;
  if (code === 'session_not_found') return { error: new AuthSessionMissingError() };
  if (code === 'weak_password') {
    const reasons = Array.isArray(data.weak_password?.reasons) ? data.weak_password!.reasons : [];
    return { error: new AuthWeakPasswordError(message, res.status, reasons as ConstructorParameters<typeof AuthWeakPasswordError>[2]) };
  }
  return { error: new AuthApiError(message, res.status, code) };
}
