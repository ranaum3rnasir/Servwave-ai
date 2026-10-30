import { componentsFor, type SessionSurface } from './account-session-surfaces';
import Stripe from 'stripe';
import { createHash } from 'crypto';
import { env } from '../config/env';
import { logger } from './logger';
import type { CheckoutMethod, PricedCheckout } from './checkout-pricing';

export const STRIPE_API_VERSION = '2025-02-24.acacia';
// The one call that may use a newer version: the card session when Link is hidden (the wallet
// option does not exist at the platform version). Webhook endpoints stay on STRIPE_API_VERSION.
export const LINK_HIDING_API_VERSION = '2025-04-30.basil';

let _stripe: Stripe | null = null;

function _platformStripe(): Stripe {
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error('Online payments are not configured on this server.');
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
      // D13 (payments go-live, 2026-10-05): Stripe's "fully embedded" model. No Stripe dashboard
      // or login for the contractor ('none'); the contractor still pays Stripe's fees, Stripe
      // carries negative-balance losses and collects requirements. NOT 'express' (Stripe rejects
      // express + losses.payments:'stripe'). The controller is fixed at creation and this is the
      // only path that creates an account, so every account ServWave makes gets exactly this.
      // See md_files/plans/payments/2026-10-05-payments-go-live/01-research-and-decisions.md §9.2.
      stripe_dashboard: { type: 'none' },
      fees: { payer: 'account' },
      losses: { payments: 'stripe' },
      requirement_collection: 'stripe',
    },
    // Without an explicit capability request the account sits at capabilities:{} forever —
    // it can complete every other requirement and still never charge a card or receive a
    // payout, and the embedded onboarding component has no capability-driven flow to show
    // (the "Add information" button renders but never advances past the landing card).
    // ACH bank debit is requested up front (PRD Module 1) so bank payments can turn on by
    // themselves once the capability goes active; nothing re-requests it later.
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
      us_bank_account_ach_payments: { requested: true },
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
// The logo cannot be prefilled by URL: settings.branding.logo wants a file id, so updateAccountBranding
// uploads the bytes first. The hosted checkout reads name, colour and logo from the account's settings
// (never per session: that needs a newer API version).

export async function createAccountSession(accountId: string, surface: SessionSurface = 'owner'): Promise<string> {
  const stripe = _platformStripe();
  const session = await stripe.accountSessions.create({
    account: accountId,
    components: componentsFor(surface) as Stripe.AccountSessionCreateParams.Components,
  });
  return session.client_secret;
}

// Live account lookup. Its errors are classified (fail closed) by lib/account-status.ts and
// by the account.updated webhook handler; this wrapper does not swallow them.
export async function retrieveAccount(accountId: string): Promise<Stripe.Account> {
  return _platformStripe().accounts.retrieve(accountId);
}

// Cheap authenticated read of the platform's own account. The nightly status refresh calls it
// once before any org, so a bad or under-permissioned platform key aborts the run instead of
// being read as an answer about every connected account. Throws the processor's error.
export async function checkPlatformKey(): Promise<void> {
  await _platformStripe().accounts.retrieveCurrent();
}

export async function createAccountLink(accountId: string, refreshUrl: string, returnUrl: string): Promise<string> {
  const link = await _platformStripe().accountLinks.create({
    account: accountId, refresh_url: refreshUrl, return_url: returnUrl, type: 'account_onboarding',
  });
  return link.url;
}

export interface AccountBranding {
  primaryColor?: string;
  logo?: { data: Buffer; mime: string };
}

/**
 * Payments go-live slice 36: push the contractor's colour and logo to the connected account's
 * branding settings, which is where the hosted checkout (and the processor's emails) read them.
 * Only what is passed is sent, and only under settings.branding (the platform may not write
 * business_profile on a processor-controlled account). The logo is uploaded as a business logo first.
 */
