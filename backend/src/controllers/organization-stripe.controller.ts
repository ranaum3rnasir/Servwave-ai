import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { COUNTED_PAYMENT_WHERE } from '../lib/payment-ledger';
import { logger } from '../lib/logger';
import { logAudit } from '../lib/audit';
import { env } from '../config/env';
import {
  CURRENT_PAYMENTS_TERMS_VERSION, PAYMENTS_TERMS_URL, PAYMENTS_FEE_SCHEDULE_URL, DISCLOSED_PAYMENTS_FEE_BPS,
} from '../lib/legal';
import { createConnectedAccount, createAccountSession, createAccountLink, retrieveAccount } from '../lib/stripe';
import { mccForIndustry } from '../lib/stripe-mcc';
import { refreshAccountStatus, type Verification, type VerificationValue } from '../lib/account-status';
import { SESSION_SURFACES, type SessionSurface } from '../lib/account-session-surfaces';
import { requestHasOnlinePayments, ONLINE_PAYMENTS_NOT_IN_PLAN_REFUSAL } from '../lib/online-payments-plan';
import { firstPayoutOf } from '../services/payments-page';

export class PaymentsTermsError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

/** Throws 403 PAYMENTS_TERMS_ACCEPTANCE_REQUIRED until the org has accepted the current version. */
export async function assertPaymentsTermsAccepted(orgId: string): Promise<void> {
  const row = await prisma.termsAcceptance.findFirst({
    where: { organization_id: orgId, context: 'payments_onboarding', terms_version: CURRENT_PAYMENTS_TERMS_VERSION },
    select: { id: true },
  });
  if (!row) {
    throw new PaymentsTermsError(403, 'PAYMENTS_TERMS_ACCEPTANCE_REQUIRED', 'Accept the ServWave Payments Terms to continue.');
  }
}

export const acceptPaymentsTermsSchema = z.object({
  accepted: z.literal(true),
  authority_attested: z.literal(true),
});

