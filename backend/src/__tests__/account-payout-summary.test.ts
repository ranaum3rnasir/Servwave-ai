/* Payouts slice P2 - the account sync also stores the payout schedule and bank label, from the same account read. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Stripe from 'stripe';
import { prisma } from '../lib/prisma';
import { retrieveAccount } from '../lib/stripe';
import { env } from '../config/env';
import { refreshAccountStatus } from '../lib/account-status';

const ORG = '00000000-0000-0000-0000-0000000000b2';

const mockPrisma = prisma as unknown as {
  organization: { findUnique: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
  $executeRaw: ReturnType<typeof vi.fn>;
};
const mockRetrieveAccount = vi.mocked(retrieveAccount);
const mutableEnv = env as unknown as { STRIPE_SECRET_KEY?: string };

const account = (over: Record<string, unknown> = {}) => ({
  id: 'acct_live', charges_enabled: true, payouts_enabled: true, details_submitted: true,
  capabilities: { card_payments: 'active' },
  requirements: { currently_due: [], disabled_reason: null },
  settings: { payouts: { schedule: { interval: 'weekly', weekly_anchor: 'friday', delay_days: 2 } } },
  external_accounts: { object: 'list', data: [{ object: 'bank_account', bank_name: 'Test Bank', last4: '6789' }] },
  ...over,
}) as unknown as Stripe.Account;

const summaryWrites = () => mockPrisma.organization.updateMany.mock.calls
  .map((c) => c[0] as { where: unknown; data: Record<string, unknown> })
  .filter((c) => 'payout_summary' in c.data);

beforeEach(() => {
  vi.clearAllMocks();
  mutableEnv.STRIPE_SECRET_KEY = 'sk_test_unit';
  mockPrisma.organization.findUnique.mockResolvedValue({
    id: ORG, stripe_account_id: 'acct_live', stripe_charges_enabled: false, accepted_payment_methods: ['CARD'],
  });
  mockPrisma.organization.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
  mockPrisma.$executeRaw.mockResolvedValue(0);
});
afterEach(() => {
  delete mutableEnv.STRIPE_SECRET_KEY;
});

describe('account sync: payout summary', () => {
  it('stores the schedule and the bank label from one account read', async () => {
    mockRetrieveAccount.mockResolvedValue(account());

    await refreshAccountStatus(ORG);

    expect(mockRetrieveAccount).toHaveBeenCalledTimes(1);
    expect(summaryWrites()).toEqual([{
      where: { id: ORG, stripe_account_id: 'acct_live' },
      data: {
        payout_summary: { interval: 'weekly', weekly_anchor: 'friday', delay_days: 2, bank_label: 'Test Bank ••6789' },
        stripe_verification: { business_details: 'verified', owner_identity: 'verified', bank_account: 'verified', tax_id: 'verified' },
      },
    }]);
  });

  it('a read without a bank label stores bank_label null', async () => {
    mockRetrieveAccount.mockResolvedValue(account({ external_accounts: { object: 'list', data: [] } }));

    await refreshAccountStatus(ORG);

    expect(summaryWrites()[0].data.payout_summary).toEqual({ interval: 'weekly', weekly_anchor: 'friday', delay_days: 2, bank_label: null });
  });

  it('a read without any schedule or external accounts still stores a summary of nulls', async () => {
    mockRetrieveAccount.mockResolvedValue(account({ settings: undefined, external_accounts: undefined }));

    await refreshAccountStatus(ORG);

    expect(summaryWrites()[0].data.payout_summary).toEqual({ interval: null, weekly_anchor: null, delay_days: null, bank_label: null });
  });

  it('never carries a vendor word in the bank label', async () => {
    mockRetrieveAccount.mockResolvedValue(account({ external_accounts: { object: 'list', data: [{ bank_name: 'STRIPE TEST BANK', last4: '6789' }] } }));

    await refreshAccountStatus(ORG);

    expect(JSON.stringify(summaryWrites()[0].data.payout_summary)).not.toMatch(/stripe/i);
  });

  it('writes no summary when the account could not be read', async () => {
    mockRetrieveAccount.mockRejectedValue(Object.assign(new Error('gone'), { code: 'account_invalid' }));

    await refreshAccountStatus(ORG);

    expect(summaryWrites()).toEqual([]);
  });
});

describe('account sync: verification rows (V7-02a)', () => {
  it('stores the four rows in the same write as the payout summary', async () => {
    mockRetrieveAccount.mockResolvedValue(account({
      requirements: { currently_due: ['individual.verification.document'], disabled_reason: null },
    }));

    await refreshAccountStatus(ORG);

    const writes = summaryWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0].data.stripe_verification).toEqual({
      business_details: 'verified', owner_identity: 'action_needed', bank_account: 'verified', tax_id: 'verified',
    });
  });

  it('a rejected account stores all four rows as restricted', async () => {
    mockRetrieveAccount.mockResolvedValue(account({
      charges_enabled: false, requirements: { currently_due: [], disabled_reason: 'rejected.fraud' },
    }));

    await refreshAccountStatus(ORG);

    expect(summaryWrites()[0].data.stripe_verification).toEqual({
      business_details: 'restricted', owner_identity: 'restricted', bank_account: 'restricted', tax_id: 'restricted',
    });
  });

  it('a failed-closed refresh leaves the stored rows untouched', async () => {
    mockRetrieveAccount.mockRejectedValue(Object.assign(new Error('gone'), { code: 'account_invalid' }));

    await refreshAccountStatus(ORG);

    const everyWrite = mockPrisma.organization.updateMany.mock.calls.map((c) => c[0] as { data: Record<string, unknown> });
    expect(everyWrite.some((w) => 'stripe_verification' in w.data)).toBe(false);
  });

  it('a kept refresh (platform error) writes nothing at all', async () => {
    mockRetrieveAccount.mockRejectedValue(new Stripe.errors.StripeRateLimitError({
      type: 'invalid_request_error', code: 'rate_limit', message: 'Too many requests', statusCode: 429,
    } as never));

    await refreshAccountStatus(ORG);

    expect(mockPrisma.organization.updateMany).not.toHaveBeenCalled();
  });
});
