import Stripe from 'stripe';
import { createHash } from 'crypto';
import { env } from '../config/env';
import { logger } from './logger';

export const STRIPE_API_VERSION = '2025-02-24.acacia';

let _stripe: Stripe | null = null;

function _platformStripe(): Stripe {
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error('Stripe is not configured. Set STRIPE_SECRET_KEY in environment.');
  }
  if (!_stripe) {
    _stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION });
  }
  return _stripe;
}

export function getStripeForOrg(org: { stripe_account_id: string | null }): {
  stripe: Stripe;
  stripeAccount?: string;
} {
  return {
    stripe: _platformStripe(),
    stripeAccount: org.stripe_account_id ?? undefined,
  };
}

export function isStripeConfigured(): boolean {
  return !!env.STRIPE_SECRET_KEY;
}

// Prefill EVERYTHING ServWave knows so the contractor confirms, not types (§3.3).
export interface ConnectedAccountPrefill {
  orgId: string;
  email: string | null;
  businessName: string;
  mcc: string;
  url?: string | null;
  supportEmail?: string | null;
  supportPhone?: string | null;                    // from org.phone → business_profile.support_phone
  statementDescriptor?: string | null;
  address?: { line1?: string | null; line2?: string | null; city?: string | null; state?: string | null; postal_code?: string | null } | null;
  brandColorHex?: string | null;                   // org.brand_color → settings.branding.primary_color
  businessType?: 'individual' | 'company' | null;  // caller maps conservatively; null = Stripe collects it
}

// Stripe rejects '' for an optional string param as "an attempt to unset a parameter
// that cannot be unset" — org columns can hold '' (not null) for unset text fields
// (pre-existing rows backfilled before a field was collected), so every optional
// string handed to accounts.create must be normalized through this, not `?? undefined`.
function emptyToUndefined(value?: string | null): string | undefined {
  return value && value.trim() ? value : undefined;
}

export async function createConnectedAccount(input: ConnectedAccountPrefill): Promise<Stripe.Account> {
  const stripe = _platformStripe();
  const addr = input.address
    ? {
        line1: emptyToUndefined(input.address.line1),
        line2: emptyToUndefined(input.address.line2),
        city: emptyToUndefined(input.address.city),
        state: emptyToUndefined(input.address.state),
        postal_code: emptyToUndefined(input.address.postal_code),
        country: 'US',
      }
    : undefined;
  const params: Stripe.AccountCreateParams = {
    country: 'US',
    email: emptyToUndefined(input.email),
    controller: {
      // MUST be 'full' (Standard-equivalent), NOT 'express': Stripe rejects
      // express + losses.payments:'stripe' ("when dashboard=express, your platform must be
      // liable for negative balances/chargebacks"). ServWave's posture is contractor-liable
      // (contractor bears chargebacks, ServWave holds no funds/reserves) → the account must
      // be full/Standard. Embedded onboarding still works with full; contractors operate
      // in-app day-to-day. See md_files/plans/payments/2026-07-22-connect-account-dashboard-decision.md
      stripe_dashboard: { type: 'full' },
      fees: { payer: 'account' },
      losses: { payments: 'stripe' },
      requirement_collection: 'stripe',
    },
    // Without an explicit capability request the account sits at capabilities:{} forever —
    // it can complete every other requirement and still never charge a card or receive a
    // payout, and the embedded onboarding component has no capability-driven flow to show
    // (the "Add information" button renders but never advances past the landing card).
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
    // business_type OMITTED when the caller can't confidently map org.business_type — Stripe then
    // collects it (safer than hardcoding 'company' onto a sole proprietor).
    ...(input.businessType ? { business_type: input.businessType } : {}),
    business_profile: {
      name: input.businessName,
      mcc: input.mcc,
      url: emptyToUndefined(input.url),
      support_email: emptyToUndefined(input.supportEmail),
      support_phone: emptyToUndefined(input.supportPhone),
      ...(addr ? { support_address: addr } : {}),
    },
    // Statement descriptor → CONNECTED account, NO platform prefix (unset ⇒ leaks "ServWave", §3.3).
    // primary_color prefills Stripe-hosted Checkout/emails from org.brand_color.
    // NEVER set receipt_email (here or in createCheckoutSession) — §3.3/§13.5 no-stray-receipt.
    settings: {
      ...(input.statementDescriptor ? { payments: { statement_descriptor: input.statementDescriptor } } : {}),
      ...(input.brandColorHex ? { branding: { primary_color: input.brandColorHex } } : {}),
    },
    metadata: { servwave_org_id: input.orgId },
  };
  // The idempotency key MUST vary with the request params. A static `acct-create:${orgId}` locks to
  // the FIRST attempt's params for ~24h — even a FAILED attempt — so an org whose first onboarding
  // attempt errors (e.g. the empty-phone rejection) and then corrects its data is otherwise blocked
  // from retrying for 24h ("Keys for idempotent requests can only be used with the same parameters").
  // Hashing the params keeps genuine retries idempotent (identical params → same key → Stripe returns
  // the first account, no duplicate) while letting a corrected retry proceed under a fresh key. The
  // race-safe DB claim in connectStripe() is the real duplicate guard. See the 2026-07-22 decision doc.
  const paramsHash = createHash('sha256').update(JSON.stringify(params)).digest('hex').slice(0, 16);
  return stripe.accounts.create(params, { idempotencyKey: `acct-create:${input.orgId}:${paramsHash}` });
}
// NOTE — logo can't be prefilled by URL: settings.branding.logo wants a Stripe File id, so an org
// logo needs a files.create({ purpose: 'business_logo' }) upload first. Defer to a follow-up
// (contractor's own logo upload on Stripe's surface is acceptable at launch; color is the cheap win).

