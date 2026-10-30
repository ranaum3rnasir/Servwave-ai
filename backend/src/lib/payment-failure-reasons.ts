/**
 * Payouts slice P2 - why a payment, refund or payout failed, in ServWave's own words.
 *
 * The processor's failure codes are stored as they arrive (payments.failure_code, refunds.failure_code,
 * payouts.failure_code) and are never shown. Anything that reaches a response or a screen goes through
 * describeFailure, so no processor wording and no vendor name leaves the backend.
 */

const BANK_DID_NOT_ACCEPT = 'The bank did not accept the payment';

const WORDS: Record<string, string> = {
  insufficient_funds: 'Insufficient funds',
  account_closed: 'The bank account is closed',
  no_account: BANK_DID_NOT_ACCEPT,
  debit_not_authorized: BANK_DID_NOT_ACCEPT,
  could_not_process: BANK_DID_NOT_ACCEPT,
  bank_account_restricted: BANK_DID_NOT_ACCEPT,
  invalid_account_number: BANK_DID_NOT_ACCEPT,
  authorization_revoked_by_customer: BANK_DID_NOT_ACCEPT,
  bank_ownership_changed: BANK_DID_NOT_ACCEPT,
};

export const FAILURE_FALLBACK = 'The payment did not go through';

export function describeFailure(code: string | null | undefined): string {
  if (!code) return FAILURE_FALLBACK;
  return Object.prototype.hasOwnProperty.call(WORDS, code) ? WORDS[code] : FAILURE_FALLBACK;
}

/** Why a refund did not reach the customer; the refund's own fallback sentence when the reason is unknown. */
export function describeRefundFailure(code: string | null | undefined): string {
  const d = describeFailure(code);
  return d === FAILURE_FALLBACK ? 'The refund did not reach the customer' : d;
}

const DISPUTE_FALLBACK = 'The customer disputed this payment';

const DISPUTE_WORDS: Record<string, string> = {
  fraudulent: 'The cardholder says they did not make this payment',
  product_not_received: 'The customer says they did not receive the service',
  product_unacceptable: 'The customer says the service was not as described',
  duplicate: 'The customer says they were charged twice',
  subscription_canceled: 'The customer says they canceled the plan',
  credit_not_processed: 'The customer says a refund was never given',
  unrecognized: 'The customer does not recognise this payment',
  general: DISPUTE_FALLBACK,
  bank_cannot_process: 'The bank returned this payment',
  insufficient_funds: 'The bank returned this payment: insufficient funds',
  debit_not_authorized: 'The customer says they did not authorise this bank debit',
};

/** Why a customer disputed a payment, in ServWave's words. An unknown code reads the generic line, never the code itself. */
export function describeDisputeReason(code: string | null | undefined): string {
  if (!code) return DISPUTE_FALLBACK;
  return Object.prototype.hasOwnProperty.call(DISPUTE_WORDS, code) ? DISPUTE_WORDS[code] : DISPUTE_FALLBACK;
}
