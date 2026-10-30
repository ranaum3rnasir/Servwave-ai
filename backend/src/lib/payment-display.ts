/**
 * How a payment reads on one line: the card brand and last four, the wallet it came through, or
 * the bank and its last four. Backend twin of the frontend `describePayment` (lib/payment-display.ts)
 * so the payments report reads exactly like the ledger. Nothing here names the processor.
 */
export interface PaymentDisplayInput {
  method: string;
  wallet?: string | null;
  cardBrand?: string | null;
  cardLast4?: string | null;
  bankName?: string | null;
  bankLast4?: string | null;
}

const DOTS = '••••';

/**
 * The processor's sandbox reports its own brand as the bank name ("STRIPE TEST BANK"), and "Test Bank" is
 * the generic sandbox label (exactly; a real bank such as "First Test Bank" stays). Neither is a customer's bank, and the processor's name must never be shown, so
 * both read as no bank name. Live mode reports the customer's real bank, which passes through untouched.
 */
const PROCESSOR_BANK_NAME = /stripe|^test bank$/i;

export function publicBankName(name: string | null | undefined): string | null {
  const trimmed = name?.trim();
  if (!trimmed || PROCESSOR_BANK_NAME.test(trimmed)) return null;
  return trimmed;
}

const CARD_BRANDS: Record<string, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  discover: 'Discover',
  diners: 'Diners Club',
  jcb: 'JCB',
  unionpay: 'UnionPay',
};

const WALLETS: Record<string, string> = { APPLE_PAY: 'Apple Pay', GOOGLE_PAY: 'Google Pay' };

function tidy(code: string): string {
  const words = code.replace(/_/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function cardLine(p: PaymentDisplayInput): string {
  const brand = p.cardBrand ? (CARD_BRANDS[p.cardBrand.toLowerCase()] ?? tidy(p.cardBrand)) : null;
  const last4 = p.cardLast4 ? `${DOTS} ${p.cardLast4}` : null;
  if (brand && last4) return `${brand} ${last4}`;
  return brand ?? last4 ?? '';
}

/** The report's "Card" cell: details of an online card or bank payment, else ''. */
export function describePaymentDetail(p: PaymentDisplayInput): string {
  if (p.method === 'ACH') {
    const bankName = publicBankName(p.bankName);
    if (bankName && p.bankLast4) return `${bankName} ${DOTS} ${p.bankLast4}`;
    if (bankName) return bankName;
    if (p.bankLast4) return `Bank ${DOTS} ${p.bankLast4}`;
    return '';
  }
  if (p.method === 'CARD') {
    if (p.wallet === 'LINK') return 'Link';
    const card = cardLine(p);
    const wallet = p.wallet ? WALLETS[p.wallet] : undefined;
    if (wallet) return card ? `${wallet} (${card})` : wallet;
    return card;
  }
  return '';
}
