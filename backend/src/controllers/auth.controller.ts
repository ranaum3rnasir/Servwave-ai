import { Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin, supabaseAuth } from '../lib/supabase';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { defineAbilityFor, type PermissionOverride } from '../lib/permissions/defineAbility';
import { getCachedGrants, setCachedGrants } from '../lib/permissions/permissionCache';
import { grantRoleKey, isSuperUser } from '../lib/permissions/effectiveRole';
import { loadUserOverrides } from '../lib/permissions/loadUserOverrides';
import { resolveAppUser } from '../lib/auth-user';
import { emailSchema } from '../lib/email-schema';
import { clearTokenCache } from '../middleware/authenticate';
import { verifyInviteToken } from '../lib/invite-token';
import { generateCode, hashCode, verifyCode, encryptRefreshToken, decryptRefreshToken } from '../lib/mfa-otp';
import { sendMfaCodeEmail } from '../lib/email';
import { emit } from '../services/notifications/notificationService';
import { logAudit } from '../lib/audit';
import { CURRENT_TERMS_VERSION, TERMS_URL, PRIVACY_URL, TERMS_ENFORCEMENT_EFFECTIVE_SINCE } from '../lib/legal';
import { signAvatarPaths, resolveAvatarUrl } from '../lib/avatar';
import { userPhoneField, submittedUserPhone, USER_PHONE_INVALID_MESSAGE } from '../lib/user-phone';

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1),
});

const refreshSchema = z.object({
  refresh_token: z.string().min(1),
});

// ─── Email-OTP 2FA tuning ────────────────────────────────
const MFA_CHALLENGE_TTL_MS = 10 * 60 * 1000; // a challenge (and its parked token) lives ≤10 min
const MFA_MAX_VERIFY_ATTEMPTS = 5; // wrong-code attempts before a challenge is dead
const MFA_CREATE_WINDOW_MS = 15 * 60 * 1000; // sliding window for the per-user creation cap
const MFA_MAX_CREATES_PER_WINDOW = 5; // ≤5 codes minted per user per window (login or resend)

/** The login success body. Used by /login (non-enrolled) and /mfa/verify. */
function sessionPayload(session: { access_token: string; refresh_token: string; expires_at?: number }) {
  return {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at,
  };
}

function userPayload(user: {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  role: string;
  organization_id: string;
  org_is_demo: boolean;
  org_plan: string;
  org_features: string[];
  feature_overrides?: Record<string, unknown> | null;
  has_login: boolean;
  phone?: string | null;
  phone_ext?: string | null;
}) {
  return {
    id: user.id,
    email: user.email,
    first_name: user.first_name,
    last_name: user.last_name,
    role: user.role,
    organization_id: user.organization_id,
    // Demo-org flag drives the frontend's mock-first Reports gating.
    org_is_demo: user.org_is_demo,
    org_plan: user.org_plan,
    org_features: user.org_features,
    feature_overrides: user.feature_overrides,
    // Personnel staff-mgmt (PR #218): carry self-service profile fields so the
    // frontend auth store hydrates a real phone / has_login on every login path
    // (plain + MFA-verify). googleFinalize builds its own payload inline.
    has_login: user.has_login,
    phone: user.phone,
    phone_ext: user.phone_ext,
  };
}

/**
 * Mint an email-OTP challenge for a user, enforcing the per-user lockout +
 * creation cap, and email the code. Returns the new challenge id, or null when
 * the per-user creation cap is hit (caller answers 429). The optional
 * `encRefreshToken` is the AES-GCM-encrypted Supabase refresh token to PARK for
 * a LOGIN challenge — never present for ENROLL.
 *
 * Lockout: any prior UNCONSUMED challenge of the same purpose for the user is
 * deleted first, so at most one live challenge exists per (user, purpose).
 */
async function mintChallenge(opts: {
  userId: string;
  email: string;
  firstName?: string | null;
  purpose: 'LOGIN' | 'ENROLL';
  encRefreshToken?: string | null;
}): Promise<string | null> {
  const since = new Date(Date.now() - MFA_CREATE_WINDOW_MS);

  // Lazy reap: drop this user's challenges older than the cap window. Keeps the
  // table bounded without touching in-window rows (so the cap count is unaffected).
  await prisma.mfaEmailChallenge.deleteMany({
    where: { user_id: opts.userId, created_at: { lt: since } },
  });

  // Per-user creation cap over the sliding window (email-bomb / brute-force guard).
  // Counted BEFORE we supersede the prior challenge — and prior challenges are
  // superseded (consumed), NOT deleted — so repeated /login attempts genuinely
  // accumulate toward the cap and can't reset the per-code attempt budget by
  // rotating to a fresh challenge.
  const recent = await prisma.mfaEmailChallenge.count({
    where: { user_id: opts.userId, created_at: { gte: since } },
  });
  if (recent >= MFA_MAX_CREATES_PER_WINDOW) return null;

  // Single-live invariant: supersede any prior unconsumed challenge of this
  // purpose by consuming it (kept as a creation record for the cap above).
  await prisma.mfaEmailChallenge.updateMany({
    where: { user_id: opts.userId, purpose: opts.purpose, consumed_at: null },
    data: { consumed_at: new Date() },
  });

  const code = generateCode();
  const challenge = await prisma.mfaEmailChallenge.create({
    data: {
      user_id: opts.userId,
      code_hmac: hashCode(code),
      enc_refresh_token: opts.encRefreshToken ?? null,
      purpose: opts.purpose,
      expires_at: new Date(Date.now() + MFA_CHALLENGE_TTL_MS),
    },
  });
  await sendMfaCodeEmail({ to: opts.email, code, firstName: opts.firstName });
  return challenge.id;
}

