import { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma, PriceBookItemType, PaymentMethod } from '@prisma/client';
import { applyFilters } from '../lib/query/filterEngine';
import { invoiceFacets } from '../lib/query/registries/invoice.filters';
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
// Creator tracking (audit only) - stamped at every create, never read for authorization here.
import { createdByUser } from '../lib/created-by';
import { env } from '../config/env';
import { parsePagination, buildPaginationMeta, parseSortParams, respondInvalidSort } from '../lib/pagination';
import { INVOICE_SORT_FIELDS } from '../lib/sortFields';
import { logger } from '../lib/logger';
import { resolveOrAccreteLocation, LocationResolutionError, type LocationAddress } from '../lib/service-location';
import {
  sendInvoiceEmail,
  sendPaymentReceivedEmail,
  sendInvoiceRefundNotification,
} from '../lib/email';
import type { EmailDispatchResult } from '../lib/email';
import { createCheckoutSession, createRefund, getStripeForOrg, isStripeConfigured, resolveCheckoutFees, computeServiceFee, CARD_SERVICE_FEE_BPS, CARD_TIP_PRESET_BPS, expireCheckoutSession } from '../lib/stripe';
import { generateInvoicePdf } from '../lib/pdf';
import { invoicePdfSelect, toInvoiceForPdf } from '../lib/pdf/invoice-select';
import { scopeWhereForReq, canAccessRow, canSeePricing } from '../lib/permissions/enforce';
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
import { emit } from '../services/notifications/notificationService';
import { transitionLeadStatus } from '../services/lead-stage.service';
import { dispatchAutomationEvent } from '../services/automations/dispatch';
import { BeeService } from '../services/bee/beeService';
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
import { stripDocumentCost } from '../lib/scopes';
import { resolveTaxRateForState } from '../lib/tax/resolveTaxRate';
import { resolveDepositAmount, depositFigureWouldMove, type DepositOrgDefaults } from '../lib/estimates/deposit-amount';
import { isOnJobCrew } from '../lib/job-crew';

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
  description: z.string().min(1),
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
  voided_reason: z.string().min(1).max(1000),
});

export const editInvoiceSchema = z.object({
  due_date: z.string().datetime().optional(),
  // R3b (2026-07-21) — cost model (D2/D8). Nullable overhead_mode/value mirror deposit_type/value
  // (both must be set for an override; null falls back to the org default) — see resolveOverhead.
  labor_hours: z.number().min(0).max(99999).nullable().optional(),
  overhead_mode: z.enum(['PERCENTAGE', 'FIXED']).nullable().optional(),
  overhead_value: z.number().min(0).nullable().optional(),
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
  method: z.nativeEnum(PaymentMethod),
  paid_at: z.string().datetime().optional(),
  reference_number: z.string().max(100).optional(),
  notes: z.string().max(2000).optional(),
  // SRVW-55 — tip on a manually recorded payment. Rides on the payment, never the invoice
  // (D2/D3): amount_due, overpayment and isFullyPaid below are computed from `amount` alone.
  tip_amount: z.number().finite().min(0).max(10000).optional(),
});

export const addNoteSchema = z.object({
  content: z.string().min(1).max(5000),
});

