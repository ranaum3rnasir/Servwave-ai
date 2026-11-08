/**
 * Invoice money, ledger and action derivations - ONE implementation.
 *
 * These are the functions that decide what an invoice has collected, refunded,
 * credited and overpaid, and which actions a viewer may take on it. They were
 * authored inside `pages/InvoiceDetailPage.tsx`; two of them were exported and
 * the other five were not, so the /v2 invoice pages imported what they could
 * and copied the rest. Two copies of money arithmetic is exactly the failure
 * this module exists to prevent, so all of it now lives here and both
 * presentations import it.
 *
 * The row types travel with the functions: `buildLedgerEvents` takes an
 * `InvoiceDetail`, and a hand-written second copy of that shape would drift the
 * moment a field is added.
 */
import type { InvoiceKind, Refund, Credit, VoidPaymentReason } from '@/types/entities';
import type { InvoiceLineItem, Scope } from '@/lib/api/jobs';
import type { PaymentMethod } from '@/lib/api/organization';
import { PAYMENT_METHOD_LABELS } from '@/lib/payment-methods';
import type { AppAbility } from '@/lib/ability';
import { orgDayDiff } from '@/lib/schedule-tz';

// ─── Types ──────────────────────────────────────────

// The invoice's owned line shape — shared with the line-items editor so the same rows render
// here and on the Job → Items tab (carries item_type, per-line discounts and the catalog photo).
export type LineItem = InvoiceLineItem;

export interface Payment {
  id: string;
  amount: number | string;
  method: string;
  paid_at: string;
  collected_by: string | null;
  stripe_payment_intent_id: string | null;
  reference_number: string | null;
  notes: string | null;
  created_at: string;
  collector: { id: string; first_name: string; last_name: string } | null;
  // entity-redesign §8 void-payment fields (additive/optional):
  voided_at?: string | null;
  voided_reason?: string | null;
  voided_by?: string | null;
  void_category?: VoidPaymentReason | null;
  // Task 3.4 (spec §7.3) — per-payment fee breakdown; null/undefined for non-CARD payments and
  // for a CARD payment not yet reconciled by Task 3.3's post-commit capture.
  stripe_fee_amount?: number | string | null;
  platform_fee_amount?: number | string | null;
  net_amount?: number | string | null;
  // Slice 5 (card service fee) — the customer-paid fee collected alongside this payment; never
  // part of `amount` (D1). Null/undefined for non-CARD, disabled-org, or pre-feature payments.
  service_fee_amount?: number | string | null;
  // Slice 8 (customer-facing tipping) — the pay-time tip collected alongside this payment; never
  // part of `amount` (D10). Null/undefined when the customer left no tip.
  tip_amount?: number | string | null;
}

