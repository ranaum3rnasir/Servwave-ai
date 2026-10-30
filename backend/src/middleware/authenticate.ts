import { Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { resolveAppUser, signInRefusal } from '../lib/auth-user';
import { runWithOrg, runUnscoped } from '../lib/tenant-context';
import { logger } from '../lib/logger';
import { SWITCHES_STAMP_HEADER } from '../lib/permissions/switches/stamp';
import { readAccessStamp, signInStampOf, type AccessStamp } from '../lib/permissions/accessStamp';
import { runWithSwitchesStamp } from '../lib/permissions/switches/cache';

interface CachedAuth {
  user: {
    id: string;
    email: string;
    first_name: string;
    last_name: string;
    role: string;
    // Roles & Permissions P15: the Admin flag MUST travel with the person, cached copy included: isSuperUser reads it
    // off req.user on every request, and a missing flag would lock every Admin out.
    is_admin: boolean;
    // SRVW-138: MUST travel with the base role - grantRoleKey/isSuperUser read these off
    // req.user on every request, cached copy included. Dropping them here silently
    // resolves every custom-role user's grants as their (possibly wider) base role.
    custom_role_id?: string | null;
    custom_role?: { key: string } | null;
    has_login: boolean;
    organization_id: string;
    org_is_demo: boolean;
    org_is_spider_pilot: boolean;
    org_plan: string;
    org_features: string[];
    department_id?: string | null;
    location_id?: string | null;
    phone?: string | null;
    phone_ext?: string | null;
    // The auth provider's id for this person, taken from the VERIFIED token. Not the app user
    // id: an invited user's two ids differ (lib/auth-user.ts). Server-side only - `me` strips it.
    auth_id: string;
  };
  /**
   * The sign-in part of the person's access stamp, made from the row this copy was built from (ticket 37). The copy is used
   * only while the stamp read from the database on each request still matches, so a change made on any server is seen here
   * on the person's next request. The TTL below bounds memory and the profile fields (name, email) that are not access.
   */
  stamp: string;
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
  | { ok: true; user: CachedAuth['user']; stamp: string }
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

/**
 * When each person's cached sign-in was last thrown away (security finding H2, ticket 22). A verification reads the person's row
 * and only then fills the cache; if a revoke or a deactivation lands between that read and the fill, the fill would put back the
 * "may sign in" the revoke just threw away, for up to 60 s. So every clear is numbered, a verification notes the number when it
 * starts, and its result is cached only if no clear for that person (or for everyone) has happened since.
 */
let clearSeq = 0;
let everyoneClearedAt = 0;
const userClearedAt = new Map<string, { seq: number; at: number }>();

// Evict expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of tokenCache) {
    if (entry.expiresAt <= now) {
      tokenCache.delete(token);
    }
  }
  // A clear only matters to a verification still running when it happened; none runs anywhere near this long.
  for (const [userId, cleared] of userClearedAt) {
    if (cleared.at <= now - EVICTION_INTERVAL_MS) userClearedAt.delete(userId);
  }
}, EVICTION_INTERVAL_MS).unref();

