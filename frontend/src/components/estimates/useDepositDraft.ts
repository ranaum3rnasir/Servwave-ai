import { useState } from 'react';
import { useOrganization } from '@/lib/api/organization';
import {
  resolveDeposit,
  amountFromPercent,
  percentFromAmount,
  round2,
  type DepositType,
  type ResolvedDeposit,
} from '@/lib/deposit';

/**
 * The deposit-editing state shared by `SendEstimateDialog` and `MarkSentDialog` (#2010) - moved
 * out of `SendEstimateDialog` verbatim, not reworked, so the mirroring/mode/dirty/validity rules
 * stay exactly what Send already shipped. See `md_files/plans/agents/runs/issue-2010/spec.md` for
 * the rulings this file bakes in; each one is called out below rather than re-derived.
 */
export interface UseDepositDraftArgs {
  open: boolean;
  totalAmount: number;
  depositType?: DepositType | null;
  depositValue?: number | string | null;
  depositFrozen?: boolean;
  existingDepositAmount?: number | null;
  existingDepositPercentage?: number | null;
  /** The dialog's own "Require deposit" toggle state - `valid` short-circuits on it. */
  depositRequired: boolean;
  /**
   * Security round 1 (#2010) finding 1 - `ability.can('update', 'Estimate')`, resolved once at
   * the `EstimateWorkspacePage` callsite and ANDed in here so a role holding `send Estimate` but
   * not `update Estimate` gets a read-only deposit in both dialogs instead of a PATCH the backend
   * 403s. Defaults `true` so callers that never pass it (every pre-existing test) are unaffected.
   */
  canEditDeposit?: boolean;
  /**
   * #2091 - true when the estimate's deposit invoice is still DRAFT/SENT with no money against
   * it (`depositInvoiceIsUnpaid`, mirroring the backend's `repriceUnpaidDepositInvoice` predicate
   * exactly). A frozen deposit whose invoice is unpaid gets RE-PRICED by the very send/mark-sent
   * this dialog is about to fire, so the frozen `existingDepositAmount` is about to go stale the
   * moment the figure differs - showing it previews one number and bills another. Defaults
   * `false`: an unknown or settled invoice keeps showing the honest, already-billed figure.
   */
  depositInvoiceUnpaid?: boolean;
}

export interface DepositPatchBody {
  deposit_type: DepositType;
  deposit_value: number;
}

export interface UseDepositDraftResult {
  percent: string;
  amount: string;
  mode: DepositType;
  amountNumber: number;
  resolved: ResolvedDeposit;
  editable: boolean;
  dirty: boolean;
  valid: boolean;
  /**
   * #2091 - a frozen deposit whose invoice will be re-priced by this very send/mark-sent. The
   * dialogs pass this straight through to `DepositControls` so its hint can say so instead of
   * claiming the figure was "set when this estimate was first sent".
   */
  willReprice: boolean;
  setPercent: (raw: string) => void;
  setAmount: (raw: string) => void;
  patchBody: DepositPatchBody;
}