/**
 * Generic-401 gate for a challenge being verified. Returns true when the
 * challenge is unusable (missing / wrong purpose / wrong user / consumed /
 * expired / attempts exhausted) — the caller must answer a generic 401 in every
 * case so nothing distinguishes them (no account / code enumeration).
 */
function challengeUnusable(
  challenge:
    | {
        user_id: string;
        purpose: string;
        attempts: number;
        expires_at: Date;
        consumed_at: Date | null;
      }
    | null,
  expect: { purpose: 'LOGIN' | 'ENROLL'; userId?: string },
): boolean {
  if (!challenge) return true;
  if (challenge.purpose !== expect.purpose) return true;
  if (expect.userId && challenge.user_id !== expect.userId) return true;
  if (challenge.consumed_at) return true;
  if (challenge.expires_at.getTime() <= Date.now()) return true;
  if (challenge.attempts >= MFA_MAX_VERIFY_ATTEMPTS) return true;
  return false;
}

const mfaVerifySchema = z.object({
  challengeId: z.string().min(1),
  code: z.string().min(1),
});
const mfaResendSchema = z.object({ challengeId: z.string().min(1) });
const mfaEnableSchema = z.object({ challengeId: z.string().min(1), code: z.string().min(1) });

export async function login(req: Request, res: Response) {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Email and password are required' });
    return;
  }

  const { email, password } = parsed.data;

  try {
    const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password });
    if (error || !data.user || !data.session) {
      // Resolve the org/actor from the attempted email so a known user's failed
      // attempt is attributed (org_id is NOT NULL — unknown emails are skipped).
      // Best-effort: never let this lookup turn a 401 into a 500.
      let known: { id: string; email: string; organization_id: string } | null = null;
      try {
        known = await prisma.user.findFirst({
          where: { email: { equals: email, mode: 'insensitive' } },
          select: { id: true, email: true, organization_id: true },
        });
      } catch {
        known = null;
      }
      void logAudit({
        req,
        action: 'login.failed',
        resourceType: 'User',
        resourceId: known?.id ?? null,
        orgId: known?.organization_id,
        actorId: known?.id ?? null,
        actorEmail: known?.email ?? email,
        metadata: { email, reason: 'invalid_credentials' },
      });
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const user = await resolveAppUser(data.user);

    if (!user) {
      void logAudit({
        req,
        action: 'login.failed',
        actorId: null,
        actorEmail: data.user.email ?? email,
        metadata: { email, reason: 'no_app_user' },
      });
      res.status(401).json({ error: 'User account not found' });
      return;
    }

    if (!user.is_active) {
      void logAudit({
        req,
        action: 'login.failed',
        resourceType: 'User',
        resourceId: user.id,
        orgId: user.organization_id,
        actorId: user.id,
        actorEmail: user.email,
        metadata: { reason: 'deactivated' },
      });
      res.status(403).json({ error: 'Account is deactivated' });
      return;
    }

    // Email-OTP 2FA gate. resolveAppUser's select omits the flag, so read it
    // (plus first_name for the email greeting) before deciding the branch.
    const mfaRow = await prisma.user.findUnique({
      where: { id: user.id },
      select: { mfa_email_enrolled: true, first_name: true },
    });

    if (mfaRow?.mfa_email_enrolled) {
      // CRITICAL INVARIANT: do NOT return or log the session here. The Supabase
      // refresh token is PARKED (encrypted) on the challenge and only exchanged
      // after the code is verified at /mfa/verify.
      const challengeId = await mintChallenge({
        userId: user.id,
        email: user.email,
        firstName: mfaRow.first_name ?? user.first_name,
        purpose: 'LOGIN',
        encRefreshToken: encryptRefreshToken(data.session.refresh_token),
      });
      if (!challengeId) {
        res.status(429).json({ error: 'Too many verification attempts. Please wait a few minutes and try again.' });
        return;
      }
      void logAudit({
        req,
        action: 'login.mfa_challenged',
        resourceType: 'User',
        resourceId: user.id,
        orgId: user.organization_id,
        actorId: user.id,
        actorEmail: user.email,
        metadata: { challengeId },
      });
      res.json({ mfaRequired: true, challengeId });
      return;
    }

    res.json({
      user: userPayload(user),
      session: sessionPayload(data.session),
    });
    void logAudit({
      req,
      action: 'login.succeeded',
      resourceType: 'User',
      resourceId: user.id,
      orgId: user.organization_id,
      actorId: user.id,
      actorEmail: user.email,
    });
    emit({
      verb: 'security.new_signin',
      organizationId: user.organization_id,
      actorId: null,
      object: { type: 'USER', id: user.id },
      entity: { user_id: user.id },
      data: { object_label: user.first_name || user.email },
    }).catch((err) => logger.warn('notification emit failed', err));
  } catch (err) {
    logger.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
}

