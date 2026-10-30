import type { PaymentMethod } from '@/types/entities';
import type { DepositPolicy } from '@/lib/api/organization';
import { PAYMENT_METHOD_ORDER } from '@/lib/payment-methods';

/**
 * Payments go-live slice 21 - what a document's payment-option overrides are compared against.
 *
 * Mirrors the backend resolver's org-defaults read (backend/src/lib/payment-options.ts
 * orgPaymentDefaults): accepted_payment_methods is the only source; CARD and ACH in it are the
 * server-owned "the payout account can take this" facts, and the owner leaves either out of the
 * DEFAULT offer with card_offered_by_default / bank_offered_by_default. A document's override
 * replaces this list. Online methods are still offered only while the account can take them;
 * that filtering happens at resolve time, so an override may list one ahead of time.
 */

export type { DepositPolicy };

export const DEPOSIT_POLICY_LABELS: Record<DepositPolicy, string> = {
  REQUIRED_BEFORE_APPROVAL: 'Require the deposit before approval',
  PAY_LATER: 'Allow approval now, deposit paid later',
};

export const DEFAULT_DEPOSIT_POLICY: DepositPolicy = 'REQUIRED_BEFORE_APPROVAL';

export type OnlineMethod = 'CARD' | 'ACH';

/** The org fields the defaults are read from. Optional where an old backend may omit them. */
export interface OrgPaymentDefaultsSource {
  accepted_payment_methods?: readonly PaymentMethod[] | null;
  stripe_charges_enabled?: boolean | null;
  card_offered_by_default?: boolean | null;
  bank_offered_by_default?: boolean | null;
  deposit_policy?: DepositPolicy | null;
}

/** The online rows, by their short names. Manual methods keep their usual labels. */
export const ONLINE_METHOD_LABELS: Record<OnlineMethod, string> = { CARD: 'Card', ACH: 'Bank' };

/** Why Card or Bank is not offered while the org's plan lacks online payments (slice 16). */
export const NOT_IN_PLAN_NOTE = 'Not included in your plan.';

/**
 * The methods the org offers on a document that has no override of its own. Slice 16: while the
 * plan lacks online payments (`useFeature('online_payments')`) Card and Bank are left out, since
 * the customer's page cannot offer them (the backend resolver drops them the same way).
 */
export function orgDefaultMethods(
  org: OrgPaymentDefaultsSource | null | undefined,
  onlinePaymentsInPlan = true,
): PaymentMethod[] {
  const accepted = org?.accepted_payment_methods ?? [];
  return accepted.filter((m) =>
    (m !== 'CARD' || (onlinePaymentsInPlan && org?.card_offered_by_default !== false))
    && (m !== 'ACH' || (onlinePaymentsInPlan && org?.bank_offered_by_default !== false)));
}

/** Whether the payout account can take this online method right now, and the plan includes it. */
export function onlineMethodActive(
  org: OrgPaymentDefaultsSource | null | undefined,
  method: OnlineMethod,
  onlinePaymentsInPlan = true,
): boolean {
  return onlinePaymentsInPlan && org?.stripe_charges_enabled === true && (org?.accepted_payment_methods ?? []).includes(method);
}

/** The manual methods the org records by hand, in the usual picker order. */
export function orgManualMethods(org: OrgPaymentDefaultsSource | null | undefined): PaymentMethod[] {
  const accepted = org?.accepted_payment_methods ?? [];
  return PAYMENT_METHOD_ORDER.filter((m) => m !== 'CARD' && accepted.includes(m));
}

/** Same methods, ignoring order. */
export function sameMethods(a: readonly PaymentMethod[], b: readonly PaymentMethod[]): boolean {
  return a.length === b.length && a.every((m) => b.includes(m));
}

/** Online first (card, then bank), then the manual methods in the usual picker order. */
const DISPLAY_ORDER: PaymentMethod[] = ['CARD', 'ACH', ...PAYMENT_METHOD_ORDER.filter((m) => m !== 'CARD')];

/** How each method reads inside a sentence ("Org default: Card, bank and check"). */
const IN_SENTENCE: Record<PaymentMethod, string> = {
  CARD: 'card',
  ACH: 'bank',
  EXTERNAL_CARD: 'card on your own processor',
  BANK_TRANSFER: 'bank transfer',
  CHECK: 'check',
  CASH: 'cash',
  ZELLE: 'Zelle',
  VENMO: 'Venmo',
  CASH_APP: 'Cash App',
  OTHER: 'other',
};

/** "Card and bank", "Card, bank and check", "None" - the sentence an "Org default:" line reads. */
export function describeMethods(methods: readonly PaymentMethod[]): string {
  const words = DISPLAY_ORDER.filter((m) => methods.includes(m)).map((m) => IN_SENTENCE[m] ?? m);
  const last = words.pop();
  if (last === undefined) return 'None';
  const sentence = words.length === 0 ? last : `${words.join(', ')} and ${last}`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** Orders a method list for saving: online first, then manual, matching what the rows show. */
export function orderMethods(methods: Iterable<PaymentMethod>): PaymentMethod[] {
  const set = new Set(methods);
  return DISPLAY_ORDER.filter((m) => set.has(m));
}