export interface InvoiceDetail {
  id: string;
  invoice_number: string;
  status: string;
  subtotal: number | string;
  discount_amount: number | string;
  tax_rate: number | string;
  tax_amount: number | string;
  // Whole-invoice tip (post-tax, untaxed) — editable on DRAFT via the line-items editor footer.
  tip?: number | string | null;
  deposit_credit: number | string;
  total_amount: number | string;
  amount_due: number | string;
  // #1997 round 3 — optional: absent, not null, when the requester cannot read the anchored
  // customer (the unauthenticated public PDF route would otherwise accept this token with no
  // read-Customer check at all). `undefined` (key absent) and `null` (genuinely never sent) are
  // two different states InvoiceDetailPage's Copy Link control must not collapse into one.
  public_token?: string | null;
  sent_at: string | null;
  // SERV10X-59 — derived server-side (getById), not persisted: true when a material edit landed
  // after the invoice was last sent/resent.
  needs_resend?: boolean;
  paid_at: string | null;
  due_date: string | null;
  voided_at: string | null;
  voided_reason: string | null;
  refunded_at: string | null;
  total_refunded: number | string | null;
  refund_reason: string | null;
  refund_reason_category: string | null;
  // entity-redesign §8 (additive/optional — Phase 8 renders these):
  kind?: InvoiceKind;
  estimate_id?: string | null;
  customer_id?: string;
  line_items?: LineItem[];
  // Batch 3: flat-priced, non-line-item scope-of-work blocks — ride along on this same detail
  // fetch (invoiceDetailSelect embeds `scopes: true`, no separate GET like the Job side needs).
  scopes?: Scope[];
  refunds?: Refund[];
  credits?: Credit[];
  // SRVW-103 - hydrated by GET /api/invoices/:id (and the list), not by mutation responses.
  tags?: { id: string; name: string; color: string }[];
  net_collected?: number | string;
  stripe_dispute_id?: string | null;
  created_at: string;
  updated_at: string;
  // R3b (2026-07-21) — cost model (D2/D8), staff-only (stripped for non-privileged viewers).
  labor_hours?: number | string | null;
  overhead_mode?: 'PERCENTAGE' | 'FIXED' | null;
  overhead_value?: number | string | null;
  // Top-level customer — backend source-of-truth for job-less (deposit/orphan) invoices.
  customer?: InvoiceCustomer;
  // Copy-to-Invoice (R5e): the ONLY way to reach the source estimate for a job-less, standalone
  // invoice (invoice.job is null for these, so invoice.job?.estimate never resolves). Shaped as a
  // superset-compatible sibling of job.estimate below (same field names, all additive/optional
  // beyond the guaranteed id/estimate_number) so both sources unify into one type at the
  // `invoice.job?.estimate ?? invoice.estimate` fallback call sites.
  estimate?: {
    id: string;
    estimate_number: string;
    tax_rate?: number | string;
    discount_amount?: number | string;
    discount_type?: string | null;
    discount_value?: number | string | null;
    discount_name?: string | null;
    line_items?: LineItem[];
    invoices?: {
      id: string;
      status: string;
      total_refunded: number | string | null;
      refunded_at: string | null;
      payments: {
        amount: number | string;
        method: string;
        paid_at: string;
        reference_number: string | null;
        stripe_fee_amount?: number | string | null;
        platform_fee_amount?: number | string | null;
        net_amount?: number | string | null;
        service_fee_amount?: number | string | null;
        // Set only when the money actually moved through Stripe - the honest signal for whether
        // this row can be attributed to Stripe (see `processorLabel`).
        stripe_payment_intent_id?: string | null;
      }[];
    }[];
    lead?: { id: string; lead_assignees: { user_id: string }[] } | null;
  } | null;
  // entity-redesign: deposit/orphan invoices carry job_id=null → job is null.
  job: {
    id: string;
    job_number: string;
    status: string;
    // Job crew (M2M). Legacy single-assignee FK dropped in TG7.
    assignees: { user_id: string }[];
    customer: InvoiceCustomer;
    service_location: {
      id: string;
      address_line1: string;
      address_line2: string | null;
      city: string;
      state: string;
      zip: string;
    };
    estimate: {
      id: string;
      estimate_number: string;
      tax_rate: number | string;
      discount_amount: number | string;
      discount_type: string | null;
      discount_value: number | string | null;
      discount_name: string | null;
      line_items: LineItem[];
      // Bug #45: the deposit's real Payment now lives on the sibling kind=DEPOSIT invoice
      // (entity-redesign dropped the estimate.deposit relation). The backend selects it via
      // estimate.invoices (filtered to kind=DEPOSIT, take 1).
      invoices?: {
        id: string;
        status: string;
        total_refunded: number | string | null;
        refunded_at: string | null;
        payments: {
          amount: number | string;
          method: string;
          paid_at: string;
          reference_number: string | null;
          // Task 3.4 (spec §7.3) — the deposit is frequently a CARD payment too.
          stripe_fee_amount?: number | string | null;
          platform_fee_amount?: number | string | null;
          net_amount?: number | string | null;
          service_fee_amount?: number | string | null;
          stripe_payment_intent_id?: string | null;
        }[];
      }[];
      lead: { id: string; lead_assignees: { user_id: string }[] } | null;
    } | null;
  } | null;
  payments: Payment[];
}

export interface InvoiceCustomer {
  id: string;
  first_name: string;
  last_name: string;
  // #1997 — a requester who cannot `read` this customer never receives these keys at all
  // (absent, not null); every reader must degrade to the name-only Prepared For column instead
  // of crashing or rendering "undefined".
  email?: string | null;
  phone?: string | null;
  payment_type?: string | null;
  tax_exempt?: boolean;
}

// ─── Helpers ────────────────────────────────────────