export async function createAccountSession(accountId: string): Promise<string> {
  const stripe = _platformStripe();
  const session = await stripe.accountSessions.create({
    account: accountId,
    components: {
      account_onboarding: { enabled: true },
    },
  });
  return session.client_secret;
}

// NOTE: this is a forward reference for Task 1.3 ("Stripe lib — account
// create/session/retrieve/dual-secret verify"), added here because Task 1.1's
// backfillStripeFlags() hard-depends on it to compile. Task 1.3 owns the rest
// of that surface (createConnectedAccount/createAccountSession/etc.) — this
// export should already match its spec, so that task just adds what's missing.
export async function retrieveAccount(accountId: string): Promise<Stripe.Account> {
  return _platformStripe().accounts.retrieve(accountId);
}

export async function createAccountLink(accountId: string, refreshUrl: string, returnUrl: string): Promise<string> {
  const link = await _platformStripe().accountLinks.create({
    account: accountId, refresh_url: refreshUrl, return_url: returnUrl, type: 'account_onboarding',
  });
  return link.url;
}

export async function updateAccountStatementDescriptor(accountId: string, descriptor: string): Promise<void> {
  await _platformStripe().accounts.update(accountId, { settings: { payments: { statement_descriptor: descriptor } } });
}

// --- Card service fee ---------------------------------------------------------------------
// Plan: md_files/plans/payments/2026-08-03-card-service-fee-workiz-parity.md
//
// The customer, not the contractor, funds the card-fee stack. On a card payment we add a 3.5%
// service fee to what the customer is charged, and ServWave's application fee becomes whatever
// is left of that fee after Stripe takes its cut, so the org receives its face amount. This
// REPLACED the old flat platform_fee_bps cut on card payments rather than stacking on top of
// it (D2), and it is the only card-fee path there is: card payments always carry a card fee,
// so no org opts out of it and there is no per-org switch to consult.
//
// All three functions are pure: the money math has to be unit-testable without a Stripe call,
// and callers need to compute the figures before deciding whether to pass them through at all.

// D4: a platform constant. Deliberately NOT a column, NOT an AppSetting, and NOT exposed in any
// settings form - orgs do not choose this rate. Rate rationale is in the plan's economics
// section: no rate inside the 3% network cap can fund both Stripe and our platform fee.
export const CARD_SERVICE_FEE_BPS = 350;

// Stripe's standard US card rate. Used only to SIZE our application fee at checkout-creation
// time, because application_fee_amount must be fixed before Stripe knows what card is coming.
const STRIPE_PERCENT_RATE = 0.029;
const STRIPE_FIXED_FEE_CENTS = 30;

/** The service fee the customer pays on top, in cents. Basis is what is being paid now. */
export function computeServiceFee(amountCents: number, bps: number): number {
  return Math.round(amountCents * bps / 10000);
}

/**
 * What Stripe is expected to take from the GROSS charge (base + service fee), in cents.
 * An estimate, not a measurement: international, Amex and converted cards all cost more, and
 * when actual exceeds this the org nets slightly under face value (D2, accepted).
 */
export function estimateStripeFee(grossCents: number): number {
  return Math.round(STRIPE_PERCENT_RATE * grossCents) + STRIPE_FIXED_FEE_CENTS;
}

/**
 * ServWave's application_fee_amount on a card payment carrying a service fee: the service fee
 * less what Stripe is expected to take, clamped at zero.
 *
 * The clamp is load-bearing. Below a base of about $60.18 Stripe's fixed 30c outruns the 3.5%
 * and the raw figure goes negative - Stripe rejects a negative application fee, and we must
 * never bill the org for the shortfall, so ServWave simply earns nothing on small tickets.
 *
 * Takes the base amount only. The customer's pay-time tip is never part of this basis (D7).
 */