export async function acceptPaymentsTerms(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true } });
    if (!org) { res.status(404).json({ error: 'Organization not configured' }); return; }
    try {
      await prisma.termsAcceptance.create({
        data: {
          user_id: req.user!.id,
          user_email: req.user!.email,
          organization_id: orgId,
          terms_version: CURRENT_PAYMENTS_TERMS_VERSION,
          terms_url: PAYMENTS_TERMS_URL,
          privacy_url: PAYMENTS_FEE_SCHEDULE_URL, // Fee Schedule is the payments-relevant companion doc
          context: 'payments_onboarding',
          ip_address: req.ip ?? null,
          user_agent: req.headers['user-agent'] ?? null,
          disclosed_fee_bps: DISCLOSED_PAYMENTS_FEE_BPS,
          authority_attested: true,
        },
      });
    } catch (err) {
      // P2002 on the partial unique index = already accepted this version → idempotent success.
      if ((err as { code?: string }).code !== 'P2002') throw err;
    }
    void logAudit({ req, action: 'payments.terms_accepted', resourceType: 'Organization', resourceId: orgId,
      metadata: { terms_version: CURRENT_PAYMENTS_TERMS_VERSION, disclosed_fee_bps: DISCLOSED_PAYMENTS_FEE_BPS } });
    res.json({ accepted: true, terms_version: CURRENT_PAYMENTS_TERMS_VERSION });
  } catch (err) {
    logger.error('acceptPaymentsTerms error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/** Truncate/normalize an org name to Stripe's connected-account descriptor rules (5–22, Latin characters, ≥1 letter, none of <>\/'"*). */
export function toStatementDescriptor(name: string): string | null {
  const cleaned = name.replace(/[<>\\/'"*]/g, '').replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim().slice(0, 22);
  if (cleaned.length < 5 || !/[A-Za-z]/.test(cleaned)) return null; // let Stripe collect it on their surface
  return cleaned;
}

export async function connectStripe(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: {
        id: true, name: true, email: true, website: true, support_email: true, industry: true, stripe_account_id: true,
        phone: true, business_type: true, brand_color: true,
        address_line1: true, address_line2: true, city: true, state: true, postal_code: true,
      },
    });
    if (!org) { res.status(404).json({ error: 'Organization not configured' }); return; }
    if (org.stripe_account_id) { res.json({ connected: true }); return; }
    // Payments go-live slice 16: the plan gate sits on opening a NEW account only. An existing
    // account stays reachable (above, and the session/link routes) so it can still be fixed.
    if (!requestHasOnlinePayments(req)) { res.status(403).json(ONLINE_PAYMENTS_NOT_IN_PLAN_REFUSAL); return; }

    const account = await createConnectedAccount({
      orgId,
      email: org.email,
      businessName: org.name,
      mcc: mccForIndustry(org.industry as string[] | null),
      url: org.website,
      supportEmail: org.support_email,
      supportPhone: org.phone,
      statementDescriptor: toStatementDescriptor(org.name),
      brandColorHex: org.brand_color, // schema default "#242424" is a valid hex → primary_color
      address: { line1: org.address_line1, line2: org.address_line2, city: org.city, state: org.state, postal_code: org.postal_code },
      // Conservative business_type map: only 'individual' when clearly a sole prop; else 'company'; else let Stripe collect.
      businessType: /sole|individual|proprietor/i.test(org.business_type ?? '') ? 'individual' : (org.business_type ? 'company' : null),
    });

    // Race-safe conditional claim: only the admin who finds stripe_account_id still NULL wins.
    const claim = await prisma.organization.updateMany({
      where: { id: orgId, stripe_account_id: null },
      data: { stripe_account_id: account.id },
    });
    if (claim.count === 0) {
      const winner = await prisma.organization.findUnique({ where: { id: orgId }, select: { stripe_account_id: true } });
      res.json({ connected: true });
      return;
    }
    void logAudit({ req, action: 'payments.account_created', resourceType: 'Organization', resourceId: orgId, metadata: { stripe_account_id: account.id } });
    res.json({ connected: true });
  } catch (err) {
    logger.error('connectStripe error:', err);
    res.status(500).json({ error: 'Could not start ServWave Payments setup.' });
  }
}

export const accountSessionSchema = z.object({
  surface: z.enum(SESSION_SURFACES as [SessionSurface, ...SessionSurface[]]).default('owner'),
});

export async function createStripeAccountSession(req: Request, res: Response) {
  try {
    const parsed = accountSessionSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: 'Unknown session type.' }); return; }
    // Each surface is its own permission: the owner surface changes the payout account, the viewer surface only reads
    // payments and answers disputes. Holding one never opens the other.
    const needed = parsed.data.surface === 'owner' ? 'manage_payout_account' : 'view_payments';
    if (!req.ability?.can(needed, 'Organization')) { res.status(403).json({ error: 'Insufficient permissions' }); return; }
    const orgId = req.user!.organization_id;
    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { stripe_account_id: true } });
    if (!org?.stripe_account_id) { res.status(409).json({ error: 'Start setup first.' }); return; }
    await assertPaymentsTermsAccepted(orgId); // 403 PAYMENTS_TERMS_ACCEPTANCE_REQUIRED until accepted
    const clientSecret = await createAccountSession(org.stripe_account_id, parsed.data.surface); // always mint fresh (Connect.js re-invokes on expiry)
    res.json({ client_secret: clientSecret });
  } catch (err) {
    if (err instanceof PaymentsTermsError) { res.status(err.status).json({ code: err.code, error: err.message }); return; }
    logger.error('createStripeAccountSession error:', err);
    res.status(500).json({ error: 'Could not load secure setup.' });
  }
}

/** The stored verification rows, cut to exactly the four values; null until the first account sync. */
function verificationForBrowser(stored: unknown): Verification | null {
  if (!stored || typeof stored !== 'object') return null;
  const v = stored as Record<string, unknown>;
  return {
    business_details: v.business_details as VerificationValue,
    owner_identity: v.owner_identity as VerificationValue,
    bank_account: v.bank_account as VerificationValue,
    tax_id: v.tax_id as VerificationValue,
  };
}