export function isDepositCreditPayment(payment: Payment): boolean {
  return payment.reference_number === 'DEPOSIT-CREDIT';
}

/** Round a money sum to cents so float drift never shows a wrong "collected"/Net figure. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface LedgerEvent {
  key: string;
  date: string;
  label: string;
  source: 'ESTIMATE' | 'INVOICE';
  estimateId?: string;
  estimateNumber?: string;
  method: string;
  amount: number;
  sign: '+' | '−';
  by: string;
  isRefund: boolean;
  // A give-back credit (Invoice.credits[]) - lowers amount_due with NO cash movement. Rendered as
  // its own outbound row, but it is NOT cash out, so it never counts against net CASH.
  isCredit: boolean;
  // A voided INVOICE payment (payment.voided_at set) - still listed (struck through) but excluded
  // from every money total, so voided cash is not counted as collected.
  voided: boolean;
  /**
   * Whether this row's money belongs to THIS invoice's arithmetic.
   *
   * False for the two ESTIMATE-source rows (Deposit Paid / Deposit Refunded): that money moved on
   * the sibling kind=DEPOSIT invoice, not here. The portion of it that reaches this invoice is the
   * APPLIED deposit credit, which arrives as its own synthetic `DEPOSIT-CREDIT` Payment row
   * (emitted in step 2 below, labelled "Deposit Credit Applied") carrying the capped
   * `min(remaining, invoiceTotal)` amount that `applyDepositCredit` actually drew down - NOT the
   * raw deposit payment, which can be larger.
   * Counting the raw deposit is exactly how a $500 deposit on a $300 invoice fakes a $200
   * overpayment. These rows stay VISIBLE as evidence and render muted/unsigned so the "+" rows
   * still add up to the footer.
   */
  countsInNet: boolean;
  // Slice 5 (card service fee) — the customer-paid fee collected alongside this payment; never
  // part of `amount` (D1). Undefined/null for non-CARD, disabled-org, or pre-feature payments,
  // and for the synthetic DEPOSIT-CREDIT row.
  serviceFeeAmount?: number | string | null;
  // Slice 8 (customer-facing tipping) — the pay-time tip collected alongside this payment; never
  // part of `amount` (D10). Invoices only (D11) — always undefined on the "Deposit Paid" row.
  tipAmount?: number | string | null;
}

/**
 * The money figures every surface on this page shares - ONE derivation, so the Receipt card, the
 * overpaid banner, the Payments KPI strip and the Payments-tab footer can never disagree.
 *
 * `net_collected` is deliberately NOT read: `recordPayment` only writes `amount_due`/`status`
 * (invoice.controller.ts), so it sits at 0 on ordinary paid invoices. Everything here is derived
 * from the same ledger pass the Payments tab renders.
 */
/**
 * What to show in the ledger's "By" column for a payment nobody is recorded as having collected.
 *
 * This used to render the literal string 'Stripe' for every CARD row, which was wrong twice over.
 * It named a processor the org may not even have - an org running cards on its own terminal
 * accepts EXTERNAL_CARD and has no Stripe account at all - and it put a vendor name in front of
 * users at all, which we do not do (Ran, 2026-08-04): the org and its customers see the payment
 * METHOD, never the processor we happen to route it through.
 *
 * So: a payment carrying a Stripe payment intent really was processed by us, and is labelled with
 * the CARD method regardless of what the row stores; everything else falls back to its own
 * method's label. Both come from `PAYMENT_METHOD_LABELS` - the same vocabulary Settings >
 * Payments & Lists shows - so this column can only ever name a method the org configured.
 *
 * The Stripe naming survives in the parameter, the intent check and this comment on purpose: the
 * wiring stays traceable in code even though the word never reaches the screen.
 */
export function processorLabel(method: string, stripePaymentIntentId?: string | null): string {
  const key = stripePaymentIntentId ? 'CARD' : method;
  return PAYMENT_METHOD_LABELS[key as PaymentMethod] ?? method.replace(/_/g, ' ');
}

