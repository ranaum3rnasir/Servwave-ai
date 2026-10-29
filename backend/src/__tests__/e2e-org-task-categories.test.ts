import { describe, it, expect, vi, afterEach } from 'vitest';

// A provisioned throwaway org is a newly created organization like any other, so it must start
// with the three starter task categories (visits-and-task-categories slice 08). The seed SQL
// itself is exercised against a real database in task-categories-seed-db.test.ts; this suite
// proves provisionTestOrg runs it, for the org it just created.
//
// Same env handling as e2e-org-guard.test.ts: the REAL env.ts feeds assertSafeDbHost.
vi.unmock('../config/env');

const executeRaw = vi.fn().mockResolvedValue(3);
vi.mock('../lib/prisma', () => ({
  prisma: {
    organization: { create: vi.fn().mockResolvedValue({}), delete: vi.fn() },
    rolePermission: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    user: { create: vi.fn().mockResolvedValue({}) },
    $executeRawUnsafe: (...args: unknown[]) => executeRaw(...args),
  },
}));
vi.mock('../lib/supabase', () => ({
  supabaseAdmin: {
    auth: { admin: { createUser: vi.fn().mockResolvedValue({ data: { user: { id: 'u-1' } }, error: null }) } },
  },
}));

describe('provisionTestOrg - task categories', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); executeRaw.mockClear(); });

  it('seeds the starter task categories into the org it creates', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('SUPABASE_URL', 'https://x.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'x');
    vi.stubEnv('DATABASE_URL', 'postgresql://postgres.localref:p@localhost:5432/postgres');
    vi.stubEnv('E2E_ALLOWED_DB_HOSTS', 'localhost');
    vi.stubEnv('E2E_ALLOWED_DB_REF', 'localref');
    vi.resetModules();
    const { provisionTestOrg } = await import('../lib/e2e-org.js');
    const { starterTaskCategoriesSql } = await import('../lib/tasks/categories.js');

    const org = await provisionTestOrg();

    expect(executeRaw).toHaveBeenCalledWith(starterTaskCategoriesSql('$1::uuid'), org.organizationId);
  });
});
