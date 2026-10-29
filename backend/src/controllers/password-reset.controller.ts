import { Request, Response } from 'express';
import { z } from 'zod';
import { emailSchema } from '../lib/email-schema';
import { getClientIp, logAudit } from '../lib/audit';
import { logger } from '../lib/logger';
import { PASSWORD_UPDATE_FAILED_MESSAGE, mapPasswordUpdateError } from '../lib/auth-provider-errors';
import { prisma } from '../lib/prisma';
import { tenantWhere } from '../lib/tenant';
import { emit } from '../services/notifications/notificationService';
import {
  FORGOT_RESPONSE_DELAY_MS,
  PASSWORD_RESET_SEND_LIMIT,
  completePasswordReset,
  requestPasswordReset,
  reservePasswordResetSend,
  runPasswordResetWork,
  sendPasswordResetLink,
} from '../lib/password-reset';

/**
 * The signed-out password reset (password reset spec §5.2, slice 04).
 *
 * POST /api/auth/password/forgot never says whether an account exists (conductor brief §3.1): the
 * status, the body and the time it takes are the same for a known, unknown, deactivated or revoked
 * email, and for a user over the per-email limit.
 */

const forgotSchema = z.object({ email: emailSchema });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function forgotPassword(req: Request, res: Response) {
  const parsed = forgotSchema.safeParse(req.body);
  if (!parsed.success) {
    // Says nothing about any account: it is the same for every malformed input.
    res.status(400).json({ error: 'Enter a valid email address.' });
    return;
  }

  const context = {
    ipAddress: getClientIp(req),
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
  };
  // The lookup and the send run off the response path; the answer waits a fixed time instead.
  runPasswordResetWork(() => requestPasswordReset(parsed.data.email, context));
  await sleep(FORGOT_RESPONSE_DELAY_MS);
  res.json({ ok: true });
}

export const INVALID_RESET_LINK_MESSAGE = 'This reset link is invalid or has expired.';

// Same rule as a signed-in change (user.controller changePasswordSchema): 8 to 256 characters.
const resetSchema = z.object({
  token: z.string().min(1).max(2048),
  password: z.string().min(8, 'Password must be at least 8 characters.').max(256, 'Password must be at most 256 characters.'),
});

/**
 * POST /api/auth/password/reset { token, password }. The token only ever travels in this body.
 * Validation runs before the token is checked, because checking it spends it.
 */
export async function resetPassword(req: Request, res: Response) {
  const parsed = resetSchema.safeParse(req.body);
  if (!parsed.success) {
    const tokenIssue = parsed.error.issues.some((i) => i.path[0] === 'token');
    const passwordIssue = parsed.error.issues.find((i) => i.path[0] === 'password');
    if (tokenIssue) {
      res.status(400).json({ error: INVALID_RESET_LINK_MESSAGE, code: 'invalid_reset_link' });
    } else {
      res.status(400).json({
        error: passwordIssue?.code === 'invalid_type' ? 'Enter a new password.' : passwordIssue?.message ?? 'Enter a new password.',
      });
    }
    return;
  }

  try {
    const outcome = await completePasswordReset(parsed.data.token, parsed.data.password);

    if (outcome.kind === 'invalid_link') {
      res.status(400).json({ error: INVALID_RESET_LINK_MESSAGE, code: 'invalid_reset_link' });
      return;
    }
    if (outcome.kind === 'rejected') {
      const mapped = mapPasswordUpdateError(outcome.error, 'reset-password', { userId: outcome.user.id });
      // A breached password must not burn the link (spec §5.2): the page swaps in the replacement
      // token, keeps it in memory only, and the user tries another password. Any other failure
      // gets no token. The answer is a credential, so nothing may cache it.
      const retryToken = mapped.body.code === 'weak_password' ? outcome.retryToken : undefined;
      res.set('Cache-Control', 'no-store');
      res.status(mapped.status).json(retryToken ? { ...mapped.body, token: retryToken } : mapped.body);
      return;
    }

    const { user } = outcome;
    void logAudit({
      req,
      action: 'user.password_reset',
      resourceType: 'User',
      resourceId: user.id,
      orgId: user.organization_id,
      actorId: user.id,
      actorEmail: user.email,
      metadata: { sessions_signed_out: outcome.sessionsSignedOut },
    });
    // Still 200: the password DID change. `sessions_signed_out: false` lets the page say plainly
    // that other devices may still be signed in (a reset is the usual fix after a compromise).
    res.json({ ok: true, sessions_signed_out: outcome.sessionsSignedOut });
    emit({
      verb: 'security.password_changed',
      organizationId: user.organization_id,
      actorId: null,
      object: { type: 'USER', id: user.id },
      entity: { user_id: user.id },
      data: { object_label: user.first_name || user.email },
    }).catch((err) => logger.warn('notification emit failed', { name: err instanceof Error ? err.name : typeof err }));
  } catch (err) {
    logger.error('Password reset failed', { name: err instanceof Error ? err.name : typeof err });
    res.status(500).json({ error: PASSWORD_UPDATE_FAILED_MESSAGE });
  }
}

// ─── "Set a password by email" (signed in; slice 06) ─────────────────────────