export interface InvoiceMoneyFigures {
  /** Non-voided cash credited to THIS invoice, including the applied deposit credit. */
  collectedGross: number;
  /** Σ of this invoice's refunds (itemized rows, or the legacy aggregate when there are none). */
  refundedTotal: number;
  /** Σ of this invoice's credits[] - given back, but never cash. */
  creditedTotal: number;
  /** collectedGross − refundedTotal. Cash actually kept. */
  netCash: number;
  /**
   * netCash + creditedTotal - what has been SETTLED against the invoice, the basis for the
   * "% collected" bar. See the credit note on `deriveInvoiceMoney`.
   */
  settled: number;
  /** Surplus settled beyond the invoice total. */
  overpaidAmount: number;
}

/**
 * Derive the shared money figures from an already-built ledger.
 *
 * REFUNDS reopen the bar (they are cash going back out, and the backend deliberately never
 * reopens `amount_due` on a refund - invoice.controller.ts), which is the whole point of basing
 * the bar on this instead of `(total − amount_due)`.
 *
 * CREDITS are counted as SETTLED rather than left out. A credit lowers `amount_due` with no cash,
 * so a cash-only bar would render a fully-settled invoice ($50 credit + $950 cash on $1,000) as
 * "95% collected" at $0.00 balance due - which reads as a collections problem on an invoice that
 * owes nothing. The conservative reading wins: the bar tracks settlement, and the credit is still
 * shown explicitly on its own "Credited" row and its own footer figure, so net CASH is never
 * overstated anywhere it is reported.
 */
export function deriveInvoiceMoney(ledger: LedgerEvent[], totalAmount: number): InvoiceMoneyFigures {
  const counted = ledger.filter((e) => e.countsInNet && !e.voided);
  const collectedGross = round2(
    counted.filter((e) => !e.isRefund && !e.isCredit).reduce((s, e) => s + e.amount, 0),
  );
  const refundedTotal = round2(counted.filter((e) => e.isRefund).reduce((s, e) => s + e.amount, 0));
  const creditedTotal = round2(counted.filter((e) => e.isCredit).reduce((s, e) => s + e.amount, 0));
  const netCash = round2(collectedGross - refundedTotal);
  const settled = round2(netCash + creditedTotal);
  return {
    collectedGross,
    refundedTotal,
    creditedTotal,
    netCash,
    settled,
    overpaidAmount: round2(Math.max(settled - totalAmount, 0)),
  };
}

