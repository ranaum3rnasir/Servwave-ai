import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { unscopedRequest } from '../middleware/unscopedRequest';
import { authLimiter, mfaResendLimiter } from '../middleware/rate-limit';
import * as authController from '../controllers/auth.controller';

const router = Router();

// The unauthenticated auth-bootstrap routes resolve the user (and thus the org)
// from credentials/token BEFORE any org context exists, so they must run
// `unscopedRequest` — otherwise, once DB_TENANT_GUARD=on, their `users` /
// `organizations` / `mfa_email_challenge` lookups hit the fail-closed
// tenant_isolation RLS policy and return no rows (every login → 401). This mirrors
// how the `authenticate` middleware wraps its own bootstrap lookup in runUnscoped.
router.post('/login', unscopedRequest, authLimiter, authController.login);
router.post('/logout', authenticate, authController.logout);
// refresh is a credential exchange too — throttle it like login.
router.post('/refresh', unscopedRequest, authLimiter, authController.refresh);
router.post('/google/finalize', unscopedRequest, authLimiter, authController.googleFinalize);
router.get('/me', authenticate, authController.me);
// Unauthenticated HMAC verify + user lookup → throttle to blunt invite-token guessing / DB amplification.
// POST (not GET) so the single-use token travels in the body, never the URL/query — keeps it out of
// request logs and proxy access logs.
router.post('/invite', unscopedRequest, authLimiter, authController.getInvite);
router.post('/accept-invite', unscopedRequest, authLimiter, authController.acceptInvite);
router.post('/accept-invite/terms', unscopedRequest, authLimiter, authController.acceptInviteTerms);

// ─── Email-OTP 2FA ───
// Login step 2 + resend are unauthenticated (the user has no session yet) and
// brute-force-sensitive → authLimiter; resend additionally gets the tighter
// email-bomb limiter. Enrollment endpoints require an authenticated session.
router.post('/mfa/verify', unscopedRequest, authLimiter, authController.mfaVerify);
router.post('/mfa/resend', unscopedRequest, authLimiter, mfaResendLimiter, authController.mfaResend);
router.post('/mfa/setup', authenticate, mfaResendLimiter, authController.mfaSetup);
router.post('/mfa/enable', authenticate, authController.mfaEnable);
router.post('/mfa/disable', authenticate, authController.mfaDisable);
router.get('/mfa/status', authenticate, authController.mfaStatus);

export default router;
