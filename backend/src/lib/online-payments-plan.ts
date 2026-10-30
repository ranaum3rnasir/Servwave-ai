import type { Request } from 'express';
import { hasFeature as orgHasFeature } from './entitlements/resolve';
import { hasFeature as requestHasFeature } from '../middleware/requireFeature';

/**
 * The `online_payments` plan gate (payments go-live slice 16, PRD Module 3 and call 5).
 *
 * It applies where online money starts: onboarding start, meaning opening a NEW payout account
 * (POST /stripe/connect for an org with none), and checkout creation (the public pay routes, which
 * have no user, so the gate is read off the document's org row). It answers 403 with its own code,
 * not the generic 402 upgrade bounce (the plan code for the signed-in owner, a neutral code for a
 * public checkout): the Payments settings page shows the plan message in place,
 * so the owner never half-finishes onboarding, and a homeowner on a public page is told only that
 * paying online is unavailable.
 *
 * It never gates an account that already exists: terms, account-session and account-link stay
 * open so an org that lost the entitlement can still fix its account and get money it already
 * collected paid out. Nor does it gate the payment event reconciler: events for payments that
 * already exist are recorded whatever the plan says (slices 08-10).
 */

export const ONLINE_PAYMENTS_NOT_IN_PLAN = 'ONLINE_PAYMENTS_NOT_IN_PLAN';
/**
 * The public checkout refusal's code. Neutral on purpose: anyone holding a public link sees this
 * body, so it must not reveal the business's subscription plan. The plan code above is for the
 * signed-in owner only.
 */
export const ONLINE_PAYMENT_UNAVAILABLE = 'ONLINE_PAYMENT_UNAVAILABLE';
export const ONLINE_PAYMENTS_NOT_IN_PLAN_MESSAGE = "Online payments aren't included in your plan.";

/** Whether the signed-in user's org has the entitlement (fails closed with no user). */
export function requestHasOnlinePayments(req: Request): boolean {
  return requestHasFeature(req, 'online_payments');
}

/** The onboarding-start refusal, in the owner's words. */
export const ONLINE_PAYMENTS_NOT_IN_PLAN_REFUSAL = {
  code: ONLINE_PAYMENTS_NOT_IN_PLAN,
  error: ONLINE_PAYMENTS_NOT_IN_PLAN_MESSAGE,
} as const;

/** The org fields the plan resolves from: add to the org select of any public checkout lookup. */
export const ORG_PLAN_SELECT = { plan: true, trial_ends_at: true, feature_overrides: true } as const;

/** Whether an org row (read with ORG_PLAN_SELECT) has online payments in its plan. */
export function onlinePaymentsInPlan(org: { plan: string; trial_ends_at: Date | null; feature_overrides: unknown }): boolean {
  return orgHasFeature(
    {
      plan: org.plan,
      trial_ends_at: org.trial_ends_at,
      feature_overrides: org.feature_overrides as Record<string, unknown> | null,
    },
    'online_payments',
  );
}

/**
 * The refusal a public checkout answers with. Homeowner copy: its code and message say only that
 * paying online is unavailable, never anything about the business's plan or the processor.
 */
export function onlinePaymentsUnavailableRefusal(document: 'invoice' | 'estimate') {
  return { code: ONLINE_PAYMENT_UNAVAILABLE, error: `Paying online isn't available for this ${document}.` };
}