export function buildLedgerEvents(invoice: InvoiceDetail): LedgerEvent[] {
  const events: LedgerEvent[] = [];
  // Copy-to-Invoice (R5e): a job-less standalone invoice has no invoice.job, so its estimate is
  // only reachable via the new top-level invoice.estimate — fall back to it so a copied invoice's
  // deposit-credit row still renders instead of silently vanishing.
  const estimate = invoice.job?.estimate ?? invoice.estimate;
  // Bug #45: the deposit now lives as a sibling kind=DEPOSIT invoice; its real customer Payment
  // (method/date/amount) is the first row in its payments list.
  const depositInvoice = estimate?.invoices?.[0];
  const depositPayment = depositInvoice?.payments?.[0];

  // 1. Deposit Paid
  if (depositPayment && depositPayment.paid_at) {
    events.push({
      key: 'deposit-paid',
      date: depositPayment.paid_at,
      label: 'Deposit Paid',
      source: 'ESTIMATE',
      estimateId: estimate?.id,
      estimateNumber: estimate?.estimate_number,
      method: depositPayment.method || 'CARD',
      amount: Number(depositPayment.amount),
      sign: '+',
      by: processorLabel(depositPayment.method || 'CARD', depositPayment.stripe_payment_intent_id),
      isRefund: false,
      isCredit: false,
      voided: false,
      // Informational: the applied slice of this deposit arrives below as its own DEPOSIT-CREDIT row.
      countsInNet: false,
      serviceFeeAmount: depositPayment.service_fee_amount,
    });
  }

  // 2. Invoice payments. The synthetic DEPOSIT-CREDIT row is the APPLIED deposit drawdown
  //    (`min(remaining, invoiceTotal)`, written alongside the DepositCreditApplication ledger row)
  //    and is the only deposit money that belongs to this invoice's arithmetic, so it is now
  //    rendered and counted instead of skipped. Voided rows stay listed but are tagged so no
  //    money total counts voided cash.
  for (const p of invoice.payments) {
    const isDepositCredit = isDepositCreditPayment(p);
    events.push({
      key: p.id,
      date: p.paid_at,
      label: isDepositCredit
        ? 'Deposit Credit Applied'
        : p.method === 'CARD'
        ? 'Invoice Paid'
        : 'Manual Payment',
      source: 'INVOICE',
      method: isDepositCredit ? 'DEPOSIT_CREDIT' : p.method,
      amount: Number(p.amount),
      sign: '+',
      by: isDepositCredit
        ? '—'
        : p.collector
        ? `${p.collector.first_name} ${p.collector.last_name}`
        // Card rows name whoever actually processed them; the non-card methods keep '—' rather
        // than echoing the Method column back at the reader.
        : p.method === 'CARD' || p.method === 'EXTERNAL_CARD'
        ? processorLabel(p.method, p.stripe_payment_intent_id)
        : '—',
      isRefund: false,
      isCredit: false,
      voided: p.voided_at != null,
      countsInNet: true,
      // A synthetic credit row carries no fee of its own - the deposit invoice's real payment does.
      serviceFeeAmount: isDepositCredit ? null : p.service_fee_amount,
      tipAmount: isDepositCredit ? null : p.tip_amount,
    });
  }

  // 3. Refunds - one outbound row per first-class `refunds[]` row. These are the source of truth;
  //    a PARTIAL refund writes status PARTIALLY_REFUNDED (invoice.controller.ts), which the legacy
  //    `status === 'REFUNDED'` aggregate check below never matched, so partial refunds rendered no
  //    evidence at all.
  const refundRows = invoice.refunds ?? [];
  for (const r of refundRows) {
    events.push({
      key: `refund-${r.id}`,
      date: r.created_at ?? invoice.refunded_at ?? invoice.updated_at,
      label: 'Refund',
      source: 'INVOICE',
      method: r.method || 'CARD',
      amount: Number(r.amount),
      sign: '−',
      by: '—',
      isRefund: true,
      isCredit: false,
      voided: false,
      countsInNet: true,
    });
  }

  // 3b. Credits - one outbound give-back row per `credits[]` row, tagged as a credit so no cash
  //     figure treats it as cash.
  for (const c of invoice.credits ?? []) {
    events.push({
      key: `credit-${c.id}`,
      date: c.created_at ?? invoice.updated_at,
      label: 'Credit',
      source: 'INVOICE',
      method: 'CREDIT',
      amount: Number(c.amount),
      sign: '−',
      by: '—',
      isRefund: false,
      isCredit: true,
      voided: false,
      countsInNet: true,
    });
  }

  // 3c. Legacy aggregate refund row - ONLY when there are no itemized refunds[] rows, which would
  //     otherwise be the same money counted twice. Preserves pre-ledger refund history.
  if (refundRows.length === 0 && invoice.status === 'REFUNDED' && invoice.refunded_at && invoice.total_refunded) {
    events.push({
      key: 'invoice-refunded',
      date: invoice.refunded_at,
      label: 'Invoice Refunded',
      source: 'INVOICE',
      method: 'CARD',
      amount: Number(invoice.total_refunded),
      sign: '−',
      by: '—',
      isRefund: true,
      isCredit: false,
      voided: false,
      countsInNet: true,
    });
  }

  // 4. Deposit Refunded
  if (
    depositInvoice &&
    depositInvoice.status === 'REFUNDED' &&
    depositInvoice.refunded_at &&
    depositInvoice.total_refunded
  ) {
    events.push({
      key: 'deposit-refunded',
      date: depositInvoice.refunded_at,
      label: 'Deposit Refunded',
      source: 'ESTIMATE',
      estimateId: estimate?.id,
      estimateNumber: estimate?.estimate_number,
      method: 'CARD',
      amount: Number(depositInvoice.total_refunded),
      sign: '−',
      // A deposit refund reverses the deposit payment, so it is attributed to whatever processed
      // that payment rather than assuming Stripe.
      by: processorLabel(depositPayment?.method || 'CARD', depositPayment?.stripe_payment_intent_id),
      isRefund: true,
      isCredit: false,
      voided: false,
      // Informational, like Deposit Paid: this money left the sibling DEPOSIT invoice. Subtracting
      // it here would double-charge this invoice against a deposit of which it only ever received
      // the applied slice.
      countsInNet: false,
    });
  }

  events.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  return events;
}