/**
 * Step 2 of email-OTP login: verify the code and, only on success, exchange the
 * parked refresh token for a fresh session. Every failure returns an identical
 * generic 401 (no account/code enumeration). The parked token is single-use:
 * the challenge is consumed then deleted.
 */
export async function mfaVerify(req: Request, res: Response) {
  const parsed = mfaVerifySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'A challenge id and code are required' });
    return;
  }
  const { challengeId, code } = parsed.data;

  try {
    const challenge = await prisma.mfaEmailChallenge.findUnique({ where: { id: challengeId } });
    if (challengeUnusable(challenge, { purpose: 'LOGIN' })) {
      res.status(401).json({ error: 'Invalid or expired code' });
      return;
    }

    if (!verifyCode(code, challenge!.code_hmac)) {
      // Wrong code: burn one attempt, then the same generic 401.
      await prisma.mfaEmailChallenge.update({
        where: { id: challengeId },
        data: { attempts: { increment: 1 } },
      });
      res.status(401).json({ error: 'Invalid or expired code' });
      return;
    }

    // Correct. Atomically consume (compare-and-set consumed_at null→now) so only
    // ONE concurrent request can spend the parked token; a duplicate loses the
    // race (0 rows updated) and gets the same generic 401.
    const consumed = await prisma.mfaEmailChallenge.updateMany({
      where: { id: challengeId, consumed_at: null },
      data: { consumed_at: new Date() },
    });
    if (consumed.count !== 1) {
      res.status(401).json({ error: 'Invalid or expired code' });
      return;
    }

    if (!challenge!.enc_refresh_token) {
      res.status(401).json({ error: 'Invalid or expired code' });
      return;
    }
    const refreshToken = decryptRefreshToken(challenge!.enc_refresh_token);
    const { data, error } = await supabaseAuth.auth.refreshSession({ refresh_token: refreshToken });
    if (error || !data.session) {
      res.status(401).json({ error: 'Invalid or expired code' });
      return;
    }

    const user = await resolveAppUser({
      id: challenge!.user_id,
      email: undefined,
      email_confirmed_at: undefined,
    });
    if (!user || !user.is_active) {
      res.status(401).json({ error: 'Invalid or expired code' });
      return;
    }

    // Burn the row so the parked token can never be replayed.
    await prisma.mfaEmailChallenge.delete({ where: { id: challengeId } });

    res.json({
      user: userPayload(user),
      session: sessionPayload(data.session),
    });
    void logAudit({
      req,
      action: 'mfa.verified',
      resourceType: 'User',
      resourceId: user.id,
      orgId: user.organization_id,
      actorId: user.id,
      actorEmail: user.email,
    });
    emit({
      verb: 'security.new_signin',
      organizationId: user.organization_id,
      actorId: null,
      object: { type: 'USER', id: user.id },
      entity: { user_id: user.id },
      data: { object_label: user.first_name || user.email },
    }).catch((err) => logger.warn('notification emit failed', err));
  } catch (err) {
    logger.error('MFA verify error:', err);
    res.status(500).json({ error: 'Verification failed' });
  }
}

/**
 * Re-mint the code on an existing live LOGIN challenge and re-email it, subject
 * to the same per-user creation cap. The parked token, expiry, and attempts are
 * preserved — only the code (and its hash) rotate. 429 when capped, generic 401
 * when the challenge is unusable.
 */
export async function mfaResend(req: Request, res: Response) {
  const parsed = mfaResendSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'A challenge id is required' });
    return;
  }

  try {
    const challenge = await prisma.mfaEmailChallenge.findUnique({ where: { id: parsed.data.challengeId } });
    if (challengeUnusable(challenge, { purpose: 'LOGIN' })) {
      res.status(401).json({ error: 'Invalid or expired code' });
      return;
    }

    const since = new Date(Date.now() - MFA_CREATE_WINDOW_MS);
    const recent = await prisma.mfaEmailChallenge.count({
      where: { user_id: challenge!.user_id, created_at: { gte: since } },
    });
    if (recent >= MFA_MAX_CREATES_PER_WINDOW) {
      res.status(429).json({ error: 'Too many code requests. Please wait a few minutes and try again.' });
      return;
    }

    const target = await prisma.user.findUnique({
      where: { id: challenge!.user_id },
      select: { email: true, first_name: true, organization_id: true },
    });
    if (!target) {
      res.status(401).json({ error: 'Invalid or expired code' });
      return;
    }

    const code = generateCode();
    await prisma.mfaEmailChallenge.update({
      where: { id: parsed.data.challengeId },
      data: { code_hmac: hashCode(code) },
    });
    await sendMfaCodeEmail({ to: target.email, code, firstName: target.first_name });
    void logAudit({
      req,
      action: 'mfa.code_resent',
      resourceType: 'User',
      resourceId: challenge!.user_id,
      orgId: target.organization_id,
      actorId: challenge!.user_id,
      actorEmail: target.email,
      metadata: { challengeId: parsed.data.challengeId },
    });
    res.json({ ok: true });
  } catch (err) {
    logger.error('MFA resend error:', err);
    res.status(500).json({ error: 'Could not resend code' });
  }
}

