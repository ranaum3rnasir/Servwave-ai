import { Input } from '@/components/ui/input';
import { FormField } from '@/components/patterns/FormField';
import { formatCurrency } from '@/lib/utils';

/**
 * The "Deposit %" / "Deposit amount" pair, presentational only (#2010) - moved verbatim out of
 * `SendEstimateDialog` so `SendEstimateDialog` and `MarkSentDialog` render the identical JSX
 * instead of drifting. No data fetching, no mutation: the caller supplies the draft (via
 * `useDepositDraft`) and reacts to the two change handlers.
 */
export interface DepositControlsProps {
  /** 'send' -> send-deposit-pct/-amount; 'mark-sent' -> mark-sent-deposit-pct/-amount. */
  idPrefix: string;
  /** Raw input string, never a number - a cleared box must stay cleared. */
  percent: string;
  /** Raw input string. */
  amount: string;
  totalAmount: number;
  /** false => both inputs disabled. Paired with `frozen` for which hint (if any) shows. */
  editable: boolean;
  /**
   * true => the deposit was billed at first send and cannot move; shows "Set when this estimate
   * was first sent" (or, when `willReprice` is also true, the honest "about to change" hint
   * instead - see that prop). When `editable` is false and `frozen` is false, the inputs are
   * still disabled (e.g. the viewer lacks `update Estimate`, #2010 finding 1) but that hint would
   * be false - the estimate was never sent - so no hint renders at all.
   */
  frozen?: boolean;
  /**
   * #2091 - true when `frozen` AND the deposit invoice behind it is still unpaid, so the send
   * this dialog is about to fire will RE-PRICE that invoice to `amount`/`percent` (already
   * recomputed by the caller - see `useDepositDraft`'s `willReprice`). Swaps the frozen hint for
   * "Updates to match the current total when sent" so the rep is never shown a figure the send
   * itself is about to change out from under them.
   */
  willReprice?: boolean;
  /** false => the inline "Enter a deposit between..." message. */
  valid: boolean;
  onPercentChange: (raw: string) => void;
  onAmountChange: (raw: string) => void;
}

export function DepositControls({
  idPrefix,
  percent,
  amount,
  totalAmount,
  editable,
  frozen = false,
  willReprice = false,
  valid,
  onPercentChange,
  onAmountChange,
}: DepositControlsProps) {
  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormField label="Deposit %" htmlFor={`${idPrefix}-deposit-pct`}>
          <Input
            id={`${idPrefix}-deposit-pct`}
            type="number"
            min={0}
            max={100}
            step="0.5"
            value={percent}
            disabled={!editable}
            onChange={(e) => onPercentChange(e.target.value)}
          />
        </FormField>
        <FormField
          label="Deposit amount"
          htmlFor={`${idPrefix}-deposit-amount`}
          hint={
            editable
              ? `Total estimate: ${formatCurrency(totalAmount)}`
              : frozen
                ? willReprice
                  ? 'Updates to match the current total when sent'
                  : 'Set when this estimate was first sent'
                : undefined
          }
        >
          <Input
            id={`${idPrefix}-deposit-amount`}
            type="number"
            min={0}
            step="0.01"
            value={amount}
            disabled={!editable}
            onChange={(e) => onAmountChange(e.target.value)}
          />
        </FormField>
      </div>

      {editable && !valid && (
        <p className="text-sm text-danger">
          Enter a deposit between {formatCurrency(0.01)} and {formatCurrency(totalAmount)}.
        </p>
      )}
    </>
  );
}