export function deriveServiceFeeApplicationFee(amountCents: number): number {
  const serviceFeeCents = computeServiceFee(amountCents, CARD_SERVICE_FEE_BPS);
  const grossCents = amountCents + serviceFeeCents;
  return Math.max(0, serviceFeeCents - estimateStripeFee(grossCents));
}

/**
 * Resolves both fee fields for a card checkout in one place, so the two call sites (invoice
 * payment + estimate deposit) cannot drift.
 *
 * Takes the amount and nothing else, deliberately: paying by card always carries the card fee,
 * so there is no org, plan or setting that can turn it off. Keep it that way - an org parameter
 * here is how an opt-out gets reintroduced by accident.
 */
export function resolveCheckoutFees(
  amountCents: number,
): { serviceFeeAmount: number; applicationFeeAmount: number } {
  return {
    serviceFeeAmount: computeServiceFee(amountCents, CARD_SERVICE_FEE_BPS),
    applicationFeeAmount: deriveServiceFeeApplicationFee(amountCents),
  };
}

// D11 — percentages exist ONLY to render chips client-side; nothing persists them. Platform
// constants in v1 (no column, no settings form) - org-configurable presets are a follow-up.
export const CARD_TIP_PRESET_BPS = [1000, 1500, 2000];

export async function createCheckoutSession(
  options: {
    depositAmount: number;
    description: string;
    successUrl: string;
    cancelUrl: string;
    metadata: Record<string, string>;
    applicationFeeAmount?: number;
    serviceFeeAmount?: number;
    tipAmount?: number;
  },
  ctx: { stripe: Stripe; stripeAccount?: string },
): Promise<Stripe.Checkout.Session> {
  const totalCents = Math.round(options.depositAmount * 100);
  const hasServiceFee = !!options.serviceFeeAmount && options.serviceFeeAmount > 0;
  const hasTip = !!options.tipAmount && options.tipAmount > 0;

  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [{
    price_data: {
      currency: 'usd',
      unit_amount: totalCents,
      product_data: { name: options.description },
    },
    quantity: 1,
  }];
  // Slice 2 — itemised, not folded into a larger total, so the customer sees the fee on the
  // Stripe-hosted page itself (D1: the invoice document is untouched, this is checkout-only).
  if (hasServiceFee) {
    lineItems.push({
      price_data: {
        currency: 'usd',
        unit_amount: options.serviceFeeAmount!,
        product_data: { name: 'Service fee' },
      },
      quantity: 1,
    });
  }
  // Slice 7 — the tip is a third, independent line item. It rides on the payment, not the
  // invoice (D10), and is never part of the service-fee basis (D7 amendment).
  if (hasTip) {
    lineItems.push({
      price_data: {
        currency: 'usd',
        unit_amount: options.tipAmount!,
        product_data: { name: 'Tip' },
      },
      quantity: 1,
    });
  }

  const session = await ctx.stripe.checkout.sessions.create(
    {
      // IMPORTANT: 'card' only. If we add Link/ACH/SEPA/Klarna, those complete asynchronously
      // and we MUST add payment_intent.succeeded webhook handling. See spec §1 out-of-scope.
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: options.successUrl,
      cancel_url: options.cancelUrl,
      // D8 — serviceFeeCents/tipCents ride along for the webhook's amount cross-check; neither
      // is ever the webhook's source of truth on its own.
      metadata: {
        ...options.metadata,
        ...(hasServiceFee ? { serviceFeeCents: String(options.serviceFeeAmount) } : {}),
        ...(hasTip ? { tipCents: String(options.tipAmount) } : {}),
      },
      // Platform fee — DIRECT charges only, positive integer only. An application fee on a
      // platform-account session (no stripeAccount) makes Stripe 400 EVERY checkout.
      ...(ctx.stripeAccount && options.applicationFeeAmount && options.applicationFeeAmount > 0
        ? { payment_intent_data: { application_fee_amount: options.applicationFeeAmount } }
        : {}),
    },
    ctx.stripeAccount ? { stripeAccount: ctx.stripeAccount } : undefined,
  );

  return session;
}

// --- Killing a checkout the customer already has open -------------------------------------
// #2031 slice 5 (F2). A Checkout Session lives at Stripe for ~24h after it is created and settles
// on its own; refusing to CREATE a new one does nothing about the one already open. When the
// figure behind a deposit stops being true, the open session has to die, because a dead session
// cannot settle — that is what makes "no two live payable links at different amounts" a property
// of the system rather than a cross-check someone has to remember to run.
//
// Nothing here throws. Every caller is on a path (an estimate edit, a send) that must succeed
// whether or not Stripe is reachable, so the outcome is REPORTED instead: `ok` is false whenever
// this function cannot prove that no open session for the invoice survives.

