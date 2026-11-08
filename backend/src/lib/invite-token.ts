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

export interface InvitePayload {
  uid: string;
  email: string;
  exp: number; // unix seconds
}

function sign(body: string): string {
  return createHmac('sha256', SECRET).update(body).digest('base64url');
}

/** Build a signed, self-contained invite token: `<base64url(payload)>.<hmac>`. */
export function signInviteToken(uid: string, email: string, ttlSeconds = DEFAULT_TTL_SECONDS): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload: InvitePayload = { uid, email, exp };
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
  return payload;
}
