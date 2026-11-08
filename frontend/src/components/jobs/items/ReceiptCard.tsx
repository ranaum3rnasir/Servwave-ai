/**
 * ReceiptCard — Card A, the single shared "Totals" money card for Estimate / Job / Invoice
 * (v12 unified line-items, plan §3 "FIX/CONSOLIDATE Card A"). Card B is the separate, staff-only
 * `<InternalCostsCard>`.
 *
 * Pure presentational primitive: every figure is a prop, no fetching/mutation logic and no
 * business-math beyond the one display-only back-derivation the old `InvoiceReceiptCard` already
 * did (Taxable base = tax_amount / tax_rate when the caller doesn't hand it over pre-computed).
 * The per-surface wrapper (`InvoiceReceiptCard` today; Job/Estimate wrappers in a later wave)
 * owns fetching real data and computing the "Line items" / "Scope of work" breakdown from its own
 * raw line/scope arrays, then hands this card already-summed numbers.
 *
 * Rows (v12 §01 rail + DDR "Card A"): Line items → Scope of work → Subtotal → Discount (editable
 * ✎) → Taxable (faint) → Tax rate (select) / Tax → divider → Total (hero). Three variants layer
 * on top of that common spine:
 *   - `invoice` — adds Tip, then after Total: Deposit credit + a bold "Balance due" row (colored
 *     by paid/overdue state) + a collected-% progress bar. Label/testids preserved verbatim from
 *     the pre-v12 `InvoiceReceiptCard` (`invoice-receipt-card`, `invoice-receipt-balance-due`,
 *     "Balance due", "X% collected") — existing tests and the one page that renders this card
 *     depend on exactly these strings.
 *   - `estimate` — adds a nested sage-tinted Deposit box (deposit-due-now selector + balance-on-
 *     completion + hint) below Total. Only renders once `depositDuePercent` is actually supplied —
 *     no box, no fake selector, until the Estimate wiring wave (plan §4 Estimate, Slice 6) hands
 *     real numbers in.
 *   - `job` - no tip/deposit, but DOES carry tax + discount (job-items-estimate-parity D1/D2):
 *     both are read-only, derived from the job's linked estimate (never independently editable - 
 *     "same job, same number"). The hero row IS the bottom line, labeled "Total" like the other
 *     two (it was "Job subtotal" while the figure was an untaxed tally; D1/D2 made it a real,
 *     tax-inclusive total).
 *
 * EDITABILITY (the whole point of the v12 consolidation): every editable control here is gated on
 * the PRESENCE of its callback prop, not a boolean `editable` flag — per the project's
 * no-honest-looking-fake-control rule, a Discount/Tip/Tax-rate/Deposit-% control with nowhere to
 * send its value must not render as if it were live. Invoice wires `onDiscountChange`/
 * `onTipChange`/`onTaxRateChange`/`taxRates` in from `InvoiceDetailPage.tsx`, and Estimate wires
 * `onDiscountChange`/`onTaxRateChange`/`onDepositPercentChange`/`onDepositModeChange`/
 * `onDepositFixedValueChange` in from `EstimateReceiptCard.tsx` — both are live, editable money
 * surfaces today (review fix L3: this used to say "not yet wired"; it now is). Job's variant
 * passes tax/discount FIGURES (D1/D2 above) but none of the change handlers - pre-invoice job
 * billing has no tip/deposit concept at all, and tax/discount are derived from the job's linked
 * estimate rather than independently settable (see `JobDetailPage.tsx`'s
 * `<ReceiptCard variant="job">`) - so those rows render read-only.
 * `<LineItemsTable>`'s own `<TotalsFooter>` money-editing UI still exists underneath
 * (gated on its `editable` prop), but Invoice/Estimate/Job all hardcode `canEditBilling={false}`
 * so it never renders a second, competing set of inputs — Card A is the one editable money surface
 * on every surface that has editable money at all.
 *
 * MODE TOGGLES (review fix M1 — restores the approved DDR §3's "%/$" spec, dropped by the initial
 * v12 wiring wave): both the Discount row and the Estimate-only Deposit-due-now row can carry a
 * $/% segmented toggle, mirroring the pre-v12 `DiscountDialog`/`SetDepositDialog` modals' own
 * toggle (same two-button pattern, now inline instead of in a separate dialog). Each toggle is
 * OPTIONAL and additive — omit `discountMode`/`depositMode` (and their mode-change callbacks) to
 * keep the original single-mode editor (Invoice's header discount has no percent concept in its
 * data model — `Invoice.discount_amount` is a bare dollar column, no `discount_type`/`discount_value`
 * — so `InvoiceReceiptCard` never passes `discountMode` and keeps its plain $-only editor).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Receipt, Pencil } from 'lucide-react';
import { SectionCard } from '@/components/jobs/overview/SectionCard';
import { Input } from '@/components/ui/input';
import { SelectField, type SelectFieldOption } from '@/components/form/SelectField';
import { cn, formatCurrency, formatTaxRatePercent } from '@/lib/utils';
import { toNum } from './money';
import type { StateTaxRate } from '@/lib/api/invoices';
import { matchTaxRateState } from '@/lib/tax/matchTaxRateState';
import { AddTaxRateDialog } from '@/components/tax/AddTaxRateDialog';

export type ReceiptCardVariant = 'invoice' | 'estimate' | 'job';

export interface ReceiptCardProps {
  variant: ReceiptCardVariant;
  /** Card header title. Defaults to "Totals". */
  title?: string;
  className?: string;

  // ---- Breakdown rows — omitted (undefined) skips the row entirely. ----
  lineItemsSubtotal?: number | string | null;
  scopeSubtotal?: number | string | null;

  /**
   * #2088 — "N of M optional add-ons included", rendered as a plain secondary-text caption right
   * after the Subtotal row. Estimate-variant only (`variant === 'estimate' && !!optionalSummary`)
   * — the Job/Invoice variants stay byte-identical, since neither passes this. NOT a `<Row>`: it
   * carries no amount and is never passed through `formatCurrency`.
   */
  optionalSummary?: string | null;

  /** The combined subtotal (server-authoritative when available). */
  subtotal: number | string;

  /** Header-level discount already applied. */
  discountAmount?: number | string | null;
  /**
   * Current discount type — supplying this (alongside `onDiscountChange`) switches the Discount
   * row from the legacy plain-dollar editor to a $/% segmented toggle + raw-value input. Omit to
   * keep the legacy dollar-only editor (e.g. Invoice, whose header discount has no percent mode).
   */
  discountMode?: 'PERCENTAGE' | 'FIXED_AMOUNT';
  /**
   * The raw discount value in `discountMode`'s own unit — a percent number (e.g. `10`) when
   * PERCENTAGE, a dollar amount when FIXED_AMOUNT. Seeds the input; falls back to `discountAmount`
   * when omitted. Only read when `discountMode` is supplied.
   */
  discountRawValue?: number | string | null;

  /**
   * Tax as a FRACTION (e.g. 0.0663). Pass `undefined`/omit entirely to skip ALL tax rows. `0` is a
   * real "no tax charged" state (e.g. no linked estimate on the Job variant, or a tax-exempt
   * customer) and still renders the (muted) rows, distinct from "tax doesn't apply here at all."
   */
  taxRate?: number | string | null;
  taxAmount?: number | string | null;
  /** Back-derived as `taxAmount / taxRate` when omitted (mirrors the pre-v12 InvoiceReceiptCard). */
  taxableBase?: number | string | null;

  /** Invoice-only. */
  tip?: number | string | null;
  depositCredit?: number | string | null;
  amountDue?: number | string | null;
  /** Mirrors the page's own overdue check — tints Balance due + the progress track. */
  overdue?: boolean;

  /** The hero row's figure. */
  total: number | string;
  /** Hero row label. Defaults to "Total" on every variant (see resolvedTotalLabel). */
  totalLabel?: string;
  /** Small caption under the hero label. Defaults: estimate → "Customer pays", else none. Pass '' to omit. */
  totalCaption?: string;

  // ---- Estimate-only nested deposit box — renders only once depositDuePercent is supplied. ----
  depositDuePercent?: number | null;
  depositDueAmount?: number | string | null;
  balanceOnCompletion?: number | string | null;
  /**
   * #2031 — set when the deposit no longer reconciles with the current total, i.e. the estimate
   * was sent at one total and edited afterwards. Replaces the Balance-on-completion line, which
   * was clamped at zero and so rendered an impossible state as a plausible-looking $0.00. The
   * caller reads this from the shared deposit resolver; this card never infers it from arithmetic.
   */
  depositMismatch?: { depositAmount: number; total: number } | null;
  depositPercentOptions?: number[];
  onDepositPercentChange?: (pct: number) => void;
  /**
   * Current deposit type — supplying this (alongside `onDepositModeChange`) renders a %/$
   * segmented toggle in the deposit box, switching between the percent `<Select>` (existing) and
   * a fixed-dollar input (new). Omit to keep the legacy percent-only selector.
   */
  depositMode?: 'PERCENTAGE' | 'FIXED';
  onDepositModeChange?: (mode: 'PERCENTAGE' | 'FIXED') => void;
  /** Commits a typed fixed-dollar deposit amount — only rendered/read when `depositMode === 'FIXED'`. */
  onDepositFixedValueChange?: (amount: number) => void;

  // ---- Editing — a control is interactive iff its handler prop is provided. ----
  onDiscountChange?: (value: number, mode?: 'PERCENTAGE' | 'FIXED_AMOUNT') => void;
  onTipChange?: (value: number) => void;
  onTaxRateChange?: (rate: number) => void;
  /** Jurisdiction options for the tax-rate select — required alongside onTaxRateChange to go interactive. */
  taxRates?: StateTaxRate[];
  /**
   * Optional muted helper line under the Tax rate row - explains why the control is fixed (e.g. a
   * job-attached estimate whose tax is set by the job's service location). Omit to render nothing;
   * Job/Invoice consumers leave it undefined and are unaffected.
   */
  taxHelperText?: string;
  /**
   * #985 - the record's service-location state, used ONLY to label the tax select. Several states
   * share a rate (IL/MA/TX are all 6.25%) and only the number is persisted, so matching on rate
   * alone named whichever collided first. This is the state the backend actually derived the rate
   * from (destination-based tax). Omit and the label falls back to the first rate match.
   */
  taxStateCode?: string | null;

  // ---- Invoice-only reversal figures. IGNORED entirely on the estimate/job variants. ----
  /**
   * Money refunded on this invoice (itemized `refunds[]`, or the legacy aggregate). Renders a
   * signed "Refunded" row when > 0.
   */
  refundedTotal?: number;
  /** Non-cash give-backs (`credits[]`). Renders a signed "Credited" row when > 0. */
  creditedTotal?: number;
  /**
   * What has actually been SETTLED against the invoice - net cash kept plus credits given. When
   * supplied it, not `(total − amountDue)`, drives the progress bar and "% collected", so a refund
   * reopens the bar instead of sticking at 100% (the backend deliberately never reopens
   * `amount_due` on a refund). Omit and the bar keeps its legacy `amountDue` reading.
   */
  settledTotal?: number;
  /** Surplus settled beyond the total. Renders an "Overpaid" row when > 0. */
  overpaidAmount?: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Fraction → trimmed percent string (0.06875 → "6.875"). */
