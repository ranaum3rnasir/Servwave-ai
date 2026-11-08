/**
 * TotalsFooter — the right-aligned summary block under the line-items table.
 *
 * Renders: Total qty · Item cost (subtotal) · per-line Discount · header Discount (editable) ·
 * Tip (editable) · a sales-tax jurisdiction dropdown + computed tax amount · Invoice total.
 *
 * Money figures are SERVER-AUTHORITATIVE when an invoice exists (subtotal / tax_amount /
 * total_amount come straight from the recomputed invoice) — the footer does NOT re-derive tax,
 * which is what previously caused a fraction-vs-percent (100×) bug. Only Total qty and the
 * per-line discount sum are derived from the line rows. Tip / header-discount / tax-rate are
 * editable for Admin/Dispatcher and fire the provided callbacks on commit — gated solely on
 * `editable` (Invoice/Estimate/Job all hardcode this to `false` now that their shared
 * `<ReceiptCard>`, Card A, is the one editable money surface; see LineItemsTable.tsx's
 * `canEditBilling`).
 *
 * `showTotal` (v12 review fix B3): when a page-level `<ReceiptCard>` becomes the surface that
 * owns the running total (Job today; Estimate once it grows one), this footer's own bold bottom
 * total row would otherwise duplicate — or, worse, silently disagree with — that card's number.
 * Defaults to `true` (no behavior change for any existing caller). When `false`, the bottom
 * Total row is suppressed AND the "Item cost" row is suppressed alongside it — the two are
 * either both shown (when this footer is still the total's only home) or both hidden (when a
 * page-level card owns the total instead), so there is never a lone "Item cost" figure left
 * behind that a page-level card's own item-cost/subtotal breakdown could disagree with.
 */
import { useEffect, useState } from 'react';
import { cn, formatCurrency, formatTaxRatePercent } from '@/lib/utils';
import { FormField } from '@/components/patterns/FormField';
import { Input } from '@/components/ui/input';
import { SelectField, type SelectFieldOption } from '@/components/form/SelectField';
import { toNum } from './money';
import type { InvoiceLineItem } from '@/lib/api/jobs';
import type { StateTaxRate } from '@/lib/api/invoices';
import { matchTaxRateState } from '@/lib/tax/matchTaxRateState';
import { AddTaxRateDialog } from '@/components/tax/AddTaxRateDialog';

export interface TotalsFooterProps {
  lines: InvoiceLineItem[];
  /** Server-authoritative when hasInvoice. */
  subtotal: string | number | null;
  tax_amount: string | number | null;
  /** Tax rate as a FRACTION (e.g. 0.0663). */
  tax_rate: string | number | null;
  discount_amount: string | number | null;
  tip: string | number | null;
  total_amount: string | number | null;
  /** Jurisdiction options for the tax dropdown. */
  taxRates?: StateTaxRate[];
  /**
   * #985 - the record's service-location state, used ONLY to label the tax select when several
   * states share the stored rate. See matchTaxRateState.
   */
  taxStateCode?: string | null;
  editable?: boolean;
  hasInvoice?: boolean;
  onTipChange?: (value: number) => void;
  onDiscountChange?: (value: number) => void;
  onTaxRateChange?: (rate: number) => void;
  /** Shown as the total when there's no invoice yet (estimate basis, or a job's running subtotal). */
  estimateTotal?: number;
  /** Override the bottom total's label. Defaults to "Invoice total" / "Estimate total". */
  totalLabel?: string;
  /**
   * Show the bottom bold Total row (and, alongside it, the "Item cost" row). Defaults to `true`.
   * Set `false` when a page-level `<ReceiptCard>` already owns the running total for this
   * surface (e.g. Job's own card), so this footer never renders a second, potentially-
   * disagreeing total. See file header.
   */
  showTotal?: boolean;
  className?: string;
}

/** Fraction → trimmed percent string (0.06875 → "6.875"). */
const pctLabel = formatTaxRatePercent;

const NO_TAX = 'NONE';
const CUSTOM_RATE = 'CUSTOM';