/**
 * Authenticated: start email-OTP enrollment. Mints an ENROLL challenge (no
 * parked token) for the signed-in user and emails the code.
 */
export async function mfaSetup(req: Request, res: Response) {
  const me = req.user!;
  try {
    const challengeId = await mintChallenge({
      userId: me.id,
      email: me.email,
      firstName: me.first_name,
      purpose: 'ENROLL',
    });
    if (!challengeId) {
      res.status(429).json({ error: 'Too many code requests. Please wait a few minutes and try again.' });
      return;
    }
    void logAudit({
      req,
      action: 'mfa.enroll_started',
      resourceType: 'User',
      resourceId: me.id,
      metadata: { challengeId },
    });
    res.json({ challengeId });
  } catch (err) {
    logger.error('MFA setup error:', err);
    res.status(500).json({ error: 'Could not start enrollment' });
  }
}

/**
 * Authenticated: finish enrollment by verifying the ENROLL code, then flip
 * mfa_email_enrolled = true. The challenge must belong to the caller. Generic
 * 401 on any verification failure.
 */
export async function mfaEnable(req: Request, res: Response) {
  const me = req.user!;
  const parsed = mfaEnableSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'A challenge id and code are required' });
    return;
  }
  const { challengeId, code } = parsed.data;

  try {
    const challenge = await prisma.mfaEmailChallenge.findUnique({ where: { id: challengeId } });
    if (challengeUnusable(challenge, { purpose: 'ENROLL', userId: me.id })) {
      res.status(401).json({ error: 'Invalid or expired code' });
      return;
    }

    if (!verifyCode(code, challenge!.code_hmac)) {
      await prisma.mfaEmailChallenge.update({
        where: { id: challengeId },
        data: { attempts: { increment: 1 } },
      });
      let u: { organization_id: string; email: string } | null = null;
      try {
        u = await prisma.user.findUnique({
          where: { id: challenge!.user_id },
          select: { organization_id: true, email: true },
        });
      } catch {
        u = null;
      }
      void logAudit({
        req,
        action: 'mfa.failed',
        resourceType: 'User',
        resourceId: challenge!.user_id,
        orgId: u?.organization_id,
        actorId: challenge!.user_id,
        actorEmail: u?.email,
        metadata: { challengeId, reason: 'wrong_code' },
      });
      res.status(401).json({ error: 'Invalid or expired code' });
      return;
    }

    // Atomically consume so a duplicate request can't double-process the enroll.
    const consumed = await prisma.mfaEmailChallenge.updateMany({
      where: { id: challengeId, consumed_at: null },
      data: { consumed_at: new Date() },
    });
    if (consumed.count !== 1) {
      res.status(401).json({ error: 'Invalid or expired code' });
      return;
    }
    await prisma.user.update({ where: { id: me.id }, data: { mfa_email_enrolled: true } });
    await prisma.mfaEmailChallenge.delete({ where: { id: challengeId } });

    res.json({ enrolled: true });
    void logAudit({ req, action: 'mfa.enabled', resourceType: 'User', resourceId: me.id });
    emit({
      verb: 'security.mfa_enabled',
      organizationId: me.organization_id,
      actorId: null,
      object: { type: 'USER', id: me.id },
      entity: { user_id: me.id },
      data: { object_label: me.first_name || me.email },
    }).catch((err) => logger.warn('notification emit failed', err));
  } catch (err) {
    logger.error('MFA enable error:', err);
    res.status(500).json({ error: 'Could not enable two-factor authentication' });
  }
}

/** Authenticated: turn email-OTP off and purge any of the user's challenges. */
export async function mfaDisable(req: Request, res: Response) {
  const me = req.user!;
  try {
    await prisma.user.update({ where: { id: me.id }, data: { mfa_email_enrolled: false } });
    await prisma.mfaEmailChallenge.deleteMany({ where: { user_id: me.id } });

    res.json({ enrolled: false });
    void logAudit({ req, action: 'mfa.disabled', resourceType: 'User', resourceId: me.id });
    emit({
      verb: 'security.mfa_disabled',
      organizationId: me.organization_id,
      actorId: null,
      object: { type: 'USER', id: me.id },
      entity: { user_id: me.id },
      data: { object_label: me.first_name || me.email },
    }).catch((err) => logger.warn('notification emit failed', err));
  } catch (err) {
    logger.error('MFA disable error:', err);
    res.status(500).json({ error: 'Could not disable two-factor authentication' });
  }
}