export async function updateAccountBranding(accountId: string, branding: AccountBranding): Promise<void> {
  const stripe = _platformStripe();
  let logoFileId: string | undefined;
  if (branding.logo) {
    const ext = branding.logo.mime === 'image/png' ? 'png' : 'jpg';
    const file = await stripe.files.create({
      purpose: 'business_logo',
      file: { data: branding.logo.data, name: `logo.${ext}`, type: 'application/octet-stream' },
    });
    logoFileId = file.id;
  }
  const brandingSettings = {
    ...(branding.primaryColor ? { primary_color: branding.primaryColor } : {}),
    ...(logoFileId ? { logo: logoFileId } : {}),
  };
  const params: Stripe.AccountUpdateParams = {
    ...(Object.keys(brandingSettings).length ? { settings: { branding: brandingSettings } } : {}),
  };
  if (Object.keys(params).length === 0) return;
  await stripe.accounts.update(accountId, params);
}

// D11 — percentages exist ONLY to render chips client-side; nothing persists them. Platform
// constants in v1 (no column, no settings form) - org-configurable presets are a follow-up.
export const CARD_TIP_PRESET_BPS = [1000, 1500, 2000];

/**
 * The payment-method part of a hosted checkout. A session carries exactly one method, never both
 * (payments go-live PRD Module 3, D19):
 * - card: card only. The hosted page then also offers Apple Pay, Google Pay and Link on a
 *   supported browser.
 * - bank: ACH debit only, verified instantly through the customer's bank login, with
 *   micro-deposits as the fallback (`automatic`). Only the `payment_method` permission is asked
 *   for: the account and routing number the debit needs, never balances or transactions.
 */
function sessionMethodParams(method: CheckoutMethod): Pick<
  Stripe.Checkout.SessionCreateParams,
  'payment_method_types' | 'payment_method_options'
> {
  if (method === 'bank') {
    return {
      payment_method_types: ['us_bank_account'],
      payment_method_options: {
        us_bank_account: {
          verification_method: 'automatic',
          financial_connections: { permissions: ['payment_method'] },
        },
      },
    };
  }
  return { payment_method_types: ['card'] };
}

/** The document a checkout pays. `kind` is what the reconciler books it as. */
export interface CheckoutDocument {
  organizationId: string;
  invoiceId: string;
  kind: 'invoice' | 'deposit';
  /** A deposit taken at approval also names its estimate. */
  estimateId?: string;
}

/**
 * Opens a hosted checkout for an already-priced payment, by card or by bank (one per session).
 *
 * What the customer is charged is decided by the checkout pricing module (checkout-pricing.ts),
 * never here: each priced line becomes one line item, in order. No application fee is ever sent
 * (payments go-live D9 - ServWave takes no cut of payments at launch).
 */
