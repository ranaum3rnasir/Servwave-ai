/**
 * Pure builder for the upfront `kind=PLAN` invoice minted at a plan's activation and at each renewal.
 *
 * Extracted from the controller (vs. the inlined DEPOSIT path in estimate.controller.ts) so the tax
 * math is unit-testable in isolation. Unlike a DEPOSIT — which is zero-tax because the later job
 * invoice captures tax — a PLAN has no follow-on invoice, so tax is applied like a normal invoice:
 * subtotal = Σ line items, tax = subtotal × the service location's state rate (zeroed when the
 * customer is tax-exempt), total = subtotal + tax. v1 treats every plan line item as taxable.
 *
 * The caller (controller) allocates the invoice number + public token and resolves the numeric tax
 * rate (state lookup) and tax-exempt flag, then hands them in — keeping this function deterministic.
 */

// Creator tracking (audit only) - never read for authorization here.
import { CREATED_BY_SYSTEM } from '../created-by';

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface PlanLineItemInput {
  name: string;
  quantity: number;
  unit_price: number;
}

export interface BuildPlanInvoiceArgs {
  invoiceNumber: string;
  organizationId: string;
  customerId: string;
  servicePlanId: string;
  publicToken: string;
  lineItems: PlanLineItemInput[];
  /** The service location's state tax rate as a fraction, e.g. 0.0875. */
  taxRate: number;
  /** When true, tax is zeroed regardless of taxRate. */
  taxExempt: boolean;
}

export function buildPlanInvoiceData(args: BuildPlanInvoiceArgs) {
  const lineItemCreates = args.lineItems.map((li, idx) => ({
    sequence: idx + 1,
    description: li.name,
    quantity: li.quantity,
    unit_price: li.unit_price,
    is_taxable: true,
    line_total: round2(li.quantity * li.unit_price),
  }));

  const subtotal = round2(lineItemCreates.reduce((sum, li) => sum + li.line_total, 0));
  const effectiveRate = args.taxExempt ? 0 : args.taxRate;
  const taxAmount = round2(subtotal * effectiveRate);
  const total = round2(subtotal + taxAmount);

  return {
    invoice_number: args.invoiceNumber,
    organization_id: args.organizationId,
    job_id: null as string | null,
    kind: 'PLAN' as const,
    service_plan_id: args.servicePlanId,
    customer_id: args.customerId,
    status: 'SENT' as const,
    public_token: args.publicToken,
    subtotal,
    discount_amount: 0,
    tax_rate: effectiveRate,
    tax_amount: taxAmount,
    deposit_credit: 0,
    total_amount: total,
    amount_due: total,
    line_items: { create: lineItemCreates },
    // Creator tracking (audit only). A plan invoice is materialised by the plan's own billing
    // schedule, not authored by whoever pressed Activate or Renew - the same reasoning that made
    // PR 1 stamp a plan visit job SYSTEM, and the same code will run from a scheduler with no user
    // at all. Stamped here rather than at the two call sites so they cannot drift apart.
    // -> md_files/specs/permissions/2026-08-04-technician-ownership-and-creator-tracking.md (Part A)
    ...CREATED_BY_SYSTEM,
  };
}
