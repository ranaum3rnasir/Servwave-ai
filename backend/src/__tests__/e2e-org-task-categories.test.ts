import { describe, it, expect, vi, afterEach } from 'vitest';

// A provisioned throwaway org is a newly created organization like any other, so it must start
// with the three starter task categories (visits-and-task-categories slice 08). The seed SQL
// itself is exercised against a real database in task-categories-seed-db.test.ts; this suite
// proves provisionTestOrg runs it, for the org it just created.
//
// Same env handling as e2e-org-guard.test.ts: the REAL env.ts feeds assertSafeDbHost.
vi.unmock('../config/env');

const executeRaw = vi.fn().mockResolvedValue(3);
vi.mock('../lib/prisma', () => {
  const prisma = {
    organization: { create: vi.fn().mockResolvedValue({}), delete: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    user: { create: vi.fn().mockResolvedValue({}) },
    // The first Owner is recorded in the same transaction (ticket 25).
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    $executeRawUnsafe: (...args: unknown[]) => executeRaw(...args),
    // The admin and their mailbox are written in one transaction.
    $transaction: (fn: (tx: unknown) => unknown) => fn(prisma),
  };
  return { prisma };
});
// The company is created through the mailbox address register (its own suites cover that); here it only
// has to be called, so the register's transaction is not run against the mocked client.
vi.mock('../lib/mailbox/register', () => ({
  createCompanyWithMainMailbox: vi.fn().mockResolvedValue({}),
  issueUserMailbox: vi.fn().mockResolvedValue({ status: 'active' }),
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
