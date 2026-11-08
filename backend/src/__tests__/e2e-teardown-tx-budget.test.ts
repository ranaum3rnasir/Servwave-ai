/**
 * teardownTestOrg's transaction budget.
 *
 * Found by sweeping 10 leaked `e2e-qa-*` orgs off staging on 2026-08-04. teardownTestOrg used
 * to wrap the ENTIRE purge in one Prisma interactive transaction (`{ timeout: 120_000 }`),
 * while purgeOrganization walks customers one subtree at a time. On the three biggest leaked
 * orgs (40, 41 and 99 customers) that loop needed more than 120s of round trips, so the
 * transaction expired mid-purge:
 *
 *   Transaction not found. Transaction ID is invalid, refers to an old closed transaction
 *   Prisma doesn't have information about anymore, or was obtained before disconnecting.
 *
 * The whole purge then rolled back and the org survived intact - which is almost certainly why
 * those orgs leaked in the first place: every small org in the set tore down fine, every large
 * one did not, so each QA run against a big org left its org behind forever.
 *
 * The fix splits the work instead of raising the ceiling: one transaction per customer subtree,
 * then a final small one for the org. WHAT gets deleted is unchanged (purgeCustomerSubtree and
 * purgeOrganization are reused untouched, with the same `e2e-qa-` name guard); only the
 * transaction boundaries move.
 *
 * The deliberate trade, asserted below: the purge is no longer atomic. For a throwaway QA org
 * that is strictly better - a partial purge leaves less behind than a total rollback, and a
 * retry resumes where it stopped because deleted customers stay deleted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.unmock('../config/env');
vi.mock('../lib/supabase', () => ({
  supabaseAdmin: { auth: { admin: { listUsers: vi.fn(async () => ({ data: { users: [] } })), deleteUser: vi.fn() } } },
}));

const purgeCustomerSubtree = vi.fn(async () => {});
const purgeOrganization = vi.fn(async () => {});
vi.mock('../lib/purge', () => ({ purgeCustomerSubtree, purgeOrganization }));

const organization = { findUnique: vi.fn() };
const customer = { findMany: vi.fn() };
const $transaction = vi.fn(async (fn: any, _opts?: any) => fn({} as any));
vi.mock('../lib/prisma', () => ({ prisma: { organization, customer, $transaction } }));

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

function withCustomers(n: number, orgName = 'e2e-qa-abc123') {
  organization.findUnique.mockResolvedValue({ id: ORG_ID, name: orgName });
  customer.findMany.mockResolvedValue(Array.from({ length: n }, (_, i) => ({ id: `cust-${i}` })));
}

beforeEach(() => {
  vi.clearAllMocks();
  $transaction.mockImplementation(async (fn: any) => fn({} as any));
});

describe('teardownTestOrg — transaction budget', () => {
  it('opens one transaction PER CUSTOMER plus one for the org, never a single all-encompassing one', async () => {
    const teardownTestOrg = await loadTeardown();
    withCustomers(99); // the size that actually failed on staging

    await teardownTestOrg(ORG_ID);

    // 99 customer transactions + 1 org transaction. The old code opened exactly 1 for everything.
    expect($transaction).toHaveBeenCalledTimes(100);
    expect(purgeCustomerSubtree).toHaveBeenCalledTimes(99);
    expect(purgeOrganization).toHaveBeenCalledTimes(1);
  });

  it('scales the transaction count with the customer count (the 1-transaction design did not)', async () => {
    const teardownTestOrg = await loadTeardown();
    withCustomers(3);
    await teardownTestOrg(ORG_ID);
    expect($transaction).toHaveBeenCalledTimes(4);
  });

  it('still purges the org itself when it has no customers at all', async () => {
    const teardownTestOrg = await loadTeardown();
    withCustomers(0);
    await teardownTestOrg(ORG_ID);
    expect(purgeCustomerSubtree).not.toHaveBeenCalled();
    expect(purgeOrganization).toHaveBeenCalledTimes(1);
    expect($transaction).toHaveBeenCalledTimes(1);
  });

  it('passes the e2e name guard through to purgeOrganization unchanged', async () => {
    const teardownTestOrg = await loadTeardown();
    withCustomers(1);
    await teardownTestOrg(ORG_ID);
    expect(purgeOrganization).toHaveBeenCalledWith(expect.anything(), ORG_ID, 'e2e-qa-');
  });

  it('gives every transaction an explicit timeout (never Prisma\'s 5s default)', async () => {
    const teardownTestOrg = await loadTeardown();
    withCustomers(2);
    await teardownTestOrg(ORG_ID);
    for (const call of $transaction.mock.calls) {
      expect(call[1]).toMatchObject({ timeout: expect.any(Number) });
      expect((call[1] as any).timeout).toBeGreaterThanOrEqual(120_000);
    }
  });

  // ── The safety requirement the split INTRODUCES ────────────────────────────
  // purgeOrganization carries the name guard, but it now runs LAST - after the customer loop
  // has already deleted data. So teardownTestOrg must assert the guard itself, up front, or a
  // mis-aimed org id would have its customers purged before anything checked the name.
  it('refuses a non-e2e org BEFORE deleting a single customer subtree', async () => {
    const teardownTestOrg = await loadTeardown();
    withCustomers(5, 'Northwind Services');

    await expect(teardownTestOrg(ORG_ID)).rejects.toThrow(/refus/i);

    expect(purgeCustomerSubtree).not.toHaveBeenCalled();
    expect(purgeOrganization).not.toHaveBeenCalled();
    expect($transaction).not.toHaveBeenCalled();
  });

  it('does nothing and does not throw when the org is already gone', async () => {
    const teardownTestOrg = await loadTeardown();
    organization.findUnique.mockResolvedValue(null);
    customer.findMany.mockResolvedValue([]);
    await expect(teardownTestOrg(ORG_ID)).resolves.toBeUndefined();
    expect(purgeCustomerSubtree).not.toHaveBeenCalled();
    expect(purgeOrganization).not.toHaveBeenCalled();
  });

  // ── The deliberate atomicity trade ─────────────────────────────────────────
  it('keeps the customers it already purged when a later customer transaction fails', async () => {
    const teardownTestOrg = await loadTeardown();
    withCustomers(4);
    let n = 0;
    $transaction.mockImplementation(async (fn: any) => {
      n += 1;
      if (n === 3) throw new Error('Transaction not found. Transaction ID is invalid');
      return fn({} as any);
    });

    await expect(teardownTestOrg(ORG_ID)).rejects.toThrow(/Transaction not found/);

    // Progress is durable: the first two subtrees were purged in their own committed
    // transactions. Under the old single-transaction design a failure here rolled the whole
    // org back and left it fully intact, which is how these orgs leaked.
    expect(purgeCustomerSubtree).toHaveBeenCalledTimes(2);
    expect(purgeOrganization).not.toHaveBeenCalled();
  });

  it('sweeps @e2e-qa.invalid Auth users even when no org id is supplied', async () => {
    const teardownTestOrg = await loadTeardown();
    await expect(teardownTestOrg()).resolves.toBeUndefined();
    expect(organization.findUnique).not.toHaveBeenCalled();
    expect($transaction).not.toHaveBeenCalled();
  });
});