/** Whether a verification that started at clear number `startedAt` may still cache its result for this person. */
function stillCacheable(userId: string, startedAt: number): boolean {
  return everyoneClearedAt <= startedAt && (userClearedAt.get(userId)?.seq ?? 0) <= startedAt;
}

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
  clearSeq += 1;
  if (userId === undefined) {
    everyoneClearedAt = clearSeq;
    tokenCache.clear();
    return;
  }
  userClearedAt.set(userId, { seq: clearSeq, at: Date.now() });
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
  // The one sign-in check (H2), before any route: a deactivated person, and a person whose sign-in was revoked, hold no
  // session, whatever token they still carry. A revoked session answers what a removed login answers (the token is no good),
  // so the browser signs them out.
  const refusal = signInRefusal(user);
  if (refusal === 'deactivated') return { ok: false, status: 403, error: 'Account is deactivated' };
  if (refusal === 'no_login') return { ok: false, status: 401, error: 'Invalid or expired token' };

  return {
    ok: true,
    stamp: signInStampOf(user),
    user: {
      id: user.id,
      email: user.email,
      first_name: user.first_name,
      last_name: user.last_name,
      role: user.role,
      is_admin: user.is_admin,
      custom_role_id: user.custom_role_id,
      custom_role: user.custom_role,
      has_login: user.has_login,
      organization_id: user.organization_id,
      org_is_demo: user.org_is_demo,
      org_is_spider_pilot: user.org_is_spider_pilot,
      org_plan: user.org_plan,
      org_features: user.org_features,
      department_id: user.department_id,
      location_id: user.location_id,
      phone: user.phone,
      phone_ext: user.phone_ext,
      auth_id: data.user.id,
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

/**
 * The person's access stamp now (lib/permissions/accessStamp.ts), read under their company for the database's tenant rules.
 * Null when it cannot be read: there is then nothing to compare a copy with, so none is used.
 */
async function freshStamp(user: CachedAuth['user']): Promise<AccessStamp | null> {
  try {
    return await runWithOrg(user.organization_id, () => readAccessStamp(user.id));
  } catch (err) {
    logger.debug('access stamp unavailable', { err });
    return null;
  }
}

/**
 * The rest of the request, as this person: scoped to their company for the database's tenant rules, carrying the switches
 * stamp just read (the header P17 sends the browser, and the key of the switch copy in memory).
 */
async function carryOn(user: CachedAuth['user'], stamp: AccessStamp | null, res: Response, next: NextFunction): Promise<void> {
  // The header only tells the browser when to refetch: it never fails the request it rides on.
  try {
    if (stamp) res.setHeader(SWITCHES_STAMP_HEADER, stamp.switches);
  } catch (err) {
    logger.debug('switches stamp header not set', { err });
  }
  await runWithOrg(user.organization_id, () => runWithSwitchesStamp(user.id, stamp?.switches ?? null, async () => {
    next();
  }));
}

/**
 * The requests this middleware has already signed in, with the token it did it for. Several routers share a base path
 * (/api/inventory, /api/communication) and each runs `authenticate` on traffic it only passes through, so one request can
 * meet it several times. The first run read the access stamp and set the request's company and stamp scope around the rest
 * of the chain, which includes the later runs, so they have nothing to add and the stamp is read once per request.
 */
const signedIn = new WeakMap<Request, string>();

export async function authenticate(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid authorization header' });
    return;
  }

  const token = authHeader.substring(7);
  if (req.user && signedIn.get(req) === token) {
    next();
    return;
  }

  try {
    // A copy in memory is used only while the person's access, read from the database now, is what it was when the copy was
    // made: a deactivation, a revoke, a new role or Admin flag made on any server ends it here, on this very request.
    const cached = tokenCache.get(token);
    if (cached && cached.expiresAt > Date.now()) {
      const stamp = await freshStamp(cached.user);
      if (stamp && stamp.signIn === cached.stamp) {
        req.user = cached.user as typeof req.user;
        signedIn.set(req, token);
        await carryOn(cached.user, stamp, res, next);
        return;
      }
      if (tokenCache.get(token) === cached) tokenCache.delete(token);
    }

    // Cache miss: verify the token, or wait on the verification a sibling
    // request already started for this same token.
    const startedAt = clearSeq;
    const outcome = await verifyTokenOnce(token);

    if (!outcome.ok) {
      res.status(outcome.status).json({ error: outcome.error });
      return;
    }

    // Store in cache for subsequent requests. Every request in a shared burst
    // writes the same user here; the last one simply wins, and its expiry is
    // the most generous, which is the one worth keeping.
    // Not if the person's sign-in was thrown away while this verification ran (a revoke, a deactivation): the next request
    // verifies again and is refused.
    if (stillCacheable(outcome.user.id, startedAt)) {
      tokenCache.set(token, {
        user: outcome.user,
        stamp: outcome.stamp,
        expiresAt: Date.now() + TOKEN_TTL_MS,
      });
    }

    req.user = outcome.user as typeof req.user;
    signedIn.set(req, token);
    await carryOn(outcome.user, await freshStamp(outcome.user), res, next);
  } catch (err) {
    logger.error('Authentication error:', err);
    res.status(401).json({ error: 'Authentication failed' });
  }
}
