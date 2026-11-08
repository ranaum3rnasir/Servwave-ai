import { Request, Response } from 'express';
import { z } from 'zod';
import { PaymentMethod } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { transitionLeadStatus } from '../services/lead-stage.service';
// Creator tracking (audit only) - stamped at every create, never read for authorization here.
import { CREATED_BY_CLIENT } from '../lib/created-by';
import { constructWebhookEvent, retrieveAccount, getStripeForOrg, computeServiceFee, CARD_SERVICE_FEE_BPS } from '../lib/stripe';
import { logger } from '../lib/logger';
import { env } from '../config/env';
import { sendDepositPaymentConfirmation, sendDepositPaidAlert, sendPaymentReceivedEmail, sendEstimateApprovedNotification, sendPaymentsActionNeededEmail } from '../lib/email';
import { systemVoidPaymentForChargeback, depositHoldReason } from './invoice.controller';
import { emit } from '../services/notifications/notificationService';
import { dispatchAutomationEvent } from '../services/automations/dispatch';
import { logAudit } from '../lib/audit';
import { captureStripeFees } from '../lib/reconcile-stripe-fees';
import { loadOptionSummary, optionSummaryData } from '../lib/estimates/optionSummary';

// Local currency formatter — mirrors the inline Intl call already used further
// down in this file (est.total_amount). Kept local rather than importing
// email.ts's private helper: it's a one-line pure format, and email.ts is
// wholesale-mocked in controller tests, so importing it would mean also
// updating that global mock for an unrelated reason.
function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

const uuidSchema = z.string().uuid();

/**
 * Pull a UUID-typed entity id out of Stripe metadata. Returns null when
 * absent or malformed — callers must short-circuit on null and NOT use
 * the value for a DB lookup. Defense-in-depth against malformed/crafted
 * metadata; the per-org tenant model is the primary safeguard.
 */
function readUuidMetadata(metadata: unknown, key: 'invoiceId'): string | null {
  const value = (metadata as Record<string, unknown> | undefined)?.[key];
  if (typeof value !== 'string') return null;
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) {
    logger.warn(`Webhook: invalid UUID for metadata.${key}: ${value.slice(0, 40)}`);
    return null;
  }
  return parsed.data;
}

/**
 * MULTI-TENANT NOTE (2026-05-13):
 * Stripe webhook handlers do NOT currently validate that metadata.invoiceId,
 * etc., belong to the org resolved by resolveOrgFromEvent().
 * For Lakeside launch this is acceptable because Lakeside has no Stripe (CARD not in
 * accepted_payment_methods, gate below short-circuits). Alpha continues to use
 * Stripe in prod — the gap is theoretical (would require crafting a malicious
 * checkout with someone else's invoice ID in metadata). Fix scheduled for
 * §5.7 / post-launch.
 */

class DuplicateWebhookError extends Error {
  constructor() {
    super('Webhook event already processed (concurrent duplicate)');
    this.name = 'DuplicateWebhookError';
  }
}

// Resolves which Organization owns a given Stripe event.
// Priority: event.account (9C2 Connect path) → invoiceId metadata → payment_intent lookup.
// Returns accepted_payment_methods so handleStripeWebhook can short-circuit on
// orgs that don't accept CARD (§4.5 — replaces the old payment_provider gate).
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

/**
 * Account-lifecycle handler (Task 1.6) — account.updated / account.application.deauthorized.
 * Called BEFORE the §4.5 accepted-payment-methods gate (see processStripeEvent) so a
 * mid-onboarding org (which does not yet accept CARD) still gets its capability flags
 * synced instead of being silently swallowed.
 */
async function handleAccountLifecycle(
  event: { id: string; type: string; account?: string; data: { object: any } },
  res: Response,
): Promise<void> {
  const accountId = event.account;
  if (!accountId) { await recordStripeEvent(event); res.json({ received: true }); return; }
  const org = await prisma.organization.findFirst({
    where: { stripe_account_id: accountId },
    select: { id: true, accepted_payment_methods: true, stripe_charges_enabled: true, stripe_payouts_enabled: true, name: true },
  });
  if (!org) { logger.warn(`account lifecycle for unknown account ${accountId}`); await recordStripeEvent(event); res.json({ received: true }); return; }

  // Idempotency: replayed event id is a no-op.
  const dup = await prisma.stripeEvent.findUnique({ where: { stripe_event_id: event.id } });
  if (dup) { res.json({ received: true, replay: true }); return; }

  if (event.type === 'account.application.deauthorized') {
    await prisma.organization.update({
      where: { id: org.id },
      data: { stripe_charges_enabled: false, stripe_payouts_enabled: false, stripe_details_submitted: false,
               stripe_requirements_due: [], stripe_disabled_reason: 'deauthorized' },
    });
    await recordStripeEvent(event);
    res.json({ received: true });
    return;
  }

  // account.updated — FETCH-ON-EVENT: trust live truth, not the (unordered) payload.
  const acct = await retrieveAccount(accountId);
  const chargesEnabled = !!acct.charges_enabled;
  const payoutsEnabled = !!acct.payouts_enabled;
  const requirementsDue = acct.requirements?.currently_due ?? [];

  const wasCharges = org.stripe_charges_enabled;
  const wasPayouts = org.stripe_payouts_enabled;

  const methods = Array.isArray(org.accepted_payment_methods) ? (org.accepted_payment_methods as string[]) : [];
  const addCard = chargesEnabled && !methods.includes('CARD');

  await prisma.organization.update({
    where: { id: org.id },
    data: {
      stripe_charges_enabled: chargesEnabled,
      stripe_payouts_enabled: payoutsEnabled,
      stripe_details_submitted: !!acct.details_submitted,
      stripe_requirements_due: requirementsDue,
      stripe_disabled_reason: acct.requirements?.disabled_reason ?? null,
      ...(addCard ? { accepted_payment_methods: [...methods, 'CARD'] } : {}),
    },
  });
  await recordStripeEvent(event);

  // Fire flag-transition notifications (dedup per account+verb+requirements-hash).
  // .catch()-guarded like every other notification/email dispatch in this file (:550 et al) —
  // the org update + recordStripeEvent above have already committed by this point, and the
  // outer duplicate check (:230) would swallow any Stripe retry of this same event, so an
  // unguarded emit() failure here would both 500 an otherwise-successful sync back to Stripe
  // AND permanently drop the notification with no retry path.
  const reqHash = requirementsDue.slice().sort().join(',');
  if (chargesEnabled && !wasCharges) {
    await emitPaymentsNotif('billing.payments_activated', org.id, org.name, `activated:${accountId}`)
      .catch((err) => logger.error('Failed to emit billing.payments_activated notification:', err));
  }
  if (payoutsEnabled && !wasPayouts) {
    await emitPaymentsNotif('billing.payouts_activated', org.id, org.name, `payouts:${accountId}`)
      .catch((err) => logger.error('Failed to emit billing.payouts_activated notification:', err));
  }
  if (requirementsDue.length > 0) {
    const dedup = `action:${accountId}:${reqHash}`;
    // Pre-check BEFORE emit() (which would itself insert the row) — see
    // notificationAlreadyExists's doc comment for why this isn't folded into emit().
    const alreadyNotified = await notificationAlreadyExists(org.id, paymentsNotifDedupKey('billing.payments_action_needed', dedup));
    await emitPaymentsNotif('billing.payments_action_needed', org.id, org.name, dedup)
      .catch((err) => logger.error('Failed to emit billing.payments_action_needed notification:', err));
    if (!alreadyNotified) {
      await emailActiveAdminsActionNeeded(org.id, org.name)
        .catch((err) => logger.error('Failed to send payments action-needed email:', err));
    }
  }
  if (acct.requirements?.disabled_reason) {
    const disabledReason = acct.requirements.disabled_reason;
    const dedup = `paused:${accountId}:${disabledReason}`;
    const alreadyNotified = await notificationAlreadyExists(org.id, paymentsNotifDedupKey('billing.payments_paused', dedup));
    await emitPaymentsNotif('billing.payments_paused', org.id, org.name, dedup)
      .catch((err) => logger.error('Failed to emit billing.payments_paused notification:', err));
    if (!alreadyNotified) {
      await emailActiveAdminsActionNeeded(org.id, org.name)
        .catch((err) => logger.error('Failed to send payments action-needed email:', err));
    }
  }
  res.json({ received: true });
}

