/* =============================================================================
   Security finding H2 (ticket 22): every way in, in one place. Not a test file.

   `SIGN_IN_DOORS` is every route that opens, continues or completes a sign-in for someone without a session. The real-database
   suite (permission-revoke-locks-out-db.test.ts) runs each one against a revoked and a deactivated person, and fails if a door
   listed here has no row there. The source guard (permission-revoke-doors-guard.test.ts) fails if a route in auth.routes.ts that
   runs without `authenticate` is in neither list below, and if code anywhere else starts minting or accepting sessions.
   ========================================================================== */

/** Every authenticated route: the session door. The authenticate middleware runs the one sign-in check before any of them. */
export const SESSION_DOOR = 'every route behind authenticate';

/** The unauthenticated routes that sign someone in, keep them signed in, or open the way to it. Method and path under /api/auth. */
export const SIGN_IN_DOORS = [
  'POST /login',
  'POST /mfa/verify',
  'POST /refresh',
  'POST /google/finalize',
  'POST /invite',
  'POST /accept-invite',
  'POST /accept-invite/terms',
  'POST /password/reset',
] as const;

/** Unauthenticated routes that open no session, each with why. A new unauthenticated route goes in one of the two lists. */
export const NOT_A_DOOR: Record<string, string> = {
  'POST /password/forgot': 'sends a reset link only to an active person with a login (lib/password-reset requestPasswordReset), and the link itself is the password/reset door',
  'POST /mfa/resend': 'mails a new code for a parked sign-in; the code opens nothing unless mfa/verify, a door, lets them in',
  'POST /owner-approval': "shows a Make Owner approval link's names (ticket 27); makes no session and changes nothing",
  'POST /owner-approval/approve': 'moves the company\'s Owner from an emailed approval link (ticket 27); makes no session and signs no one in',
};

/**
 * The only source files allowed to mint or accept a session with the identity provider, each with why. A call to one of
 * SESSION_CALLS anywhere else fails the guard, so a new way in can't appear without joining the door table.
 */
export const SESSION_CALL_SITES: Record<string, string> = {
  'middleware/authenticate.ts': 'the session door: verifies every bearer token, then the one sign-in check',
  'controllers/auth.controller.ts': 'the sign-in doors in SIGN_IN_DOORS',
  'lib/password-reset.ts': 'the password/reset door, and the reset link it mints',
  'controllers/user.controller.ts': "an Admin creating a person with a password, and re-checking a signed-in person's current password",
  'lib/e2e-org.ts': 'the end-to-end test company, never reachable from a route',
};

/** The identity-provider calls that make or accept a session or a login. */
export const SESSION_CALLS = [
  'signInWithPassword(', 'refreshSession(', 'verifyOtp(', 'auth.getUser(', 'admin.createUser(', 'generateLink(',
  'signInWithOtp(', 'signInWithOAuth(', 'exchangeCodeForSession(', 'setSession(', 'signInWithIdToken(', 'signUp(',
] as const;
