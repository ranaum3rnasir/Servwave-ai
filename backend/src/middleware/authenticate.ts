import { Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { resolveAppUser } from '../lib/auth-user';
import { runWithOrg, runUnscoped } from '../lib/tenant-context';
import { logger } from '../lib/logger';

interface CachedAuth {
  user: {
    id: string;
    email: string;
    first_name: string;
    last_name: string;
    role: string;
    // SRVW-138: MUST travel with the base role - grantRoleKey/isSuperUser read these off
    // req.user on every request, cached copy included. Dropping them here silently
    // resolves every custom-role user's grants as their (possibly wider) base role.
    custom_role_id?: string | null;
    custom_role?: { key: string } | null;
    has_login: boolean;
    organization_id: string;
    org_is_demo: boolean;
    org_plan: string;
    org_features: string[];
    feature_overrides?: Record<string, unknown> | null;
    department_id?: string | null;
    location_id?: string | null;
    phone?: string | null;
    phone_ext?: string | null;
  };
  expiresAt: number;
}

const TOKEN_TTL_MS = 60 * 1000; // 60 seconds
const EVICTION_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const tokenCache = new Map<string, CachedAuth>();

/**
 * What one verification of a bearer token concluded.
 *
 * The verification is shared between concurrent requests, so it cannot write a
 * response itself - it returns the conclusion and each request answers for
 * itself. That keeps `res` out of the shared path entirely, which is what stops
 * a burst from writing several responses onto one request.
 */
type AuthOutcome =
  | { ok: true; user: CachedAuth['user'] }
  | { ok: false; status: 401 | 403; error: string };

/**
 * Verifications currently in progress, keyed by token.
 *
 * `tokenCache` above holds the RESOLVED user, which only ever helps a request
 * that arrives after one has finished. A cold page load is the opposite shape:
 * the Phone page fires roughly a dozen queries in the same tick, every one a
 * cache miss, and each used to call Supabase Auth and re-read the user row on
 * its own. Measured against staging, one auth-path request costs ~85-100ms and
 * twelve concurrent ones 341-1003ms each. Holding the PROMISE collapses that
 * burst to a single verification.
 *
 * Entries live only as long as the request that created them - the `finally`
 * below removes each one on settle, success or failure alike, so nothing here
 * can serve a stale answer or outlive the token's own 60s result cache.
 */
const inFlight = new Map<string, Promise<AuthOutcome>>();

// Evict expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of tokenCache) {
    if (entry.expiresAt <= now) {
      tokenCache.delete(token);
    }
  }
}, EVICTION_INTERVAL_MS).unref();

/**
 * Clear the token cache.
 * If userId is provided, only evict entries for that user.
 * If omitted, clear the entire cache (useful in tests).
 */
export function clearTokenCache(userId?: string): void {
  // In-flight verifications are dropped either way. They cannot be filtered by
  // user - the user is precisely what has not been resolved yet - and the cost
  // of dropping one is a single extra verification, whereas keeping one alive
  // through a deactivation would hand back the session this call exists to
  // revoke.
  inFlight.clear();
  if (userId === undefined) {
    tokenCache.clear();
    return;
  }
  for (const [token, entry] of tokenCache) {
    if (entry.user.id === userId) {
      tokenCache.delete(token);
    }
  }
}

/** One verification: Supabase Auth, then the app user behind it. */
async function verifyToken(token: string): Promise<AuthOutcome> {
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) {
    return { ok: false, status: 401, error: 'Invalid or expired token' };
  }

  // The bootstrap lookup runs before any org context exists, so it must be
  // unscoped or RLS on `users` would hide the very row we're authenticating.
  const user = await runUnscoped(() => resolveAppUser(data.user));

  if (!user) return { ok: false, status: 401, error: 'User not found' };
  if (!user.is_active) return { ok: false, status: 403, error: 'Account is deactivated' };

  return {
    ok: true,
    user: {
      id: user.id,
      email: user.email,
      first_name: user.first_name,
      last_name: user.last_name,
      role: user.role,
      custom_role_id: user.custom_role_id,
      custom_role: user.custom_role,
      has_login: user.has_login,
      organization_id: user.organization_id,
      org_is_demo: user.org_is_demo,
      org_plan: user.org_plan,
      org_features: user.org_features,
      feature_overrides: user.feature_overrides,
      department_id: user.department_id,
      location_id: user.location_id,
      phone: user.phone,
      phone_ext: user.phone_ext,
    },
  };
}

/** Verify a token, or join the verification already running for it. */
function verifyTokenOnce(token: string): Promise<AuthOutcome> {
  const existing = inFlight.get(token);
  if (existing) return existing;

  const pending = verifyToken(token).finally(() => {
    inFlight.delete(token);
  });
  inFlight.set(token, pending);
  return pending;
}

export async function authenticate(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid authorization header' });
    return;
  }

  const token = authHeader.substring(7);

  try {
    // Cache hit: skip both Supabase and Prisma calls
    const cached = tokenCache.get(token);
    if (cached && cached.expiresAt > Date.now()) {
      req.user = cached.user as typeof req.user;
      // Scope the rest of the request to this org for the DB RLS backstop.
      runWithOrg(cached.user.organization_id, () => next());
      return;
    }

    // Cache miss: verify the token, or wait on the verification a sibling
    // request already started for this same token.
    const outcome = await verifyTokenOnce(token);

    if (!outcome.ok) {
      res.status(outcome.status).json({ error: outcome.error });
      return;
    }

    // Store in cache for subsequent requests. Every request in a shared burst
    // writes the same user here; the last one simply wins, and its expiry is
    // the most generous, which is the one worth keeping.
    tokenCache.set(token, {
      user: outcome.user,
      expiresAt: Date.now() + TOKEN_TTL_MS,
    });

    req.user = outcome.user as typeof req.user;
    // Scope the rest of the request to this org for the DB RLS backstop.
    runWithOrg(outcome.user.organization_id, () => next());
  } catch (err) {
    logger.error('Authentication error:', err);
    res.status(401).json({ error: 'Authentication failed' });
  }
}