async function recordStripeEvent(event: { id: string; type: string }): Promise<void> {
  try { await prisma.stripeEvent.create({ data: { stripe_event_id: event.id, event_type: event.type } }); }
  catch (err) { if ((err as { code?: string }).code !== 'P2002') throw err; }
}

function paymentsNotifDedupKey(verb: string, dedup: string): string {
  return `${verb}:${dedup}`;
}

async function emitPaymentsNotif(verb: string, orgId: string, orgName: string | null, dedup: string): Promise<void> {
  await emit({
    verb, organizationId: orgId, actorId: null,
    object: { type: 'ORGANIZATION', id: orgId, label: orgName ?? 'ServWave Payments' },
    entity: {}, dedupKey: paymentsNotifDedupKey(verb, dedup),
  });
}

// Task 1.9 — mirrors emit()'s own dedup_key lookup so the action-needed email can
// be gated on "is this genuinely new" BEFORE calling emitPaymentsNotif (whose
// emit() call would otherwise have already inserted the row by the time we could
// check). Not folded into notificationService.ts: this is the only caller that
// needs to know in advance, and duplicating one findFirst is cheaper than
// widening emit()'s return contract for every call site in the codebase.
async function notificationAlreadyExists(orgId: string, dedupKey: string): Promise<boolean> {
  const existing = await prisma.notification.findFirst({ where: { organization_id: orgId, dedup_key: dedupKey } });
  return !!existing;
}

// Fire-and-forget the co-branded action-needed email (Task 1.9 / §6.6-§6.8) to
// every active ADMIN. Called only when notificationAlreadyExists() says this is
// a genuinely new occurrence — a re-delivered account.updated with the same
// requirements-hash must not re-email.
async function emailActiveAdminsActionNeeded(orgId: string, orgName: string | null): Promise<void> {
  const admins = await prisma.user.findMany({
    where: { organization_id: orgId, role: 'ADMIN', is_active: true },
    select: { email: true },
  });
  const fixUrl = `${env.FRONTEND_URL}/settings/payments`;
  for (const admin of admins) {
    sendPaymentsActionNeededEmail({
      organizationId: orgId,
      to: admin.email,
      orgName: orgName ?? 'your organization',
      fixUrl,
    }).catch(() => {});
  }
}

