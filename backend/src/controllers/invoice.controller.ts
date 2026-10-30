import { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma, PriceBookItemType, PaymentMethod } from '@prisma/client';
import type { RefundCategory, RefundState } from '@prisma/client';
import { applyFilters } from '../lib/query/filterEngine';
import { invoiceFacets } from '../lib/query/registries/invoice.filters';
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
// Creator tracking (audit only) - stamped at every create, never read for authorization here.
import { createdByUser } from '../lib/created-by';
import { env } from '../config/env';
import { parsePagination, buildPaginationMeta, parseSortParams, respondInvalidSort } from '../lib/pagination';
import { INVOICE_SORT_FIELDS } from '../lib/sortFields';
import { COMPLETED_OR_LATER_JOB_STATUSES } from '../lib/job-status-order';
import { logger } from '../lib/logger';
import { ADDRESS_NEEDED_REFUSAL, handSenderOrRefusal, type HandSender } from '../lib/mailbox/hand-sender';
import { resolveOrAccreteLocation, LocationResolutionError, type LocationAddress } from '../lib/service-location';
import {
  sendInvoiceEmail,
  sendPaymentReceivedEmail,
  sendInvoiceRefundNotification,
} from '../lib/email';
import type { EmailDispatchResult } from '../lib/email';
import { cancelPaymentIntent, createCheckoutSession, createRefund, getStripeForOrg, isStripeConfigured, expireCheckoutSession, expireOpenCheckoutSessionsForInvoice } from '../lib/stripe';
import { orgPaymentCapabilities, paymentOptionsFor, storedMethodsOverride, tipPresetAmountsCents } from '../lib/payment-options';
import { exceedsPayableNow, payableNowCents, priceCheckout, processingBlocksHandPaymentMessage, type CheckoutMethod } from '../lib/checkout-pricing';
import { generateInvoicePdf } from '../lib/pdf';
import { invoicePdfSelect, toInvoiceForPdf } from '../lib/pdf/invoice-select';
import { scopeWhereForReq, canAccessRow, canSeeCosts } from '../lib/permissions/enforce';
import { invoiceActionsFor } from '../lib/permissions/documentActions';
import { invoiceDonePriceRefusal } from '../lib/permissions/jobLock';
import { presentInvoiceDetail, isCustomerReadable, resolveTokenAnchor } from '../lib/permissions/customerContact';
import { isCustomerReadableRow, CUSTOMER_PROOF_SELECT } from '../lib/permissions/customerScope';
import { addOrFilter } from '../lib/permissions/whereCompose';
import { tenantWhere } from '../lib/tenant';
import { loadTagsByEntity, loadTagsForEntity } from '../lib/tags';
import { allocateNumber } from '../lib/numbering';
import { withNumberCollisionRetry } from '../lib/number-collision-retry';
import {
  remainingDepositCredit,
  DEPOSIT_CREDIT_REFERENCE,
  resolvePaidDepositInvoices,
  computeDepositCredit,
  applyDepositCreditsWithPayments,
  depositEstimateIds,
} from '../lib/deposit-credit';
import { jobLineToInvoiceLineCreate } from '../lib/invoice-lines-from-job';
import { recomputeInvoiceTotals } from '../lib/invoice-totals';
import { reverseDepositCredit } from '../lib/deposit-credit-reversal';
import { invoiceRefundCap, REFUNDABLE_PAYMENT_WHERE } from '../lib/refund-cap';
import { recordJobMoneyMovement, recordJobDepositsApplied } from '../lib/job-change-history';
import { queueInvoiceAlert } from '../services/notifications/invoiceBillingAlerts';
import { queueEstimateAlert } from '../services/notifications/leadEstimateAlerts';
import { methodLabel } from '../services/payments-report';
import { publicBankName } from '../lib/payment-display';
import { transitionLeadStatus } from '../services/lead-stage.service';
import { closeOpenCheckoutLinks } from '../lib/invoice-checkout-expiry';
import { dispatchAutomationEvent } from '../services/automations/dispatch';
import { logAudit } from '../lib/audit';
import { isInvoiceEditable, isSentInvoice } from '../lib/invoice-editable';
import { getOrgTimezone, getRequestOrgTimezone, DEFAULT_TIMEZONE } from '../lib/timezone';
import { orgTodayStart } from '../lib/orgDayRange';
import { computeRenumber, applyRenumber, isInvoiceRenumberLocked, type RenumberComputation } from '../lib/record-renumber';
// Inventory P1 (§4.4/§5.3) — invoice delete/void auto-return SYNCED lines through the shared
// inv-stock return loop (applyStockMovement stays the only StockBalance write path).
import { returnSyncedLines } from './inv-stock.controller';
// Logistic Orders (spec §14 C1) — invoice void/DRAFT-delete return the PROCESSED LOs anchored to
// the invoice (the C1 stranded-stock path); resolve pre-tx, apply inside the existing transaction.
import { collectAnchoredLoUnwind, applyAnchoredLoUnwind } from '../lib/logisticOrders';
// SRVW-140 - stripInvoiceCost (moved in from invoice-lines.controller.ts) needs these two.
import { stripDocumentCost, toPublicScopes } from '../lib/scopes';
import { resolveTaxRateForState } from '../lib/tax/resolveTaxRate';
import { resolveDepositAmount, depositFigureWouldMove, type DepositOrgDefaults } from '../lib/estimates/deposit-amount';
import { manualPaymentMethodSchema } from '../lib/payment-methods';
import { creditCoveredStatus } from '../lib/invoice-money-status';
import { refusedForStandalone } from '../lib/permissions/standaloneCreate';
import { refuseDisallowedPaymentMethod } from '../lib/permissions/paymentMethods';
import { REFUND_ROW_METADATA_KEY, completeReservedRefund, releaseIfRefused, reserveRefund } from '../lib/in-app-refund';
import {
  BANK_PAYMENT_NOT_CANCELLABLE_MESSAGE, BANK_PAYMENT_PROCESSING_MESSAGE, BANK_REFUND_WINDOW_MESSAGE, ONLY_PROCESSING_BANK_PAYMENT_CANCELS_MESSAGE,
  REFUND_NOT_SENT_MESSAGE, REFUND_UNCONFIRMED_MESSAGE, allocateRefund, refundRoute, refundRowMethod, refusedRefundAnswer,
  feeReversalOption,
  refundTimingFor,
} from '../lib/refund-rules';
import { withoutProcessorIdKeys } from '../lib/processor-ids';
import { ORG_PLAN_SELECT, onlinePaymentsInPlan, onlinePaymentsUnavailableRefusal } from '../lib/online-payments-plan';
import { publicPayState, checkoutOpenStatus } from '../lib/public-pay-state';
import {
  COUNTED_PAYMENT_WHERE, COMMITTED_REFUND_WHERE, PROCESSING_PAYMENT_WHERE, MONEY_TAKEN_PAYMENT_WHERE, toCents, fromCents, paidCents, refundedCents, committedRefundCents, refundStatusFor, netCollectedCents, restampPaymentRefunds,
  settlePaymentInTx, heldRefundCents, rederiveRefundTotals,
} from '../lib/payment-ledger';
import { LINE_DESCRIPTION_MAX } from '../lib/line-items';
import { LONG_TEXT_MAX, VERY_LONG_TEXT_MAX } from '../lib/text-limits';

function param(req: Request, name: string): string {
  return req.params[name] as string;
}

// SRVW-85: DEPOSIT_CREDIT_REFERENCE's canonical home is now lib/deposit-credit. Re-exported here
// because estimate.controller, report.controller and job-invoicing.test.ts still import it from
// this module - the import above is what puts it in scope for this file's own uses.
// job.controller imports it from lib/deposit-credit directly.
export { DEPOSIT_CREDIT_REFERENCE };

// --- Zod Schemas ---
// NOTE: validate() middleware calls schema.parse(req.body) directly — no body: wrapper

// A single OWNED InvoiceLineItem authored on the body (no estimate to snapshot). line_total is
// NEVER trusted from the client — it is computed server-side (quantity × unit_price, money-rounded).
// item_type is the PriceBookItemType enum (SERVICE | MATERIAL), defaulting to SERVICE in the DB.
const invoiceLineItemInput = z.object({
  description: z.string().min(1).max(LINE_DESCRIPTION_MAX),
  quantity: z.number().positive(),
  unit_price: z.number().nonnegative(),
  is_taxable: z.boolean(),
  item_type: z.nativeEnum(PriceBookItemType).optional(),
  // String-id (not .uuid()) to match the codebase id convention; the FK + tenant scope are the
  // real guard. A bad id simply fails the InvoiceLineItem.price_book_item FK at write time.
  price_book_item_id: z.string().min(1).optional(),
});
export type InvoiceLineItemInput = z.infer<typeof invoiceLineItemInput>;

// A location address for accretion (mirrors updateJobSchema.address). Used by the standalone
// anchor and the DRAFT tax-location change to find-or-create a ServiceLocation on the customer.
const locationAddressSchema = z.object({
  address_line1: z.string().min(1),
  address_line2: z.string().optional().nullable(),
  city: z.string().min(1),
  state: z.string().min(1),
  zip: z.string().min(1),
});

// `POST /api/invoices` accepts EITHER anchor (entity-redesign + Standalone Invoices):
//   A) { job_id }                                  — existing job (snapshot the estimate, OR author
//                                                     line_items[] when the job has no estimate).
//   B) { customer_id, line_items[], service_location_id? | address? } — STANDALONE (no job/estimate).
// Exactly one of job_id / customer_id is required. For the standalone anchor, line_items[] is
// mandatory (there is no estimate to snapshot). For the job anchor, line_items[] is optional here
// (whether they are required is decided in the controller, which can see the job's estimate).
export const createInvoiceSchema = z.object({
  // String-ids (not .uuid()) to match the codebase id convention; org-scoped lookups + FKs are the
  // real guard (resolveOrAccreteLocation rejects a foreign service_location_id; tenantWhere scopes).
  job_id: z.string().min(1).optional(),
  customer_id: z.string().min(1).optional(),
  line_items: z.array(invoiceLineItemInput).optional(),
  service_location_id: z.string().min(1).optional(),
  address: locationAddressSchema.optional(),
}).superRefine((data, ctx) => {
  const hasJob = Boolean(data.job_id);
  const hasCustomer = Boolean(data.customer_id);
  if (hasJob === hasCustomer) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Provide either job_id OR customer_id (exactly one)',
      path: ['job_id'],
    });
    return;
  }
  // Standalone anchor (customer_id, no job): owned line_items are mandatory + non-empty.
  if (hasCustomer && (!data.line_items || data.line_items.length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'line_items is required (at least one) for a standalone invoice',
      path: ['line_items'],
    });
  }
});

export const voidInvoiceSchema = z.object({
  voided_reason: z.string().min(1).max(LONG_TEXT_MAX),
});

export const editInvoiceSchema = z.object({
  due_date: z.string().datetime().optional(),
  // R3b (2026-07-21) — cost model (D2/D8). Nullable overhead_mode/value mirror deposit_type/value
  // (both must be set for an override; null falls back to the org default) — see resolveOverhead.
  labor_hours: z.number().min(0).max(99999).nullable().optional(),
  overhead_mode: z.enum(['PERCENTAGE', 'FIXED']).nullable().optional(),
  overhead_value: z.number().min(0).nullable().optional(),
  // Payments go-live slice 19 (PRD Module 6) - per-invoice payment options. null resets to the
  // org default. Online methods in the list are still offered only while the account can take
  // them (lib/payment-options.ts), so a stored ACH waits for the ACH capability.
  // Its own list schema, not the org setting's: that one's duplicate message names
  // accepted_payment_methods, which this screen's user never sees (slice 21).
  payment_methods_override: z.array(z.nativeEnum(PaymentMethod))
    .refine((arr) => new Set(arr).size === arr.length, { message: 'Each payment method can be listed only once' })
    .refine((arr) => arr.length > 0, { message: 'Choose at least one payment method, or use the org default' })
    .nullable()
    .optional(),
  allow_partial_payment: z.boolean().nullable().optional(),
});

// Editable record ids (Workiz dual-run, SERV10X record-renumber) - shared by both the preview and
// the rename endpoint below. Deliberately thin: the charset/length/numeric-cap rules live in
// validateNumberFormat inside record-renumber.ts (called by computeRenumber), not here - this
// schema only guarantees `number` is present and a string. Mirrors estimateNumberSchema in
// estimate.controller.ts.
export const invoiceNumberSchema = z.object({
  number: z.string(),
}).strict();

export const recordPaymentSchema = z.object({
  amount: z.number().positive(),
  method: manualPaymentMethodSchema,
  paid_at: z.string().datetime().optional(),
  reference_number: z.string().max(100).optional(),
  notes: z.string().max(LONG_TEXT_MAX).optional(),
  // SRVW-55 — tip on a manually recorded payment. Rides on the payment, never the invoice
  // (D2/D3): amount_due, overpayment and isFullyPaid below are computed from `amount` alone.
  tip_amount: z.number().finite().min(0).max(10000).optional(),
});

export const addNoteSchema = z.object({
  content: z.string().min(1).max(LONG_TEXT_MAX),
});

// Send / Resend recipient override. Request-scoped — not saved to the customer.
export const sendInvoiceSchema = z.object({
  to: z.string().email().optional(),
  cc_emails: z.array(z.string().email()).max(5).optional(),
  message_body: z.string().max(VERY_LONG_TEXT_MAX).optional(),
});

// --- Helpers ---

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

// Proportional refund/credit tax: gross × tax_amount / total_amount; $0 under a non-taxable
// concession (goodwill / overpayment). Guards total_amount=0 → 0.
function computeRefundTax(
  amount: number,
  taxAmount: { toString(): string } | number | null,
  totalAmount: { toString(): string } | number | null,
  nonTaxableConcession?: boolean,
): number {
  if (nonTaxableConcession) return 0;
  const total = Number(totalAmount ?? 0);
  if (total <= 0) return 0;
  const tax = Number(taxAmount ?? 0);
  return roundMoney((amount * tax) / total);
}

// Exported so estimate.controller.ts's copyToInvoice() can reuse the exact same due-date
// resolution as every other invoice-creation path (create()/createStandaloneInvoice above).
export function calculateDueDate(paymentType: string | null | undefined, fromDate: Date): Date {
  const d = new Date(fromDate);
  switch (paymentType) {
    case 'COD': return d;
    case 'NET 15': d.setDate(d.getDate() + 15); return d;
    case 'NET 30': d.setDate(d.getDate() + 30); return d;
    case 'NET 60': d.setDate(d.getDate() + 60); return d;
    case 'EOM':
      return new Date(d.getFullYear(), d.getMonth() + 1, 0);
    default: // fallback NET 30
      d.setDate(d.getDate() + 30); return d;
  }
}

// Tax lookup moved to lib/tax/resolveTaxRate.ts (2026-08-05) so the org-owned list is consulted
// here exactly as it is on the estimate, job and service-plan paths.

// Map authored line inputs → InvoiceLineItem create rows, computing line_total (money-rounded)
// and assigning sequence by array order. line_total is never trusted from the client.
// LO-4: every invoice-born line is stamped NOT_TRACKED unconditionally. Logistic Orders now own
// all stock deduction, so the legacy tracked→UNSYNCED stamp (which fed the retired sync-stock
// endpoints) is gone — no catalog lookup needed at create time.
function buildOwnedLineCreates(items: InvoiceLineItemInput[]) {
  return items.map((i, idx) => ({
    sequence: idx + 1,
    description: i.description,
    quantity: i.quantity,
    unit_price: i.unit_price,
    is_taxable: i.is_taxable,
    line_total: roundMoney(i.quantity * i.unit_price),
    stock_status: 'NOT_TRACKED' as const,
    ...(i.item_type ? { item_type: i.item_type } : {}),
    ...(i.price_book_item_id ? { price_book_item_id: i.price_book_item_id } : {}),
  }));
}

// List-level bulk send / bulk resend (Invoices list page). Capped at 25, not the house 100 -
// same reasoning as the estimates bulk reminder: the loop below is sequential and each row is a
// real Resend round-trip.
export const bulkSendInvoicesSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(25),
  message_body: z.string().max(VERY_LONG_TEXT_MAX).optional(),
});

// --- Select Objects ---

export const invoiceDetailSelect = {
  id: true,
  invoice_number: true,
  status: true,
  // Entity-redesign §6: kind + the guaranteed-edge anchors (additive in Phase 0).
  kind: true,
  estimate_id: true,
  customer_id: true,
  net_collected: true,
  // B3/job-items: whole-invoice tip (post-tax, untaxed).
  tip: true,
  // Payments go-live slice 19: this invoice's payment-option overrides (null = the org default).
  payment_methods_override: true,
  allow_partial_payment: true,
  subtotal: true,
  discount_amount: true,
  tax_rate: true,
  tax_amount: true,
  deposit_credit: true,
  total_amount: true,
  amount_due: true,
  // R3b (2026-07-21) - cost model (D2/D8/D18). Staff-only. SRVW-140 corrected the claim that
  // used to stand here: `read Invoice` is NOT canSeeCosts any more (that keys on the dedicated
  // `read Pricing` grant), so these ARE stripped in this controller now - every detail-shaped
  // res.json below goes through `stripInvoiceCost`, defined under this select.
  labor_hours: true,
  overhead_mode: true,
  overhead_value: true,
  // Seam 1: the invoice OWNS its lines. Detail reads owned line_items (InvoiceLineItem is the
  // SOLE line source — JobCharge is gone in Phase D).
  line_items: {
    select: {
      id: true,
      sequence: true,
      description: true,
      quantity: true,
      unit_price: true,
      unit_cost: true,
      markup_percent: true,
      is_taxable: true,
      line_total: true,
      item_type: true,
      // Items-editor port: the invoice-page editor reuses the Job → Items row, which renders
      // per-line discounts + the linked catalog item's photo.
      discount_type: true,
      discount_value: true,
      discount_amount: true,
      price_book_item_id: true,
      // Inventory P1 (§0.4): stock pills. NOT cost data — stripInvoiceCost leaves them alone.
      stock_status: true,
      stock_location_id: true,
      price_book_item: { select: { image_url: true, photo_url: true } },
    },
    orderBy: { sequence: 'asc' as const },
  },
  // Stage 5: flat-priced, non-line-item scope-of-work blocks (scopes.ts). No separate GET
  // /scopes route — embedded directly here, matching the line_items precedent above.
  scopes: true,
  public_token: true,
  sent_at: true,
  paid_at: true,
  due_date: true,
  voided_at: true,
  voided_reason: true,
  refunded_at: true,
  total_refunded: true,
  refund_reason: true,
  refund_reason_category: true,
  created_at: true,
  updated_at: true,
  // Entity-redesign §8: first-class Refund/Credit ledgers, surfaced for the invoice money UI.
  refunds: {
    select: {
      id: true,
      payment_id: true,
      amount: true,
      tax_portion: true,
      non_taxable_concession: true,
      method: true,
      reason: true,
      reason_category: true,
      stripe_refund_id: true,
      created_at: true,
      // Payments go-live slice 05: the money UI counts SUCCEEDED refunds only.
      state: true,
      // Payments go-live slice 28: the ledger's "By" column names who sent the money back.
      refunded_by_user: { select: { id: true, first_name: true, last_name: true } },
    },
    orderBy: { created_at: 'asc' as const },
  },
  credits: {
    select: {
      id: true,
      amount: true,
      tax_portion: true,
      reason: true,
      category: true,
      created_at: true,
    },
    orderBy: { created_at: 'asc' as const },
  },
  // Top-level customer: the source of truth for job-less (deposit/orphan) invoices.
  // For legacy job-anchored invoices this is null (customer_id was never set), so reads
  // fall back to job.customer below via `invoice.customer ?? invoice.job?.customer`.
  customer: {
    select: {
      id: true,
      first_name: true,
      last_name: true,
      company_name: true,
      email: true,
      phone: true,
      payment_type: true,
      tax_exempt: true,
      // #2041 decision 5 — projects the row-scope PROOF relations onto this anchor so
      // `presentInvoiceDetail`/`isCustomerReadableRow` can judge readability synchronously,
      // in-memory. Stripped again before any response goes out.
      ...CUSTOMER_PROOF_SELECT,
    },
  },
  // R5e (2026-07-22) — top-level estimate (parallel to the top-level `customer` field above,
  // same job-less-invoice reason): a copy-to-invoice invoice has estimate_id set but no job, so
  // the job.estimate nested select below never fires for it. This is what the "View Estimate"
  // reciprocal UI link reads for a job-less, estimate-anchored invoice. Mirrors job.estimate's
  // own `invoices` sub-select (Bug #45) so the frontend's buildLedgerEvents can render the
  // "Deposit Paid" row for a copy-to-invoice invoice too, not just a job-anchored one.
  estimate: {
    select: {
      id: true,
      estimate_number: true,
      invoices: {
        where: { kind: 'DEPOSIT' as const },
        select: {
          id: true,
          status: true,
          total_refunded: true,
          refunded_at: true,
          payments: {
            select: {
              amount: true,
              method: true,
              paid_at: true,
              reference_number: true,
              stripe_fee_amount: true,
              platform_fee_amount: true,
              net_amount: true,
              service_fee_amount: true,
              tip_amount: true,
            },
          },
        },
        take: 1,
      },
    },
  },
  job: {
    select: {
      id: true,
      job_number: true,
      status: true,
      visits: { select: { assignees: { select: { user_id: true } } } },
      customer: {
        select: {
          id: true,
          first_name: true,
          last_name: true,
          company_name: true,
          email: true,
          phone: true,
          payment_type: true,
          tax_exempt: true,
          // #2041 decision 5 — see the top-level `customer` anchor's comment above.
          ...CUSTOMER_PROOF_SELECT,
        },
      },
      service_location: {
        select: {
          id: true,
          address_line1: true,
          address_line2: true,
          city: true,
          state: true,
          zip: true,
        },
      },
      estimate: {
        select: {
          id: true,
          estimate_number: true,
          tax_rate: true,
          discount_amount: true,
          discount_type: true,
          discount_value: true,
          discount_name: true,
          line_items: {
            select: {
              id: true,
              sequence: true,
              description: true,
              quantity: true,
              unit_price: true,
              is_taxable: true,
              line_total: true,
            },
            orderBy: { sequence: 'asc' as const },
          },
          lead: {
            select: {
              id: true,
              lead_assignees: { select: { user_id: true } },
            },
          },
          // Bug #45: the deposit's real Payment now lives on the sibling kind=DEPOSIT invoice
          // (entity-redesign dropped the estimate.deposit relation). Select it so the Payments-tab
          // ledger can render the "Deposit Paid" row and any deposit refunds.
          invoices: {
            where: { kind: 'DEPOSIT' as const },
            select: {
              id: true,
              status: true,
              total_refunded: true,
              refunded_at: true,
              payments: {
                select: {
                  amount: true,
                  method: true,
                  paid_at: true,
                  reference_number: true,
                  // Task 3.4 (spec §7.3) — per-payment fee breakdown for the "Deposit Paid"
                  // ledger row (the deposit is frequently a CARD payment too).
                  stripe_fee_amount: true,
                  platform_fee_amount: true,
                  net_amount: true,
                  service_fee_amount: true,
                  tip_amount: true,
                },
              },
            },
            take: 1,
          },
        },
      },
    },
  },
  payments: {
    select: {
      id: true,
      amount: true,
      method: true,
      paid_at: true,
      collected_by: true,
      stripe_payment_intent_id: true,
      reference_number: true,
      notes: true,
      created_at: true,
      // Entity-redesign §8: void-payment state for the payments ledger / void affordance.
      voided_at: true,
      voided_reason: true,
      void_category: true,
      // Payments go-live slice 05: the money UI counts SUCCEEDED payments only.
      state: true,
      // Payments go-live slice 28: how the customer paid, for the payment history.
      wallet: true,
      card_brand: true,
      card_last4: true,
      bank_name: true,
      bank_last4: true,
      // Task 3.4 (spec §7.3) — per-payment fee breakdown (Gross/Stripe fee/ServWave fee/Net),
      // populated post-commit by captureStripeFees (Task 3.3); null until reconciled or for
      // non-CARD payments.
      stripe_fee_amount: true,
      platform_fee_amount: true,
      net_amount: true,
      // Slice 5 (card service fee) — org-facing visibility of what the customer paid on top.
      service_fee_amount: true,
      // Slice 8 (customer-facing tipping) — org-facing visibility of the tip collected.
      tip_amount: true,
      collector: {
        select: { id: true, first_name: true, last_name: true },
      },
    },
    orderBy: { paid_at: 'asc' as const },
  },
};

/**
 * Cost/margin strip for an `invoiceDetailSelect`-shaped invoice. Thin alias of the shared
 * `stripDocumentCost` policy (lib/scopes.ts) so Invoice and Estimate cannot drift out of sync.
 *
 * SRVW-140 - moved here from invoice-lines.controller.ts and applied in THIS controller too.
 * The old comment above `labor_hours` claimed every handler here is gated by
 * canDo('read'/'update','Invoice') "which IS canSeeCosts, so no strip is needed", which was
 * true only while canSeeCosts keyed on `read Invoice`. It now keys on the dedicated
 * `read Pricing` grant, so a requester who can open an invoice RECORD but has "See financial
 * data" off must not get its cost model back on the detail response. Lives next to
 * `invoiceDetailSelect` because it is paired with it; invoice-lines.controller.ts imports it
 * (that file already imports invoiceDetailSelect from here, and this file imports nothing from
 * it, so there is no cycle).
 */
export function stripInvoiceCost<T extends Parameters<typeof stripDocumentCost>[0]>(doc: T, req: Request): T {
  return stripDocumentCost(withoutProcessorIds(withDerivedNetCollected(doc)), req);
}

/**
 * Payments go-live slice 33 - processor ids never reach the browser (its network tab is user-visible).
 * The stored columns stay; the response carries a neutral `paid_through_processor` boolean per payment
 * (what the page needs to pick the refund route and the void affordance) and no dispute id (the invoice
 * status already says DISPUTED). Runs on every detail-shaped response, so no door can forget it.
 */
function withoutProcessorIds<T>(doc: T): T {
  const d = doc as { payments?: unknown; stripe_dispute_id?: unknown };
  if (!d || typeof d !== 'object') return doc;
  const { stripe_dispute_id: _dispute, ...rest } = d as Record<string, unknown>;
  const payments = Array.isArray(d.payments)
    ? (d.payments as Array<Record<string, unknown>>).map((p) => {
        const { stripe_payment_intent_id: intentId, ...pay } = p;
        // The sandbox's own name for its test bank is the processor's brand: it never leaves as a bank name.
        const bank = 'bank_name' in pay ? { bank_name: publicBankName(pay.bank_name as string | null) } : {};
        return { ...pay, ...bank, paid_through_processor: Boolean(intentId) };
      })
    : d.payments;
  // Refund ids (and any other processor id nested in the ledger) go too; the server reads them
  // from its own queries, never from this response.
  return withoutProcessorIdKeys({ ...rest, ...(payments === undefined ? {} : { payments }) }) as T;
}

/**
 * Payments go-live slice 07 - net collected, derived from the ledger in ONE place. Only the refund
 * doors ever wrote the stored column, so an invoice paid by hand (or settled, or voided) carried a
 * stale figure. Every detail-shaped response passes through here with its payments and refunds,
 * so the figure it reports is always SUCCEEDED money paid (applied deposit credit aside) minus
 * SUCCEEDED refunds. A document without those lists is passed through untouched.
 */
