import { describe, it, expect, beforeAll } from 'vitest';
import {
  generateCode,
  hashCode,
  verifyCode,
  encryptRefreshToken,
  decryptRefreshToken,
} from '../mfa-otp';

// The crypto module reads process.env directly (MFA_TOKEN_ENC_KEY ||
// SUPABASE_SERVICE_ROLE_KEY). Pin a deterministic key so HMAC/AES output is
// stable regardless of the shell .env under vitest.
beforeAll(() => {
  process.env.MFA_TOKEN_ENC_KEY = 'test-mfa-enc-key-deterministic';
});

describe('mfa-otp · generateCode', () => {
  it('returns a 6-digit numeric string', () => {
    const code = generateCode();
    expect(code).toMatch(/^\d{6}$/);
  });
});

describe('mfa-otp · verifyCode', () => {
  it('returns true when the code matches its stored hash', () => {
    const code = '123456';
    const stored = hashCode(code);
    expect(verifyCode(code, stored)).toBe(true);
  });

  it('returns false when the code does not match its stored hash', () => {
    const stored = hashCode('123456');
    expect(verifyCode('654321', stored)).toBe(false);
  });

  it('returns false (no throw) when the stored hash is the wrong length', () => {
    // Exercises the equal-length guard before timingSafeEqual, which would
    // otherwise throw RangeError on mismatched buffer lengths.
    expect(verifyCode('123456', 'deadbeef')).toBe(false);
  });
});

describe('mfa-otp · refresh-token encryption', () => {
  it('round-trips a refresh token through encrypt → decrypt', () => {
    const plain = 'sb-refresh-token.abc123.def456';
    const blob = encryptRefreshToken(plain);
    expect(blob).not.toBe(plain);
    expect(decryptRefreshToken(blob)).toBe(plain);
  });

  it('throws when decrypting a tampered blob (GCM auth failure)', () => {
    const blob = encryptRefreshToken('sb-refresh-token.abc123.def456');
    // Flip a byte in the ciphertext region (well past iv + authTag).
    const raw = Buffer.from(blob, 'base64');
    raw[raw.length - 1] ^= 0xff;
    const tampered = raw.toString('base64');
    expect(() => decryptRefreshToken(tampered)).toThrow();
  });
});
