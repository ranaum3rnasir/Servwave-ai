import { Prisma } from '@prisma/client';
import { env } from '../config/env';
import { prisma } from './prisma';
import { logger } from './logger';
import { supabaseAdmin, createIsolatedAuthClient } from './supabase';
import { sendPasswordResetEmail } from './email';
import { resolveAppUser, type AppUser } from './auth-user';
import { clearTokenCache } from '../middleware/authenticate';
import { isWeakPasswordError, isSessionMissingError } from './auth-provider-errors';

/**
 * Sending a password reset link (password reset spec §5.2, §7; conductor brief §3.1-§3.3).
 *
 * One path for every reset email: the user's own "Forgot password?" request (slice 04) and an
 * admin's "Send password reset" (slice 07) both go through `reservePasswordResetSend` and then
 * `sendPasswordResetLink`, so they share one per-email limit and one email.
 *
 * The link is a live credential for an hour. Nothing here writes it, or the token in it, to a log
 * line or an audit row.
 */

/** At most this many reset links per user per window, whoever asked (user or admin). */
export const PASSWORD_RESET_SEND_LIMIT = 3;
export const PASSWORD_RESET_WINDOW_MS = 15 * 60 * 1000;

/** The audit actions that record a reset link going out. The per-email limit counts these rows. */
export const PASSWORD_RESET_SEND_ACTIONS = ['user.password_reset_requested', 'user.password_reset_sent_by_admin'] as const;
export type PasswordResetSendAction = (typeof PASSWORD_RESET_SEND_ACTIONS)[number];

/**
 * How long POST /api/auth/password/forgot takes, whichever branch ran. The lookup and the send
 * happen off the response path (see `runPasswordResetWork`), so this fixed wait is all a caller
 * can time.
 */
export const FORGOT_RESPONSE_DELAY_MS = 300;

export interface PasswordResetRecipient {
  id: string;
  email: string;
  first_name: string;
  organization_id: string;
}