/** Authenticated: report whether the current user has email-OTP enabled. */
export async function mfaStatus(req: Request, res: Response) {
  const me = req.user!;
  try {
    const row = await prisma.user.findUnique({
      where: { id: me.id },
      select: { mfa_email_enrolled: true },
    });
    res.json({ enrolled: row?.mfa_email_enrolled ?? false });
  } catch (err) {
    logger.error('MFA status error:', err);
    res.status(500).json({ error: 'Could not load two-factor status' });
  }
}

export async function logout(req: Request, res: Response) {
  // `authenticate` ran first, so we have both the app user id and the raw bearer
  // JWT. Revoke EVERY Supabase refresh token for this user (global scope) so a
  // stolen/parked refresh token can't mint new sessions, and drop the in-process
  // auth-cache entry so the ≤60s cached identity is killed immediately. Logout is
  // best-effort: a GoTrue hiccup must never leave the client unable to "log out",
  // so we always return 200 and let the client clear its local state.
  const userId = req.user?.id;
  const authHeader = req.headers.authorization;
  const jwt = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : undefined;

  if (jwt) {
    try {
      const { error } = await supabaseAdmin.auth.admin.signOut(jwt, 'global');
      if (error) logger.warn('Logout global signOut failed (continuing):', error.message);
    } catch (err) {
      logger.warn('Logout global signOut threw (continuing):', err);
    }
  }
  if (userId) clearTokenCache(userId);

  if (req.user) {
    void logAudit({ req, action: 'logout', resourceType: 'User', resourceId: req.user.id });
  }
  res.json({ message: 'Logged out successfully' });
}

export async function refresh(req: Request, res: Response) {
  const parsed = refreshSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Refresh token is required' });
    return;
  }

  try {
    const { data, error } = await supabaseAuth.auth.refreshSession({
      refresh_token: parsed.data.refresh_token,
    });

    if (error || !data.session) {
      res.status(401).json({ error: 'Invalid refresh token' });
      return;
    }

    res.json({
      session: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at,
      },
    });
  } catch (err) {
    logger.error('Token refresh error:', err);
    res.status(500).json({ error: 'Token refresh failed' });
  }
}

/**
 * Load the CASL ability rules for a user (admin → manage all; others → DB grants
 * with a per-org cache). Shared by `me` and `googleFinalize`.
 */
async function loadAbilityRules(user: {
  id: string;
  role: string;
  organization_id: string;
  // SRVW-138: present for a custom-role user; selected together, always.
  custom_role_id?: string | null;
  custom_role?: { key: string } | null;
}) {
  let grants: Array<{ action: string; subject: string; conditions?: Record<string, unknown> | null }> = [];
  let overrides: PermissionOverride[] = [];
  // Only an unrestricted ADMIN skips grant loading. An ADMIN-DERIVED custom role must ship
  // its real rules to the frontend, or the UI would render full access while the API
  // enforced the subtracted set.
  if (!isSuperUser(user)) {
    const roleKey = grantRoleKey(user);
    const cached = getCachedGrants(user.organization_id, roleKey);
    if (cached) {
      grants = cached;
    } else {
      const rows = await prisma.rolePermission.findMany({
        where: { organization_id: user.organization_id, role: roleKey },
        select: { action: true, subject: true, conditions: true },
      });
      grants = rows.map((r) => ({
        action: r.action,
        subject: r.subject,
        conditions: r.conditions as Record<string, unknown> | null,
      }));
      setCachedGrants(user.organization_id, roleKey, grants);
    }
    // Per-user overrides flow to the frontend rules too, so the affected user's UI
    // (e.g. the "New Invoice" menu item) reflects the toggle. ADMIN is unaffected.
    overrides = await loadUserOverrides(user.id);
  }

  const ability = defineAbilityFor(user, grants, overrides);
  return ability.rules;
}

// req.user (cached auth) never carries avatar_path — a light side lookup, not folded into that
// hot-path cache, which every authenticated request pays regardless of route.
async function resolveMyAvatarUrl(userId: string): Promise<string | null> {
  const row = await prisma.user.findUnique({ where: { id: userId }, select: { avatar_path: true } });
  const signed = await signAvatarPaths([row?.avatar_path]);
  return resolveAvatarUrl(row?.avatar_path, signed);
}

export async function me(req: Request, res: Response) {
  const user = req.user!;
  // No data dependency between the two - resolve concurrently rather than paying both round
  // trips in sequence on a path every authenticated request/refresh hits.
  const [abilityRules, avatar_url] = await Promise.all([loadAbilityRules(user), resolveMyAvatarUrl(user.id)]);
  res.json({ user: { ...user, avatar_url }, abilityRules });
}

/**
 * Completes a Google OAuth sign-in. The Supabase JS client has already set the
 * session client-side; this endpoint verifies the token, gatekeeps against the
 * Prisma users table (only admin-provisioned accounts may sign in), and returns
 * the same profile shape as /me. Unknown Google accounts are rejected and the
 * orphan Supabase user that OAuth created on first sign-in is deleted.
 *
 * Deliberately does NOT use the `authenticate` middleware so it can return
 * specific error codes and perform orphan cleanup.
 */
const acceptInviteSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
  accepted_terms: z.literal(true),
  // Optional, and the SAME rule every other door that writes User.phone applies
  // (lib/user-phone.ts). The `.transform()` inside it is what turns the masked
  // display form the page shows into the one spelling the column holds.
  phone: userPhoneField,
});

