import type { PaymentMethod } from '@/lib/api/organization';

// User-facing copy only. The processor behind CARD is Stripe, but that name never appears in the
// UI (Ran, 2026-08-04) - orgs and their customers see the payment METHOD, not the vendor we route
// it through. Code, comments and internal flags still say Stripe so the wiring stays traceable.
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  CARD: 'Credit Card',
  // Still distinct from CARD: this is the org running cards on its own processor/terminal, which
  // the Payments & Lists picker must be able to tell apart from card payments we process.
  EXTERNAL_CARD: 'Card (outside ServWave)',
  // Payments go-live slice 28: ACH names the online bank debit only; a hand-recorded transfer is just a
  // bank transfer.
  BANK_TRANSFER: 'Bank transfer',
  CHECK: 'Check',
  CASH: 'Cash',
  // R5b (2026-07-22) — D3.
  ZELLE: 'Zelle',
  VENMO: 'Venmo',
  CASH_APP: 'Cash App',
  OTHER: 'Other',
  // Payments go-live slice 04: an ONLINE bank debit the customer made through ServWave Payments.
  // Deliberately absent from PAYMENT_METHOD_ORDER below: that list feeds the pickers where staff
  // record, refund or accept a payment by hand, and a hand-recorded transfer is BANK_TRANSFER.
  ACH: 'Bank (ACH)',
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
