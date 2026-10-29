import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { logAudit } from '../lib/audit';
import { env } from '../config/env';
import {
  CURRENT_PAYMENTS_TERMS_VERSION, PAYMENTS_TERMS_URL, PAYMENTS_FEE_SCHEDULE_URL,
} from '../lib/legal';
import { createConnectedAccount, createAccountSession, createAccountLink, updateAccountStatementDescriptor } from '../lib/stripe';
import { mccForIndustry } from '../lib/stripe-mcc';

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
    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { platform_fee_bps: true } });
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
          disclosed_fee_bps: org.platform_fee_bps,
          authority_attested: true,
        },
      });
    } catch (err) {
      // P2002 on the partial unique index = already accepted this version → idempotent success.
      if ((err as { code?: string }).code !== 'P2002') throw err;
    }
    void logAudit({ req, action: 'payments.terms_accepted', resourceType: 'Organization', resourceId: orgId,
      metadata: { terms_version: CURRENT_PAYMENTS_TERMS_VERSION, disclosed_fee_bps: org.platform_fee_bps } });
    res.json({ accepted: true, terms_version: CURRENT_PAYMENTS_TERMS_VERSION });
  } catch (err) {
    logger.error('acceptPaymentsTerms error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/** Truncate/normalize an org name to Stripe's connected-account descriptor rules (5–22, ≥1 letter, no <>/'"*). */
export function toStatementDescriptor(name: string): string | null {
  const cleaned = name.replace(/[<>/'"*]/g, '').replace(/\s+/g, ' ').trim().slice(0, 22);
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
    if (org.stripe_account_id) { res.json({ stripe_account_id: org.stripe_account_id }); return; }

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
      res.json({ stripe_account_id: winner?.stripe_account_id ?? account.id });
      return;
    }
    void logAudit({ req, action: 'payments.account_created', resourceType: 'Organization', resourceId: orgId, metadata: { stripe_account_id: account.id } });
    res.json({ stripe_account_id: account.id });
  } catch (err) {
    logger.error('connectStripe error:', err);
    res.status(500).json({ error: 'Could not start ServWave Payments setup.' });
  }
}

export async function createStripeAccountSession(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    await assertPaymentsTermsAccepted(orgId); // 403 PAYMENTS_TERMS_ACCEPTANCE_REQUIRED until accepted
    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { stripe_account_id: true } });
    if (!org?.stripe_account_id) { res.status(409).json({ error: 'Start setup first.' }); return; }
    const clientSecret = await createAccountSession(org.stripe_account_id); // always mint fresh (Connect.js re-invokes on expiry)
    res.json({ client_secret: clientSecret });
  } catch (err) {
    if (err instanceof PaymentsTermsError) { res.status(err.status).json({ code: err.code, error: err.message }); return; }
    logger.error('createStripeAccountSession error:', err);
    res.status(500).json({ error: 'Could not load secure setup.' });
  }
}

export async function getStripeStatus(req: Request, res: Response) {
  try {
    const org = await prisma.organization.findUnique({
      where: { id: req.user!.organization_id },
      select: {
        stripe_account_id: true, stripe_charges_enabled: true, stripe_payouts_enabled: true,
        stripe_details_submitted: true, stripe_requirements_due: true, stripe_disabled_reason: true,
        platform_fee_bps: true,
      },
    });
    if (!org) { res.status(404).json({ error: 'Organization not configured' }); return; }
    // Deferred-bank nudge $X (§6.6): sum of CARD payments still awaiting payout — only while payouts pending.
    let collected_awaiting_payout = 0;
    if (org.stripe_charges_enabled && !org.stripe_payouts_enabled) {
      const agg = await prisma.payment.aggregate({
        where: { invoice: { organization_id: req.user!.organization_id }, method: 'CARD', voided_at: null },
        _sum: { amount: true },
      });
      collected_awaiting_payout = Number(agg._sum.amount ?? 0);
    }
    res.json({ ...org, collected_awaiting_payout });
  } catch (err) {
    logger.error('getStripeStatus error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// Hosted Account Link fallback (§3.1/§6.2) — the drawer calls this after the embedded component
// fails to load twice, so onboarding can always be finished on Stripe's surface.
export async function createStripeAccountLink(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    await assertPaymentsTermsAccepted(orgId);
    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { stripe_account_id: true } });
    if (!org?.stripe_account_id) { res.status(409).json({ error: 'Start setup first.' }); return; }
    const returnUrl = `${env.FRONTEND_URL}/settings/payments`;
    const url = await createAccountLink(org.stripe_account_id, returnUrl, returnUrl);
    res.json({ url });
  } catch (err) {
    if (err instanceof PaymentsTermsError) { res.status(err.status).json({ code: err.code, error: err.message }); return; }
    logger.error('createStripeAccountLink error:', err);
    res.status(500).json({ error: 'Could not create the setup link.' });
  }
}

// Post-onboarding statement-descriptor edit (§3.3 "post-onboarding edit path in Settings" / §15B#4).
export const updateDescriptorSchema = z.object({
  statement_descriptor: z.string().trim().min(5).max(22).regex(/^[^<>/'"*]*$/).refine((v) => /[A-Za-z]/.test(v), 'Descriptor needs at least one letter'),
});
export async function updateStatementDescriptor(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { stripe_account_id: true } });
    if (!org?.stripe_account_id) { res.status(409).json({ error: 'ServWave Payments is not connected.' }); return; }
    await updateAccountStatementDescriptor(org.stripe_account_id, req.body.statement_descriptor); // connected account, no platform prefix
    res.json({ statement_descriptor: req.body.statement_descriptor });
  } catch (err) {
    logger.error('updateStatementDescriptor error:', err);
    res.status(500).json({ error: 'Could not update the descriptor.' });
  }
}