export function useDepositDraft({
  open,
  totalAmount,
  depositType,
  depositValue,
  depositFrozen = false,
  existingDepositAmount,
  existingDepositPercentage,
  depositRequired,
  canEditDeposit = true,
  depositInvoiceUnpaid = false,
}: UseDepositDraftArgs): UseDepositDraftResult {
  const { data: org } = useOrganization();

  // The deposit the dialog will actually charge - the estimate's own deposit_type/deposit_value
  // override first, org defaults only as a fallback (SendEstimateDialog.tsx's original comment).
  const resolved = resolveDeposit(
    { deposit_type: depositType, deposit_value: depositValue, total_amount: totalAmount },
    org,
  );

  // The deposit is frozen at FIRST send: commitFirstSend writes send_config + the deposit invoice
  // once and a resend never revisits them. ANDed with the callsite's `update Estimate` ability
  // check (#2010 finding 1) - a send-only role gets the same read-only presentation, not a set of
  // inputs that lead to a PATCH the backend refuses.
  const editable = !depositFrozen && canEditDeposit;

  // #2091 - a frozen deposit is only TRUE while its invoice stays unpaid: the next send/mark-sent
  // re-prices exactly that invoice to whatever the current inputs resolve to
  // (repriceUnpaidDepositInvoice), so a paid-out figure would go stale the moment the total moves.
  // A settled invoice never moves, so its billed figure stays the honest one to show.
  const willReprice = depositFrozen && depositInvoiceUnpaid;

  // What the two boxes start at: the billed figure when there is one and it will hold, the
  // resolved (current-inputs) figure when it is about to be re-priced or there is nothing billed yet.
  const seedPercent = willReprice ? resolved.percent : (existingDepositPercentage ?? resolved.percent);
  const seedAmount = round2(willReprice ? resolved.amount : (existingDepositAmount ?? resolved.amount));

  const [percent, setPercentState] = useState<string>(String(seedPercent));
  const [amount, setAmountState] = useState<string>(String(seedAmount));
  // Seeded from `resolved.type`, not defaulted to 'PERCENTAGE', so a FIXED estimate override stays
  // FIXED until a box is typed in.
  const [mode, setMode] = useState<DepositType>(resolved.type);

  // Every open starts a fresh draft. The dialog stays mounted while closed, so without this a
  // cancelled edit survives a reopen. Adjusted during render rather than in an effect - the pattern
  // SendEstimateDialog.tsx's own `wasOpen` sentinel already uses - an effect would trip
  // `react-hooks/set-state-in-effect` (enforced on changed lines in CI).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setPercentState(String(seedPercent));
      setAmountState(String(seedAmount));
      setMode(resolved.type);
    }
  }

  // The % and the $ describe one deposit, so each edit mirrors into the other. Which box was
  // edited also decides how the deposit is STORED: a typed % stays a PERCENTAGE, a typed dollar
  // figure stays FIXED.
  const setPercent = (raw: string) => {
    setPercentState(raw);
    setMode('PERCENTAGE');
    const pct = parseFloat(raw);
    if (!Number.isNaN(pct)) setAmountState(String(amountFromPercent(totalAmount, pct)));
  };

  const setAmount = (raw: string) => {
    setAmountState(raw);
    setMode('FIXED');
    const amt = parseFloat(raw);
    if (!Number.isNaN(amt)) setPercentState(String(percentFromAmount(totalAmount, amt)));
  };

  const amountNumber = round2(parseFloat(amount) || 0);
  // Only write when the figure actually moved off what the estimate already resolves to - an
  // untouched dialog must not rewrite the estimate's deposit_type as a side effect of sending.
  const dirty = amountNumber !== resolved.amount;

  // The value that would actually be persisted for the current mode - used both to bound the
  // percentage box's own figure and to catch a cleared box before it round-trips as `null`.
  const persistedValue = mode === 'FIXED' ? amountNumber : parseFloat(percent);
  // Send's `depositValid` verbatim, plus one addition: `Number.isFinite(persistedValue)`. A cleared
  // percent box (`parseFloat('') === NaN`) would otherwise stay `mode: 'PERCENTAGE'` with a
  // mirrored-looking amount on screen while `JSON.stringify({ deposit_value: NaN })` serialises to
  // `null`, which the backend accepts and treats as "no override" - the screen and the bill would
  // disagree. The first two terms are unchanged: a deposit that is not required, or not editable,
  // is always valid regardless of the figures.
  const valid =
    !depositRequired ||
    !editable ||
    (amountNumber > 0 && amountNumber <= round2(totalAmount) && Number.isFinite(persistedValue));

  const patchBody: DepositPatchBody = {
    deposit_type: mode,
    deposit_value: mode === 'FIXED' ? amountNumber : parseFloat(percent),
  };

  return {
    percent,
    amount,
    mode,
    amountNumber,
    resolved,
    editable,
    dirty,
    valid,
    willReprice,
    setPercent,
    setAmount,
    patchBody,
  };
}
