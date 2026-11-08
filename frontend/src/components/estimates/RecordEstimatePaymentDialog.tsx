import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import { useOrganization } from '@/lib/api/organization';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { FormField } from '@/components/patterns/FormField';
import { SelectField } from '@/components/form/SelectField';
import { DatePicker } from '@/components/form/DatePicker';
import { Loader2, DollarSign } from 'lucide-react';
import { formatCurrency, extractApiError } from '@/lib/utils';
import { instantFromLocalDay, todayLocalDay } from '@/lib/format-date';
import { PAYMENT_METHOD_LABELS, PAYMENT_METHOD_ORDER } from '@/lib/payment-methods';
import {
  resolveDeposit,
  amountFromPercent,
  percentFromAmount,
  round2,
  type DepositType,
} from '@/lib/deposit';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  estimateId: string;
  estimateNumber: string;
  totalAmount: number;
  // The estimate's own deposit override (Receipt Card). Feeds resolveDeposit, which prefers it over
  // the org defaults - the same precedence the backend applies when it derives the percentage.
  depositType?: DepositType | null;
  depositValue?: number | string | null;
  // If a deposit row already exists (SENT/PENDING flow), pre-fill amount + %.
  existingDepositAmount?: number | null;
  existingDepositPercentage?: number | null;
}


