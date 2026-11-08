/**
 * InvoiceReceiptCard — the Invoice detail page's thin wrapper around the shared `<ReceiptCard>`
 * (v12 unified line-items, plan §3 "FIX/CONSOLIDATE Card A"). Card B is the separate, staff-only
 * `<InternalCostsCard>` (shared with the Job Items tab).
 *
 * Replaces TWO pre-v12 blocks that duplicated this same balance-due arithmetic in two places on
 * the page: the standalone "Payment Summary" `<Card>` that sat above the tabs, and the "hybrid
 * totals" money tail rendered under `<InvoiceLineItemsEditor>` in the Line Items tab. Both are
 * gone; this card renders ONCE, inside the Line Items tab.
 *
 * Every figure is SERVER-AUTHORITATIVE (invoice.subtotal/tax_amount/total_amount/amount_due —
 * already scope-aware since Batch 1's `recomputeInvoiceTotals` folds a scope's flat_price into
 * both subtotal and the taxable base). The one exception is the "Line items"/"Scope of work"
 * breakdown rows, which this wrapper derives from `invoice.line_items`/`invoice.scopes` when the
 * caller hands them over — omit both and `<ReceiptCard>` just skips straight to "Subtotal" (e.g.
 * an older call site that only has the four money totals, no line/scope arrays).
 *
 * EDITING: this wrapper forwards `onDiscountChange`/`onTipChange`/`onTaxRateChange`/`taxRates`
 * straight through to `<ReceiptCard>`; `InvoiceDetailPage` wires all three.
 *
 * NOTE (review fix M1): deliberately does NOT pass `discountMode`/`discountRawValue` — Invoice's
 * header discount is a bare `discount_amount` dollar column with no `discount_type`/`discount_value`
 * pair in the data model (unlike Estimate's), so there is no percent mode to toggle here. This is
 * not a regression — Invoice's header discount editor has always been dollar-only. If Invoice ever
 * grows a header-level `discount_type`/`discount_value`, wire them through the same way
 * `EstimateReceiptCard` does and `<ReceiptCard>`'s toggle activates automatically.
 */
import { ReceiptCard } from '@/components/jobs/items/ReceiptCard';
import { toNum, netOf } from '@/components/jobs/items/money';
import type { InvoiceLineItem, Scope } from '@/lib/api/jobs';
import type { StateTaxRate } from '@/lib/api/invoices';

export interface InvoiceReceiptCardInvoice {
  subtotal: number | string;
  discount_amount: number | string;
  /** Sales-tax rate as a FRACTION (e.g. 0.0663 for 6.63%). */
  tax_rate: number | string;
  tax_amount: number | string;
  tip?: number | string | null;
  total_amount: number | string;
  deposit_credit: number | string;
  amount_due: number | string;
  /** Optional — when present, renders the "Line items"/"Scope of work" breakdown rows. */
  line_items?: InvoiceLineItem[];
  scopes?: Scope[];
  /**
   * #985 - the state tax_rate was derived from (`lookupStateTaxRate(job.service_location.state)`),
   * so the tax select names the right jurisdiction when several share the rate. Already on the
   * invoice detail select.
   */
  service_location?: { state?: string | null } | null;
}

export interface InvoiceReceiptCardProps {
  invoice: InvoiceReceiptCardInvoice;
  /**
   * Mirrors the page's own `isOverdue(invoice)` check — tints Balance Due + the progress track.
   * Not re-derived here; overdue-ness is a page-level business rule, not this card's job.
   */
  overdue?: boolean;

  /** Forwarded to `<ReceiptCard>` — `InvoiceDetailPage.tsx` wires all three (see file header). */
  onDiscountChange?: (value: number) => void;
  onTipChange?: (value: number) => void;
  onTaxRateChange?: (rate: number) => void;
  taxRates?: StateTaxRate[];

  /**
   * Reversal figures, all computed once by the page (`deriveInvoiceMoney`) and passed straight
   * through - this wrapper adds no money math of its own. See `<ReceiptCard>` for what each drives.
   */
  refundedTotal?: number;
  creditedTotal?: number;
  settledTotal?: number;
  overpaidAmount?: number;
}

export function InvoiceReceiptCard({
  invoice,
  overdue = false,
  onDiscountChange,
  onTipChange,
  onTaxRateChange,
  taxRates,
  refundedTotal,
  creditedTotal,
  settledTotal,
  overpaidAmount,
}: InvoiceReceiptCardProps) {
  const lineItemsSubtotal = invoice.line_items?.reduce((sum, l) => sum + netOf(l), 0);
  const scopeSubtotal = invoice.scopes
    ?.filter((s) => s.flat_price != null)
    .reduce((sum, s) => sum + toNum(s.flat_price), 0);

  return (
    <ReceiptCard
      variant="invoice"
      title="Receipt"
      lineItemsSubtotal={lineItemsSubtotal}
      scopeSubtotal={scopeSubtotal}
      subtotal={invoice.subtotal}
      discountAmount={invoice.discount_amount}
      taxRate={invoice.tax_rate}
      taxAmount={invoice.tax_amount}
      tip={invoice.tip}
      total={invoice.total_amount}
      depositCredit={invoice.deposit_credit}
      amountDue={invoice.amount_due}
      overdue={overdue}
      onDiscountChange={onDiscountChange}
      onTipChange={onTipChange}
      onTaxRateChange={onTaxRateChange}
      taxRates={taxRates}
      taxStateCode={invoice.service_location?.state ?? null}
      refundedTotal={refundedTotal}
      creditedTotal={creditedTotal}
      settledTotal={settledTotal}
      overpaidAmount={overpaidAmount}
    />
  );
}