/**
 * The single error string the invite page shows for a rejected submission.
 *
 * A phone rejected by `userPhoneField` deserves to say so - letting an unusable
 * number fall into "a token and a password are required" would send the hire
 * back to the field they got right. But answering with ONLY the phone message
 * is the same mistake pointed the other way: the phone box is optional and the
 * password (or the consent, on the Google path) is what actually blocks the
 * acceptance, so a hire who got both wrong fixed their number, resubmitted, and
 * only THEN heard about the password they had to fix anyway.
 *
 * So both problems are named, and the blocking one is named first. Reporting a
 * single problem at a time is not the right shape here: `AuthAlert` renders one
 * plain string in one wrapping block (auth-public/components/authPanel.tsx), so
 * two sentences cost the page nothing and save a whole round trip. The client
 * already validates in this order (AcceptInvitePage checks the password, then
 * the phone), so the API now agrees with the form rather than contradicting it.
 *
 * `fallback` covers every non-phone issue - token, password, consent - exactly
 * as it did before this function existed, and a phone-only rejection still
 * answers with the bare shared message, unchanged.
 */
function inviteParseError(
  issues: { path: PropertyKey[] }[],
  fallback: string,
): string {
  const phoneRejected = issues.some((i) => i.path[0] === 'phone');
  if (!phoneRejected) return fallback;
  const blockingRejected = issues.some((i) => i.path[0] !== 'phone');
  if (!blockingRejected) return USER_PHONE_INVALID_MESSAGE;
  // Run together as prose, so the shared message needs the terminator it does
  // not carry on its own (it is a standalone field hint everywhere else).
  const phone = /[.!?]$/.test(USER_PHONE_INVALID_MESSAGE)
    ? USER_PHONE_INVALID_MESSAGE
    : `${USER_PHONE_INVALID_MESSAGE}.`;
  return `${fallback} ${phone}`;
}

/**
 * Write the phone the invitee just supplied, and ONLY then.
 *
 * Blank must leave the column alone rather than null it: `inviteUser` persists
 * the number the admin typed on the invite card, so a naive "blank means null"
 * write would destroy the very data this capture exists to collect. The write
 * is deliberately one column keyed on the id the signed token resolved to -
 * this route is public, unscoped and rate-limited, and nothing else about the
 * user is the invitee's to change here.
 */
async function persistInvitePhone(userId: string, submitted: string | null | undefined): Promise<void> {
  const phone = submittedUserPhone(submitted);
  if (!phone) return;
  await prisma.user.update({ where: { id: userId }, data: { phone } });
}

/** Public: validate an invite token and return who it's for (to greet on the page). */
export async function getInvite(req: Request, res: Response) {
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  const payload = verifyInviteToken(token);
  if (!payload) {
    res.status(400).json({ error: 'This invitation link is invalid or has expired.' });
    return;
  }
  const user = await prisma.user.findUnique({
    where: { id: payload.uid },
    select: { email: true, first_name: true, is_active: true, phone: true, phone_ext: true },
  });
  if (!user || !user.is_active) {
    res.status(400).json({ error: 'This invitation is no longer valid.' });
    return;
  }
  // phone/phone_ext are here so the accept page can PREFILL what the admin
  // already typed on the invite card (inviteUser persists both). Without the
  // prefill, a hire who never touches the box submits a blank over a stored
  // number - which is why the write on acceptance is conditional as well.
  res.json({
    email: user.email,
    first_name: user.first_name,
    phone: user.phone ?? null,
    phone_ext: user.phone_ext ?? null,
  });
}

/**
 * Public: accept an invite by setting a password. Creates the Supabase Auth
 * account lazily (email pre-confirmed). If an account already exists for the
 * email (e.g. the invitee already signed in with Google), returns 409 telling
 * them to just sign in. The Prisma row already exists from the invite; password
 * login resolves it via the confirmed-email fallback in resolveAppUser.
 */
