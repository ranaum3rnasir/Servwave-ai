import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Stripe from 'stripe';
import { prisma } from '../lib/prisma';
import { retrieveAccount, checkPlatformKey } from '../lib/stripe';
import { logger } from '../lib/logger';
import { env } from '../config/env';
import { getTenantContext, runUnscoped } from '../lib/tenant-context';
import { refreshAllAccountStatuses } from '../lib/account-status';

const ORG_A = '00000000-0000-0000-0000-0000000000a1';
const ORG_B = '00000000-0000-0000-0000-0000000000b2';
const ORG_NONE = '00000000-0000-0000-0000-0000000000c3';

const mockPrisma = prisma as unknown as {
  organization: {
    findMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
  $transaction: ReturnType<typeof vi.fn>;
  $executeRaw: ReturnType<typeof vi.fn>;
};
const mockRetrieveAccount = vi.mocked(retrieveAccount);
const mockCheckPlatformKey = vi.mocked(checkPlatformKey);
const mutableEnv = env as unknown as { STRIPE_SECRET_KEY?: string };

// An in-memory org table standing in for the database: findMany honours the
// "has an account" filter only if the job asks for it, findUnique reads by id.
const ORGS = [
  { id: ORG_A, stripe_account_id: 'acct_a', stripe_charges_enabled: true },
  { id: ORG_B, stripe_account_id: 'acct_b', stripe_charges_enabled: true },
  { id: ORG_NONE, stripe_account_id: null, stripe_charges_enabled: false },
];

let writes: Array<{ orgId: string; tenant: ReturnType<typeof getTenantContext>; data: Record<string, unknown> }>;

beforeEach(() => {
  vi.clearAllMocks();
  mutableEnv.STRIPE_SECRET_KEY = 'sk_test_unit';
  writes = [];
  mockCheckPlatformKey.mockResolvedValue(undefined);
  // Slice 10: each org's refresh writes in one transaction, under the org row lock.
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
  mockPrisma.$executeRaw.mockResolvedValue(0);
  // Returns EVERY org, as if the query filter were dropped, so the job's own skip is what's tested.
  mockPrisma.organization.findMany.mockResolvedValue(ORGS.map((o) => ({ id: o.id, stripe_account_id: o.stripe_account_id })));
  mockPrisma.organization.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    ORGS.find((o) => o.id === where.id) ?? null);
  mockPrisma.organization.updateMany.mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
    // Payouts slice P2: the payout summary is written beside the status; this list is the status writes.
    if (!('payout_summary' in data)) writes.push({ orgId: where.id, tenant: getTenantContext(), data });
    return { count: 1 };
  });
  mockRetrieveAccount.mockImplementation(async (id: string) => {
    if (id === 'acct_a') {
      return { id, charges_enabled: true, payouts_enabled: true, details_submitted: true,
        requirements: { currently_due: [], disabled_reason: null } } as unknown as Stripe.Account;
    }
    throw new Stripe.errors.StripePermissionError({ type: 'invalid_request_error', code: 'account_invalid', message: 'no access' });
  });
});
afterEach(() => {
  delete mutableEnv.STRIPE_SECRET_KEY;
});

describe('refreshAllAccountStatuses (nightly)', () => {
  it('refreshes each org with an account under that org\'s own tenant context', async () => {
    const summary = await runUnscoped(() => refreshAllAccountStatuses());

    expect(writes.map((w) => w.orgId).sort()).toEqual([ORG_A, ORG_B]);
    for (const w of writes) {
      expect(w.tenant).toEqual({ orgId: w.orgId, unscoped: false });
    }
    expect(writes.find((w) => w.orgId === ORG_B)!.data).toMatchObject({ stripe_charges_enabled: false });
    expect(summary.orgs).toEqual([
      { orgId: ORG_A, outcome: 'refreshed', stripe_charges_enabled: true },
      { orgId: ORG_B, outcome: 'failed_closed', stripe_charges_enabled: false },
    ]);
  });

  it('never looks up or writes an org without an account', async () => {
    await runUnscoped(() => refreshAllAccountStatuses());

    expect(writes.some((w) => w.orgId === ORG_NONE)).toBe(false);
    expect(mockRetrieveAccount).toHaveBeenCalledTimes(2);
    expect(mockRetrieveAccount).not.toHaveBeenCalledWith(null);
  });

  it('a dry run lists the orgs it would refresh and touches nothing', async () => {
    const summary = await runUnscoped(() => refreshAllAccountStatuses({ dryRun: true }));

    expect(summary).toEqual({ dryRun: true, orgs: [{ orgId: ORG_A }, { orgId: ORG_B }] });
    expect(mockRetrieveAccount).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it('one org failing unexpectedly does not stop the others', async () => {
    mockPrisma.organization.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
      if (where.id === ORG_A) throw new Error('connection reset');
      return ORGS.find((o) => o.id === where.id) ?? null;
    });

    const summary = await runUnscoped(() => refreshAllAccountStatuses());

    expect(summary.orgs).toEqual([
      { orgId: ORG_A, outcome: 'error' },
      { orgId: ORG_B, outcome: 'failed_closed', stripe_charges_enabled: false },
    ]);
  });

  // Conductor decision 2026-10-06: a bad platform key would fail every org's lookup the same
  // way. The job proves the key once first and, if it cannot, writes nothing for anyone.
  it('checks the platform key once before refreshing any org', async () => {
    const order: string[] = [];
    mockCheckPlatformKey.mockImplementation(async () => { order.push('check'); });
    mockRetrieveAccount.mockImplementation(async (id: string) => {
      order.push(id);
      return { id, charges_enabled: true, payouts_enabled: true, details_submitted: true,
        requirements: { currently_due: [], disabled_reason: null } } as unknown as Stripe.Account;
    });

    await runUnscoped(() => refreshAllAccountStatuses());

    expect(order).toEqual(['check', 'acct_a', 'acct_b']);
  });

  it('a failed platform check aborts the run: no org is looked up or written, and a warning is logged', async () => {
    mockCheckPlatformKey.mockRejectedValue(new Stripe.errors.StripeAuthenticationError({
      type: 'invalid_request_error', message: 'Invalid API Key provided', statusCode: 401,
    } as never));

    const summary = await runUnscoped(() => refreshAllAccountStatuses());

    expect(mockRetrieveAccount).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(summary).toEqual({ aborted: 'platform_check_failed', orgs: [] });
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining('platform key check failed'),
      expect.anything(),
    );
  });

  it('a dry run does not call the processor, not even for the platform check', async () => {
    await runUnscoped(() => refreshAllAccountStatuses({ dryRun: true }));

    expect(mockCheckPlatformKey).not.toHaveBeenCalled();
  });
});
