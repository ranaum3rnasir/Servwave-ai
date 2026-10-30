import { useScheduleTimezone, pickerValueToIso, isoToPickerValue } from '@/lib/schedule-tz';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import { createJobInvoice } from '@/lib/api/jobs';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { DateField } from '@/ui-kit/components/form/dateField';
import { FormField } from '@/components/patterns/FormField';
import { extractApiError, formatCurrency } from '@/lib/utils';
import { RecordPaymentMethodField } from '@/components/payments/RecordPaymentMethodField';
import { selectedPaymentMethod, useRecordablePaymentMethods } from '@/lib/api/recordablePaymentMethods';
import { TIP_PRESET_PCT } from '@/lib/tips';
import { Loader2 } from 'lucide-react';

const apiErrorCode = (err: unknown): string | undefined =>
  (err as { response?: { data?: { code?: string } } })?.response?.data?.code;

const METHOD_REASON_ID = 'record-payment-method-reason';

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
  /**
   * Slice 28b: bank money still clearing on this invoice. It is not collected yet, but it is not
   * collected a second time by hand either: the dialog works from payable-now (balance due less
   * this), and the server refuses a hand payment above it.
   */
  processingAmount?: number;
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
  processingAmount = 0,
}: RecordPaymentDialogProps) {
  const queryClient = useQueryClient();
  const timezone = useScheduleTimezone();
  const defaultPaidAt = isoToPickerValue(new Date().toISOString(), timezone);
  const processing = invoiceId === null ? 0 : Math.max(0, processingAmount);
  const payableNow = Math.max(0, Math.round((amountDue - processing) * 100) / 100);
  const [amount, setAmount] = useState(payableNow);
  // What the person picked; the method shown and sent is that while it is still on offer, else the first on offer
  // (the lists arrive after the dialog mounts, so the preselection cannot be seeded here).
  const [pickedMethod, setPickedMethod] = useState('');
  const recordable = useRecordablePaymentMethods();
  const method = selectedPaymentMethod(pickedMethod, recordable.methods);
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
  // Closing (Cancel, X, Escape, a finished payment) hands focus back to the control that opened the dialog. The opener is
  // read in a layout effect, which runs before the dialog moves focus into itself; the dialog stays mounted while closed,
  // so the browser's own "back to where you were" is not enough here.
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (open) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, [open]);
  useEffect(() => {
    if (open) return;
    const target = opener.current;
    opener.current = null;
    if (!target) return;
    const timer = window.setTimeout(() => {
      const active = document.activeElement;
      if (target.isConnected && (!active || active === document.body)) target.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open]);
  const resetForm = () => {
    setAmount(payableNow);
    setPickedMethod('');
    setPaidAt(defaultPaidAt);
    // Keeps "what was seeded" honest, so a zone landing after a reset is still read as untouched.
    setSeededPaidAt(defaultPaidAt);
    setReferenceNumber('');
    setNotes('');
    setTipSelection('');
    setTipOtherValue('');
  };

  const isNoInvoice = invoiceId === null;
  // Nothing the person may record: the button is greyed and the field says why.
  const noMethod = recordable.ready && recordable.methods.length === 0;

  const tipDollars = tipSelection === 'other'
    ? Math.max(0, parseFloat(tipOtherValue) || 0)
    : tipSelection
      ? Math.round(amount * (Number(tipSelection) / 100) * 100) / 100
      : 0;

  // A hand payment can never be larger than the balance due: the server refuses it, and the dialog
  // says so before the click. The composite (no invoice) path is exempt: the invoice is CREATED for
  // exactly the typed amount, so `amountDue` is always 0 there and there is no balance to exceed.
  // While a bank payment is clearing, the processing texts below own the message (payable-now cap).
  const dueCents = Math.round(amountDue * 100);
  const nothingLeft = !isNoInvoice && processing === 0 && dueCents <= 0;
  const aboveBalance =
    !isNoInvoice && processing === 0 && dueCents > 0 && Number.isFinite(amount) && Math.round(amount * 100) > dueCents;
  // Slice 28b: above payable-now while a debit is clearing is refused (the server answers 409).
  const overPayableNow = processing > 0 && Number.isFinite(amount) && amount > payableNow + 0.0001;

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
    onError: (err) => {
      // The balance moved while the dialog was open: the server's sentence shows under the Amount
      // field, and the invoice is reloaded so the new balance is what the person sees next.
      if (apiErrorCode(err) === 'AMOUNT_ABOVE_BALANCE') {
        queryClient.invalidateQueries({ queryKey: ['invoice', invoiceId] });
        queryClient.invalidateQueries({ queryKey: ['invoices'] });
        // The job page reads the balance it passes in from its financials query.
        if (jobId) queryClient.invalidateQueries({ queryKey: ['job-financials', jobId] });
      }
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
          `to record it there - do not record it again here, or the job will be billed twice.`,
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
  const serverCapError =
    !isNoInvoice && mutation.error && apiErrorCode(mutation.error) === 'AMOUNT_ABOVE_BALANCE'
      ? extractApiError(mutation.error, '')
      : null;
  const amountError = nothingLeft
    ? 'There is nothing left to pay on this invoice.'
    : aboveBalance
      ? `That is more than the ${formatCurrency(amountDue)} balance due. Enter ${formatCurrency(amountDue)} or less.`
      : serverCapError;

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
      intent="form"
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
          <Button variant="outline" className="max-sm:h-11" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        ) : (
          <>
            <Button variant="outline" className="max-sm:h-11" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              className="max-sm:h-11"
              onClick={handleSubmit}
              aria-describedby={noMethod ? METHOD_REASON_ID : undefined}
              disabled={
                !method || !amount || amount <= 0 || !paidAt || overPayableNow || Boolean(amountError) || isPending
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
            <FormField
              label="Amount *"
              htmlFor="record-payment-amount"
              hint={isNoInvoice ? undefined : `Balance due: ${formatCurrency(amountDue)}`}
              error={amountError ? <span role="alert">{amountError}</span> : undefined}
            >
              <Input
                kind="money"
                value={amount}
                onChange={(e) => {
                  // An empty field yields NaN from parseFloat; coerce to 0 so the controlled input
                  // never receives NaN (which renders as a blank the user cannot tell from unset).
                  const v = parseFloat(e.target.value);
                  setAmount(Number.isNaN(v) ? 0 : v);
                  // A server refusal belongs to the amount that was sent; a new amount clears it.
                  if (mutation.isError) mutation.reset();
                }}
                min={0.01}
                max={isNoInvoice ? undefined : payableNow}
                step={0.01}
              />
            </FormField>
            {processing > 0 && (
              <p className="mt-1 text-xs text-text-secondary" data-testid="record-payment-processing">
                A bank payment of {formatCurrency(processing)} is still processing. You can record up to{' '}
                {formatCurrency(payableNow)} now.
              </p>
            )}
            {overPayableNow && (
              <p className="mt-1 text-xs text-danger" role="alert" data-testid="record-payment-processing-over">
                That is more than can be recorded while the bank payment clears: up to {formatCurrency(payableNow)}.
              </p>
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
                  kind="money"
                  min={0}
                  step={0.01}
                  placeholder="0.00"
                  value={tipOtherValue}
                  onChange={(e) => setTipOtherValue(e.target.value)}
                />
              </div>
            )}
          </div>

          <RecordPaymentMethodField
            methods={recordable.methods}
            ready={recordable.ready}
            value={method}
            onValueChange={setPickedMethod}
            reasonId={METHOD_REASON_ID}
          />

          {/* Not converted to FormField in this pass; out of scope for the
              DateField/TimeField migration (SRVW-247).

              clearable={false} because this date is REQUIRED: it is seeded to now, so the
              picker's X is there the moment the dialog opens, and it gates the submit on
              `!paidAt` - clicking it can only grey out "Record payment" with nothing said.
              Both sub-fields stay fully typeable, so backdating a payment costs nothing. */}
          <div>
            <Label>Date *</Label>
            <DateField mode="datetime" value={paidAt} onChange={setPaidAt} clearable={false} className="mt-1" />
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

          {error && !serverCapError && (
            <p className="text-sm text-danger">
              {extractApiError(error, 'Failed to record payment')}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
