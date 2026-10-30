import { describe, it, expect, beforeAll, vi } from 'vitest';
import Stripe from 'stripe';
import { prisma } from '../lib/prisma';
import { retrieveAccount } from '../lib/stripe';
import { logger } from '../lib/logger';
import { getTenantContext } from '../lib/tenant-context';

/**
 * Server start (src/index.ts), payments go-live slice 06 (#1987).
 *
 * Replaces backfill-stripe-flags.test.ts: the boot-time backfill ran with no tenant context
 * and FAILED OPEN (any processor error set "can take cards" true when CARD was listed). It is
 * gone; account status now refreshes on the account event, on the return from onboarding and
 * nightly per org. These tests boot the real entry module with only its I/O stubbed.
 */

const scheduled: Array<{ expr: string; fn: () => unknown }> = vi.hoisted(() => []);

vi.mock('../instrument', () => ({}));
vi.mock('node-cron', () => ({
  default: { schedule: vi.fn((expr: string, fn: () => unknown) => { scheduled.push({ expr, fn }); }) },
}));
vi.mock('../app', () => ({
  default: { listen: vi.fn((_port: number, _host: string, cb?: () => void) => { cb?.(); return {}; }) },
}));
vi.mock('../services/notifications/invoiceDueCron', () => ({ runInvoiceDueChecks: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../services/automations/cron', () => ({ runAutomationTick: vi.fn().mockResolvedValue(undefined) }));

const ORG = '00000000-0000-0000-0000-0000000000a1';
const mockPrisma = prisma as unknown as {
  organization: {
    findMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
  $transaction: ReturnType<typeof vi.fn>;
  $executeRaw: ReturnType<typeof vi.fn>;
};
const mockRetrieveAccount = vi.mocked(retrieveAccount);
const flush = () => new Promise((r) => setTimeout(r, 20));

const writes: Array<{ orgId: string; tenant: ReturnType<typeof getTenantContext>; data: Record<string, unknown> }> = [];
let infoLines: string[] = [];

beforeAll(async () => {
  // An org whose account the processor will refuse: the old boot backfill grandfathered it to
  // "can take cards" because CARD is listed.
  const org = { id: ORG, stripe_account_id: 'acct_bogus', stripe_charges_enabled: true, accepted_payment_methods: ['CARD'] };
  mockPrisma.organization.findMany.mockResolvedValue([org]);
  mockPrisma.organization.findUnique.mockResolvedValue(org);
  mockPrisma.organization.update.mockResolvedValue({});
  // Slice 10: each refresh writes in one transaction, under the org row lock.
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
  mockPrisma.$executeRaw.mockResolvedValue(0);
  mockPrisma.organization.updateMany.mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
    writes.push({ orgId: where.id, tenant: getTenantContext(), data });
    return { count: 1 };
  });
  mockRetrieveAccount.mockRejectedValue(new Stripe.errors.StripePermissionError({
    type: 'invalid_request_error', code: 'account_invalid', message: 'no access',
  }));
  const info = vi.spyOn(logger, 'info');

  await import('../index.js');
  await flush();

  infoLines = info.mock.calls.map((c) => String(c[0]));
});

describe('server start', () => {
  it('no longer runs the account-flag backfill: no processor lookup, no org written, no backfill log line', () => {
    expect(mockRetrieveAccount).not.toHaveBeenCalled();
    expect(mockPrisma.organization.update).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(infoLines.some((l) => /stripe backfill/i.test(l))).toBe(false);
  });

  it('schedules a nightly job that refreshes each org with an account in its own tenant context, failing closed', async () => {
    for (const job of scheduled) await job.fn();
    await flush();

    expect(mockRetrieveAccount).toHaveBeenCalledWith('acct_bogus');
    // Slice 10: failing closed also takes CARD off the accepted methods (the card capability is not
    // known to be active).
    expect(writes).toEqual([
      {
        orgId: ORG, tenant: { orgId: ORG, unscoped: false },
        data: { stripe_charges_enabled: false, stripe_payouts_enabled: false, accepted_payment_methods: [] },
      },
    ]);
  });
});
