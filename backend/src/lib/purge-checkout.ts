/**
 * Payments go-live F1: close the payment links of a customer's invoices before a force-purge.
 *
 * Unlike the shared sweep in lib/stripe.ts (open sessions only, used by void / edit / credit), a
 * purge has to know about the sessions of the subtree's invoices that are open OR complete, because
 * one that is already COMPLETE (the customer paid, the payment row may not be written yet) must stop
 * the purge: the money would be taken and the invoice it belongs to deleted. Status is read from the
 * typed `status` field of the session, never from an error message.
 *
 * The work is bounded by the subtree, never by the size of the account's history:
 *   - a session id ServWave stored (a payment or an unapplied capture of the subtree holds it) is
 *     retrieved by id, once;
 *   - a session ServWave never stored is, by construction, one that has not completed into a
 *     payment: it is either OPEN (a live link) or COMPLETE-but-not-yet-recorded. A checkout link
 *     lives at most 24 hours, so those two sets are found by listing only `open` sessions and only
 *     sessions completed in the last 26 hours, matched on `metadata.invoiceId`. An expired session
 *     is dead and is never needed. Nothing lists the account's whole history.
 *
 *   open     -> expire it at the processor (a refusal fails the purge)
 *   expired  -> nothing to do
 *   complete -> fine only when a payment (or an unapplied capture) already records it, else blocked
 */
import { prisma } from './prisma';
import { logger } from './logger';
import { getStripeForOrg, isStripeConfigured, expireCheckoutSession } from './stripe';

export type PurgeLinksOutcome = 'ok' | 'failed' | 'payment_in_flight';

/** Pages of 100: 2,000 sessions OPEN (or newly completed) at once, which a 24-hour link life makes enormous. */
const SESSION_PAGE_LIMIT = 20;
/** A link lives 24 hours; the extra two are clock slack for the "completed recently" window. */
const COMPLETED_WINDOW_SECONDS = 26 * 3600;

export async function closePurgeCheckoutLinks(
  orgId: string,
  invoices: ReadonlyArray<{ id: string }>,
): Promise<PurgeLinksOutcome> {
  if (invoices.length === 0 || !isStripeConfigured()) return 'ok';
  try {
    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { stripe_account_id: true } });
    if (!org) return 'ok';
    const ctx = getStripeForOrg(org);
    const requestOptions = ctx.stripeAccount ? { stripeAccount: ctx.stripeAccount } : undefined;
    const invoiceIds = invoices.map((i) => i.id);
    const ids = new Set(invoiceIds);

    // Sessions ServWave stored for the subtree: recorded by definition (a payment or capture holds them).
    const [payments, captures] = await Promise.all([
      prisma.payment.findMany({
        where: { invoice_id: { in: invoiceIds }, stripe_checkout_session_id: { not: null } },
        select: { stripe_checkout_session_id: true },
      }),
      prisma.unappliedCapture.findMany({
        where: { organization_id: orgId, invoice_id: { in: invoiceIds }, stripe_checkout_session_id: { not: null } },
        select: { stripe_checkout_session_id: true },
      }),
    ]);
    const stored = new Set<string>(
      [...payments, ...captures].map((r) => r.stripe_checkout_session_id).filter((id): id is string => !!id),
    );

    const found = new Map<string, unknown>(); // session id -> typed status
    for (const sessionId of stored) {
      const session = await ctx.stripe.checkout.sessions.retrieve(sessionId, undefined, requestOptions);
      found.set(sessionId, session?.status);
    }

    // Sessions never stored: only those that can still take or have just taken money.
    const completedSince = Math.floor(Date.now() / 1000) - COMPLETED_WINDOW_SECONDS;
    for (const query of [
      { status: 'open' as const },
      { status: 'complete' as const, created: { gte: completedSince } },
    ]) {
      let startingAfter: string | undefined;
      let exhausted = false;
      for (let page = 0; page < SESSION_PAGE_LIMIT; page++) {
        const listed = await ctx.stripe.checkout.sessions.list(
          { ...query, limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) },
          requestOptions,
        );
        const sessions = listed?.data ?? [];
        for (const s of sessions) {
          const invoiceId = s?.metadata?.invoiceId;
          if (invoiceId && ids.has(invoiceId) && !found.has(s.id)) found.set(s.id, s.status);
        }
        if (!listed?.has_more || sessions.length === 0) { exhausted = true; break; }
        startingAfter = sessions[sessions.length - 1].id;
      }
      if (!exhausted) {
        logger.error(`Purge link sweep for org ${orgId} hit the ${SESSION_PAGE_LIMIT}-page bound on ${query.status} sessions; cannot prove the links are closed`);
        return 'failed';
      }
    }

    let inFlight = false;
    for (const [sessionId, status] of found) {
      if (status === 'open') {
        if (!(await expireCheckoutSession(sessionId, ctx))) return 'failed';
      } else if (status === 'expired') {
        continue;
      } else if (status === 'complete') {
        if (!stored.has(sessionId)) inFlight = true;
      } else {
        logger.error(`Purge link sweep: session ${sessionId} has an unreadable status`);
        return 'failed';
      }
    }
    return inFlight ? 'payment_in_flight' : 'ok';
  } catch (err) {
    logger.error(`Purge link sweep failed for org ${orgId}:`, err);
    return 'failed';
  }
}
