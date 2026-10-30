import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Stripe from 'stripe';
import { prisma } from '../lib/prisma';
import { retrieveAccount } from '../lib/stripe';
import { env } from '../config/env';
import { refreshAccountStatus } from '../lib/account-status';
import { logger } from '../lib/logger';

const ORG = '00000000-0000-0000-0000-0000000000a1';

const mockPrisma = prisma as unknown as {
  organization: { findUnique: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
  $executeRaw: ReturnType<typeof vi.fn>;
};
const mockRetrieveAccount = vi.mocked(retrieveAccount);
const mutableEnv = env as unknown as { STRIPE_SECRET_KEY?: string };

function accountInvalid(): Error {
  return new Stripe.errors.StripePermissionError({
    type: 'invalid_request_error',
    code: 'account_invalid',
    message: "The provided key does not have access to account 'acct_bogus' (or that account does not exist).",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mutableEnv.STRIPE_SECRET_KEY = 'sk_test_unit';
  mockPrisma.organization.updateMany.mockResolvedValue({ count: 1 });
  // Slice 10: the refresh writes in one transaction, under the org row lock.
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
  mockPrisma.$executeRaw.mockResolvedValue(0);
});
afterEach(() => {
  delete mutableEnv.STRIPE_SECRET_KEY;
});

describe('refreshAccountStatus', () => {
  it('an org pointed at a bogus account id is stored and reported as unable to take cards', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue({
      id: ORG, stripe_account_id: 'acct_bogus', stripe_charges_enabled: true,
    });
    mockRetrieveAccount.mockRejectedValue(accountInvalid());

    const result = await refreshAccountStatus(ORG);

    expect(result).toEqual({ outcome: 'failed_closed', stripe_charges_enabled: false });
    expect(mockRetrieveAccount).toHaveBeenCalledWith('acct_bogus');
    expect(mockPrisma.organization.updateMany).toHaveBeenCalledWith({
      where: { id: ORG, stripe_account_id: 'acct_bogus' },
      data: { stripe_charges_enabled: false, stripe_payouts_enabled: false },
    });
  });

  it('an org without an account is not looked up and not written', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue({
      id: ORG, stripe_account_id: null, stripe_charges_enabled: false,
    });

    const result = await refreshAccountStatus(ORG);

    expect(result).toEqual({ outcome: 'no_account', stripe_charges_enabled: false });
    expect(mockRetrieveAccount).not.toHaveBeenCalled();
    expect(mockPrisma.organization.updateMany).not.toHaveBeenCalled();
  });

  it('a missing account on a sandbox key keeps what is stored and writes nothing', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue({
      id: ORG, stripe_account_id: 'acct_fixture', stripe_charges_enabled: true,
    });
    mockRetrieveAccount.mockRejectedValue(new Stripe.errors.StripeInvalidRequestError({
      type: 'invalid_request_error', code: 'resource_missing', message: "No such account: 'acct_fixture'",
    }));

    const result = await refreshAccountStatus(ORG);

    expect(result).toEqual({ outcome: 'kept_test_mode_missing', stripe_charges_enabled: true });
    expect(mockPrisma.organization.updateMany).not.toHaveBeenCalled();
  });

  it('the same missing account on a live key fails closed', async () => {
    mutableEnv.STRIPE_SECRET_KEY = 'sk_live_unit';
    mockPrisma.organization.findUnique.mockResolvedValue({
      id: ORG, stripe_account_id: 'acct_gone', stripe_charges_enabled: true,
    });
    mockRetrieveAccount.mockRejectedValue(new Stripe.errors.StripeInvalidRequestError({
      type: 'invalid_request_error', code: 'resource_missing', message: "No such account: 'acct_gone'",
    }));

    const result = await refreshAccountStatus(ORG);

    expect(result).toEqual({ outcome: 'failed_closed', stripe_charges_enabled: false });
    expect(mockPrisma.organization.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { stripe_charges_enabled: false, stripe_payouts_enabled: false },
    }));
  });

  it('a processor outage (rate limit) keeps an org that takes cards able to take cards, and writes nothing', async () => {
    mutableEnv.STRIPE_SECRET_KEY = 'sk_live_unit';
    mockPrisma.organization.findUnique.mockResolvedValue({
      id: ORG, stripe_account_id: 'acct_live', stripe_charges_enabled: true,
    });
    mockRetrieveAccount.mockRejectedValue(new Stripe.errors.StripeRateLimitError({
      type: 'invalid_request_error', code: 'rate_limit', message: 'Too many requests', statusCode: 429,
    } as never));

    const result = await refreshAccountStatus(ORG);

    expect(result).toEqual({ outcome: 'kept_platform_error', stripe_charges_enabled: true });
    expect(mockPrisma.organization.updateMany).not.toHaveBeenCalled();
  });

  it('a platform key that fails authentication keeps the stored flags, writes nothing and logs a warning', async () => {
    mutableEnv.STRIPE_SECRET_KEY = 'sk_live_unit';
    mockPrisma.organization.findUnique.mockResolvedValue({
      id: ORG, stripe_account_id: 'acct_live', stripe_charges_enabled: true,
    });
    mockRetrieveAccount.mockRejectedValue(new Stripe.errors.StripeAuthenticationError({
      type: 'invalid_request_error', message: 'Invalid API Key provided', statusCode: 401,
    } as never));

    const result = await refreshAccountStatus(ORG);

    expect(result).toEqual({ outcome: 'kept_platform_error', stripe_charges_enabled: true });
    expect(mockPrisma.organization.updateMany).not.toHaveBeenCalled();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(expect.stringContaining('platform-side error'));
  });

  it('a live account that can take cards is stored as able to take cards', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue({
      id: ORG, stripe_account_id: 'acct_live', stripe_charges_enabled: false, accepted_payment_methods: ['CARD'],
    });
    mockRetrieveAccount.mockResolvedValue({
      id: 'acct_live', charges_enabled: true, payouts_enabled: true, details_submitted: true,
      capabilities: { card_payments: 'active' },
      requirements: { currently_due: [], disabled_reason: null },
    } as unknown as Stripe.Account);

    const result = await refreshAccountStatus(ORG);

    expect(result).toEqual({ outcome: 'refreshed', stripe_charges_enabled: true });
    expect(mockPrisma.organization.updateMany).toHaveBeenCalledWith({
      where: { id: ORG, stripe_account_id: 'acct_live' },
      data: {
        stripe_charges_enabled: true, stripe_payouts_enabled: true, stripe_details_submitted: true,
        stripe_requirements_due: [], stripe_disabled_reason: null,
      },
    });
  });

  // CARD is server-owned: a settings save while "can take cards" was false drops it, and the
  // webhook gate then ignores every money event for the org. When the account comes back able
  // to take cards, the refresh puts CARD back exactly as the account-updated handler does.
  it('when the account can take cards again, CARD is put back on the accepted methods', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue({
      id: ORG, stripe_account_id: 'acct_back', stripe_charges_enabled: false,
      accepted_payment_methods: ['CHECK', 'ZELLE'],
    });
    mockRetrieveAccount.mockResolvedValue({
      id: 'acct_back', charges_enabled: true, payouts_enabled: true, details_submitted: true,
      capabilities: { card_payments: 'active' },
      requirements: { currently_due: [], disabled_reason: null },
    } as unknown as Stripe.Account);

    await refreshAccountStatus(ORG);

    expect(mockPrisma.organization.updateMany).toHaveBeenCalledWith({
      where: { id: ORG, stripe_account_id: 'acct_back' },
      data: expect.objectContaining({
        stripe_charges_enabled: true,
        accepted_payment_methods: ['CHECK', 'ZELLE', 'CARD'],
      }),
    });
  });

  it('an account that still cannot take cards does not get CARD added', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue({
      id: ORG, stripe_account_id: 'acct_pending', stripe_charges_enabled: false,
      accepted_payment_methods: ['CHECK'],
    });
    mockRetrieveAccount.mockResolvedValue({
      id: 'acct_pending', charges_enabled: false, payouts_enabled: false, details_submitted: true,
      requirements: { currently_due: ['external_account'], disabled_reason: null },
    } as unknown as Stripe.Account);

    await refreshAccountStatus(ORG);

    const call = mockPrisma.organization.updateMany.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(call.data).not.toHaveProperty('accepted_payment_methods');
  });

  // Payments go-live slice 19 (conductor decision 2026-10-06): ACH in the accepted methods is the
  // only mirror of the account's bank-debit capability, so the refresh adds it and removes it.
  // The owner's default offer (bank_offered_by_default) is never touched here.
  describe('ACH follows the bank-debit capability', () => {
    function account(ach: string | undefined) {
      return {
        id: 'acct_ach', charges_enabled: true, payouts_enabled: true, details_submitted: true,
        capabilities: ach ? { card_payments: 'active', us_bank_account_ach_payments: ach } : { card_payments: 'active' },
        requirements: { currently_due: [], disabled_reason: null },
      } as unknown as Stripe.Account;
    }
    function writtenData(): Record<string, unknown> {
      return (mockPrisma.organization.updateMany.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    }

    it('an active capability adds ACH after the other methods', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue({
        id: ORG, stripe_account_id: 'acct_ach', stripe_charges_enabled: true, accepted_payment_methods: ['CHECK', 'CARD'],
      });
      mockRetrieveAccount.mockResolvedValue(account('active'));

      await refreshAccountStatus(ORG);

      expect(writtenData().accepted_payment_methods).toEqual(['CHECK', 'CARD', 'ACH']);
      expect(writtenData()).not.toHaveProperty('bank_offered_by_default');
    });

    it.each(['inactive', 'pending', undefined])('a capability that is %s removes ACH', async (state) => {
      mockPrisma.organization.findUnique.mockResolvedValue({
        id: ORG, stripe_account_id: 'acct_ach', stripe_charges_enabled: true, accepted_payment_methods: ['CHECK', 'CARD', 'ACH'],
      });
      mockRetrieveAccount.mockResolvedValue(account(state));

      await refreshAccountStatus(ORG);

      expect(writtenData().accepted_payment_methods).toEqual(['CHECK', 'CARD']);
    });

    // Slice 10: CARD follows the card capability both ways too, so failing closed removes both.
    it('a lookup that fails closed removes ACH and CARD', async () => {
      mutableEnv.STRIPE_SECRET_KEY = 'sk_live_unit';
      mockPrisma.organization.findUnique.mockResolvedValue({
        id: ORG, stripe_account_id: 'acct_ach', stripe_charges_enabled: true, accepted_payment_methods: ['CHECK', 'CARD', 'ACH'],
      });
      mockRetrieveAccount.mockRejectedValue(new Stripe.errors.StripePermissionError({
        type: 'invalid_request_error', code: 'account_invalid', message: 'No access to that account.',
      } as never));

      await refreshAccountStatus(ORG);

      expect(writtenData()).toEqual(expect.objectContaining({ stripe_charges_enabled: false, accepted_payment_methods: ['CHECK'] }));
    });

    it('an unchanged ACH state writes no methods list', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue({
        id: ORG, stripe_account_id: 'acct_ach', stripe_charges_enabled: true, accepted_payment_methods: ['CHECK', 'CARD', 'ACH'],
      });
      mockRetrieveAccount.mockResolvedValue(account('active'));

      await refreshAccountStatus(ORG);

      expect(writtenData()).not.toHaveProperty('accepted_payment_methods');
    });
  });

  // The refresh on the return from onboarding usually lands before the account-updated event,
  // which then sees no change and stays silent. So the refresh owns the "activated" nudges for
  // the flags it turns on (deduped per account, so both paths firing sends one).
  describe('activation notifications', () => {
    function arrangeAdmins() {
      (prisma.user.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 'admin1', role: 'ADMIN', email: 'admin1@acme.test' }]);
      (prisma.notification.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (prisma.notification.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'notif1' });
    }
    function createdVerbs(): string[] {
      return (prisma.notification.create as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => (c[0] as { data: { verb: string } }).data.verb);
    }

    it('cards and payouts turning on send "payments activated" and "payouts activated" to the org', async () => {
      arrangeAdmins();
      mockPrisma.organization.findUnique.mockResolvedValue({
        id: ORG, name: 'Acme Plumbing', stripe_account_id: 'acct_new', stripe_charges_enabled: false,
        stripe_payouts_enabled: false, accepted_payment_methods: [],
      });
      mockRetrieveAccount.mockResolvedValue({
        id: 'acct_new', charges_enabled: true, payouts_enabled: true, details_submitted: true,
        requirements: { currently_due: [], disabled_reason: null },
      } as unknown as Stripe.Account);

      await refreshAccountStatus(ORG);

      expect(prisma.notification.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          organization_id: ORG,
          verb: 'billing.payments_activated',
          dedup_key: 'billing.payments_activated:activated:acct_new',
        }),
      }));
      expect(prisma.notification.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          organization_id: ORG,
          verb: 'billing.payouts_activated',
          dedup_key: 'billing.payouts_activated:payouts:acct_new',
        }),
      }));
    });

    it('flags that were already on send nothing', async () => {
      arrangeAdmins();
      mockPrisma.organization.findUnique.mockResolvedValue({
        id: ORG, name: 'Acme Plumbing', stripe_account_id: 'acct_on', stripe_charges_enabled: true,
        stripe_payouts_enabled: true, accepted_payment_methods: ['CARD'],
      });
      mockRetrieveAccount.mockResolvedValue({
        id: 'acct_on', charges_enabled: true, payouts_enabled: true, details_submitted: true,
        requirements: { currently_due: [], disabled_reason: null },
      } as unknown as Stripe.Account);

      await refreshAccountStatus(ORG);

      expect(createdVerbs()).toEqual([]);
    });

    it('a refresh that fails closed sends nothing', async () => {
      arrangeAdmins();
      mockPrisma.organization.findUnique.mockResolvedValue({
        id: ORG, name: 'Acme Plumbing', stripe_account_id: 'acct_bogus', stripe_charges_enabled: false,
        stripe_payouts_enabled: false, accepted_payment_methods: [],
      });
      mockRetrieveAccount.mockRejectedValue(accountInvalid());

      await refreshAccountStatus(ORG);

      expect(createdVerbs()).toEqual([]);
    });

    it('a refresh that raced a disconnect (no row written) sends nothing', async () => {
      arrangeAdmins();
      mockPrisma.organization.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.organization.findUnique.mockResolvedValue({
        id: ORG, name: 'Acme Plumbing', stripe_account_id: 'acct_gone', stripe_charges_enabled: false,
        stripe_payouts_enabled: false, accepted_payment_methods: [],
      });
      mockRetrieveAccount.mockResolvedValue({
        id: 'acct_gone', charges_enabled: true, payouts_enabled: true, details_submitted: true,
        requirements: { currently_due: [], disabled_reason: null },
      } as unknown as Stripe.Account);

      await refreshAccountStatus(ORG);

      expect(createdVerbs()).toEqual([]);
    });
  });
});