export async function acceptInvite(req: Request, res: Response) {
  const parsed = acceptInviteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: inviteParseError(
        parsed.error.issues,
        'A token and a password of at least 8 characters are required.',
      ),
    });
    return;
  }
  const payload = verifyInviteToken(parsed.data.token);
  if (!payload) {
    res.status(400).json({ error: 'This invitation link is invalid or has expired.' });
    return;
  }

  let emitPayload: Parameters<typeof emit>[0] | null = null;

  try {
    const appUser = await prisma.user.findUnique({
      where: { id: payload.uid },
      select: { id: true, email: true, is_active: true, first_name: true, last_name: true, organization_id: true },
    });
    if (!appUser || !appUser.is_active || appUser.email !== payload.email) {
      res.status(400).json({ error: 'This invitation is no longer valid.' });
      return;
    }

    // #607 defense-in-depth — refuse acceptance if this email is ever tied to a
    // DIFFERENT account. A no-op today (User.email is globally @unique), it becomes
    // a real guard if uniqueness is ever relaxed to per-org. Route runs under
    // unscopedRequest (auth.routes.ts), so this findFirst sees all orgs.
    const emailConflict = await prisma.user.findFirst({
      where: { email: appUser.email, id: { not: appUser.id } },
      select: { id: true },
    });
    if (emailConflict) {
      res.status(409).json({ error: 'This email is already associated with an existing account.' });
      return;
    }

    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email: payload.email,
      password: parsed.data.password,
      email_confirm: true,
    });

    if (error || !data.user) {
      const code = (error as { code?: string } | null)?.code;
      const message = error?.message ?? '';
      if (code === 'email_exists' || /already.*(registered|exists)/i.test(message)) {
        res.status(409).json({ error: 'This account is already set up. Please sign in — you can also use "Sign in with Google".' });
        return;
      }
      logger.error('Accept invite createUser error:', error);
      res.status(400).json({ error: 'Could not set your password. Please try again.' });
      return;
    }

    // Only once the login exists. A 409 above (the account was already set up)
    // must leave the row exactly as it was rather than half-apply the form.
    await persistInvitePhone(appUser.id, parsed.data.phone);

    emitPayload = {
      verb: 'team.invite_accepted',
      organizationId: appUser.organization_id,
      actorId: appUser.id,
      object: { type: 'USER', id: appUser.id },
      entity: {},
      data: { object_label: `${appUser.first_name ?? ''} ${appUser.last_name ?? ''}`.trim() || appUser.email },
      dedupKey: `team.invite_accepted:${appUser.id}`,
    };

    const existingTerms = await prisma.termsAcceptance.findFirst({
      where: { user_id: appUser.id },
      select: { id: true },
    });
    if (!existingTerms) {
      await prisma.termsAcceptance.create({
        data: {
          user_id: appUser.id,
          user_email: appUser.email,
          organization_id: appUser.organization_id,
          terms_version: CURRENT_TERMS_VERSION,
          terms_url: TERMS_URL,
          privacy_url: PRIVACY_URL,
          context: 'invite_acceptance',
          ip_address: req.ip ?? null,
          user_agent: req.headers['user-agent'] ?? null,
        },
      });
    }

    void logAudit({
      req,
      action: 'invite.accepted',
      resourceType: 'User',
      resourceId: appUser.id,
      orgId: appUser.organization_id,
      actorId: appUser.id,
      actorEmail: appUser.email,
    });
    res.json({ success: true });
  } catch (err) {
    logger.error('Accept invite error:', err);
    res.status(500).json({ error: 'Could not complete your invitation.' });
  }

  // Fire-and-forget: emit AFTER responding so it never blocks or leaks into the try/catch.
  if (emitPayload) emit(emitPayload);
}

const acceptInviteTermsSchema = z.object({
  token: z.string().min(1),
  accepted_terms: z.literal(true),
  // The invite page has TWO submit paths and this is the second one. The phone
  // box sits above the consent row and is submitted by whichever button the
  // hire presses, so the Google path carries it exactly as the password path
  // does - otherwise every Google invitee is silently skipped.
  phone: userPhoneField,
});

/**
 * Public: record ToS/Privacy acceptance for an invited user WITHOUT setting a
 * password. Used by the invite page's "Continue with Google" path, which must
 * capture consent BEFORE the OAuth handoff (Google doesn't carry consent across
 * the redirect). Idempotent — a second call, or a later password accept, never
 * writes a duplicate row. Same trust model as accept-invite: the HMAC invite
 * token is the sole credential (unscopedRequest + authLimiter on the route).
 */
export async function acceptInviteTerms(req: Request, res: Response) {
  const parsed = acceptInviteTermsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: inviteParseError(
        parsed.error.issues,
        'You must accept the Terms of Service and Privacy Policy to continue.',
      ),
    });
    return;
  }
  const payload = verifyInviteToken(parsed.data.token);
  if (!payload) {
    res.status(400).json({ error: 'This invitation link is invalid or has expired.' });
    return;
  }
  try {
    const appUser = await prisma.user.findUnique({
      where: { id: payload.uid },
      select: { id: true, email: true, is_active: true, organization_id: true },
    });
    if (!appUser || !appUser.is_active || appUser.email !== payload.email) {
      res.status(400).json({ error: 'This invitation is no longer valid.' });
      return;
    }

    await persistInvitePhone(appUser.id, parsed.data.phone);

    const existing = await prisma.termsAcceptance.findFirst({
      where: { user_id: appUser.id },
      select: { id: true },
    });
    if (!existing) {
      await prisma.termsAcceptance.create({
        data: {
          user_id: appUser.id,
          user_email: appUser.email,
          organization_id: appUser.organization_id,
          terms_version: CURRENT_TERMS_VERSION,
          terms_url: TERMS_URL,
          privacy_url: PRIVACY_URL,
          context: 'invite_acceptance_google',
          ip_address: req.ip ?? null,
          user_agent: req.headers['user-agent'] ?? null,
        },
      });
    }
    res.json({ success: true });
  } catch (err) {
    logger.error('Accept invite terms error:', err);
    res.status(500).json({ error: 'Could not record your acceptance. Please try again.' });
  }
}

