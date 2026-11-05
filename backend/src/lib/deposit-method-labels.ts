/**
 * #2980 - the words for a deposit method wherever staff read one about a customer's pick: the
 * in-app alert, History and the dashboard's activity line. Never the raw enum value.
 *
 * Card and bank are named as the customer saw them on the estimate page. EXTERNAL_CARD (the
 * customer pays by card over the phone) is "Card by phone", so the office knows to expect a call.
 * The frontend History drawer keeps the same list (features/estimate-workspace/lib/depositMethodHistory.ts).
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

/** A method's words; an unknown value reads as a neutral phrase, never as its code. */
export function depositMethodLabel(method: string | null | undefined): string {
  return (method && DEPOSIT_METHOD_LABELS[method]) || 'another method';
}

/** Card and bank are paid online through the deposit's checkout; every other method by hand. */
export function isOnlineDepositMethod(method: string | null | undefined): boolean {
  return method === 'CARD' || method === 'ACH';
}

export type DepositMethodPick = 'first' | 'changed' | 'same';

/** What a pick is, against the method on file. */
export function depositMethodPick(previous: string | null | undefined, next: string): DepositMethodPick {
  if (!previous) return 'first';
  return previous === next ? 'same' : 'changed';
}

/** The words of a pick: the dashboard's activity line and the in-app alert's title. Never a method code. */
export function depositMethodActivityLine(previous: string | null | undefined, next: string, estimateNumber: string): string {
  return depositMethodPick(previous, next) === 'changed'
    ? `Customer changed the deposit method on ${estimateNumber} from ${depositMethodLabel(previous)} to ${depositMethodLabel(next)}`
    : `Customer chose ${depositMethodLabel(next)} for the deposit on ${estimateNumber}`;
}

/** The in-app alert's second line when the new method is paid by hand (card and bank confirm themselves). */
export const WATCH_FOR_PAYMENT_LINE = 'Watch for incoming payment before marking the deposit as received.';