export function getAvailableActions(invoice: InvoiceDetail, role: string, ability: AppAbility) {
  const isPayable = invoice.status === 'SENT' || invoice.status === 'PARTIAL';
  const isDraft = invoice.status === 'DRAFT';
  const canManage = role === 'ADMIN' || role === 'DISPATCHER';

  return {
    canSend: isDraft && canManage,
    // "Was this ever sent" must come from the invoice's own sent state (status + `sent_at`,
    // mirroring the backend's `isSentInvoice()` in `backend/src/lib/invoice-editable.ts`), not
    // from `!!invoice.public_token` — #1997 round 3 made that key entirely ABSENT (not null) on a
    // document whose anchored customer the requester cannot read, which was hiding Resend for a
    // requester who still holds `resend Invoice` on a genuinely SENT invoice. Both `status` and
    // `sent_at` are always projected and untouched by that redaction.
    canResend: isPayable && !!invoice.sent_at && canManage,
    // Sending first is not required — DRAFT invoices can take a payment too.
    // D4: record_payment is a per-user capability, never a technician role default. The old
    // `role === 'TECHNICIAN' && isOwnJob` granted by role what the toggle is supposed to gate.
    canRecordPayment: (isPayable || isDraft) && ability.can('record_payment', 'Invoice'),
    canVoid: isPayable && ability.can('void', 'Invoice'),
    canDelete: isDraft && canManage,
    canEdit: isDraft && canManage,
    // Available pre-send too — minting the link (if none exists yet) issues the invoice.
    // Same grant as send/resend; VOIDED has no payable surface.
    canCopyLink: invoice.status !== 'VOIDED' && canManage,
  };
}

/**
 * Whole CALENDAR days from today to the due date, both measured on the ORG's clock.
 * Negative = past due. `null` when the invoice has no due date at all.
 *
 * ONE derivation, because "how overdue is this?" was being answered three different ways
 * and the answers disagreed. This is the frontend half of the backend's `daysLateFor`
 * (backend/src/services/ar-aging-report.ts) — same rule, same zone, so the invoice page
 * and the AR Aging report can never quote different numbers for one invoice.
 *
 * The old arithmetic here divided the raw millisecond gap and took the ceiling, which
 * counts ELAPSED 24-HOUR PERIODS rather than days on a calendar. Any due date whose
 * time-of-day is not exactly midnight therefore lost a day: I00118 (due 02:35Z) read
 * "45 days overdue" all through its 46th day. Being a raw instant diff, it was also
 * an hour out on the two DST days a year.
 *
 * The zone is the ORG's, not the viewer's browser: aging is a fact about the business's
 * own calendar, and two staff in two zones must not see one invoice age differently
 * (the #1634 anti-pattern). It is a required argument for the same reason — a defaulted
 * timezone is exactly how the browser zone leaks back in.
 *
 * `nowIso` exists so tests can pin the reference point; production callers omit it.
 */
export function dueDayDiff(
  invoice: InvoiceDetail,
  timeZone: string,
  nowIso?: string,
): number | null {
  if (!invoice.due_date) return null;
  return orgDayDiff(invoice.due_date, timeZone, nowIso);
}

/**
 * OVERDUE is a derived pseudo-status, never persisted. Payable + the org's calendar day
 * has moved PAST the due day — an invoice due today is not late until tomorrow, which is
 * what the AR Aging report has always meant by bucketing `daysLate <= 0` as "current".
 * Comparing raw instants instead made the banner contradict its own label for the last
 * few hours of the due day ("OVERDUE - Due today past due").
 */
export function isOverdue(invoice: InvoiceDetail, timeZone: string, nowIso?: string): boolean {
  const diff = dueDayDiff(invoice, timeZone, nowIso);
  if (diff === null) return false;
  const isPayable = invoice.status === 'SENT' || invoice.status === 'PARTIAL';
  return isPayable && diff < 0;
}

export function getDueDateLabel(
  invoice: InvoiceDetail,
  timeZone: string,
  nowIso?: string,
): string {
  const diffDays = dueDayDiff(invoice, timeZone, nowIso);
  if (diffDays === null) return '';
  if (diffDays < 0) return `${Math.abs(diffDays)} day${Math.abs(diffDays) !== 1 ? 's' : ''} overdue`;
  if (diffDays === 0) return 'Due today';
  return `${diffDays} day${diffDays !== 1 ? 's' : ''} left`;
}
