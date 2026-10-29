import { describe, it, expect } from 'vitest';
import authRouter from '../routes/auth.routes';
import { unscopedRequest } from '../middleware/unscopedRequest';

/**
 * Regression guard for the "cannot log in on staging + main" incident.
 *
 * The unauthenticated auth-bootstrap routes resolve the user (and thus the org)
 * from credentials/token BEFORE any org context exists. Once DB_TENANT_GUARD=on
 * and the app connects as the non-BYPASSRLS `app_rls` role, their `users` /
 * `organizations` / `mfa_email_challenge` lookups hit the fail-closed
 * tenant_isolation RLS policy and return no rows — so every login 401s unless the
 * route runs `unscopedRequest`. These assertions fail loudly if that middleware
 * is ever dropped from a bootstrap route again.
 */

type Layer = { handle: unknown; route?: { path: string; methods: Record<string, boolean>; stack: Layer[] } };

const layers = (authRouter as unknown as { stack: Layer[] }).stack;

function routeHandles(method: string, path: string): unknown[] {
  const layer = layers.find(
    (l) => l.route?.path === path && l.route?.methods?.[method] === true,
  );
  if (!layer?.route) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
  return layer.route.stack.map((s) => s.handle);
}

describe('auth routes — RLS bootstrap wrapping', () => {
  // Every unauthenticated route that touches an RLS-protected table before an org
  // context exists must be wrapped in unscopedRequest.
  const bootstrapRoutes: Array<[string, string]> = [
    ['post', '/login'],
    ['post', '/refresh'],
    ['post', '/google/finalize'],
    ['post', '/invite'],
    ['post', '/accept-invite'],
    ['post', '/mfa/verify'],
    ['post', '/mfa/resend'],
  ];

  it.each(bootstrapRoutes)('%s %s runs unscopedRequest', (method, path) => {
    expect(routeHandles(method, path)).toContain(unscopedRequest);
  });

  // Authenticated routes get their org context from `authenticate` (runWithOrg),
  // so they must NOT be unscoped — that would defeat tenant isolation for them.
  const authenticatedRoutes: Array<[string, string]> = [
    ['post', '/logout'],
    ['get', '/me'],
    ['post', '/mfa/setup'],
    ['post', '/mfa/enable'],
    ['post', '/mfa/disable'],
    ['get', '/mfa/status'],
  ];

  it.each(authenticatedRoutes)('%s %s is NOT unscoped', (method, path) => {
    expect(routeHandles(method, path)).not.toContain(unscopedRequest);
  });
});
