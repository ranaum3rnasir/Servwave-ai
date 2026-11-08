/**
 * PaymentFeeBreakdown — Task 3.4 (spec §7.3), the per-payment fee display for ServWave Payments.
 *
 * Shown next to a CARD payment's amount on the invoice payments ledger (InvoiceDetailPage) and
 * the job PaymentsTab: ONE combined fee figure (Stripe processing + ServWave's platform fee),
 * with a click-to-open drill-in revealing the itemized split — Gross / Stripe fee / ServWave
 * fee / Net (§7.3: "Stripe writes the app-fee as its own BalanceTransaction line (unhideable),
 * so the split is always honest").
 *
 * Renders NOTHING when any of the three reconciliation columns is null/undefined — a cash/check/
 * manual payment never has them, and a CARD payment renders nothing until Task 3.3's post-commit
 * capture (webhook + nightly sweep) has landed. There is no partial/garbled state: the three
 * columns are always written together (reconcile-stripe-fees.ts), so checking all three is
 * simply defensive, not a sign a fourth state exists.
 *
 * TWO BASES (2026-08-04). `amount` is the invoice FACE value: the card service fee and the
 * customer's tip are deliberately never folded into Payment.amount or invoice totals (D1/D10 of
 * the card-service-fee plan). `net_amount`, by contrast, is derived by reconcile-stripe-fees.ts
 * from Stripe's `charge.amount` — the FULL amount charged to the card, face + fee + tip — since
 * that is what Stripe's cut came out of. So on any fee- or tip-bearing payment this column would
 * otherwise show a Net LARGER than the Gross it was subtracted from. The two additive rows below
 * are the missing terms, and with them the column is arithmetic the org can follow top to bottom.
 */
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn, formatCurrency } from '@/lib/utils';
import { toNum } from '@/components/jobs/items/money';

export interface PaymentFeeBreakdownProps {
  /** Payment.amount — the invoice FACE amount, NOT the total charged to the card. */
  amount: number | string;
  /** Payment.stripe_fee_amount — null/undefined for non-CARD or not-yet-reconciled payments. */
  stripeFeeAmount: number | string | null | undefined;
  /** Payment.platform_fee_amount — ServWave's cut (§7.3, launch default 0.5%; the displayed
   * rate % is DERIVED from this ÷ amount, not hardcoded — see formatFeeRatePct below). */
  platformFeeAmount: number | string | null | undefined;
  /** Payment.net_amount — the cash that landed, measured against face + service fee + tip
   * (see the two-bases note above), so it can legitimately exceed `amount`. */
  netAmount: number | string | null | undefined;
  /** Payment.service_fee_amount — the card fee the CUSTOMER paid on top of the face amount.
   * Absent/null on every non-card and pre-feature payment; its row is then omitted. */
  serviceFeeAmount?: number | string | null;
  /** Payment.tip_amount — the customer's pay-time tip, also on top of the face amount and
   * kept in full by the org. Absent/null when no tip was given. */
  tipAmount?: number | string | null;
}

function FeeRow({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={cn('flex items-center justify-between gap-3 py-0.5 text-xs', bold && 'border-t border-border pt-1.5 mt-1')}>
      <span className={cn('text-text-secondary', bold && 'font-bold text-text-primary')}>{label}</span>
      <span className={cn('tabular-nums text-text-secondary', bold && 'font-bold text-text-primary')}>{value}</span>
    </div>
  );
}

/**
 * Derives the display percentage from THIS payment's actual dollars (platformFee / gross)
 * rather than a hardcoded literal or the org's CURRENT platform_fee_bps — the org's rate can
 * change over time (a support-only tool exists precisely for this), so a historical payment's
 * label must reflect the rate it actually paid, not today's config. Basis points are always a
 * whole number of hundredths of a percent, so rounding to 2dp exactly reproduces the configured
 * rate (e.g. 50 bps → "0.5%", 125 bps → "1.25%"). Returns null (rate-agnostic label) when gross
 * is 0/invalid, so the caller never renders "NaN%"/"Infinity%".
 */
function formatFeeRatePct(platformFee: number, gross: number): string | null {
  if (!(gross > 0)) return null;
  const pct = Math.round((platformFee / gross) * 10000) / 100;
  return Number.isFinite(pct) ? `${pct}%` : null;
}

export function PaymentFeeBreakdown({
  amount,
  stripeFeeAmount,
  platformFeeAmount,
  netAmount,
  serviceFeeAmount,
  tipAmount,
}: PaymentFeeBreakdownProps) {
  // Defensive: cash/check/legacy payments and not-yet-reconciled CARD payments carry no fee
  // data at all. Never show a partial/garbled breakdown — nothing renders until all three exist.
  if (stripeFeeAmount == null || platformFeeAmount == null || netAmount == null) return null;

  const gross = toNum(amount);
  const stripeFee = toNum(stripeFeeAmount);
  const platformFee = toNum(platformFeeAmount);
  const net = toNum(netAmount);
  const combinedFee = stripeFee + platformFee;
  // A real 0 means the customer was charged nothing extra, so there is no term to itemize —
  // same display outcome as null, unlike the three cost columns above where 0 is meaningful
  // data (an org on platform_fee_bps=0) that must still render.
  const serviceFee = serviceFeeAmount != null ? toNum(serviceFeeAmount) : 0;
  const tip = tipAmount != null ? toNum(tipAmount) : 0;
  // The platform fee is only a percentage of `amount` on the legacy path. Once a service fee is
  // present it is derived as `serviceFee − estimatedStripeFee` (D2) and is not a rate on
  // anything, so dividing it by the face amount would print a percentage the org was never
  // charged. Show the bare label instead of a fabricated number.
  const feeRatePct = serviceFee > 0 ? null : formatFeeRatePct(platformFee, gross);
  const platformFeeLabel = feeRatePct ? `ServWave platform fee — ${feeRatePct}` : 'ServWave platform fee';

  return (
    <Popover>
      <PopoverTrigger asChild>
        {/* Dotted-underline link-styled text trigger: 11px font has no Button size rung, and no
            link/neutral or link/subtle cell is minted (only link/brand exists, which would
            recolour the idle text). No matching cell - left raw. */}
        <button
          type="button"
          className="inline-flex items-center font-normal text-[11px] text-text-secondary underline decoration-dotted underline-offset-2 transition-colors hover:text-text-primary"
        >
          Fee {formatCurrency(combinedFee)}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64">
        <div className="flex flex-col">
          <FeeRow label="Gross" value={formatCurrency(gross)} />
          {/* Additive, and explicitly signed: these are the customer's money arriving on top of
              the face amount, not deductions. Sits above the two cost rows so the column reads
              in the order the money moved — charged, then taken out, then what landed. */}
          {serviceFee > 0 && (
            <FeeRow label="Service fee (customer)" value={`+${formatCurrency(serviceFee)}`} />
          )}
          {tip > 0 && <FeeRow label="Tip (customer)" value={`+${formatCurrency(tip)}`} />}
          <FeeRow label="Stripe fee" value={formatCurrency(-stripeFee)} />
          <FeeRow label={platformFeeLabel} value={formatCurrency(-platformFee)} />
          <FeeRow label="Net" value={formatCurrency(net)} bold />
        </div>
      </PopoverContent>
    </Popover>
  );
}
