// Payments report (catalog F5) — pure mapping, no Prisma/Express so it
// unit-tests with fixtures and shares the row shape with the frontend.
//
// Produces the same `PaymentTxn[]` rows the frontend Payments report renders
// (see frontend/src/pages/reports/payments-report-data.ts). The frontend owns
// ALL filtering/aggregation (date presets, KPIs, category breakdown, weekly
// trend) in payments-report-logic.ts, so this service only normalizes one
// Prisma payment row → one transaction row. Demo + live therefore stay in
// lockstep: the same logic runs over mock rows (demo) and these live rows (real).

// Frontend label unions (mirrored here so the DTO is self-describing without a
// cross-package import). Kept identical to payments-report-data.ts.
export type PaymentMethodLabel = 'Credit card' | 'Check' | 'ACH / Bank transfer' | 'Cash' | 'Zelle' | 'Venmo' | 'Cash App' | 'Other';
export type PaymentCategoryLabel = 'Invoice' | 'Deposit' | 'Account' | 'Recurring';
export type PaymentStatusLabel = 'Succeeded' | 'Pending' | 'Failed' | 'Refunded';

/** The transaction row the report renders — mirrors the frontend `PaymentTxn`. */
export interface PaymentRowDto {
  id: string;
  date: number; // epoch ms (paid_at)
  amount: number;
  tip: number;
  method: PaymentMethodLabel;
  category: PaymentCategoryLabel;
  status: PaymentStatusLabel;
  client: string;
  email: string;
  card: string; // masked last-4 for card payments, else ''
  technician: string; // collected_by user display name, else 'Dispatch'
  txnKind: string; // Keyed / Client portal / … — not modeled live → 'Keyed'
  confirmation: string; // processor note for card/ACH ('Approved'), else ''
  // #498 - true when this row is the synthetic payment written on a STANDARD invoice to apply a
  // deposit already collected (reference_number = DEPOSIT-CREDIT). It is NOT new money: the same
  // dollars were already banked as the deposit's own payment row. The frontend renders it (it is
  // how the customer's balance cleared) but excludes it from every sum.
  isDepositCredit: boolean;
}

/** Prisma enum string for Payment.method. */
export type DbPaymentMethod = 'CARD' | 'EXTERNAL_CARD' | 'CASH' | 'CHECK' | 'BANK_TRANSFER' | 'ZELLE' | 'VENMO' | 'CASH_APP' | 'OTHER';
/** Prisma enum string for Invoice.kind. */
export type DbInvoiceKind = 'DEPOSIT' | 'STANDARD' | 'PLAN';

/** One payment normalized from the Prisma row by the controller. */
export interface PaymentInput {
  id: string;
  amount: number;
  method: DbPaymentMethod;
  paidAt: Date;
  refundedAt: Date | null;
  voidedAt: Date | null;
  // Resolved by the controller against DEPOSIT_CREDIT_REFERENCE - this module stays free of
  // Prisma/controller imports, so it receives the verdict rather than the raw reference string.
  isDepositCredit: boolean;
  invoiceKind: DbInvoiceKind;
  customerName: string;
  customerEmail: string | null;
  collectorName: string | null;
  tipAmount: number;
}

// CARD / EXTERNAL_CARD → "Credit card"; BANK_TRANSFER → "ACH / Bank transfer".
const METHOD_LABEL: Record<DbPaymentMethod, PaymentMethodLabel> = {
  CARD: 'Credit card',
  EXTERNAL_CARD: 'Credit card',
  CASH: 'Cash',
  CHECK: 'Check',
  BANK_TRANSFER: 'ACH / Bank transfer',
  // R5b (2026-07-22) — D3.
  ZELLE: 'Zelle',
  VENMO: 'Venmo',
  CASH_APP: 'Cash App',
  OTHER: 'Other',
};

// Invoice.kind → report category. There is no "Account" kind in the schema;
// PLAN (recurring service plans) maps to "Recurring".
const CATEGORY_LABEL: Record<DbInvoiceKind, PaymentCategoryLabel> = {
  STANDARD: 'Invoice',
  DEPOSIT: 'Deposit',
  PLAN: 'Recurring',
};

export function methodLabel(m: DbPaymentMethod): PaymentMethodLabel {
  return METHOD_LABEL[m];
}

export function categoryLabel(kind: DbInvoiceKind): PaymentCategoryLabel {
  return CATEGORY_LABEL[kind];
}

/**
 * Payment status as the report sees it. Live payments are recorded only once
 * the money has landed (there is no "pending payment" row), so a live payment is
 * Succeeded unless it was later voided (→ Failed) or refunded (→ Refunded).
 * Refund wins over void when both are set (a refund is the meaningful outcome).
 */
export function statusLabel(p: { refundedAt: Date | null; voidedAt: Date | null }): PaymentStatusLabel {
  if (p.refundedAt) return 'Refunded';
  if (p.voidedAt) return 'Failed';
  return 'Succeeded';
}

/** Last-4 mask for card payments (no PAN is stored, so this is a placeholder). */
function cardMask(method: DbPaymentMethod): string {
  return method === 'CARD' || method === 'EXTERNAL_CARD' ? 'XXXX••••' : '';
}

/** Map one Prisma payment row → the report's transaction row. */
export function toPaymentRow(p: PaymentInput): PaymentRowDto {
  const method = methodLabel(p.method);
  const isCardOrAch = p.method === 'CARD' || p.method === 'EXTERNAL_CARD' || p.method === 'BANK_TRANSFER';
  return {
    id: p.id,
    date: p.paidAt.getTime(),
    amount: p.amount,
    tip: p.tipAmount,
    method,
    category: categoryLabel(p.invoiceKind),
    status: statusLabel(p),
    client: p.customerName || 'Unknown',
    email: p.customerEmail ?? '',
    card: cardMask(p.method),
    technician: p.collectorName ?? 'Dispatch',
    txnKind: 'Keyed', // transaction origin isn't modeled in the schema
    confirmation: isCardOrAch ? 'Approved' : '',
    isDepositCredit: p.isDepositCredit,
  };
}

/** Build the report payload: all org payments mapped to rows, newest first. */
export function buildPaymentsReport(payments: PaymentInput[]): { payments: PaymentRowDto[] } {
  const rows = payments.map(toPaymentRow).sort((a, b) => b.date - a.date);
  return { payments: rows };
}
