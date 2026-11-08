/**
 * EstimateReceiptCard — the Estimate workspace's thin wrapper around the shared `<ReceiptCard>`
 * (v12 unified line-items, plan §3 "FIX/CONSOLIDATE Card A" + §4 Estimate). Card B is the
 * separate, staff-only `<InternalCostsCard>` (shared with Job/Invoice), rendered as its own
 * sibling by the page — mirrors `InvoiceReceiptCard.tsx`'s split exactly.
 *
 * Replaces the "Totals" third of the old three-way `InfoPanel.tsx` split. Every headline figure
 * is SERVER-AUTHORITATIVE (estimate.subtotal/tax_amount/total_amount/discount_amount — the
 * granular line/scope endpoints already recompute + persist these, per `lib/api/estimates.ts`'s
 * own header comment), so this wrapper does NOT re-derive totals client-side the way the old
 * `InfoPanel`'s `computeTotals()` did. The one exception is the "Line items"/"Scope of work"
 * breakdown rows, derived from `estimate.line_items`/`estimate.scopes` — mirrors
 * `InvoiceReceiptCard.tsx`'s identical `netOf`-based derivation.
 *
 * DEPOSIT (the Estimate-only extension `<ReceiptCard variant="estimate">` was built for): mirrors
 * the old `InfoPanel`'s pre-send/post-send split —
 *   - Pre-send: `deposit_type`/`deposit_value` are a live, editable override — including the
 *     %/$ mode toggle (review fix M1/B8), matching the old `SetDepositDialog`'s percent/fixed-
 *     amount toggle and the Ran-approved DDR §3 ("Deposit due now — editable %/$"). Toggling the
 *     mode re-commits the currently-displayed number under the new unit (no auto-conversion),
 *     same behavior the old dialog had.
 *   - Post-send: the real charged numbers are frozen in `send_config.deposit_amount`/
 *     `deposit_percentage` — display-only from there on (§G), matching the old card's identical
 *     `depositSent` gate.
 * Backend note (B8): `send()`/`recordEstimatePayment()` still need to read the estimate's own
 * `deposit_type`/`deposit_value` (PRD §13.7) instead of org defaults — this wrapper's job is only
 * to genuinely PERSIST the chosen type/value so that backend rewire has real data to read; it does
 * not itself change what gets charged.
 *
 * DISCOUNT: `<ReceiptCard>`'s Discount row also carries the %/$ mode toggle (review fix M1),
 * matching the old `DiscountDialog`'s percent-vs-amount toggle and the DDR's "Discount (editable
 * ✎)" spec — discount edits from this card persist as either `PERCENTAGE` or `FIXED_AMOUNT`
 * (`estimate.discount_type`), not hardcoded to one. TAX RATE reuses `<ReceiptCard>`'s own built-in
 * jurisdiction `<Select>` (identical UI/behavior to the old `InfoPanel`'s tax-rate dropdown).
 * All three call the SAME whole-document `updateEstimate()` PATCH the old card used — discount/tax/
 * deposit are Estimate-row fields, not line/scope rows, so they were never part of the granular
 * line-items migration (that only replaced `line_items`/`scopes` editing).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ReceiptCard } from '@/components/jobs/items/ReceiptCard';
import { toNum, netOf, countsTowardTotals } from '@/components/jobs/items/money';
import { resolveDepositState, round2 } from '@/lib/deposit';
import { useOrganization } from '@/lib/api/organization';
import { fetchStateTaxRates } from '@/lib/api/invoices';
import { updateEstimate, type EstimateLineItem, type Scope } from '@/lib/api/estimates';
import { toast } from '@/components/ui/use-toast';
import { useConfirm } from '@/hooks/useConfirm';
import {
  materialEditPrompt,
  needsMaterialEditConfirm,
  rememberMaterialEditConfirmed,
} from '@/features/estimate-workspace/lib/materialEditConfirm';
import { extractApiError } from '@/lib/utils';

export interface EstimateReceiptCardEstimate {
  id: string;
  /** Attach FK - when set, this estimate is attached to a job and tax is fixed by the job's service location (read-only). */
  job_id?: string | null;
  subtotal: number | string | null | undefined;
  discount_amount?: number | string | null;
  /** Discount mode — drives the Discount row's $/% toggle (review fix M1). Null/undefined → FIXED_AMOUNT (existing default). */
  discount_type?: 'PERCENTAGE' | 'FIXED_AMOUNT' | null;
  /** Raw discount value in discount_type's own unit (percent number or dollar amount). */
  discount_value?: number | string | null;
  discount_name?: string | null;
  /** #2030 — the send state the material-edit confirmation reads. */
  status?: string;
  version?: number;
  signature_data?: string | null;
  /** Sales-tax rate as a FRACTION (e.g. 0.0663 for 6.63%). */
  tax_rate: number | string | null | undefined;
  tax_amount: number | string | null | undefined;
  total_amount?: number | string | null;
  deposit_type?: 'PERCENTAGE' | 'FIXED' | null;
  deposit_value?: number | string | null;
  send_config?: {
    deposit_percentage?: number | string | null;
    deposit_amount?: number | string | null;
  } | null;
  line_items?: EstimateLineItem[];
  scopes?: Scope[];
  /**
   * #985 - the state the backend derived tax_rate from, so the tax select can name the right
   * jurisdiction when several share the rate. Mirrors `deriveTaxRateFromLead`'s own precedence:
   * the direct service location first, then the lead's denormalized service_state.
   * Both are already on estimateDetailSelect - no API change needed.
   */
  service_location?: { state?: string | null } | null;
  lead?: { service_state?: string | null } | null;
}