function withDerivedNetCollected<T>(doc: T): T {
  const d = doc as { payments?: unknown; refunds?: unknown };
  if (!Array.isArray(d.payments) || !Array.isArray(d.refunds)) return doc;
  // Slice 28: the bank money still clearing, derived here with the rest of the ledger figures (an
  // invoice has no "processing" status; the page badges this amount).
  const clearing = (d.payments as Array<{ amount: Parameters<typeof paidCents>[0][number]['amount']; state?: string; voided_at?: Date | null }>)
    .filter((p) => p.state === 'PROCESSING' && !p.voided_at);
  return {
    ...doc,
    net_collected: fromCents(netCollectedCents(d.payments, d.refunds)),
    processing_amount: fromCents(paidCents(clearing)),
  };
}

const invoiceListSelect = {
  id: true,
  invoice_number: true,
  status: true,
  kind: true,
  subtotal: true,
  discount_amount: true,
  tax_amount: true,
  deposit_credit: true,
  total_amount: true,
  amount_due: true,
  due_date: true,
  sent_at: true,
  paid_at: true,
  created_at: true,
  // Entity-redesign §6/§8: the customer lives directly on the invoice and is
  // always present; `job` is optional (deposit/orphan invoices have no job).
  // Select the direct customer so the list can render job-less invoices.
  customer: {
    select: { id: true, first_name: true, last_name: true, company_name: true },
  },
  job: {
    select: {
      id: true,
      job_number: true,
    },
  },
  // Slice 28: the bank money still clearing on this invoice, summed into processing_amount by
  // listRow() so the list can badge it. Never sent as rows.
  payments: { where: PROCESSING_PAYMENT_WHERE, select: { amount: true } },
};

/** An invoice list row for the wire: the clearing bank payments folded into one processing_amount. */
function listRow<T extends { payments: Array<{ amount: Parameters<typeof paidCents>[0][number]['amount'] }> }>(row: T) {
  const { payments, ...rest } = row;
  return { ...rest, processing_amount: fromCents(paidCents(payments)) };
}

/**
 * The status fields an invoice takes as it is issued (sent, or given a payment link): SENT, or PAID
 * with a paid date when its deposit credit alone covers the whole total (slice 32b). Only a DRAFT
 * is judged: it carries no payment and no credit note, so its balance is the credit's doing alone.
 */
function issuedStatusOf(invoice: { status: string; deposit_credit: Prisma.Decimal | number; amount_due: Prisma.Decimal | number }) {
  const covered = invoice.status === 'DRAFT'
    && creditCoveredStatus({ status: 'SENT', cashBalanceCents: toCents(invoice.amount_due), depositCreditCents: toCents(invoice.deposit_credit) }) === 'PAID';
  return covered ? { status: 'PAID' as const, paid_at: new Date() } : { status: 'SENT' as const };
}

// --- Handlers ---

