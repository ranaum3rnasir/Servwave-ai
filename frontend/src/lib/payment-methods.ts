import type { PaymentMethod } from '@/lib/api/organization';

// User-facing copy only. The processor behind CARD is Stripe, but that name never appears in the
// UI (Ran, 2026-08-04) - orgs and their customers see the payment METHOD, not the vendor we route
// it through. Code, comments and internal flags still say Stripe so the wiring stays traceable.
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  CARD: 'Credit Card',
  // Still distinct from CARD: this is the org running cards on its own processor/terminal, which
  // the Payments & Lists picker must be able to tell apart from card payments we process.
  EXTERNAL_CARD: 'External Credit Card Processor',
  BANK_TRANSFER: 'Bank Transfer (ACH)',
  CHECK: 'Check',
  CASH: 'Cash',
  // R5b (2026-07-22) — D3.
  ZELLE: 'Zelle',
  VENMO: 'Venmo',
  CASH_APP: 'Cash App',
  OTHER: 'Other',
};

export const PAYMENT_METHOD_ORDER: PaymentMethod[] = [
  'CARD',
  'EXTERNAL_CARD',
  'BANK_TRANSFER',
  'CHECK',
  'CASH',
  'ZELLE',
  'VENMO',
  'CASH_APP',
  'OTHER',
];