export async function googleFinalize(req: Request, res: Response) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid authorization header' });
    return;
  }
  const token = authHeader.substring(7);

  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data.user) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    const appUser = await resolveAppUser(data.user);

    if (!appUser) {
      // Unknown Google account — Supabase created a user on first OAuth sign-in.
      // Delete that orphan so unauthorized identities do not accumulate.
      await supabaseAdmin.auth.admin.deleteUser(data.user.id);
      void logAudit({
        req,
        action: 'oauth.google_rejected',
        actorId: null,
        actorEmail: data.user.email ?? null,
        metadata: { reason: 'unknown_account' },
      });
      res.status(403).json({
        code: 'NOT_AUTHORIZED',
        error: 'This Google account is not authorized. Contact your administrator.',
      });
      return;
    }

    if (!appUser.is_active) {
      void logAudit({
        req,
        action: 'oauth.google_rejected',
        resourceType: 'User',
        resourceId: appUser.id,
        orgId: appUser.organization_id,
        actorId: appUser.id,
        actorEmail: appUser.email,
        metadata: { reason: 'deactivated' },
      });
      res.status(403).json({ code: 'ACCOUNT_DISABLED', error: 'Account is deactivated' });
      return;
    }

    // Email-OTP 2FA gate. The Google path receives an already-live Supabase session
    // (the JS client set it before this call), so there is no refresh token to PARK as
    // the password path does. Rather than bless that session, refuse enrolled users
    // here and send them through the password + OTP flow, which is the only path that
    // actually enforces the second factor (F-07).
    const mfaRow = await prisma.user.findUnique({
      where: { id: appUser.id },
      select: { mfa_email_enrolled: true, created_at: true },
    });

    // ToS/Privacy gate (SERV10X-17 Task 5). Accounts created on/after the cutover
    // must have accepted terms — via the password path's checkbox, or a prior
    // session's acceptance — before a Google finalize can complete their
    // onboarding. Accounts predating the cutover are grandfathered.
    if (mfaRow && mfaRow.created_at >= TERMS_ENFORCEMENT_EFFECTIVE_SINCE) {
      const accepted = await prisma.termsAcceptance.findFirst({
        where: { user_id: appUser.id },
        select: { id: true },
      });
      if (!accepted) {
        void logAudit({
          req,
          action: 'oauth.google_rejected',
          resourceType: 'User',
          resourceId: appUser.id,
          orgId: appUser.organization_id,
          actorId: appUser.id,
          actorEmail: appUser.email,
          metadata: { reason: 'terms_not_accepted' },
        });
        res.status(403).json({
          code: 'TERMS_ACCEPTANCE_REQUIRED',
          error:
            'Please finish setting up your account — including accepting our Terms of Service and Privacy Policy — using the link in your invite email, then you can sign in with Google.',
        });
        return;
      }
    }

    if (mfaRow?.mfa_email_enrolled) {
      void logAudit({
        req,
        action: 'oauth.google_rejected',
        resourceType: 'User',
        resourceId: appUser.id,
        orgId: appUser.organization_id,
        actorId: appUser.id,
        actorEmail: appUser.email,
        metadata: { reason: 'mfa_required' },
      });
      res.status(403).json({
        code: 'MFA_REQUIRED',
        error:
          'Two-factor authentication is enabled for this account. Please sign in with your email and password to receive a verification code.',
      });
      return;
    }

    const user = {
      id: appUser.id,
      email: appUser.email,
      first_name: appUser.first_name,
      last_name: appUser.last_name,
      role: appUser.role,
      has_login: appUser.has_login,
      organization_id: appUser.organization_id,
      org_is_demo: appUser.org_is_demo,
      org_plan: appUser.org_plan,
      org_features: appUser.org_features,
      feature_overrides: appUser.feature_overrides,
      department_id: appUser.department_id,
      location_id: appUser.location_id,
      phone: appUser.phone,
      phone_ext: appUser.phone_ext,
    };

    const abilityRules = await loadAbilityRules(user);

    // Only emit on the FIRST finalization (genuine invite acceptance). Returning
    // users (has_login already true) do not re-emit — the dedupKey alone would
    // suppress duplicates, but the guard is the authoritative first-time signal.
    if (!appUser.has_login) {
      emit({
        verb: 'team.invite_accepted',
        organizationId: appUser.organization_id,
        actorId: appUser.id,
        object: { type: 'USER', id: appUser.id },
        entity: {},
        data: { object_label: `${appUser.first_name ?? ''} ${appUser.last_name ?? ''}`.trim() || appUser.email },
        dedupKey: `team.invite_accepted:${appUser.id}`,
      });
    }

    void logAudit({
      req,
      action: 'oauth.google_finalized',
      resourceType: 'User',
      resourceId: appUser.id,
      orgId: appUser.organization_id,
      actorId: appUser.id,
      actorEmail: appUser.email,
      metadata: { first_time: !appUser.has_login },
    });
    res.json({ user, abilityRules });
  } catch (err) {
    logger.error('Google finalize error:', err);
    res.status(500).json({ error: 'Sign-in failed' });
  }
}