/** Who asked, for the audit row. Captured before the response is sent. */
export interface PasswordResetRequestContext {
  actorId: string | null;
  actorEmail: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * Claim one of the user's reset sends for this window, and record it. Returns false when the user
 * already had PASSWORD_RESET_SEND_LIMIT links in the last 15 minutes; then nothing is recorded and
 * nothing may be sent.
 *
 * The count and the insert run under a per-user transaction lock, so concurrent requests (many IPs
 * at once) cannot all read "2" and each send a link. The audit row is the record of the send, so
 * the limit survives restarts and holds across instances without new storage. No token or link is
 * ever put in it.
 */
export async function reservePasswordResetSend(args: {
  user: Pick<PasswordResetRecipient, 'id' | 'organization_id'>;
  action: PasswordResetSendAction;
  context: PasswordResetRequestContext;
  metadata?: Record<string, unknown>;
}): Promise<boolean> {
  const { user, action, context } = args;
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`password-reset:${user.id}`}, 0))`;
    const recent = await tx.auditLog.count({
      where: {
        resource_type: 'User',
        resource_id: user.id,
        action: { in: [...PASSWORD_RESET_SEND_ACTIONS] },
        created_at: { gte: new Date(Date.now() - PASSWORD_RESET_WINDOW_MS) },
      },
    });
    if (recent >= PASSWORD_RESET_SEND_LIMIT) return false;
    await tx.auditLog.create({
      data: {
        org_id: user.organization_id,
        actor_id: context.actorId,
        actor_email: context.actorEmail,
        action,
        resource_type: 'User',
        resource_id: user.id,
        metadata: (args.metadata ?? {}) as Prisma.InputJsonValue,
        ip_address: context.ipAddress,
        user_agent: context.userAgent,
      },
    });
    return true;
  });
}

/** The page the link opens. The token rides in the query string and the page strips it on load. */
export function passwordResetUrl(hashedToken: string): string {
  return `${env.FRONTEND_URL.replace(/\/+$/, '')}/reset-password?token=${encodeURIComponent(hashedToken)}`;
}

/**
 * Mint a single-use recovery token for the user and email them ServWave's own reset link.
 * `generateLink` sends nothing itself; the provider's mailer is never used. Returns whether the
 * email went out. Never throws.
 */
export async function sendPasswordResetLink(user: PasswordResetRecipient): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin.auth.admin.generateLink({ type: 'recovery', email: user.email });
    const hashedToken = data?.properties?.hashed_token;
    if (error || !hashedToken) {
      logger.warn('Password reset link could not be minted', {
        userId: user.id,
        providerStatus: (error as { status?: number } | null)?.status,
        providerCode: (error as { code?: string } | null)?.code,
      });
      return false;
    }
    return await sendPasswordResetEmail({
      to: user.email,
      firstName: user.first_name,
      resetUrl: passwordResetUrl(hashedToken),
      organizationId: user.organization_id,
    });
  } catch (err) {
    logger.error('Password reset link failed', { userId: user.id, name: err instanceof Error ? err.name : typeof err });
    return false;
  }
}

/**
 * The work behind a "Forgot password?" request: find an active user with a login, claim a send
 * under the per-email limit, and send the link. A revoked user has no auth account and has_login
 * false, so the lookup alone excludes them. Never throws.
 */
export async function requestPasswordReset(email: string, context: Omit<PasswordResetRequestContext, 'actorId' | 'actorEmail'>): Promise<void> {
  try {
    const user = await prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' }, is_active: true, has_login: true },
      select: { id: true, email: true, first_name: true, organization_id: true },
    });
    if (!user) return;

    const reserved = await reservePasswordResetSend({
      user,
      action: 'user.password_reset_requested',
      context: { ...context, actorId: user.id, actorEmail: user.email },
    });
    if (!reserved) {
      logger.info('Password reset link withheld: per-email limit reached', { userId: user.id });
      return;
    }
    await sendPasswordResetLink(user);
  } catch (err) {
    logger.error('Password reset request failed', { name: err instanceof Error ? err.name : typeof err });
  }
}

const pending = new Set<Promise<void>>();

/**
 * Run reset work off the response path, so how long it takes (a database read for a known email, a
 * provider round trip and a send) can never show in the response time. Tracked so a test or a
 * graceful shutdown can wait for it with `settlePasswordResetWork`.
 */
export function runPasswordResetWork(work: () => Promise<void>): void {
  const p = work().catch(() => undefined).finally(() => pending.delete(p));
  pending.add(p);
}

/** Wait for every reset email still being prepared or sent. */
export async function settlePasswordResetWork(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending]);
}

// ─── Setting the new password ────────────────────────────────────────────────

/**
 * What a reset attempt came to. The controller turns it into a response; nothing here builds copy.
 *
 * - `invalid_link`: the token is unknown, used or expired, or its user can no longer sign in.
 * - `rejected`: the token was good but the provider refused the new password (`error` goes through
 *   lib/auth-provider-errors.ts). The token is spent by then. For a breached password only,
 *   `retryToken` is a replacement single-use token for the same user (spec §5.2 "A rejected
 *   password must not burn the link"); it is absent when minting one failed.
 * - `done`: the password is set, every session is signed out and the identity cache is cleared.
 */
export type PasswordResetOutcome =
  | { kind: 'invalid_link' }
  | { kind: 'rejected'; error: unknown; user: AppUser; retryToken?: string }
  | { kind: 'done'; user: AppUser; sessionsSignedOut: boolean };

/**
 * Sign out with the session the token check opened. `global` revokes every session the user has
 * (used after a successful reset); `local` revokes only that one session (used when nothing
 * changed, so the user's other devices stay signed in). Never throws.
 *
 * Returns `signed_out` when the provider ended the session(s) now, `already_gone` when it answered
 * that the token's session no longer exists (nothing is retried then: there is nothing left to end),
 * and `failed` otherwise. What `already_gone` proves is the caller's call.
 */
async function signOutWith(
  accessToken: string | undefined,
  scope: 'global' | 'local',
  userId: string,
): Promise<'signed_out' | 'already_gone' | 'failed'> {
  if (!accessToken) return 'failed';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { error } = await supabaseAdmin.auth.admin.signOut(accessToken, scope);
      if (!error) return 'signed_out';
      if (isSessionMissingError(error)) return 'already_gone';
      logger.warn('Password reset: sign-out was refused', { userId, scope, attempt, providerStatus: (error as { status?: number }).status });
    } catch (err) {
      logger.warn('Password reset: sign-out threw', { userId, scope, attempt, name: err instanceof Error ? err.name : typeof err });
    }
  }
  return 'failed';
}

/**
 * Mint a replacement recovery token after a breached password (spec §5.2; conductor brief §3.3).
 * Called only from `completePasswordReset`, in the same request in which the caller presented a
 * valid token for this auth user, so it grants nothing that caller did not already hold.
 * `generateLink` sends no email. The token is returned, never logged. A token minted for any account
 * other than the one the presented token belonged to is discarded. Never throws; undefined on any
 * failure (the page then offers "Send a new link").
 */
async function mintRetryToken(authUser: { id: string; email?: string | null }, user: AppUser): Promise<string | undefined> {
  const email = authUser.email || user.email;
  try {
    const { data, error } = await supabaseAdmin.auth.admin.generateLink({ type: 'recovery', email });
    const hashedToken = data?.properties?.hashed_token;
    if (error || !hashedToken || data?.user?.id !== authUser.id) {
      logger.warn('Password reset: replacement link could not be minted', {
        userId: user.id,
        providerStatus: (error as { status?: number } | null)?.status,
        providerCode: (error as { code?: string } | null)?.code,
        otherAccount: !error && !!hashedToken && data?.user?.id !== authUser.id,
      });
      return undefined;
    }
    return hashedToken;
  } catch (err) {
    logger.warn('Password reset: replacement link threw', { userId: user.id, name: err instanceof Error ? err.name : typeof err });
    return undefined;
  }
}

/**
 * Set a new password from a reset link's token (spec §5.2). The token is checked with `verifyOtp`
 * on a brand-new client made for this call: verifyOtp signs the token's user in on the client that
 * runs it, and neither supabaseAdmin (Storage RLS) nor the shared supabaseAuth may hold a session
 * (lib/supabase.ts). That session is signed out before this returns or throws, whatever the
 * outcome, and never reaches the browser: a reset never signs anyone in, so 2FA still applies at
 * sign-in.
 *
 * verifyOtp spends the token before the provider checks the new password, so a breached password
 * would burn the link. In that case only, a replacement token is minted for the same user and
 * handed back (see `mintRetryToken`).
 *
 * The caller validates the password first: verifyOtp spends the token, so a password the server
 * would refuse anyway must never get this far. Never logs the token or the password.
 */
export async function completePasswordReset(token: string, password: string): Promise<PasswordResetOutcome> {
  let authUser: { id: string; email?: string | null; email_confirmed_at?: string | null } | null = null;
  let accessToken: string | undefined;
  try {
    const { data, error } = await createIsolatedAuthClient().auth.verifyOtp({ type: 'recovery', token_hash: token });
    accessToken = data?.session?.access_token;
    if (!error && data?.user) authUser = data.user;
    else logger.info('Password reset: link refused', { providerCode: (error as { code?: string } | null)?.code });
  } catch (err) {
    logger.warn('Password reset: link check threw', { name: err instanceof Error ? err.name : typeof err });
  }
  if (!authUser) {
    await signOutWith(accessToken, 'local', 'unknown');
    return { kind: 'invalid_link' };
  }

  // From here the token session is open. Whatever happens next, including a throw (review note
  // O-a), the `finally` closes it, unless the global sign-out after a successful reset already ran.
  let logId = authUser.id;
  let globalSignOutRan = false;
  try {
    const user = await resolveAppUser(authUser);
    if (user) logId = user.id;
    if (!user || !user.is_active || !user.has_login) return { kind: 'invalid_link' };

    let updateError: unknown;
    try {
      ({ error: updateError } = await supabaseAdmin.auth.admin.updateUserById(authUser.id, { password }));
    } catch (err) {
      updateError = err;
    }
    if (updateError) {
      const retryToken = isWeakPasswordError(updateError) ? await mintRetryToken(authUser, user) : undefined;
      return { kind: 'rejected', error: updateError, user, retryToken };
    }

    // Every session, on every device, including the one verifyOtp just opened. Then the 60 s
    // identity cache, so a revoked token cannot keep working from it.
    //
    // The provider's admin password update normally gets there first: it ends every session of the
    // user in the same transaction that sets the password (Supabase Auth `adminUserUpdate` ->
    // `UpdatePassword(tx, nil)` -> `Logout(tx, userID)`; #2866 staging check, 2026-10-25). The
    // sign-out then finds the token's session gone. That session was live a moment ago and nothing
    // in this request ended it, so "already gone" right after a successful update is that
    // all-sessions step having run: every session is signed out. Any other refusal is not.
    globalSignOutRan = true;
    const signOut = await signOutWith(accessToken, 'global', user.id);
    const sessionsSignedOut = signOut !== 'failed';
    if (signOut === 'already_gone') {
      logger.info('Password reset: the password update had already signed every session out', { userId: user.id });
    }
    clearTokenCache(user.id);
    return { kind: 'done', user, sessionsSignedOut };
  } finally {
    if (!globalSignOutRan) await signOutWith(accessToken, 'local', logId);
  }
}