export async function handleStripeWebhook(req: Request, res: Response) {
  const sig = req.headers['stripe-signature'] as string;
  if (!sig && process.env.NODE_ENV !== 'test') {
    res.status(400).json({ error: 'Missing stripe-signature header' });
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
 * #2031 slice 5 (F1) — a capture this handler will not apply, written down where a person can
 * find it.
 *
 * The three places this codebase records an operationally-important money event, used exactly as
 * the dispute and chargeback branches use them: a timeline entry on the invoice (so it is visible
 * from the record itself), an audit row, and an in-app notification that interrupts an admin.
 *
 * Deliberately NOT swallowed. If this cannot be written the error propagates, the event is not
 * recorded as processed, and the processor's retry gives us another chance — an unrecorded charge
 * with nothing pointing at it is worse than a retry.
 *
 * The copy is staff-facing and names no vendor: this is ServWave's own card payment.
 */
async function recordUnappliedCapture(params: {
  event: { id: string };
  session: { id?: string; payment_intent?: string; amount_total?: unknown };
  invoice: { id: string; invoice_number: string; organization_id: string };
  reason: 'AMOUNT_MISMATCH' | 'DEPOSIT_SUPERSEDED' | 'DEPOSIT_ON_HOLD';
  expectedCents: number;
  chargedCents: unknown;
}): Promise<void> {
  const { event, session, invoice, reason, expectedCents, chargedCents } = params;
  const charged = typeof chargedCents === 'number' ? chargedCents : null;
  const description = reason === 'DEPOSIT_SUPERSEDED'
    ? `Card payment on deposit ${invoice.invoice_number} was not recorded: the estimate changed after this deposit was sent, so the amount paid is no longer the amount owed.`
    : reason === 'DEPOSIT_ON_HOLD'
      ? `Card payment on deposit ${invoice.invoice_number} was not recorded: the estimate was sent back to draft, so this deposit request is on hold until it is sent again.`
      : `Card payment on invoice ${invoice.invoice_number} was not recorded: the amount paid does not match the amount owed.`;

  const metadata = {
    reason,
    expected_cents: expectedCents,
    charged_cents: charged,
    payment_intent: session.payment_intent ?? null,
    checkout_session: session.id ?? null,
    event_id: event.id,
  };

  await prisma.timelineEvent.create({
    data: {
      organization_id: invoice.organization_id,
      entity_type: 'INVOICE',
      entity_id: invoice.id,
      event_type: 'PAYMENT_UNRECORDED',
      description,
      metadata,
    },
  });

  await emit({
    verb: 'billing.payment_unrecorded',
    organizationId: invoice.organization_id,
    actorId: null,
    object: { type: 'INVOICE', id: invoice.id, label: invoice.invoice_number },
    entity: {},
    data: { object_label: invoice.invoice_number },
    // The processor retries; one alert per event, not one per delivery.
    dedupKey: `billing.payment_unrecorded:${event.id}`,
  });

  void logAudit({
    action: 'billing.payment_unrecorded',
    resourceType: 'Invoice',
    resourceId: invoice.id,
    orgId: invoice.organization_id,
    actorId: null,
    metadata: { invoice_number: invoice.invoice_number, ...metadata },
  });
}

/**
 * Post-signature webhook processing — idempotency + org resolution + the event switch.
 * Extracted (no behavior change) so the E2E test door (/api/test/stripe-webhook) can
 * replay Stripe-shaped events through the EXACT money code without ever bypassing the
 * real route's signature verification. The real /api/webhooks/stripe route is unchanged.
 */
export async function processStripeEvent(
  event: { id: string; type: string; account?: string; data: { object: any } },
  res: Response,
) {
  // Idempotency check
  const existingEvent = await prisma.stripeEvent.findUnique({
    where: { stripe_event_id: event.id },
  });
  if (existingEvent) {
    res.json({ received: true, duplicate: true });
    return;
  }

  try {
    // Account-lifecycle events must be handled BEFORE the accepted-payment-methods
    // gate: a mid-onboarding org does not yet accept CARD, so the gate at :174 would
    // swallow account.updated and mark the event processed (idempotency then blocks retry).
    if (event.type === 'account.updated' || event.type === 'account.application.deauthorized') {
      await handleAccountLifecycle(event, res);
      return;
    }

    // §4.5 — accepted_payment_methods gate. Resolve the owning org first; if
    // it doesn't accept CARD (or can't be resolved at all) short-circuit with
    // 200 + record the event so Stripe stops retrying. The DB write here
    // intentionally lives inside the outer try so a real DB failure surfaces
    // as 500 (matching the original unhandled-event behavior).
    const owningOrg = await resolveOrgFromEvent(event);
    if (!owningOrg) {
      logger.warn(`Webhook ignored — unknown owning org for event ${event.id} (${event.type})`);
      await recordStripeEvent(event);
      res.json({ received: true });
      return;
    }
    if (!owningOrg.accepted_payment_methods.includes('CARD')) {
      logger.warn(`Webhook ignored — org ${owningOrg.id} does not accept CARD (accepted_payment_methods=${JSON.stringify(owningOrg.accepted_payment_methods)})`);
      await recordStripeEvent(event);
      res.json({ received: true, ignored: 'org_does_not_accept_card' });
      return;
    }

    // Track whether the event was recorded inside a transaction (happy path).
    // For all other cases (early breaks, unhandled events) we record it below.
    let eventRecorded = false;

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as any;

        // ── Invoice payment path ──────────────────────────────
        const invoiceId = readUuidMetadata(session.metadata, 'invoiceId');
        if (invoiceId) {
          const invoice = await prisma.invoice.findUnique({
            where: { id: invoiceId },
            select: {
              id: true,
              invoice_number: true,
              status: true,
              kind: true,
              amount_due: true,
              total_amount: true,
              organization_id: true,
              // Top-level customer (job-less invoices) with job.customer fallback for legacy rows.
              customer: { select: { id: true, email: true, first_name: true, last_name: true, company_name: true } },
              job: {
                select: {
                  id: true,
                  job_number: true,
                  customer: { select: { id: true, email: true, first_name: true, last_name: true, company_name: true } },
                  // billing.payment_received routes to the customer owner too - same
                  // job -> estimate -> lead chain the recordPayment door reads.
                  estimate: { select: { lead: { select: { commission_owner_id: true } } } },
                },
              },
              // #2031 slice 5 — the org's deposit defaults, so the superseded test below can
              // resolve what the deposit SHOULD be, not merely that the estimate was touched.
              organization: {
                select: {
                  deposit_default_type: true,
                  deposit_default_percentage: true,
                  deposit_default_fixed_amount: true,
                },
              },
              // For a kind=DEPOSIT invoice, paying it also approves the estimate + wins the lead.
              estimate: {
                select: {
                  id: true, lead_id: true, estimate_number: true, total_amount: true, status: true,
                  // #2031 slice 5 — the inputs the deposit figure is calculated from, for the
                  // superseded test below.
                  modified_after_send: true, deposit_type: true, deposit_value: true,
                  creator: { select: { email: true } },
                  organization: { select: { name: true, logo_url: true, brand_color: true } },
                  // SERV10X-61 - direct anchor (R6) so a lead-less estimate whose deposit is paid via
                  // Stripe still emails the customer their deposit confirmation; falls back through
                  // the lead for lead-anchored rows (see the depCust resolution below).
                  customer: { select: { id: true, first_name: true, last_name: true, company_name: true, email: true } },
                  lead: { select: {
                    commission_owner_id: true,
                    // Spec #1751 D6 — the transition writer records `from` on the ledger entry.
                    status: true,
                    customer: { select: { id: true, first_name: true, last_name: true, company_name: true, email: true } },
                  } },
                },
              },
            },
          });

          if (!invoice) {
            logger.warn(`Webhook: invoice ${invoiceId} not found`);
            break;
          }

          // SECURITY (review #6): the invoice MUST belong to the org resolved for this event.
          // resolveOrgFromEvent may resolve the owner via event.account (Connect) independently of
          // metadata.invoiceId — so without this assert a signed event from org A naming org B's
          // invoiceId could mark org B's invoice paid. Defense-in-depth alongside the amount fail-closed.
          if (invoice.organization_id !== owningOrg.id) {
            logger.error(
              `Webhook: invoice ${invoiceId} org ${invoice.organization_id} != owning org ${owningOrg.id}; rejecting cross-org payment`,
            );
            break;
          }

          if (invoice.status !== 'SENT' && invoice.status !== 'PARTIAL') {
            logger.warn(`Webhook: invoice ${invoiceId} not payable (status: ${invoice.status})`);
            break;
          }

          // #2031 slice 5 (F2, last line of defence) — a deposit whose estimate has moved on, or
          // been recalled to draft. The primary guarantee is that this session was expired the
          // moment either happened, so nothing should ever settle here; this catches the case
          // where that external call failed. The figures still agree (amount_due has not been
          // re-priced, and a recall does not touch the document at all), so the cross-check below
          // would wave it through — booking a payment at a figure the business no longer quotes,
          // and, on a recall, winning an estimate that was withdrawn for changes. The superseded
          // half stays amount-aware on purpose: refusing a deposit that is still asking for
          // exactly the right money would cost the customer a charge nothing credits back.
          const holdReason = depositHoldReason(invoice, invoice.organization);
          if (holdReason) {
            await recordUnappliedCapture({
              event,
              session,
              invoice,
              reason: holdReason === 'ESTIMATE_IN_DRAFT' ? 'DEPOSIT_ON_HOLD' : 'DEPOSIT_SUPERSEDED',
              expectedCents: Math.round(Number(invoice.amount_due) * 100),
              chargedCents: session.amount_total,
            });
            break;
          }

          const paymentAmount = Number(invoice.amount_due);
          const amountDueCents = Math.round(paymentAmount * 100);

          // Slice 3 / D8 — the service fee is server-recomputed from amount_due + the platform
          // constant and cross-checked against session metadata; it is never trusted from
          // metadata alone. A checkout with no serviceFeeCents metadata (disabled org, or a
          // pre-feature session) expects no fee at all — byte-identical to today's check.
          const metaServiceFeeCents = session.metadata?.serviceFeeCents
            ? Number(session.metadata.serviceFeeCents)
            : 0;
          let serviceFeeCents = 0;
          if (metaServiceFeeCents > 0) {
            const expectedServiceFeeCents = computeServiceFee(amountDueCents, CARD_SERVICE_FEE_BPS);
            if (metaServiceFeeCents !== expectedServiceFeeCents) {
              logger.error(
                `Webhook: service fee mismatch for invoice ${invoiceId}. Metadata claimed ${metaServiceFeeCents}, expected ${expectedServiceFeeCents}`,
              );
              break;
            }
            serviceFeeCents = expectedServiceFeeCents;
          }

          // Slice 7 / D10 — the tip is a customer-chosen value, so unlike the service fee there
          // is no formula to recompute it from. Trust session metadata as the record of what
          // checkout validated (createPublicCheckout re-validates it server-side before writing
          // it there), and let the amount_total cross-check below catch drift/tampering the same
          // way it does for every other figure.
          const tipCents = session.metadata?.tipCents ? Number(session.metadata.tipCents) : 0;

          // Amount verification — Checkout session must total amount_due + the verified fee + tip.
          const expectedCents = amountDueCents + serviceFeeCents + tipCents;
          const actualCents = session.amount_total;
          // FAIL-CLOSED (F-51): a missing/non-numeric amount_total must reject, never
          // silently fall through to record a full payment.
          if (typeof actualCents !== 'number' || !Number.isFinite(actualCents) || expectedCents !== actualCents) {
            logger.error(
              `Webhook: amount mismatch/absent for invoice ${invoiceId}. Expected ${expectedCents}, got ${String(actualCents)}`,
            );
            // #2031 slice 5 (F1) — the customer's card HAS been charged by now. Declining to write
            // a Payment is right (the figures do not reconcile and guessing is worse), but the
            // event is recorded below, so the processor never re-delivers and this is the only
            // moment anyone will ever hear about the money. A log line is not a record.
            await recordUnappliedCapture({
              event,
              session,
              invoice,
              reason: 'AMOUNT_MISMATCH',
              expectedCents,
              chargedCents: actualCents,
            });
            break;
          }

          // Task 3.3: closure-captured (not returned from $transaction) so it survives past
          // commit for the post-commit fee-capture call below, which is the only thing that
          // reads it.
          let createdPaymentId: string | undefined;

          await prisma.$transaction(async (tx) => {
            // FIRST — atomic idempotency claim; P2002 = concurrent duplicate
            try {
              await tx.stripeEvent.create({
                data: { stripe_event_id: event.id, event_type: event.type },
              });
            } catch (err) {
              if ((err as any).code === 'P2002') throw new DuplicateWebhookError();
              throw err;
            }

            const payment = await tx.payment.create({
              data: {
                invoice_id: invoiceId,
                amount: paymentAmount,
                method: 'CARD',
                paid_at: new Date(),
                collected_by: null,
                stripe_payment_intent_id: session.payment_intent as string,
                // NULL = legacy platform-account payment; a set value = direct charge (Connect).
                // Read by Step 4's refund keying and Phase 3's reconciliation.
                stripe_account_id: event.account ?? null,
                // D1 — never part of Payment.amount or invoice totals; null on every non-card,
                // disabled-org, or pre-feature payment (this webhook is the only writer).
                service_fee_amount: serviceFeeCents > 0 ? serviceFeeCents / 100 : null,
                // D10 — rides on the payment, not Invoice.tip; null when the customer left none.
                tip_amount: tipCents > 0 ? tipCents / 100 : null,
                // Audit: the CUSTOMER paid this themselves through Stripe Checkout. There is no
                // ServWave user behind it - CLIENT is what separates that from "we do not know",
                // which a null created_by_id alone could not say.
                ...CREATED_BY_CLIENT,
              },
            });
            createdPaymentId = payment.id;

            await tx.invoice.update({
              where: { id: invoiceId },
              data: {
                amount_due: 0,
                status: 'PAID',
                paid_at: new Date(),
              },
            });

            await tx.timelineEvent.create({
              data: {
                organization_id: invoice.organization_id,
                entity_type: 'INVOICE',
                entity_id: invoiceId,
                event_type: 'PAYMENT_RECEIVED',
                description: `Card payment of $${paymentAmount.toFixed(2)} received via Stripe`,
                metadata: { payment_id: payment.id, stripe_payment_intent_id: session.payment_intent },
              },
            });

            await tx.timelineEvent.create({
              data: {
                organization_id: invoice.organization_id,
                entity_type: 'INVOICE',
                entity_id: invoiceId,
                event_type: 'INVOICE_PAID',
                description: `Invoice ${invoice.invoice_number} paid in full`,
              },
            });

            // ── kind=DEPOSIT invoice paid via Stripe → approve estimate + win lead ──
            // Ported from the retired metadata.depositId branch: paying the deposit invoice
            // is the public-checkout approval signal for the estimate.
            if (invoice.kind === 'DEPOSIT' && invoice.estimate) {
              const est = invoice.estimate;
              await tx.estimate.update({
                where: { id: est.id },
                data: { status: 'WON', approved_at: new Date() },
              });
              // Spec #1751 D6 — the one status writer. actorId null: a Stripe webhook has no
              // signed-in user, and the ledger says so by naming no actor rather than by
              // borrowing one.
              if (est.lead_id) {
                await transitionLeadStatus(tx, {
                  leadId: est.lead_id,
                  orgId: invoice.organization_id,
                  to: 'WON',
                  from: est.lead!.status,
                  actorId: null,
                  description: 'Lead won — deposit invoice paid by card',
                  metadata: { estimate_id: est.id, estimate_number: est.estimate_number, invoice_id: invoiceId, via: 'stripe_deposit_paid' },
                });
              }
              await tx.timelineEvent.create({
                data: {
                  organization_id: invoice.organization_id,
                  entity_type: 'ESTIMATE',
                  entity_id: est.id,
                  event_type: 'DEPOSIT_PAID',
                  description: `Deposit of $${paymentAmount.toFixed(2)} paid via credit card for estimate ${est.estimate_number}`,
                  metadata: { payment_intent: session.payment_intent, method: 'CARD' },
                },
              });

            }
          });

          // Task 3.3: post-commit fee/net reconciliation — direct-charge Payments only (a
          // legacy platform-account charge carries no application fee to reconcile).
          // Fire-and-forget: a capture failure must never affect the money write that already
          // committed above; captureStripeFees is failure-isolated internally, and the nightly
          // sweep (sweepUncapturedFees) backfills anything missed here.
          if (event.account && createdPaymentId && session.payment_intent) {
            void captureStripeFees(createdPaymentId, String(session.payment_intent), event.account);
          }

          eventRecorded = true;

          // ── Deferred-bank first-payment nudge (Task 1.9 / §6.6, §6.8) ──────────
          // Direct-charge orgs (event.account set) that haven't connected a payout
          // method yet get a one-shot FEED nudge the moment their FIRST CARD payment
          // lands. The running "$X collected" total + 7-day resurface live on the
          // status card (Task 2.3) — this is only the first-payment ping.
          //
          // MUST scope to this connected account's own Direct-Charge payments
          // (stripe_account_id: event.account) — NOT every CARD payment the org has
          // ever recorded. Every real org runs its existing payments through the
          // legacy platform account (stripe_account_id: null) today, so an unscoped
          // count would already sit above 1 the moment an org onboards to Connect,
          // and this "first payment" gate would never pass. Mirrors the write side
          // exactly: the Payment row is stamped `stripe_account_id: event.account ?? null`
          // at creation (above), so filtering by event.account is the precise inverse
          // of that snapshot — not just "any direct charge, on any account this org
          // has ever had" (which `not: null` would allow if the org ever reconnects).
          if (event.account && !owningOrg.stripe_payouts_enabled) {
            const priorCardPayments = await prisma.payment.count({
              where: { invoice: { organization_id: owningOrg.id }, method: 'CARD', voided_at: null, stripe_account_id: event.account },
            });
            if (priorCardPayments === 1) { // the one we just wrote
              await emit({
                verb: 'billing.payouts_pending_first_payment',
                organizationId: owningOrg.id,
                actorId: null,
                object: { type: 'ORGANIZATION', id: owningOrg.id, label: owningOrg.name ?? 'ServWave Payments' },
                entity: {},
                data: { amount: formatCurrency(paymentAmount) },
                dedupKey: `billing.payouts_pending_first_payment:${owningOrg.id}`,
              });
            }
          }

          // Audit (system actor — Stripe webhook, no req.user).
          void logAudit({
            action: 'invoice.paid_via_stripe',
            resourceType: 'Invoice',
            resourceId: invoice.id,
            orgId: invoice.organization_id,
            actorId: null,
            metadata: { invoice_number: invoice.invoice_number, amount: paymentAmount, kind: invoice.kind },
          });

          // ─── Automation Center event — invoice reached PAID via Stripe ────────
          dispatchAutomationEvent({
            type: 'INVOICE_PAID',
            organizationId: invoice.organization_id,
            entity: { type: 'invoice', id: invoiceId, label: invoice.invoice_number },
            actorId: null,
          });

          // A deposit payment is announced by the block below (deposit receipt + signed-PDF
          // approval); it must not ALSO fire the generic "invoice paid" emails further down (#993).
          const isDepositPayment = invoice.kind === 'DEPOSIT' && invoice.estimate != null;

          // Fire-and-forget: deposit-invoice payment also confirms the estimate approval +
          // notifies the creator (ported from the retired metadata.depositId branch).
          if (isDepositPayment) {
            const est = invoice.estimate!;

            // ── Notification hooks (Path C — Stripe webhook) — POST-COMMIT (#271) ──
            // actorId null: no staff actor; dedupKey shared with paths A+B.
            const commissionOwnerId = est.lead?.commission_owner_id ?? null;
            // #2090 - the add-ons the customer chose and turned down, named as the document names
            // them, so this path's notification and email say the same as the other three.
            const optionSummary = await loadOptionSummary(est.id);
            await emit({
              verb: 'estimate.deposit_paid',
              organizationId: invoice.organization_id,
              actorId: null,
              object: { type: 'ESTIMATE', id: est.id, label: est.estimate_number },
              entity: { commission_owner_id: commissionOwnerId },
              data: { object_label: est.estimate_number, lead_id: est.lead_id },
              dedupKey: `estimate.deposit_paid:${est.id}`,
            });
            await emit({
              verb: 'estimate.approved',
              organizationId: invoice.organization_id,
              actorId: null,
              object: { type: 'ESTIMATE', id: est.id, label: est.estimate_number },
              entity: { commission_owner_id: commissionOwnerId },
              data: { object_label: est.estimate_number, lead_id: est.lead_id, ...optionSummaryData(optionSummary) },
              dedupKey: `estimate.approved:${est.id}`,
            });
            // Automation Center — path C; dedupe collapses with paths A+B.
            dispatchAutomationEvent({
              type: 'ESTIMATE_APPROVED',
              organizationId: invoice.organization_id,
              entity: { type: 'estimate', id: est.id, label: est.estimate_number },
              actorId: null,
            });

            void logAudit({
              action: 'estimate.deposit_paid',
              resourceType: 'Estimate',
              resourceId: est.id,
              orgId: invoice.organization_id,
              actorId: null,
              metadata: { estimate_number: est.estimate_number, via: 'stripe' },
            });
            void logAudit({
              action: 'estimate.approved',
              resourceType: 'Estimate',
              resourceId: est.id,
              orgId: invoice.organization_id,
              actorId: null,
              metadata: { estimate_number: est.estimate_number, via: 'stripe_deposit' },
            });

            const depCust = est.lead?.customer ?? est.customer;
            const depCustName = [depCust?.first_name, depCust?.last_name].filter(Boolean).join(' ') || depCust?.company_name || 'Customer';
            if (depCust?.email) {
              sendDepositPaymentConfirmation({
                organizationId: invoice.organization_id,
                to: depCust.email,
                customerName: depCustName,
                estimateNumber: est.estimate_number,
                depositAmount: paymentAmount,
                totalCharged: paymentAmount,
                paymentMethod: 'Credit Card',
                transactionId: session.payment_intent,
                companyName: est.organization?.name ?? 'ServWave',
                // Attach-by-origin: deposit payment predates any job — customer/lead only.
                record: {
                  organizationId: invoice.organization_id,
                  customerId: depCust.id,
                  leadId: est.lead_id,
                },
              }).catch(() => {});
            }
            if (est.creator?.email) {
              sendDepositPaidAlert({
                organizationId: invoice.organization_id,
                to: est.creator.email,
                estimateNumber: est.estimate_number,
                customerName: depCustName,
                depositAmount: paymentAmount,
                paymentMethod: 'Credit Card',
              }).catch(() => {});
            }
            if (est.organization && depCust?.email) {
              sendEstimateApprovedNotification({
                estimateId: est.id,
                org: { id: invoice.organization_id, name: est.organization.name, logo_url: est.organization.logo_url, brand_color: est.organization.brand_color },
                to: depCust.email,
                customerName: depCustName,
                estimateNumber: est.estimate_number,
                total: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(est.total_amount)),
                // #2090 - the same two lists the notification names.
                options: optionSummary,
                record: {
                  organizationId: invoice.organization_id,
                  customerId: depCust.id,
                  leadId: est.lead_id,
                },
              }).catch((err) => logger.error('Failed to send approval notification after CARD deposit payment:', err));
            }
          }

          // Fire-and-forget emails — resolve customer directly, falling back to job.customer.
          // Skipped for a deposit payment: it already got its own emails above (#993).
          // Only sendPaymentReceivedEmail is sent here — this webhook always pays the invoice
          // off in full (amount_due is fail-closed-verified against the Checkout total before
          // the transaction above runs), so a separate "Invoice Paid in Full" email only
          // repeated what sendPaymentReceivedEmail already renders whenever newBalance <= 0.
          const c = invoice.customer ?? invoice.job?.customer;
          const customerName = [c?.first_name, c?.last_name].filter(Boolean).join(' ') || c?.company_name || 'Customer';
          if (c?.email && !isDepositPayment) {
            const paymentRecord = {
              organizationId: invoice.organization_id,
              customerId: c.id,
              jobId: invoice.job?.id,
              jobLabel: invoice.job?.job_number,
              entityType: 'invoice',
              entityId: invoice.id,
            };
            sendPaymentReceivedEmail({
              organizationId: invoice.organization_id,
              to: c.email,
              customerName,
              invoiceNumber: invoice.invoice_number,
              amount: paymentAmount,
              method: 'CARD',
              newBalance: 0,
              record: paymentRecord,
            }).catch(err => logger.error('Webhook email error:', err));
          }

          // ── In-app notification: billing.payment_received - POST-COMMIT ──
          // This door had no emit at all: its only internal signal was the
          // "[Internal] Payment received" alert email, which was addressed to
          // EMAIL_FROM (the app's own no-reply sender) and suppressed by Resend
          // every time, so a card payment notified nobody. actorId null - Stripe
          // has no staff actor, and a null actor drops no one from the recipients.
          // Always payment_received, never partial_payment: this branch only runs
          // after amount_total is fail-closed-verified against the full amount_due.
          await emit({
            verb: 'billing.payment_received',
            organizationId: invoice.organization_id,
            actorId: null,
            object: { type: 'INVOICE', id: invoice.id, label: invoice.invoice_number },
            entity: { customer_owner_id: invoice.job?.estimate?.lead?.commission_owner_id ?? null },
            data: { object_label: invoice.invoice_number, amount: paymentAmount },
            // Stripe-retry safety, keyed on the payment intent rather than the
            // invoice: two genuine checkouts against one invoice are two payments
            // and must notify twice.
            dedupKey: `billing.payment_received:${session.payment_intent}`,
          });

          break;
        }

        // No invoiceId metadata — nothing to do for this checkout session.
        break;
      }
      case 'charge.refunded': {
        const charge = event.data.object as any;
        const paymentIntentId = charge.payment_intent as string;
        const refundedCents = charge.amount_refunded as number;
        const latestRefund = charge.refunds?.data?.[0];
        const isInAppRefund = latestRefund?.metadata?.source === 'in_app';

        if (isInAppRefund) {
          // In-app refund — state already updated by the HTTP refund handler; record event only
          logger.info(`charge.refunded for in-app refund ${latestRefund?.id}; recording event only`);
          await recordStripeEvent(event);
          eventRecorded = true;
          break;
        }

        // Dashboard-initiated — try invoice path first
        const payment = await prisma.payment.findFirst({
          where: { stripe_payment_intent_id: paymentIntentId },
          include: { invoice: { include: { organization: true } } },
        });

        if (payment) {
          // Slice 6/7 — a dashboard refund's cents include the customer's service fee and tip, so
          // the raw figure is not the face value refunded against the invoice. Strip both out by
          // the same fraction the face amount represents of the original charge (immutable once
          // webhook-written), so a full dashboard refund of the whole charge reduces to exactly
          // the face amount and a partial one reduces proportionally. Byte-identical to today when
          // the payment carries neither (fraction is 1).
          const feeAmount = Number(payment.service_fee_amount ?? 0);
          const tipAmount = Number(payment.tip_amount ?? 0);
          const faceAmount = Number(payment.amount);
          const originalTotal = faceAmount + feeAmount + tipAmount;
          const faceFraction = originalTotal > 0 ? faceAmount / originalTotal : 1;
          const refundedAmount = Math.round((refundedCents / 100) * faceFraction * 100) / 100;

          // Idempotency on stripe_refund_id: if an in-app Refund already persisted this id,
          // the money + invoice state are already correct — record the event only, never double-record.
          if (latestRefund?.id) {
            const existingRefund = await prisma.refund.findFirst({
              where: { stripe_refund_id: latestRefund.id },
              select: { id: true },
            });
            if (existingRefund) {
              logger.info(`charge.refunded for already-recorded refund ${latestRefund.id}; recording event only`);
              await recordStripeEvent(event);
              eventRecorded = true;
              break;
            }
          }

          // Task 3.2 (fee reversal, door 2 — dashboard refund): this refund bypassed createRefund
          // entirely (initiated on Stripe's own dashboard), so refund_application_fee never
          // applied — reverse ServWave's platform fee here instead, proportionally. Direct charges
          // only (event.account set) — a legacy platform-account charge never had a fee to reverse.
          // Platform-side call: NO stripeAccount header (application fees live on the platform
          // account, not the connected account). Money-first, like the in-app refund path above:
          // if this throws, stripeEvent.create (below) never commits, so Stripe's own webhook
          // retry re-attempts cleanly rather than silently losing the reversal.
          if (event.account) {
            const { stripe } = getStripeForOrg(payment.invoice.organization);
            const fees = await stripe.applicationFees.list({ charge: charge.id, limit: 1 });
            const appFee = fees.data[0];
            if (appFee && appFee.amount_refunded < appFee.amount) {
              // charge.amount_refunded is Stripe's CUMULATIVE refunded total on the charge, so
              // "fee * portion" is an ABSOLUTE target, not this event's increment. Reversing the
              // full target on every event would re-reverse whatever a prior dashboard refund on
              // this same charge already took (and can push the running total past the fee's
              // unrefunded amount, which createRefund rejects — see incrementalReversal clamp).
              // Reverse only what's newly owed: target minus what's already been reversed,
              // clamped to [0, remaining unrefunded fee] so a rounding edge or duplicate
              // delivery can never push it negative or over the cap.
              const refundedPortion = charge.amount_refunded / charge.amount; // cumulative proportion
              const targetReversed = Math.round(appFee.amount * refundedPortion);
              const remainingFee = appFee.amount - appFee.amount_refunded;
              const incrementalReversal = Math.min(Math.max(targetReversed - appFee.amount_refunded, 0), remainingFee);
              if (incrementalReversal > 0) {
                await stripe.applicationFees.createRefund(appFee.id, { amount: incrementalReversal });
              }
            }
          }

          // Read the running refunded total so total_refunded is an INCREMENT, not an assignment.
          const priorAgg = await prisma.refund.aggregate({
            where: { invoice_id: payment.invoice_id },
            _sum: { amount: true },
          });
          const priorRefunded = Number(priorAgg._sum.amount ?? 0);
          const accumulatedRefunded = Math.round((priorRefunded + refundedAmount) * 100) / 100;
          const invoiceTotal = Number(payment.invoice.total_amount ?? 0);
          const fullyRefunded = invoiceTotal > 0
            ? accumulatedRefunded >= invoiceTotal - 0.0001
            : accumulatedRefunded >= Number(payment.amount) - 0.0001;

          // The Refund row needs a User actor (refunded_by FK). A dashboard refund has no
          // in-app user, so attribute it to the org's first ADMIN as the system actor.
          const systemActor = await prisma.user.findFirst({
            where: { organization_id: payment.invoice.organization_id, role: 'ADMIN' },
            select: { id: true },
          });

          await prisma.$transaction(async (tx) => {
            try {
              await tx.stripeEvent.create({
                data: { stripe_event_id: event.id, event_type: event.type },
              });
            } catch (err) {
              if ((err as any).code === 'P2002') throw new DuplicateWebhookError();
              throw err;
            }
            if (systemActor) {
              await tx.refund.create({
                data: {
                  invoice_id: payment.invoice_id,
                  payment_id: payment.id,
                  amount: refundedAmount,
                  tax_portion: 0,
                  non_taxable_concession: false,
                  method: 'CARD',
                  reason: 'Refunded via Stripe dashboard',
                  reason_category: 'OTHER',
                  stripe_refund_id: latestRefund?.id ?? null,
                  refunded_by: systemActor.id,
                  organization_id: payment.invoice.organization_id,
                },
              });
            }
            await tx.payment.update({
              where: { id: payment.id },
              data: { refunded_at: new Date(), refunded_amount: accumulatedRefunded },
            });
            await tx.invoice.update({
              where: { id: payment.invoice_id },
              data: {
                status: fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
                total_refunded: accumulatedRefunded,
                refunded_at: new Date(),
                refund_reason: 'Refunded via Stripe dashboard',
              },
            });
            await tx.timelineEvent.create({
              data: {
                organization_id: payment.invoice.organization_id,
                entity_type: 'INVOICE',
                entity_id: payment.invoice_id,
                event_type: 'INVOICE_REFUNDED',
                description: `Invoice refunded $${refundedAmount.toFixed(2)} via Stripe dashboard`,
                metadata: { source: 'stripe_dashboard', refund_id: latestRefund?.id },
              },
            });
          });
          eventRecorded = true;
          void logAudit({
            action: 'invoice.refunded_via_stripe',
            resourceType: 'Invoice',
            resourceId: payment.invoice_id,
            orgId: payment.invoice.organization_id,
            actorId: null,
            metadata: { amount: refundedAmount, source: 'stripe_dashboard' },
          });
          break;
        }

        // A kind=DEPOSIT invoice's Payment carries the PI, so the payment branch above already
        // handled deposit refunds (writing a first-class Refund row). No legacy Deposit fallback.
        logger.warn(`charge.refunded for unknown payment_intent ${paymentIntentId}`);
        break;
      }
      // ── Chargebacks / disputes (entity-redesign §8, Phase 2c) ──────────────
      // AUTOMATIC (no permission). Idempotent on stripe_dispute_id. A dispute object carries
      // `payment_intent` (always present for card disputes), so resolveOrgFromEvent already
      // resolved the owning org via PI→Payment→invoice.organization above.
      case 'charge.dispute.created': {
        const dispute = event.data.object as any;
        const disputeId = dispute.id as string;
        const disputePi = dispute.payment_intent as string | undefined;

        const payment = disputePi
          ? await prisma.payment.findFirst({
              where: { stripe_payment_intent_id: disputePi },
              include: { invoice: { select: { id: true, status: true, organization_id: true, invoice_number: true, stripe_dispute_id: true } } },
            })
          : null;

        if (!payment) {
          logger.warn(`charge.dispute.created — no Payment for payment_intent ${disputePi}; recording event only`);
          break; // falls through to the bottom stripeEvent.create
        }

        // Idempotency on stripe_dispute_id: a replayed created event for the same dispute is a no-op.
        if (payment.invoice.stripe_dispute_id === disputeId) {
          logger.info(`charge.dispute.created replay for ${disputeId}; recording event only`);
          break;
        }

        await prisma.$transaction(async (tx) => {
          try {
            await tx.stripeEvent.create({
              data: { stripe_event_id: event.id, event_type: event.type },
            });
          } catch (err) {
            if ((err as any).code === 'P2002') throw new DuplicateWebhookError();
            throw err;
          }

          // Flag DISPUTED + store the dispute id. NO reversal — the dispute may still be won.
          await tx.invoice.update({
            where: { id: payment.invoice.id },
            data: { status: 'DISPUTED', stripe_dispute_id: disputeId },
          });

          await tx.timelineEvent.create({
            data: {
              organization_id: payment.invoice.organization_id,
              entity_type: 'INVOICE',
              entity_id: payment.invoice.id,
              event_type: 'INVOICE_DISPUTED',
              description: `Card payment disputed on invoice ${payment.invoice.invoice_number} (chargeback opened)`,
              metadata: { stripe_dispute_id: disputeId, payment_intent: disputePi },
            },
          });
        });

        // In-app notification: billing.disputed (webhook → actorId null; Stripe-retry dedupKey required)
        await emit({
          verb: 'billing.disputed',
          organizationId: payment.invoice.organization_id,
          actorId: null,
          object: { type: 'INVOICE', id: payment.invoice.id, label: payment.invoice.invoice_number },
          entity: {},
          data: { object_label: payment.invoice.invoice_number },
          dedupKey: `billing.disputed:${disputeId}`,
        });

        void logAudit({
          action: 'billing.dispute_opened',
          resourceType: 'Invoice',
          resourceId: payment.invoice.id,
          orgId: payment.invoice.organization_id,
          actorId: null,
          metadata: { invoice_number: payment.invoice.invoice_number, stripe_dispute_id: disputeId },
        });

        eventRecorded = true;
        break;
      }
      case 'charge.dispute.closed': {
        const dispute = event.data.object as any;
        const disputeId = dispute.id as string;
        const disputeStatus = dispute.status as string; // 'won' | 'lost' | 'warning_closed' | ...
        const disputePi = dispute.payment_intent as string | undefined;

        // Anchor on the dispute id first (idempotency anchor); fall back to PI→payment→invoice.
        let invoice = await prisma.invoice.findFirst({
          where: { stripe_dispute_id: disputeId },
          select: { id: true, status: true, organization_id: true, invoice_number: true, total_amount: true, amount_due: true, kind: true },
        });
        if (!invoice && disputePi) {
          const byPi = await prisma.payment.findFirst({
            where: { stripe_payment_intent_id: disputePi },
            include: { invoice: { select: { id: true, status: true, organization_id: true, invoice_number: true, total_amount: true, amount_due: true, kind: true } } },
          });
          invoice = byPi?.invoice ?? null;
        }

        if (!invoice) {
          logger.warn(`charge.dispute.closed — no invoice for dispute ${disputeId}; recording event only`);
          break;
        }

        if (disputeStatus === 'won') {
          // Idempotency: only act while still DISPUTED.
          if (invoice.status !== 'DISPUTED') {
            logger.info(`charge.dispute.closed(won) replay for ${disputeId}; recording event only`);
            break;
          }
          const invWon = invoice;
          await prisma.$transaction(async (tx) => {
            try {
              await tx.stripeEvent.create({ data: { stripe_event_id: event.id, event_type: event.type } });
            } catch (err) {
              if ((err as any).code === 'P2002') throw new DuplicateWebhookError();
              throw err;
            }
            // Clear the flag, restore PAID. No money moved.
            await tx.invoice.update({
              where: { id: invWon.id },
              data: { status: 'PAID', stripe_dispute_id: null },
            });
            await tx.timelineEvent.create({
              data: {
                organization_id: invWon.organization_id,
                entity_type: 'INVOICE',
                entity_id: invWon.id,
                event_type: 'INVOICE_DISPUTE_WON',
                description: `Dispute won on invoice ${invWon.invoice_number}; restored to PAID`,
                metadata: { stripe_dispute_id: disputeId },
              },
            });
          });
          eventRecorded = true;
          void logAudit({
            action: 'billing.dispute_closed',
            resourceType: 'Invoice',
            resourceId: invWon.id,
            orgId: invWon.organization_id,
            actorId: null,
            metadata: { invoice_number: invWon.invoice_number, stripe_dispute_id: disputeId, outcome: 'won' },
          });
          break;
        }

        if (disputeStatus === 'lost') {
          // Re-find the disputed CARD Payment by PI (the row systemVoid will void).
          const disputedPayment = disputePi
            ? await prisma.payment.findFirst({ where: { stripe_payment_intent_id: disputePi } })
            : null;
          if (!disputedPayment) {
            logger.warn(`charge.dispute.closed(lost) — no Payment for ${disputePi}; recording event only`);
            break;
          }
          // Idempotency: already charged-back → no-op.
          if (disputedPayment.void_category === 'CHARGEBACK' || disputedPayment.voided_at) {
            logger.info(`charge.dispute.closed(lost) replay for ${disputeId}; recording event only`);
            break;
          }

          // Task 3.2 (fee reversal, door 3 — dispute LOST only; NOT created, NOT won). The
          // ENTIRE disputed charge is being clawed back (systemVoidPaymentForChargeback voids
          // the full Payment below), so reverse whatever fee remains IN FULL — not proportional
          // like a partial dashboard refund. Direct charges only; platform-side call, no
          // stripeAccount header (mirrors the dashboard-refund door). Money-first, same reasoning
          // as door 2: runs before stripeEvent.create commits so a failure here is naturally
          // retried by Stripe's own webhook redelivery.
          if (disputedPayment.stripe_account_id) {
            const disputeChargeId = dispute.charge as string | undefined;
            if (disputeChargeId) {
              const { stripe } = getStripeForOrg(disputedPayment);
              const fees = await stripe.applicationFees.list({ charge: disputeChargeId, limit: 1 });
              const appFee = fees.data[0];
              if (appFee && appFee.amount_refunded < appFee.amount) {
                await stripe.applicationFees.createRefund(appFee.id, { amount: appFee.amount - appFee.amount_refunded });
              }
            }
          }

          const invLost = invoice;
          await prisma.$transaction(async (tx) => {
            try {
              await tx.stripeEvent.create({ data: { stripe_event_id: event.id, event_type: event.type } });
            } catch (err) {
              if ((err as any).code === 'P2002') throw new DuplicateWebhookError();
              throw err;
            }
            // Route the one involuntary money-back through the internal system void-payment (CHARGEBACK).
            await systemVoidPaymentForChargeback(tx, {
              payment: {
                id: disputedPayment.id,
                amount: disputedPayment.amount,
                method: disputedPayment.method,
                stripe_payment_intent_id: disputedPayment.stripe_payment_intent_id,
              },
              invoice: {
                id: invLost.id,
                amount_due: invLost.amount_due,
                total_amount: invLost.total_amount,
                status: invLost.status,
                kind: invLost.kind,
                invoice_number: invLost.invoice_number,
              },
              disputeId,
              orgId: invLost.organization_id,
            });
          });

          // In-app notification: billing.chargeback (webhook → actorId null; Stripe-retry dedupKey required)
          await emit({
            verb: 'billing.chargeback',
            organizationId: invLost.organization_id,
            actorId: null,
            object: { type: 'INVOICE', id: invLost.id, label: invLost.invoice_number },
            entity: {},
            data: { object_label: invLost.invoice_number },
            dedupKey: `billing.chargeback:${disputeId}`,
          });

          void logAudit({
            action: 'billing.dispute_closed',
            resourceType: 'Invoice',
            resourceId: invLost.id,
            orgId: invLost.organization_id,
            actorId: null,
            metadata: { invoice_number: invLost.invoice_number, stripe_dispute_id: disputeId, outcome: 'lost' },
          });

          eventRecorded = true;
          break;
        }

        // Any other terminal status (e.g. warning_closed) — record the event only, no state change.
        logger.info(`charge.dispute.closed with status ${disputeStatus} for ${disputeId}; recording event only`);
        break;
      }
      default:
        logger.info(`Unhandled webhook event: ${event.type}`);
    }

    // For all non-happy-path cases (early breaks, unhandled events), record
    // the event now so Stripe does not re-deliver them indefinitely.
    if (!eventRecorded) {
      await recordStripeEvent(event);
    }

    res.json({ received: true });
  } catch (err) {
    if (err instanceof DuplicateWebhookError) {
      res.json({ received: true, duplicate: true });
      return;
    }
    logger.error('Webhook processing error:', err);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
}
