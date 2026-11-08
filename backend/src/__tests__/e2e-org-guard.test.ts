import { describe, it, expect, vi, afterEach } from 'vitest';

// This suite exercises the REAL env.ts (it is the env-driven guard under test), so we
// unmock the globally-mocked config/env and let vi.stubEnv feed process.env into a fresh
// envSchema.parse on each import. prisma/supabase stay mocked (cheap, never invoked by the
// guard) so importing e2e-org.ts does not spin up real clients.
vi.unmock('../config/env');
vi.mock('../lib/prisma', () => ({ prisma: {} }));
vi.mock('../lib/supabase', () => ({ supabaseAdmin: {} }));

// Minimum env every fresh env.ts parse needs (non-production path skips the sslmode guard).
function baseEnv() {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('SUPABASE_URL', 'https://x.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'x');
}

describe('assertSafeDbHost', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('throws when the DB host is not in E2E_ALLOWED_DB_HOSTS', async () => {
    baseEnv();
    vi.stubEnv('DATABASE_URL', 'postgresql://postgres.prodref:p@prod-db.supabase.co:6543/postgres');
    vi.stubEnv('E2E_ALLOWED_DB_HOSTS', 'staging-db.supabase.co,localhost');
    vi.stubEnv('E2E_ALLOWED_DB_REF', 'prodref');
    vi.resetModules();
    const { assertSafeDbHost } = await import('../lib/e2e-org.js');
    expect(() => assertSafeDbHost()).toThrow(/refusing.*not in the allowlist/i);
  });

  it('passes for an allowlisted host whose ref is embedded in DATABASE_URL', async () => {
    baseEnv();
    vi.stubEnv('DATABASE_URL', 'postgresql://postgres.stagingref:p@staging-db.supabase.co:6543/postgres');
    vi.stubEnv('E2E_ALLOWED_DB_HOSTS', 'staging-db.supabase.co,localhost');
    vi.stubEnv('E2E_ALLOWED_DB_REF', 'stagingref');
    vi.resetModules();
    const { assertSafeDbHost } = await import('../lib/e2e-org.js');
    expect(() => assertSafeDbHost()).not.toThrow();
  });

  it('throws when the ref does not appear in DATABASE_URL (shared pooler host, wrong project)', async () => {
    baseEnv();
    // Allowlisted host, but the connection username carries a DIFFERENT project ref than the
    // one we expect — this is the shared-pooler staging-vs-prod confusion the ref check guards.
    vi.stubEnv('DATABASE_URL', 'postgresql://postgres.someotherref:p@staging-db.supabase.co:6543/postgres');
    vi.stubEnv('E2E_ALLOWED_DB_HOSTS', 'staging-db.supabase.co,localhost');
    vi.stubEnv('E2E_ALLOWED_DB_REF', 'stagingref');
    vi.resetModules();
    const { assertSafeDbHost } = await import('../lib/e2e-org.js');
    expect(() => assertSafeDbHost()).toThrow(/project ref.*not found/i);
  });

  it('throws when E2E_ALLOWED_DB_REF is unset even if the host is allowlisted', async () => {
    baseEnv();
    vi.stubEnv('DATABASE_URL', 'postgresql://postgres.stagingref:p@staging-db.supabase.co:6543/postgres');
    vi.stubEnv('E2E_ALLOWED_DB_HOSTS', 'staging-db.supabase.co,localhost');
    vi.stubEnv('E2E_ALLOWED_DB_REF', '');
    vi.resetModules();
    const { assertSafeDbHost } = await import('../lib/e2e-org.js');
    expect(() => assertSafeDbHost()).toThrow(/project ref.*not found/i);
  });
});