export interface EstimateReceiptCardProps {
  estimate: EstimateReceiptCardEstimate;
  /** §A1/A3 lock policy from the page (locked/terminal/not-yet-editable) — same gate the old InfoPanel's `canEdit` used. */
  canEditNow: boolean;
}

/** Quick-select presets for the deposit box — always includes whatever the estimate is actually set to, so the <Select> never shows a value with no matching option. */
const DEPOSIT_PRESETS = [0, 10, 20, 25, 33, 50, 75, 100];

export function EstimateReceiptCard({ estimate, canEditNow }: EstimateReceiptCardProps) {
  const queryClient = useQueryClient();

  const { data: taxRates = [] } = useQuery({
    queryKey: ['state-tax-rates'],
    queryFn: fetchStateTaxRates,
  });

  // The org's deposit defaults — the fallback half of the resolver's precedence rule. Without
  // them the card cannot answer for an estimate that carries no override of its own.
  const { data: org } = useOrganization();

  const { confirm, confirmDialog } = useConfirm();

  /**
   * #2030 slice 5 — the first material edit after a send says what it will do: the customer's
   * link stops working, and a pending signature is voided. The server has always applied both;
   * this makes them visible. Once per version — the next send resets it.
   *
   * Commit-on-blur is untouched and no Save button appears: this asks AFTER the field has
   * committed its intent and BEFORE the PATCH goes out, so the interaction is the same one jobs
   * and invoices use.
   */
  async function confirmMaterialEdit(): Promise<boolean> {
    const status = estimate.status ?? 'DRAFT';
    const version = estimate.version ?? 0;
    if (!needsMaterialEditConfirm(status, estimate.id, version)) return true;

    const prompt = materialEditPrompt(Boolean(estimate.signature_data));
    if (!(await confirm({ ...prompt, tone: 'danger' }))) return false;

    rememberMaterialEditConfirmed(estimate.id, version);
    return true;
  }

  /** Ask first; a decline leaves the estimate exactly as it was. */
  async function saveMaterial(body: Record<string, unknown>) {
    if (await confirmMaterialEdit()) saveMutation.mutate(body);
  }

  const saveMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) => updateEstimate(estimate.id, body),
    onSuccess: (res) => {
      // SRVW-103 - merge, never replace: the response has no `tags` key (see
      // EstimateLineItemsEditor's docblock for the full contract).
      if (res?.estimate) {
        queryClient.setQueryData<Record<string, unknown>>(['estimate', estimate.id], (old) => ({
          ...(old ?? {}),
          ...(res.estimate as Record<string, unknown>),
        }));
      }
    },
    onError: (err: unknown) =>
      toast({ title: 'Could not save', description: extractApiError(err, 'Your change was not saved.'), variant: 'destructive' }),
  });

  // #2053 slice 1 — an optional-unselected line/scope is excluded from the breakdown too, so it
  // always sums to the bold Subtotal (AC12) rather than double-counting a line the server itself
  // already excluded from `estimate.subtotal`.
  const lineItemsSubtotal = estimate.line_items?.filter(countsTowardTotals).reduce((sum, l) => sum + netOf(l), 0);
  const scopeSubtotal = estimate.scopes
    ?.filter((s) => s.flat_price != null && countsTowardTotals(s))
    .reduce((sum, s) => sum + toNum(s.flat_price), 0);

  // #2088 AC7 — "N of M optional add-ons included". M counts optional SCOPE BLOCKS too, not only
  // lines (R8) — a table-row count alone undercounts a fixture that mixes both. No currency figure
  // is computed here or passed down.
  const optionalLines = estimate.line_items?.filter((l) => l.is_optional) ?? [];
  const optionalScopes = estimate.scopes?.filter((s) => s.is_optional) ?? [];
  const optionalTotal = optionalLines.length + optionalScopes.length;
  const optionalIncluded = [...optionalLines, ...optionalScopes].filter((x) => x.is_selected !== false).length;
  const optionalSummary =
    optionalTotal > 0 ? `${optionalIncluded} of ${optionalTotal} optional add-ons included` : undefined;

  // Discount — %/$ mode toggle (review fix M1). Null/undefined discount_type defaults to
  // FIXED_AMOUNT, matching the pre-fix hardcoded behavior for estimates that never set one.
  const discountMode: 'PERCENTAGE' | 'FIXED_AMOUNT' = estimate.discount_type === 'PERCENTAGE' ? 'PERCENTAGE' : 'FIXED_AMOUNT';
  // discount_value is the raw number in discountMode's own unit; fall back to the computed
  // discount_amount for estimates saved before discount_value existed.
  const discountRawValue = estimate.discount_value != null ? toNum(estimate.discount_value) : toNum(estimate.discount_amount);

  // Deposit — #2031: one resolver answers this for every surface (the card, the send dialog, the
  // public page, the record-payment dialog). The card used to decide for itself, and got two
  // things wrong: pre-send it read the estimate's own override ONLY, so an estimate with no
  // override showed 0% while the send dialog previewed and the server charged the org default;
  // post-send it read the frozen send_config unconditionally, so a deposit went on presenting
  // itself as simply due at the old amount however far the total had since moved.
  //
  // Held, not silently recalculated (Ran's decision): once sent, `deposit.amount` IS the figure
  // the customer was presented. `deposit.matchesTotal` is what says it no longer reconciles.
  // total_amount is optional on this card's own estimate shape but required (nullable) by the
  // resolver, which wants a caller that forgot it to be a type error rather than a silent zero.
  const deposit = resolveDepositState({ ...estimate, total_amount: estimate.total_amount ?? null }, org ?? null);
  const totalNum = toNum(estimate.total_amount);
  const preSendRawValue = toNum(estimate.deposit_value);

  const depositPct = Math.round(deposit.percent);
  const depositDueAmount = deposit.amount;
  // NOT clamped at zero — #2031 slice 3. A deposit larger than the total is an impossible state,
  // and clamping rendered it as a plausible-looking $0.00 balance that hid the mismatch from the
  // one person able to fix it. The mismatch itself comes from the resolver, never from comparing
  // these two numbers here: a FIXED deposit is still valid when the total merely grows.
  const balanceOnCompletion = round2(totalNum - depositDueAmount);
  const depositMismatch = deposit.matchesTotal
    ? null
    : { depositAmount: depositDueAmount, total: totalNum };
  const depositPercentOptions = DEPOSIT_PRESETS.includes(depositPct)
    ? DEPOSIT_PRESETS
    : [...DEPOSIT_PRESETS, depositPct].sort((a, b) => a - b);

  // Deposit editing is only available pre-send — once sent, the charged amount is frozen (§G),
  // ANDed with the page's own lock/terminal policy. Frozen figures always display percent-style,
  // matching send_config's own shape (deposit_percentage/deposit_amount, no mode flag).
  const depositEditable = canEditNow && deposit.editable;
  const displayDepositMode: 'PERCENTAGE' | 'FIXED' = deposit.issued ? 'PERCENTAGE' : deposit.type;

  // E3 (job-owns-tax-discount) retired the job-anchored tax lock: a job-anchored estimate is a
  // quote, the job is the work, and they may legitimately differ. One flag for BOTH tax props
  // below: `taxRates` without `onTaxRateChange` renders an inert jurisdiction select, so the two
  // must never drift apart.
  const taxEditable = canEditNow;

  return (
    <>
      {confirmDialog}
      <ReceiptCard
      variant="estimate"
      lineItemsSubtotal={lineItemsSubtotal}
      scopeSubtotal={scopeSubtotal}
      optionalSummary={optionalSummary}
      subtotal={toNum(estimate.subtotal)}
      discountAmount={estimate.discount_amount}
      discountMode={discountMode}
      discountRawValue={discountRawValue}
      taxRate={estimate.tax_rate}
      taxAmount={estimate.tax_amount}
      total={toNum(estimate.total_amount)}
      depositDuePercent={depositPct}
      depositDueAmount={depositDueAmount}
      balanceOnCompletion={balanceOnCompletion}
      depositMismatch={depositMismatch}
      depositPercentOptions={depositPercentOptions}
      depositMode={displayDepositMode}
      onDepositPercentChange={
        depositEditable ? (pct) => void saveMaterial({ deposit_type: 'PERCENTAGE', deposit_value: pct }) : undefined
      }
      onDepositModeChange={
        depositEditable
          ? (mode) => void saveMaterial({ deposit_type: mode, deposit_value: preSendRawValue })
          : undefined
      }
      onDepositFixedValueChange={
        depositEditable ? (amount) => void saveMaterial({ deposit_type: 'FIXED', deposit_value: amount }) : undefined
      }
      onDiscountChange={
        canEditNow
          ? (amount, mode) =>
              void saveMaterial({
                discount_type: mode ?? 'FIXED_AMOUNT',
                discount_value: amount,
                discount_name: estimate.discount_name || 'Discount',
              })
          : undefined
      }
      onTaxRateChange={taxEditable ? (rate) => void saveMaterial({ tax_rate: rate }) : undefined}
      taxRates={taxEditable ? taxRates : undefined}
      taxStateCode={estimate.service_location?.state ?? estimate.lead?.service_state ?? null}
      />
    </>
  );
}