export function RecordEstimatePaymentDialog({
  open,
  onOpenChange,
  estimateId,
  estimateNumber,
  totalAmount,
  depositType,
  depositValue,
  existingDepositAmount,
  existingDepositPercentage,
}: Props) {
  const queryClient = useQueryClient();
  const { data: org } = useOrganization();

  // #61/B8: the estimate's own deposit_type/deposit_value override wins over the org defaults -
  // shared with the backend's resolveDepositAmount through lib/deposit's mirror, so the figure
  // offered here is the one a send would actually charge.
  const resolved = resolveDeposit(
    { deposit_type: depositType, deposit_value: depositValue, total_amount: totalAmount },
    org,
  );

  // A frozen send_config (the deposit actually billed) outranks any recomputation.
  const defaultPct = existingDepositPercentage ?? resolved.percent;
  const defaultAmount = round2(existingDepositAmount ?? amountFromPercent(totalAmount, defaultPct));

  const today = todayLocalDay();

  const [percentage, setPercentage] = useState<string>(String(defaultPct));
  const [amount, setAmount] = useState<string>(String(defaultAmount));
  const [method, setMethod] = useState<string>('EXTERNAL_CARD');
  const [paidAt, setPaidAt] = useState<string>(today);
  const [referenceNumber, setReferenceNumber] = useState<string>('');
  const [notes, setNotes] = useState<string>('');

  // When the modal opens, re-sync defaults (so re-opening after a partial fill restores org
  // defaults rather than stale state), and re-seed if the resolved deposit itself changes while
  // open (the org query landing after mount).
  //
  // Adjusted during render rather than in an effect - React's documented way to reset state when a
  // prop changes, and what `react-hooks/set-state-in-effect` (enforced on changed lines in CI)
  // requires. Same pattern as SendEstimateDialog's `wasOpen` sentinel. The key covers the seed
  // values too, so this keeps the exact re-sync behaviour the effect had.
  const seedKey = `${open}|${defaultPct}|${defaultAmount}`;
  const [lastSeed, setLastSeed] = useState(seedKey);
  if (seedKey !== lastSeed) {
    setLastSeed(seedKey);
    if (open) {
      setPercentage(String(defaultPct));
      setAmount(String(defaultAmount));
      setMethod('EXTERNAL_CARD');
      setPaidAt(today);
      setReferenceNumber('');
      setNotes('');
    }
  }

  // The two fields describe ONE deposit and are posted together (`amount` is the charge,
  // `deposit_percentage` is what that charge gets recorded as), so every edit mirrors into the
  // other. The previous one-way `amountTouched` latch let them drift apart permanently: touch the
  // amount once and the % never followed again, so the request described a deposit nobody entered.
  // Raw strings stay in state so a cleared box stays cleared (rather than snapping back to a
  // number mid-edit); the mirror only fires on a parseable value and never rewrites the field
  // being edited, so an empty or half-typed entry leaves its partner untouched instead of NaN.
  const handlePercentageChange = (raw: string) => {
    setPercentage(raw);
    const pct = parseFloat(raw);
    if (!Number.isNaN(pct)) setAmount(String(amountFromPercent(totalAmount, pct)));
  };

  const handleAmountChange = (raw: string) => {
    setAmount(raw);
    const amt = parseFloat(raw);
    if (!Number.isNaN(amt)) setPercentage(String(percentFromAmount(totalAmount, amt)));
  };

  const mutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        amount: round2(parseFloat(amount)),
        payment_method: method,
        // `new Date(paidAt)` on a date-only value lands on UTC midnight, which is the
        // previous evening in every US timezone - the day-early bug on the payments
        // surfaces. paid_at is an instant, so the picked day gets a time of day first.
        paid_at: instantFromLocalDay(paidAt),
      };
      // `deposit_percentage` is `.positive().max(100)` server-side, so a 0 (zero-total estimate) or
      // an over-100 amount must be omitted rather than posted into a 400 - it is descriptive only,
      // and the backend re-derives it from the estimate when absent.
      const pctNum = parseFloat(percentage);
      if (!Number.isNaN(pctNum) && pctNum > 0 && pctNum <= 100) body.deposit_percentage = pctNum;
      if (referenceNumber.trim()) body.reference_number = referenceNumber.trim();
      if (notes.trim()) body.notes = notes.trim();

      const { data } = await api.post(`/api/estimates/${estimateId}/record-payment`, body);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['estimate', estimateId] });
      queryClient.invalidateQueries({ queryKey: ['estimates'] });
      onOpenChange(false);
    },
  });

  const amountValid = !Number.isNaN(parseFloat(amount)) && parseFloat(amount) > 0;
  const canSubmit = amountValid && Boolean(method) && Boolean(paidAt);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Record Payment — {estimateNumber}</DialogTitle>
          <DialogDescription>
            Recording a payment that covers the full deposit will approve the estimate and move the lead to Won.
            A partial payment is recorded against the deposit balance.
            No email is sent to the customer.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FormField label="Deposit %" htmlFor="rp-pct">
              <Input
                type="number"
                min={1}
                max={100}
                step="0.5"
                value={percentage}
                onChange={(e) => handlePercentageChange(e.target.value)}
              />
            </FormField>
            <FormField
              label="Deposit amount *"
              htmlFor="rp-amount"
              hint={`Total estimate: ${formatCurrency(totalAmount)}`}
            >
              <Input
                type="number"
                min={0.01}
                step="0.01"
                value={amount}
                onChange={(e) => handleAmountChange(e.target.value)}
              />
            </FormField>
          </div>

          {/* Not a FormField: SelectField's props are a closed list (value /
              onValueChange / options / placeholder / disabled / className /
              aria-label) with no id or aria-* passthrough, so the id FormField
              generates would be dropped on the floor and the label would point
              at nothing. Wiring it needs a change to SelectField, not to this
              call site. Same for RefundDepositDialog's Reason category. */}
          <div>
            <Label id="rp-method-label">Payment method *</Label>
            <SelectField
              aria-label="Payment method"
              value={method}
              onValueChange={setMethod}
              className="w-full h-9"
              options={PAYMENT_METHOD_ORDER.map((m) => ({ value: m, label: PAYMENT_METHOD_LABELS[m] }))}
            />
          </div>

          <FormField label="Date received *" htmlFor="rp-date">
            <DatePicker value={paidAt} onChange={setPaidAt} />
          </FormField>

          <FormField label="Reference number" htmlFor="rp-ref">
            <Input
              type="text"
              value={referenceNumber}
              onChange={(e) => setReferenceNumber(e.target.value)}
              placeholder="Check #, transaction ID, etc."
            />
          </FormField>

          <FormField label="Notes" htmlFor="rp-notes">
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Optional notes…"
            />
          </FormField>

          {mutation.error && (
            <p className="text-sm text-danger">
              {extractApiError(mutation.error, 'Failed to record payment')}
            </p>
          )}

          <div className="flex justify-end gap-3 border-t pt-4">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={() => mutation.mutate()} disabled={!canSubmit || mutation.isPending}>
              {mutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <DollarSign className="mr-2 h-4 w-4" />
              )}
              {mutation.isPending ? 'Recording…' : 'Record Payment'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
