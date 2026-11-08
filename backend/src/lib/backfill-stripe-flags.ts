import { prisma } from './prisma';
import { retrieveAccount } from './stripe';
import { logger } from './logger';

/**
 * Deploy-time (NOT lazy) backfill of the §4.1 capability flags for orgs that
 * already carry a stripe_account_id. Public checkout never hits the status
 * endpoint, so a lazy "backfill on first status fetch" would lock CARD out.
 * Unreachable/fake ids (e2e acct_e2e_*) grandfather to charges_enabled=true
 * iff CARD is already accepted. Idempotent; safe to re-run.
 */
export async function backfillStripeFlags(): Promise<{ scanned: number; updated: number }> {
  const orgs = await prisma.organization.findMany({
    where: { stripe_account_id: { not: null } },
    select: { id: true, stripe_account_id: true, accepted_payment_methods: true },
  });
  let updated = 0;
  for (const org of orgs) {
    try {
      const acct = await retrieveAccount(org.stripe_account_id!);
      await prisma.organization.update({
        where: { id: org.id },
        data: {
          stripe_charges_enabled: !!acct.charges_enabled,
          stripe_payouts_enabled: !!acct.payouts_enabled,
          stripe_details_submitted: !!acct.details_submitted,
          stripe_requirements_due: acct.requirements?.currently_due ?? [],
          stripe_disabled_reason: acct.requirements?.disabled_reason ?? null,
        },
      });
      updated++;
    } catch {
      // Unreachable id (e2e fixture / deleted account): grandfather iff CARD already accepted.
      const methods = Array.isArray(org.accepted_payment_methods) ? (org.accepted_payment_methods as string[]) : [];
      if (methods.includes('CARD')) {
        await prisma.organization.update({
          where: { id: org.id },
          data: { stripe_charges_enabled: true, stripe_details_submitted: true },
        });
        updated++;
      } else {
        logger.warn(`[backfill-stripe-flags] unreachable account ${org.stripe_account_id} for org ${org.id}; left disabled`);
      }
    }
  }
  return { scanned: orgs.length, updated };
}