// Neutral about who asked: the cap is shared with forgot-password and admin sends (review item 6).
export const PASSWORD_LINK_LIMIT_MESSAGE = `We've already sent ${PASSWORD_RESET_SEND_LIMIT} reset links to this address in the last 15 minutes. Use the newest email, or try again later.`;
// Spec §7 wording.
export const PASSWORD_LINK_NOT_SENT_MESSAGE = "We couldn't send the email. Try again or contact ServWave support.";

/**
 * POST /api/users/me/password/email-link — a signed-in user (typically Google-only, who has no
 * current password to type) asks for the same reset email "Forgot password?" sends (spec §4.1 last
 * bullet). The address is the one on the user's own record, read here; the request body is never
 * read, so this can only ever email the caller.
 *
 * Same per-email limit as forgot-password and admin sends (3 per 15 min, counted in the audit log).
 * The caller is signed in, so there is nothing to hide: the answer says plainly when the limit is
 * reached or the email could not go out. The token is never logged, audited or returned.
 */
export async function sendMyPasswordLink(req: Request, res: Response) {
  try {
    const me = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { id: true, email: true, first_name: true, organization_id: true, is_active: true, has_login: true },
    });
    if (!me || !me.is_active || !me.has_login) {
      res.status(400).json({ error: 'Login is not enabled for your account' });
      return;
    }

    const reserved = await reservePasswordResetSend({
      user: me,
      action: 'user.password_reset_requested',
      context: {
        actorId: me.id,
        actorEmail: me.email,
        ipAddress: getClientIp(req),
        userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
      },
      metadata: { source: 'login_and_security' },
    });
    if (!reserved) {
      res.status(429).json({ error: PASSWORD_LINK_LIMIT_MESSAGE, code: 'reset_link_limit' });
      return;
    }

    const sent = await sendPasswordResetLink(me);
    if (!sent) {
      res.status(502).json({ error: PASSWORD_LINK_NOT_SENT_MESSAGE, code: 'reset_link_not_sent' });
      return;
    }
    res.json({ ok: true, email: me.email });
  } catch (err) {
    logger.error('Set-password link failed', { name: err instanceof Error ? err.name : typeof err });
    res.status(500).json({ error: PASSWORD_LINK_NOT_SENT_MESSAGE, code: 'reset_link_not_sent' });
  }
}

// ─── An admin sends a reset link (Users & Teams; slice 07) ───────────────────

export const ADMIN_RESET_LIMIT_MESSAGE = `This person has been sent ${PASSWORD_RESET_SEND_LIMIT} reset links in the last 15 minutes. Ask them to use the newest email, or try again in a few minutes.`;
export const ADMIN_RESET_NOT_SENT_MESSAGE = "We couldn't send the email. Try again or contact ServWave support.";
export const ADMIN_RESET_NO_LOGIN_MESSAGE = "This person doesn't have a login. Send them an invite instead.";
export const ADMIN_RESET_INACTIVE_MESSAGE = 'This person is deactivated. Reactivate them first.';

/**
 * POST /api/users/:id/password-reset — an admin (update User, checked by the route) emails a person
 * in their own organization the same reset link "Forgot password?" sends (spec §7). The person sets
 * their own password; the admin never sees the link, the token or a password, and nothing in the
 * request body is read.
 *
 * The target is looked up inside the caller's organization, so an id from another organization is
 * simply not found (brief §3.5). The send counts against the same per-email limit as forgot-password
 * and "Set a password by email", and is audited as `user.password_reset_sent_by_admin` with the admin
 * as actor. The caller is a signed-in admin, so the answer says plainly when the limit is reached or
 * the email could not go out.
 */
export async function sendUserPasswordReset(req: Request, res: Response) {
  try {
    const target = await prisma.user.findFirst({
      where: { id: String(req.params.id), ...tenantWhere(req) },
      select: { id: true, email: true, first_name: true, organization_id: true, is_active: true, has_login: true },
    });
    if (!target) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    if (!target.is_active) {
      res.status(400).json({ error: ADMIN_RESET_INACTIVE_MESSAGE, code: 'user_inactive' });
      return;
    }
    if (!target.has_login) {
      res.status(400).json({ error: ADMIN_RESET_NO_LOGIN_MESSAGE, code: 'no_login' });
      return;
    }

    const reserved = await reservePasswordResetSend({
      user: target,
      action: 'user.password_reset_sent_by_admin',
      context: {
        actorId: req.user!.id,
        actorEmail: req.user!.email,
        ipAddress: getClientIp(req),
        userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
      },
      metadata: { source: 'users_and_teams' },
    });
    if (!reserved) {
      res.status(429).json({ error: ADMIN_RESET_LIMIT_MESSAGE, code: 'reset_link_limit' });
      return;
    }

    const sent = await sendPasswordResetLink(target);
    if (!sent) {
      res.status(502).json({ error: ADMIN_RESET_NOT_SENT_MESSAGE, code: 'reset_link_not_sent' });
      return;
    }
    res.json({ ok: true, email: target.email });
  } catch (err) {
    logger.error('Admin password reset send failed', { name: err instanceof Error ? err.name : typeof err });
    res.status(500).json({ error: ADMIN_RESET_NOT_SENT_MESSAGE, code: 'reset_link_not_sent' });
  }
}
