import { createHmac, timingSafeEqual } from 'crypto';
import { env } from '../config/env';

// Dedicated invite-signing secret. In production env.ts REQUIRES this to be set
// (>=32 chars), so invite links never share a secret with the service-role key
// (key reuse: a leaked invite token must not imply anything about that key, and
// rotating invites must not force a service-role rotation). In dev/test it may
// fall back to the service-role key so the app still boots with zero extra config.
const SECRET =
  env.INVITE_TOKEN_SECRET ||
  (env.NODE_ENV === 'production' ? '' : env.SUPABASE_SERVICE_ROLE_KEY);
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

/** How long an invite link lives. Ticket 27's Make Owner approval link uses the same (the spec gives it none of its own). */
export const INVITE_TTL_SECONDS = DEFAULT_TTL_SECONDS;

export interface InvitePayload {
  uid: string;
  email: string;
  exp: number; // unix seconds
  /** Which invite this link is. Only the link whose id the person's row currently holds is live (lib/invite-link.ts). */
  jti?: string;
}

function sign(body: string): string {
  return createHmac('sha256', SECRET).update(body).digest('base64url');
}

/**
 * The signature for another one-time link signed with the same secret, under its own scope (ticket 27: the Make Owner approval
 * link). The scope is part of what is signed, so a link of one kind never verifies as another, and never as an invite: an
 * invite's signed text is the bare body, which (base64url) never holds the newline that ends a scope.
 */
export function signScoped(scope: string, body: string): string {
  return sign(`${scope}\n${body}`);
}

/** Build a signed, self-contained invite token: `<base64url(payload)>.<hmac>`. */
export function signInviteToken(uid: string, email: string, ttlSeconds = DEFAULT_TTL_SECONDS, jti?: string): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload: InvitePayload = { uid, email, exp, ...(jti ? { jti } : {}) };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body)}`;
}

/** Verify signature + expiry. Returns the payload, or null if invalid/expired/tampered. */
export function verifyInviteToken(token: string): InvitePayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, providedSig] = parts;

  const expectedSig = sign(body);
  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: InvitePayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as InvitePayload;
  } catch {
    return null;
  }
  if (!payload || !payload.uid || !payload.email || typeof payload.exp !== 'number') return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  if (payload.jti !== undefined && typeof payload.jti !== 'string') return null;
  return payload;
}
