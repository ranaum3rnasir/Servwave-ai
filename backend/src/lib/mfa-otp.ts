import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomInt,
  scryptSync,
  timingSafeEqual,
} from 'crypto';

const IV_BYTES = 12; // GCM standard nonce length
const TAG_BYTES = 16; // GCM auth tag length

// Resolved lazily (at use-time, not module-load) so a missing key only throws
// when crypto is actually exercised. Mirrors the invite-token secret resolution:
// a dedicated MFA_TOKEN_ENC_KEY lets prod rotate the 2FA secret independently of
// the service-role key. In PRODUCTION the service-role fallback is removed (key
// reuse: a service-role leak must not also yield OTP forgery / refresh-token
// decryption) — config/env.ts requires MFA_TOKEN_ENC_KEY at boot, so prod never
// reaches the throw; in dev/test the fallback keeps zero-config boot (authn-2).
function mfaSecret(): string {
  const secret =
    process.env.MFA_TOKEN_ENC_KEY ||
    (process.env.NODE_ENV === 'production' ? '' : process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!secret) {
    throw new Error('MFA secret missing: set MFA_TOKEN_ENC_KEY (required in production)');
  }
  return secret;
}

/** Generate a zero-padded 6-digit one-time code via a CSPRNG. */
export function generateCode(): string {
  // randomInt's upper bound is exclusive: [0, 1_000_000) → six digits.
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** HMAC-SHA256 of a code under the MFA secret, hex-encoded (the at-rest form). */
export function hashCode(code: string): string {
  return createHmac('sha256', mfaSecret()).update(code).digest('hex');
}

/**
 * Constant-time comparison of a candidate code against a stored hash.
 * Never uses `===` (which short-circuits and leaks timing). The equal-length
 * guard prevents timingSafeEqual from throwing on mismatched buffer lengths.
 */
export function verifyCode(code: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashCode(code));
  const stored = Buffer.from(storedHash);
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
}

// AES-256 needs a 32-byte key; derive it from the MFA secret with a fixed salt
// so the same secret always yields the same key (required to decrypt later).
function encKey(): Buffer {
  return scryptSync(mfaSecret(), 'mfa-otp-enc', 32);
}

/**
 * Encrypt a Supabase refresh token with AES-256-GCM. The output is
 * base64(iv | authTag | ciphertext) — self-contained, so decrypt needs only
 * the blob + the secret. A fresh random IV per call keeps identical plaintexts
 * from producing identical ciphertexts.
 */
export function encryptRefreshToken(plain: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', encKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

/**
 * Inverse of encryptRefreshToken. Throws if the blob was tampered with: GCM
 * authentication fails on any modified byte (iv, tag, or ciphertext).
 */
export function decryptRefreshToken(blob: string): string {
  const raw = Buffer.from(blob, 'base64');
  const iv = raw.subarray(0, IV_BYTES);
  const authTag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', encKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
