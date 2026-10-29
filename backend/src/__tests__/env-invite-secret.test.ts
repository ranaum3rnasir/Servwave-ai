import { describe, it, expect, vi, afterEach } from 'vitest';

// This suite exercises the REAL env.ts (the prod-only validation under test), so we unmock
// the globally-mocked config/env and feed process.env via vi.stubEnv into a fresh
// envSchema.parse on each import. prisma/supabase stay mocked so nothing real spins up.
vi.unmock('../config/env');
vi.mock('../lib/prisma', () => ({ prisma: {} }));
vi.mock('../lib/supabase', () => ({ supabaseAdmin: {} }));

// A complete-enough production env that satisfies every OTHER prod guard
// (sslmode on DATABASE_URL/DIRECT_URL, RESEND_API_KEY) so the ONLY thing under
// test is the new INVITE_TOKEN_SECRET requirement.
function prodBaseEnv() {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('SUPABASE_URL', 'https://x.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key-value');
  vi.stubEnv('DATABASE_URL', 'postgresql://u:p@db.example.com:6543/postgres?sslmode=require');
  vi.stubEnv('DIRECT_URL', 'postgresql://u:p@db.example.com:5432/postgres?sslmode=require');
  vi.stubEnv('RESEND_API_KEY', 'resend-key');
  vi.stubEnv('MFA_TOKEN_ENC_KEY', 'm'.repeat(40)); // satisfy the sibling prod MFA guard (authn-2)
}

describe('env.ts — INVITE_TOKEN_SECRET production requirement (F-26/F-56)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('refuses to boot in production when INVITE_TOKEN_SECRET is unset', async () => {
    prodBaseEnv();
    vi.stubEnv('INVITE_TOKEN_SECRET', '');
    vi.resetModules();
    await expect(import('../config/env.js')).rejects.toThrow(/INVITE_TOKEN_SECRET/i);
  });

  it('refuses to boot in production when INVITE_TOKEN_SECRET is too short (<32 chars)', async () => {
    prodBaseEnv();
    vi.stubEnv('INVITE_TOKEN_SECRET', 'short-secret');
    vi.resetModules();
    await expect(import('../config/env.js')).rejects.toThrow(/INVITE_TOKEN_SECRET/i);
  });

  it('boots in production with a dedicated >=32 char INVITE_TOKEN_SECRET', async () => {
    prodBaseEnv();
    vi.stubEnv('INVITE_TOKEN_SECRET', 'x'.repeat(40));
    vi.resetModules();
    const mod = await import('../config/env.js');
    expect(mod.env.INVITE_TOKEN_SECRET).toBe('x'.repeat(40));
    expect(mod.env.NODE_ENV).toBe('production');
  });

  it('does NOT require INVITE_TOKEN_SECRET outside production (dev/test unaffected)', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('SUPABASE_URL', 'https://x.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key-value');
    vi.stubEnv('DATABASE_URL', 'postgresql://u:p@db.example.com:6543/postgres');
    vi.stubEnv('INVITE_TOKEN_SECRET', '');
    vi.resetModules();
    const mod = await import('../config/env.js');
    expect(mod.env.NODE_ENV).toBe('test');
  });
});

// Proves the prod service-role-key fallback is gone in invite-token.ts: a token
// signed in production with NO INVITE_TOKEN_SECRET must not verify against the
// service-role key (i.e. the two no longer share a secret). env is mocked here so
// we can drive NODE_ENV='production' WITHOUT satisfying the full real-env schema.
describe('invite-token.ts — no service-role fallback in production (F-26/F-56)', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('../config/env');
  });

  it('does not sign invites with the service-role key in production', async () => {
    vi.resetModules();
    vi.doMock('../config/env', () => ({
      env: {
        NODE_ENV: 'production',
        INVITE_TOKEN_SECRET: undefined,
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-value',
      },
    }));
    const { signInviteToken, verifyInviteToken } = await import('../lib/invite-token.js');

    // With the prod fallback removed, SECRET is '' so a signed token still
    // round-trips against its OWN (empty) secret, but crucially the signature is
    // NOT computed from the service-role key. Build the would-be service-role
    // signature and assert the produced token does not match it.
    const token = signInviteToken('uid-1', 'a@b.com');
    expect(verifyInviteToken(token)?.uid).toBe('uid-1'); // self-consistent

    const { createHmac } = await import('crypto');
    const [body, sig] = token.split('.');
    const srkSig = createHmac('sha256', 'service-role-key-value').update(body).digest('base64url');
    expect(sig).not.toBe(srkSig); // NOT signed with the service-role key
  });

  it('signs with the dedicated secret when INVITE_TOKEN_SECRET is present in production', async () => {
    vi.resetModules();
    vi.doMock('../config/env', () => ({
      env: {
        NODE_ENV: 'production',
        INVITE_TOKEN_SECRET: 'x'.repeat(40),
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-value',
      },
    }));
    const { signInviteToken, verifyInviteToken } = await import('../lib/invite-token.js');
    const token = signInviteToken('uid-2', 'c@d.com');
    expect(verifyInviteToken(token)?.uid).toBe('uid-2');

    const { createHmac } = await import('crypto');
    const [body, sig] = token.split('.');
    const dedicatedSig = createHmac('sha256', 'x'.repeat(40)).update(body).digest('base64url');
    expect(sig).toBe(dedicatedSig); // signed with the dedicated secret
  });

  it('still falls back to the service-role key OUTSIDE production (dev/test unaffected)', async () => {
    vi.resetModules();
    vi.doMock('../config/env', () => ({
      env: {
        NODE_ENV: 'test',
        INVITE_TOKEN_SECRET: undefined,
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-value',
      },
    }));
    const { signInviteToken } = await import('../lib/invite-token.js');
    const token = signInviteToken('uid-3', 'e@f.com');

    const { createHmac } = await import('crypto');
    const [body, sig] = token.split('.');
    const srkSig = createHmac('sha256', 'service-role-key-value').update(body).digest('base64url');
    expect(sig).toBe(srkSig); // dev/test keeps the zero-config fallback
  });
});
