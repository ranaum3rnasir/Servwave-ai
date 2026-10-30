// Payments report (catalog F5) — pure mapping, no Prisma/Express so it
// unit-tests with fixtures and shares the row shape with the frontend.
//
// Produces the same `PaymentTxn[]` rows the frontend Payments report renders
// (see frontend/src/pages/reports/payments-report-data.ts). The frontend owns
// ALL filtering/aggregation (date presets, KPIs, category breakdown, weekly
// trend) in payments-report-logic.ts, so this service only normalizes one
// Prisma payment row → one transaction row. Demo + live therefore stay in
// lockstep: the same logic runs over mock rows (demo) and these live rows (real).

import type { PaymentMethod } from '@prisma/client';
import { describePaymentDetail } from '../lib/payment-display';

// Frontend label unions (mirrored here so the DTO is self-describing without a
// cross-package import). Kept identical to payments-report-data.ts.
export type PaymentMethodLabel = 'Credit card' | 'Card (outside ServWave)' | 'Check' | 'Bank transfer' | 'Bank (ACH)' | 'Cash' | 'Zelle' | 'Venmo' | 'Cash App' | 'Other';
export type PaymentCategoryLabel = 'Invoice' | 'Deposit' | 'Account' | 'Recurring';
export type PaymentStatusLabel = 'Succeeded' | 'Pending' | 'Failed' | 'Voided' | 'Charged back' | 'Partly refunded' | 'Refunded';

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
  card: string; // brand + last four (or bank + last four), as the ledger reads, else ''
  technician: string; // collected_by user display name, else 'Dispatch'; '' for an online payment (nobody collected it)
  txnKind: string; // 'Online' when the customer paid it themselves, else 'Keyed'
  confirmation: string; // processor note for card/ACH ('Approved'), else ''
  // #498 - true when this row is the synthetic payment written on a STANDARD invoice to apply a
  // deposit already collected (reference_number = DEPOSIT-CREDIT). It is NOT new money: the same
  // dollars were already banked as the deposit's own payment row. The frontend renders it (it is
  // how the customer's balance cleared) but excludes it from every sum.
  isDepositCredit: boolean;
}

/**
 * Payment.method, as the database enum itself (a type-only import: this module stays free of
 * Prisma at runtime). A method added to the enum then fails to compile here until it has a label,
 * instead of reaching the report unlabelled (payments go-live slice 13: ACH was missed once).
 */
export type DbPaymentMethod = PaymentMethod;
/** Prisma enum string for Invoice.kind. */
export type DbInvoiceKind = 'DEPOSIT' | 'STANDARD' | 'PLAN';

/** One payment normalized from the Prisma row by the controller. */
export interface PaymentInput {
  id: string;
  amount: number;
  method: DbPaymentMethod;
  paidAt: Date;
  refundedAt: Date | null;
  // What went back so far (Payment.refunded_amount); null on a row from before it was kept.
  refundedAmount: number | null;
  voidedAt: Date | null;
  // Why it was voided (Payment.void_category); a payment lost to a dispute reads Charged back.
  voidCategory?: string | null;
  // Resolved by the controller against DEPOSIT_CREDIT_REFERENCE - this module stays free of
  // Prisma/controller imports, so it receives the verdict rather than the raw reference string.
  isDepositCredit: boolean;
  invoiceKind: DbInvoiceKind;
  customerName: string;
  customerEmail: string | null;
  collectorName: string | null;
  // The customer paid it themselves (a checkout or bank debit through ServWave Payments): no one keyed or collected it.
  paidOnline?: boolean;
  tipAmount: number;
  // How it was paid, as stored on the payment row (display only; all optional, older rows have none).
  wallet?: string | null;
  cardBrand?: string | null;
  cardLast4?: string | null;
  bankName?: string | null;
  bankLast4?: string | null;
}

// CARD → "Credit card"; EXTERNAL_CARD (a card taken outside ServWave) → "Card (outside ServWave)"; BANK_TRANSFER (recorded by hand) → "Bank transfer"; ACH (an
// online bank debit) → "Bank (ACH)". ACH names the online debit only (payments go-live slice 28).
const METHOD_LABEL: Record<DbPaymentMethod, PaymentMethodLabel> = {
  CARD: 'Credit card',
  EXTERNAL_CARD: 'Card (outside ServWave)',
  CASH: 'Cash',
  CHECK: 'Check',
  BANK_TRANSFER: 'Bank transfer',
  ACH: 'Bank (ACH)',
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
 * Payment status as the report sees it. The report lists only payments that SUCCEEDED, so a live
 * payment reads Succeeded unless it was later voided (Voided) or refunded: Refunded when all of it
 * went back, Partly refunded when only part did (slice 28). A refund with no recorded amount
 * predates the column and was always the whole payment. Refund wins over void when both are set
 * (a refund is the meaningful outcome).
 */
export function statusLabel(p: { amount: number; refundedAt: Date | null; refundedAmount: number | null; voidedAt: Date | null; voidCategory?: string | null }): PaymentStatusLabel {
  if (p.refundedAt) {
    return p.refundedAmount != null && Math.round(p.refundedAmount * 100) < Math.round(p.amount * 100) ? 'Partly refunded' : 'Refunded';
  }
  if (p.voidedAt) return p.voidCategory === 'CHARGEBACK' ? 'Charged back' : 'Voided';
  return 'Succeeded';
}

/** Map one Prisma payment row → the report's transaction row. */
export function toPaymentRow(p: PaymentInput): PaymentRowDto {
  const method = methodLabel(p.method);
  const isCardOrAch = p.method === 'CARD' || p.method === 'EXTERNAL_CARD' || p.method === 'BANK_TRANSFER' || p.method === 'ACH';
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
    card: describePaymentDetail(p),
    technician: p.paidOnline ? '' : (p.collectorName ?? 'Dispatch'),
    txnKind: p.paidOnline ? 'Online' : 'Keyed',
    confirmation: isCardOrAch ? 'Approved' : '',
    isDepositCredit: p.isDepositCredit,
  };
}

/** Build the report payload: all org payments mapped to rows, newest first. */
export function buildPaymentsReport(payments: PaymentInput[]): { payments: PaymentRowDto[] } {
  const rows = payments.map(toPaymentRow).sort((a, b) => b.date - a.date);
  return { payments: rows };
}