function TotalsRow({
  label,
  value,
  muted,
}: {
  label: string;
  value: string;
  muted?: boolean;
}) {
  return (
    <div className="flex items-center justify-between py-1 text-sm">
      <span className={muted ? 'text-text-secondary' : 'text-text-primary'}>{label}</span>
      <span className={cn('tabular-nums', muted ? 'text-text-secondary' : '')}>{value}</span>
    </div>
  );
}

export function TotalsFooter({
  lines,
  subtotal,
  tax_amount,
  tax_rate,
  discount_amount,
  tip,
  total_amount,
  taxRates = [],
  taxStateCode,
  editable = false,
  hasInvoice = false,
  onTipChange,
  onDiscountChange,
  onTaxRateChange,
  estimateTotal = 0,
  totalLabel,
  showTotal = true,
  className,
}: TotalsFooterProps) {
  const totalQty = lines.reduce((s, l) => s + toNum(l.quantity), 0);
  const lineDiscounts = lines.reduce((s, l) => s + toNum(l.discount_amount), 0);

  // Subtotal: server value when we have an invoice; else net of the line rows.
  const subtotalVal = hasInvoice
    ? toNum(subtotal)
    : lines.reduce((s, l) => s + Math.max(0, toNum(l.line_total) - toNum(l.discount_amount)), 0);

  const headerDiscount = toNum(discount_amount);
  const tipVal = toNum(tip);
  const taxRateVal = toNum(tax_rate);
  const taxAmountVal = toNum(tax_amount);
  const totalVal = hasInvoice ? toNum(total_amount) : estimateTotal;

  // Editable input mirrors (committed on blur).
  const [tipInput, setTipInput] = useState(tipVal > 0 ? String(tipVal) : '');
  const [discountInput, setDiscountInput] = useState(headerDiscount > 0 ? String(headerDiscount) : '');
  useEffect(() => setTipInput(tipVal > 0 ? String(tipVal) : ''), [tipVal]);
  useEffect(() => setDiscountInput(headerDiscount > 0 ? String(headerDiscount) : ''), [headerDiscount]);

  // Reverse-map the stored rate to a state for the dropdown's selected value (mirrors the estimate).
  // #985 - shared matcher: rate match, tie-broken by the service-location state, since IL/MA/TX all
  // carry 6.25% and only the number is persisted.
  const matchedState = matchTaxRateState(taxRates, taxRateVal, taxStateCode);
  const selectValue =
    taxRateVal === 0 ? NO_TAX : matchedState ? matchedState.state_code : CUSTOM_RATE;

  const [addRateOpen, setAddRateOpen] = useState(false);

  const handleTaxChange = (v: string) => {
    if (v === NO_TAX) return onTaxRateChange?.(0);
    if (v === CUSTOM_RATE) return; // current rate has no matching state — no-op
    const state = taxRates.find((r) => r.state_code === v);
    if (state) onTaxRateChange?.(toNum(state.tax_rate));
  };

  // ADD_CUSTOM is no longer one of these: "+ Add tax rate" opens a dialog, so
  // it is the field's `action` row rather than a value the handler has to
  // recognise. CUSTOM_RATE still is - it is a real (unmatched) rate the user
  // can look at, just not re-pick.
  const taxOptions: SelectFieldOption[] = [
    { value: NO_TAX, label: 'No tax (0%)' },
    ...(selectValue === CUSTOM_RATE
      ? [{ value: CUSTOM_RATE, label: `Custom rate (${pctLabel(taxRateVal)}%)` }]
      : []),
    ...taxRates.map((r) => ({
      value: r.state_code,
      label: `${r.state_name} (${pctLabel(toNum(r.tax_rate))}%)`,
    })),
  ];

  return (
    <div className={cn('mt-3 flex justify-end border-t border-border pt-4', className)}>
      <div className="w-[340px] space-y-0.5">
        <TotalsRow label="Total qty" value={String(totalQty % 1 === 0 ? totalQty : totalQty.toFixed(2))} muted />
        {showTotal && <TotalsRow label="Item cost" value={formatCurrency(subtotalVal)} />}

        {lineDiscounts > 0 && (
          <TotalsRow label="Discount (items)" value={`-${formatCurrency(lineDiscounts)}`} muted />
        )}

        {/* Invoice-level discount */}
        {editable ? (
          <div className="flex items-center justify-between py-1 text-sm">
            <span className="text-text-secondary">Invoice discount</span>
            <div className="flex items-center gap-1">
              <span className="text-text-secondary">$</span>
              <Input
                type="number"
                min={0}
                step={0.01}
                value={discountInput}
                onChange={(e) => setDiscountInput(e.target.value)}
                onBlur={() => onDiscountChange?.(parseFloat(discountInput) || 0)}
                placeholder="0.00"
                size="xs"
                // tabular-nums has no Input size/tone prop equivalent - kept raw.
                className="w-24 text-right tabular-nums"
                aria-label="Invoice-level discount"
              />
            </div>
          </div>
        ) : (
          headerDiscount > 0 && <TotalsRow label="Invoice discount" value={`-${formatCurrency(headerDiscount)}`} muted />
        )}

        {/* Tip */}
        {editable ? (
          <div className="flex items-center justify-between py-1 text-sm">
            <span className="text-text-primary">Tip</span>
            <div className="flex items-center gap-1">
              <span className="text-text-secondary">$</span>
              <Input
                type="number"
                min={0}
                step={0.01}
                value={tipInput}
                onChange={(e) => setTipInput(e.target.value)}
                onBlur={() => onTipChange?.(parseFloat(tipInput) || 0)}
                placeholder="0.00"
                size="xs"
                // tabular-nums has no Input size/tone prop equivalent - kept raw.
                className="w-24 text-right tabular-nums"
                aria-label="Tip amount"
              />
            </div>
          </div>
        ) : (
          tipVal > 0 && <TotalsRow label="Tip" value={formatCurrency(tipVal)} />
        )}

        {/* Tax — jurisdiction dropdown (editable) + computed amount. Tax is an invoice-level
            concept (a job has no tax_rate of its own), so this whole block is skipped
            entirely pre-invoice (hasInvoice === false, e.g. the Job Items tab). */}
        {hasInvoice &&
          (editable ? (
            <div className="my-2 rounded-xl border border-border bg-background-light/40 p-3">
              {/* Select is a Radix root that renders no DOM of its own, so the id has to land
                  on the trigger button - FormField's render-prop child handles that shape. */}
              <FormField label="Sales tax — jurisdiction">
                {(fieldProps) => (
                  /* text-sm restates the base string's own default font - sm's height-only
                     rung already reproduces this byte-for-byte. */
                  <SelectField
                    {...fieldProps}
                    size="sm"
                    value={selectValue}
                    onValueChange={handleTaxChange}
                    placeholder="Select state…"
                    options={taxOptions}
                    action={{ label: '+ Add tax rate', onSelect: () => setAddRateOpen(true) }}
                  />
                )}
              </FormField>
              {/* Mounted only while open — see the same note in ReceiptCard.tsx. */}
              {addRateOpen && (
                <AddTaxRateDialog
                  open
                  onOpenChange={setAddRateOpen}
                  onCreated={(rate) => onTaxRateChange?.(rate)}
                />
              )}
              <div className="mt-2 flex items-center justify-between text-sm">
                <span className="text-text-secondary">Tax ({pctLabel(taxRateVal)}%)</span>
                <span className="font-medium tabular-nums">{formatCurrency(taxAmountVal)}</span>
              </div>
            </div>
          ) : (
            <TotalsRow label={`Tax (${pctLabel(taxRateVal)}%)`} value={formatCurrency(taxAmountVal)} muted={taxRateVal === 0} />
          ))}

        {showTotal && (
          <div className="mt-1 flex items-center justify-between border-t border-border pt-3">
            <span className="text-[15px] font-bold text-text-primary">
              {totalLabel ?? (hasInvoice ? 'Invoice total' : 'Estimate total')}
            </span>
            <span className="text-lg font-extrabold tabular-nums text-sage-700">{formatCurrency(totalVal)}</span>
          </div>
        )}
      </div>
    </div>
  );
}
