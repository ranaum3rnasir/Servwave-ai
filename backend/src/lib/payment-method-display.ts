/**
 * How a customer-facing message names the way a card payment was made: the wallet when one was
 * used ("Link", "Apple Pay", "Google Pay"), else the card ("Visa ending 4242"), else "Card".
 * Words only a customer would use; never a processor's name.
 */
import type { PaymentWallet } from '@prisma/client';

const WALLET_LABELS: Record<PaymentWallet, string> = {
  APPLE_PAY: 'Apple Pay',
  GOOGLE_PAY: 'Google Pay',
  LINK: 'Link',
};

const titleCase = (brand: string): string => brand.charAt(0).toUpperCase() + brand.slice(1).toLowerCase();

export function cardPaymentDisplay(p: { wallet: PaymentWallet | null; card_brand: string | null; card_last4: string | null }): string {
  if (p.wallet) return WALLET_LABELS[p.wallet];
  if (p.card_brand && p.card_last4) return `${titleCase(p.card_brand)} ending ${p.card_last4}`;
  if (p.card_last4) return `Card ending ${p.card_last4}`;
  return 'Card';
}

/** How a bank payment is named to the customer: "Bank •••• 6789", or "Bank account" when the last four are unknown. */
export function bankPaymentDisplay(last4: string | null | undefined): string {
  return last4 ? `Bank \u2022\u2022\u2022\u2022 ${last4}` : 'Bank account';
}