export async function create(req: Request, res: Response) {
  try {
    const { job_id } = req.body as z.infer<typeof createInvoiceSchema>;

    // ── Anchor B: STANDALONE (customer-anchored, no job/estimate) ──
    // The either-anchor schema guarantees exactly one of job_id / customer_id; route here when
    // there is no job_id. Standalone is a distinct flow (no estimate snapshot, no deposit credit,
    // no job.amount_invoiced bump) so it lives in its own handler.
    if (!job_id) {
      return createStandaloneInvoice(req, res);
    }

    // ── Anchor A: JOB (existing) ──
    // 1. Fetch job with all related data (scoped to requesting org)
    const job = await prisma.job.findUnique({
      where: { id: job_id, ...tenantWhere(req) },
      include: {
        customer: { select: { id: true, payment_type: true, tax_exempt: true } },
        // job-owns-tax-discount (E4): tax_rate/discount_amount come straight off the JOB now
        // (plain scalar columns, included automatically) - the estimate is no longer a tax or
        // discount source either, only an id for the deposit-credit union below.
        estimate: { select: { id: true } },
        // The Items tab: the billing truth for both doors (SERV10X-38 / Spec B1).
        job_line_items: { orderBy: { sequence: 'asc' } },
        // SERV10X-61 Task 10: estimates attached via EstimateJobLink, each with its own PAID
        // deposit.
        linked_estimates: { select: { id: true } },
      },
    });

    if (!job) return res.status(404).json({ error: 'Job not found' });
    // Every job status can be invoiced (Spec B1) — cancellation is no longer terminal, so a
    // cancelled job that gets revived, or one cancelled after work was genuinely done, still bills.
    // Service-plan visit-jobs are non-billable: the plan was paid once upfront via its kind=PLAN
    // invoice, so invoicing the spawned visit-job would double-charge. (FE hides the action too.)
    if (job.source_plan_id) {
      return res.status(400).json({ error: 'This job is a service plan visit and cannot be invoiced — the plan was already paid upfront.' });
    }

    // One ACTIVE invoice per job. SRVW-85: this is NOT the guard Spec B1 removed. The two doors
    // are two different verbs. THIS one bills the WHOLE job in a single document, so a second one
    // is always a duplicate of the first; POST /api/jobs/:id/invoices bills a DRAW or a SUBSET and
    // is repeatable by design (Spec B1, afdc77e0d). VOIDED invoices do NOT block - void-and-reissue
    // stays possible.
    const activeInvoice = await prisma.invoice.findFirst({
      where: { job_id: job.id, kind: 'STANDARD', status: { not: 'VOIDED' }, ...tenantWhere(req) },
      select: { invoice_number: true },
    });
    if (activeInvoice) {
      return res.status(409).json({
        error: `This job already has an invoice (${activeInvoice.invoice_number}). Void it first or edit the existing one.`,
      });
    }

    // Create invoices reaches a job the person can open: the route already required `create Invoice` via canDo
    // (subject-level only), and the person's Jobs scope decides which jobs are theirs (Attached covers the crew, Sold By
    // and Dispatcher). No role name is read.
    if (!(await canAccessRow(req, 'Job', prisma.job, job.id))) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    // Resolve the invoice's OWNED lines + totals. SRVW-85 precedence, three-way:
    //   (a) job HAS Items-tab lines → bill THOSE (body line_items are ignored, the same silent
    //       precedence the estimate snapshot used to have), with the job's multi-deposit
    //       drawdown. This door always bills the WHOLE job in one document (the one-active-
    //       invoice guard above), so tax/discount both come straight off the job (E1/E2/E4) -
    //       the same numbers the Items tab preview already shows for this exact item set.
    //   (b) job has NO Items-tab lines → author body line_items[] (from-scratch job invoice).
    //       Same job tax/discount - a job always carries its own rate now, estimate or not.
    //   (c) neither → 400.
    // Either way the invoice OWNS its lines (InvoiceLineItem).
    const authoredItems = (req.body as z.infer<typeof createInvoiceSchema>).line_items ?? [];

    const taxRate = Number(job.tax_rate);
    let subtotal: number;
    let discountAmount: number;
    let taxAmount: number;
    // Owned line create-rows for the new invoice (job-line copy OR authored).
    let ownedLineCreates: Prisma.InvoiceLineItemCreateWithoutInvoiceInput[];

    if (job.job_line_items.length > 0) {
      // (a) Bill the Items tab. E2: discount_amount is the job's own already-RESOLVED dollar
      // figure - passed straight through, never re-derived from a rate against this invoice's
      // subtotal. Safe here because this door always bills the FULL job, the same set the
      // figure was resolved against - clamped to THIS subtotal defensively anyway, in case the
      // item set shrank after the discount was set (these lines never carry a per-line discount
      // of their own, so a plain quantity*unit_price sum IS the pre-discount subtotal).
      const lineInputs = job.job_line_items.map((l) => ({
        quantity: Number(l.quantity),
        unit_price: Number(l.unit_price),
        is_taxable: l.is_taxable,
      }));
      const preDiscountSubtotal = roundMoney(lineInputs.reduce((sum, l) => sum + roundMoney(l.quantity * l.unit_price), 0));
      const jobLineTotals = recomputeInvoiceTotals({
        lines: lineInputs,
        taxRate,
        taxExempt: job.customer.tax_exempt,
        invoiceDiscountAmount: Math.min(Number(job.discount_amount), preDiscountSubtotal),
      });
      discountAmount = jobLineTotals.discount_amount;
      subtotal = jobLineTotals.subtotal;
      taxAmount = jobLineTotals.tax_amount;

      // Same row shape job.controller.ts's itemized path builds, so the two doors write identical
      // InvoiceLineItem rows - jobLineToInvoiceLineCreate is the shared mapper (SRVW-85). Per-line
      // discount_type/discount_value stay uncopied, exactly as both doors do today.
      ownedLineCreates = job.job_line_items.map(jobLineToInvoiceLineCreate);
    } else {
      // (b) From-scratch job invoice: author body line_items[]. line_items is required here.
      if (authoredItems.length === 0) {
        return res.status(400).json({ error: 'Cannot create invoice with no line items' });
      }
      ownedLineCreates = buildOwnedLineCreates(authoredItems);
      const preDiscountSubtotal = roundMoney(authoredItems.reduce((sum, i) => sum + roundMoney(i.quantity * i.unit_price), 0));
      const totals = recomputeInvoiceTotals({
        lines: authoredItems.map((i) => ({
          quantity: i.quantity,
          unit_price: i.unit_price,
          is_taxable: i.is_taxable,
        })),
        taxRate,
        taxExempt: job.customer.tax_exempt,
        invoiceDiscountAmount: Math.min(Number(job.discount_amount), preDiscountSubtotal),
      });
      subtotal = totals.subtotal;
      taxAmount = totals.tax_amount;
      discountAmount = totals.discount_amount;
    }

    const totalAmount = roundMoney(subtotal - discountAmount + taxAmount);

    // Due date
    const dueDate = calculateDueDate(job.customer.payment_type, new Date());

    // 3. Create invoice in transaction
    const invoice = await withNumberCollisionRetry(() => prisma.$transaction(async (tx) => {
      const invoiceNumber = await allocateNumber(tx, 'invoice', req.user!.organization_id);

      // ── Seam 1: INVOICE OWNS LINES ──
      // ownedLineCreates was resolved above: the job's Items-tab lines (path a) OR the authored
      // body line_items (from-scratch job invoice path). Either way the invoice owns its lines.
      const snapshotLines = ownedLineCreates;

      // ── Seam 4 (Phase 2a): deposit-credit DRAW-DOWN (tax-once), keyed on the kind=DEPOSIT Invoice ──
      // The deposit is a real kind=DEPOSIT Invoice (created at estimate.send()); its id is the
      // valid FK target for DepositCreditApplication.deposit_invoice_id. The credit is recorded as
      // a POST-TAX Payment (NEVER a discount line) - the single subtraction that makes Σ applied
      // across a job's STANDARD invoices ≤ the deposit.
      // SRVW-85: the deposit source is now the SAME union the job door uses - every attached
      // estimate (linked_estimates / EstimateJobLink) UNION the 1:1 provenance estimate, deduped.
      // Before this, a customer who paid their deposit on a LINKED estimate lost that credit
      // through this door and was billed twice for their own money.
      const paidDeposits = await resolvePaidDepositInvoices(tx, depositEstimateIds(job), req.user!.organization_id);
      const depositCredit = await computeDepositCredit(tx, paidDeposits, totalAmount);

      const amountDue = Math.round((totalAmount - depositCredit) * 100) / 100;

      const created = await tx.invoice.create({
        data: {
          invoice_number: invoiceNumber,
          organization_id: req.user!.organization_id,
          job_id: job.id,
          // Invoice.customer_id is REQUIRED (entity-redesign §6). A job-anchored invoice resolves
          // its customer directly from the job.
          customer_id: job.customer.id,
          status: 'DRAFT',
          subtotal,
          discount_amount: discountAmount,
          tax_rate: taxRate,
          tax_amount: taxAmount,
          deposit_credit: depositCredit,
          total_amount: totalAmount,
          amount_due: amountDue,
          due_date: dueDate,
          // R3b (2026-07-21) — copy the job's cost basis onto the new invoice (D18), same
          // copy-on-conversion precedent as Estimate → Job above. A from-scratch job (no
          // estimate) leaves these null on the job too, so this is a no-op fallback to org
          // default via resolveOverhead either way.
          labor_hours: job.labor_hours,
          overhead_mode: job.overhead_mode,
          overhead_value: job.overhead_value,
          ...(snapshotLines.length > 0 ? { line_items: { create: snapshotLines } } : {}),
          // Audit: the user who chose to raise this invoice.
          ...createdByUser(req),
        },
        select: invoiceDetailSelect,
      });

      // PASS 2: one DepositCreditApplication ledger row + one post-tax DEPOSIT-CREDIT Payment per
      // deposit that draws > 0, under the same decreasing-room clamp pass 1 used. Shared with the
      // job door so the two can never drift apart again.
      const appliedDeposits = await applyDepositCreditsWithPayments(tx, paidDeposits, created.id, totalAmount, req.user!.organization_id);
      // S06.7: each deposit drawn onto this invoice is on the job's history.
      await recordJobDepositsApplied(
        tx, { orgId: req.user!.organization_id, userId: req.user!.id }, job.id, created, appliedDeposits,
      );

      // §5 — maintain the job's cached amount_invoiced as a billing tracker (billed-vs-estimate,
      // to prevent over/double-billing). create() only ever makes a STANDARD invoice anchored to
      // a job, so increment by this invoice's gross total (NOT amount_due — the deposit credit is
      // a payment, not a reduction in what was billed).
      await tx.job.update({
        where: { id: job.id },
        data: { amount_invoiced: { increment: totalAmount } },
      });

      await tx.timelineEvent.create({
        data: {
          organization_id: req.user!.organization_id,
          entity_type: 'INVOICE',
          entity_id: created.id,
          event_type: 'INVOICE_CREATED',
          description: `Invoice ${invoiceNumber} created`,
          created_by: req.user?.id,
        },
      });

      return created;
    }), { label: 'invoice.create_from_job' });

    void logAudit({
      req,
      action: 'invoice.created',
      resourceType: 'Invoice',
      resourceId: invoice.id,
      metadata: { invoice_number: invoice.invoice_number },
    });
    res.status(201).json({ invoice: presentInvoiceDetail(req, stripInvoiceCost(invoice, req)) });
  } catch (err) {
    logger.error('Error creating invoice:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ── Anchor B: STANDALONE invoice (customer-anchored, no job/estimate) ──
// Author owned line_items against a customer with NO job. Tax is location-driven (Design A): the
// chosen / accreted service location's state rate, or 0 when the customer is tax-exempt. No deposit
// credit (no estimate ⇒ nothing to draw down). kind = STANDARD. Needs the Standalone invoices switch on
// top of Create invoices: a person who may invoice a job they can open may not bill a bare customer.
async function createStandaloneInvoice(req: Request, res: Response) {
  if (refusedForStandalone(req, res, 'Invoice')) return;

  const body = req.body as z.infer<typeof createInvoiceSchema>;
  const customerId = body.customer_id!;
  const authoredItems = body.line_items ?? [];

  // Fetch the customer (org-scoped) + its service locations so we can resolve the tax location.
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, ...tenantWhere(req) },
    select: {
      id: true,
      payment_type: true,
      tax_exempt: true,
      service_locations: {
        where: { is_active: { not: false } },
        select: { id: true, state: true, is_primary: true },
      },
    },
  });
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const ownedLineCreates = buildOwnedLineCreates(authoredItems);

  try {
    const invoice = await withNumberCollisionRetry(() => prisma.$transaction(async (tx) => {
      // Resolve the tax location. Explicit id / address → resolveOrAccreteLocation (ownership-
      // checked + find-or-create). Otherwise default to the customer's primary location if any.
      // A tax-exempt customer needs no location (tax is 0 regardless).
      let resolvedState: string | null = null;
      if (body.service_location_id || body.address) {
        const resolved = await resolveOrAccreteLocation(tx, {
          customerId: customer.id,
          orgId: req.user!.organization_id,
          service_location_id: body.service_location_id ?? null,
          address: (body.address as LocationAddress | undefined) ?? null,
        });
        resolvedState = resolved.state;
      } else {
        const primary = customer.service_locations.find((l) => l.is_primary) ?? customer.service_locations[0];
        resolvedState = primary?.state ?? null;
      }

      // The tax tables are reference data, but they MUST be read on the tx connection: we are
      // inside an open $transaction (resolveOrAccreteLocation above is a write that must stay
      // atomic), so a read on the global `prisma` client would ask the pooler for a 2nd
      // connection that can't free until this txn commits → deadlock/error → 500 (the job-anchored
      // path is safe because it looks the rate up BEFORE opening its txn).
      const taxRate = customer.tax_exempt
        ? 0
        : await resolveTaxRateForState(tx, req.user!.organization_id, resolvedState);
      const totals = recomputeInvoiceTotals({
        lines: authoredItems.map((i) => ({
          quantity: i.quantity,
          unit_price: i.unit_price,
          is_taxable: i.is_taxable,
        })),
        taxRate,
        taxExempt: customer.tax_exempt,
      });
      const subtotal = totals.subtotal;
      const taxAmount = totals.tax_amount;
      const totalAmount = roundMoney(subtotal + taxAmount);
      const dueDate = calculateDueDate(customer.payment_type, new Date());

      const invoiceNumber = await allocateNumber(tx, 'invoice', req.user!.organization_id);

      const created = await tx.invoice.create({
        data: {
          invoice_number: invoiceNumber,
          organization_id: req.user!.organization_id,
          // No job, no estimate — purely customer-anchored.
          customer_id: customer.id,
          kind: 'STANDARD',
          status: 'DRAFT',
          subtotal,
          discount_amount: 0,
          tax_rate: taxRate,
          tax_amount: taxAmount,
          deposit_credit: 0,
          total_amount: totalAmount,
          amount_due: totalAmount,
          due_date: dueDate,
          line_items: { create: ownedLineCreates },
          // Audit: the user who chose to raise this customer-anchored invoice.
          ...createdByUser(req),
        },
        select: invoiceDetailSelect,
      });

      await tx.timelineEvent.create({
        data: {
          organization_id: req.user!.organization_id,
          entity_type: 'INVOICE',
          entity_id: created.id,
          event_type: 'INVOICE_CREATED',
          description: `Invoice ${invoiceNumber} created`,
          created_by: req.user?.id,
        },
      });

      return created;
    }), { label: 'invoice.create' });

    void logAudit({
      req,
      action: 'invoice.created',
      resourceType: 'Invoice',
      resourceId: invoice.id,
      metadata: { invoice_number: invoice.invoice_number },
    });
    res.status(201).json({ invoice: presentInvoiceDetail(req, stripInvoiceCost(invoice, req)) });
  } catch (err) {
    if (err instanceof LocationResolutionError) {
      return res.status(400).json({ error: err.message });
    }
    logger.error('Error creating standalone invoice:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Build the `where` clause (and the underlying grant-driven `roleScope`) for the invoice
 * list/export. Extracted from `list()` so the unpaginated `exportAll` applies the IDENTICAL
 * tenant scope + CASL row-scope + filters. Returns `roleScope` too because `list()` reuses it
 * to build the separate stats `scopeWhere`.
 */
export async function buildInvoiceListWhere(req: Request): Promise<{ where: Record<string, unknown>; roleScope: Record<string, unknown> }> {
  const search = (req.query.search as string) || '';
  const overdue = req.query.overdue === 'true';

  // #106 — grant-driven row-scope (replaces the hand-rolled TECHNICIAN/SALES `job` filter, which
  // fail-OPEN for every other non-ADMIN/custom role). scopeWhereForReq resolves the role's
  // read-Invoice grant condition: ADMIN/unconditional → {} (no restriction); owner/team/location
  // → that condition; no read grant / token-null → MATCH_NOTHING ({ id: { in: [] } }) = sees nothing.
  // Kept as the OUTERMOST spread so per-request filters below can't overwrite the MATCH_NOTHING id.
  const roleScope: Record<string, unknown> = await scopeWhereForReq(req, 'Invoice');

  // Build where clause (org-scoped + grant-driven row-scope)
  const where: Record<string, unknown> = { ...tenantWhere(req), ...roleScope };

  // status, customer_id, total (total_min/total_max), balance (balance_min/balance_max),
  // created (created_after/created_before), due (due_after/due_before) — see invoice.filters.ts.
  await applyFilters(where, req, invoiceFacets);

  // `overdue` is a computed predicate, not a facet, so it stays here and runs AFTER applyFilters:
  //   - due_date MERGES onto whatever the `due` facet already set (e.g. overdue + due_after =
  //     "overdue within a window" → { lt: <org day start>, gte: dueAfter }), matching the prior hand-rolled
  //     due_after/due_before-refines-onto-overdue behavior.
  //   - status OVERWRITES whatever the `status` facet set — overdue wins over an explicit status
  //     filter, matching the prior hand-rolled `if (overdue) { where.status = ... }` running after
  //     the status assignment.
  if (overdue) {
    // The ORG's clock, not the server's. `lt: new Date()` selected every invoice due EARLIER
    // TODAY, which the OVERDUE chip on that same row (invoicesColumns.tsx -> orgDayDiff < 0)
    // then declined to draw - a row in the Overdue list that does not say Overdue. The org
    // day start is the exact Prisma expression of that chip's predicate.
    //
    // Resolved INSIDE this branch, following filterEngine's lazy discipline: a request without
    // ?overdue=true must not pay for a lookup it cannot use. getRequestOrgTimezone memoizes on
    // the request, so it is free when a `due` chip already resolved it in applyFilters above.
    const timeZone = await getRequestOrgTimezone(req);
    where.due_date = {
      ...((where.due_date as Record<string, unknown> | undefined) ?? {}),
      lt: orgTodayStart(timeZone),
    };
    where.status = { in: ['SENT', 'PARTIAL'] };
  }

  if (search) {
    // Clobber-safe: a multi-read user's row-scope can itself be an `OR` (spread in above from
    // scopeWhereForReq — e.g. a SALES user with both the role OWN_INVOICE_VIA_LEAD read AND a
    // per-user `create Invoice` override implying OWN_INVOICE_VIA_JOB). Assigning `where.OR`
    // directly would silently drop it (row-scope LEAK), so AND-merge. See lib/permissions/whereCompose.
    addOrFilter(where, [
      { invoice_number: { contains: search, mode: 'insensitive' } },
      { job: { job_number: { contains: search, mode: 'insensitive' } } },
      // Search the invoice's direct customer so job-less invoices match by name.
      { customer: { first_name: { contains: search, mode: 'insensitive' } } },
      { customer: { last_name: { contains: search, mode: 'insensitive' } } },
    ]);
  }

  return { where, roleScope };
}

export async function list(req: Request, res: Response) {
  try {
    const { page, limit, skip } = parsePagination(req.query);

    // SRVW-89 - hoisted above buildInvoiceListWhere/where/scopeWhere: parseSortParams is pure
    // (reads only req.query) so hoisting is behaviour-neutral, and it makes "no where is built
    // on a rejected sort" a genuinely uniform invariant across all 9 parseSortParams callers.
    const sort = parseSortParams(req.query as any, INVOICE_SORT_FIELDS);
    if (!sort.ok) {
      respondInvalidSort(res, sort);
      return;
    }
    const orderBy = sort.orderBy;

    const { where, roleScope } = await buildInvoiceListWhere(req);

    // Scope where for stats (same grant-driven row-scope, but not status/search filters)
    const scopeWhere: any = { ...tenantWhere(req), ...roleScope };

    // GAP-3: the "need invoices" KPI counts JOBS (not invoices), so it needs the requester's
    // Job read-scope — NOT the Invoice roleScope above (an Invoice `where.job` fragment is wrong
    // shape for a job.count). ADMIN / unconditional read → {} → org-wide (unchanged).
    const jobScope = await scopeWhereForReq(req, 'Job');

    const now = new Date();
    // The Overdue KPI tile must cut where the list rows and their chips cut - see the
    // `overdue` branch in buildInvoiceListWhere. `now` is passed explicitly so the tile and
    // the rows in this one response cannot straddle a midnight tick. Memoized per request, and
    // buildInvoiceListWhere above has often primed it already, so this is at most one lookup.
    const overdueBefore = orgTodayStart(await getRequestOrgTimezone(req), now);

    const [invoices, total, dueStats, overdueStats, collectedStats, unsent, needInvoices,
      depositPaidAgg, depositAppliedAgg, depositRefundedAgg] = await Promise.all([
      prisma.invoice.findMany({
        where,
        select: invoiceListSelect,
        skip,
        take: limit,
        orderBy,
      }),
      prisma.invoice.count({ where }),
      // Due: SENT + PARTIAL
      prisma.invoice.aggregate({
        where: { ...scopeWhere, status: { in: ['SENT', 'PARTIAL'] } },
        _sum: { amount_due: true },
        _count: true,
      }),
      // Overdue: due before the ORG day began + SENT/PARTIAL (same boundary as the rows).
      prisma.invoice.aggregate({
        where: { ...scopeWhere, status: { in: ['SENT', 'PARTIAL'] }, due_date: { lt: overdueBefore } },
        _sum: { amount_due: true },
        _count: true,
      }),
      // Collected this month (GAP-3: scope the parent invoice by the role row-scope, not org-wide
      // tenantWhere, so a row-scoped role's collected total reflects only their own invoices).
      prisma.payment.aggregate({
        where: {
          // Slice 05: only SUCCEEDED, non-voided money was collected.
          ...COUNTED_PAYMENT_WHERE,
          paid_at: {
            gte: new Date(now.getFullYear(), now.getMonth(), 1),
            lt: new Date(now.getFullYear(), now.getMonth() + 1, 1),
          },
          invoice: scopeWhere,
        },
        _sum: { amount: true },
        _count: true,
      }),
      // Unsent (DRAFT)
      prisma.invoice.count({ where: { ...scopeWhere, status: 'DRAFT' } }),
      // Need invoices (completed-or-later jobs - PRD 6: Completed, Office review, Ready to close, Done - with no active invoice — every invoice is VOIDED, or none exist).
      // GAP-3: scope by the requester's Job read-scope so a row-scoped role counts only jobs it can see.
      prisma.job.count({
        where: {
          ...tenantWhere(req),
          ...jobScope,
          status: { in: [...COMPLETED_OR_LATER_JOB_STATUSES] },
          NOT: { invoices: { some: { status: { not: 'VOIDED' } } } },
        },
      }),
      // ── Deposits held ──────────────────────────────────────────────────────
      // Money taken as a deposit that has NOT yet been applied to an invoice.
      // The three aggregates are the same subtraction `remainingDepositCredit`
      // (lib/deposit-credit.ts) performs per deposit, summed across the org
      // instead of one invoice at a time:
      //
      //   held = Σ non-voided payments on DEPOSIT invoices
      //        − Σ active DepositCreditApplication.amount
      //        − Σ refunds on DEPOSIT invoices
      //
      // It is deliberately NOT `sum(total_amount)` of deposit invoices: an
      // unpaid deposit is money requested, not money held, and that figure is
      // already the dashboard's separate "Deposits Awaiting" tile.
      //
      // Every leg is scoped by `scopeWhere` (tenant + the requester's row
      // scope), reached through the deposit invoice, so a row-scoped role sees
      // only deposits on invoices it can already read.
      prisma.payment.aggregate({
        where: { ...COUNTED_PAYMENT_WHERE, invoice: { ...scopeWhere, kind: 'DEPOSIT' } },
        _sum: { amount: true },
      }),
      prisma.depositCreditApplication.aggregate({
        where: { reversed_at: null, deposit_invoice: scopeWhere },
        _sum: { amount: true },
      }),
      prisma.refund.aggregate({
        where: { ...COMMITTED_REFUND_WHERE, invoice: { ...scopeWhere, kind: 'DEPOSIT' } },
        _sum: { amount: true },
      }),
    ]);

    // Each leg is read through the same null-tolerant shape `remainingDepositCredit`
    // uses (`sumOf`, lib/deposit-credit.ts): an aggregate over an empty set yields
    // `_sum.amount === null`, and the three legs are independent, so a missing leg
    // must read as zero money rather than NaN.
    const sumAmount = (agg: { _sum?: { amount?: unknown } } | null | undefined): number => {
      const raw = agg?._sum?.amount;
      return raw == null ? 0 : Number(raw);
    };

    // Clamped at zero: the subtraction is over three independently-aggregated
    // sets, and a reversal landing mid-flight should read as "nothing held",
    // never as negative money.
    const depositsHeld = Math.max(
      0,
      sumAmount(depositPaidAgg) - sumAmount(depositAppliedAgg) - sumAmount(depositRefundedAgg),
    );

    // SRVW-103 - one batched, tenant-scoped tag read for the whole page (never one per row).
    const tagsByInvoice = await loadTagsByEntity(req, 'INVOICE', invoices.map((i) => i.id));

    res.json({
      invoices: invoices.map((i) => ({ ...listRow(i), tags: tagsByInvoice.get(i.id) ?? [] })),
      pagination: buildPaginationMeta(total, { page, limit, skip }),
      stats: {
        due: { total: dueStats._sum.amount_due || 0, count: dueStats._count },
        overdue: { total: overdueStats._sum.amount_due || 0, count: overdueStats._count },
        collected_this_month: { total: collectedStats._sum.amount || 0, count: collectedStats._count },
        unsent: unsent,
        need_invoices: needInvoices,
        deposits_held: depositsHeld,
      },
    });
  } catch (err) {
    logger.error('Error listing invoices:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

const EXPORT_ROW_CAP = 50_000;

/**
 * Export every invoice matching the active filters (unpaginated, capped). Reuses the list's
 * `where` (tenant + CASL row-scope + filters), `select`, and default `orderBy` so the CSV
 * the frontend builds is column-identical to the list and row-level security holds.
 */
export async function exportAll(req: Request, res: Response) {
  try {
    const { where } = await buildInvoiceListWhere(req);
    const invoices = await prisma.invoice.findMany({
      where,
      select: invoiceListSelect,
      orderBy: { created_at: 'desc' },
      take: EXPORT_ROW_CAP,
    });
    if (invoices.length === EXPORT_ROW_CAP) {
      logger.warn(`Invoice export hit row cap (${EXPORT_ROW_CAP}) for org ${req.user?.organization_id}`);
    }
    void logAudit({
      req,
      action: 'invoice.exported',
      resourceType: 'Invoice',
      resourceId: null,
      metadata: { count: invoices.length },
    });
    res.json({ invoices: invoices.map(listRow) });
  } catch (err) {
    logger.error('Export invoices error:', err);
    res.status(500).json({ error: 'Failed to export invoices' });
  }
}

export async function getById(req: Request, res: Response) {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      select: invoiceDetailSelect,
    });

    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (!(await canAccessRow(req, 'Invoice', prisma.invoice, param(req, 'id')))) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    // SERV10X-59 — derived, not persisted: true when a material edit landed strictly after the
    // last send/resend. Skip the query entirely on a never-sent/DRAFT/settled invoice.
    let needsResend = false;
    if (isSentInvoice(invoice.status, invoice.sent_at)) {
      const staleEdit = await prisma.timelineEvent.findFirst({
        where: {
          entity_type: 'INVOICE',
          entity_id: invoice.id,
          event_type: 'INVOICE_EDITED',
          created_at: { gt: invoice.sent_at! },
          ...tenantWhere(req),
        },
        select: { id: true },
      });
      needsResend = !!staleEdit;
    }

    // SRVW-103 - after the 403 guard above, so no tag query fires for a row the caller cannot read.
    const tags = await loadTagsForEntity(req, 'INVOICE', invoice.id);

    // What this person may do on this invoice, asked of the record as it stands: the invoice page draws a button only
    // for a listed action (M3), and the routes behind the buttons ask the same switches and the creator rule.
    const actions = await invoiceActionsFor(req, invoice.id);
    // The words beside the closed line, scope, discount and tax controls when the invoice belongs to a Done job (S06.19), else null.
    const price_edit_closed_reason = await invoiceDonePriceRefusal(req, invoice.id);

    res.json({ invoice: { ...presentInvoiceDetail(req, stripInvoiceCost({ ...invoice, needs_resend: needsResend, tags }, req)), actions, price_edit_closed_reason } });
  } catch (err) {
    logger.error('Error fetching invoice:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function update(req: Request, res: Response) {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      select: { id: true, status: true, kind: true, due_date: true, sent_at: true, job: { select: { visits: { select: { assignees: { select: { user_id: true } } } }, estimate: { select: { lead: { select: { lead_assignees: { select: { user_id: true } } } } } } } } },
    });

    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    // #106 — grant-driven per-instance owner check (placed AFTER the 404 guard, BEFORE the status
    // guard). The route guard (canDo) is SUBJECT-level only: it passes the moment a role carries any
    // update-Invoice grant (incl. an owner-scoped one org-settings narrows it to), so the row's
    // ownership must still be verified here. canAccessRow resolves the role's read-Invoice grant
    // condition through SQL (one scoped findFirst) — fail-closed and nested-safe for the multi-hop
    // Invoice owner chain (job→estimate→lead), which @casl/prisma's in-memory matcher cannot
    // traverse. This is the fix for the P0 fail-open the old canAccessInvoice carried (it returned
    // true for ADMIN/DISPATCHER unconditionally, IGNORING the narrowed grant condition).
    if (!(await canAccessRow(req, 'Invoice', prisma.invoice, param(req, 'id')))) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    if (!isInvoiceEditable(invoice.status)) return res.status(400).json({ error: 'This invoice is locked and can no longer be edited (it is paid or closed)' });

    const { due_date, labor_hours, overhead_mode, overhead_value, payment_methods_override, allow_partial_payment } = req.body;

    // R3b (2026-07-21) — labor_hours/overhead_mode/overhead_value are staff-only cost-model
    // inputs (D2/D8). A requester without See financial data (canSeeCosts) must
    // not be able to blindly set them either — mirrors Estimate's identical write-guard.
    if (
      (labor_hours !== undefined || overhead_mode !== undefined || overhead_value !== undefined)
      && !canSeeCosts(req)
    ) {
      return res.status(403).json({ error: 'Insufficient permissions to edit cost fields' });
    }

    // A deposit is always paid in full, so it cannot be set to take part payments.
    if (invoice.kind === 'DEPOSIT' && allow_partial_payment === true) {
      return res.status(400).json({ error: 'A deposit invoice is always paid in full, so partial payments cannot be turned on.' });
    }

    const updated = await prisma.invoice.update({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      data: {
        due_date: due_date ? new Date(due_date) : undefined,
        labor_hours: labor_hours !== undefined ? (labor_hours ?? null) : undefined,
        overhead_mode: overhead_mode !== undefined ? (overhead_mode || null) : undefined,
        overhead_value: overhead_value !== undefined ? (overhead_value ?? null) : undefined,
        payment_methods_override: payment_methods_override === undefined
          ? undefined
          : (payment_methods_override === null ? Prisma.DbNull : payment_methods_override),
        allow_partial_payment: allow_partial_payment === undefined ? undefined : allow_partial_payment,
      },
      select: invoiceDetailSelect,
    });

    // SERV10X-59 — due_date is in the public payload (getPublic); labor_hours/overhead_* are
    // staff-only cost-model inputs and never material. Skip on a no-op PATCH (due_date resent
    // unchanged) — compare against the PRE-edit value loaded above, not the response.
    const dueDateChanged = due_date !== undefined
      && new Date(due_date).getTime() !== (invoice.due_date ? invoice.due_date.getTime() : NaN);
    if (dueDateChanged && isSentInvoice(invoice.status, invoice.sent_at)) {
      await prisma.timelineEvent.create({
        data: {
          organization_id: req.user!.organization_id,
          entity_type: 'INVOICE',
          entity_id: invoice.id,
          event_type: 'INVOICE_EDITED',
          description: 'Invoice edited after it was sent',
          metadata: { fields: ['due_date'] },
          created_by: req.user!.id,
          created_at: new Date(),
        },
      });
    }

    void logAudit({
      req,
      action: 'invoice.updated',
      resourceType: 'Invoice',
      resourceId: param(req, 'id'),
      metadata: { fields: Object.keys(req.body ?? {}) },
    });
    res.json({ invoice: presentInvoiceDetail(req, stripInvoiceCost(updated, req)) });
  } catch (err) {
    logger.error('Error updating invoice:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

const DELETE_HAS_PAYMENT_MESSAGE = 'This invoice has a payment on it, so it cannot be deleted. Void it instead.';
const DELETE_LINK_OPEN_MESSAGE = 'This invoice\'s payment link could not be closed right now. Try again in a moment.';

export async function remove(req: Request, res: Response) {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      select: { id: true, status: true, invoice_number: true, job_id: true, kind: true, total_amount: true, _count: { select: { payments: true } }, job: { select: { visits: { select: { assignees: { select: { user_id: true } } } }, estimate: { select: { lead: { select: { lead_assignees: { select: { user_id: true } } } } } } } } },
    });

    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    // #106 — grant-driven per-instance owner check (mirrors update(); the subject-level route guard
    // is not enough). canAccessRow resolves the read-Invoice grant scope through SQL — see update().
    if (!(await canAccessRow(req, 'Invoice', prisma.invoice, param(req, 'id')))) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    if (invoice.status !== 'DRAFT') return res.status(400).json({ error: 'Only DRAFT invoices can be deleted' });
    // W4: a DRAFT can be paid through its link, so it may hold money. A payment (even a pending
    // one) is a record the invoice cannot lose; void it instead.
    if ((invoice._count?.payments ?? 0) > 0) return res.status(409).json({ error: DELETE_HAS_PAYMENT_MESSAGE });
    // W4: a DRAFT with a public link may have a live checkout. Expire it BEFORE the row dies, and
    // refuse if the sweep cannot prove it dead: a customer paying a deleted invoice lands unapplied.
    if (!(await closeOpenCheckoutLinks(req.user!.organization_id, [invoice], 'invoice_deleted'))) {
      return res.status(409).json({ error: DELETE_LINK_OPEN_MESSAGE });
    }

    // Inventory P1 (§4.4 / QA-505): auto-return invoice-BORN SYNCED lines BEFORE the row (and
    // its cascading lines) die — movement FKs must exist at insert; SetNull fires on delete.
    // Only invoice-born lines can be SYNCED (job copies are stamped NOT_TRACKED by §5.2
    // construction), so the stock_status filter IS the scope rule (QA-503).
    const actor = `${req.user!.first_name ?? ''} ${req.user!.last_name ?? ''}`.trim() || 'Unknown';
    // Logistic Orders (spec §14 C1): resolve the invoice's LOs PRE-TX (pool discipline); a DRAFT
    // invoice delete unwinds them on the same rule as void.
    const loUnwind = await collectAnchoredLoUnwind(prisma, {
      orgId: req.user!.organization_id,
      where: { invoice_id: invoice.id },
      actor,
      actorUserId: req.user!.id,
    });
    await prisma.$transaction(async (tx) => {
      const syncedLines = await tx.invoiceLineItem.findMany({
        where: { invoice_id: invoice.id, stock_status: 'SYNCED' },
        select: { id: true, quantity: true, price_book_item_id: true, stock_location_id: true },
      });
      await returnSyncedLines(tx, syncedLines, {
        orgId: req.user!.organization_id,
        reference: `${invoice.invoice_number} deleted`,
        actor,
        actorUserId: req.user!.id,
        jobId: invoice.job_id ?? null,
        lineRef: 'invoice',
      });
      // Return PROCESSED LOs BEFORE the invoice row dies (FK ordering); open LOs left alone, same
      // rule as void (cancelOpen: false).
      await applyAnchoredLoUnwind(tx, loUnwind, { cancelOpen: false });
      // §5 — deleting a draft un-issues the bill, exactly as voiding does (:1346-1352). create()
      // increments amount_invoiced at DRAFT time, so without this the job's cached billed total
      // stays inflated forever and the completed-revenue series reports money never invoiced.
      // Same STANDARD + job_id condition as void: a kind=DEPOSIT draft never incremented it.
      if (invoice.kind === 'STANDARD' && invoice.job_id) {
        await tx.job.update({
          where: { id: invoice.job_id },
          data: { amount_invoiced: { decrement: Number(invoice.total_amount) } },
        });
      }
      await tx.invoice.delete({ where: { id: param(req, 'id') } });
    });
    void logAudit({
      req,
      action: 'invoice.deleted',
      resourceType: 'Invoice',
      resourceId: param(req, 'id'),
    });
    res.status(204).send();
  } catch (err) {
    // A payment that landed after the check above: the foreign key (Restrict) holds the invoice.
    if ((err as { code?: string })?.code === 'P2003') {
      return res.status(409).json({ error: DELETE_HAS_PAYMENT_MESSAGE });
    }
    logger.error('Error deleting invoice:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Editable record ids (Workiz dual-run, SERV10X record-renumber) ──────

/**
 * Thrown INSIDE the rename transaction when a fresh, lock-protected `computeRenumber` finds
 * conflicts, so the controller can respond 409 with the structured computation instead of
 * guessing at the shape of `applyRenumber`'s own (plain-message) conflict error. Carrying the
 * computation on the error also means `applyRenumber` - which re-derives and would throw for the
 * identical reason - is never even called on the conflict path, so nothing is written. Mirrors
 * estimate.controller.ts's identical class for the same reason.
 */
class RenumberConflictError extends Error {
  constructor(public readonly computation: RenumberComputation) {
    super(`Cannot rename invoice ${computation.parentId}: number "${computation.newNumber}" has conflicts`);
  }
}

/** True for the `Invalid record number: ...` Error validateNumberFormat/computeRenumber throw. */
function isInvalidNumberError(err: unknown): err is Error {
  return err instanceof Error && err.message.startsWith('Invalid record number');
}

/** Fields isInvoiceRenumberLocked (decision #8) reads - a DIFFERENT, stricter check than
 * isInvoiceEditable: any invoice that has been sent, or has real money collected on it, can no
 * longer have its number edited, even though it may still be editable in every other respect.
 *
 * Payment ROWS, not the money columns: voiding an invoice zeroes amount_due, and the residual
 * arithmetic then reads that as "the whole total was collected" and locks a voided, never-sent,
 * never-paid invoice. Voided payments are selected too - the predicate, not the query, decides
 * which of them count. */
const RENUMBER_LOCK_SELECT = {
  id: true,
  sent_at: true,
  payments: { select: { voided_at: true } },
} as const;

const INVOICE_RENUMBER_LOCKED_MESSAGE =
  'This invoice has been sent or has a payment on it and can no longer have its number edited';

/**
 * POST /:id/number/preview - read-only, no lock, no writes. Mirrors computeRenumber's own
 * contract (advisory only): drives the (later-PR) confirmation dialog before the real rename.
 */
export async function previewNumber(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const orgId = req.user!.organization_id;

    const existing = await prisma.invoice.findUnique({
      where: { id, ...tenantWhere(req) },
      select: RENUMBER_LOCK_SELECT,
    });
    if (!existing) {
      res.status(404).json({ error: 'Invoice not found' });
      return;
    }

    // #106 - per-instance ownership (the route guard canDo('renumber') is subject-level only).
    // Same canAccessRow gate update()/remove()/voidInvoice() already use.
    if (!(await canAccessRow(req, 'Invoice', prisma.invoice, existing.id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    if (isInvoiceRenumberLocked(existing)) {
      res.status(400).json({ error: INVOICE_RENUMBER_LOCKED_MESSAGE });
      return;
    }

    const computation = await computeRenumber(prisma, 'invoice', id, orgId, req.body.number);
    res.json(computation);
  } catch (err) {
    if (isInvalidNumberError(err)) {
      res.status(400).json({ error: err.message });
      return;
    }
    logger.error('Preview invoice number error:', err);
    res.status(500).json({ error: 'Failed to preview invoice number change' });
  }
}

/**
 * PATCH /:id/number - the real rename. Cheap existence/ownership/precondition check OUTSIDE the
 * transaction first (mirrors update()/remove()'s permission → 404 → ownership → business-
 * precondition ordering, so a request that's going to 404/403/400 anyway never opens a
 * transaction). The transaction then locks the parent row `FOR NO KEY UPDATE` - the SAME lock
 * strength allocateAnchoredNumber already takes on the invoices table when invoice is the
 * LogisticOrder anchor (numbering.ts), so the two code paths serialize against each other instead
 * of deadlocking or racing - before computing/applying.
 */
export async function renameNumber(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const orgId = req.user!.organization_id;

    const existing = await prisma.invoice.findUnique({
      where: { id, ...tenantWhere(req) },
      select: RENUMBER_LOCK_SELECT,
    });
    if (!existing) {
      res.status(404).json({ error: 'Invoice not found' });
      return;
    }

    if (!(await canAccessRow(req, 'Invoice', prisma.invoice, existing.id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    if (isInvoiceRenumberLocked(existing)) {
      res.status(400).json({ error: INVOICE_RENUMBER_LOCKED_MESSAGE });
      return;
    }

    let computation: RenumberComputation;
    try {
      computation = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT id FROM invoices WHERE id = ${id}::uuid AND organization_id = ${orgId}::uuid FOR NO KEY UPDATE`;

        // Compute fresh, under the lock, BEFORE calling applyRenumber - so a conflict can be
        // reported with the full structured computation. applyRenumber re-derives this exact
        // same computation internally and would throw for the identical reason, so skip it
        // entirely on the conflict path rather than calling it twice.
        const preview = await computeRenumber(tx, 'invoice', id, orgId, req.body.number);
        if (preview.hasConflicts) {
          throw new RenumberConflictError(preview);
        }

        return applyRenumber(tx, 'invoice', id, orgId, req.body.number);
      });
    } catch (err) {
      if (err instanceof RenumberConflictError) {
        res.status(409).json({ error: err.message, computation: err.computation });
        return;
      }
      if (isInvalidNumberError(err)) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    // Timeline + audit AFTER the transaction commits - never inside it (a rolled-back attempt
    // must leave no trace of either).
    await prisma.timelineEvent.create({
      data: {
        organization_id: orgId,
        entity_type: 'INVOICE',
        entity_id: id,
        event_type: 'INVOICE_RENUMBERED',
        description: `Invoice number changed from ${computation.oldNumber} to ${computation.newNumber}`
          + ` (${computation.derived.length + computation.labelRefreshes.length} related record(s) updated)`,
        metadata: {
          old_number: computation.oldNumber,
          new_number: computation.newNumber,
          derived_count: computation.derived.length + computation.labelRefreshes.length,
        },
        created_by: req.user!.id,
      },
    });

    void logAudit({
      req,
      action: 'invoice.renumbered',
      resourceType: 'Invoice',
      resourceId: id,
      metadata: { old_number: computation.oldNumber, new_number: computation.newNumber },
    });

    // Built from the computation, not a re-SELECT - everything the (later-PR) frontend
    // confirmation dialog needs, in one round trip.
    res.json({
      invoice: { id, invoice_number: computation.newNumber },
      old_number: computation.oldNumber,
      new_number: computation.newNumber,
      derived: computation.derived,
      label_refreshes: computation.labelRefreshes,
    });
  } catch (err) {
    logger.error('Rename invoice number error:', err);
    res.status(500).json({ error: 'Failed to change invoice number' });
  }
}

/** What a send or a resend of one invoice answers; `code` names a refusal the screen can act on (ADDRESS_NEEDED). */
type InvoiceSendResult = { ok: true; invoice: unknown } | { ok: false; status: number; error: string; code?: string };

// Extracted from send() so bulkSend() (list-level bulk send, Invoices list page) can share the
// EXACT same guard/PREP/EMAIL/COMMIT sequence without duplicating it. Returns a result instead of
// writing to `res` directly - send() and bulkSend() each translate that result into their own
// response shape. Same pattern as estimate.controller.ts's deleteEstimateInternal/bulkRemove.
class SendNoLongerDraftError extends Error {}

async function sendInvoiceInternal(
  req: Request,
  id: string,
  body: z.infer<typeof sendInvoiceSchema>,
  sender: HandSender,
): Promise<InvoiceSendResult> {
  const invoice = await prisma.invoice.findUnique({
    where: { id, ...tenantWhere(req) },
    select: invoiceDetailSelect,
  });

  if (!invoice) return { ok: false, status: 404, error: 'Invoice not found' };
  // #106 — grant-driven per-instance owner check (a send-Invoice grant org-settings narrows to
  // owned rows must be enforced on THIS row, not just at the subject-level route guard).
  if (!(await canAccessRow(req, 'Invoice', prisma.invoice, id))) {
    return { ok: false, status: 403, error: 'Insufficient permissions' };
  }
  if (invoice.status !== 'DRAFT') return { ok: false, status: 400, error: 'Only DRAFT invoices can be sent' };

  const cust = invoice.customer ?? invoice.job?.customer;
  // #1997 round 2 — a client-supplied recipient (`to`/`cc_emails`) is a direct bypass of the
  // round-1 redaction; see sendEstimateInternal's identical guard for the full rationale.
  const hasClientRecipient = body.to !== undefined || (body.cc_emails?.length ?? 0) > 0;
  if (hasClientRecipient && (!cust || !isCustomerReadableRow(req, cust))) {
    return { ok: false, status: 403, error: "You can send this to the customer's saved address only." };
  }
  // ── PREP (phase 1): resolve the recipient BEFORE anything irreversible ──────────────
  const to = body.to || cust?.email;
  if (!to) return { ok: false, status: 400, error: 'No recipient email — add a recipient to send this invoice' };

  // A payment link made while this was a DRAFT already handed the customer a token; keep it alive.
  const publicToken = invoice.public_token ?? crypto.randomUUID();
  const dueDate = invoice.due_date || calculateDueDate(cust?.payment_type, new Date());
  const publicUrl = `${env.FRONTEND_URL || ''}/p/invoices/${invoice.id}?token=${publicToken}`;
  const timezone = await getOrgTimezone(req.user!.organization_id);

  // ── EMAIL (phase 2): AWAIT the send. Do NOT mark SENT unless it goes out. ───────────
  const emailResult: EmailDispatchResult = await sendInvoiceEmail({
    invoiceId: invoice.id,
    organizationId: req.user!.organization_id,
    to,
    cc: body.cc_emails,
    message: body.message_body,
    customerName: [cust?.first_name, cust?.last_name].filter(Boolean).join(' ') || cust?.company_name || 'Customer',
    invoiceNumber: invoice.invoice_number,
    total: Number(invoice.total_amount),
    amountDue: Number(invoice.amount_due),
    dueDate: dueDate.toISOString(),
    publicUrl,
    timezone,
    record: {
      organizationId: req.user!.organization_id,
      customerId: cust?.id,
      jobId: invoice.job?.id,
      jobLabel: invoice.job?.job_number,
      // The reply anchor: this invoice's send, its reminder and the customer's
      // reply are one conversation - see lib/reply-token.ts.
      entityType: 'invoice',
      entityId: invoice.id,
    },
    // Sent by hand: from the sender's own mailbox, and the person who pressed Send is recorded with the send.
    handSender: { mailboxId: sender.mailboxId, userId: req.user!.id },
  });

  if (emailResult.status !== 'sent') {
    const { code, message, errorCode } = mapInvoiceEmailFailure(emailResult, 'send');
    return { ok: false, status: code, error: message, ...(errorCode ? { code: errorCode } : {}) };
  }

  // ── COMMIT (phase 3): email confirmed sent - flip the status + write the ledger ─────
  // A DRAFT with a payment link is payable, so a payment may have landed while the email went out:
  // lock the row and re-check, as markSent does, so a PAID/PARTIAL invoice is never flipped to SENT.
  let updated;
  try {
    updated = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM invoices WHERE id = ${id}::uuid AND organization_id = ${req.user!.organization_id}::uuid FOR UPDATE`;
    const locked = await tx.invoice.findUniqueOrThrow({
      where: { id, ...tenantWhere(req) },
      select: { status: true, amount_due: true, deposit_credit: true },
    });
    if (locked.status !== 'DRAFT') throw new SendNoLongerDraftError();
    const inv = await tx.invoice.update({
      where: { id, ...tenantWhere(req) },
      data: {
        ...issuedStatusOf(locked),
        sent_at: new Date(),
        public_token: publicToken,
        due_date: dueDate,
      },
      select: invoiceDetailSelect,
    });

    await tx.timelineEvent.create({
      data: {
        organization_id: req.user!.organization_id,
        entity_type: 'INVOICE',
        entity_id: inv.id,
        event_type: 'INVOICE_SENT',
        description: `Invoice ${inv.invoice_number} sent to customer`,
        created_by: req.user?.id,
      },
    });

    return inv;
    });
  } catch (err) {
    if (err instanceof SendNoLongerDraftError) return { ok: false, status: 409, error: 'This invoice changed while it was being sent. Refresh and check its status.' };
    throw err;
  }

  void logAudit({
    req,
    action: 'invoice.sent',
    resourceType: 'Invoice',
    resourceId: updated.id,
    metadata: { invoice_number: updated.invoice_number },
  });

  // ─── Automation Center event — post-commit, fire-and-forget (#271) ────────
  dispatchAutomationEvent({
    type: 'INVOICE_SENT',
    organizationId: req.user!.organization_id,
    entity: { type: 'invoice', id: updated.id, label: updated.invoice_number },
    actorId: req.user?.id ?? null,
  });

  return { ok: true, invoice: presentInvoiceDetail(req, stripInvoiceCost(updated, req)) };
}

export async function send(req: Request, res: Response) {
  try {
    const body = req.body as z.infer<typeof sendInvoiceSchema>;
    const sender = await handSenderOrRefusal(prisma, req);
    if (!sender.ok) return res.status(sender.refusal.status).json({ error: sender.refusal.error, code: sender.refusal.code });
    const result = await sendInvoiceInternal(req, param(req, 'id'), body, sender.sender);
    if (!result.ok) return res.status(result.status).json({ error: result.error, ...(result.code ? { code: result.code } : {}) });
    // sendInvoiceInternal already redacts its returned `invoice` (#1997); applying the presenter
    // again here is a harmless no-op (redactCustomerContactFor is idempotent) and keeps this call
    // site self-evidently correct rather than relying on the internal function alone.
    res.json({ invoice: presentInvoiceDetail(req, result.invoice) });
  } catch (err) {
    logger.error('Error sending invoice:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// List-level bulk send (Invoices list page) - sequential, per-id isolated. One id's failure never
// aborts the rest of the batch.
export async function bulkSend(req: Request, res: Response) {
  try {
    const { ids, message_body } = req.body as z.infer<typeof bulkSendInvoicesSchema>;
    // A bulk send is a hand send by the person who clicked: their own mailbox, resolved once for the batch, and a person with
    // no address is refused as a whole before any invoice is read or sent.
    const sender = await handSenderOrRefusal(prisma, req);
    if (!sender.ok) return res.status(sender.refusal.status).json({ error: sender.refusal.error, code: sender.refusal.code });
    const sent: string[] = [];
    const failed: { id: string; error: string }[] = [];

    for (const id of ids) {
      try {
        const result = await sendInvoiceInternal(req, id, { ...(message_body !== undefined ? { message_body } : {}) }, sender.sender);
        if (result.ok) {
          sent.push(id);
        } else {
          failed.push({ id, error: result.error });
        }
      } catch (err) {
        logger.error(`Bulk send invoice error for ${id}:`, err);
        failed.push({ id, error: 'Failed to send invoice' });
      }
    }

    res.json({ sent, failed });
  } catch (err) {
    logger.error('Bulk send invoices error:', err);
    res.status(500).json({ error: 'Failed to send invoices' });
  }
}

// Extracted from resend() so bulkResend() (list-level bulk reminder, Invoices list page) can
// share the EXACT same guard/EMAIL/COMMIT sequence without duplicating it. Same pattern as
// sendInvoiceInternal above.
async function resendInvoiceInternal(
  req: Request,
  id: string,
  body: z.infer<typeof sendInvoiceSchema>,
  sender: HandSender,
): Promise<InvoiceSendResult> {
  const invoice = await prisma.invoice.findUnique({
    where: { id, ...tenantWhere(req) },
    select: invoiceDetailSelect,
  });

  if (!invoice) return { ok: false, status: 404, error: 'Invoice not found' };
  // #106 — grant-driven per-instance owner check (resend shares the send grant; enforce on the row).
  if (!(await canAccessRow(req, 'Invoice', prisma.invoice, id))) {
    return { ok: false, status: 403, error: 'Insufficient permissions' };
  }
  if (!invoice.public_token) return { ok: false, status: 400, error: 'Invoice has not been sent yet' };
  if (invoice.status === 'DRAFT') return { ok: false, status: 400, error: 'Cannot resend a DRAFT invoice' };
  if (invoice.status === 'VOIDED') return { ok: false, status: 400, error: 'Cannot resend a VOIDED invoice' };

  const cust = invoice.customer ?? invoice.job?.customer;
  // #1997 round 2 — see sendInvoiceInternal's identical guard above.
  const hasClientRecipient = body.to !== undefined || (body.cc_emails?.length ?? 0) > 0;
  if (hasClientRecipient && (!cust || !isCustomerReadableRow(req, cust))) {
    return { ok: false, status: 403, error: "You can send this to the customer's saved address only." };
  }
  // Resolve recipient before mutating — override beats the saved email; missing recipient is a hard 400.
  const to = body.to || cust?.email;
  if (!to) return { ok: false, status: 400, error: 'No recipient email — add a recipient to resend this invoice' };

  // ── EMAIL (phase 1): AWAIT the send. Do NOT touch sent_at/timeline unless it goes out. ──
  const publicUrl = `${env.FRONTEND_URL || ''}/p/invoices/${invoice.id}?token=${invoice.public_token}`;
  const timezone = await getOrgTimezone(req.user!.organization_id);
  const emailResult: EmailDispatchResult = await sendInvoiceEmail({
    invoiceId: invoice.id,
    organizationId: req.user!.organization_id,
    to,
    cc: body.cc_emails,
    message: body.message_body,
    customerName: [cust?.first_name, cust?.last_name].filter(Boolean).join(' ') || cust?.company_name || 'Customer',
    invoiceNumber: invoice.invoice_number,
    total: Number(invoice.total_amount),
    amountDue: Number(invoice.amount_due),
    dueDate: (invoice.due_date || new Date()).toISOString(),
    publicUrl,
    timezone,
    record: {
      organizationId: req.user!.organization_id,
      customerId: cust?.id,
      jobId: invoice.job?.id,
      jobLabel: invoice.job?.job_number,
      // The reply anchor: this invoice's send, its reminder and the customer's
      // reply are one conversation - see lib/reply-token.ts.
      entityType: 'invoice',
      entityId: invoice.id,
    },
    // Sent by hand: from the sender's own mailbox, and the person who pressed Send is recorded with the send.
    handSender: { mailboxId: sender.mailboxId, userId: req.user!.id },
  });

  if (emailResult.status !== 'sent') {
    const { code, message, errorCode } = mapInvoiceEmailFailure(emailResult, 'resend');
    return { ok: false, status: code, error: message, ...(errorCode ? { code: errorCode } : {}) };
  }

  // ── COMMIT (phase 2): email confirmed sent - update the timestamp + write the ledger ──
  const updated = await prisma.$transaction(async (tx) => {
    const inv = await tx.invoice.update({
      where: { id, ...tenantWhere(req) },
      data: { sent_at: new Date() },
      select: invoiceDetailSelect,
    });
    await tx.timelineEvent.create({
      data: {
        organization_id: req.user!.organization_id,
        entity_type: 'INVOICE',
        entity_id: inv.id,
        event_type: 'INVOICE_RESENT',
        description: `Invoice ${inv.invoice_number} resent to customer`,
        created_by: req.user?.id,
      },
    });
    return inv;
  });

  return { ok: true, invoice: presentInvoiceDetail(req, stripInvoiceCost(updated, req)) };
}

export async function resend(req: Request, res: Response) {
  try {
    const body = req.body as z.infer<typeof sendInvoiceSchema>;
    const sender = await handSenderOrRefusal(prisma, req);
    if (!sender.ok) return res.status(sender.refusal.status).json({ error: sender.refusal.error, code: sender.refusal.code });
    const result = await resendInvoiceInternal(req, param(req, 'id'), body, sender.sender);
    if (!result.ok) return res.status(result.status).json({ error: result.error, ...(result.code ? { code: result.code } : {}) });
    // See send()'s identical comment — resendInvoiceInternal already redacts, this is a harmless
    // idempotent re-application.
    res.json({ invoice: presentInvoiceDetail(req, result.invoice) });
  } catch (err) {
    logger.error('Error resending invoice:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// List-level bulk resend (Invoices list page) - sequential, per-id isolated.
export async function bulkResend(req: Request, res: Response) {
  try {
    const { ids, message_body } = req.body as z.infer<typeof bulkSendInvoicesSchema>;
    // See bulkSend: one resolution for the batch, refused as a whole for a person with no address.
    const sender = await handSenderOrRefusal(prisma, req);
    if (!sender.ok) return res.status(sender.refusal.status).json({ error: sender.refusal.error, code: sender.refusal.code });
    const sent: string[] = [];
    const failed: { id: string; error: string }[] = [];

    for (const id of ids) {
      try {
        const result = await resendInvoiceInternal(req, id, { ...(message_body !== undefined ? { message_body } : {}) }, sender.sender);
        if (result.ok) {
          sent.push(id);
        } else {
          failed.push({ id, error: result.error });
        }
      } catch (err) {
        logger.error(`Bulk resend invoice error for ${id}:`, err);
        failed.push({ id, error: 'Failed to resend invoice' });
      }
    }

    res.json({ sent, failed });
  } catch (err) {
    logger.error('Bulk resend invoices error:', err);
    res.status(500).json({ error: 'Failed to resend invoices' });
  }
}

// Map a non-'sent' EmailDispatchResult to the HTTP response send()/resend() return when they
// refuse to mark an invoice sent. Pure - no side effects. org_disabled is a deliberate admin
// kill-switch (409 conflict, not an error); a missing API key or a provider rejection is an
// upstream/infra failure (502 bad gateway). In every case the invoice is LEFT unchanged.
function mapInvoiceEmailFailure(
  result: EmailDispatchResult,
  action: 'send' | 'resend',
): { code: number; message: string; errorCode?: string } {
  const verb = action === 'send' ? 'sent' : 'resent';
  // The sender lost their address between the check at the door and the dispatch: refused like any other address-needed send.
  if (result.status === 'skipped' && (result.reason === 'address_needed' || result.reason === 'foreign_mailbox')) {
    return { code: ADDRESS_NEEDED_REFUSAL.status, message: ADDRESS_NEEDED_REFUSAL.error, errorCode: ADDRESS_NEEDED_REFUSAL.code };
  }
  if (result.status === 'skipped' && result.reason === 'org_disabled') {
    return {
      code: 409,
      message: `Email is turned off for your whole organization, so no invoice email was sent. This affects all outgoing email - an admin can turn it back on in Settings -> Company Profile. The invoice was not marked as ${verb}.`,
    };
  }
  if (result.status === 'skipped') { // no_api_key
    return { code: 502, message: `Email is not configured, so the invoice was not ${verb}.` };
  }
  return { code: 502, message: `The invoice could not be emailed to the customer, so it was not marked as ${verb}. Please try again.` };
}


// Issue a payable public link without sending an email - deliberately NOT gated by the org
// email_sending_enabled toggle. A DRAFT with a token is payable through its public link (W4), so
// this action only mints the token and fills the due date: it never changes the status. An
// invoice that already has a token just returns it (idempotent).
export async function createPaymentLink(req: Request, res: Response) {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      select: invoiceDetailSelect,
    });

    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (!(await canAccessRow(req, 'Invoice', prisma.invoice, param(req, 'id')))) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    if (invoice.status === 'VOIDED') return res.status(400).json({ error: 'Cannot create a payment link for a voided invoice.' });

    // #1997 round 3 (HIGH) — the `url` this endpoint returns carries the raw public token as a
    // SIBLING of the presenter-redacted `invoice`, so it survived as a laundering channel around
    // the redaction: a requester who cannot read the anchored customer could still read the token
    // out of `url` and replay it, unauthenticated, against `getPublicPdf`. Refuse BEFORE minting
    // or writing anything — same verdict `presentInvoiceDetail` uses to strip the top-level
    // `public_token`, resolved on the already-loaded row (no extra query).
    const tokenAnchor = resolveTokenAnchor(invoice);
    if (tokenAnchor && !isCustomerReadable(req, tokenAnchor)) {
      return res.status(403).json({ error: 'Payment links are not available for this customer.' });
    }

    if (invoice.public_token) {
      const url = `${env.FRONTEND_URL || ''}/p/invoices/${invoice.id}?token=${invoice.public_token}`;
      return res.json({ invoice: presentInvoiceDetail(req, stripInvoiceCost(invoice, req)), url });
    }

    const cust = invoice.customer ?? invoice.job?.customer;
    const candidateToken = crypto.randomUUID();
    const dueDate = invoice.due_date || calculateDueDate(cust?.payment_type, new Date());

    // Decide from the row as it is under the lock, not from the read above: a hand payment, a
    // void or another payment-link call may have committed since (same pattern as record-payment, #891).
    const outcome = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM invoices WHERE id = ${param(req, 'id')}::uuid AND organization_id = ${req.user!.organization_id}::uuid FOR UPDATE`;
      const locked = await tx.invoice.findUniqueOrThrow({
        where: { id: param(req, 'id'), ...tenantWhere(req) },
        select: { status: true, public_token: true, sent_at: true, amount_due: true, deposit_credit: true },
      });
      if (locked.status === 'VOIDED') throw new RefusedUnderLockError('Cannot create a payment link for a voided invoice.');
      if (locked.public_token) {
        // Someone already minted the link: hand it out unchanged, write nothing.
        const existing = await tx.invoice.findUniqueOrThrow({
          where: { id: param(req, 'id'), ...tenantWhere(req) },
          select: invoiceDetailSelect,
        });
        return { inv: existing, token: locked.public_token, created: false };
      }

      const inv = await tx.invoice.update({
        where: { id: param(req, 'id'), ...tenantWhere(req) },
        data: {
          // W4 (Ran, 13 Oct): a payment link never changes the status. A DRAFT stays a DRAFT (it is
          // issued by Send or "Mark as sent"), and its sent date stays empty. Any other status is
          // kept as it is too (slice 32c); sent_at is stamped once, never overwritten, and only on
          // an invoice that is already past DRAFT.
          ...(locked.status === 'DRAFT' || locked.sent_at ? {} : { sent_at: new Date() }),
          public_token: candidateToken,
          due_date: dueDate,
        },
        select: invoiceDetailSelect,
      });

      await tx.timelineEvent.create({
        data: {
          organization_id: req.user!.organization_id,
          entity_type: 'INVOICE',
          entity_id: inv.id,
          event_type: 'INVOICE_PAYMENT_LINK_CREATED',
          description: `Payment link created for invoice ${inv.invoice_number}`,
          created_by: req.user?.id,
        },
      });

      return { inv, token: candidateToken, created: true };
    });

    const updated = outcome.inv;
    const publicToken = outcome.token;

    if (outcome.created) {
      void logAudit({
        req,
        action: 'invoice.payment_link_created',
        resourceType: 'Invoice',
        resourceId: updated.id,
        metadata: { invoice_number: updated.invoice_number },
      });
    }

    const url = `${env.FRONTEND_URL || ''}/p/invoices/${updated.id}?token=${publicToken}`;
    res.json({ invoice: presentInvoiceDetail(req, stripInvoiceCost(updated, req)), url });
  } catch (err) {
    if (err instanceof RefusedUnderLockError) return res.status(400).json({ error: err.message });
    logger.error('Error creating invoice payment link:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// W4: "Mark as sent" - the office delivered a DRAFT outside the app, so it is issued without an email.
// DRAFT only. Same lock-then-judge shape as createPaymentLink: the status is decided from the row as it
// stands under the invoice lock, so a repeat (or a racing Send) answers 409 and writes nothing twice.
// The automation event is the one Send fires (INVOICE_SENT), as the estimate's markSent fires
// ESTIMATE_SENT for a document delivered outside the app.
export async function markSent(req: Request, res: Response) {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      select: invoiceDetailSelect,
    });
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (!(await canAccessRow(req, 'Invoice', prisma.invoice, param(req, 'id')))) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    if (invoice.status !== 'DRAFT') return res.status(409).json({ error: MARK_SENT_NOT_DRAFT_MESSAGE });

    const cust = invoice.customer ?? invoice.job?.customer;
    const candidateToken = crypto.randomUUID();
    const dueDate = invoice.due_date || calculateDueDate(cust?.payment_type, new Date());

    const updated = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM invoices WHERE id = ${param(req, 'id')}::uuid AND organization_id = ${req.user!.organization_id}::uuid FOR UPDATE`;
      const locked = await tx.invoice.findUniqueOrThrow({
        where: { id: param(req, 'id'), ...tenantWhere(req) },
        select: { status: true, public_token: true, amount_due: true, deposit_credit: true },
      });
      if (locked.status !== 'DRAFT') throw new MarkSentRefusedError();
      const inv = await tx.invoice.update({
        where: { id: param(req, 'id'), ...tenantWhere(req) },
        data: {
          ...issuedStatusOf(locked),
          sent_at: new Date(),
          // A link made earlier stays the link the customer may already hold.
          public_token: locked.public_token ?? candidateToken,
          due_date: dueDate,
        },
        select: invoiceDetailSelect,
      });
      await tx.timelineEvent.create({
        data: {
          organization_id: req.user!.organization_id,
          entity_type: 'INVOICE',
          entity_id: inv.id,
          event_type: 'INVOICE_SENT',
          description: `Invoice ${inv.invoice_number} marked as sent (no email sent)`,
          created_by: req.user?.id,
        },
      });
      return inv;
    });

    void logAudit({
      req,
      action: 'invoice.marked_sent',
      resourceType: 'Invoice',
      resourceId: updated.id,
      metadata: { invoice_number: updated.invoice_number },
    });
    dispatchAutomationEvent({
      type: 'INVOICE_SENT',
      organizationId: req.user!.organization_id,
      entity: { type: 'invoice', id: updated.id, label: updated.invoice_number },
      actorId: req.user?.id ?? null,
    });

    res.json({ invoice: presentInvoiceDetail(req, stripInvoiceCost(updated, req)) });
  } catch (err) {
    if (err instanceof MarkSentRefusedError) return res.status(409).json({ error: MARK_SENT_NOT_DRAFT_MESSAGE });
    logger.error('Error marking invoice as sent:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

const MARK_SENT_NOT_DRAFT_MESSAGE = 'Only a draft invoice can be marked as sent.';
class MarkSentRefusedError extends Error {}

// Thrown inside a transaction when the re-read under the invoice lock finds the request no longer
// valid (another door moved the invoice or the payment after the pre-check). Rolls the write back
// and answers 400 with its message.
class RefusedUnderLockError extends Error {}
// Slice 18: thrown inside a money door's transaction when the invoice, re-read under its lock, no
// longer matches what the door decided on before the lock. Rolls the write back; answers 409.
class InvoiceChangedUnderLockError extends Error {}
const INVOICE_CHANGED_MESSAGE = 'This invoice changed while your change was being saved, so nothing was changed. Reload and try again.';

// Slice 18: the void door refuses an invoice that carries money (MONEY_TAKEN_PAYMENT_WHERE), with
// the reason. Shown verbatim by the void action in the UI.
export const INVOICE_HAS_PAYMENTS_CODE = 'INVOICE_HAS_PAYMENTS';
export const INVOICE_HAS_PAYMENTS_MESSAGE = 'This invoice has payments. Void or refund them first.';
// Slice 29 (conductor ruling): when every payment was already refunded in full, asking for a refund
// again is wrong; only voiding the payments is left.
export const INVOICE_PAYMENTS_REFUNDED_MESSAGE = 'Void its payments first to void this invoice.';
// Slice 29 (conductor ruling 2026-10-08): a REFUNDED invoice is final and is never voided.
export const INVOICE_REFUNDED_FINAL_MESSAGE = 'A refunded invoice is final and cannot be voided.';
// Thrown inside the void transaction when the locked re-check finds money that landed after the
// pre-check. Rolls the void back and answers 409 with the message it carries.
class InvoiceHasPaymentsError extends Error {}

/** The void refusal for an invoice that holds money: which step is left for the user to take. */
async function invoiceHasPaymentsMessage(db: Prisma.TransactionClient, invoiceId: string): Promise<string> {
  const payments = await db.payment.findMany({
    where: { invoice_id: invoiceId, ...MONEY_TAKEN_PAYMENT_WHERE },
    select: { amount: true, state: true, refunds: { select: { amount: true, state: true } } },
  });
  const allRefunded = payments.length > 0
    && payments.every((p) => p.state === 'SUCCEEDED' && refundedCents(p.refunds) >= toCents(p.amount));
  return allRefunded ? INVOICE_PAYMENTS_REFUNDED_MESSAGE : INVOICE_HAS_PAYMENTS_MESSAGE;
}

export async function voidInvoice(req: Request, res: Response) {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      select: { id: true, status: true, invoice_number: true, kind: true, total_amount: true, job_id: true, organization_id: true, estimate: { select: { lead: { select: { commission_owner_id: true } } } }, job: { select: { salesperson_id: true, visits: { select: { assignees: { select: { user_id: true } } } }, estimate: { select: { lead: { select: { lead_assignees: { select: { user_id: true } }, commission_owner_id: true } } } } } } },
    });

    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    // #106 — grant-driven per-instance owner check (a void-Invoice grant org-settings narrows to
    // owned rows must be enforced on THIS row, not just at the subject-level route guard).
    if (!(await canAccessRow(req, 'Invoice', prisma.invoice, param(req, 'id')))) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    if (invoice.status === 'VOIDED') {
      return res.status(400).json({ error: 'Cannot void a PAID or already VOIDED invoice' });
    }
    if (invoice.status === 'DRAFT') {
      return res.status(400).json({ error: 'Use DELETE for DRAFT invoices' });
    }
    if (invoice.status === 'REFUNDED') {
      return res.status(400).json({ error: INVOICE_REFUNDED_FINAL_MESSAGE });
    }
    // Slice 18: a VOIDED invoice is never restored, so money on it (taken, or a bank debit on its
    // way) must be voided first, whatever the status says - PAID, PARTIAL, PARTIALLY_REFUNDED and
    // REFUNDED alike. Checked again under the row lock inside the transaction below.
    const moneyTaken = await prisma.payment.count({ where: { invoice_id: invoice.id, ...MONEY_TAKEN_PAYMENT_WHERE } });
    if (moneyTaken > 0) {
      return res.status(409).json({ error: await invoiceHasPaymentsMessage(prisma, invoice.id), code: INVOICE_HAS_PAYMENTS_CODE });
    }
    // Slice 29: a PAID invoice with no money taken on it was paid by drawn deposit credit only. It
    // voids like a SENT or PARTIAL one, and the credit goes back to the deposit (below).

    // Hoisted to handler scope: both the SYNCED-line auto-return and the LO unwind stamp this
    // actor. Logistic Orders (spec §14 C1): resolve the invoice's LOs PRE-TX (pool discipline).
    const actor = `${req.user!.first_name ?? ''} ${req.user!.last_name ?? ''}`.trim() || 'Unknown';
    const loUnwind = await collectAnchoredLoUnwind(prisma, {
      orgId: req.user!.organization_id,
      where: { invoice_id: invoice.id },
      actor,
      actorUserId: req.user!.id,
    });

    const updated = await prisma.$transaction(async (tx) => {
      // A payment door (settlePayment, recordPayment) may have taken the invoice to PAID since the
      // check above. Take the same invoice lock and re-check under it, so a paid invoice is never
      // turned VOIDED with the money still on it.
      await tx.$executeRaw`SELECT id FROM invoices WHERE id = ${invoice.id}::uuid AND organization_id = ${req.user!.organization_id}::uuid FOR UPDATE`;
      // Same order as the checks above: money taken on the invoice is refused with its reason
      // before the status, so a payment that paid it in full while this waited reads as payments.
      const locked = await tx.invoice.findUniqueOrThrow({ where: { id: invoice.id }, select: { status: true } });
      if (locked.status === 'VOIDED') {
        throw new RefusedUnderLockError('Cannot void a PAID or already VOIDED invoice');
      }
      if (locked.status === 'REFUNDED') throw new RefusedUnderLockError(INVOICE_REFUNDED_FINAL_MESSAGE);
      if ((await tx.payment.count({ where: { invoice_id: invoice.id, ...MONEY_TAKEN_PAYMENT_WHERE } })) > 0) {
        throw new InvoiceHasPaymentsError(await invoiceHasPaymentsMessage(tx, invoice.id));
      }

      const inv = await tx.invoice.update({
        where: { id: param(req, 'id'), ...tenantWhere(req) },
        data: {
          status: 'VOIDED',
          voided_at: new Date(),
          voided_reason: req.body.voided_reason,
        },
        select: invoiceDetailSelect,
      });

      // Inventory P1 (§4.4 / QA-506): void keeps the document + rows visible — auto-return the
      // invoice-BORN synced lines (job-copied lines are NOT_TRACKED by §5.2 construction; the
      // SYNCED filter IS the scope rule) and stamp them UNSYNCED so ledger and pills agree.
      // Re-deduction via sync is impossible afterward: VOIDED fails isInvoiceEditable → 409.
      const syncedLines = await tx.invoiceLineItem.findMany({
        where: { invoice_id: inv.id, stock_status: 'SYNCED' },
        select: { id: true, quantity: true, price_book_item_id: true, stock_location_id: true },
      });
      if (syncedLines.length > 0) {
        await returnSyncedLines(tx, syncedLines, {
          orgId: req.user!.organization_id,
          reference: `${invoice.invoice_number} voided`,
          actor,
          actorUserId: req.user!.id,
          jobId: invoice.job_id ?? null,
          lineRef: 'invoice',
        });
        await tx.invoiceLineItem.updateMany({
          where: { invoice_id: inv.id, stock_status: 'SYNCED' },
          data: { stock_status: 'UNSYNCED' },
        });
      }

      // Logistic Orders (spec §14 C1): return the PROCESSED LOs anchored to THIS invoice — the C1
      // stranded-stock path, since a COMPLETED job's only unwind is its invoice's void (E9). Open
      // LOs are LEFT ALONE (cancelOpen: false): a void does not invalidate not-yet-processed intent.
      await applyAnchoredLoUnwind(tx, loUnwind, { cancelOpen: false });

      // §5 — voiding un-issues the bill: decrement the job's cached amount_invoiced. Only a
      // STANDARD invoice on a job counts as billed (a kind=DEPOSIT void never touches it).
      if (invoice.kind === 'STANDARD' && invoice.job_id) {
        await tx.job.update({
          where: { id: invoice.job_id },
          data: { amount_invoiced: { decrement: Number(invoice.total_amount) } },
        });
      }

      await tx.timelineEvent.create({
        data: {
          organization_id: req.user!.organization_id,
          entity_type: 'INVOICE',
          entity_id: inv.id,
          event_type: 'INVOICE_VOIDED',
          description: `Invoice ${invoice.invoice_number} voided: ${req.body.voided_reason}`,
          created_by: req.user?.id,
        },
      });

      // §8 — voiding a STANDARD invoice un-applies the deposit credit DRAWN ONTO it (the mirror of
      // the void-PAYMENT cascade ~1769-1813, which keys on deposit_invoice_id). Here the voided
      // invoice IS the target, so we key on target_invoice_id. Setting reversed_at re-frees the
      // deposit invoice's credit (remainingDepositCredit sums reversed_at IS NULL) so a reissued
      // invoice re-draws it. We do NOT touch THIS invoice's amount_due/status (already VOIDED) and
      // we do NOT touch the deposit invoice — only the ledger + this invoice's own synthetic payment.
      const now = new Date();
      const reversed = await tx.depositCreditApplication.updateMany({
        where: { target_invoice_id: inv.id, reversed_at: null, ...tenantWhere(req) },
        data: { reversed_at: now },
      });

      if (reversed.count > 0) {
        // Void the synthetic DEPOSIT-CREDIT Payment this invoice was born with (create() lines
        // 475-485). REQUIRED for correctness: statement.controller.ts skips the billed line for a
        // VOIDED invoice (line 181) but still classifies a live synthetic payment as a -amount
        // deposit_credit event (186-189) → a phantom credit. Voiding it drops it from the
        // voided_at:null payments filter (line 51-52). Also keeps reconcile.ts (excludes voided
        // payments) holding on the dead doc.
        await tx.payment.updateMany({
          where: { invoice_id: inv.id, reference_number: DEPOSIT_CREDIT_REFERENCE, voided_at: null },
          data: { voided_at: now, voided_reason: 'Invoice voided', voided_by: req.user!.id },
        });

        await tx.timelineEvent.create({
          data: {
            organization_id: req.user!.organization_id,
            entity_type: 'INVOICE',
            entity_id: inv.id,
            event_type: 'DEPOSIT_CREDIT_REVERSED',
            description: `Deposit credit released on invoice ${invoice.invoice_number} (voided)`,
            created_by: req.user?.id,
          },
        });
      }

      return inv;
    });

    // Slice 18: a customer holding an old checkout link must not be able to pay the voided bill.
    // Post-commit and fire-and-forget: a processor outage never fails the void.
    void closeOpenCheckoutLinks(req.user!.organization_id, [invoice], 'invoice_voided');

    // In-app notification: billing.voided, on M6's two-lane chain and sent once the response has gone out.
    queueInvoiceAlert({
      verb: 'billing.voided',
      organizationId: req.user!.organization_id,
      actorId: req.user?.id ?? null,
      object: { type: 'INVOICE', id: param(req, 'id'), label: invoice.invoice_number },
      data: { object_label: invoice.invoice_number },
    });

    void logAudit({
      req,
      action: 'invoice.voided',
      resourceType: 'Invoice',
      resourceId: updated.id,
    });
    res.json({ invoice: presentInvoiceDetail(req, stripInvoiceCost(updated, req)) });
  } catch (err) {
    if (err instanceof RefusedUnderLockError) return res.status(400).json({ error: err.message });
    if (err instanceof InvoiceHasPaymentsError) {
      return res.status(409).json({ error: err.message || INVOICE_HAS_PAYMENTS_MESSAGE, code: INVOICE_HAS_PAYMENTS_CODE });
    }
    logger.error('Error voiding invoice:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// SERV10X-59 — mirrors lead.controller.ts's getTimeline. metadata carries field NAMES only
// (never values — see emitInvoiceEditedIfMaterial in invoice-lines.controller.ts), so no
// money-redaction pass is needed here the way job.controller.ts's timeline route needs one.
export async function getTimeline(req: Request, res: Response) {
  try {
    const id = param(req, 'id');

    const invoice = await prisma.invoice.findUnique({ where: { id, ...tenantWhere(req) } });
    if (!invoice) {
      res.status(404).json({ error: 'Invoice not found' });
      return;
    }

    if (!(await canAccessRow(req, 'Invoice', prisma.invoice, id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const events = await prisma.timelineEvent.findMany({
      where: { entity_type: 'INVOICE', entity_id: id, ...tenantWhere(req) },
      select: {
        id: true,
        event_type: true,
        description: true,
        metadata: true,
        created_at: true,
        creator: { select: { id: true, first_name: true, last_name: true } },
      },
      orderBy: { created_at: 'desc' },
    });

    res.json({ events: events.map((e) => ({ ...e, metadata: withoutProcessorIdKeys(e.metadata, { scrubValues: true }) })) });
  } catch (err) {
    logger.error('Error fetching invoice timeline:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getNotes(req: Request, res: Response) {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      select: { id: true, job: { select: { visits: { select: { assignees: { select: { user_id: true } } } }, estimate: { select: { lead: { select: { lead_assignees: { select: { user_id: true } } } } } } } } },
    });
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (!(await canAccessRow(req, 'Invoice', prisma.invoice, param(req, 'id')))) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const notes = await prisma.note.findMany({
      where: { entity_type: 'INVOICE', entity_id: param(req, 'id'), ...tenantWhere(req) },
      include: { creator: { select: { id: true, first_name: true, last_name: true } } },
      orderBy: { created_at: 'desc' },
    });

    res.json({ notes });
  } catch (err) {
    logger.error('Error fetching invoice notes:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

const RECORD_PAYMENT_NOT_PAYABLE = 'Payments can only be recorded on DRAFT, SENT, or PARTIAL invoices';
// Thrown inside recordPayment's transaction when the locked re-read finds the invoice no longer
// payable (voided or paid by another request after the pre-check). Rolls the payment back.
class InvoiceNotPayableError extends Error {}
// Thrown when a hand payment would take money a bank debit still processing on the invoice is collecting.
class HandPaymentProcessingError extends Error {
  constructor(readonly processingCents: number) { super('bank payment processing'); }
}

export async function recordPayment(req: Request, res: Response) {
  try {
    const { amount, method, paid_at, reference_number, notes, tip_amount } = req.body;

    // 1. Fetch invoice with access fields
    const invoice = await prisma.invoice.findUnique({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      select: {
        id: true,
        invoice_number: true,
        status: true,
        kind: true,
        amount_due: true,
        total_amount: true,
        // For a kind=DEPOSIT invoice, paying it also approves the estimate + wins the lead.
        estimate: { select: { id: true, lead_id: true, status: true, estimate_number: true, lead: { select: { commission_owner_id: true, status: true } } } },
        customer: { select: { id: true, first_name: true, last_name: true, company_name: true, email: true } },
        job: {
          select: {
            id: true,
            job_number: true,
            salesperson_id: true,
            visits: { select: { assignees: { select: { user_id: true } } } },
            customer: { select: { id: true, first_name: true, last_name: true, company_name: true, email: true } },
            estimate: { select: { lead: { select: { lead_assignees: { select: { user_id: true } }, commission_owner_id: true } } } },
          },
        },
      },
    });

    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    // Status guard: DRAFT, SENT, or PARTIAL — sending first is not required. Checked again
    // under the row lock inside the transaction below.
    if (invoice.status !== 'DRAFT' && invoice.status !== 'SENT' && invoice.status !== 'PARTIAL') {
      return res.status(400).json({ error: RECORD_PAYMENT_NOT_PAYABLE });
    }

    // Overpayment (§8): amount > amount_due is ALLOWED — record the real money received,
    // flag the excess, default refund-the-excess (no pre-lock reject).

    if (!(await canAccessRow(req, 'Invoice', prisma.invoice, param(req, 'id')))) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    // The method must be one the company accepts and one of the person's Allowed payment methods.
    if (await refuseDisallowedPaymentMethod(req, res, method)) return;

    // 2. Transaction with row locking
    const result = await prisma.$transaction(async (tx) => {
      // Lock the invoice row, then re-read it. Without the lock the re-read cannot see a void
      // another transaction is committing (a job cancel), and the update below would land on
      // top of it and turn VOIDED back into PAID (#891). Once the lock is held, the re-read
      // sees the committed status and amount_due.
      await tx.$executeRaw`SELECT id FROM invoices WHERE id = ${param(req, 'id')}::uuid AND organization_id = ${req.user!.organization_id}::uuid FOR UPDATE`;
      const lockedInvoice = await tx.invoice.findUniqueOrThrow({
        where: { id: param(req, 'id'), ...tenantWhere(req) },
        select: { amount_due: true, status: true, payments: { where: PROCESSING_PAYMENT_WHERE, select: { amount: true } } },
      });
      if (lockedInvoice.status !== 'DRAFT' && lockedInvoice.status !== 'SENT' && lockedInvoice.status !== 'PARTIAL') {
        throw new InvoiceNotPayableError();
      }
      const currentDue = Number(lockedInvoice.amount_due);
      // Slice 28b: work from payable-now. A bank debit still processing is not collected a second
      // time by hand (it would land as an unapplied capture when it clears).
      const processingCents = paidCents(lockedInvoice.payments ?? []);
      if (processingCents > 0 && exceedsPayableNow(toCents(lockedInvoice.amount_due), processingCents, toCents(amount))) {
        throw new HandPaymentProcessingError(processingCents);
      }

      // Overpayment: clamp amount_due at 0; the excess is the recorded-money overage.
      const overpaid = Math.round(Math.max(amount - currentDue, 0) * 100) / 100;
      const newAmountDue = Math.round(Math.max(currentDue - amount, 0) * 100) / 100;
      const isFullyPaid = newAmountDue <= 0;

      // Create Payment
      const payment = await tx.payment.create({
        data: {
          invoice_id: param(req, 'id'),
          amount,
          method,
          paid_at: paid_at ? new Date(paid_at) : new Date(),
          collected_by: req.user?.id!,
          reference_number: reference_number || null,
          notes: notes || null,
          tip_amount: tip_amount > 0 ? tip_amount : null,
          // Audit: staff collected this on the customer's behalf, so the collecting user is also
          // the creator (spec Part A - "a payment taken by staff is USER, the collecting user").
          ...createdByUser(req),
        },
        include: { collector: { select: { id: true, first_name: true, last_name: true } } },
      });

      // Slice 29 (from the slice 14 acceptance): the stored net collected from the ledger rows,
      // under this lock, as every money writer does (reports read the column). This door only
      // takes DRAFT/SENT/PARTIAL invoices, whose status the re-derive leaves to the write below.
      await rederiveRefundTotals(tx, { invoiceId: param(req, 'id'), organizationId: req.user!.organization_id });

      // Update invoice
      const updatedInvoice = await tx.invoice.update({
        where: { id: param(req, 'id'), ...tenantWhere(req) },
        data: {
          amount_due: newAmountDue,
          status: isFullyPaid ? 'PAID' : 'PARTIAL',
          paid_at: isFullyPaid ? new Date() : undefined,
        },
        select: invoiceDetailSelect,
      });

      // Timeline event: payment received
      await tx.timelineEvent.create({
        data: {
          organization_id: req.user!.organization_id,
          entity_type: 'INVOICE',
          entity_id: param(req, 'id'),
          event_type: 'PAYMENT_RECEIVED',
          description: `Payment of $${amount.toFixed(2)} received via ${methodLabel(method)}`
            + (tip_amount > 0 ? ` (plus $${Number(tip_amount).toFixed(2)} tip)` : ''),
          created_by: req.user?.id,
        },
      });

      // S06.7: the same payment on the job's own history (a standalone invoice writes nothing).
      await recordJobMoneyMovement(
        tx, { orgId: req.user!.organization_id, userId: req.user!.id }, invoice.job?.id, invoice, 'PAYMENT_RECORDED',
        { amount, method, invoiceEventType: 'PAYMENT_RECEIVED', paymentId: payment.id },
      );

      // Timeline event: invoice fully paid
      if (isFullyPaid) {
        await tx.timelineEvent.create({
          data: {
            organization_id: req.user!.organization_id,
            entity_type: 'INVOICE',
            entity_id: param(req, 'id'),
            event_type: 'INVOICE_PAID',
            description: `Invoice ${invoice.invoice_number} fully paid`,
            created_by: req.user?.id,
          },
        });
      }

      // ── kind=DEPOSIT invoice fully paid via the generic door → approve estimate + win lead ──
      // Parity with the Stripe webhook deposit branch (webhook.controller.ts:303-325) and
      // estimate.controller.recordEstimatePayment. Idempotent on re-pay (COL-07): an already-
      // WON estimate is a no-op write and the lead.updateMany matches zero rows.
      if (isFullyPaid && invoice.kind === 'DEPOSIT' && invoice.estimate) {
        const est = invoice.estimate;
        await tx.estimate.update({
          where: { id: est.id, ...tenantWhere(req) },
          data: { status: 'WON', approved_at: new Date() },
        });
        // Spec #1751 D6 — the one status writer. It carries the tenant scope itself (it takes
        // orgId and puts it in the WHERE clause), so the `...tenantWhere(req)` spread this
        // replaces is preserved rather than dropped.
        if (est.lead_id) {
          await transitionLeadStatus(tx, {
            leadId: est.lead_id,
            orgId: req.user!.organization_id,
            to: 'WON',
            from: est.lead!.status,
            actorId: req.user?.id ?? null,
            description: 'Lead won — deposit invoice paid in full',
            metadata: { estimate_id: est.id, estimate_number: est.estimate_number, invoice_id: invoice.id, via: 'deposit_invoice_paid' },
          });
        }
        await tx.timelineEvent.create({
          data: {
            organization_id: req.user!.organization_id,
            entity_type: 'ESTIMATE',
            entity_id: est.id,
            event_type: 'DEPOSIT_PAID',
            description: `Deposit of $${amount.toFixed(2)} paid via ${method} for estimate ${est.estimate_number}`,
            created_by: req.user?.id,
          },
        });
        await tx.timelineEvent.create({
          data: {
            organization_id: req.user!.organization_id,
            entity_type: 'ESTIMATE',
            entity_id: est.id,
            event_type: 'APPROVED',
            description: `Estimate ${est.estimate_number} approved (deposit paid via ${method})`,
            created_by: req.user?.id,
          },
        });
      }

      // Overpayment (§8): flag the excess; default policy is refund-the-excess (executed
      // by an admin via the unified refund flow). We surface it on the timeline now.
      if (overpaid > 0) {
        await tx.timelineEvent.create({
          data: {
            organization_id: req.user!.organization_id,
            entity_type: 'INVOICE',
            entity_id: param(req, 'id'),
            event_type: 'OVERPAYMENT_FLAGGED',
            description: `Overpayment of $${overpaid.toFixed(2)} received on invoice ${invoice.invoice_number} — refund the excess`,
            metadata: { overpaid, default_action: 'refund_excess' },
            created_by: req.user?.id,
          },
        });
      }

      return { invoice: updatedInvoice, payment, isFullyPaid, overpaid };
    });

    // Slice 14: a link opened before this payment asks for the old balance. Post-commit and
    // fire-and-forget: a processor outage never fails the payment.
    void closeOpenCheckoutLinks(req.user!.organization_id, [invoice], 'manual_payment');

    // 3. Fire-and-forget emails — resolve customer directly, falling back to job.customer.
    const c = invoice.customer ?? invoice.job?.customer;
    const customerName = [c?.first_name, c?.last_name].filter(Boolean).join(' ') || c?.company_name || 'Customer';
    const customerEmail = c?.email;

    if (customerEmail) {
      sendPaymentReceivedEmail({
        organizationId: req.user!.organization_id,
        to: customerEmail,
        customerName,
        invoiceNumber: invoice.invoice_number,
        amount,
        method,
        newBalance: Number(result.invoice.amount_due),
        record: {
          organizationId: req.user!.organization_id,
          customerId: c?.id,
          jobId: invoice.job?.id,
          jobLabel: invoice.job?.job_number,
          entityType: 'invoice',
          entityId: invoice.id,
        },
      }).catch(err => logger.error('Failed to send payment received email:', err));
    }

    // The internal "[Internal] Payment received" alert email used to fire here. It was
    // addressed to EMAIL_FROM - the app's own no-reply sender - so Resend suppressed
    // every copy and no human ever saw one. The in-app alert below already tells the people
    // who handle this payment, so the email was redundant as well as undeliverable.

    // In-app notification: billing.payment_received / billing.partial_payment, on M6's two-lane chain and sent once the response
    // has gone out.
    queueInvoiceAlert({
      verb: result.isFullyPaid ? 'billing.payment_received' : 'billing.partial_payment',
      organizationId: req.user!.organization_id,
      actorId: req.user?.id ?? null,
      object: { type: 'INVOICE', id: param(req, 'id'), label: invoice.invoice_number },
      data: { object_label: invoice.invoice_number, amount: Number(amount).toFixed(2) },
    });

    // estimate.deposit_paid: parity with estimate.controller.ts + webhook.controller.ts (#268).
    // dedupKey matches the other two doors so multi-door payment never double-pins.
    if (result.isFullyPaid && invoice.kind === 'DEPOSIT' && invoice.estimate) {
      queueEstimateAlert({
        verb: 'estimate.deposit_paid',
        organizationId: req.user!.organization_id,
        actorId: req.user?.id ?? null,
        estimateId: invoice.estimate.id,
        data: { lead_id: invoice.estimate.lead_id },
        dedupKey: `estimate.deposit_paid:${invoice.estimate.id}`,
      });
      // Automation Center — this door approves the estimate (status→APPROVED above),
      // so dispatch ESTIMATE_APPROVED like the public/record-payment/Stripe doors.
      // Same-entity engine dedupe collapses any overlap across doors.
      dispatchAutomationEvent({
        type: 'ESTIMATE_APPROVED',
        organizationId: req.user!.organization_id,
        entity: { type: 'estimate', id: invoice.estimate.id, label: invoice.estimate.estimate_number },
        actorId: req.user?.id ?? null,
      });
    }

    // ─── Automation Center event — fires only when the invoice reaches PAID ──
    if (result.isFullyPaid) {
      dispatchAutomationEvent({
        type: 'INVOICE_PAID',
        organizationId: req.user!.organization_id,
        entity: { type: 'invoice', id: param(req, 'id'), label: invoice.invoice_number },
        actorId: req.user?.id ?? null,
      });
    }

    void logAudit({
      req,
      action: 'invoice.payment_recorded',
      resourceType: 'Invoice',
      resourceId: param(req, 'id'),
      metadata: { amount, fully_paid: result.isFullyPaid },
    });
    res.status(201).json({ invoice: presentInvoiceDetail(req, stripInvoiceCost(result.invoice, req)), payment: withoutProcessorIdKeys(result.payment), overpaid: result.overpaid });
  } catch (err: any) {
    if (err instanceof InvoiceNotPayableError) {
      return res.status(400).json({ error: RECORD_PAYMENT_NOT_PAYABLE });
    }
    if (err instanceof HandPaymentProcessingError) {
      return res.status(409).json({ error: processingBlocksHandPaymentMessage(err.processingCents, 'invoice') });
    }
    logger.error('Error recording payment:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// --- Public Handlers (no auth) ---

// Payments go-live slice 19 - getPublic and createPublicCheckout both read what a public invoice
// offers through lib/payment-options.ts (paymentOptionsFor), so the page and the money door can
// never disagree. That module now owns the chain that used to live here (org accepted methods ->
// fixed default; CARD only while charges are enabled and CARD is accepted, #904/#927). The legacy
// per-org `available_payment_methods` settings row is no longer read (conductor decision
// 2026-10-06): it shadowed the defaults the owner saves.
export async function getPublic(req: Request, res: Response) {
  try {
    const token = req.query.token as string;
    if (!token) return res.status(400).json({ error: 'Token required' });

    const invoice = await prisma.invoice.findFirst({
      where: { id: param(req, 'id'), public_token: token },
      select: {
        id: true,
        invoice_number: true,
        organization_id: true,
        status: true,
        subtotal: true,
        discount_amount: true,
        tax_amount: true,
        deposit_credit: true,
        total_amount: true,
        amount_due: true,
        due_date: true,
        sent_at: true,
        paid_at: true,
        created_at: true,
        kind: true,
        // Slice 24 (#1073) - the scope of work the customer is paying for. The raw column carries
        // `internal_cost` (margin), so it leaves this handler only through `toPublicScopes`.
        scopes: true,
        // #2031 slice 5 — read so the page can stop offering to pay a superseded deposit: the
        // flag, plus the inputs the deposit figure is calculated from (F4 — the flag alone cannot
        // tell a moved figure from an unmoved one). Stripped out of the echoed invoice below: this
        // is internal state, not part of what the customer is shown.
        estimate: { select: { status: true, modified_after_send: true, deposit_type: true, deposit_value: true, total_amount: true } },
        // Top-level customer for job-less (deposit/orphan) invoices; job.customer fallback below.
        // F-55: email/phone withheld from the public (token) payload — display name only. The
        // public invoice page renders the customer's name, not their contact details.
        customer: {
          select: { first_name: true, last_name: true, company_name: true },
        },
        // Phase 2c — the invoice's OWN lines. A kind=DEPOSIT (or future orphan) invoice has no job,
        // so its line display must come from InvoiceLineItem, not job.estimate.line_items/job.charges.
        line_items: {
          select: { id: true, sequence: true, description: true, quantity: true, unit_price: true, is_taxable: true, line_total: true },
          orderBy: { sequence: 'asc' as const },
        },
        job: {
          select: {
            job_number: true,
            estimate: {
              select: {
                estimate_number: true,
                discount_name: true,
                discount_type: true,
                discount_value: true,
                tax_rate: true,
                line_items: {
                  select: { id: true, sequence: true, description: true, quantity: true, unit_price: true, is_taxable: true, line_total: true },
                  orderBy: { sequence: 'asc' as const },
                },
              },
            },
            // F-55: email/phone withheld from the public (token) payload — display name only.
            customer: {
              select: { first_name: true, last_name: true, company_name: true },
            },
            // Ran 2026-10-08 (payments go-live slice 26): the customer's invoice shows the full
            // address, street included - billing needs it, and the invoice PDF and the public
            // estimate already print it. This lifts F-55 for the street on THIS route only; the
            // payer's contact, costs, tenant id and token stay withheld.
            service_location: {
              select: { address_line1: true, address_line2: true, city: true, state: true, zip: true },
            },
          },
        },
        payments: {
          // Payments go-live slice 05: state, so the page totals SUCCEEDED payments only. Slice 09:
          // a voided payment did not happen, whoever voided it (staff voiding a payment recorded in
          // error, a lost dispute, a returned bank payment), so the customer's page never lists it.
          where: {
            voided_at: null,
            // Slice 33b: the synthetic deposit-credit row is the same credit the invoice's own
            // "Deposit credit" line states; listing it too printed the credit twice. `not` alone
            // would drop NULL references, so a payment with no reference is named.
            OR: [{ reference_number: null }, { reference_number: { not: DEPOSIT_CREDIT_REFERENCE } }],
          },
          // Slice 28: how they paid (their own card or bank, as they saw it at checkout).
          select: {
            id: true, amount: true, method: true, paid_at: true, state: true,
            wallet: true, card_brand: true, card_last4: true, bank_name: true, bank_last4: true,
          },
          orderBy: { paid_at: 'asc' as const },
        },
        // Slice 28: what was given back or is on its way. A refund that failed gave nothing back, and
        // who made it and why are staff's business: the customer gets the amount, state and date.
        refunds: {
          where: { state: { in: ['SUCCEEDED', 'PENDING'] } },
          select: { id: true, amount: true, state: true, created_at: true },
          orderBy: { created_at: 'asc' as const },
        },
        // Slice 19 - this invoice's payment-option overrides, read for the resolver only and
        // stripped from the echoed invoice below.
        payment_methods_override: true,
        allow_partial_payment: true,
      },
    });

    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    // Fetch payment settings + org branding in parallel (use invoice's own org_id — public route has no req.user)
    const invOrgId = invoice.organization_id;
    const [checkSetting, cashSetting, org] = await Promise.all([
      prisma.appSetting.findUnique({ where: { organization_id_key: { organization_id: invOrgId, key: 'check_instructions' } } }),
      prisma.appSetting.findUnique({ where: { organization_id_key: { organization_id: invOrgId, key: 'cash_instructions' } } }),
      prisma.organization.findUnique({ where: { id: invOrgId } }),
    ]);

    // Payments go-live slice 19 - the page shows exactly what the resolver offers for THIS
    // invoice (org defaults x its overrides x what the account can take); the checkout door
    // asks the same resolver, so the two cannot disagree.
    const options = paymentOptionsFor(org, {
      methods: storedMethodsOverride(invoice.payment_methods_override),
      // A deposit is always paid in full, whatever the stored flag says.
      allow_partial: invoice.kind === 'DEPOSIT' ? false : invoice.allow_partial_payment,
    });
    const availableMethods = options.methods;

    const organization = org ? {
      name: org.name,
      logo_url: org.logo_url,
      brand_color: org.brand_color,
      phone: org.phone,
      // SRVW-54 - beside `phone`, never appended to it (see the estimate twin).
      phone_ext: org.phone_ext,
      // Mobile slice 28 - the business's own published address, a mail link on the public page
      // (the estimate twin already sends it). Never the payer's email, which stays withheld.
      email: org.email ?? null,
      // #1821 — the customer reading the public page is UNAUTHENTICATED, so the frontend has
      // no org context and no `useScheduleTimezone()`. Without this field the page can only
      // fall back to the customer's OWN browser zone, which is genuinely unknown and
      // routinely not the business's. Resolved here rather than sent raw so the wire
      // contract is always a valid IANA zone; `Organization.timezone` is nullable and
      // DEFAULT_TIMEZONE is the same 'America/New_York' the authed app falls back to
      // (lib/timezone.ts:7, mirrored by the frontend's DEFAULT_SCHEDULE_TIMEZONE at
      // lib/schedule-tz.ts:31), so a zone-less org reads identically on both surfaces.
      // Costs nothing: the findUnique above has no `select`, so `org.timezone` is already
      // loaded — `getOrgTimezone` would be a second round trip for a row we already hold,
      // and it needs a `req.user` this unscopedRequest route does not have.
      timezone: org.timezone || DEFAULT_TIMEZONE,
      // Slice 25 - the org's raw accepted methods are not sent: the page reads only what the
      // resolver offers this invoice (available_payment_methods below).
    } : null;

    // #2031 slice 5 — the same predicate the checkout POST refuses on, so the page and the money
    // door can never disagree about whether this deposit can be paid right now. The REASON rides
    // along because the page has to explain itself: a recalled estimate and a stale figure both
    // withdraw the payment options, and they are different things to tell a customer.
    const holdReason = depositHoldReason(invoice, org);
    // Payments go-live slice 25 - the bank money still clearing (listed payments are not voided;
    // only PROCESSING ones are in flight), what can be paid online now, and the one state the page
    // renders from. The checkout door refuses every state but PAYABLE.
    const amountDueCents = toCents(invoice.amount_due);
    const processingCents = paidCents(invoice.payments.filter((p) => p.state === 'PROCESSING'));
    const payState = publicPayState({ status: invoice.status, amountDueCents, processingCents, held: holdReason !== null, estimateClosed: depositEstimateClosed(invoice), deposit: invoice.kind === 'DEPOSIT' });
    // The estimate's internal state was read for that decision only; the customer's payload does
    // not carry it.
    const {
      estimate: _internalEstimateState,
      // Slice 24 - read to find the org's settings above; the tenant id is not the customer's.
      organization_id: _tenantId,
      payment_methods_override: _methodsOverride,
      allow_partial_payment: _allowPartial,
      ...publicInvoice
    } = invoice;

    res.json({
      // #1997 — a fail-closed BACKSTOP, not the protection itself: this route is unauthenticated,
      // so the presenter can only answer "not readable". What actually keeps contact off this
      // payload is the select above (F-55, display name only). See estimate.controller.ts's
      // `getPublic` for the same note.
      invoice: presentInvoiceDetail(req, {
        ...publicInvoice,
        // The processor sandbox's own name for its test bank is the processor's brand, never a bank name.
        payments: publicInvoice.payments.map((p) => ({ ...p, bank_name: publicBankName(p.bank_name) })),
        scopes: toPublicScopes(publicInvoice.scopes),
      }),
      organization,
      deposit_hold_reason: holdReason,
      pay_state: payState,
      processing_amount: fromCents(processingCents),
      // Only a PAYABLE invoice has money to take: a voided or closed invoice keeps its amount_due
      // on the row, and the page must never read that as something to pay.
      payable_now: payState === 'PAYABLE' ? fromCents(payableNowCents(amountDueCents, processingCents)) : 0,
      available_payment_methods: availableMethods,
      payment_options: {
        ...options,
        tips: {
          ...options.tips,
          // What each preset tips when paying the whole amount due: a percentage of its pre-tax
          // share (story 27). The partial-amount field recomputes it for a smaller amount.
          preset_amounts: tipPresetAmountsCents({
            presets: options.tips.presets,
            payingCents: Math.round(Number(invoice.amount_due) * 100),
            totalCents: Math.round(Number(invoice.total_amount) * 100),
            taxCents: Math.round(Number(invoice.tax_amount) * 100),
          }).map((cents) => cents / 100),
        },
      },
      payment_instructions: {
        // Slice 19 - the org's instructions, and only while bank transfer is offered here.
        bank_transfer: options.bank_transfer_instructions,
        check: checkSetting?.value ?? null,
        cash: cashSetting?.value ?? null,
      },
      // Slice 8 — the tip chips render off this. Slice 19: the org's presets, empty while tips are off.
      tip_preset_bps: options.tips.presets.map((pct) => pct * 100),
    });
  } catch (err) {
    logger.error('Error fetching public invoice:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// Slice 7 (D10/D11) — invoices only, per the plan (the estimate-deposit checkout path is
// untouched). A tip is a customer input over a public token-authed route: untrusted, so it is
// bounded and re-validated server-side here rather than merely re-read from the client.
// A figure with a fraction of a cent is refused, never rounded: the page limits input to two decimals.
const wholeCents = (n: number) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
const publicCheckoutSchema = z.object({
  tip: z.number().finite().min(0).max(10000).refine(wholeCents).optional(),
  // Payments go-live slice 26 - the partial amount the homeowner chose to pay now, in dollars.
  // Untrusted like the tip: bounded again by the pricing module and refused unless this invoice
  // allows partial payments. Omitted = pay what is payable now in full.
  amount: z.number().finite().min(0).max(10000000).refine(wholeCents).optional(),
  // Payments go-live slice 12 - one method per session. Omitted = card, which is what every
  // public page sent before the bank button existed.
  method: z.enum(['card', 'bank']).optional(),
  // Slice 27 - a deposit paid from the ESTIMATE page returns there instead of to the deposit invoice page.
  return_to: z.literal('estimate').optional(),
  // Payments go-live slice 25 - what the page showed as payable now, in dollars. When it no longer
  // matches, the invoice changed under the page and no session opens. Optional: a page cached from
  // before this field still pays (the session's own re-check below still guards it).
  expected_amount: z.number().finite().min(0).optional(),
});

/**
 * Payments go-live slice 25 - the codes the public invoice page reads (never the wording), so a
 * refusal tells the homeowner the true state instead of "something went wrong".
 */
export const INVOICE_CHANGED_CODE = 'INVOICE_CHANGED';
export const INVOICE_NOT_PAYABLE_CODE = 'INVOICE_NOT_PAYABLE';
export const PAYMENT_PROCESSING_CODE = 'PAYMENT_PROCESSING';
/**
 * Slice 26 - what the page was offering (a method, a tip, a partial amount) is no longer offered on
 * this invoice: the page re-reads it and shows what is. Inline codes for a bad figure the
 * homeowner typed: the page shows them beside the field.
 */
export const PAYMENT_OPTIONS_CHANGED_CODE = 'PAYMENT_OPTIONS_CHANGED';
export const AMOUNT_BELOW_MINIMUM_CODE = 'AMOUNT_BELOW_MINIMUM';
/** A figure with a fraction of a cent: a different fix from "too small", so a different code. */
export const AMOUNT_NOT_WHOLE_CENTS_CODE = 'AMOUNT_NOT_WHOLE_CENTS';
export const AMOUNT_ABOVE_PAYABLE_NOW_CODE = 'AMOUNT_ABOVE_PAYABLE_NOW';
export const TIP_OUT_OF_BOUNDS_CODE = 'TIP_OUT_OF_BOUNDS';
const optionsChanged = (error: string) => ({ error, code: PAYMENT_OPTIONS_CHANGED_CODE });
const INVOICE_CHANGED_REFUSAL = { error: 'This invoice has changed since it was opened.', code: INVOICE_CHANGED_CODE };

// #2031 slice 5 — user-visible copy. It reaches the customer on the public deposit page, so it
// names no vendor and no account: the deposit is ServWave's own document, and the remedy is the
// organization the customer is already dealing with.
/**
 * The machine-readable half of the refusal. The public page can be OLDER than the estimate behind
 * it — it loaded while the deposit was payable and offered a Pay button — so it has to be able to
 * recognise this particular 400 and say something true about it. It matches on this, never on the
 * wording: matching wording is how the refusal came to be answered with "please try again" (F5).
 */
export const DEPOSIT_SUPERSEDED_CODE = 'DEPOSIT_SUPERSEDED';

export const DEPOSIT_SUPERSEDED_MESSAGE =
  'This deposit request is out of date because the estimate has changed. Please contact us for the current amount.';

/**
 * The second way a deposit link stops being payable: the estimate behind it was recalled to draft.
 * Its own code, because it is a different thing to be told — nothing is out of date yet, the
 * document has simply been withdrawn for changes — and the page has to be able to say which.
 */
export const DEPOSIT_ON_HOLD_CODE = 'DEPOSIT_ON_HOLD';

export const DEPOSIT_ON_HOLD_MESSAGE =
  'This deposit is on hold while the estimate is being updated. Please contact us if you would like to pay it now.';

/** Why a deposit link is refusing money right now. */
export type DepositHoldReason = 'SUPERSEDED' | 'ESTIMATE_IN_DRAFT';

/** The refusal a door hands back. One reason → one code → one piece of customer copy. */
export function depositHoldRefusal(reason: DepositHoldReason): { error: string; code: string } {
  return reason === 'ESTIMATE_IN_DRAFT'
    ? { error: DEPOSIT_ON_HOLD_MESSAGE, code: DEPOSIT_ON_HOLD_CODE }
    : { error: DEPOSIT_SUPERSEDED_MESSAGE, code: DEPOSIT_SUPERSEDED_CODE };
}

/**
 * Payments go-live slice 15 - a deposit takes money only while it is open (SENT, or PARTIAL after
 * part of it was recorded by hand). Every other status is refused with a code the public page can
 * explain: the customer holding an old link or an old page needs to be told WHY, not "try again".
 */
export const DEPOSIT_ALREADY_PAID_CODE = 'DEPOSIT_ALREADY_PAID';
export const DEPOSIT_ALREADY_PAID_MESSAGE = 'This deposit has already been paid.';
export const DEPOSIT_VOIDED_CODE = 'DEPOSIT_VOIDED';
export const DEPOSIT_VOIDED_MESSAGE =
  'This deposit request has been cancelled. Please contact us if you have any questions.';
/** Any other closed state (a draft, a refunded or disputed deposit). */
export const DEPOSIT_CLOSED_CODE = 'DEPOSIT_CLOSED';
export const DEPOSIT_CLOSED_MESSAGE =
  'This deposit cannot be paid online right now. Please contact us to arrange payment.';

/**
 * Why this deposit cannot take money right now, as the refusal a door answers with, or null when
 * it can. The deposit's own status is asked first (a paid deposit is "already paid", whatever the
 * estimate did since), then the hold (depositHoldReason). The estimate's approve door and the
 * deposit link's checkout both answer through this, so they never disagree.
 */
export function depositCheckoutRefusal(
  invoice: DepositSupersedeCheck & { status: string },
  org: DepositOrgDefaults | null,
): { error: string; code: string } | null {
  if (invoice.status === 'PAID') return { error: DEPOSIT_ALREADY_PAID_MESSAGE, code: DEPOSIT_ALREADY_PAID_CODE };
  if (invoice.status === 'VOIDED') return { error: DEPOSIT_VOIDED_MESSAGE, code: DEPOSIT_VOIDED_CODE };
  if (invoice.status !== 'SENT' && invoice.status !== 'PARTIAL') return { error: DEPOSIT_CLOSED_MESSAGE, code: DEPOSIT_CLOSED_CODE };
  // Slice 27 (slice 15 review) - a cancelled or declined estimate closes its deposit for good, even
  // one with money already on it (PARTIAL), which the void sweep leaves alone. A WON estimate does
  // not: under pay later and after a failed bank debit its deposit stays open.
  if (depositEstimateClosed(invoice)) return { error: DEPOSIT_VOIDED_MESSAGE, code: DEPOSIT_VOIDED_CODE };
  const holdReason = depositHoldReason(invoice, org);
  return holdReason ? depositHoldRefusal(holdReason) : null;
}

/**
 * True when the deposit's estimate was declined, cancelled or expired: nothing more is collected on
 * it, and a payment that still lands (a session minted before the close) wins nothing (the
 * reconciler asks this same function). SUPERSEDED is deliberately not here: an estimate changed
 * after send keeps its own slice-15 hold reason ("out of date", depositHoldReason), which tells
 * the customer the figure moved rather than that the offer is over.
 */
export function depositEstimateClosed(invoice: DepositSupersedeCheck): boolean {
  const status = invoice.estimate?.status;
  return status === 'DECLINED' || status === 'ARCHIVED' || status === 'EXPIRED';
}

/** Everything the hold test needs off the invoice row. Kept as a named shape so the three
 *  call sites' `select`s can be read against it. */
export interface DepositSupersedeCheck {
  kind?: string | null;
  /** The figure the document is asking the customer for. */
  total_amount?: unknown;
  estimate?: {
    /** Required, not optional, for the same reason `total_amount` is: a `select` that forgets it
     *  reads `undefined` — never 'DRAFT' — and would silently reopen the money door on a recalled
     *  estimate. A compile error is the one thing a fully-mocked Prisma cannot hide. */
    status: string;
    modified_after_send?: boolean | null;
    deposit_type?: 'PERCENTAGE' | 'FIXED' | null;
    deposit_value?: unknown;
    /** Required, not optional: a caller whose `select` forgets it is a compile error rather than a
     *  silent NaN comparison. */
    total_amount: unknown;
  } | null;
}

/**
 * Why this deposit document cannot take money right now, or null when it can.
 *
 * ONE predicate behind every door — the public GET (so the page stops offering to pay), the
 * checkout POST (which is the guarantee) and the webhook backstop. They must never disagree about
 * whether money can move, the same rule lib/payment-options.ts enforces for CARD;
 * asking the question again somewhere else is how a page comes to promise what a door refuses.
 *
 * ESTIMATE_IN_DRAFT — Ran's policy call. Back to draft already nulls the estimate's OWN public
 * token, so the customer's view of the document is gone; the deposit invoice was the one thing
 * that survived a recall still payable, which reads as an oversight rather than a decision. It is
 * unconditional on the figure: a recall is not a claim that the amount is wrong, it is a statement
 * that the document is back in the salesperson's hands. And it is asked FIRST because the recall
 * CLEARS `modified_after_send` — so the superseded test below, on its own, sees an estimate in
 * perfect step with its deposit and waves the money through. The suspension lifts on the next
 * send, which re-prices this same invoice behind this same link.
 *
 * SUPERSEDED — the figure has gone stale under a materially-edited SENT estimate. A material edit
 * does not by itself make the deposit wrong (F4): a FIXED deposit is the same $500 whether the
 * total moved or not, and `nonTotalsMaterialChange` raises the flag for a renamed discount, which
 * moves nothing at all. Refusing those takes a working payment link away from a customer who is
 * trying to pay the right amount. So the question asked here is the same one the re-price asks —
 * would the next send MOVE this figure — which is why both go through `depositFigureWouldMove`.
 *
 * Fail-closed on missing inputs: an estimate whose total cannot be read resolves to NaN, which
 * never equals the stored figure, so the door refuses rather than taking money it cannot justify.
 */
export function depositHoldReason(
  invoice: DepositSupersedeCheck,
  org: DepositOrgDefaults | null,
): DepositHoldReason | null {
  if (invoice.kind !== 'DEPOSIT') return null;
  if (!invoice.estimate) return null;
  if (invoice.estimate.status === 'DRAFT') return 'ESTIMATE_IN_DRAFT';
  if (invoice.estimate.modified_after_send !== true) return null;
  const { depositAmount } = resolveDepositAmount(invoice.estimate, org);
  return depositFigureWouldMove(invoice.total_amount, depositAmount) ? 'SUPERSEDED' : null;
}

// Phase 2c — this handler doubles as the public deposit-pay surface: a kind=DEPOSIT invoice (job-less,
// SENT, with a public_token from estimate.send) is payable here exactly like a STANDARD invoice. It
// resolves the customer via invoice.customer (no job) and builds a Stripe checkout with
// metadata.invoiceId → the webhook invoice-payment branch records the Payment.
export async function createPublicCheckout(req: Request, res: Response) {
  try {
    const token = req.query.token as string;
    if (!token) return res.status(400).json({ error: 'Token required' });

    const parsedBody = publicCheckoutSchema.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      const badMethod = parsedBody.error.issues.some((issue) => issue.path[0] === 'method');
      const badAmount = parsedBody.error.issues.some((issue) => issue.path[0] === 'amount');
      if (badAmount) {
        // A fraction of a cent is its own refusal; any other bad amount (negative, not a number) is
        // refused as below the minimum.
        const fractional = parsedBody.error.issues.some((issue) => issue.path[0] === 'amount' && issue.code === 'custom');
        return fractional
          ? res.status(400).json({ error: 'Enter an amount in dollars and cents.', code: AMOUNT_NOT_WHOLE_CENTS_CODE })
          : res.status(400).json({ error: 'Invalid payment amount', code: AMOUNT_BELOW_MINIMUM_CODE });
      }
      return res.status(400).json({ error: badMethod ? 'Invalid payment method' : 'Invalid tip amount', ...(badMethod ? {} : { code: TIP_OUT_OF_BOUNDS_CODE }) });
    }
    const tipCents = parsedBody.data.tip ? Math.round(parsedBody.data.tip * 100) : 0;
    const requestedCents = parsedBody.data.amount !== undefined ? Math.round(parsedBody.data.amount * 100) : undefined;
    const method: CheckoutMethod = parsedBody.data.method ?? 'card';

    if (!isStripeConfigured()) {
      // Slice 25 - the same words the estimate's deposit door uses for a bank request.
      return res.status(400).json({ error: method === 'bank' ? 'Bank payment is not available' : 'Card payments are not configured' });
    }

    const invoice = await prisma.invoice.findFirst({
      where: { id: param(req, 'id'), public_token: token },
      select: {
        id: true,
        invoice_number: true,
        status: true,
        amount_due: true,
        // #2031 slice 5 — a deposit invoice is only payable while it still agrees with the
        // estimate it was calculated from; see DEPOSIT_SUPERSEDED_MESSAGE below. total_amount is
        // the figure that agreement is tested against (F4).
        kind: true,
        total_amount: true,
        estimate: { select: { id: true, public_token: true, status: true, modified_after_send: true, deposit_type: true, deposit_value: true, total_amount: true } },
        customer: { select: { first_name: true, last_name: true, company_name: true } },
        job: {
          select: {
            customer: { select: { first_name: true, last_name: true, company_name: true } },
          },
        },
        organization: { select: { id: true, stripe_account_id: true, accepted_payment_methods: true, stripe_charges_enabled: true, card_offered_by_default: true, bank_offered_by_default: true, tips_enabled: true, tip_presets: true, deposit_default_type: true, deposit_default_percentage: true, deposit_default_fixed_amount: true, ...ORG_PLAN_SELECT } },
        // Slice 19 - the resolver decides whether this invoice offers card at all, and whether it takes a tip.
        payment_methods_override: true,
        // Slice 26 - whether this invoice takes a partial amount (the staff Payment options card).
        allow_partial_payment: true,
        // Slice 12 - bank payments still in flight: what is offered online is the amount due less these.
        payments: { where: PROCESSING_PAYMENT_WHERE, select: { amount: true } },
      },
    });

    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    // Payments go-live slice 15 - a deposit answers with a reason its page can show (already paid,
    // cancelled, on hold); an ordinary invoice keeps its plain refusal.
    //
    // #2031 slice 5 — the hold covers the two windows in which this link is alive but must not take
    // money: the gap between a material edit and the next send (§A3 leaves an edited SENT estimate
    // SENT and nulls ITS public link, while the deposit invoice minted at the first send keeps its
    // own live token and its old amount), and a recall to draft, which withdraws the document
    // altogether and, by clearing modified_after_send, used to reopen this door rather than close it.
    //
    // Ran's decision in both cases is to leave the link alive and unrotated — never voided, never
    // re-minted — and have it decline. The next send re-prices this same invoice behind this same
    // token and lifts the refusal in the same transaction.
    if (invoice.kind === 'DEPOSIT') {
      const refusal = depositCheckoutRefusal(invoice, invoice.organization);
      if (refusal) return res.status(400).json(refusal);
    }
    if (!checkoutOpenStatus(invoice.status, invoice.kind === 'DEPOSIT')) {
      return res.status(400).json({ error: 'Invoice is not payable', code: INVOICE_NOT_PAYABLE_CODE });
    }
    // Payments go-live slice 16 - no checkout opens for an org whose plan lacks online payments.
    if (!onlinePaymentsInPlan(invoice.organization)) {
      return res.status(403).json(onlinePaymentsUnavailableRefusal('invoice'));
    }
    // Task 1.7 re-key — block checkout creation unless the owning org's Stripe charges are
    // actually enabled (stripe_charges_enabled is the mirrored-from-Stripe truth;
    // accepted_payment_methods/stripe_account_id presence alone can go stale — e.g.
    // mid-onboarding, or after a later deauthorized/restricted account).
    // Code-review finding: stripe_charges_enabled alone doesn't guarantee CARD is actually in
    // the org's accepted-methods list. Both are required, not either/or — reuse getPublic's exact
    // resolution chain so the public GET and this checkout POST can never disagree.
    // Payments go-live slice 12 - the same gate per method: a bank session needs the account's
    // bank-debit capability (ACH, which also requires charges enabled), a card session needs card.
    const capabilities = orgPaymentCapabilities(invoice.organization);
    if (method === 'card' && !capabilities.card) {
      return res.status(400).json({ error: 'Card payments are not enabled for this organization' });
    }
    if (method === 'bank' && !capabilities.ach) {
      return res.status(400).json({ error: 'Bank payments are not enabled for this organization' });
    }
    // Payments go-live slice 19 - the same resolver the public page renders from: an invoice
    // whose methods override leaves card out (made bank-only, say) takes no card checkout, and one
    // that leaves bank out takes no bank checkout.
    const options = paymentOptionsFor(invoice.organization, {
      methods: storedMethodsOverride(invoice.payment_methods_override),
      // A deposit is always paid in full, whatever the stored flag says.
      allow_partial: invoice.kind === 'DEPOSIT' ? false : invoice.allow_partial_payment,
    });
    // Slice 26: each of these refusals carries a code, so a page that kept offering what was just
    // withdrawn re-reads the invoice instead of showing a dead end.
    if (method === 'card' && !options.online_methods.includes('CARD')) {
      return res.status(400).json(optionsChanged('Card payments are not offered on this invoice'));
    }
    if (method === 'bank' && !options.online_methods.includes('ACH')) {
      return res.status(400).json(optionsChanged('Bank payments are not offered on this invoice'));
    }
    // Tips are an org switch (call 6): while it is off the page shows no tip chips, so a tip here
    // came from a bypassed page and is refused rather than charged.
    if (tipCents > 0 && !options.tips.enabled) {
      return res.status(400).json(optionsChanged('Tips are not accepted on this invoice'));
    }
    // Slice 26: a partial amount is an invoice switch; without it the page showed no such field.
    if (requestedCents !== undefined && !options.allow_partial) {
      return res.status(400).json(optionsChanged('Partial payments are not accepted on this invoice'));
    }

    const checkoutCustomer = invoice.customer ?? invoice.job?.customer;
    const customerName = [checkoutCustomer?.first_name, checkoutCustomer?.last_name].filter(Boolean).join(' ') || checkoutCustomer?.company_name || 'Customer';

    // Payments go-live slice 02 — the pricing module decides every line the customer is charged
    // and re-validates the tip (at most the invoice amount, its total - not what is still due).
    // No fee line, no platform fee (D9).
    // Payments go-live slice 12 - the amount offered is payable-now: the amount due less the bank
    // payments still processing on this invoice, so money in flight is never asked for twice.
    const amountDueCents = toCents(invoice.amount_due);
    const pricing = priceCheckout({
      invoiceTotalCents: Math.round(Number(invoice.total_amount) * 100),
      amountDueCents,
      payableNowCents: payableNowCents(amountDueCents, paidCents(invoice.payments)),
      requestedCents,
      tipCents,
      method,
      description: `Payment for Invoice ${invoice.invoice_number} — ${customerName}`,
    });
    if (!pricing.ok) {
      switch (pricing.error) {
        case 'NOTHING_PAYABLE_NOW':
          return res.status(400).json({ error: 'A payment for this invoice is already processing', code: PAYMENT_PROCESSING_CODE });
        case 'AMOUNT_BELOW_MINIMUM':
          return res.status(400).json({ error: 'The smallest payment is $1.00', code: AMOUNT_BELOW_MINIMUM_CODE });
        case 'AMOUNT_ABOVE_PAYABLE_NOW':
          return res.status(400).json({ error: 'That is more than can be paid right now', code: AMOUNT_ABOVE_PAYABLE_NOW_CODE });
        default:
          return res.status(400).json({ error: 'Invalid tip amount', code: TIP_OUT_OF_BOUNDS_CODE });
      }
    }
    // Slice 25 - the page asked to pay a different figure than the invoice now asks for.
    const expectedAmount = parsedBody.data.expected_amount;
    if (expectedAmount !== undefined && Math.round(expectedAmount * 100) !== pricing.payableNowCents) {
      return res.status(409).json(INVOICE_CHANGED_REFUSAL);
    }

    const baseUrl = env.FRONTEND_URL || '';
    const ctx = getStripeForOrg(invoice.organization);
    // Slice 27 - back to the estimate page when it asked, and its own link is still alive.
    const backToEstimate = parsedBody.data.return_to === 'estimate' && invoice.kind === 'DEPOSIT' && !!invoice.estimate?.id && !!invoice.estimate.public_token;
    const session = await createCheckoutSession({
      pricing,
      method,
      // Slice 25 - the method rides the return, so the page confirms a card payment as received
      // and a bank payment as processing.
      successUrl: backToEstimate
        ? `${baseUrl}/p/estimates/${invoice.estimate!.id}?token=${invoice.estimate!.public_token}&payment=success&method=${method}&deposit=1`
        : `${baseUrl}/p/invoices/${invoice.id}?token=${token}&payment=success&method=${method}`,
      cancelUrl: backToEstimate
        ? `${baseUrl}/p/estimates/${invoice.estimate!.id}?token=${invoice.estimate!.public_token}&payment=cancelled`
        : `${baseUrl}/p/invoices/${invoice.id}?token=${token}&payment=cancelled`,
      document: {
        organizationId: invoice.organization.id,
        invoiceId: invoice.id,
        kind: invoice.kind === 'DEPOSIT' ? 'deposit' : 'invoice',
      },
    }, ctx);

    // #2031 slice 5 (F2) — the last sliver of the window. The guard above read the invoice, and
    // only THEN did Stripe mint a session; a change landing in between produces a live session at a
    // figure the invoice no longer asks for. Everywhere else that window is closed by expiring open
    // sessions at the change, but this one does not exist yet when the sweep runs. So the answer is
    // re-checked now that the session does exist, and a session that lost the race is killed before
    // its URL is handed out. Payments go-live slice 25: every invoice, not only deposits - a manual
    // payment, credit, line edit or void moves an ordinary invoice's figure the same way.
    const recheck = await prisma.invoice.findFirst({
      where: { id: invoice.id, public_token: token },
      select: {
        status: true,
        amount_due: true,
        kind: true,
        total_amount: true,
        estimate: { select: { status: true, modified_after_send: true, deposit_type: true, deposit_value: true, total_amount: true } },
        payments: { where: PROCESSING_PAYMENT_WHERE, select: { amount: true } },
      },
    });
    // Slice 27 (slice 15 review) - the whole door predicate, not only the hold: a deposit paid by
    // hand, voided, or whose estimate was declined while the session was being minted answers with
    // its own reason, exactly as the guard above would have.
    const raceRefusal = invoice.kind !== 'DEPOSIT' ? null : recheck ? depositCheckoutRefusal(recheck, invoice.organization) : depositHoldRefusal('SUPERSEDED');
    const figureMoved = !recheck
      || !checkoutOpenStatus(recheck.status, invoice.kind === 'DEPOSIT')
      || payableNowCents(toCents(recheck.amount_due), paidCents(recheck.payments)) !== pricing.payableNowCents;
    if (raceRefusal || figureMoved) {
      // Fail-soft: if the session cannot be killed the customer still never receives its URL,
      // and the sweep at the change that closed the door will try again.
      await expireCheckoutSession(session.id, ctx);
      return raceRefusal ? res.status(400).json(raceRefusal) : res.status(409).json(INVOICE_CHANGED_REFUSAL);
    }

    // Slice 27 (slice 15 acceptance 3) - a deposit holds one live link: the older sessions (a card
    // tab and a bank tab, a reload) are closed now that this one is handed out. Fail-soft.
    if (invoice.kind === 'DEPOSIT') {
      await expireOpenCheckoutSessionsForInvoice(invoice.id, ctx, { exceptSessionId: session.id, createdBefore: session.created });
    }

    res.json({ checkout_url: session.url });
  } catch (err) {
    logger.error('Error creating invoice checkout:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function addNote(req: Request, res: Response) {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      select: { id: true, job: { select: { visits: { select: { assignees: { select: { user_id: true } } } }, estimate: { select: { lead: { select: { lead_assignees: { select: { user_id: true } } } } } } } } },
    });
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    if (!(await canAccessRow(req, 'Invoice', prisma.invoice, param(req, 'id')))) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const note = await prisma.note.create({
      data: {
        entity_type: 'INVOICE',
        entity_id: param(req, 'id'),
        content: req.body.content,
        created_by: req.user?.id!,
        organization_id: req.user!.organization_id,
      },
      include: { creator: { select: { id: true, first_name: true, last_name: true } } },
    });

    res.status(201).json({ note });
  } catch (err) {
    logger.error('Error adding invoice note:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// Entity-redesign §8: generalized refund — first-class Refund rows, partial + multiple,
// execution keyed off the SOURCE payment's stripe_payment_intent_id (NOT the method label).
const REFUND_CATEGORIES = ['CUSTOMER_REQUEST', 'ERROR', 'GOODWILL', 'OVERPAYMENT', 'CHARGEBACK', 'OTHER'] as const;

export const refundInvoiceSchema = z.object({
  amount: z.number().positive().optional(),
  payment_id: z.string().uuid().optional(),
  // Slice 29: a hand-chosen refund method is never ACH (an online bank debit only the processor
  // makes). A bank payment refunded with the method left on Auto still records ACH.
  method: manualPaymentMethodSchema.optional(),
  reference_number: z.string().max(100).optional(),
  non_taxable_concession: z.boolean().optional(),
  reason_category: z.enum(REFUND_CATEGORIES),
  reason: z.string().min(1).max(LONG_TEXT_MAX),
});

function proportionalShare(refundFaceAmount: number, faceAmount: number, extraAmount: number): number {
  if (!(extraAmount > 0) || !(faceAmount > 0)) return 0;
  return roundMoney(extraAmount * (refundFaceAmount / faceAmount));
}

/**
 * Slice 7 (tipping) - a refund returns the tip too: a full refund the whole tip, a partial refund
 * its proportional share. The tip sits in the processor's charge total, not in the payment's face
 * amount, so it needs its own explicit addition to the refund amount sent.
 *
 * Proportional against the SOURCE payment's ORIGINAL face amount and tip (both immutable once the
 * webhook writes them), not any running total - so repeated partial refunds against the same
 * payment sum to exactly 100% of the tip, never more.
 *
 * Payments go-live slice 29 (D9): there is no service fee any more, so none is given back. A legacy
 * charge that carried one keeps it, as the business's own pricing then.
 *
 * D1/D10 - this only changes what the processor is asked to return. Refund.amount,
 * Invoice.total_refunded and net_collected stay face-value-only; the tip never re-enters the
 * invoice ledger.
 */
function proportionalRefundExtras(
  refundFaceAmount: number,
  sourcePayment: { amount: unknown; tip_amount?: unknown } | null,
): number {
  if (!sourcePayment) return 0;
  return proportionalShare(refundFaceAmount, Number(sourcePayment.amount ?? 0), Number(sourcePayment.tip_amount ?? 0));
}

// Non-deposit-credit payment filter: keep real payments (NULL or non-DEPOSIT-CREDIT reference),
// drop the synthetic DEPOSIT-CREDIT rows. Prisma `{ not: value }` excludes NULLs, so allow null.
// Payments go-live slice 05: only SUCCEEDED money was collected, so only it can be given back
// (a PROCESSING bank debit may still fail; a FAILED one never arrived).
const NON_CREDIT_PAYMENT_FILTER: Prisma.PaymentWhereInput = REFUNDABLE_PAYMENT_WHERE;

// Payments go-live slice 07: the refused-refund message (lib/refund-rules.ts holds it since slice 29).
export { REFUND_NOT_SENT_MESSAGE };

/**
 * The state an in-app refund is written in. A bank (ACH) refund is PENDING until the processor
 * confirms it; a card refund is SUCCEEDED on creation, unless the processor itself reports it
 * pending (it then lands through refund.updated).
 */
export function inAppRefundState(processorStatus: string | null | undefined, sourceMethod: PaymentMethod | undefined): RefundState {
  if (processorStatus === 'failed' || processorStatus === 'canceled') return 'FAILED';
  if (sourceMethod === 'ACH' || processorStatus === 'pending' || processorStatus === 'requires_action') return 'PENDING';
  return 'SUCCEEDED';
}

export async function refundInvoice(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const body = req.body as z.infer<typeof refundInvoiceSchema>;
    const { reason_category, reason, payment_id, non_taxable_concession } = body;

    const invoice = await prisma.invoice.findUnique({
      where: { id: id as string, ...tenantWhere(req) },
      include: {
        organization: true,
        // Real (non-voided, non-deposit-credit) payments — manual methods now eligible too. Oldest
        // first: "Auto / oldest" takes the refund from the oldest payment that can return it.
        payments: { where: NON_CREDIT_PAYMENT_FILTER, orderBy: [{ paid_at: 'asc' }, { created_at: 'asc' }] },
        // The refunded payment's void: a refund that left with a charged-back payment holds back
        // nothing (heldRefundCents).
        refunds: { include: { payment: { select: { voided_at: true } } } },
        customer: true,
        // The seller the notification is addressed to: the job's stored Sold By (a column on `job`), or,
        // for an invoice with no job, its estimate's lead Owner.
        job: { include: { customer: true } },
        estimate: { select: { lead: { select: { commission_owner_id: true } } } },
      },
    });

    if (!invoice) {
      res.status(404).json({ error: 'Invoice not found' });
      return;
    }
    // #106 — grant-driven per-instance owner check (a refund-Invoice grant org-settings narrows to
    // owned rows must be enforced on THIS row, not just at the subject-level route guard).
    if (!(await canAccessRow(req, 'Invoice', prisma.invoice, id as string))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    // Slice 29 (D17): a bank payment still processing has not landed; it is cancelled, not refunded.
    if (payment_id && await prisma.payment.count({
      where: { id: payment_id, invoice_id: invoice.id, ...PROCESSING_PAYMENT_WHERE },
    })) {
      res.status(400).json({ error: BANK_PAYMENT_PROCESSING_MESSAGE });
      return;
    }
    if (invoice.status !== 'PAID' && invoice.status !== 'PARTIALLY_REFUNDED') {
      res.status(400).json({ error: `Invoice must be PAID to refund (current: ${invoice.status})` });
      return;
    }

    // Net math is computed from the live payments/refunds, NOT the cached column
    // (legacy rows carry net_collected=0; the cached value can't be trusted).
    // Slice 05: totals count SUCCEEDED refunds only; the cap also leaves room for PENDING ones.
    // The ledger math is in integer cents.

    // MON-09: a DEPOSIT invoice's refundable balance is the DRAWDOWN-AWARE remaining credit
    // (paid − applied − refunded), NOT the raw net-paid. A deposit already drawn down onto a job's
    // STANDARD invoice is NOT refundable — refunding it would double-spend the credit. Non-deposit
    // invoices keep capping at net-paid.
    // The cap itself lives in lib/refund-cap.ts, shared with the Payments drawer (P6), so the two never disagree.
    const refundableCap = roundMoney(await invoiceRefundCap(prisma, invoice));

    if (refundableCap <= 0) {
      res.status(400).json({
        error: invoice.kind === 'DEPOSIT'
          ? 'Deposit credit is fully applied or refunded — nothing left to refund'
          : 'No remaining net-paid balance to refund',
      });
      return;
    }

    if (payment_id && !invoice.payments.some((p) => p.id === payment_id)) {
      res.status(400).json({ error: 'Payment not found on this invoice' });
      return;
    }

    // Default amount = full refundable balance (drawdown-aware for deposits, net-paid otherwise).
    const amount = roundMoney(body.amount ?? refundableCap);
    if (amount <= 0) {
      res.status(400).json({ error: 'Refund amount must be positive' });
      return;
    }

    // Cap A: Σ refunds ≤ refundable balance (drawdown-aware for deposits, net-paid otherwise).
    if (amount > refundableCap + 0.0001) {
      res.status(400).json({ error: 'Refund exceeds net paid' });
      return;
    }

    // What a payment can still give back: its amount less the refunds on it, landed or on their way.
    const roomCents = (p: { id: string; amount: Prisma.Decimal }) =>
      toCents(p.amount) - committedRefundCents(invoice.refunds.filter((r) => r.payment_id === p.id));

    // Where the refund comes from: the named payment, else the oldest that can return it, else
    // (hand payments only) spread oldest first; every refund row names its payment (slice 29).
    const allocation = allocateRefund({
      payments: invoice.payments.map((p) => ({ ...p, amountCents: toCents(p.amount), online: refundRoute(p, body.method) !== 'record' })),
      roomCents,
      amountCents: toCents(amount),
      namedPaymentId: payment_id,
    });
    if (!allocation.ok) {
      res.status(400).json({ error: allocation.error });
      return;
    }
    const { parts } = allocation;
    const sourcePayment = parts[0].payment;

    // Method: free-choice, default the source payment's method.
    const methodOf = (payment: (typeof invoice.payments)[number]) => refundRowMethod(payment, body.method);

    // Tax portion: proportional gross×tax/total; $0 under a non-taxable concession. Spread over
    // the parts with the last one taking the rounding, so the parts sum to the whole.
    const taxPortion = computeRefundTax(amount, invoice.tax_amount, invoice.total_amount, non_taxable_concession);
    const partTax = parts.map((part, i) => (i < parts.length - 1
      ? computeRefundTax(fromCents(part.cents), invoice.tax_amount, invoice.total_amount, non_taxable_concession)
      : 0));
    partTax[parts.length - 1] = roundMoney(taxPortion - partTax.slice(0, -1).reduce((sum, t) => sum + t, 0));

    // Execution keys off the SOURCE payment's PI presence — NOT the method label. Slice 29 (D17):
    // the processor refunds a bank payment only within 180 days. Past it, a refund handed back
    // another way (a hand method chosen) is recorded only; one left to go back to the bank is
    // refused here, before the processor is asked (conductor ruling 2026-10-08).
    const route = refundRoute(sourcePayment, body.method);
    if (route === 'refused') {
      res.status(400).json({ error: BANK_REFUND_WINDOW_MESSAGE });
      return;
    }
    const pi = route === 'processor' ? sourcePayment.stripe_payment_intent_id : null;

    const now = new Date();
    const refundRows = parts.map((part, i) => ({
      invoice_id: invoice.id,
      // The payment this part of the refund was taken from.
      payment_id: part.payment.id,
      amount: fromCents(part.cents),
      tax_portion: partTax[i],
      non_taxable_concession: non_taxable_concession ?? false,
      method: methodOf(part.payment),
      reason,
      reason_category,
      refunded_by: req.user!.id,
      organization_id: req.user!.organization_id,
    }));

    /**
     * Under the invoice lock (the one every ledger door and the refund event's reconciler take):
     * the caps again, on the rows as they stand, so two refunds made at the same moment can never
     * together give back more than was paid (slice 18; slice 29 for processor refunds too).
     */
    const lockAndRecheck = async (tx: Prisma.TransactionClient) => {
      await tx.$executeRaw`SELECT id FROM invoices WHERE id = ${invoice.id}::uuid AND organization_id = ${invoice.organization_id}::uuid FOR UPDATE`;
      const lockedInvoice = await tx.invoice.findUniqueOrThrow({
        where: { id: invoice.id },
        select: {
          status: true,
          payments: { where: NON_CREDIT_PAYMENT_FILTER, select: { id: true, amount: true } },
          refunds: { select: { amount: true, state: true, payment_id: true, payment: { select: { voided_at: true } } } },
        },
      });
      if (lockedInvoice.status !== 'PAID' && lockedInvoice.status !== 'PARTIALLY_REFUNDED') {
        throw new RefusedUnderLockError(`Invoice must be PAID to refund (current: ${lockedInvoice.status})`);
      }
      const lockedCap = roundMoney(await invoiceRefundCap(tx, { id: invoice.id, kind: invoice.kind, ...lockedInvoice }));
      if (amount > lockedCap + 0.0001) throw new RefusedUnderLockError('Refund exceeds net paid');
      for (const part of parts) {
        const lockedPaymentRefundedCents = committedRefundCents(lockedInvoice.refunds.filter((r) => r.payment_id === part.payment.id));
        if (part.cents > toCents(part.payment.amount) - lockedPaymentRefundedCents) {
          throw new RefusedUnderLockError('Refund exceeds payment balance');
        }
      }
    };

    /** The invoice's refund totals, status and history once the refund row is written (lock held). */
    const recordOnInvoice = async (tx: Prisma.TransactionClient, refundRowId: string) => {
      // Totals and status from the ledger rows by the ledger's one rule (lib/payment-ledger.ts): a
      // refund still on its way back (PENDING) has given nothing back yet, one on a charged-back
      // payment left with it, and money sent back from "Payments needing attention" was never the
      // invoice's. A refund NEVER reopens amount_due; status drops PAID→PARTIALLY_REFUNDED→REFUNDED
      // (docs/adr/0004-refund-never-reopens-amount-due.md). It also re-stamps each payment.
      await rederiveRefundTotals(tx, { invoiceId: invoice.id, organizationId: req.user!.organization_id });
      await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          refunded_at: now,
          refunded_by: req.user!.id,
          refund_reason: reason,
          refund_reason_category: reason_category,
        },
      });

      await tx.timelineEvent.create({
        data: {
          organization_id: req.user!.organization_id,
          entity_type: 'INVOICE',
          entity_id: invoice.id,
          event_type: 'INVOICE_REFUNDED',
          description: `Invoice ${invoice.invoice_number} refunded $${amount.toFixed(2)} (${reason_category})`,
          metadata: { source: 'in_app', refund_id: refundRowId, amount, reason_category },
          created_by: req.user?.id,
        },
      });
      await recordJobMoneyMovement(
        tx, { orgId: req.user!.organization_id, userId: req.user!.id }, invoice.job?.id, invoice, 'REFUND_ISSUED',
        { amount, method: refundRows[0].method, invoiceEventType: 'INVOICE_REFUNDED', refundId: refundRowId },
      );
      return tx.refund.findUniqueOrThrow({ where: { id: refundRowId } });
    };

    let refundRow;
    // Slice 31: the customer is emailed by whoever MOVED the refund to SUCCEEDED. A hand-recorded
    // refund is the door's; a processor refund the event settled first was the event's.
    let doorMovedRow = true;
    if (!pi) {
      // No PI ⇒ record-only (money returned out-of-band; capture method + reference). A refund
      // handed back by hand is done when it is recorded.
      refundRow = await prisma.$transaction(async (tx) => {
        await lockAndRecheck(tx);
        let firstId: string | null = null;
        for (const data of refundRows) {
          const created = await tx.refund.create({ data: { ...data, stripe_refund_id: null, state: 'SUCCEEDED' } });
          firstId ??= created.id;
        }
        return recordOnInvoice(tx, firstId!);
      });
    } else {
      // Slice 29: hold the money first (a PENDING reservation, under the lock), then ask the
      // processor, then complete the row with its answer (lib/in-app-refund.ts).
      const reservation = await prisma.$transaction(async (tx) => {
        await lockAndRecheck(tx);
        return reserveRefund(tx, refundRows[0]);
      });
      let stripeRefund: { id?: string; status?: string | null } | undefined;
      // Transition safety (spec §5.3): key off the PAYMENT row's stripe_account_id
      // snapshot, not the org's CURRENT one — an org may connect Stripe (or its
      // account may otherwise change) after this charge was made, so the org's
      // present-day value could point refund execution at the wrong account.
      const ctx = getStripeForOrg({ stripe_account_id: sourcePayment?.stripe_account_id ?? null });
      try {
        // Slice 7 - return the tip's proportional share alongside the face amount (slice 29: no fee).
        const extrasRefund = proportionalRefundExtras(amount, sourcePayment);
        const amountInCents = Math.round((amount + extrasRefund) * 100);
        stripeRefund = await createRefund(
          pi,
          ctx,
          amountInCents,
          {
            // The reservation's id lets the refund's own event complete this row (slice 29).
            metadata: { source: 'in_app', invoiceId: invoice.id, [REFUND_ROW_METADATA_KEY]: reservation.id },
            // Reverse the application fee only when this payment carried one (D1): a charge
            // taken since D9 has none, and the processor refuses to reverse what is not there.
            ...feeReversalOption(sourcePayment),
            // One refund per reservation, however often the call is retried.
            idempotencyKey: `invoice-refund:${reservation.id}`,
          },
        );
      } catch (stripeErr: any) {
        logger.error('Stripe refund failed:', stripeErr);
        if (!(await releaseIfRefused(req.user!.organization_id, reservation.id, stripeErr))) {
          // The answer never arrived: the refund may exist, so its money stays held.
          res.status(502).json({ error: REFUND_UNCONFIRMED_MESSAGE });
          return;
        }
        const refused = refusedRefundAnswer(stripeErr);
        res.status(refused.status).json({ error: refused.error });
        return;
      }
      refundRow = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT id FROM invoices WHERE id = ${invoice.id}::uuid AND organization_id = ${invoice.organization_id}::uuid FOR UPDATE`;
        const { id: rowId, moved } = await completeReservedRefund(tx, {
          refundRowId: reservation.id,
          organizationId: req.user!.organization_id,
          stripeRefundId: stripeRefund?.id ?? null,
          state: inAppRefundState(stripeRefund?.status, sourcePayment?.method),
        });
        doorMovedRow = moved;
        return recordOnInvoice(tx, rowId);
      });
    }

    const customer = invoice.customer ?? invoice.job?.customer;
    // Slice 30: the customer hears of a refund once it has SUCCEEDED (a card refund, at once). A
    // bank refund is still PENDING here; the processor's confirmation sends it (payment-reconciler).
    if (customer?.email && refundRow.state === 'SUCCEEDED' && doorMovedRow) {
      sendInvoiceRefundNotification({
        organizationId: req.user!.organization_id,
        to: customer.email,
        customerName: [customer.first_name, customer.last_name].filter(Boolean).join(' ') || customer.company_name || 'Customer',
        invoiceNumber: invoice.invoice_number,
        invoiceId: invoice.id,
        refundAmount: amount,
        timing: refundTimingFor({ method: refundRow.method, processed: !!refundRow.stripe_refund_id }),
        record: {
          organizationId: req.user!.organization_id,
          customerId: customer.id,
          jobId: invoice.job?.id,
          jobLabel: invoice.job?.job_number,
        },
      }).catch((err) => logger.error('Invoice refund email failed:', err));
    }

    // In-app notification: billing.refunded, on M6's two-lane chain and sent once the response has gone out.
    queueInvoiceAlert({
      verb: 'billing.refunded',
      organizationId: req.user!.organization_id,
      actorId: req.user?.id ?? null,
      object: { type: 'INVOICE', id: invoice.id, label: invoice.invoice_number },
      data: { object_label: invoice.invoice_number, amount },
    });

    void logAudit({
      req,
      action: 'invoice.refunded',
      resourceType: 'Invoice',
      resourceId: invoice.id,
      metadata: { amount },
    });
    res.json({ success: true, refund: withoutProcessorIdKeys(refundRow) });
  } catch (err) {
    if (err instanceof RefusedUnderLockError) {
      res.status(400).json({ error: err.message });
      return;
    }
    logger.error('Error refunding invoice:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Credit (§8): lower amount_due, no money moves; unified give-back rule ───
export const creditInvoiceSchema = z.object({
  amount: z.number().positive(),
  reason: z.string().min(1).max(LONG_TEXT_MAX),
  category: z.string().max(100).optional(),
  refund_instead: z.boolean().optional(),
  // Explicit opt-in payment reversal, the documented exception to the never-reopen rule
  // (docs/adr/0004-refund-never-reopens-amount-due.md).
  reopen_balance: z.boolean().optional(),
  // Slice 29: as the refund door - a chosen give-back method is never ACH.
  method: manualPaymentMethodSchema.optional(),
  non_taxable_concession: z.boolean().optional(),
});

export async function credit(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const body = req.body as z.infer<typeof creditInvoiceSchema>;
    const { amount, reason, category, non_taxable_concession } = body;

    const invoice = await prisma.invoice.findUnique({
      where: { id: id as string, ...tenantWhere(req) },
      include: {
        organization: true,
        payments: { where: NON_CREDIT_PAYMENT_FILTER },
        refunds: true,
        customer: true,
        // The seller the notification is addressed to: the job's stored Sold By (a column on `job`), or,
        // for an invoice with no job, its estimate's lead Owner.
        job: { include: { customer: true } },
        estimate: { select: { lead: { select: { commission_owner_id: true } } } },
      },
    });

    if (!invoice) {
      res.status(404).json({ error: 'Invoice not found' });
      return;
    }
    // #106 — grant-driven per-instance owner check (a credit-Invoice grant org-settings narrows to
    // owned rows must be enforced on THIS row, not just at the subject-level route guard).
    if (!(await canAccessRow(req, 'Invoice', prisma.invoice, id as string))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // §8/§10: a credit-first give-back is only valid on a live billable invoice. SENT/PARTIAL drive
    // the credit-the-balance path; PAID/PARTIALLY_REFUNDED drive the all-cash path. DRAFT, VOIDED,
    // CANCELLED, and REFUNDED are off-limits (no money should move on a dead/un-issued document).
    const CREDITABLE_STATUSES = ['SENT', 'PARTIAL', 'PAID', 'PARTIALLY_REFUNDED'];
    if (!CREDITABLE_STATUSES.includes(invoice.status)) {
      res.status(400).json({ error: `Cannot apply a credit to a ${invoice.status} invoice` });
      return;
    }

    const balanceOwed = roundMoney(Number(invoice.amount_due));
    const giveBack = roundMoney(amount);

    // docs/adr/0004-refund-never-reopens-amount-due.md - reopen_balance is the one explicit,
    // fenced exception to the never-reopen rule below.
    const reopenBalance = body.reopen_balance === true;
    if (reopenBalance && !body.refund_instead) {
      res.status(400).json({ error: 'reopen_balance requires refund_instead: money can only be put back on the balance when it is actually sent back' });
      return;
    }
    if (reopenBalance && balanceOwed <= 0) {
      // Load-bearing, not defensive: without this guard, on the only shape with live staging
      // rows (an overpaid/fully-paid invoice), creditPart is 0 and refundPart is the whole
      // give-back, so the write below would bill the customer for money they never owed.
      res.status(400).json({ error: 'reopen_balance needs an outstanding balance: returning an overpayment must not bill the customer for money they never owed' });
      return;
    }
    if (reopenBalance && invoice.kind === 'DEPOSIT') {
      // voidPayment's reopen pairs with a DepositCreditApplication un-apply cascade (see
      // voidPayment below) that this door does not mirror; a PARTIAL DEPOSIT invoice with a live
      // drawdown is reachable and would otherwise double-count the returned dollars.
      res.status(400).json({ error: 'reopen_balance is not available on a deposit invoice: reopening it would leave its drawdown applied to the target invoice' });
      return;
    }

    // Unified give-back: credit the outstanding balance first; only the EXCESS goes out as cash.
    // refund_instead=true ⇒ override: money goes out even though a balance is owed.
    const creditPart = body.refund_instead ? 0 : roundMoney(Math.min(giveBack, Math.max(balanceOwed, 0)));
    const refundPart = roundMoney(giveBack - creditPart);

    // Payments go-live slice 22: any give-back that sends cash back IS a refund, so it needs the
    // "Refund payments" switch on top of `credit Invoice`. A credit that only lowers what is still
    // owed sends nothing back and needs no more than the route's own grant.
    if (refundPart > 0 && !req.ability?.can('refund', 'Invoice')) {
      res.status(403).json({ error: 'Sending money back needs the Refund payments permission' });
      return;
    }

    const now = new Date();

    // For the cash-excess refund portion.
    const realPayments = invoice.payments;

    // §8 universal money rule: Σ refunds ≤ net-paid. The cash give-back can only return money that
    // was actually collected — never invent funds (that would write a NEGATIVE net_collected).
    // Slice 05: in integer cents, counting SUCCEEDED refunds and leaving room for PENDING ones;
    // slice 29: a refund that left with a charged-back payment holds back nothing.
    const netPaidCents = paidCents(realPayments) - heldRefundCents(invoice.refunds);
    if (toCents(refundPart) > Math.max(netPaidCents, 0)) {
      // The requested give-back exceeds balanceOwed + net-paid: the excess cannot be returned
      // because that money was never collected. Carry-forward is deferred to the §13 wallet.
      res.status(400).json({ error: 'Give-back exceeds net paid: cannot refund money that was never collected' });
      return;
    }

    // Slice 29: the cash part comes from a named payment like any refund (lib/refund-rules.ts):
    // the oldest payment that can return it (one through the processor goes back to its charge),
    // else spread over hand payments oldest first. Every give-back row names its payment, so the
    // payment's refund stamp and the invoice's refunded total agree.
    const roomCents = (p: { id: string; amount: Prisma.Decimal }) =>
      toCents(p.amount) - committedRefundCents(invoice.refunds.filter((r) => r.payment_id === p.id));
    let parts: Array<{ payment: (typeof realPayments)[number]; cents: number }> = [];
    if (refundPart > 0) {
      const allocation = allocateRefund({
        payments: realPayments.map((p) => ({ ...p, amountCents: toCents(p.amount), online: refundRoute(p, body.method) !== 'record' })),
        roomCents,
        amountCents: toCents(refundPart),
      });
      if (!allocation.ok) {
        res.status(400).json({ error: allocation.error });
        return;
      }
      parts = allocation.parts;
    }
    const sourcePayment = parts[0]?.payment ?? null;
    // Slice 29 (D17): the processor refunds a bank payment only within 180 days. Past it, a
    // give-back with a hand method chosen is recorded only, as at the refund door (ruling 2026-10-08).
    const route = sourcePayment ? refundRoute(sourcePayment, body.method) : 'record';
    if (route === 'refused') {
      res.status(400).json({ error: BANK_REFUND_WINDOW_MESSAGE });
      return;
    }
    const pi = route === 'processor' ? sourcePayment?.stripe_payment_intent_id ?? null : null;

    const giveBackRows = parts.map((part, i) => {
      const partAmount = fromCents(part.cents);
      return {
        invoice_id: invoice.id,
        payment_id: part.payment.id,
        amount: partAmount,
        // Each part's own share of the tax, the last one taking the rounding.
        tax_portion: i < parts.length - 1
          ? computeRefundTax(partAmount, invoice.tax_amount, invoice.total_amount, non_taxable_concession)
          : roundMoney(
            computeRefundTax(refundPart, invoice.tax_amount, invoice.total_amount, non_taxable_concession)
              - parts.slice(0, -1).reduce((sum, p) => sum + computeRefundTax(fromCents(p.cents), invoice.tax_amount, invoice.total_amount, non_taxable_concession), 0),
          ),
        non_taxable_concession: non_taxable_concession ?? false,
        method: refundRowMethod(part.payment, body.method),
        reason,
        reason_category: (body.refund_instead ? 'CUSTOMER_REQUEST' : 'OVERPAYMENT') as RefundCategory,
        refunded_by: req.user!.id,
        organization_id: req.user!.organization_id,
      };
    });

    /**
     * Under the invoice lock every ledger door takes (the refund event's reconciler among them), the
     * give-back is decided on what the invoice holds NOW (slice 18): a payment, refund or void that
     * committed since the reads above would otherwise be written over (a cleared balance put back, a
     * give-back past what was paid). Refused whole while nothing has gone out.
     */
    const lockAndRecheck = async (tx: Prisma.TransactionClient) => {
      await tx.$executeRaw`SELECT id FROM invoices WHERE id = ${invoice.id}::uuid AND organization_id = ${req.user!.organization_id}::uuid FOR UPDATE`;
      const lockedInvoice = await tx.invoice.findUniqueOrThrow({
        where: { id: invoice.id },
        select: {
          status: true,
          amount_due: true,
          payments: { where: NON_CREDIT_PAYMENT_FILTER, select: { amount: true } },
          refunds: { select: { amount: true, state: true, payment_id: true, payment: { select: { voided_at: true } } } },
        },
      });
      const lockedNetPaidCents = paidCents(lockedInvoice.payments) - heldRefundCents(lockedInvoice.refunds);
      if (
        !CREDITABLE_STATUSES.includes(lockedInvoice.status)
        || toCents(lockedInvoice.amount_due) !== toCents(balanceOwed)
        || toCents(refundPart) > Math.max(lockedNetPaidCents, 0)
        || parts.some((part) => part.cents > toCents(part.payment.amount)
          - committedRefundCents(lockedInvoice.refunds.filter((r) => r.payment_id === part.payment.id)))
      ) {
        throw new InvoiceChangedUnderLockError();
      }
    };

    /** The credit half, the give-back's write-off and history, and the totals (lock held). */
    const writeGiveBack = async (tx: Prisma.TransactionClient) => {
      // Slice 29: the balance as it stands under this lock. When money went out through the
      // processor, a payment may have landed since the give-back was decided: the credit half is
      // never more than is still owed.
      const locked = await tx.invoice.findUniqueOrThrow({ where: { id: invoice.id }, select: { status: true, amount_due: true } });
      const lockedDue = roundMoney(Number(locked.amount_due));
      const creditNow = roundMoney(Math.min(creditPart, Math.max(lockedDue, 0)));
      if (creditNow > 0) {
        const creditTax = computeRefundTax(creditNow, invoice.tax_amount, invoice.total_amount, non_taxable_concession);
        await tx.credit.create({
          data: {
            invoice_id: invoice.id,
            amount: creditNow,
            tax_portion: creditTax,
            reason,
            category: category ?? null,
            created_by: req.user!.id,
            organization_id: req.user!.organization_id,
          },
        });

        const newDue = roundMoney(Math.max(lockedDue - creditNow, 0));
        // Lower the bill. Keep PAID logic to payments — a credit never marks PAID; if a
        // partial balance remains, surface PARTIAL, else leave the status as-is.
        const creditStatus = newDue > 0 && newDue < Number(invoice.total_amount) ? 'PARTIAL' : locked.status;
        await tx.invoice.update({
          where: { id: invoice.id },
          data: { amount_due: newDue, status: creditStatus },
        });

        await tx.timelineEvent.create({
          data: {
            organization_id: req.user!.organization_id,
            entity_type: 'INVOICE',
            entity_id: invoice.id,
            event_type: 'CREDIT_APPLIED',
            description: `Credit of $${creditNow.toFixed(2)} applied to invoice ${invoice.invoice_number}`,
            metadata: { amount: creditNow, reason, category: category ?? null },
            created_by: req.user?.id,
          },
        });
      }

      if (refundPart > 0) {
        // Cash give-back for the excess. Rule + its one explicit exception:
        // docs/adr/0004-refund-never-reopens-amount-due.md. By default this NEVER reopens
        // amount_due - an operator-forced give-back on a live balance is mirrored by a write-off
        // Credit instead. reopen_balance is the explicit opt-in reversal, unavailable at zero
        // balance and on DEPOSIT invoices - see the guards above.

        // The give-back forced money out while a balance was still owed: mirror it with a
        // write-off Credit so the invoice still reconciles (total_amount == amount_due + net
        // cash + credits) and the statement's running balance stops disagreeing with the invoice
        // by exactly refundPart. tax_portion is 0 because the Refund row already reverses
        // the tax exactly once - a second portion here would double-reverse it.
        const writeOff = body.refund_instead === true && !reopenBalance && balanceOwed > 0;
        if (writeOff) {
          await tx.credit.create({
            data: {
              invoice_id: invoice.id,
              amount: refundPart,
              tax_portion: 0,
              reason,
              category: 'REFUND_WRITE_OFF',
              created_by: req.user!.id,
              organization_id: req.user!.organization_id,
            },
          });

          await tx.timelineEvent.create({
            data: {
              organization_id: req.user!.organization_id,
              entity_type: 'INVOICE',
              entity_id: invoice.id,
              event_type: 'CREDIT_APPLIED',
              description: `Write-off credit of $${refundPart.toFixed(2)} recorded for the cash give-back on invoice ${invoice.invoice_number}`,
              metadata: { amount: refundPart, reason, category: 'REFUND_WRITE_OFF' },
              created_by: req.user?.id,
            },
          });
        }

        // Only money that has gone back counts; a PENDING give-back counts when it lands. Re-read
        // from the rows, not added to the figure read before the processor call: the refund event
        // may have recorded this give-back (in its own state), or settled another refund, since.
        // Net collected by the ledger's one rule: a refund on a charged-back payment left with that
        // payment, so it is not taken off again (slice 09). The status is this door's own (below).
        const ledger = await tx.invoice.findUniqueOrThrow({
          where: { id: invoice.id },
          select: {
            payments: { select: { id: true, amount: true, state: true, voided_at: true, reference_number: true } },
            refunds: { select: { amount: true, state: true, payment_id: true } },
          },
        });
        const totalRefunded = fromCents(refundedCents(ledger.refunds));
        const newNet = fromCents(netCollectedCents(ledger.payments, ledger.refunds));
        // creditPart is 0 whenever reopenBalance is true - name the reopened value explicitly.
        const reopenedDue = roundMoney(lockedDue + refundPart);
        const reopenedStatus = reopenedDue >= Number(invoice.total_amount) - 0.0001 ? 'SENT' : 'PARTIAL';
        await tx.invoice.update({
          where: { id: invoice.id },
          data: {
            total_refunded: totalRefunded,
            net_collected: newNet,
            refunded_at: now,
            ...(reopenBalance ? { amount_due: reopenedDue, status: reopenedStatus, paid_at: null } : {}),
          },
        });
        // The refunded payment's stamp, from its SUCCEEDED refund rows (slice 08).
        await restampPaymentRefunds(tx, { invoiceId: invoice.id, organizationId: req.user!.organization_id });

        await tx.timelineEvent.create({
          data: {
            organization_id: req.user!.organization_id,
            entity_type: 'INVOICE',
            entity_id: invoice.id,
            event_type: 'INVOICE_REFUNDED',
            description: reopenBalance
              ? `Invoice ${invoice.invoice_number} give-back refund $${refundPart.toFixed(2)} - balance reopened to $${reopenedDue.toFixed(2)}`
              : `Invoice ${invoice.invoice_number} give-back refund $${refundPart.toFixed(2)}`,
            metadata: { source: 'in_app', amount: refundPart, give_back: true, ...(reopenBalance ? { reopened: true } : {}) },
            created_by: req.user?.id,
          },
        });
        // The give-back's refund row (the latest one this door wrote on the invoice) for the job history.
        const giveBackRefund = await tx.refund.findFirst({
          where: { invoice_id: invoice.id, organization_id: req.user!.organization_id, refunded_by: req.user!.id },
          orderBy: { created_at: 'desc' },
          select: { id: true },
        });
        await recordJobMoneyMovement(
          tx, { orgId: req.user!.organization_id, userId: req.user!.id }, invoice.job?.id, invoice, 'REFUND_ISSUED',
          { amount: refundPart, method: giveBackRows[0].method, invoiceEventType: 'INVOICE_REFUNDED', refundId: giveBackRefund?.id },
        );
      }

      return tx.invoice.findUnique({ where: { id: invoice.id }, select: invoiceDetailSelect });
    };

    let updated;
    // Slice 30: the customer hears of a give-back once it has SUCCEEDED (by hand, or a card refund at
    // once); a pending bank give-back is announced when the processor confirms it (payment-reconciler).
    let giveBackSucceeded = refundPart > 0 && !pi;
    // Slice 31: a hand-recorded give-back has no timing to promise; a processor one follows its method.
    const giveBackTiming = refundTimingFor({ method: giveBackRows[0]?.method, processed: !!pi });
    if (!pi) {
      // Nothing goes through the processor: one transaction, refused whole if the invoice changed.
      // A give-back handed over by hand is done when it is recorded.
      updated = await prisma.$transaction(async (tx) => {
        await lockAndRecheck(tx);
        for (const data of giveBackRows) {
          await tx.refund.create({ data: { ...data, stripe_refund_id: null, state: 'SUCCEEDED' } });
        }
        return writeGiveBack(tx);
      });
    } else {
      // Slice 29: hold the give-back's money first (a PENDING reservation, under the lock), then
      // ask the processor, then write the rest with its answer (lib/in-app-refund.ts).
      const reservation = await prisma.$transaction(async (tx) => {
        await lockAndRecheck(tx);
        return reserveRefund(tx, giveBackRows[0]);
      });
      let stripeRefund: { id?: string; status?: string | null } | undefined;
      // Transition safety (spec §5.3) — see the identical comment in refundInvoice().
      const ctx = getStripeForOrg({ stripe_account_id: sourcePayment?.stripe_account_id ?? null });
      try {
        // Slice 7 - return the tip's proportional share alongside the cash give-back (slice 29: no fee).
        const extrasRefund = proportionalRefundExtras(refundPart, sourcePayment);
        stripeRefund = await createRefund(
          pi,
          ctx,
          Math.round((refundPart + extrasRefund) * 100),
          {
            metadata: { source: 'in_app', invoiceId: invoice.id, [REFUND_ROW_METADATA_KEY]: reservation.id },
            // Reverse the application fee only when this payment carried one (D1): a charge
            // taken since D9 has none, and the processor refuses to reverse what is not there.
            ...feeReversalOption(sourcePayment),
            idempotencyKey: `invoice-refund:${reservation.id}`,
          },
        );
      } catch (stripeErr: any) {
        logger.error('Stripe refund failed (credit excess):', stripeErr);
        if (!(await releaseIfRefused(req.user!.organization_id, reservation.id, stripeErr))) {
          // The answer never arrived: the refund may exist, so its money stays held.
          res.status(502).json({ error: REFUND_UNCONFIRMED_MESSAGE });
          return;
        }
        const refused = refusedRefundAnswer(stripeErr);
        res.status(refused.status).json({ error: refused.error });
        return;
      }
      updated = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT id FROM invoices WHERE id = ${invoice.id}::uuid AND organization_id = ${req.user!.organization_id}::uuid FOR UPDATE`;
        const { moved } = await completeReservedRefund(tx, {
          refundRowId: reservation.id,
          organizationId: req.user!.organization_id,
          stripeRefundId: stripeRefund?.id ?? null,
          state: inAppRefundState(stripeRefund?.status, sourcePayment?.method),
        });
        // Slice 31: if the refund's event settled the row first, the event told the customer.
        giveBackSucceeded = moved && inAppRefundState(stripeRefund?.status, sourcePayment?.method) === 'SUCCEEDED';
        return writeGiveBack(tx);
      });
    }

    const giveBackCustomer = invoice.customer ?? invoice.job?.customer;
    if (giveBackSucceeded && giveBackCustomer?.email) {
      sendInvoiceRefundNotification({
        organizationId: req.user!.organization_id,
        to: giveBackCustomer.email,
        customerName: [giveBackCustomer.first_name, giveBackCustomer.last_name].filter(Boolean).join(' ') || giveBackCustomer.company_name || 'Customer',
        invoiceNumber: invoice.invoice_number,
        invoiceId: invoice.id,
        refundAmount: refundPart,
        timing: giveBackTiming,
        record: {
          organizationId: req.user!.organization_id,
          customerId: giveBackCustomer.id,
          jobId: invoice.job?.id,
          jobLabel: invoice.job?.job_number,
        },
      }).catch((err) => logger.error('Invoice give-back refund email failed:', err));
    }

    // Slice 14: the credit (or a reopened balance) changed what the customer owes, so a link built
    // for the old amount must not take it. Post-commit, fire-and-forget: never fails the credit.
    if (creditPart > 0 || reopenBalance) {
      void closeOpenCheckoutLinks(req.user!.organization_id, [invoice], 'credit_applied');
    }

    // In-app notification: billing.credit_applied, on M6's two-lane chain and sent once the response has gone out.
    queueInvoiceAlert({
      verb: 'billing.credit_applied',
      organizationId: req.user!.organization_id,
      actorId: req.user?.id ?? null,
      object: { type: 'INVOICE', id: invoice.id, label: invoice.invoice_number },
      data: { object_label: invoice.invoice_number, amount },
    });

    void logAudit({
      req,
      action: 'invoice.credited',
      resourceType: 'Invoice',
      resourceId: invoice.id,
    });
    res.json({ invoice: updated && presentInvoiceDetail(req, stripInvoiceCost(updated, req)) });
  } catch (err) {
    if (err instanceof InvoiceChangedUnderLockError) {
      res.status(409).json({ error: INVOICE_CHANGED_MESSAGE });
      return;
    }
    logger.error('Error applying credit:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Void-payment (§8): involuntary; manual methods only; reopens amount_due ───
// ─── Payments go-live slice 29 (D17): cancel a bank payment that is still processing ───
export const cancelBankPaymentSchema = z.object({
  payment_id: z.string().uuid(),
});

/**
 * POST /api/invoices/:id/cancel-bank-payment - stop a bank debit that has not cleared. While a bank
 * payment is PROCESSING the money has not landed, so there is nothing to refund: the debit is
 * cancelled at the processor instead, and the payment is FAILED (it never counted, and the balance
 * it was going to pay stays open). The processor's own later "failed" event finds nothing to settle.
 * Needs the Refund payments permission, like every door that stops money reaching the business.
 */
export async function cancelBankPayment(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const { payment_id } = req.body as z.infer<typeof cancelBankPaymentSchema>;
    const invoice = await prisma.invoice.findUnique({
      where: { id: id as string, ...tenantWhere(req) },
      select: { id: true, invoice_number: true, organization_id: true },
    });
    if (!invoice) {
      res.status(404).json({ error: 'Invoice not found' });
      return;
    }
    if (!(await canAccessRow(req, 'Invoice', prisma.invoice, invoice.id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    const payment = await prisma.payment.findFirst({
      where: { id: payment_id, invoice_id: invoice.id },
      select: { id: true, amount: true, method: true, state: true, voided_at: true, stripe_payment_intent_id: true, stripe_account_id: true },
    });
    if (!payment) {
      res.status(404).json({ error: 'Payment not found on this invoice' });
      return;
    }
    if (payment.method !== 'ACH' || payment.state !== 'PROCESSING' || payment.voided_at || !payment.stripe_payment_intent_id) {
      res.status(400).json({ error: ONLY_PROCESSING_BANK_PAYMENT_CANCELS_MESSAGE });
      return;
    }

    try {
      // The account the debit was made in (the payment's snapshot), never the org's current one.
      await cancelPaymentIntent(payment.stripe_payment_intent_id, getStripeForOrg({ stripe_account_id: payment.stripe_account_id }));
    } catch (err) {
      logger.error(`Cancelling bank payment ${payment.id} (invoice ${invoice.id}) failed:`, err);
      const code = (err as { code?: unknown } | null)?.code;
      if (code === 'payment_intent_unexpected_state') {
        res.status(400).json({ error: BANK_PAYMENT_NOT_CANCELLABLE_MESSAGE });
      } else {
        res.status(500).json({ error: "This bank payment couldn't be cancelled through ServWave Payments. Try again in a moment." });
      }
      return;
    }

    await prisma.$transaction(async (tx) => {
      const settled = await settlePaymentInTx(tx, { paymentId: payment.id, organizationId: invoice.organization_id, to: 'FAILED' });
      if (!settled.changed) return;
      await tx.timelineEvent.create({
        data: {
          organization_id: invoice.organization_id,
          entity_type: 'INVOICE',
          entity_id: invoice.id,
          event_type: 'PAYMENT_CANCELED',
          description: `Bank payment of $${Number(payment.amount).toFixed(2)} canceled before it cleared`,
          metadata: { payment_id: payment.id },
          created_by: req.user!.id,
        },
      });
    });

    void logAudit({
      req,
      action: 'invoice.bank_payment_canceled',
      resourceType: 'Invoice',
      resourceId: invoice.id,
      metadata: { payment_id: payment.id, amount: Number(payment.amount) },
    });
    res.json({ success: true });
  } catch (err) {
    logger.error('Error cancelling bank payment:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export const voidPaymentSchema = z.object({
  payment_id: z.string().uuid(),
  void_category: z.enum(['BOUNCED', 'ERROR', 'DUPLICATE', 'WRONG_INVOICE']),
  reason: z.string().min(1).max(LONG_TEXT_MAX),
});

export async function voidPayment(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const body = req.body as z.infer<typeof voidPaymentSchema>;
    const { payment_id, void_category, reason } = body;

    const invoice = await prisma.invoice.findUnique({
      where: { id: id as string, ...tenantWhere(req) },
      select: { id: true, status: true, amount_due: true, total_amount: true, kind: true, invoice_number: true, job_id: true },
    });

    if (!invoice) {
      res.status(404).json({ error: 'Invoice not found' });
      return;
    }
    // #106 — grant-driven per-instance owner check (a void_payment-Invoice grant org-settings
    // narrows to owned rows must be enforced on THIS row, not just at the subject-level route guard).
    if (!(await canAccessRow(req, 'Invoice', prisma.invoice, id as string))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // §8/§10: void-payment is for live, paid invoices whose payment was never real. A terminal
    // (VOIDED / REFUNDED / CANCELLED) or pre-payment (DRAFT) document must NOT be resurrected.
    const VOIDABLE_STATUSES = ['PAID', 'PARTIAL', 'PARTIALLY_REFUNDED'];
    if (!VOIDABLE_STATUSES.includes(invoice.status)) {
      res.status(400).json({ error: `Cannot void a payment on a ${invoice.status} invoice` });
      return;
    }

    const payment = await prisma.payment.findFirst({
      where: { id: payment_id, invoice_id: invoice.id },
    });

    if (!payment) {
      res.status(404).json({ error: 'Payment not found on this invoice' });
      return;
    }
    if (payment.voided_at) {
      res.status(400).json({ error: 'Payment already voided' });
      return;
    }
    // Manual methods only — a settled card payment is reversed by refund, never voided.
    if (payment.method === 'CARD' || payment.method === 'EXTERNAL_CARD' || payment.stripe_payment_intent_id) {
      res.status(400).json({ error: 'Card payments are reversed by refund, not void' });
      return;
    }
    // Payments go-live slice 05: only a SUCCEEDED payment ever lowered the balance, so only it can
    // be voided back onto it. A processing or failed payment was never counted.
    if (payment.state !== 'SUCCEEDED') {
      res.status(400).json({ error: 'Only a payment that has gone through can be voided' });
      return;
    }

    const now = new Date();
    const reopenAmount = Number(payment.amount);

    // Every invoice whose balance this void raises: the invoice itself and, for a deposit, each
    // invoice its credit is taken back from.
    const raisedInvoices: Array<{ id: string; invoice_number: string }> = [invoice];
    const updated = await prisma.$transaction(async (tx) => {
      // The ledger doors (settlePayment / settleRefund) move the balance under the invoice lock.
      // Take it and re-read the balance and the payment under it, so the void reopens this
      // payment on the balance as it stands now, never on one read before a payment settled.
      await tx.$executeRaw`SELECT id FROM invoices WHERE id = ${invoice.id}::uuid AND organization_id = ${req.user!.organization_id}::uuid FOR UPDATE`;
      const locked = await tx.invoice.findUniqueOrThrow({
        where: { id: invoice.id },
        select: { status: true, amount_due: true, total_amount: true },
      });
      if (!VOIDABLE_STATUSES.includes(locked.status)) throw new RefusedUnderLockError(`Cannot void a payment on a ${locked.status} invoice`);
      const lockedPayment = await tx.payment.findUniqueOrThrow({ where: { id: payment.id }, select: { voided_at: true, state: true } });
      if (lockedPayment.voided_at) throw new RefusedUnderLockError('Payment already voided');
      if (lockedPayment.state !== 'SUCCEEDED') throw new RefusedUnderLockError('Only a payment that has gone through can be voided');
      const newDue = roundMoney(Number(locked.amount_due) + reopenAmount);
      const newStatus = newDue >= Number(locked.total_amount) - 0.0001 ? 'SENT' : 'PARTIAL';

      await tx.payment.update({
        where: { id: payment.id },
        data: { voided_at: now, voided_reason: reason, voided_by: req.user!.id, void_category },
      });

      await tx.invoice.update({
        where: { id: invoice.id },
        data: { amount_due: newDue, status: newStatus, paid_at: null },
      });

      await tx.timelineEvent.create({
        data: {
          organization_id: req.user!.organization_id,
          entity_type: 'INVOICE',
          entity_id: invoice.id,
          event_type: 'PAYMENT_VOIDED',
          description: `Payment of $${reopenAmount.toFixed(2)} voided on invoice ${invoice.invoice_number} (${void_category})`,
          metadata: { payment_id: payment.id, void_category, reason, amount: reopenAmount },
          created_by: req.user?.id,
        },
      });
      await recordJobMoneyMovement(
        tx, { orgId: req.user!.organization_id, userId: req.user!.id }, invoice.job_id, invoice, 'PAYMENT_VOIDED',
        { amount: reopenAmount, method: payment.method, invoiceEventType: 'PAYMENT_VOIDED', paymentId: payment.id },
      );

      // CASCADE: voiding a DEPOSIT payment un-applies its drawdown. The credit money behind each
      // application was never real, so each target invoice's balance rises by THIS deposit's
      // credit, and only its credit row is voided (slice 15; lib/deposit-credit-reversal.ts).
      if (invoice.kind === 'DEPOSIT') {
        const raised = await reverseDepositCredit(tx, {
          depositInvoiceId: invoice.id,
          organizationId: req.user!.organization_id,
          now,
          creditVoid: { voided_reason: 'Deposit payment voided', voided_by: req.user!.id, void_category },
        });
        for (const target of raised) {
          raisedInvoices.push(target);
          await tx.timelineEvent.create({
            data: {
              organization_id: req.user!.organization_id,
              entity_type: 'INVOICE',
              entity_id: target.id,
              event_type: 'DEPOSIT_CREDIT_REVERSED',
              description: `Deposit credit of $${target.amount.toFixed(2)} reversed on invoice ${target.invoice_number}`,
              metadata: { deposit_invoice_id: invoice.id, amount: target.amount },
              created_by: req.user?.id,
            },
          });
        }
      }

      return tx.invoice.findUnique({ where: { id: invoice.id }, select: invoiceDetailSelect });
    });

    void logAudit({
      req,
      action: 'invoice.payment_voided',
      resourceType: 'Invoice',
      resourceId: invoice.id,
    });
    // Slice 14: the balance went back up, so a link built before the void asks for too little.
    // After the commit and fire-and-forget: never fails the void.
    void closeOpenCheckoutLinks(req.user!.organization_id, raisedInvoices, 'payment_voided');
    res.json({ invoice: updated && presentInvoiceDetail(req, stripInvoiceCost(updated, req)) });
  } catch (err) {
    if (err instanceof RefusedUnderLockError) {
      res.status(400).json({ error: err.message });
      return;
    }
    logger.error('Error voiding payment:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * systemVoidPaymentForChargeback (entity-redesign §8 — Phase 2c, webhook-only)
 *
 * The INTERNAL system-void path for a LOST Stripe dispute. Routing the one involuntary
 * money-back through void-payment keeps Refund's no-reopen rule clean: the chargeback reopens
 * `amount_due` (the money was clawed back), the invoice carries a CHARGEBACK-voided payment.
 *
 * This is a SEPARATE path from the manual `voidPayment` HTTP handler (which correctly REJECTS a
 * CARD payment carrying a PI — manual card reversals go through refund). This function ALLOWS a
 * CARD/PI payment because the reason is an involuntary chargeback, and runs with NO req.user
 * (system actor = null `voided_by`). It mirrors voidPayment's reopen math + the kind=DEPOSIT
 * drawdown un-apply cascade. Must be called INSIDE a transaction by the webhook.
 *
 * Returns the ids of the invoices whose balance it raised (slice 15), for the caller's
 * post-commit checkout-link sweep.
 */
export async function systemVoidPaymentForChargeback(
  tx: Prisma.TransactionClient,
  args: {
    payment: { id: string; amount: number | Prisma.Decimal; method: string; stripe_payment_intent_id: string | null };
    invoice: { id: string; amount_due: number | Prisma.Decimal; total_amount: number | Prisma.Decimal; status: string; kind: string; invoice_number: string };
    disputeId: string;
    orgId: string;
    /** Payments go-live slice 09: a bank payment returned after it cleared (a late bank return). */
    bankReturn?: boolean;
  },
): Promise<string[]> {
  const { payment, invoice, disputeId, orgId, bankReturn } = args;
  const now = new Date();
  const reopenAmount = Number(payment.amount);
  const newDue = roundMoney(Number(invoice.amount_due) + reopenAmount);
  const newStatus = newDue >= Number(invoice.total_amount) - 0.0001 ? 'SENT' : 'PARTIAL';
  // A voided invoice is a document the contractor closed: the payment is still voided (the money
  // was taken back), but the invoice keeps its status and balance, so it never becomes payable again.
  const invoiceClosed = invoice.status === 'VOIDED';

  // Every write here is scoped by the org the event arrived on, not only the reads that led to it
  // (slice 09): a payment or invoice of another org is not found, which fails the event.
  await tx.payment.update({
    where: { id: payment.id, invoice: { organization_id: orgId } },
    data: {
      voided_at: now,
      voided_reason: bankReturn ? 'Returned by the bank' : 'Chargeback (dispute lost)',
      voided_by: null,
      void_category: 'CHARGEBACK',
    },
  });

  // A lost dispute is over: the invoice carries no pointer to it any more, so a payable-again invoice never reads as
  // having an open dispute. The charged-back record is the CHARGEBACK-voided payment, the history entry below and the
  // dispute row itself (slice 35, from the slice 09 acceptance).
  await tx.invoice.update({
    where: { id: invoice.id, organization_id: orgId },
    data: invoiceClosed
      ? { stripe_dispute_id: null }
      : { amount_due: newDue, status: newStatus, paid_at: null, stripe_dispute_id: null },
  });

  await tx.timelineEvent.create({
    data: {
      organization_id: orgId,
      entity_type: 'INVOICE',
      entity_id: invoice.id,
      event_type: 'CHARGEBACK',
      description: bankReturn
        ? `The bank returned the payment of $${reopenAmount.toFixed(2)} on invoice ${invoice.invoice_number}; payment voided, ${invoiceClosed ? 'the invoice stays voided' : 'balance reopened'}`
        : `Chargeback lost — payment of $${reopenAmount.toFixed(2)} voided on invoice ${invoice.invoice_number}; ${invoiceClosed ? 'the invoice stays voided' : 'balance reopened'}`,
      metadata: { payment_id: payment.id, stripe_dispute_id: disputeId, amount: reopenAmount },
    },
  });

  // Slice 15 (from the slice 14 review): every invoice whose balance this raises, returned so the
  // caller can close the checkout links still open for them once its transaction commits.
  const reopened: string[] = invoiceClosed ? [] : [invoice.id];

  // CASCADE: a charged-back DEPOSIT payment un-applies its drawdown, the same reversal as the staff
  // void (slice 15; lib/deposit-credit-reversal.ts): only this deposit's credit, under each
  // target's lock, a voided target left alone and each target's status derived from its money.
  if (invoice.kind === 'DEPOSIT') {
    const raised = await reverseDepositCredit(tx, {
      depositInvoiceId: invoice.id,
      organizationId: orgId,
      now,
      creditVoid: { voided_reason: 'Deposit payment charged back', voided_by: null, void_category: 'CHARGEBACK' },
    });
    for (const target of raised) {
      reopened.push(target.id);
      await tx.timelineEvent.create({
        data: {
          organization_id: orgId,
          entity_type: 'INVOICE',
          entity_id: target.id,
          event_type: 'DEPOSIT_CREDIT_REVERSED',
          description: `Deposit credit of $${target.amount.toFixed(2)} reversed on invoice ${target.invoice_number} (chargeback)`,
          metadata: { deposit_invoice_id: invoice.id, amount: target.amount },
        },
      });
    }
  }
  return reopened;
}

// ─── PDF ──────────────────────────────────────────────

export const getPdf = async (req: Request, res: Response): Promise<void> => {
  const id = param(req, 'id');
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id, ...tenantWhere(req) },
      select: invoicePdfSelect,
    });

    if (!invoice) {
      res.status(404).json({ error: 'Invoice not found' });
      return;
    }

    // #233-equivalent per-row ownership gate — IDENTICAL to getById's check. The route guard
    // (canDo) is subject-level only, so a granted-but-narrowed role could otherwise pull the
    // fully-priced PDF of an invoice outside their own scope. Runs alongside the org lookup
    // below — neither depends on the other's result.
    const [allowed, org] = await Promise.all([
      canAccessRow(req, 'Invoice', prisma.invoice, id),
      prisma.organization.findUnique({ where: { id: invoice.organization_id } }),
    ]);
    if (!allowed) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    if (!org) {
      res.status(500).json({ error: 'Organization not found' });
      return;
    }

    // Same template picker as the estimate PDF (org.estimate_template).
    // #1997 round 2 — this staff preview/download must degrade the same way the JSON detail
    // response does for a requester who cannot read the customer (mirrors estimate.controller.ts's
    // getPdf, which applies presentEstimateDetail the same way). getPublicPdf below is untouched —
    // it renders on behalf of the organization for the customer, not a requester.
    // A person without See financial data gets the same document with the scopes' internal cost gone,
    // so a cost never reaches the renderer, whatever a template chooses to draw.
    const pdfSource = presentInvoiceDetail(req, stripInvoiceCost(invoice, req));
    const buffer = await generateInvoicePdf(
      toInvoiceForPdf(pdfSource),
      org as any,
      (org.estimate_template ?? 'alpha-classic') as any,
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="invoice-${invoice.invoice_number}.pdf"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err) {
    logger.error(`PDF generation failed for invoice ${id}:`, err);
    res.status(500).json({ error: 'Failed to generate PDF' });
  }
};

// ─── Public PDF ───────────────────────────────────────

export const getPublicPdf = async (req: Request, res: Response): Promise<void> => {
  try {
    const id = param(req, 'id');
    const token = req.query.token as string | undefined;
    if (!token) {
      res.status(404).json({ error: 'Invoice not found' });
      return;
    }

    const inv = await prisma.invoice.findUnique({
      where: { id },
      select: { id: true, invoice_number: true, public_token: true },
    });
    if (!inv || inv.public_token !== token) {
      res.status(404).json({ error: 'Invoice not found' });
      return;
    }

    const fullInv = await prisma.invoice.findUnique({
      where: { id },
      select: invoicePdfSelect,
    });
    if (!fullInv) {
      res.status(404).json({ error: 'Invoice not found' });
      return;
    }

    // Use the invoice's own organization_id — public route has no req.user.
    const org = await prisma.organization.findUnique({ where: { id: fullInv.organization_id } });
    if (!org) {
      res.status(404).json({ error: 'Invoice not found' });
      return;
    }

    const buffer = await generateInvoicePdf(
      toInvoiceForPdf(fullInv),
      org as any,
      (org.estimate_template ?? 'alpha-classic') as any,
    );
    res.setHeader('Content-Type', 'application/pdf');
    // Inline, not attachment (mobile slice 04): the public page opens this in the same tab, and an
    // in-app browser has no download UI, so an attachment there did nothing. The viewer still saves.
    res.setHeader('Content-Disposition', `inline; filename="invoice-${inv.invoice_number}.pdf"`);
    res.send(buffer);
  } catch (err) {
    logger.error('Public invoice PDF generation failed:', err);
    res.status(500).json({ error: 'PDF generation failed' });
  }
};
