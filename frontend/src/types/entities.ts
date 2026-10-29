/**
 * Entity-redesign (Phase 7) shared DTO + enum mirrors.
 *
 * ARCHITECTURE NOTE: this repo has no central entity-type layer — each page/component
 * declares its own inline interface for the entity it renders (see CustomersPage,
 * LeadsPage, EstimateDetailPage, InvoiceDetailPage, JobDetailPage, …). This module is
 * NOT an attempt to consolidate those. It is a single additive home for the brand-new
 * enums and record shapes introduced by the entity redesign so the new api-client
 * functions (and the Phase-8 forms) can type their payloads/results in one place.
 *
 * Mirrors the backend Prisma enums + controller select shapes verified in Phase 7.
 * Money fields are `number | string` because Prisma Decimals serialize as strings over
 * JSON and existing inline interfaces already model them that way.
 */

// ─── Enums (string-literal unions; consumed as plain strings today, so additive-only) ──

/** Customer.kind — Prisma enum (PERSON | COMPANY). */
export type CustomerKind = 'PERSON' | 'COMPANY';

/** Customer.segment — Prisma enum (RESIDENTIAL | COMMERCIAL). */
export type CustomerSegment = 'RESIDENTIAL' | 'COMMERCIAL';

/** Invoice.kind — Prisma enum (DEPOSIT | STANDARD | PLAN). */
export type InvoiceKind = 'DEPOSIT' | 'STANDARD' | 'PLAN';

/**
 * Invoice.status — full backend InvoiceStatus enum incl. the §8 additions
 * PARTIALLY_REFUNDED + DISPUTED. Status is typed `string` at every render site and
 * StatusBadge renders unknown keys via a fallback, so this is documentation/typed-payload
 * use only (no list interface is tightened to it this phase).
 */
export type InvoiceStatus =
  | 'DRAFT'
  | 'SENT'
  | 'PARTIAL'
  | 'PAID'
  | 'VOIDED'
  | 'REFUNDED'
  | 'PARTIALLY_REFUNDED'
  | 'DISPUTED';

/**
 * Refund.reason_category — backend REFUND_CATEGORIES (invoice.controller.ts) /
 * Prisma RefundCategory enum. Mirrors the REASON_CATEGORIES list lifted from
 * RefundDepositDialog.tsx.
 */
export type RefundCategory =
  | 'CUSTOMER_REQUEST'
  | 'ERROR'
  | 'GOODWILL'
  | 'OVERPAYMENT'
  | 'CHARGEBACK'
  | 'OTHER';

/**
 * Payment.void_category — backend voidPaymentSchema enum (invoice.controller.ts) /
 * Prisma VoidPaymentReason enum. CHARGEBACK is set internally by the chargeback path
 * and is included for read-shape completeness.
 */
export type VoidPaymentReason =
  | 'BOUNCED'
  | 'ERROR'
  | 'DUPLICATE'
  | 'WRONG_INVOICE'
  | 'CHARGEBACK';

/** Payment method — backend PaymentMethod (schema.prisma). */
export type PaymentMethod = 'CARD' | 'EXTERNAL_CARD' | 'CASH' | 'CHECK' | 'BANK_TRANSFER' | 'ZELLE' | 'VENMO' | 'CASH_APP' | 'OTHER';

// ─── Customer phone (new repeatable phones[] on Customer) ──────────────────────────────

export interface CustomerPhone {
  phone: string;
  label?: string | null;
  extension?: string | null;
  is_primary?: boolean;
}

// ─── New money-model record shapes (entity-redesign §8) ────────────────────────────────

/**
 * A refund row attached to an Invoice (Invoice.refunds[]).
 * Mirrors the backend Prisma Refund model: it has tax_portion (Decimal) +
 * non_taxable_concession (bool), a required reason_category (RefundCategory) and
 * method (PaymentMethod). There is NO `refunds_tax` column.
 */
export interface Refund {
  id: string;
  invoice_id: string;
  amount: number | string;
  method?: string | null;
  payment_id?: string | null;
  reason?: string | null;
  reason_category?: RefundCategory | null;
  /** Decimal portion of the refund attributable to tax. */
  tax_portion?: number | string;
  /** True when the refund is a non-taxable concession (tax not reversed). */
  non_taxable_concession?: boolean;
  stripe_refund_id?: string | null;
  created_at?: string;
}

/**
 * A credit / give-back row (Invoice.credits[]).
 * Mirrors the backend Prisma Credit model: invoice_id is REQUIRED, the reason
 * bucket is a free-form `category` string. There is NO `customer_id` and NO
 * `reason_category` on this model.
 */
export interface Credit {
  id: string;
  invoice_id: string;
  amount: number | string;
  reason?: string | null;
  /** Backend credit schema uses a free-form `category` string. */
  category?: string | null;
  /** Decimal portion of the credit attributable to tax. */
  tax_portion?: number | string;
  created_at?: string;
}

/** Links a kind=DEPOSIT invoice's credit onto a target (standard) invoice. */
export interface DepositCreditApplication {
  id: string;
  deposit_invoice_id: string;
  target_invoice_id: string;
  amount: number | string;
  created_at?: string;
}

// ─── Statement (entity-redesign §9 — read-only ledger projection) ──────────────────────

export type StatementScope = 'job' | 'customer';

export type StatementLineType = 'invoice' | 'credit' | 'deposit_credit' | 'payment' | 'refund';

/** One running-balance line in a statement (statement.controller buildStatement). */
export interface StatementLine {
  type: StatementLineType;
  date: string | null;
  invoice_id: string;
  invoice_number: string;
  invoice_kind: string;
  customer_id?: string | null;
  customer_name?: string;
  /** Always the positive magnitude shown on the document. */
  amount: number;
  running_balance: number;
}

export interface StatementTotals {
  billed: number;
  paid: number;
  /** Deposit credit drawn down onto job invoices — real cash counted in `paid` on the deposit
   *  invoice, applied here, so it's a distinct column (not double-counted in `paid`). */
  deposit_credit?: number;
  refunded: number;
  credited: number;
  balance: number;
}

/**
 * The JSON statement response. Shape differs slightly by scope:
 *  - job:      { scope, job, lines, totals }
 *  - customer: { scope, customer, members, lines, totals }
 * Modeled with optional scope-specific fields so one type covers both responses.
 */
export interface Statement {
  scope: StatementScope;
  lines: StatementLine[];
  totals: StatementTotals;
  job?: unknown;
  customer?: unknown;
  members?: Array<{
    id: string;
    first_name?: string | null;
    last_name?: string | null;
    company_name?: string | null;
  }>;
}
