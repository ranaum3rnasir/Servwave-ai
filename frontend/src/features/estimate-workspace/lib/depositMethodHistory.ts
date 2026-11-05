import type { EstimateActivityEvent } from './estimateHistoryTimeline';

/**
 * #2980 - a deposit method in the words the customer picked it by. The backend's
 * `lib/deposit-method-labels.ts` holds the same list for the office email. Never the method code.
 */
export const DEPOSIT_METHOD_LABELS: Record<string, string> = {
  CARD: 'Credit/Debit Card',
  ACH: 'Bank Account',
  EXTERNAL_CARD: 'Card by phone',
  CHECK: 'Check',
  BANK_TRANSFER: 'Bank transfer',
  CASH: 'Cash',
  ZELLE: 'Zelle',
  VENMO: 'Venmo',
  CASH_APP: 'Cash App',
  OTHER: 'Other',
};

function methodWords(code: unknown): string | null {
  return typeof code === 'string' ? DEPOSIT_METHOD_LABELS[code] ?? null : null;
}

/**
 * The History sentence for a deposit method pick: it names the method, and a change names both
 * ("Customer changed the deposit method from Check to Credit/Debit Card"). Null for any other
 * event, and for a pick recorded before the method rode the event (or with a method this list
 * does not know): the drawer then keeps its generic line, so no code ever reaches the screen.
 */
export function depositMethodEventLabel(event: Pick<EstimateActivityEvent, 'action' | 'metadata'>): string | null {
  if (event.action !== 'estimate.deposit_method_selected') return null;
  const next = methodWords(event.metadata?.method);
  const previous = methodWords(event.metadata?.previous_method);
  if (next && previous) return `Customer changed the deposit method from ${previous} to ${next}`;
  if (next) return `Customer chose ${next} for the deposit`;
  return null;
}