export interface CheckoutExpiryResult {
  /** Session ids confirmed expired. */
  expired: string[];
  /** Sessions found but refused by Stripe. */
  failed: number;
  /** True only when the sweep completed and every matching session is confirmed dead. */
  ok: boolean;
}

/**
 * The sweep's page bound. Only `status: 'open'` sessions are listed and Stripe expires them on
 * its own within ~24h, so 5 pages is several hundred sessions in flight on one connected account.
 * Hitting the bound is reported as `ok: false` rather than silently truncating the sweep.
 */
const OPEN_SESSION_PAGE_LIMIT = 5;

/** Expire one session. Returns false (never throws) when Stripe refuses. */
export async function expireCheckoutSession(
  sessionId: string,
  ctx: { stripe: Stripe; stripeAccount?: string },
): Promise<boolean> {
  try {
    await ctx.stripe.checkout.sessions.expire(
      sessionId,
      undefined,
      ctx.stripeAccount ? { stripeAccount: ctx.stripeAccount } : undefined,
    );
    return true;
  } catch (err) {
    // An already-expired or already-completed session is a refusal too, and a harmless one — the
    // caller only ever wants "this cannot take money any more", which is already true in that
    // case. We cannot tell the two apart cheaply, so it is reported as a failure and the caller
    // logs conservatively.
    logger.error(`Failed to expire checkout session ${sessionId}:`, err);
    return false;
  }
}

/**
 * Expire every OPEN checkout session that was created for this invoice.
 *
 * Stripe cannot filter a session list by metadata and Checkout Sessions are not in its Search API,
 * so the open set is listed and matched on `metadata.invoiceId` — the same key the checkout
 * creators write and the webhook reads. That avoids persisting a session id on the invoice (which
 * would need a column) and, unlike a stored id, it catches EVERY session a customer opened rather
 * than only the most recent one.
 */
export async function expireOpenCheckoutSessionsForInvoice(
  invoiceId: string,
  ctx: { stripe: Stripe; stripeAccount?: string },
): Promise<CheckoutExpiryResult> {
  const result: CheckoutExpiryResult = { expired: [], failed: 0, ok: true };
  const requestOptions = ctx.stripeAccount ? { stripeAccount: ctx.stripeAccount } : undefined;

  try {
    let startingAfter: string | undefined;
    for (let page = 0; page < OPEN_SESSION_PAGE_LIMIT; page++) {
      const listed = await ctx.stripe.checkout.sessions.list(
        { status: 'open', limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) },
        requestOptions,
      );
      const sessions = listed?.data ?? [];
      for (const session of sessions) {
        if (session?.metadata?.invoiceId !== invoiceId) continue;
        if (await expireCheckoutSession(session.id, ctx)) {
          result.expired.push(session.id);
        } else {
          result.failed += 1;
          result.ok = false;
        }
      }
      if (!listed?.has_more || sessions.length === 0) return result;
      startingAfter = sessions[sessions.length - 1].id;
    }
    // Ran out of pages before running out of open sessions: we cannot claim the invoice is clean.
    logger.error(
      `Checkout expiry sweep for invoice ${invoiceId} hit the ${OPEN_SESSION_PAGE_LIMIT}-page bound; open sessions may remain`,
    );
    result.ok = false;
  } catch (err) {
    logger.error(`Checkout expiry sweep failed for invoice ${invoiceId}:`, err);
    result.ok = false;
  }
  return result;
}

export async function createRefund(
  paymentIntentId: string,
  ctx: { stripe: Stripe; stripeAccount?: string },
  amountInCents?: number,
  options?: { metadata?: Record<string, string>; reverseApplicationFee?: boolean },
): Promise<Stripe.Refund> {
  const params: Stripe.RefundCreateParams = { payment_intent: paymentIntentId };
  if (amountInCents) params.amount = amountInCents;
  if (options?.metadata) params.metadata = options.metadata;
  // Task 3.2 (fee reversal, door 1 — in-app refund): only meaningful for a direct-charge
  // Payment (an application fee only ever exists there); Stripe prorates automatically on
  // a partial refund. Callers decide via the Payment's stripe_account_id — this just wires it.
  if (options?.reverseApplicationFee) params.refund_application_fee = true;
  return ctx.stripe.refunds.create(
    params,
    ctx.stripeAccount ? { stripeAccount: ctx.stripeAccount } : undefined,
  );
}

export function constructWebhookEvent(payload: Buffer, signature: string): Stripe.Event {
  const stripe = _platformStripe();
  const secrets = [env.STRIPE_WEBHOOK_SECRET, env.STRIPE_WEBHOOK_SECRET_CONNECT].filter(Boolean) as string[];
  if (secrets.length === 0) throw new Error('No Stripe webhook secret configured');
  let lastErr: unknown;
  for (const secret of secrets) {
    try {
      return stripe.webhooks.constructEvent(payload, signature, secret);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}
