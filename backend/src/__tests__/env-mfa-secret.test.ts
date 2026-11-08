import { describe, it, expect, vi, afterEach } from 'vitest';

// Twin of env-invite-secret.test.ts, for the MFA encryption/HMAC key (authn-2).
// Exercises the REAL env.ts prod-only validation, so unmock the globally-mocked
// config/env and feed process.env via vi.stubEnv into a fresh envSchema.parse on
// each import. prisma/supabase stay mocked so nothing real spins up.
vi.unmock('../config/env');
vi.mock('../lib/prisma', () => ({ prisma: {} }));
vi.mock('../lib/supabase', () => ({ supabaseAdmin: {} }));

// A complete-enough production env that satisfies every OTHER prod guard (sslmode,
// RESEND_API_KEY, INVITE_TOKEN_SECRET) so the ONLY thing under test is the new
// MFA_TOKEN_ENC_KEY requirement.
function prodBaseEnv() {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('SUPABASE_URL', 'https://x.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key-value');
  vi.stubEnv('DATABASE_URL', 'postgresql://u:p@db.example.com:6543/postgres?sslmode=require');
  vi.stubEnv('DIRECT_URL', 'postgresql://u:p@db.example.com:5432/postgres?sslmode=require');
  vi.stubEnv('RESEND_API_KEY', 'resend-key');
  vi.stubEnv('INVITE_TOKEN_SECRET', 'i'.repeat(40));
}

describe('env.ts — MFA_TOKEN_ENC_KEY production requirement (authn-2)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('refuses to boot in production when MFA_TOKEN_ENC_KEY is unset', async () => {
    prodBaseEnv();
    vi.stubEnv('MFA_TOKEN_ENC_KEY', '');
    vi.resetModules();
    await expect(import('../config/env.js')).rejects.toThrow(/MFA_TOKEN_ENC_KEY/i);
  });

  it('refuses to boot in production when MFA_TOKEN_ENC_KEY is too short (<32 chars)', async () => {
    prodBaseEnv();
    vi.stubEnv('MFA_TOKEN_ENC_KEY', 'short-secret');
    vi.resetModules();
    await expect(import('../config/env.js')).rejects.toThrow(/MFA_TOKEN_ENC_KEY/i);
  });

  it('boots in production with a dedicated >=32 char MFA_TOKEN_ENC_KEY', async () => {
    prodBaseEnv();
    vi.stubEnv('MFA_TOKEN_ENC_KEY', 'm'.repeat(40));
    vi.resetModules();
    const mod = await import('../config/env.js');
    expect(mod.env.MFA_TOKEN_ENC_KEY).toBe('m'.repeat(40));
    expect(mod.env.NODE_ENV).toBe('production');
  });

  it('does NOT require MFA_TOKEN_ENC_KEY outside production (dev/test unaffected)', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('SUPABASE_URL', 'https://x.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key-value');
    vi.stubEnv('DATABASE_URL', 'postgresql://u:p@db.example.com:6543/postgres');
    vi.stubEnv('MFA_TOKEN_ENC_KEY', '');
    vi.resetModules();
    const mod = await import('../config/env.js');
    expect(mod.env.NODE_ENV).toBe('test');
  });
});

// Proves the prod service-role-key fallback is gone in mfa-otp.ts: in production the
// MFA HMAC/encryption secret must NOT be the service-role key — a service-role
// compromise must not also yield OTP forgery / refresh-token decryption. mfa-otp.ts
// reads process.env lazily (not the mocked config/env), so stubEnv drives it directly.
describe('mfa-otp.ts — no service-role fallback in production (authn-2)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('refuses the service-role-key fallback in production (throws instead of silently reusing it)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('MFA_TOKEN_ENC_KEY', '');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key-value');
    vi.resetModules();
    const { hashCode } = await import('../lib/mfa-otp.js');
    expect(() => hashCode('123456')).toThrow(/MFA secret missing/i);
  });

  it('uses the dedicated MFA key in production — not the service-role key', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('MFA_TOKEN_ENC_KEY', 'm'.repeat(40));
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key-value');
    vi.resetModules();
    const { hashCode } = await import('../lib/mfa-otp.js');
    const { createHmac } = await import('crypto');
    const dedicated = createHmac('sha256', 'm'.repeat(40)).update('123456').digest('hex');
    const srk = createHmac('sha256', 'service-role-key-value').update('123456').digest('hex');
    expect(hashCode('123456')).toBe(dedicated);
    expect(hashCode('123456')).not.toBe(srk);
  });

  it('still falls back to the service-role key OUTSIDE production (dev/test zero-config unaffected)', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('MFA_TOKEN_ENC_KEY', '');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key-value');
    vi.resetModules();
    const { hashCode } = await import('../lib/mfa-otp.js');
    const { createHmac } = await import('crypto');
    const srk = createHmac('sha256', 'service-role-key-value').update('123456').digest('hex');
    expect(hashCode('123456')).toBe(srk);
  });
});
