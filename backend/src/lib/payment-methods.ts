import { PaymentMethod } from '@prisma/client';
import { z } from 'zod';

export const ALL_PAYMENT_METHODS: PaymentMethod[] = [
  'CARD',
  'EXTERNAL_CARD',
  'CASH',
  'CHECK',
  'BANK_TRANSFER',
  // R5b (2026-07-22) — D3.
  'ZELLE',
  'VENMO',
  'CASH_APP',
  'OTHER',
];

export const acceptedPaymentMethodsSchema = z
  .array(z.nativeEnum(PaymentMethod))
  .refine((arr) => new Set(arr).size === arr.length, {
    message: 'accepted_payment_methods must not contain duplicates',
  });

/**
 * CARD is SERVER-OWNED: its presence in accepted_payment_methods is derived from the org's
 * card-payments connection (stripe_charges_enabled, mirrored from Stripe by the
 * account.updated webhook), never from a client payload.
 *
 * This used to be a validator that 400'd a submission which added CARD without charges, or
 * dropped CARD with charges live. Both rules were unenforceable in practice on the surface
 * that submits this field: Settings -> Payments & Lists renders NO CARD toggle at all (it is
 * filtered out of the checkbox list), yet it PATCHes the WHOLE array from the org snapshot it
 * loaded. Any snapshot taken before charges went live - a tab left open across the webhook, a
 * concurrent admin, a 5-minute-stale query cache - carries no CARD, so an unrelated edit
 * (turning Venmo on) read as "disable Credit Card" and 400'd a save the user never asked for,
 * naming a control they cannot see. Resolving instead of validating makes that class
 * impossible: a stale array can no longer express an intent about CARD either way.
 *
 * Order: submitted order is preserved for everything else, CARD appended last, matching what
 * the webhook writes ([...methods, 'CARD']).
 */
export function resolveAcceptedPaymentMethods(
  submitted: PaymentMethod[],
  chargesEnabled: boolean,
): PaymentMethod[] {
  const withoutCard = submitted.filter((m) => m !== 'CARD');
  return chargesEnabled ? [...withoutCard, 'CARD'] : withoutCard;
}

export function publicCardRoute(
  sendConfigMethods: PaymentMethod[],
): 'STRIPE' | 'CALL_US' | 'NONE' {
  if (sendConfigMethods.includes('CARD')) return 'STRIPE';
  if (sendConfigMethods.includes('EXTERNAL_CARD')) return 'CALL_US';
  return 'NONE';
}
