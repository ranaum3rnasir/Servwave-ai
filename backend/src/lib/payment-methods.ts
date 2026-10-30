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
 * The method on a payment a person records by hand (invoice Record Payment, estimate Record
 * Payment). ACH is refused: it means an ONLINE bank debit taken through ServWave Payments and
 * only the processor flow may create one, because later stages (settlement, failure, refund
 * window, reconcile) assume an ACH row has a processor charge behind it. A bank payment the
 * business received outside ServWave is BANK_TRANSFER.
 */
export const manualPaymentMethodSchema = z
  .nativeEnum(PaymentMethod)
  .refine((m) => m !== 'ACH', {
    message:
      'Online bank payments are collected through ServWave Payments. To record a bank payment you received, choose Bank Transfer.',
  });

/**
 * What the connected account can take, as the account-status sync learns it from the processor.
 * The card and bank-debit capabilities are not columns: the sync writes them into
 * accepted_payment_methods as CARD and ACH, and that is the only place they are kept.
 */
export interface AccountCapabilities {
  chargesEnabled: boolean;
  cardCapabilityActive: boolean;
  achCapabilityActive: boolean;
}

/**
 * THE rule for CARD and ACH in accepted_payment_methods (payments go-live slices 10, 16, 19):
 * - CARD is there while charges are enabled AND the card capability is active;
 * - ACH is there while charges are enabled AND the bank-debit capability is active.
 * An account that cannot take charges takes no payment of either kind, whatever a capability
 * reads. Every other method and its order are kept; a missing CARD, then ACH, is appended last.
 *
 * Both writers of the list go through it: the account-status sync (syncedAcceptedMethods) with the
 * processor's answer, and a settings save (resolveAcceptedPaymentMethods) with the stored answer.
 * CARD here means "the account can take cards", not "card is offered by default": the owner's
 * default offer of either lives in organizations.card_offered_by_default and
 * bank_offered_by_default, read by lib/payment-options.ts.
 */
export function withAccountCapabilities(methods: readonly PaymentMethod[], capabilities: AccountCapabilities): PaymentMethod[] {
  const card = capabilities.chargesEnabled && capabilities.cardCapabilityActive;
  const ach = capabilities.chargesEnabled && capabilities.achCapabilityActive;
  const next = methods.filter((m) => (m !== 'CARD' || card) && (m !== 'ACH' || ach));
  if (card && !next.includes('CARD')) next.push('CARD');
  if (ach && !next.includes('ACH')) next.push('ACH');
  return next;
}

/**
 * The accepted methods a settings save stores. CARD and ACH are SERVER-OWNED: a payload can
 * neither add nor remove them. The page PATCHes the whole array from the org snapshot it loaded,
 * so a stale snapshot (a tab left open across an account event, a concurrent admin) must not be
 * able to express an intent about either. Resolving instead of validating makes that impossible.
 *
 * Only the account-status sync learns the capabilities from the processor, and it records them in
 * the stored list. So a save takes them from there, under the same rule the sync applies
 * (withAccountCapabilities), with the stored charges flag: it keeps exactly the CARD and ACH the
 * last sync wrote, and never puts back one the sync removed (slice 10 review). Submitted order is
 * preserved for everything else, CARD then ACH appended last, matching what the sync writes.
 */
export function resolveAcceptedPaymentMethods(
  submitted: PaymentMethod[],
  chargesEnabled: boolean,
  /** The org's accepted methods as stored today: the source of the CARD and ACH facts. */
  stored: unknown,
): PaymentMethod[] {
  const storedMethods = Array.isArray(stored) ? (stored as unknown[]) : [];
  const manual = submitted.filter((m) => m !== 'CARD' && m !== 'ACH');
  return withAccountCapabilities(manual, {
    chargesEnabled,
    cardCapabilityActive: storedMethods.includes('CARD'),
    achCapabilityActive: storedMethods.includes('ACH'),
  });
}

/**
 * The accepted methods after an account-status sync (the account events through the payment event
 * reconciler, and the status refresh), or null when nothing changes. The capabilities are the
 * processor's answer about the account; withAccountCapabilities decides CARD and ACH. The
 * reconciler does not consult the accepted methods for money events, so a restricted account's
 * refunds, disputes and bank settlements are still recorded.
 */
export function syncedAcceptedMethods(stored: unknown, capabilities: AccountCapabilities): PaymentMethod[] | null {
  const methods = (Array.isArray(stored) ? stored : []) as PaymentMethod[];
  const next = withAccountCapabilities(methods, capabilities);
  const changed = next.length !== methods.length || next.some((m, i) => m !== methods[i]);
  return changed ? next : null;
}

export function publicCardRoute(
  sendConfigMethods: PaymentMethod[],
): 'STRIPE' | 'CALL_US' | 'NONE' {
  if (sendConfigMethods.includes('CARD')) return 'STRIPE';
  if (sendConfigMethods.includes('EXTERNAL_CARD')) return 'CALL_US';
  return 'NONE';
}