const pctLabel = formatTaxRatePercent;

const NO_TAX = 'NONE';
const CUSTOM_RATE = 'CUSTOM';

function Row({
  label,
  value,
  muted,
  bold,
  danger,
  labelExtra,
}: {
  label: string;
  value: ReactNode;
  muted?: boolean;
  bold?: boolean;
  danger?: boolean;
  labelExtra?: ReactNode;
}) {
  return (
    <div className={cn('flex items-baseline justify-between gap-3 py-1', bold && 'mt-1 border-t border-border pt-2.5')}>
      <span
        className={cn(
          'inline-flex items-center gap-1.5',
          bold ? 'text-sm font-bold text-text-primary' : muted ? 'text-xs text-text-secondary' : 'text-sm text-text-primary',
        )}
      >
        {label}
        {labelExtra}
      </span>
      <span
        className={cn(
          'tabular-nums',
          bold
            ? 'text-base font-extrabold text-text-primary'
            : muted
              ? 'text-xs text-text-secondary'
              : danger
                ? 'text-sm font-medium text-danger'
                : 'text-sm font-medium text-text-primary',
        )}
      >
        {value}
      </span>
    </div>
  );
}

/** Discount/Tip — a compact inline $ input, committed on blur. Mirrors TotalsFooter's own pattern. */
function EditableMoneyRow({
  label,
  icon,
  value,
  negative,
  onCommit,
  ariaLabel,
}: {
  label: string;
  icon?: ReactNode;
  value: number;
  negative?: boolean;
  onCommit: (n: number) => void;
  ariaLabel: string;
}) {
  const [draft, setDraft] = useState(value > 0 ? String(value) : '');
  useEffect(() => setDraft(value > 0 ? String(value) : ''), [value]);

  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <span className="inline-flex items-center gap-1.5 text-sm text-text-primary">
        {label}
        {icon}
      </span>
      <div className="flex items-center gap-1">
        <span className="text-xs text-text-secondary">{negative ? '−$' : '$'}</span>
        <Input
          type="number"
          min={0}
          step={0.01}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => onCommit(parseFloat(draft) || 0)}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          aria-label={ariaLabel}
          placeholder="0.00"
          size="xs"
          // tabular-nums has no Input size/tone prop equivalent - kept raw.
          className="w-24 text-right tabular-nums"
        />
      </div>
    </div>
  );
}

