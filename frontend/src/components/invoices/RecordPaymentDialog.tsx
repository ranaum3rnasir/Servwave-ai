import { useScheduleTimezone, pickerValueToIso, isoToPickerValue } from '@/lib/schedule-tz';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import { createJobInvoice } from '@/lib/api/jobs';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { SelectField } from '@/components/form/SelectField';
import { DateTimePicker } from '@/components/form/DateTimePicker';
import { FormField } from '@/components/patterns/FormField';
import { extractApiError, formatCurrency } from '@/lib/utils';
import { PAYMENT_METHOD_LABELS, PAYMENT_METHOD_ORDER } from '@/lib/payment-methods';
import { TIP_PRESET_PCT } from '@/lib/tips';
import { AlertTriangle, Loader2 } from 'lucide-react';

interface RecordPaymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null ⇒ the job has no invoice; the dialog creates and sends one first. */
  invoiceId: string | null;
  invoiceNumber: string;
  amountDue: number;
  onSuccess: () => void;
  /** Required when invoiceId is null. */
  jobId?: string;
  /** True when the customer holds a paid deposit — withholds the composite path. */
  hasUnspentDeposit?: boolean;
}

export function RecordPaymentDialog({
  open,
  onOpenChange,
  invoiceId,
  invoiceNumber,
  amountDue,
  onSuccess,
  jobId,
  hasUnspentDeposit,
}: RecordPaymentDialogProps) {
  const queryClient = useQueryClient();
  const timezone = useScheduleTimezone();
  const defaultPaidAt = isoToPickerValue(new Date().toISOString(), timezone);
  const [amount, setAmount] = useState(amountDue);
  const [method, setMethod] = useState('CASH');
  const [paidAt, setPaidAt] = useState(defaultPaidAt);
  // `useScheduleTimezone()` answers the Eastern default until GET /api/organization lands, and
  // this dialog is mounted by its host page rather than on open (see the tip note below), so it
  // seeds at the earliest moment the org query can still be in flight. The seed above is then
  // submitted back through the RESOLVED zone, booking a Denver org's payment two hours late with
  // nobody having typed anything. Re-derive it when the zone itself changes - the same guard
  // `pages/v2/leads/components/walkthroughTab.tsx` carries, adjusted during render rather than in
  // an effect per the precedent directly below.
  //
  // What was SEEDED is tracked, not just the zone, so a date the user picked inside the loading
  // window is not thrown away; and it is tracked in state rather than compared against
  // `defaultPaidAt`, which is recomputed from the clock on every render and so changes on its own
  // every minute.
  const [seededPaidAt, setSeededPaidAt] = useState(defaultPaidAt);
  const [paidAtTz, setPaidAtTz] = useState(timezone);
  if (timezone !== paidAtTz) {
    setPaidAtTz(timezone);
    setSeededPaidAt(defaultPaidAt);
    if (paidAt === seededPaidAt) setPaidAt(defaultPaidAt);
  }
  const [referenceNumber, setReferenceNumber] = useState('');
  const [notes, setNotes] = useState('');
  // SRVW-55 — chips + custom, mirroring PublicInvoicePage. D1: shown for every payment method,
  // unconditionally. Percentage base is the typed Amount, not amountDue - on the composite path
  // (no invoice yet) amountDue is always 0, so a percentage of it would always be $0.00.
  const [tipSelection, setTipSelection] = useState('');
  const [tipOtherValue, setTipOtherValue] = useState('');
  // The dialog stays mounted while closed, so without this a tip picked then abandoned via
  // Cancel survives to the next open (same stale-compose-across-reopen bug class as
  // SendEstimateDialog, #1062) - a tip left armed from a previous payment is worse than a stale
  // recipient. Adjusted during render, not in an effect, per that fix's precedent.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setTipSelection('');
      setTipOtherValue('');
    }
  }
  // Overpayment is a real, backend-supported state (recordPayment clamps amount_due at 0 and flags
  // OVERPAYMENT_FLAGGED on the timeline). Capping the input would refuse a true statement about
  // money that changed hands - but it must not be a silent slip either, so the surplus has to be
  // acknowledged explicitly before submit unlocks.
  const [overpayAcknowledged, setOverpayAcknowledged] = useState(false);

  const resetForm = () => {
    setAmount(amountDue);
    setMethod('CASH');
    setPaidAt(defaultPaidAt);
    // Keeps "what was seeded" honest, so a zone landing after a reset is still read as untouched.
    setSeededPaidAt(defaultPaidAt);
    setReferenceNumber('');
    setNotes('');
    setOverpayAcknowledged(false);
    setTipSelection('');
    setTipOtherValue('');
  };

  const isNoInvoice = invoiceId === null;

  const tipDollars = tipSelection === 'other'
    ? Math.max(0, parseFloat(tipOtherValue) || 0)
    : tipSelection
      ? Math.round(amount * (Number(tipSelection) / 100) * 100) / 100
      : 0;

  const overpayment = Math.round((amount - amountDue) * 100) / 100;
  // The gate applies ONLY when an invoice with a real balance exists. On the composite
  // (invoiceId === null) path the invoice is CREATED for exactly the typed amount, so `amountDue`
  // is always 0 and an overpayment is impossible by construction - gating there would make every
  // on-site urgent-workflow collection demand an acknowledgement of a nonsensical "more than the
  // $0.00 balance due".
  const isOverpay = !isNoInvoice && Number.isFinite(amount) && overpayment > 0;

  const mutation = useMutation({
    mutationFn: async () => {
      const { data } = await api.post(`/api/invoices/${invoiceId}/payments`, {
        amount,
        method,
        paid_at: pickerValueToIso(paidAt, timezone),
        reference_number: referenceNumber || undefined,
        notes: notes || undefined,
        tip_amount: tipDollars > 0 ? tipDollars : undefined,
      });
      return data;
    },
    onSuccess: () => {
      onSuccess();
      onOpenChange(false);
      resetForm();
    },
  });

  // The no-invoice path: create a one-line invoice, send it, then pay it. NOT atomic — each
  // step's failure is handled on its own terms rather than surfacing one generic error.
  const composite = useMutation({
    mutationFn: async (input: { amount: number; method: string; description: string; tipAmount: number }) => {
      // Step 1 — create. If this fails, nothing happened.
      const { invoice } = await createJobInvoice(jobId!, {
        amount: input.amount,
        description: input.description || 'Payment collected on site',
      });
      const number = String((invoice as { invoice_number?: unknown }).invoice_number ?? '');
      // Step 2 — send. Keeps sent_at non-null so the Invoice Sent node reads true and the Task 6
      // selector lands in State 1 rather than offering to create another invoice.
      try {
        await api.post(`/api/invoices/${invoice.id}/send`, {});
      } catch {
        // A missing customer email must not strand a payment already collected. Carry on and pay.
      }
      // Step 3 — pay. recordPayment permits DRAFT, so this works even if the send failed.
      try {
        await api.post(`/api/invoices/${invoice.id}/payments`, {
          amount: input.amount,
          method: input.method,
          tip_amount: input.tipAmount > 0 ? input.tipAmount : undefined,
        });
      } catch {
        throw new Error(
          `Invoice ${number} was created, but the payment could not be recorded. Open the invoice ` +
          `to record it there — do not record it again here, or the job will be billed twice.`,
        );
      }
      return invoice;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['job', jobId] });
      queryClient.invalidateQueries({ queryKey: ['job-financials', jobId] });
      queryClient.invalidateQueries({ queryKey: ['job-timeline', jobId] });
      onSuccess();
      onOpenChange(false);
      resetForm();
    },
  });

  const isPending = mutation.isPending || composite.isPending;
  const error = isNoInvoice ? composite.error : mutation.error;

  const handleSubmit = () => {
    if (isNoInvoice) {
      composite.mutate({ amount, method, description: notes, tipAmount: tipDollars });
    } else {
      mutation.mutate();
    }
  };

  // The deposit guard replaces the whole form, so it replaces the footer too:
  // there is nothing to record from this state, only a way out of it.
  const depositBlocked = invoiceId === null && hasUnspentDeposit;

  return (
    <Modal
      open={open}
      onClose={() => onOpenChange(false)}
      title="Record Payment"
      subtitle={
        isNoInvoice
          ? 'Record a payment for this job.'
          : `Record a payment for invoice ${invoiceNumber}.`
      }
      width="xs"
      footer={
        depositBlocked ? (
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        ) : (
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              aria-describedby={isOverpay && !overpayAcknowledged ? 'record-payment-overpay-warning' : undefined}
              disabled={
                !amount || amount <= 0 || !paidAt || (isOverpay && !overpayAcknowledged) || isPending
              }
            >
              {isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Processing...
                </>
              ) : (
                'Record Payment'
              )}
            </Button>
          </>
        )
      }
    >
      {depositBlocked && (
        <div className="space-y-3 rounded-card border border-warning/30 bg-warning/10 p-4">
          <p className="text-sm text-text-primary">
            This customer has a paid deposit on this job. Creating an invoice here would spend
            that deposit against it, which can make a real collection look like an overpayment.
          </p>
          <p className="text-sm text-text-secondary">
            Create the invoice from the Items tab first, then record the payment against it.
          </p>
        </div>
      )}

      {!depositBlocked && (
        <div className="space-y-4">
          {invoiceId === null && !hasUnspentDeposit && (
            <p className="text-sm text-text-secondary">
              This job has no invoice yet. Recording a payment will create an invoice for this
              amount, send it to the customer, and mark it paid.
            </p>
          )}

          <div>
            <FormField label="Amount *" htmlFor="record-payment-amount">
            <Input
              type="number"
              value={amount}
              onChange={(e) => {
                // An empty field yields NaN from parseFloat; coerce to 0 so the controlled input
                // never receives NaN (which renders as a blank the user cannot tell from unset).
                const v = parseFloat(e.target.value);
                setAmount(Number.isNaN(v) ? 0 : v);
                // Re-arm the acknowledgement whenever the amount changes.
                setOverpayAcknowledged(false);
              }}
              min={0.01}
              // No max: the API accepts an overpayment and flags it (OVERPAYMENT_FLAGGED).
              // Capping here refuses a true statement about money that changed hands - the
              // acknowledgement gate below makes it deliberate instead of silent.
              step={0.01}
            />
            </FormField>
            {/* No balance to state on the composite path - the invoice does not exist yet. */}
            {!isNoInvoice && (
              <p className="mt-1 text-xs text-text-secondary">
                Balance due: {formatCurrency(amountDue)}
              </p>
            )}

            {isOverpay && (
              <div
                id="record-payment-overpay-warning"
                role="alert"
                className="mt-2 rounded-card border border-warning-border bg-warning-surface p-2.5"
              >
                <div className="flex items-start gap-2 text-xs text-warning-text">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>
                    This is more than the {formatCurrency(amountDue)} balance due. The extra{' '}
                    {formatCurrency(overpayment)} will be recorded as an overpayment you may need
                    to refund.
                  </span>
                </div>
                <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs font-medium text-warning-text">
                  <Checkbox
                    checked={overpayAcknowledged}
                    onCheckedChange={(v) => setOverpayAcknowledged(v === true)}
                  />
                  Record anyway - overpayment of {formatCurrency(overpayment)}
                </label>
              </div>
            )}
          </div>

          {/* D1 — shown for every payment method, unconditionally. No per-method conditional
              rendering, no hiding it for bank transfer. Nothing preselected, no "No tip" chip -
              same treatment as PublicInvoicePage. */}
          <div className="space-y-2">
            <Label size="sm">Add a tip? (optional)</Label>
            <ToggleGroup
              type="single"
              variant="pill"
              value={tipSelection}
              onValueChange={(v) => setTipSelection(v)}
              aria-label="Tip percentage"
            >
              {TIP_PRESET_PCT.map((pct) => {
                const dollars = Math.round(amount * (pct / 100) * 100) / 100;
                return (
                  <ToggleGroupItem
                    key={pct}
                    value={String(pct)}
                    variant="pill"
                    className="inline-flex min-h-11 flex-col items-center justify-center gap-0 px-4 py-1.5"
                  >
                    <span>{pct}%</span>
                    <span className="text-xs opacity-80">{formatCurrency(dollars)}</span>
                  </ToggleGroupItem>
                );
              })}
              <ToggleGroupItem value="other" variant="pill" className="min-h-11 px-4">
                Other
              </ToggleGroupItem>
            </ToggleGroup>
            {tipSelection === 'other' && (
              <div className="max-w-[10rem] space-y-1">
                <Label htmlFor="record-payment-tip-other" size="sm">Tip amount</Label>
                <Input
                  id="record-payment-tip-other"
                  type="number"
                  min={0}
                  step={0.01}
                  inputMode="decimal"
                  placeholder="0.00"
                  value={tipOtherValue}
                  onChange={(e) => setTipOtherValue(e.target.value)}
                />
              </div>
            )}
          </div>

          {/* Not a FormField: SelectField's props are a closed list (value /
              onValueChange / options / placeholder / disabled / className /
              aria-label) with no id or aria-* passthrough, so the id FormField
              generates would be dropped on the floor and the label would point
              at nothing. Wiring it needs a change to SelectField, not to this
              call site - same documented exception as
              RecordEstimatePaymentDialog's Payment method field. */}
          <div>
            <Label>Payment method *</Label>
            <SelectField
              aria-label="Payment method"
              value={method}
              onValueChange={setMethod}
              className="w-full h-9"
              // R5b (2026-07-22) — derived from the shared list (was a hand-maintained duplicate)
              // so D3's +4 values reach this dialog too, not just the ones someone remembered.
              options={PAYMENT_METHOD_ORDER.map((value) => ({ value, label: PAYMENT_METHOD_LABELS[value] }))}
            />
          </div>

          {/* Not converted to FormField: DateTimePicker has no id prop of its own
              to receive fieldProps.

              clearable={false} because this date is REQUIRED: it is seeded to now, so the
              picker's X is there the moment the dialog opens, and it gates the submit on
              `!paidAt` - clicking it can only grey out "Record payment" with nothing said.
              Both sub-fields stay fully typeable, so backdating a payment costs nothing. */}
          <div>
            <Label>Date *</Label>
            <DateTimePicker value={paidAt} onChange={setPaidAt} clearable={false} className="mt-1" />
          </div>

          <FormField label="Reference number">
            <Input
              type="text"
              value={referenceNumber}
              onChange={(e) => setReferenceNumber(e.target.value)}
              placeholder="Check #, transaction ID, etc."
            />
          </FormField>

          <FormField label="Notes">
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Optional notes..."
            />
          </FormField>

          {error && (
            <p className="text-sm text-danger">
              {extractApiError(error, 'Failed to record payment')}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