// Send / Resend recipient override. Request-scoped — not saved to the customer.
export const sendInvoiceSchema = z.object({
  to: z.string().email().optional(),
  cc_emails: z.array(z.string().email()).max(5).optional(),
  message_body: z.string().max(5000).optional(),
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
  message_body: z.string().max(5000).optional(),
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
  subtotal: true,
  discount_amount: true,
  tax_rate: true,
  tax_amount: true,
  deposit_credit: true,
  total_amount: true,
  amount_due: true,
  // R3b (2026-07-21) - cost model (D2/D8/D18). Staff-only. SRVW-140 corrected the claim that
  // used to stand here: `read Invoice` is NOT canSeePricing any more (that keys on the dedicated
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
  stripe_dispute_id: true,
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
 * canDo('read'/'update','Invoice') "which IS canSeePricing, so no strip is needed", which was
 * true only while canSeePricing keyed on `read Invoice`. It now keys on the dedicated
 * `read Pricing` grant, so a requester who can open an invoice RECORD but has "See financial
 * data" off must not get its cost model back on the detail response. Lives next to
 * `invoiceDetailSelect` because it is paired with it; invoice-lines.controller.ts imports it
 * (that file already imports invoiceDetailSelect from here, and this file imports nothing from
 * it, so there is no cycle).
 */
export const stripInvoiceCost = stripDocumentCost;

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
};

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
        visits: { select: { assignees: { select: { user_id: true } } } },
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

    // Phase B (#235 / F-013) — role-agnostic per-instance ownership. The route already required
    // `create Invoice` via canDo (subject-level only); narrow it to THIS job here. A requester with
    // an UNCONDITIONAL create grant (dispatcher/admin — their Invoice read-scope is {}) may invoice
    // any job; a per-user OWN-scoped grantee (whose paired `read Invoice` is conditioned via job,
    // so scopeWhereForReq returns a non-empty fragment) may invoice only a job they're assigned to.
    // This replaces the old `role === 'TECHNICIAN'`/`role === 'SALES'` literals, which a per-user
    // grant could not override. Mirrors canAccessRow's "scope {} ⇒ no restriction" fast-path.
    const invoiceScope = await scopeWhereForReq(req, 'Invoice');
    const unconditionalCreator = Object.keys(invoiceScope).length === 0;
    if (!unconditionalCreator && !isOnJobCrew(job, req.user!.id)) {
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
      await applyDepositCreditsWithPayments(tx, paidDeposits, created.id, totalAmount, req.user!.organization_id);

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
// credit (no estimate ⇒ nothing to draw down). kind = STANDARD. ADMIN + DISPATCHER only (the
// `create Invoice` CASL grant also covers TECHNICIAN, but a technician may only invoice via THEIR
// own job — never a job-less standalone — so the controller rejects them here).
async function createStandaloneInvoice(req: Request, res: Response) {
  const role = req.user?.role;
  if (role !== 'ADMIN' && role !== 'DISPATCHER') {
    return res.status(403).json({ error: 'Not authorized to create a standalone invoice' });
  }

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
      // Need invoices (completed jobs with no active invoice — every invoice is VOIDED, or none exist).
      // GAP-3: scope by the requester's Job read-scope so a row-scoped role counts only jobs it can see.
      prisma.job.count({
        where: {
          ...tenantWhere(req),
          ...jobScope,
          status: 'COMPLETED',
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
        where: { voided_at: null, invoice: { ...scopeWhere, kind: 'DEPOSIT' } },
        _sum: { amount: true },
      }),
      prisma.depositCreditApplication.aggregate({
        where: { reversed_at: null, deposit_invoice: scopeWhere },
        _sum: { amount: true },
      }),
      prisma.refund.aggregate({
        where: { invoice: { ...scopeWhere, kind: 'DEPOSIT' } },
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
      invoices: invoices.map((i) => ({ ...i, tags: tagsByInvoice.get(i.id) ?? [] })),
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
    res.json({ invoices });
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

    res.json({ invoice: presentInvoiceDetail(req, stripInvoiceCost({ ...invoice, needs_resend: needsResend, tags }, req)) });
  } catch (err) {
    logger.error('Error fetching invoice:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function update(req: Request, res: Response) {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      select: { id: true, status: true, due_date: true, sent_at: true, job: { select: { visits: { select: { assignees: { select: { user_id: true } } } }, estimate: { select: { lead: { select: { lead_assignees: { select: { user_id: true } } } } } } } } },
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

    const { due_date, labor_hours, overhead_mode, overhead_value } = req.body;

    // R3b (2026-07-21) — labor_hours/overhead_mode/overhead_value are staff-only cost-model
    // inputs (D2/D8). A requester who can't see pricing (canSeePricing gates read Invoice) must
    // not be able to blindly set them either — mirrors Estimate's identical write-guard.
    if (
      (labor_hours !== undefined || overhead_mode !== undefined || overhead_value !== undefined)
      && !canSeePricing(req)
    ) {
      return res.status(403).json({ error: 'Insufficient permissions to edit cost fields' });
    }

    const updated = await prisma.invoice.update({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      data: {
        due_date: due_date ? new Date(due_date) : undefined,
        labor_hours: labor_hours !== undefined ? (labor_hours ?? null) : undefined,
        overhead_mode: overhead_mode !== undefined ? (overhead_mode || null) : undefined,
        overhead_value: overhead_value !== undefined ? (overhead_value ?? null) : undefined,
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

export async function remove(req: Request, res: Response) {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      select: { id: true, status: true, invoice_number: true, job_id: true, kind: true, total_amount: true, job: { select: { visits: { select: { assignees: { select: { user_id: true } } } }, estimate: { select: { lead: { select: { lead_assignees: { select: { user_id: true } } } } } } } } },
    });

    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    // #106 — grant-driven per-instance owner check (mirrors update(); the subject-level route guard
    // is not enough). canAccessRow resolves the read-Invoice grant scope through SQL — see update().
    if (!(await canAccessRow(req, 'Invoice', prisma.invoice, param(req, 'id')))) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    if (invoice.status !== 'DRAFT') return res.status(400).json({ error: 'Only DRAFT invoices can be deleted' });

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

// Extracted from send() so bulkSend() (list-level bulk send, Invoices list page) can share the
// EXACT same guard/PREP/EMAIL/COMMIT sequence without duplicating it. Returns a result instead of
// writing to `res` directly - send() and bulkSend() each translate that result into their own
// response shape. Same pattern as estimate.controller.ts's deleteEstimateInternal/bulkRemove.
async function sendInvoiceInternal(
  req: Request,
  id: string,
  body: z.infer<typeof sendInvoiceSchema>,
): Promise<{ ok: true; invoice: unknown } | { ok: false; status: number; error: string }> {
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

  const publicToken = crypto.randomUUID();
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
  });

  if (emailResult.status !== 'sent') {
    const { code, message } = mapInvoiceEmailFailure(emailResult, 'send');
    return { ok: false, status: code, error: message };
  }

  // ── COMMIT (phase 3): email confirmed sent - flip the status + write the ledger ─────
  const updated = await prisma.$transaction(async (tx) => {
    const inv = await tx.invoice.update({
      where: { id, ...tenantWhere(req) },
      data: {
        status: 'SENT',
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

  // ─── Bee Warranty & Outbound Call Scheduling — post-commit, fire-and-forget ──
  setImmediate(() => {
    void BeeService.processInvoiceSent(updated.id, req.user!.organization_id, req.user?.id).catch((err) => {
      logger.error(`[BeeService] Error processing warranty for invoice ${updated.id}:`, err);
    });
  });

  return { ok: true, invoice: presentInvoiceDetail(req, stripInvoiceCost(updated, req)) };
}

export async function send(req: Request, res: Response) {
  try {
    const body = req.body as z.infer<typeof sendInvoiceSchema>;
    const result = await sendInvoiceInternal(req, param(req, 'id'), body);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
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
    const sent: string[] = [];
    const failed: { id: string; error: string }[] = [];

    for (const id of ids) {
      try {
        const result = await sendInvoiceInternal(req, id, { ...(message_body !== undefined ? { message_body } : {}) });
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
): Promise<{ ok: true; invoice: unknown } | { ok: false; status: number; error: string }> {
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
  });

  if (emailResult.status !== 'sent') {
    const { code, message } = mapInvoiceEmailFailure(emailResult, 'resend');
    return { ok: false, status: code, error: message };
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
    const result = await resendInvoiceInternal(req, param(req, 'id'), body);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
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
    const sent: string[] = [];
    const failed: { id: string; error: string }[] = [];

    for (const id of ids) {
      try {
        const result = await resendInvoiceInternal(req, id, { ...(message_body !== undefined ? { message_body } : {}) });
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
function mapInvoiceEmailFailure(result: EmailDispatchResult, action: 'send' | 'resend'): { code: number; message: string } {
  const verb = action === 'send' ? 'sent' : 'resent';
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
// email_sending_enabled toggle. A payable link requires the invoice to be issued (public
// checkout only accepts SENT/PARTIAL), so a DRAFT invoice is minted a token and flipped to
// SENT here; an already-issued invoice just returns its existing token (idempotent).
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
    const publicToken = crypto.randomUUID();
    const dueDate = invoice.due_date || calculateDueDate(cust?.payment_type, new Date());

    const updated = await prisma.$transaction(async (tx) => {
      const inv = await tx.invoice.update({
        where: { id: param(req, 'id'), ...tenantWhere(req) },
        data: {
          status: 'SENT',
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
          description: `Payment link created for invoice ${inv.invoice_number} (invoice issued, no email sent)`,
          created_by: req.user?.id,
        },
      });

      return inv;
    });

    void logAudit({
      req,
      action: 'invoice.payment_link_created',
      resourceType: 'Invoice',
      resourceId: updated.id,
      metadata: { invoice_number: updated.invoice_number },
    });

    const url = `${env.FRONTEND_URL || ''}/p/invoices/${updated.id}?token=${publicToken}`;
    res.json({ invoice: presentInvoiceDetail(req, stripInvoiceCost(updated, req)), url });
  } catch (err) {
    logger.error('Error creating invoice payment link:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function voidInvoice(req: Request, res: Response) {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      select: { id: true, status: true, invoice_number: true, kind: true, total_amount: true, job_id: true, organization_id: true, job: { select: { visits: { select: { assignees: { select: { user_id: true } } } }, estimate: { select: { lead: { select: { lead_assignees: { select: { user_id: true } }, commission_owner_id: true } } } } } } },
    });

    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    // #106 — grant-driven per-instance owner check (a void-Invoice grant org-settings narrows to
    // owned rows must be enforced on THIS row, not just at the subject-level route guard).
    if (!(await canAccessRow(req, 'Invoice', prisma.invoice, param(req, 'id')))) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    if (invoice.status === 'PAID' || invoice.status === 'VOIDED') {
      return res.status(400).json({ error: 'Cannot void a PAID or already VOIDED invoice' });
    }
    if (invoice.status === 'DRAFT') {
      return res.status(400).json({ error: 'Use DELETE for DRAFT invoices' });
    }

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

    // In-app notification: billing.voided
    await emit({
      verb: 'billing.voided',
      organizationId: req.user!.organization_id,
      actorId: req.user?.id ?? null,
      object: { type: 'INVOICE', id: param(req, 'id'), label: invoice.invoice_number },
      entity: { customer_owner_id: invoice.job?.estimate?.lead?.commission_owner_id ?? null },
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

    res.json({ events });
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
            visits: { select: { assignees: { select: { user_id: true } } } },
            customer: { select: { id: true, first_name: true, last_name: true, company_name: true, email: true } },
            estimate: { select: { lead: { select: { lead_assignees: { select: { user_id: true } }, commission_owner_id: true } } } },
          },
        },
      },
    });

    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    // Status guard: DRAFT, SENT, or PARTIAL — sending first is not required
    if (invoice.status !== 'DRAFT' && invoice.status !== 'SENT' && invoice.status !== 'PARTIAL') {
      return res.status(400).json({ error: 'Payments can only be recorded on DRAFT, SENT, or PARTIAL invoices' });
    }

    // Overpayment (§8): amount > amount_due is ALLOWED — record the real money received,
    // flag the excess, default refund-the-excess (no pre-lock reject).

    if (!(await canAccessRow(req, 'Invoice', prisma.invoice, param(req, 'id')))) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    // 2. Transaction with row locking
    const result = await prisma.$transaction(async (tx) => {
      // Re-read within transaction to prevent race conditions
      const lockedInvoice = await tx.invoice.findUniqueOrThrow({
        where: { id: param(req, 'id'), ...tenantWhere(req) },
        select: { amount_due: true, status: true },
      });
      const currentDue = Number(lockedInvoice.amount_due);

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
          description: `Payment of $${amount.toFixed(2)} received via ${method}`
            + (tip_amount > 0 ? ` (plus $${Number(tip_amount).toFixed(2)} tip)` : ''),
          created_by: req.user?.id,
        },
      });

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
    // every copy and no human ever saw one. The emit() below already routes this event
    // to admins + dispatchers + the customer owner, so the email was redundant as well
    // as undeliverable.

    // In-app notification: billing.payment_received / billing.partial_payment
    const customerOwnerId = invoice.job?.estimate?.lead?.commission_owner_id ?? null;
    await emit({
      verb: result.isFullyPaid ? 'billing.payment_received' : 'billing.partial_payment',
      organizationId: req.user!.organization_id,
      actorId: req.user?.id ?? null,
      object: { type: 'INVOICE', id: param(req, 'id'), label: invoice.invoice_number },
      entity: { customer_owner_id: customerOwnerId },
      data: { object_label: invoice.invoice_number, amount },
    });

    // estimate.deposit_paid: parity with estimate.controller.ts + webhook.controller.ts (#268).
    // dedupKey matches the other two doors so multi-door payment never double-pins.
    if (result.isFullyPaid && invoice.kind === 'DEPOSIT' && invoice.estimate) {
      await emit({
        verb: 'estimate.deposit_paid',
        organizationId: req.user!.organization_id,
        actorId: req.user?.id ?? null,
        object: { type: 'ESTIMATE', id: invoice.estimate.id, label: invoice.estimate.estimate_number },
        entity: { commission_owner_id: invoice.estimate.lead?.commission_owner_id ?? null },
        data: { object_label: invoice.estimate.estimate_number, lead_id: invoice.estimate.lead_id },
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
    res.status(201).json({ invoice: presentInvoiceDetail(req, stripInvoiceCost(result.invoice, req)), payment: result.payment, overpaid: result.overpaid });
  } catch (err: any) {
    logger.error('Error recording payment:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// --- Public Handlers (no auth) ---

// Shared by getPublic + createPublicCheckout — the CARD-availability truth used to decide which
// methods to render on the public page must be the exact same resolution used to gate checkout
// creation, or the two can disagree (code-review finding: createPublicCheckout used to check
// only stripe_charges_enabled, which doesn't account for an AppSetting override that excludes
// CARD even while charges are enabled). Fallback chain: AppSetting (per-org override, if admin
// set it) → org.accepted_payment_methods (§4.5 org-level set) → hardcoded default. Task 1.7
// re-key: CARD requires stripe_charges_enabled (the mirrored-from-Stripe truth), not merely
// accepted_payment_methods/stripe_account_id presence — dropped from the resolved list (even a
// stale override) when charges aren't enabled.
// #904/#927 - also exported to estimate.controller, whose public estimate page and deposit-approve
// endpoint must agree with this same resolution about whether CARD is payable.
export function resolveAvailablePaymentMethods(
  methodsSettingValue: string | null | undefined,
  org: { accepted_payment_methods: unknown; stripe_charges_enabled: boolean } | null | undefined,
): string[] {
  // R5b (2026-07-22) — checked what actually reaches this hardcoded-default branch before leaving
  // it un-widened: `accepted_payment_methods` defaults to `[]` (still an array) and every
  // pre-existing org was backfilled to a non-empty array
  // (20260526102119_backfill_and_drop_payment_provider), so `Array.isArray(...)` is true for every
  // real org row — this default only fires when `org` itself is null/undefined (the lookup
  // failed), not "an org that hasn't configured anything" the way it reads. Left un-widened
  // anyway (no reason for a can't-happen-in-practice branch to list methods nothing reaches).
  const ORG_DEFAULT = Array.isArray(org?.accepted_payment_methods)
    ? (org!.accepted_payment_methods as string[])
    : ['CARD', 'EXTERNAL_CARD', 'BANK_TRANSFER', 'CHECK', 'CASH'];
  let availableMethods: string[] = ORG_DEFAULT;
  try {
    if (methodsSettingValue) {
      const parsed = JSON.parse(methodsSettingValue);
      // Array check, not just a parse guard: valid JSON that is not an array (a bare number,
      // string, object) used to pass straight through and then throw on .filter below, 500ing
      // the public invoice/estimate page. A malformed override falls back to the org default
      // instead - the page stays up, and CARD is still gated by stripe_charges_enabled.
      if (Array.isArray(parsed)) availableMethods = parsed;
    }
  } catch { /* ignore parse error, use default */ }
  if (!org?.stripe_charges_enabled) {
    availableMethods = availableMethods.filter((m) => m !== 'CARD');
  }
  return availableMethods;
}

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
            // F-55: street lines (address_line1/2) withheld from the public payload — city/state/zip
            // suffice to confirm the service area on the public invoice without leaking the full address.
            service_location: {
              select: { city: true, state: true, zip: true },
            },
          },
        },
        payments: {
          select: { id: true, amount: true, method: true, paid_at: true },
          orderBy: { paid_at: 'asc' as const },
        },
      },
    });

    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    // Fetch payment settings + org branding in parallel (use invoice's own org_id — public route has no req.user)
    const invOrgId = invoice.organization_id;
    const [methodsSetting, bankTransferSetting, checkSetting, cashSetting, org] = await Promise.all([
      prisma.appSetting.findUnique({ where: { organization_id_key: { organization_id: invOrgId, key: 'available_payment_methods' } } }),
      prisma.appSetting.findUnique({ where: { organization_id_key: { organization_id: invOrgId, key: 'bank_transfer_instructions' } } }),
      prisma.appSetting.findUnique({ where: { organization_id_key: { organization_id: invOrgId, key: 'check_instructions' } } }),
      prisma.appSetting.findUnique({ where: { organization_id_key: { organization_id: invOrgId, key: 'cash_instructions' } } }),
      prisma.organization.findUnique({ where: { id: invOrgId } }),
    ]);

    const availableMethods = resolveAvailablePaymentMethods(methodsSetting?.value, org);

    const organization = org ? {
      name: org.name,
      logo_url: org.logo_url,
      brand_color: org.brand_color,
      phone: org.phone,
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
      // §4.5 — Stripe capability is implicit in available_payment_methods below.
      accepted_payment_methods: Array.isArray(org.accepted_payment_methods)
        ? (org.accepted_payment_methods as string[])
        : [],
    } : null;

    // Slice 4 — display-only preview so the public page can render the Service Fee row before
    // redirect (D8). Unconditional, exactly like checkout: every card payment carries the fee.
    const amountDueCents = Math.round(Number(invoice.amount_due) * 100);
    const serviceFeePreview = computeServiceFee(amountDueCents, CARD_SERVICE_FEE_BPS) / 100;

    // #2031 slice 5 — the same predicate the checkout POST refuses on, so the page and the money
    // door can never disagree about whether this deposit can be paid right now. The REASON rides
    // along because the page has to explain itself: a recalled estimate and a stale figure both
    // withdraw the payment options, and they are different things to tell a customer.
    const holdReason = depositHoldReason(invoice, org);
    // The estimate's internal state was read for that decision only; the customer's payload does
    // not carry it.
    const { estimate: _internalEstimateState, ...publicInvoice } = invoice;

    res.json({
      // #1997 — a fail-closed BACKSTOP, not the protection itself: this route is unauthenticated,
      // so the presenter can only answer "not readable". What actually keeps contact off this
      // payload is the select above (F-55, display name only). See estimate.controller.ts's
      // `getPublic` for the same note.
      invoice: presentInvoiceDetail(req, publicInvoice),
      organization,
      deposit_hold_reason: holdReason,
      available_payment_methods: availableMethods,
      payment_instructions: {
        bank_transfer: bankTransferSetting?.value ?? null,
        check: checkSetting?.value ?? null,
        cash: cashSetting?.value ?? null,
      },
      service_fee_bps: CARD_SERVICE_FEE_BPS,
      service_fee_preview: serviceFeePreview,
      // Slice 8 — the tip chips render off this, so the presets never need hardcoding client-side.
      tip_preset_bps: CARD_TIP_PRESET_BPS,
    });
  } catch (err) {
    logger.error('Error fetching public invoice:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// Slice 7 (D10/D11) — invoices only, per the plan (the estimate-deposit checkout path is
// untouched). A tip is a customer input over a public token-authed route: untrusted, so it is
// bounded and re-validated server-side here rather than merely re-read from the client.
const publicCheckoutSchema = z.object({
  tip: z.number().finite().min(0).max(10000).optional(),
});

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
  'This deposit request is on hold while the estimate is being updated. Please contact us if you would like to pay it now.';

/** Why a deposit link is refusing money right now. */
export type DepositHoldReason = 'SUPERSEDED' | 'ESTIMATE_IN_DRAFT';

/** The refusal a door hands back. One reason → one code → one piece of customer copy. */
export function depositHoldRefusal(reason: DepositHoldReason): { error: string; code: string } {
  return reason === 'ESTIMATE_IN_DRAFT'
    ? { error: DEPOSIT_ON_HOLD_MESSAGE, code: DEPOSIT_ON_HOLD_CODE }
    : { error: DEPOSIT_SUPERSEDED_MESSAGE, code: DEPOSIT_SUPERSEDED_CODE };
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
 * whether money can move, the same rule resolveAvailablePaymentMethods exists to enforce for CARD;
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
      return res.status(400).json({ error: 'Invalid tip amount' });
    }
    const tipCents = parsedBody.data.tip ? Math.round(parsedBody.data.tip * 100) : 0;

    if (!isStripeConfigured()) {
      return res.status(400).json({ error: 'Card payments are not configured' });
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
        estimate: { select: { status: true, modified_after_send: true, deposit_type: true, deposit_value: true, total_amount: true } },
        customer: { select: { first_name: true, last_name: true, company_name: true } },
        job: {
          select: {
            customer: { select: { first_name: true, last_name: true, company_name: true } },
          },
        },
        organization: { select: { id: true, stripe_account_id: true, accepted_payment_methods: true, stripe_charges_enabled: true, deposit_default_type: true, deposit_default_percentage: true, deposit_default_fixed_amount: true } },
      },
    });

    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (invoice.status !== 'SENT' && invoice.status !== 'PARTIAL') {
      return res.status(400).json({ error: 'Invoice is not payable' });
    }
    // #2031 slice 5 — the two windows in which this link is alive but must not take money: the
    // gap between a material edit and the next send (§A3 leaves an edited SENT estimate SENT and
    // nulls ITS public link, while the deposit invoice minted at the first send keeps its own live
    // token and its old amount), and a recall to draft, which withdraws the document altogether
    // and, by clearing modified_after_send, used to reopen this door rather than close it.
    //
    // Ran's decision in both cases is to leave the link alive and unrotated — never voided, never
    // re-minted — and have it decline. The next send re-prices this same invoice behind this same
    // token and lifts the refusal in the same transaction.
    const holdReason = depositHoldReason(invoice, invoice.organization);
    if (holdReason) {
      return res.status(400).json(depositHoldRefusal(holdReason));
    }
    // Task 1.7 re-key — block checkout creation unless the owning org's Stripe charges are
    // actually enabled (stripe_charges_enabled is the mirrored-from-Stripe truth;
    // accepted_payment_methods/stripe_account_id presence alone can go stale — e.g.
    // mid-onboarding, or after a later deauthorized/restricted account).
    if (!invoice.organization.stripe_charges_enabled) {
      return res.status(400).json({ error: 'Card payments are not enabled for this organization' });
    }
    // Code-review finding: stripe_charges_enabled alone doesn't guarantee CARD is actually in
    // the org's resolved accepted-methods list (an AppSetting override could exclude it even
    // while charges are enabled). Both are required, not either/or — reuse getPublic's exact
    // resolution chain so the public GET and this checkout POST can never disagree.
    const methodsSetting = await prisma.appSetting.findUnique({
      where: { organization_id_key: { organization_id: invoice.organization.id, key: 'available_payment_methods' } },
    });
    const availableMethods = resolveAvailablePaymentMethods(methodsSetting?.value, invoice.organization);
    if (!availableMethods.includes('CARD')) {
      return res.status(400).json({ error: 'Card payments are not enabled for this organization' });
    }

    const paymentAmount = Number(invoice.amount_due);
    const checkoutCustomer = invoice.customer ?? invoice.job?.customer;
    const customerName = [checkoutCustomer?.first_name, checkoutCustomer?.last_name].filter(Boolean).join(' ') || checkoutCustomer?.company_name || 'Customer';

    const baseUrl = env.FRONTEND_URL || '';
    const ctx = getStripeForOrg(invoice.organization);
    // Double guard, layer 1 (defensive at the caller): only compute a fee at all when this
    // checkout is actually running against a connected account. Layer 2 lives inside
    // createCheckoutSession itself, which re-checks ctx.stripeAccount before including the field.
    // D2 — resolveCheckoutFees owns the fee math so this call site and the estimate-deposit one
    // (estimate.controller.ts) can never drift on it.
    const fees = ctx.stripeAccount
      ? resolveCheckoutFees(Math.round(paymentAmount * 100))
      : undefined;
    const session = await createCheckoutSession({
      depositAmount: paymentAmount,
      description: `Payment for Invoice ${invoice.invoice_number} — ${customerName}`,
      successUrl: `${baseUrl}/p/invoices/${invoice.id}?token=${token}&payment=success`,
      cancelUrl: `${baseUrl}/p/invoices/${invoice.id}?token=${token}&payment=cancelled`,
      metadata: { invoiceId: invoice.id },
      applicationFeeAmount: fees?.applicationFeeAmount,
      serviceFeeAmount: fees?.serviceFeeAmount,
      // D2 — application_fee_amount is sized off amount_due alone; the tip never enters it
      // (Stripe's cut of the tip is absorbed by the org, not the customer - deliberate).
      tipAmount: tipCents > 0 ? tipCents : undefined,
    }, ctx);

    // #2031 slice 5 (F2) — the last sliver of the window. The guard above read the invoice, and
    // only THEN did Stripe mint a session; a material edit landing in between produces exactly the
    // thing this slice exists to prevent — a live session at a figure the estimate no longer
    // supports. Everywhere else that window is closed by expiring open sessions at the edit, but
    // this one does not exist yet when the sweep runs. So the answer is re-checked now that the
    // session does exist, and a session that lost the race is killed before its URL is handed out.
    // Deposits only: an ordinary invoice has no such gate to lose a race against.
    if (invoice.kind === 'DEPOSIT') {
      const recheck = await prisma.invoice.findFirst({
        where: { id: invoice.id, public_token: token },
        select: {
          kind: true,
          total_amount: true,
          estimate: { select: { status: true, modified_after_send: true, deposit_type: true, deposit_value: true, total_amount: true } },
        },
      });
      const raceReason = recheck ? depositHoldReason(recheck, invoice.organization) : 'SUPERSEDED';
      if (raceReason) {
        // Fail-soft: if the session cannot be killed the customer still never receives its URL,
        // and the sweep at the edit or recall that closed the door will try again.
        await expireCheckoutSession(session.id, ctx);
        return res.status(400).json(depositHoldRefusal(raceReason));
      }
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
  method: z.nativeEnum(PaymentMethod).optional(),
  reference_number: z.string().max(100).optional(),
  non_taxable_concession: z.boolean().optional(),
  reason_category: z.enum(REFUND_CATEGORIES),
  reason: z.string().min(1).max(500),
});

function proportionalShare(refundFaceAmount: number, faceAmount: number, extraAmount: number): number {
  if (!(extraAmount > 0) || !(faceAmount > 0)) return 0;
  return roundMoney(extraAmount * (refundFaceAmount / faceAmount));
}

/**
 * Slice 6/7 (card service fee + tipping) — a refund must return the service fee AND the tip too:
 * a full refund the whole of each, a partial refund each one's proportional share. Both sit in
 * the Stripe charge total, not the application fee (which Stripe already prorates automatically
 * via reverseApplicationFee), so they need their own explicit addition to the Stripe refund
 * amount.
 *
 * Proportional against the SOURCE payment's ORIGINAL face amount, fee and tip (all immutable
 * once the webhook writes them), not any running total - so repeated partial refunds against the
 * same payment sum to exactly 100% of each, never more.
 *
 * D1/D10 — this only changes what Stripe is asked to return. Refund.amount, Invoice.total_refunded
 * and net_collected stay face-value-only; neither the fee nor the tip ever re-enters the invoice
 * ledger.
 */
function proportionalRefundExtras(
  refundFaceAmount: number,
  sourcePayment: { amount: unknown; service_fee_amount?: unknown; tip_amount?: unknown } | null,
): number {
  if (!sourcePayment) return 0;
  const faceAmount = Number(sourcePayment.amount ?? 0);
  const feeShare = proportionalShare(refundFaceAmount, faceAmount, Number(sourcePayment.service_fee_amount ?? 0));
  const tipShare = proportionalShare(refundFaceAmount, faceAmount, Number(sourcePayment.tip_amount ?? 0));
  return roundMoney(feeShare + tipShare);
}

// Non-deposit-credit payment filter: keep real payments (NULL or non-DEPOSIT-CREDIT reference),
// drop the synthetic DEPOSIT-CREDIT rows. Prisma `{ not: value }` excludes NULLs, so allow null.
const NON_CREDIT_PAYMENT_FILTER: Prisma.PaymentWhereInput = {
  voided_at: null,
  OR: [{ reference_number: null }, { reference_number: { not: DEPOSIT_CREDIT_REFERENCE } }],
};

export async function refundInvoice(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const body = req.body as z.infer<typeof refundInvoiceSchema>;
    const { reason_category, reason, payment_id, non_taxable_concession } = body;

    const invoice = await prisma.invoice.findUnique({
      where: { id: id as string, ...tenantWhere(req) },
      include: {
        organization: true,
        // Real (non-voided, non-deposit-credit) payments — manual methods now eligible too.
        payments: { where: NON_CREDIT_PAYMENT_FILTER },
        refunds: true,
        customer: true,
        job: { include: { customer: true, estimate: { select: { lead: { select: { commission_owner_id: true } } } } } },
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
    if (invoice.status !== 'PAID' && invoice.status !== 'PARTIALLY_REFUNDED') {
      res.status(400).json({ error: `Invoice must be PAID to refund (current: ${invoice.status})` });
      return;
    }

    // Net math is computed from the live payments/refunds, NOT the cached column
    // (legacy rows carry net_collected=0; the cached value can't be trusted).
    const paymentsTotal = invoice.payments.reduce((s, p) => s + Number(p.amount), 0);
    const priorRefunded = invoice.refunds.reduce((s, r) => s + Number(r.amount), 0);
    const netPaid = roundMoney(paymentsTotal - priorRefunded);

    // MON-09: a DEPOSIT invoice's refundable balance is the DRAWDOWN-AWARE remaining credit
    // (paid − applied − refunded), NOT the raw net-paid. A deposit already drawn down onto a job's
    // STANDARD invoice is NOT refundable — refunding it would double-spend the credit. Non-deposit
    // invoices keep capping at net-paid.
    const refundableCap = invoice.kind === 'DEPOSIT'
      ? roundMoney(await remainingDepositCredit(prisma, invoice.id))
      : netPaid;

    if (refundableCap <= 0) {
      res.status(400).json({
        error: invoice.kind === 'DEPOSIT'
          ? 'Deposit credit is fully applied or refunded — nothing left to refund'
          : 'No remaining net-paid balance to refund',
      });
      return;
    }

    // Resolve the source payment: the named one, else the single real payment when unambiguous.
    const sourcePayment = payment_id
      ? invoice.payments.find((p) => p.id === payment_id) ?? null
      : (invoice.payments.length === 1 ? invoice.payments[0] : null);

    if (payment_id && !sourcePayment) {
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

    // Cap B: when payment_id set, ≤ that payment's un-refunded balance.
    if (sourcePayment && payment_id) {
      const paymentRefunded = invoice.refunds
        .filter((r) => r.payment_id === sourcePayment.id)
        .reduce((s, r) => s + Number(r.amount), 0);
      const paymentBalance = roundMoney(Number(sourcePayment.amount) - paymentRefunded);
      if (amount > paymentBalance + 0.0001) {
        res.status(400).json({ error: 'Refund exceeds payment balance' });
        return;
      }
    }

    // Method: free-choice, default the source payment's method, else CARD.
    const method = body.method ?? (sourcePayment?.method as PaymentMethod | undefined) ?? 'CARD';

    // Tax portion: proportional gross×tax/total; $0 under a non-taxable concession.
    const taxPortion = computeRefundTax(amount, invoice.tax_amount, invoice.total_amount, non_taxable_concession);

    // Execution keys off the SOURCE payment's PI presence — NOT the method label.
    const pi = sourcePayment?.stripe_payment_intent_id ?? null;
    let stripeRefundId: string | null = null;

    if (pi) {
      // MONEY-FIRST: call Stripe, write the Refund row only after it confirms.
      // Transition safety (spec §5.3): key off the PAYMENT row's stripe_account_id
      // snapshot, not the org's CURRENT one — an org may connect Stripe (or its
      // account may otherwise change) after this charge was made, so the org's
      // present-day value could point refund execution at the wrong account.
      const ctx = getStripeForOrg({ stripe_account_id: sourcePayment?.stripe_account_id ?? null });
      try {
        // Slice 6/7 — return the proportional share of the service fee and tip alongside the face amount.
        const extrasRefund = proportionalRefundExtras(amount, sourcePayment);
        const amountInCents = Math.round((amount + extrasRefund) * 100);
        const stripeRefund: any = await createRefund(
          pi,
          ctx,
          amountInCents,
          {
            metadata: { source: 'in_app', invoiceId: invoice.id },
            // Task 3.2 (door 1): reverse the platform fee too, but only for a direct-charge
            // Payment — a legacy platform-account charge never had an application fee.
            ...(sourcePayment?.stripe_account_id ? { reverseApplicationFee: true } : {}),
          },
        );
        stripeRefundId = stripeRefund?.id ?? null;
      } catch (stripeErr: any) {
        logger.error('Stripe refund failed:', stripeErr);
        res.status(500).json({ error: 'Stripe refund failed. Please retry or refund manually in Stripe dashboard.' });
        return;
      }
    }
    // No PI ⇒ record-only (money returned out-of-band; capture method + reference).

    const totalRefunded = roundMoney(priorRefunded + amount);
    const newNet = roundMoney(paymentsTotal - totalRefunded);
    // Rule + the one explicit exception: docs/adr/0004-refund-never-reopens-amount-due.md
    // A refund NEVER reopens amount_due; status drops PAID→PARTIALLY_REFUNDED→REFUNDED.
    const newStatus = totalRefunded >= paymentsTotal - 0.0001 ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    const now = new Date();

    const refundRow = await prisma.$transaction(async (tx) => {
      const created = await tx.refund.create({
        data: {
          invoice_id: invoice.id,
          payment_id: payment_id ?? null,
          amount,
          tax_portion: taxPortion,
          non_taxable_concession: non_taxable_concession ?? false,
          method,
          reason,
          reason_category,
          stripe_refund_id: stripeRefundId,
          refunded_by: req.user!.id,
          organization_id: req.user!.organization_id,
        },
      });

      await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          status: newStatus,
          total_refunded: totalRefunded,
          net_collected: newNet,
          refunded_at: now,
          refunded_by: req.user!.id,
          refund_reason: reason,
          refund_reason_category: reason_category,
        },
      });

      // Keep the legacy per-payment stamp for back-compat when a single source payment is identified.
      if (sourcePayment) {
        const stampRefunded = invoice.refunds
          .filter((r) => r.payment_id === sourcePayment.id)
          .reduce((s, r) => s + Number(r.amount), 0) + amount;
        await tx.payment.update({
          where: { id: sourcePayment.id },
          data: { refunded_at: now, refunded_amount: roundMoney(stampRefunded) },
        });
      }

      await tx.timelineEvent.create({
        data: {
          organization_id: req.user!.organization_id,
          entity_type: 'INVOICE',
          entity_id: invoice.id,
          event_type: 'INVOICE_REFUNDED',
          description: `Invoice ${invoice.invoice_number} refunded $${amount.toFixed(2)} (${reason_category})`,
          metadata: { source: 'in_app', refund_id: created.id, amount, reason_category },
          created_by: req.user?.id,
        },
      });

      return created;
    });

    const customer = invoice.customer ?? invoice.job?.customer;
    if (customer?.email) {
      sendInvoiceRefundNotification({
        organizationId: req.user!.organization_id,
        to: customer.email,
        customerName: [customer.first_name, customer.last_name].filter(Boolean).join(' ') || customer.company_name || 'Customer',
        invoiceNumber: invoice.invoice_number,
        refundAmount: amount,
        record: {
          organizationId: req.user!.organization_id,
          customerId: customer.id,
          jobId: invoice.job?.id,
          jobLabel: invoice.job?.job_number,
        },
      }).catch((err) => logger.error('Invoice refund email failed:', err));
    }

    // In-app notification: billing.refunded
    await emit({
      verb: 'billing.refunded',
      organizationId: req.user!.organization_id,
      actorId: req.user?.id ?? null,
      object: { type: 'INVOICE', id: invoice.id, label: invoice.invoice_number },
      entity: { customer_owner_id: (invoice.job as any)?.estimate?.lead?.commission_owner_id ?? null },
      data: { object_label: invoice.invoice_number, amount },
    });

    void logAudit({
      req,
      action: 'invoice.refunded',
      resourceType: 'Invoice',
      resourceId: invoice.id,
      metadata: { amount },
    });
    res.json({ success: true, refund: refundRow });
  } catch (err) {
    logger.error('Error refunding invoice:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Credit (§8): lower amount_due, no money moves; unified give-back rule ───
export const creditInvoiceSchema = z.object({
  amount: z.number().positive(),
  reason: z.string().min(1).max(500),
  category: z.string().max(100).optional(),
  refund_instead: z.boolean().optional(),
  // Explicit opt-in payment reversal, the documented exception to the never-reopen rule
  // (docs/adr/0004-refund-never-reopens-amount-due.md).
  reopen_balance: z.boolean().optional(),
  method: z.nativeEnum(PaymentMethod).optional(),
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
        job: { include: { customer: true, estimate: { select: { lead: { select: { commission_owner_id: true } } } } } },
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

    const now = new Date();

    // For the cash-excess refund portion: execution keys off the source payment's PI.
    const realPayments = invoice.payments;

    // §8 universal money rule: Σ refunds ≤ net-paid. The cash give-back can only return money that
    // was actually collected — never invent funds (that would write a NEGATIVE net_collected).
    const paymentsTotal = realPayments.reduce((s, p) => s + Number(p.amount), 0);
    const priorRefunded = invoice.refunds.reduce((s, r) => s + Number(r.amount), 0);
    const netPaid = roundMoney(paymentsTotal - priorRefunded);
    if (refundPart > roundMoney(Math.max(netPaid, 0)) + 0.0001) {
      // The requested give-back exceeds balanceOwed + net-paid: the excess cannot be returned
      // because that money was never collected. Carry-forward is deferred to the §13 wallet.
      res.status(400).json({ error: 'Give-back exceeds net paid: cannot refund money that was never collected' });
      return;
    }

    const sourcePayment = realPayments.length === 1 ? realPayments[0] : (realPayments.find((p) => p.stripe_payment_intent_id) ?? null);
    const pi = refundPart > 0 ? (sourcePayment?.stripe_payment_intent_id ?? null) : null;

    let stripeRefundId: string | null = null;
    if (refundPart > 0 && pi) {
      // Transition safety (spec §5.3) — see the identical comment in refundInvoice().
      const ctx = getStripeForOrg({ stripe_account_id: sourcePayment?.stripe_account_id ?? null });
      try {
        // Slice 6/7 — return the proportional share of the service fee and tip alongside the cash give-back.
        const extrasRefund = proportionalRefundExtras(refundPart, sourcePayment);
        const stripeRefund: any = await createRefund(
          pi,
          ctx,
          Math.round((refundPart + extrasRefund) * 100),
          {
            metadata: { source: 'in_app', invoiceId: invoice.id },
            // Task 3.2 (door 1): reverse the platform fee too, but only for a direct-charge
            // Payment — a legacy platform-account charge never had an application fee.
            ...(sourcePayment?.stripe_account_id ? { reverseApplicationFee: true } : {}),
          },
        );
        stripeRefundId = stripeRefund?.id ?? null;
      } catch (stripeErr: any) {
        logger.error('Stripe refund failed (credit excess):', stripeErr);
        res.status(500).json({ error: 'Stripe refund failed. Please retry or refund manually in Stripe dashboard.' });
        return;
      }
    }

    const refundMethod = body.method ?? (sourcePayment?.method as PaymentMethod | undefined) ?? 'CARD';

    const updated = await prisma.$transaction(async (tx) => {
      if (creditPart > 0) {
        const creditTax = computeRefundTax(creditPart, invoice.tax_amount, invoice.total_amount, non_taxable_concession);
        await tx.credit.create({
          data: {
            invoice_id: invoice.id,
            amount: creditPart,
            tax_portion: creditTax,
            reason,
            category: category ?? null,
            created_by: req.user!.id,
            organization_id: req.user!.organization_id,
          },
        });

        const newDue = roundMoney(balanceOwed - creditPart);
        // Lower the bill. Keep PAID logic to payments — a credit never marks PAID; if a
        // partial balance remains, surface PARTIAL, else leave the status as-is.
        const creditStatus = newDue > 0 && newDue < Number(invoice.total_amount) ? 'PARTIAL' : invoice.status;
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
            description: `Credit of $${creditPart.toFixed(2)} applied to invoice ${invoice.invoice_number}`,
            metadata: { amount: creditPart, reason, category: category ?? null },
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
        const refundTax = computeRefundTax(refundPart, invoice.tax_amount, invoice.total_amount, non_taxable_concession);
        await tx.refund.create({
          data: {
            invoice_id: invoice.id,
            payment_id: null,
            amount: refundPart,
            tax_portion: refundTax,
            non_taxable_concession: non_taxable_concession ?? false,
            method: refundMethod,
            reason,
            reason_category: body.refund_instead ? 'CUSTOMER_REQUEST' : 'OVERPAYMENT',
            stripe_refund_id: stripeRefundId,
            refunded_by: req.user!.id,
            organization_id: req.user!.organization_id,
          },
        });

        // The give-back forced money out while a balance was still owed: mirror it with a
        // write-off Credit so the invoice still reconciles (total_amount == amount_due + net
        // cash + credits) and the statement's running balance stops disagreeing with the invoice
        // by exactly refundPart. tax_portion is 0 because the Refund row above already reverses
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

        const totalRefunded = roundMoney(priorRefunded + refundPart);
        const newNet = roundMoney(paymentsTotal - totalRefunded);
        // newDue is block-scoped inside the creditPart branch above and is always 0-path-
        // irrelevant here anyway (creditPart is 0 whenever reopenBalance is true) - name the
        // reopened value explicitly instead.
        const reopenedDue = roundMoney(balanceOwed + refundPart);
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
      }

      return tx.invoice.findUnique({ where: { id: invoice.id }, select: invoiceDetailSelect });
    });

    // In-app notification: billing.credit_applied
    await emit({
      verb: 'billing.credit_applied',
      organizationId: req.user!.organization_id,
      actorId: req.user?.id ?? null,
      object: { type: 'INVOICE', id: invoice.id, label: invoice.invoice_number },
      entity: { customer_owner_id: (invoice.job as any)?.estimate?.lead?.commission_owner_id ?? null },
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
    logger.error('Error applying credit:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Void-payment (§8): involuntary; manual methods only; reopens amount_due ───
export const voidPaymentSchema = z.object({
  payment_id: z.string().uuid(),
  void_category: z.enum(['BOUNCED', 'ERROR', 'DUPLICATE', 'WRONG_INVOICE']),
  reason: z.string().min(1).max(500),
});

export async function voidPayment(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const body = req.body as z.infer<typeof voidPaymentSchema>;
    const { payment_id, void_category, reason } = body;

    const invoice = await prisma.invoice.findUnique({
      where: { id: id as string, ...tenantWhere(req) },
      select: { id: true, status: true, amount_due: true, total_amount: true, kind: true, invoice_number: true },
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

    const now = new Date();
    const reopenAmount = Number(payment.amount);
    const newDue = roundMoney(Number(invoice.amount_due) + reopenAmount);
    const newStatus = newDue >= Number(invoice.total_amount) - 0.0001 ? 'SENT' : 'PARTIAL';

    const updated = await prisma.$transaction(async (tx) => {
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

      // CASCADE: voiding a DEPOSIT payment un-applies its drawdown. The credit money behind
      // each application was never real → every affected target STANDARD invoice's amount_due rises.
      if (invoice.kind === 'DEPOSIT') {
        const activeApps = await tx.depositCreditApplication.findMany({
          where: { deposit_invoice_id: invoice.id, reversed_at: null },
        });

        if (activeApps.length > 0) {
          await tx.depositCreditApplication.updateMany({
            where: { deposit_invoice_id: invoice.id, reversed_at: null },
            data: { reversed_at: now },
          });

          for (const app of activeApps) {
            const target = await tx.invoice.findFirst({
              where: { id: app.target_invoice_id },
              select: { id: true, amount_due: true, total_amount: true, status: true, invoice_number: true },
            });
            if (!target) continue;

            const raisedDue = roundMoney(Number(target.amount_due) + Number(app.amount));
            const targetStatus = raisedDue >= Number(target.total_amount) - 0.0001 ? 'SENT' : 'PARTIAL';
            await tx.invoice.update({
              where: { id: target.id },
              data: { amount_due: raisedDue, status: targetStatus, paid_at: null },
            });

            // Void the synthetic DEPOSIT-CREDIT Payment on the target so net math stays consistent.
            await tx.payment.updateMany({
              where: { invoice_id: target.id, reference_number: DEPOSIT_CREDIT_REFERENCE, voided_at: null },
              data: { voided_at: now, voided_reason: 'Deposit payment voided', voided_by: req.user!.id, void_category },
            });

            await tx.timelineEvent.create({
              data: {
                organization_id: req.user!.organization_id,
                entity_type: 'INVOICE',
                entity_id: target.id,
                event_type: 'DEPOSIT_CREDIT_REVERSED',
                description: `Deposit credit of $${Number(app.amount).toFixed(2)} reversed on invoice ${target.invoice_number}`,
                metadata: { deposit_invoice_id: invoice.id, amount: Number(app.amount) },
                created_by: req.user?.id,
              },
            });
          }
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
    res.json({ invoice: updated && presentInvoiceDetail(req, stripInvoiceCost(updated, req)) });
  } catch (err) {
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
 */
export async function systemVoidPaymentForChargeback(
  tx: Prisma.TransactionClient,
  args: {
    payment: { id: string; amount: number | Prisma.Decimal; method: string; stripe_payment_intent_id: string | null };
    invoice: { id: string; amount_due: number | Prisma.Decimal; total_amount: number | Prisma.Decimal; status: string; kind: string; invoice_number: string };
    disputeId: string;
    orgId: string;
  },
): Promise<void> {
  const { payment, invoice, disputeId, orgId } = args;
  const now = new Date();
  const reopenAmount = Number(payment.amount);
  const newDue = roundMoney(Number(invoice.amount_due) + reopenAmount);
  const newStatus = newDue >= Number(invoice.total_amount) - 0.0001 ? 'SENT' : 'PARTIAL';

  await tx.payment.update({
    where: { id: payment.id },
    data: {
      voided_at: now,
      voided_reason: 'Chargeback (dispute lost)',
      voided_by: null,
      void_category: 'CHARGEBACK',
    },
  });

  // Keep the dispute id on the invoice as the charged-back marker (no dedicated column; there is no
  // CHARGEBACK status enum value). The reopened status + the CHARGEBACK-voided payment + stripe_dispute_id
  // together denote "charged back".
  await tx.invoice.update({
    where: { id: invoice.id },
    data: { amount_due: newDue, status: newStatus, paid_at: null, stripe_dispute_id: disputeId },
  });

  await tx.timelineEvent.create({
    data: {
      organization_id: orgId,
      entity_type: 'INVOICE',
      entity_id: invoice.id,
      event_type: 'CHARGEBACK',
      description: `Chargeback lost — payment of $${reopenAmount.toFixed(2)} voided on invoice ${invoice.invoice_number}; balance reopened`,
      metadata: { payment_id: payment.id, stripe_dispute_id: disputeId, amount: reopenAmount },
    },
  });

  // CASCADE: a charged-back DEPOSIT payment un-applies its drawdown (mirrors voidPayment 1668-1711).
  if (invoice.kind === 'DEPOSIT') {
    const activeApps = await tx.depositCreditApplication.findMany({
      where: { deposit_invoice_id: invoice.id, reversed_at: null },
    });

    if (activeApps.length > 0) {
      await tx.depositCreditApplication.updateMany({
        where: { deposit_invoice_id: invoice.id, reversed_at: null },
        data: { reversed_at: now },
      });

      for (const app of activeApps) {
        const target = await tx.invoice.findFirst({
          where: { id: app.target_invoice_id },
          select: { id: true, amount_due: true, total_amount: true, status: true, invoice_number: true },
        });
        if (!target) continue;

        const raisedDue = roundMoney(Number(target.amount_due) + Number(app.amount));
        const targetStatus = raisedDue >= Number(target.total_amount) - 0.0001 ? 'SENT' : 'PARTIAL';
        await tx.invoice.update({
          where: { id: target.id },
          data: { amount_due: raisedDue, status: targetStatus, paid_at: null },
        });

        await tx.payment.updateMany({
          where: { invoice_id: target.id, reference_number: DEPOSIT_CREDIT_REFERENCE, voided_at: null },
          data: { voided_at: now, voided_reason: 'Deposit payment charged back', voided_by: null, void_category: 'CHARGEBACK' },
        });

        await tx.timelineEvent.create({
          data: {
            organization_id: orgId,
            entity_type: 'INVOICE',
            entity_id: target.id,
            event_type: 'DEPOSIT_CREDIT_REVERSED',
            description: `Deposit credit of $${Number(app.amount).toFixed(2)} reversed on invoice ${target.invoice_number} (chargeback)`,
            metadata: { deposit_invoice_id: invoice.id, amount: Number(app.amount) },
          },
        });
      }
    }
  }
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
    const pdfSource = presentInvoiceDetail(req, invoice);
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
    res.setHeader('Content-Disposition', `attachment; filename="invoice-${inv.invoice_number}.pdf"`);
    res.send(buffer);
  } catch (err) {
    logger.error('Public invoice PDF generation failed:', err);
    res.status(500).json({ error: 'PDF generation failed' });
  }
};