/**
 * Shared $/% (or %/$) segmented toggle — used by both the Discount row and the Estimate deposit
 * box. Mirrors the pre-v12 `DiscountDialog`/`SetDepositDialog` modals' own two-button toggle.
 */
function ModeToggleGroup<M extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  tone = 'default',
}: {
  value: M;
  options: { mode: M; label: string; ariaLabel: string }[];
  onChange: (mode: M) => void;
  ariaLabel: string;
  tone?: 'default' | 'sage';
}) {
  return (
    <div
      className={cn('inline-flex overflow-hidden rounded-md border', tone === 'sage' ? 'border-sage-200' : 'border-border')}
      role="group"
      aria-label={ariaLabel}
    >
      {options.map((opt) => (
        // Left raw: one half of a segmented $/% toggle group (role="group",
        // aria-pressed) - a two-state control, not a standalone Button.
        <button
          key={opt.mode}
          type="button"
          aria-pressed={value === opt.mode}
          aria-label={opt.ariaLabel}
          onClick={() => onChange(opt.mode)}
          className={cn(
            'font-semibold transition-colors',
            tone === 'sage' ? 'h-6 w-6 text-[11px]' : 'h-7 w-7 text-xs',
            value === opt.mode
              ? tone === 'sage'
                ? 'bg-sage-700 text-on-fill'
                : 'bg-primary text-on-fill'
              : tone === 'sage'
                ? 'bg-surface-light text-sage-700 hover:bg-sage-50'
                : 'bg-surface-light text-text-secondary hover:bg-primary-subtle',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

const DISCOUNT_MODE_OPTIONS = [
  { mode: 'FIXED_AMOUNT' as const, label: '$', ariaLabel: 'Discount as a dollar amount' },
  { mode: 'PERCENTAGE' as const, label: '%', ariaLabel: 'Discount as a percentage' },
];

const DEPOSIT_MODE_OPTIONS = [
  { mode: 'PERCENTAGE' as const, label: '%', ariaLabel: 'Deposit as a percentage' },
  { mode: 'FIXED' as const, label: '$', ariaLabel: 'Deposit as a dollar amount' },
];

/**
 * Discount row with a $/% mode toggle (review fix M1) — replaces `EditableMoneyRow` for the
 * Discount row whenever the caller supplies `discountMode`. Toggling the mode re-commits the
 * currently-typed draft under the new unit (no auto-conversion), matching the old
 * `DiscountDialog`'s own toggle-then-Save behavior, just inlined instead of in a modal.
 */
function EditableDiscountRow({
  mode,
  rawValue,
  onCommit,
}: {
  mode: 'PERCENTAGE' | 'FIXED_AMOUNT';
  rawValue: number;
  onCommit: (value: number, mode: 'PERCENTAGE' | 'FIXED_AMOUNT') => void;
}) {
  const [m, setM] = useState(mode);
  const [draft, setDraft] = useState(rawValue > 0 ? String(rawValue) : '');
  useEffect(() => {
    setM(mode);
    setDraft(rawValue > 0 ? String(rawValue) : '');
  }, [mode, rawValue]);

  const commit = (nextMode: 'PERCENTAGE' | 'FIXED_AMOUNT' = m) => {
    setM(nextMode);
    onCommit(parseFloat(draft) || 0, nextMode);
  };

  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <span className="inline-flex items-center gap-1.5 text-sm text-text-primary">
        Discount
        <Pencil className="h-3 w-3 text-text-secondary/70" aria-hidden />
      </span>
      <div className="flex items-center gap-1.5">
        <ModeToggleGroup value={m} ariaLabel="Discount type" onChange={(next) => commit(next)} options={DISCOUNT_MODE_OPTIONS} />
        <Input
          type="number"
          min={0}
          step={0.01}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commit()}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          aria-label="Discount value"
          placeholder="0"
          size="xs"
          // tabular-nums has no Input size/tone prop equivalent - kept raw.
          className="w-20 text-right tabular-nums"
        />
      </div>
    </div>
  );
}

/** Fixed-dollar deposit input (review fix M1) — the FIXED-mode counterpart of the percent `<Select>`. */
function DepositFixedInput({ value, onCommit }: { value: number; onCommit: (n: number) => void }) {
  const [draft, setDraft] = useState(value > 0 ? String(value) : '');
  useEffect(() => setDraft(value > 0 ? String(value) : ''), [value]);

  return (
    <span className="inline-flex items-center gap-0.5">
      <span className="text-[11px] text-sage-700">$</span>
      <Input
        type="number"
        min={0}
        step={0.01}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => onCommit(parseFloat(draft) || 0)}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        aria-label="Deposit amount"
        placeholder="0.00"
        tone="sage"
        // Deferred: Input's only font-forcing rung (`xs`) emits text-sm, not text-xs - no
        // prop reproduces this h-6/text-xs combo. tabular-nums has no prop equivalent either.
        className="h-6 w-20 text-xs tabular-nums"
      />
    </span>
  );
}

export function ReceiptCard({
  variant,
  title = 'Totals',
  className,
  lineItemsSubtotal,
  scopeSubtotal,
  optionalSummary,
  subtotal,
  discountAmount,
  discountMode,
  discountRawValue,
  taxRate,
  taxAmount,
  taxableBase,
  tip,
  depositCredit,
  amountDue,
  overdue = false,
  total,
  totalLabel,
  totalCaption,
  depositDuePercent,
  depositDueAmount,
  balanceOnCompletion,
  depositMismatch,
  depositPercentOptions = [],
  onDepositPercentChange,
  depositMode,
  onDepositModeChange,
  onDepositFixedValueChange,
  onDiscountChange,
  onTipChange,
  onTaxRateChange,
  taxRates = [],
  taxHelperText,
  taxStateCode,
  refundedTotal = 0,
  creditedTotal = 0,
  settledTotal,
  overpaidAmount = 0,
}: ReceiptCardProps) {
  const subtotalVal = toNum(subtotal);
  const discountVal = toNum(discountAmount);
  const discountRawVal = discountRawValue != null ? toNum(discountRawValue) : discountVal;
  const totalVal = toNum(total);

  const hasTax = taxRate != null;
  const taxRateVal = toNum(taxRate);
  const taxAmountVal = toNum(taxAmount);
  const taxableBaseVal = taxableBase != null ? toNum(taxableBase) : taxRateVal > 0 ? round2(taxAmountVal / taxRateVal) : 0;

  const tipVal = toNum(tip);
  const depositCreditVal = toNum(depositCredit);
  const amountDueVal = toNum(amountDue);

  const hasBreakdown = lineItemsSubtotal != null || scopeSubtotal != null;
  // Breakdown parity across Estimate / Job / Invoice: a surface that HANDS US a discount figure
  // gets the row, even at $0 - otherwise a $0-discount Job renders one fewer row than the very
  // estimate it derives from, and the three surfaces stop lining up. Estimate/Invoice were always
  // unconditional here (both wire onDiscountChange); this is what brings the read-only Job variant
  // into line. Omit `discountAmount` entirely and the row is still skipped.
  const showDiscountRow = discountAmount != null || discountVal > 0 || !!onDiscountChange;
  const showTipRow = variant === 'invoice' && (tipVal > 0 || !!onTipChange);

  // Normalize once. The jurisdiction list is an AUXILIARY lookup on every surface that shows one
  // (a separate query from the money itself), so a non-array response - an error envelope, a 500
  // body, a cache miss - must degrade to "no jurisdiction names" rather than throwing out of
  // render and white-screening the whole money card next to it.
  const taxRateOptions = Array.isArray(taxRates) ? taxRates : [];

  const taxInteractive = !!onTaxRateChange && taxRateOptions.length > 0;
  const [addRateOpen, setAddRateOpen] = useState(false);
  // #985 - shared matcher: rate match, tie-broken by the service-location state. Was a bare
  // rate-only find(), which labelled an Austin TX job "Illinois (6.25%)".
  const matchedState = matchTaxRateState(taxRateOptions, taxRateVal, taxStateCode);
  const taxSelectValue = taxRateVal === 0 ? NO_TAX : matchedState ? matchedState.state_code : CUSTOM_RATE;
  const handleTaxChange = (v: string) => {
    if (v === NO_TAX) return onTaxRateChange?.(0);
    if (v === CUSTOM_RATE) return; // current rate has no matching jurisdiction — no-op
    const state = taxRateOptions.find((r) => r.state_code === v);
    if (state) onTaxRateChange?.(toNum(state.tax_rate));
  };

  // "+ Add tax rate" is NOT one of these: it opens <AddTaxRateDialog> rather
  // than naming a rate, so it is the field's pinned `action` row instead of a
  // sentinel the change handler has to recognise.
  const taxOptions: SelectFieldOption[] = [
    { value: NO_TAX, label: 'No tax (0%)' },
    ...(taxSelectValue === CUSTOM_RATE
      ? [{ value: CUSTOM_RATE, label: `Custom rate (${pctLabel(taxRateVal)}%)` }]
      : []),
    ...taxRateOptions.map((r) => ({
      value: r.state_code,
      label: `${r.state_name} (${pctLabel(toNum(r.tax_rate))}%)`,
    })),
  ];

  const depositPercentSelectOptions: SelectFieldOption[] = depositPercentOptions.map((pct) => ({
    value: String(pct),
    label: `${pct}%`,
  }));

  // "Total" on every variant. The Job variant used to default to "Job subtotal", which was
  // accurate while its hero was an untaxed running tally - but job-items-estimate-parity D1/D2
  // made that figure tax-inclusive and discount-applied, so "subtotal" now names a total. Same
  // label on all three surfaces is also the point: the customer-facing bottom line reads the same
  // on the estimate, the job's Items tab, and the invoice.
  const resolvedTotalLabel = totalLabel ?? 'Total';
  const resolvedTotalCaption = totalCaption ?? (variant === 'estimate' ? 'Customer pays' : undefined);

  const showDepositBox = variant === 'estimate' && depositDuePercent != null;
  const depositInteractive = !!onDepositPercentChange && depositPercentOptions.length > 0;
  const effectiveDepositMode: 'PERCENTAGE' | 'FIXED' = depositMode ?? 'PERCENTAGE';
  const depositModeToggleActive = !!onDepositModeChange;
  const depositFixedInteractive = !!onDepositFixedValueChange;

  // Invoice-only reversal rows. Every one of these is inert on the estimate/job variants - both the
  // flags and the bar basis below are gated on `variant === 'invoice'`, so those two surfaces render
  // exactly as they did before these props existed.
  const isInvoice = variant === 'invoice';
  const showRefundedRow = isInvoice && refundedTotal > 0;
  const showCreditedRow = isInvoice && creditedTotal > 0;
  const showOverpaidRow = isInvoice && overpaidAmount > 0;

  // Prefer the caller's settled figure (net cash + credits) over the legacy `(total − amountDue)`
  // reading, which cannot see a refund at all: the backend never reopens `amount_due` on one, so a
  // $1,000 invoice refunded $300 would still read "100% collected" at $0.00 balance due. Clamped
  // into [0, 100] - net cash can go negative, and an overpayment can exceed the total.
  const collectedBasis = settledTotal ?? totalVal - amountDueVal;
  const progressPct =
    isInvoice && totalVal > 0 ? Math.min(Math.max((collectedBasis / totalVal) * 100, 0), 100) : 0;

  return (
    <div data-testid={variant === 'invoice' ? 'invoice-receipt-card' : undefined}>
      <SectionCard title={title} icon={<Receipt className="h-4 w-4 text-text-secondary" />} className={className}>
        <div className="flex flex-col">
          {lineItemsSubtotal != null && (
            <Row label="Line items" value={formatCurrency(toNum(lineItemsSubtotal))} />
          )}
          {scopeSubtotal != null && <Row label="Scope of work" value={formatCurrency(toNum(scopeSubtotal))} />}
          <Row label="Subtotal" value={formatCurrency(subtotalVal)} bold={hasBreakdown} />
          {/* #2088 AC7 — a plain caption, never a <Row>: it carries no amount and must never pass
              through formatCurrency. Estimate-variant only; Job/Invoice never pass this prop. */}
          {variant === 'estimate' && !!optionalSummary && (
            <p className="-mt-0.5 text-xs text-text-secondary">{optionalSummary}</p>
          )}

          {showDiscountRow &&
            (onDiscountChange && discountMode ? (
              <EditableDiscountRow mode={discountMode} rawValue={discountRawVal} onCommit={onDiscountChange} />
            ) : onDiscountChange ? (
              <EditableMoneyRow
                label="Discount"
                icon={<Pencil className="h-3 w-3 text-text-secondary/70" aria-hidden />}
                value={discountVal}
                negative
                onCommit={onDiscountChange}
                ariaLabel="Discount amount"
              />
            ) : (
              <Row label="Discount" value={`-${formatCurrency(discountVal)}`} danger />
            ))}

          {hasTax && taxRateVal > 0 && <Row label="Taxable" value={formatCurrency(taxableBaseVal)} muted />}

          {hasTax && (
            <Row
              label="Tax rate"
              value={
                taxInteractive ? (
                  <SelectField
                    value={taxSelectValue}
                    onValueChange={handleTaxChange}
                    size="xs"
                    // h-7 has no matching rung (select.tsx's own header note: h-7 stays a
                    // raw override, not a 5th rung); className wins the height conflict over
                    // `xs`'s own h-8, so only `xs`'s text-xs is actually consumed here.
                    className="h-7 w-auto min-w-[110px]"
                    aria-label="Tax jurisdiction"
                    placeholder="Select…"
                    options={taxOptions}
                    action={{ label: '+ Add tax rate', onSelect: () => setAddRateOpen(true) }}
                  />
                ) : matchedState ? (
                  // Read-only, but still NAME the jurisdiction - the interactive select shows
                  // "New Jersey (6.625%)", so a bare "6.625%" here would make the same tax read
                  // differently depending on whether the surface happens to be editable. Several
                  // states share a rate (IL/MA/TX are all 6.25%), so the number alone is genuinely
                  // ambiguous about what is being charged. Falls back to the bare percent when the
                  // caller passes no `taxRates` to match against.
                  `${matchedState.state_name} (${pctLabel(taxRateVal)}%)`
                ) : (
                  `${pctLabel(taxRateVal)}%`
                )
              }
            />
          )}
          {hasTax && taxHelperText && (
            <p className="-mt-0.5 text-xs text-text-secondary">{taxHelperText}</p>
          )}
          {hasTax && <Row label="Tax" value={formatCurrency(taxAmountVal)} muted={taxRateVal === 0} />}

          {showTipRow &&
            (onTipChange ? (
              <EditableMoneyRow label="Tip" value={tipVal} onCommit={onTipChange} ariaLabel="Tip amount" />
            ) : (
              <Row label="Tip" value={formatCurrency(tipVal)} />
            ))}

          <div className="mt-2.5 flex items-end justify-between gap-3 rounded-card bg-primary-subtle px-3 py-2.5">
            <span className="text-sm font-bold text-text-primary">
              {resolvedTotalLabel}
              {resolvedTotalCaption && (
                <small className="mt-0.5 block text-[10.5px] font-semibold uppercase tracking-wide text-text-secondary">
                  {resolvedTotalCaption}
                </small>
              )}
            </span>
            <span className="text-[27px] font-extrabold leading-none tracking-tight tabular-nums text-primary">
              {formatCurrency(totalVal)}
            </span>
          </div>

          {variant === 'invoice' && (
            <>
              {depositCreditVal > 0 && (
                <Row label="Deposit credit" value={`-${formatCurrency(depositCreditVal)}`} muted />
              )}
              <div className="mt-1 flex items-center justify-between border-t border-border pt-2.5">
                <span className="text-sm font-bold text-text-primary">Balance due</span>
                <span
                  data-testid="invoice-receipt-balance-due"
                  className={cn(
                    'text-base font-extrabold tabular-nums',
                    overdue ? 'text-danger' : amountDueVal === 0 ? 'text-sage-700' : 'text-text-primary',
                  )}
                >
                  {formatCurrency(amountDueVal)}
                </span>
              </div>

              {/* Reversals - money that left after collection, or surplus taken in. Without these
                  a refund or credit leaves no trace on the receipt at all. */}
              {showRefundedRow && <Row label="Refunded" value={`-${formatCurrency(refundedTotal)}`} danger />}
              {showCreditedRow && <Row label="Credited" value={`-${formatCurrency(creditedTotal)}`} danger />}
              {showOverpaidRow && (
                <div className="mt-1 flex items-baseline justify-between gap-3 rounded-card bg-warning-surface px-2 py-1">
                  <span className="text-sm font-medium text-warning-text">Overpaid</span>
                  <span className="text-sm font-semibold tabular-nums text-warning-text">
                    +{formatCurrency(overpaidAmount)}
                  </span>
                </div>
              )}

              <div className="mt-3">
                <div className="h-2.5 w-full overflow-hidden rounded-full bg-background-light">
                  <div
                    className={cn(
                      'h-full rounded-full transition-all',
                      progressPct === 0 ? 'bg-border' : progressPct >= 100 ? 'bg-sage-700' : 'bg-info',
                    )}
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
                <p className="mt-1 text-right text-xs tabular-nums text-text-secondary">
                  {progressPct.toFixed(0)}% collected
                </p>
              </div>
            </>
          )}

          {showDepositBox && (
            <div className="mt-2.5 rounded-card border border-sage-200 bg-sage-50 p-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="inline-flex items-center gap-1.5 text-xs font-bold text-sage-700">
                  Deposit due now
                  {depositModeToggleActive && (
                    <ModeToggleGroup
                      value={effectiveDepositMode}
                      ariaLabel="Deposit type"
                      tone="sage"
                      onChange={(next) => onDepositModeChange?.(next)}
                      options={DEPOSIT_MODE_OPTIONS}
                    />
                  )}
                  {effectiveDepositMode === 'FIXED' ? (
                    depositFixedInteractive ? (
                      <DepositFixedInput value={toNum(depositDueAmount)} onCommit={(n) => onDepositFixedValueChange?.(n)} />
                    ) : (
                      <span className="font-semibold">{formatCurrency(toNum(depositDueAmount))}</span>
                    )
                  ) : depositInteractive ? (
                    <SelectField
                      value={String(depositDuePercent)}
                      onValueChange={(v) => onDepositPercentChange?.(Number(v))}
                      tone="sage"
                      size="xs"
                      // h-6 has no matching rung; className wins the height conflict over
                      // `xs`'s own h-8 (same reasoning as the Tax jurisdiction trigger above),
                      // so only `xs`'s text-xs is actually consumed here.
                      className="h-6 w-auto min-w-[64px]"
                      options={depositPercentSelectOptions}
                    />
                  ) : (
                    <span className="font-semibold">{depositDuePercent}%</span>
                  )}
                </span>
                <span className="text-lg font-extrabold tabular-nums text-sage-700">
                  {formatCurrency(toNum(depositDueAmount))}
                </span>
              </div>
              {depositMismatch ? (
                <p role="status" className="mt-1 text-xs font-medium text-warning-text">
                  {depositMismatch.depositAmount > depositMismatch.total
                    ? `This deposit of ${formatCurrency(depositMismatch.depositAmount)} is more than the ${formatCurrency(depositMismatch.total)} total.`
                    : `This deposit of ${formatCurrency(depositMismatch.depositAmount)} was set against a different total; the estimate now totals ${formatCurrency(depositMismatch.total)}.`}
                </p>
              ) : (
                <div className="mt-1 flex justify-between text-xs text-text-secondary">
                  <span>Balance on completion</span>
                  <span className="tabular-nums">{formatCurrency(toNum(balanceOnCompletion))}</span>
                </div>
              )}
              {(depositInteractive || depositFixedInteractive) && (
                <p className="mt-1 text-[10.5px] text-sage-700/80">Change the % or amount — the balance updates.</p>
              )}
            </div>
          )}
        </div>
      </SectionCard>

      {/* Mounted only while open — this card is rendered in plenty of read-only places, and the
          dialog's react-query hooks have no business running there. */}
      {addRateOpen && (
        <AddTaxRateDialog
          open
          onOpenChange={setAddRateOpen}
          onCreated={(rate) => onTaxRateChange?.(rate)}
        />
      )}
    </div>
  );
}