export async function getStripeStatus(req: Request, res: Response) {
  try {
    const org = await prisma.organization.findUnique({
      where: { id: req.user!.organization_id },
      select: {
        stripe_account_id: true, stripe_charges_enabled: true, stripe_payouts_enabled: true,
        stripe_details_submitted: true, stripe_requirements_due: true, stripe_disabled_reason: true,
        stripe_verification: true,
      },
    });
    if (!org) { res.status(404).json({ error: 'Organization not configured' }); return; }
    // Deferred-bank nudge $X (§6.6): sum of CARD payments still awaiting payout — only while payouts pending.
    let collected_awaiting_payout = 0;
    if (org.stripe_charges_enabled && !org.stripe_payouts_enabled) {
      const agg = await prisma.payment.aggregate({
        where: {
          invoice: { organization_id: req.user!.organization_id },
          // Cleared online bank debits are collected money awaiting payout too; a hand-recorded bank transfer is not.
          OR: [{ method: 'CARD' }, { method: 'ACH', stripe_payment_intent_id: { not: null } }],
          ...COUNTED_PAYMENT_WHERE,
        },
        _sum: { amount: true },
      });
      collected_awaiting_payout = Number(agg._sum.amount ?? 0);
    }
    // The processor's account id stays on the server: the browser gets whether the org is connected, nothing more.
    // The verification column is renamed on the way out and cut to its four values, so nothing else stored in it can reach the browser.
    const { stripe_account_id, stripe_verification, ...rest } = org;
    const connected = Boolean(stripe_account_id);
    // Whether the current payments terms are on file: the payout account page asks for an embedded session only
    // once they are, so it needs to know before it asks.
    const termsRow = await prisma.termsAcceptance.findFirst({
      where: { organization_id: req.user!.organization_id, context: 'payments_onboarding', terms_version: CURRENT_PAYMENTS_TERMS_VERSION },
      select: { id: true },
    });
    // Until the first payout reaches the bank, the payout pages say how long it usually takes; then they confirm it.
    // Read from ServWave's own payout rows (no processor call); nothing but a state and a day leaves here.
    let first_payout = firstPayoutOf(null, null);
    if (connected) {
      const orgId = req.user!.organization_id;
      const earliest = (statuses: string[]) => prisma.payout.findFirst({
        where: { organization_id: orgId, status: { in: statuses } },
        orderBy: [{ arrival_date: 'asc' }, { created_at: 'asc' }],
        select: { arrival_date: true },
      });
      const paid = await earliest(['PAID']);
      first_payout = firstPayoutOf(paid, paid ? null : await earliest(['PENDING', 'IN_TRANSIT']));
    }
    res.json({
      ...rest, verification: verificationForBrowser(stripe_verification), connected, terms_accepted: Boolean(termsRow),
      collected_awaiting_payout, first_payout,
    });
  } catch (err) {
    logger.error('getStripeStatus error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// Return from onboarding (payments go-live slice 06): re-read the account from the processor,
// store its status (fail closed on any error), then answer with the same body as GET /status.
export async function refreshStripeStatus(req: Request, res: Response) {
  try {
    await refreshAccountStatus(req.user!.organization_id);
  } catch (err) {
    logger.error('refreshStripeStatus error:', err);
    res.status(500).json({ error: 'Could not refresh the payments status.' });
    return;
  }
  await getStripeStatus(req, res);
}

export const accountLinkSchema = z.object({
  collect: z.enum(['now', 'all']).default('now'),
});

// Hosted Account Link fallback (§3.1/§6.2) — the drawer calls this after the embedded component
// fails to load twice, so onboarding can always be finished on Stripe's surface.
export async function createStripeAccountLink(req: Request, res: Response) {
  try {
    const parsed = accountLinkSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: 'Unknown setup type.' }); return; }
    const orgId = req.user!.organization_id;
    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { stripe_account_id: true } });
    if (!org?.stripe_account_id) { res.status(409).json({ error: 'Start setup first.' }); return; }
    await assertPaymentsTermsAccepted(orgId);
    const refreshUrl = `${env.FRONTEND_URL}/settings/servwave-payments`;
    // ?onboarding=return makes the ServWave Payments settings page re-read the account status on arrival.
    const returnUrl = `${refreshUrl}?onboarding=return`;
    const url = await createAccountLink(org.stripe_account_id, refreshUrl, returnUrl, parsed.data.collect);
    res.json({ url });
  } catch (err) {
    if (err instanceof PaymentsTermsError) { res.status(err.status).json({ code: err.code, error: err.message }); return; }
    logger.error('createStripeAccountLink error:', err);
    res.status(500).json({ error: 'Could not create the setup link.' });
  }
}

// Read-only: the platform may not write the descriptor on a processor-controlled account, so ServWave shows it.
export async function getStatementDescriptor(req: Request, res: Response) {
  try {
    const org = await prisma.organization.findUnique({ where: { id: req.user!.organization_id }, select: { stripe_account_id: true, name: true } });
    if (!org?.stripe_account_id) { res.status(409).json({ error: 'ServWave Payments is not connected.' }); return; }
    const account = await retrieveAccount(org.stripe_account_id);
    // What the account carries now; before one is set, what the org name would give.
    const current = account.settings?.payments?.statement_descriptor || toStatementDescriptor(org.name);
    res.json({ statement_descriptor: current ?? null });
  } catch (err) {
    logger.error('getStatementDescriptor error:', err);
    res.status(500).json({ error: 'Could not load the descriptor.' });
  }
}
