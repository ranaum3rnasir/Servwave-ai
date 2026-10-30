import type { Request, Response } from 'express';
import type { PaymentMethod } from '@prisma/client';
import { prisma } from '../prisma';
import { ALL_PAYMENT_METHODS } from '../payment-methods';
import { ALL_ACCEPTED_METHODS, type SwitchValue } from './switches/catalog';
import { resolveSwitches } from './switches/store';

/**
 * The payment-method checks for recording a payment (Roles & Permissions, PRD 1, "Record payments").
 *
 * A payment recorded by hand (an invoice payment, an estimate deposit) needs a method that is in the company's
 * effective accepted list AND in the person's Allowed payment methods. Both are read here, at the time of the
 * payment, so a change to the company's list shows on the very next one.
 */

/** The online-only methods the processor connection owns: never a tick box, and kept out of the manual list. */
const SERVER_OWNED: readonly string[] = ['CARD', 'ACH'];

export interface EffectiveAcceptedMethods {
  /** The company ticked no method, so every method counts as accepted. */
  everyMethod: boolean;
  /** The methods the company accepts: every payment method when none was ticked. */
  methods: PaymentMethod[];
}

/** The org fields the effective list reads. */
export interface AcceptedMethodsOrg {
  accepted_payment_methods: unknown;
  stripe_charges_enabled?: boolean | null;
}

/**
 * The company's effective accepted list (one definition, shared with the screens and dialogs): the methods ticked in
 * Payments & Lists, plus Credit Card while the card processor is live. Credit Card is never a tick box; it is accepted
 * only through the processor connection, which the stored list mirrors (Credit Card is in it while charges are enabled
 * and the card capability is active). The list is read by this definition, not as whatever is stored.
 *
 * When the company ticked no method (the stored list is empty, or holds only the processor-owned methods) every method
 * counts as accepted, which is what the product did before the list was checked: without it a company that never filled
 * in Payments & Lists, or one with a live processor and nothing ticked, would lose payment recording for everyone.
 */
export function effectiveAcceptedMethods(org: AcceptedMethodsOrg): EffectiveAcceptedMethods {
  const stored = Array.isArray(org.accepted_payment_methods) ? (org.accepted_payment_methods as unknown[]) : [];
  const ticked = stored.filter((m): m is PaymentMethod => typeof m === 'string' && !SERVER_OWNED.includes(m) && ALL_PAYMENT_METHODS.includes(m as PaymentMethod));
  if (ticked.length === 0) return { everyMethod: true, methods: [...ALL_PAYMENT_METHODS] };
  const cardLive = org.stripe_charges_enabled === true && stored.includes('CARD');
  return { everyMethod: false, methods: cardLive ? [...ticked, 'CARD'] : ticked };
}

/**
 * Whether this method may be recorded: the company accepts it, and it is in the person's Allowed payment methods
 * ("All accepted methods" is the company's list itself; a fixed subset is intersected with it).
 */
export function methodAllowedFor(method: string, company: EffectiveAcceptedMethods, personValue: SwitchValue | undefined): boolean {
  if (!company.methods.includes(method as PaymentMethod)) return false;
  if (personValue === ALL_ACCEPTED_METHODS) return true;
  return Array.isArray(personValue) && personValue.includes(method);
}

export const METHOD_NOT_ACCEPTED = 'Your company does not accept that payment method.';
export const METHOD_NOT_ALLOWED = 'You are not allowed to record that payment method.';

/**
 * The server check behind Allowed payment methods. Answers the refusal to send (and sends nothing itself), or null
 * when the requester may record this method. The company is the requester's own.
 */
export async function paymentMethodRefusal(req: Request, method: string): Promise<{ status: number; error: string } | null> {
  const org = await prisma.organization.findUnique({
    where: { id: req.user!.organization_id },
    select: { accepted_payment_methods: true, stripe_charges_enabled: true },
  });
  const company = effectiveAcceptedMethods(org ?? { accepted_payment_methods: [] });
  if (!company.methods.includes(method as PaymentMethod)) return { status: 403, error: METHOD_NOT_ACCEPTED };
  const personValue = (await resolveSwitches(req.user!)).allowed_payment_methods;
  if (!methodAllowedFor(method, company, personValue)) return { status: 403, error: METHOD_NOT_ALLOWED };
  return null;
}

/** `paymentMethodRefusal`, answered on the response: true when the request was refused (the caller returns). */
export async function refuseDisallowedPaymentMethod(req: Request, res: Response, method: string): Promise<boolean> {
  const refusal = await paymentMethodRefusal(req, method);
  if (!refusal) return false;
  res.status(refusal.status).json({ error: refusal.error });
  return true;
}
