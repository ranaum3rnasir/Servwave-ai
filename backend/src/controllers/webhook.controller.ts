import { Request, Response } from 'express';
import { PaymentMethod } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { constructWebhookEvent } from '../lib/stripe';
import { logger } from '../lib/logger';
import { acknowledge, reconcile, type ProcessorEvent } from '../services/payment-reconciler';


/**
 * The processor's webhook, kept thin (payments go-live slice 10): verify the signature, resolve the
 * org that owns the event, hand the event to the payment event reconciler. Every rule about what an
 * event does lives in services/payment-reconciler.
 *
 * TENANCY: the owning org is resolved from the connected account the event arrived on. The
 * reconciler checks that every invoice an event touches belongs to that org; an event for an
 * account ServWave does not know is not ours and is only recorded (the one sandbox serves several
 * environments).
 */

// Resolves which Organization owns a given Stripe event.
// Priority: event.account (9C2 Connect path) → invoiceId metadata → payment_intent lookup.
export async function resolveOrgFromEvent(
  event: { id: string; type: string; account?: string; data: { object: any } },
): Promise<{ id: string; stripe_account_id: string | null; accepted_payment_methods: PaymentMethod[]; stripe_payouts_enabled: boolean; name: string | null } | null> {
  // stripe_payouts_enabled + name (Task 1.9): needed by the checkout.session.completed
  // CARD branch's deferred-bank first-payment nudge — added here rather than a second
  // query since all 3 resolution paths below already select through this one constant.
  const orgSelect = { id: true, stripe_account_id: true, accepted_payment_methods: true, stripe_payouts_enabled: true, name: true } as const;
  const toOrg = (o: { id: string; stripe_account_id: string | null; accepted_payment_methods: unknown; stripe_payouts_enabled?: boolean; name?: string | null }) => ({
    id: o.id,
    stripe_account_id: o.stripe_account_id,
    accepted_payment_methods: Array.isArray(o.accepted_payment_methods)
      ? (o.accepted_payment_methods as PaymentMethod[])
      : [],
    stripe_payouts_enabled: o.stripe_payouts_enabled ?? false,
    name: o.name ?? null,
  });

  // 9C2 path — Connect Direct charges populate event.account
  const accountId = event.account;
  if (accountId) {
    const found = await prisma.organization.findFirst({
      where: { stripe_account_id: accountId },
      select: orgSelect,
    });
    if (found) return toOrg(found);
    logger.warn(`Webhook for unknown connected account ${accountId}`);
    return null;
  }

  const obj = event.data?.object as any;
  const invoiceId = obj?.metadata?.invoiceId;
  const paymentIntentId = obj?.payment_intent;

  // The deposit checkout now carries metadata.invoiceId (the kind=DEPOSIT Invoice), so the
  // invoiceId branch resolves it. Its Payment carries the PI, so the payment branch resolves it.
  if (invoiceId) {
    const inv = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { organization: { select: orgSelect } },
    });
    return inv?.organization ? toOrg(inv.organization) : null;
  }
  if (paymentIntentId) {
    const payment = await prisma.payment.findFirst({
      where: { stripe_payment_intent_id: paymentIntentId },
      select: { invoice: { select: { organization: { select: orgSelect } } } },
    });
    if (payment) return toOrg(payment.invoice.organization);
  }

  return null;
}

export async function handleStripeWebhook(req: Request, res: Response) {
  const sig = req.headers['stripe-signature'] as string;
  if (!sig && process.env.NODE_ENV !== 'test') {
    res.status(400).json({ error: 'Missing signature header' });
    return;
  }

  let event;
  if (process.env.NODE_ENV === 'test') {
    // In test env, parse the body directly (no Stripe signature verification).
    // The webhook route uses express.raw() so req.body arrives as a Buffer.
    // supertest serialises Buffer via JSON ({"type":"Buffer","data":[...]}),
    // so we must reconstruct the original bytes and then parse them.
    const raw = req.body;
    if (typeof raw === 'string') {
      event = JSON.parse(raw);
    } else {
      const intermediate = JSON.parse(raw.toString('utf8'));
      if (intermediate && intermediate.type === 'Buffer' && Array.isArray(intermediate.data)) {
        // Re-hydrate the Buffer from the JSON representation supertest produced
        event = JSON.parse(Buffer.from(intermediate.data).toString('utf8'));
      } else {
        event = intermediate;
      }
    }
  } else {
    try {
      event = constructWebhookEvent(req.body, sig);
    } catch (err: any) {
      logger.error('Webhook signature verification failed');
      res.status(400).json({ error: 'Invalid webhook signature' });
      return;
    }
  }

  await processStripeEvent(event, res);
}

/**
 * Post-signature webhook processing: idempotency, org resolution, then the reconciler.
 * Extracted so the E2E test door (/api/test/stripe-webhook) can replay processor-shaped events
 * through the EXACT money code without ever bypassing the real route's signature verification.
 */
export async function processStripeEvent(event: ProcessorEvent, res: Response) {
  // Idempotency check (the reconciler also claims the event id inside each write).
  const existingEvent = await prisma.stripeEvent.findUnique({
    where: { stripe_event_id: event.id },
  });
  if (existingEvent) {
    res.json({ received: true, duplicate: true });
    return;
  }

  try {
    // An event whose owning org cannot be resolved (an account ServWave does not know) is recorded
    // so the processor stops retrying, and touches nothing. A real DB failure surfaces as 500.
    const owningOrg = await resolveOrgFromEvent(event);
    if (!owningOrg) {
      logger.warn(`Webhook ignored — unknown owning org for event ${event.id} (${event.type})`);
      await acknowledge(event);
      res.json({ received: true });
      return;
    }
    const outcome = await reconcile(event, owningOrg);
    // A dispute on a ServWave checkout whose payment is not booked yet: fail, so the processor
    // delivers it again once the payment exists.
    if (outcome === 'retry') {
      res.status(503).json({ received: false, retry: true });
      return;
    }
    res.json(outcome === 'duplicate' ? { received: true, duplicate: true } : { received: true });
  } catch (err) {
    logger.error('Webhook processing error:', err);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
}
