/**
 * teardownTestOrg's Auth sweep scope.
 *
 * The default sweep deletes EVERY `@e2e-qa.invalid` Auth user, which is right for a crashed-run
 * cleanup but wrong when two local browser suites run at once from different worktrees (the
 * mobile gate is run by several slice agents in parallel): one run's teardown deletes the other
 * run's admin, whose session then 401s mid-run and every remaining page lands on /login.
 *
 * `authSweep: 'org'` limits the sweep to the Auth users of the org being torn down. Their ids are
 * read BEFORE the purge, because the purge deletes the org's User rows.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.unmock('../config/env');

const listUsers = vi.fn();
const deleteUser = vi.fn(async (_id: string) => ({}));
vi.mock('../lib/supabase', () => ({
  supabaseAdmin: { auth: { admin: { listUsers, deleteUser } } },
}));

const purgeCustomerSubtree = vi.fn(async () => {});
const purgeOrganization = vi.fn(async () => {});
vi.mock('../lib/purge', () => ({ purgeCustomerSubtree, purgeOrganization }));

const organization = { findUnique: vi.fn() };
const customer = { findMany: vi.fn(async () => []) };
const user = { findMany: vi.fn() };
const $transaction = vi.fn(async (fn: any, _opts?: any) => fn({} as any));
vi.mock('../lib/prisma', () => ({ prisma: { organization, customer, user, $transaction } }));

const ORG_ID = 'org-e2e-1';

async function loadTeardown() {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('SUPABASE_URL', 'https://x.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'x');
  vi.stubEnv('DATABASE_URL', 'postgresql://postgres.stagingref:p@staging-db.supabase.co:6543/postgres');
  vi.stubEnv('E2E_ALLOWED_DB_HOSTS', 'staging-db.supabase.co,localhost');
  vi.stubEnv('E2E_ALLOWED_DB_REF', 'stagingref');
  vi.resetModules();
  return (await import('../lib/e2e-org.js')).teardownTestOrg;
}

const AUTH_USERS = [
  { id: 'mine-admin', email: 'admin-aaaa@e2e-qa.invalid' },
  { id: 'mine-tech', email: 'tech-1@e2e-qa.invalid' },
  { id: 'other-run-admin', email: 'admin-bbbb@e2e-qa.invalid' },
  { id: 'real-user', email: 'someone@example.com' },
];

beforeEach(() => {
  vi.clearAllMocks();
  organization.findUnique.mockResolvedValue({ id: ORG_ID, name: 'e2e-qa-aaaa' });
  user.findMany.mockResolvedValue([
    { id: 'mine-admin', email: 'admin-aaaa@e2e-qa.invalid' },
    { id: 'mine-tech', email: 'tech-1@e2e-qa.invalid' },
  ]);
  listUsers.mockResolvedValue({ data: { users: AUTH_USERS } });
});

describe("teardownTestOrg - authSweep: 'org'", () => {
  it("deletes only the torn-down org's Auth users, never another run's", async () => {
    const teardownTestOrg = await loadTeardown();
    await teardownTestOrg(ORG_ID, { authSweep: 'org' });

    const deleted = deleteUser.mock.calls.map((c) => c[0]).sort();
    expect(deleted).toEqual(['mine-admin', 'mine-tech']);
    expect(listUsers).not.toHaveBeenCalled();
  });

  it('reads the user ids before the purge deletes the User rows', async () => {
    const teardownTestOrg = await loadTeardown();
    const order: string[] = [];
    user.findMany.mockImplementation(async () => { order.push('read-users'); return [{ id: 'mine-admin', email: 'admin-aaaa@e2e-qa.invalid' }]; });
    purgeOrganization.mockImplementation(async () => { order.push('purge-org'); });
    await teardownTestOrg(ORG_ID, { authSweep: 'org' });
    expect(order).toEqual(['read-users', 'purge-org']);
  });

  it('scopes the user read to the org being torn down', async () => {
    const teardownTestOrg = await loadTeardown();
    await teardownTestOrg(ORG_ID, { authSweep: 'org' });
    expect(user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organization_id: ORG_ID }) }),
    );
  });

  it('never deletes an Auth user whose email is outside the e2e domain, even if it sits in the org', async () => {
    const teardownTestOrg = await loadTeardown();
    user.findMany.mockResolvedValue([
      { id: 'mine-admin', email: 'admin-aaaa@e2e-qa.invalid' },
      { id: 'stray', email: 'someone@example.com' },
      { id: 'no-email', email: null },
    ]);
    await teardownTestOrg(ORG_ID, { authSweep: 'org' });
    expect(deleteUser.mock.calls.map((c) => c[0])).toEqual(['mine-admin']);
  });

  it('keeps the default full-domain sweep when no option is passed', async () => {
    const teardownTestOrg = await loadTeardown();
    await teardownTestOrg(ORG_ID);
    const deleted = deleteUser.mock.calls.map((c) => c[0]).sort();
    expect(deleted).toEqual(['mine-admin', 'mine-tech', 'other-run-admin']);
  });
});
