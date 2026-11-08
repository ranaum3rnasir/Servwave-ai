import { describe, it, expect, vi, beforeEach } from 'vitest';
import { backfillStripeFlags } from '../lib/backfill-stripe-flags';
import { prisma } from '../lib/prisma';

vi.mock('../lib/stripe', () => ({
  retrieveAccount: vi.fn(),
}));
import { retrieveAccount } from '../lib/stripe';

describe('backfillStripeFlags', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes live flags for a reachable account', async () => {
    vi.spyOn(prisma.organization, 'findMany').mockResolvedValue([
      { id: 'org1', stripe_account_id: 'acct_real', accepted_payment_methods: [] },
    ] as any);
    (retrieveAccount as any).mockResolvedValue({
      charges_enabled: true, payouts_enabled: false, details_submitted: true,
      requirements: { currently_due: ['external_account'], disabled_reason: null },
    });
    const upd = vi.spyOn(prisma.organization, 'update').mockResolvedValue({} as any);
    const res = await backfillStripeFlags();
    expect(res).toEqual({ scanned: 1, updated: 1 });
    expect(upd).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'org1' },
      data: expect.objectContaining({ stripe_charges_enabled: true, stripe_details_submitted: true }),
    }));
  });

  it('grandfathers an unreachable fake id that already has CARD', async () => {
    vi.spyOn(prisma.organization, 'findMany').mockResolvedValue([
      { id: 'e2e1', stripe_account_id: 'acct_e2e_x', accepted_payment_methods: ['CARD'] },
    ] as any);
    (retrieveAccount as any).mockRejectedValue(new Error('No such account'));
    const upd = vi.spyOn(prisma.organization, 'update').mockResolvedValue({} as any);
    await backfillStripeFlags();
    expect(upd).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ stripe_charges_enabled: true }),
    }));
  });
});