export async function createCheckoutSession(
  options: {
    pricing: PricedCheckout;
    method: CheckoutMethod;
    document: CheckoutDocument;
    successUrl: string;
    cancelUrl: string;
  },
  ctx: { stripe: Stripe; stripeAccount?: string },
): Promise<Stripe.Checkout.Session> {
  const { pricing, document } = options;
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = pricing.lineItems.map((line) => ({
    price_data: {
      currency: 'usd',
      unit_amount: line.amountCents,
      product_data: { name: line.name },
    },
    quantity: 1,
  }));

  const hideLink = options.method === 'card' && env.PAYMENTS_HIDE_LINK_ON_CARD === true;
  const requestOptions: Stripe.RequestOptions = {
    ...(ctx.stripeAccount ? { stripeAccount: ctx.stripeAccount } : {}),
    ...(hideLink ? { apiVersion: LINK_HIDING_API_VERSION as Stripe.LatestApiVersion } : {}),
  };

  const session = await ctx.stripe.checkout.sessions.create(
    {
      ...(hideLink ? { wallet_options: { link: { display: 'never' } } } : {}),
      // A bank session completes UNPAID and settles days later (async_payment_succeeded /
      // _failed); the payment lifecycle for that is payments go-live slice 13.
      ...sessionMethodParams(options.method),
      line_items: lineItems,
      mode: 'payment',
      success_url: options.successUrl,
      cancel_url: options.cancelUrl,
      // What the session was built against (payments go-live PRD Module 3): the org, the
      // document and its kind, the payable-now amount and the tip. The reconciler checks all of it
      // against what was charged. tipCents rides along for the amount cross-check; it is never the
      // webhook's source of truth on its own, and is absent when there is no tip.
      metadata: {
        organizationId: document.organizationId,
        invoiceId: document.invoiceId,
        ...(document.estimateId ? { estimateId: document.estimateId } : {}),
        kind: document.kind,
        payableNowCents: String(pricing.payableNowCents),
        // Slice 26: a partial payment names the document amount chosen, so the reconciler books
        // exactly that and leaves the rest owing. Absent = the payable-now amount in full.
        ...(pricing.amountCents !== pricing.payableNowCents ? { amountCents: String(pricing.amountCents) } : {}),
        ...(pricing.tipCents > 0 ? { tipCents: String(pricing.tipCents) } : {}),
      },
    },
    Object.keys(requestOptions).length > 0 ? requestOptions : undefined,
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
  options?: { exceptSessionId?: string; createdBefore?: number },
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
        // Minting a new session closes the OLDER ones; the one just minted is the live link.
        if (options?.exceptSessionId && session.id === options.exceptSessionId) continue;
        // Only strictly OLDER sessions go: one minted at the same moment or later belongs to a
        // concurrent mint, and each of two simultaneous mints must not expire the other.
        if (options?.createdBefore !== undefined && typeof session.created === 'number' && session.created >= options.createdBefore) continue;
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
  options?: { metadata?: Record<string, string>; reverseApplicationFee?: boolean; idempotencyKey?: string },
): Promise<Stripe.Refund> {
  const params: Stripe.RefundCreateParams = { payment_intent: paymentIntentId };
  if (amountInCents) params.amount = amountInCents;
  if (options?.metadata) params.metadata = options.metadata;
  // Task 3.2 (fee reversal, door 1 — in-app refund): only meaningful for a direct-charge
  // Payment (an application fee only ever exists there); Stripe prorates automatically on
  // a partial refund. Callers decide via the Payment's stripe_account_id — this just wires it.
  if (options?.reverseApplicationFee) params.refund_application_fee = true;
  // Slice 11: a caller that may be retried (a double click) names the refund, so the processor
  // sends it once.
  const requestOptions: Stripe.RequestOptions = {
    ...(ctx.stripeAccount ? { stripeAccount: ctx.stripeAccount } : {}),
    ...(options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
  };
  return ctx.stripe.refunds.create(params, Object.keys(requestOptions).length ? requestOptions : undefined);
}

/**
 * Payments go-live slice 29: cancel a bank debit that is still processing, in the account it was
 * made in. The sandbox confirmed a processing bank payment intent can be cancelled (D17); the
 * processor refuses once the debit can no longer be stopped.
 */
export async function cancelPaymentIntent(
  paymentIntentId: string,
  ctx: { stripe: Stripe; stripeAccount?: string },
): Promise<Stripe.PaymentIntent> {
  return ctx.stripe.paymentIntents.cancel(paymentIntentId, {}, ctx.stripeAccount ? { stripeAccount: ctx.stripeAccount } : undefined);
}

/**
 * Slice 11: every refund on a payment intent, out of the account it was made in. The list asks this
 * before it sends a refund, so a refund an earlier attempt created (its answer was an error, or never
 * arrived) is found instead of sent a second time. Throws rather than answer with a partial list.
 */
const REFUND_LIST_PAGE_LIMIT = 10;
async function listRefundsWhere(
  filter: { payment_intent: string } | { charge: string },
  ctx: { stripe: Stripe; stripeAccount?: string },
): Promise<Stripe.Refund[]> {
  const refunds: Stripe.Refund[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < REFUND_LIST_PAGE_LIMIT; page++) {
    const listed = await ctx.stripe.refunds.list(
      { ...filter, limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) },
      ctx.stripeAccount ? { stripeAccount: ctx.stripeAccount } : undefined,
    );
    refunds.push(...listed.data);
    if (!listed.has_more || listed.data.length === 0) return refunds;
    startingAfter = listed.data[listed.data.length - 1].id;
  }
  throw new Error(`Refund list for ${Object.values(filter)[0]} hit the ${REFUND_LIST_PAGE_LIMIT}-page bound`);
}

export function listPaymentIntentRefunds(
  paymentIntentId: string,
  ctx: { stripe: Stripe; stripeAccount?: string },
): Promise<Stripe.Refund[]> {
  return listRefundsWhere({ payment_intent: paymentIntentId }, ctx);
}

/** Slice 37b: the same lookup by charge, for a payment that kept a charge id but no payment intent id. */
export function listChargeRefunds(
  chargeId: string,
  ctx: { stripe: Stripe; stripeAccount?: string },
): Promise<Stripe.Refund[]> {
  return listRefundsWhere({ charge: chargeId }, ctx);
}

/**
 * Slice 37b: one payment intent as the connected account holds it, or null when it holds none. The
 * nightly reconcile asks this before calling a bank payment "a charge the processor does not hold":
 * a debit waiting on the customer has an intent and no charge yet.
 */
export async function retrieveAccountPaymentIntent(
  accountId: string,
  paymentIntentId: string,
): Promise<{ id: string; status: string; latest_charge: string | null } | null> {
  try {
    const pi = await _platformStripe().paymentIntents.retrieve(paymentIntentId, {}, { stripeAccount: accountId });
    const latest = pi.latest_charge;
    return { id: pi.id, status: pi.status, latest_charge: typeof latest === 'string' ? latest : latest?.id ?? null };
  } catch (err) {
    if ((err as { code?: string }).code === 'resource_missing') return null;
    throw err;
  }
}

// ---- Nightly reconcile reads (payments go-live slice 37) ---------------------------------------
//
// The reconcile lists what ONE org's connected account holds, created since a moment. Each call is
// pinned to that account with the `stripeAccount` header, so a list can never read another
// account's charges. Bounded: a page cap turns a runaway list into an error, which the reconcile
// records as a failed run for that org instead of comparing against a partial list.
const RECONCILE_LIST_PAGE_LIMIT = 50;

async function listAllSince<T extends { id: string }>(
  fetchPage: (startingAfter: string | undefined) => Promise<Stripe.ApiList<T>>,
  what: string,
): Promise<T[]> {
  const all: T[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < RECONCILE_LIST_PAGE_LIMIT; page++) {
    const listed = await fetchPage(startingAfter);
    all.push(...listed.data);
    if (!listed.has_more || listed.data.length === 0) return all;
    startingAfter = listed.data[listed.data.length - 1].id;
  }
  throw new Error(`${what} list hit the ${RECONCILE_LIST_PAGE_LIMIT}-page bound`);
}

/** Charges on a connected account created at or after `sinceUnix` (seconds). */
export async function listAccountCharges(accountId: string, sinceUnix: number): Promise<Stripe.Charge[]> {
  const stripe = _platformStripe();
  return listAllSince((after) => stripe.charges.list(
    { created: { gte: sinceUnix }, limit: 100, ...(after ? { starting_after: after } : {}) },
    { stripeAccount: accountId },
  ), 'Charge');
}

/** Refunds on a connected account created at or after `sinceUnix` (seconds). */
export async function listAccountRefunds(accountId: string, sinceUnix: number): Promise<Stripe.Refund[]> {
  const stripe = _platformStripe();
  return listAllSince((after) => stripe.refunds.list(
    { created: { gte: sinceUnix }, limit: 100, ...(after ? { starting_after: after } : {}) },
    { stripeAccount: accountId },
  ), 'Refund');
}

/** Disputes on a connected account created at or after `sinceUnix` (seconds). */
export async function listAccountDisputes(accountId: string, sinceUnix: number): Promise<Stripe.Dispute[]> {
  const stripe = _platformStripe();
  return listAllSince((after) => stripe.disputes.list(
    { created: { gte: sinceUnix }, limit: 100, ...(after ? { starting_after: after } : {}) },
    { stripeAccount: accountId },
  ), 'Dispute');
}

/** Checkout sessions on a connected account created at or after `sinceUnix` (seconds). */
export async function listAccountCheckoutSessions(accountId: string, sinceUnix: number): Promise<Stripe.Checkout.Session[]> {
  const stripe = _platformStripe();
  return listAllSince((after) => stripe.checkout.sessions.list(
    { created: { gte: sinceUnix }, limit: 100, ...(after ? { starting_after: after } : {}) },
    { stripeAccount: accountId },
  ), 'Checkout session');
}

/**
 * Payouts slice P2: payouts of a connected account created at or after `sinceUnix` (seconds), each with
 * its destination bank account expanded (for the bank label). Pinned to the account.
 */
export async function listAccountPayouts(accountId: string, sinceUnix: number): Promise<Stripe.Payout[]> {
  const stripe = _platformStripe();
  return listAllSince((after) => stripe.payouts.list(
    { created: { gte: sinceUnix }, limit: 100, expand: ['data.destination'], ...(after ? { starting_after: after } : {}) },
    { stripeAccount: accountId },
  ), 'Payout');
}

/** Payouts slice P2: one payout as the processor holds it now, destination expanded. Pinned to the account. */
export async function retrieveAccountPayout(accountId: string, payoutId: string): Promise<Stripe.Payout> {
  const stripe = _platformStripe();
  return stripe.payouts.retrieve(payoutId, { expand: ['destination'] }, { stripeAccount: accountId });
}

/** Payouts slice P2: the balance transactions paid out in one payout of a connected account. Pinned to the account. */
export async function listPayoutBalanceTransactions(accountId: string, payoutId: string): Promise<Stripe.BalanceTransaction[]> {
  const stripe = _platformStripe();
  return listAllSince((after) => stripe.balanceTransactions.list(
    { payout: payoutId, limit: 100, ...(after ? { starting_after: after } : {}) },
    { stripeAccount: accountId },
  ), 'Payout balance transaction');
}

/**
 * Payouts slice P2: why a payment intent last failed, as the processor's code only (never its message).
 * Null when it holds no error or the intent is not there. Throws on a lookup failure; the caller decides
 * that a lookup failure must never block the state change it is annotating.
 */
export async function retrievePaymentIntentFailureCode(accountId: string | null, paymentIntentId: string): Promise<string | null> {
  try {
    const pi = await _platformStripe().paymentIntents.retrieve(paymentIntentId, {}, accountId ? { stripeAccount: accountId } : undefined);
    const err = pi.last_payment_error;
    return err?.code ?? err?.decline_code ?? null;
  } catch (err) {
    if ((err as { code?: string }).code === 'resource_missing') return null;
    throw err;
  }
}

/** What the unapplied item's drawer shows about how the money was paid. Words only: no id, no payer name, no error text. */
export interface CapturePayerDetail {
  method: 'card' | 'bank';
  /** The card brand as the processor names it (visa, mastercard...); null for a bank payment. */
  brand: string | null;
  last4: string | null;
  /** The bank's name for a bank payment; null for a card. */
  bank_name: string | null;
  description: string | null;
}

/** How long the drawer waits for the processor before it shows the item without the payer rows. */
export const CAPTURE_PAYER_READ_TIMEOUT_MS = 3000;

/** A description that carries one of the processor's own object ids is dropped rather than shown. */
const PROCESSOR_ID_IN_TEXT = /\b(?:pi|ch|py|cs|acct|pm|re|evt|in|dp|po|txn|ba|card|src|seti|si|sub|cus)_[A-Za-z0-9]+/;

/**
 * V7 BE-10: how an unapplied capture was paid, read on demand from the processor and NEVER stored. The one deliberate
 * exception to "ServWave's own records only" on the Payments page. Pinned to the capture's connected account, outside any
 * database transaction. Returns only { method, brand, last4, bank_name, description }; null when there is no intent or
 * account on the row, when the processor cannot say, errors, or takes longer than `timeoutMs`. It never throws and the
 * processor's error text never leaves it, so the caller shows the item without the payer rows.
 */
export async function retrieveCapturePayerDetail(
  accountId: string | null,
  paymentIntentId: string | null,
  timeoutMs: number = CAPTURE_PAYER_READ_TIMEOUT_MS,
): Promise<CapturePayerDetail | null> {
  if (!accountId || !paymentIntentId) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = _platformStripe().paymentIntents.retrieve(
      paymentIntentId,
      { expand: ['latest_charge'] },
      { stripeAccount: accountId, timeout: timeoutMs },
    );
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const pi = await Promise.race([read, timedOut]);
    if (!pi) return null;
    const charge = typeof pi.latest_charge === 'object' && pi.latest_charge ? pi.latest_charge : null;
    const details = charge?.payment_method_details;
    const description = typeof pi.description === 'string' && pi.description.trim() && !PROCESSOR_ID_IN_TEXT.test(pi.description)
      ? pi.description.trim()
      : null;
    if (details?.type === 'card' && details.card) {
      return { method: 'card', brand: details.card.brand ?? null, last4: details.card.last4 ?? null, bank_name: null, description };
    }
    if (details?.type === 'us_bank_account' && details.us_bank_account) {
      return { method: 'bank', brand: null, last4: details.us_bank_account.last4 ?? null, bank_name: details.us_bank_account.bank_name ?? null, description };
    }
    return null;
  } catch {
    // The caller decides what a missing read means; the processor's message is never passed on.
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Payments go-live P10: answering a dispute. Every call is pinned to the account the payment lives on (null = the
// platform account, a legacy payment); the evidence rules are enforced by the caller before any of this runs.
// ---------------------------------------------------------------------------------------------------------------------

const onAccount = (accountId: string | null) => (accountId ? { stripeAccount: accountId } : undefined);

/** Send one evidence file to the processor. Returns its file token, which one later request may use once. */
export async function uploadDisputeEvidenceFile(
  accountId: string | null,
  file: { data: Buffer; name: string; mime: string },
): Promise<string> {
  const made = await _platformStripe().files.create(
    { purpose: 'dispute_evidence', file: { data: file.data, name: file.name, type: file.mime } },
    onAccount(accountId),
  );
  return made.id;
}

/**
 * Stage the evidence on the dispute without sending it (visible there, not yet to the bank). `evidence` maps an
 * evidence field to a file token or text; an empty string clears the field.
 */
export async function stageDisputeEvidence(accountId: string | null, disputeId: string, evidence: Record<string, string>): Promise<void> {
  await _platformStripe().disputes.update(disputeId, { evidence, submit: false }, onAccount(accountId));
}

/** Send the staged evidence to the bank. Final: the processor takes nothing more after this. */
export async function submitDisputeEvidence(accountId: string | null, disputeId: string): Promise<void> {
  await _platformStripe().disputes.update(disputeId, { submit: true }, onAccount(accountId));
}

/** How many times evidence has been submitted on this dispute, as the processor counts it. */
export async function retrieveDisputeSubmissionCount(accountId: string | null, disputeId: string): Promise<number> {
  const d = await _platformStripe().disputes.retrieve(disputeId, {}, onAccount(accountId));
  return d.evidence_details?.submission_count ?? 0;
}

export function constructWebhookEvent(payload: Buffer, signature: string): Stripe.Event {
  const stripe = _platformStripe();
  const secrets = [env.STRIPE_WEBHOOK_SECRET, env.STRIPE_WEBHOOK_SECRET_CONNECT].filter(Boolean) as string[];
  if (secrets.length === 0) throw new Error('No webhook secret configured');
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
