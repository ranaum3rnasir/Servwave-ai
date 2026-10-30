import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { paymentsPageKeys, type PaymentDetail } from '@/lib/api/paymentsPage';
import { refundInvoice } from '@/lib/api/invoices';
import { BANK_DUAL_CREDIT_WARNING, BANK_REFUND_WINDOW_MESSAGE, isPastBankRefundWindow } from '@/lib/refund-rules';
import { extractApiError, formatCurrency } from '@/lib/utils';
import type { RefundCategory } from '@/types/entities';
import { Alert } from '@/components/ui/alert';
import { SelectField } from '@/ui-kit/components/form/selectField';
import { Button } from '@/ui-kit/components/ui/button';
import {
  Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/ui-kit/components/ui/dialog';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';
import { Textarea } from '@/ui-kit/components/ui/textarea';
import { toast } from '@/ui-kit/components/ui/sonner';

import { PHONE_TAP_AREA } from '../phoneTap';

/** The six categories the server requires (`REFUND_CATEGORIES`), in the order the refund dialogs list them. */
const REASONS: Array<{ value: RefundCategory; label: string }> = [
  { value: 'CUSTOMER_REQUEST', label: 'Customer request' },
  { value: 'ERROR', label: 'Billing error' },
  { value: 'GOODWILL', label: 'Goodwill' },
  { value: 'OVERPAYMENT', label: 'Overpayment' },
  { value: 'CHARGEBACK', label: 'Chargeback' },
  { value: 'OTHER', label: 'Other' },
];
const labelOf = (value: RefundCategory) => REASONS.find((r) => r.value === value)!.label;

const toCents = (n: number) => Math.round(n * 100);

/**
 * Refund one payment (payments go-live P6). Its own dialog: the invoice page's refund dialog is edited by other slices
 * and answers a different question (which payment, which method). Here the payment is known, so the person only says
 * how much and why. The amount is checked here before anything is sent (the server checks it again).
 */
type RefundPaymentDialogProps = {
  payment: PaymentDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRefunded?: () => void;
  /** Start from these values instead of the defaults (a failed refund being sent again). */
  prefill?: { amount: number; category: string | null; reason: string | null };
};

/** The form mounts fresh on every open, so the amount, reason, note and any server error never carry over. */
export function RefundPaymentDialog(props: RefundPaymentDialogProps) {
  if (!props.open) return null;
  return <RefundPaymentForm {...props} />;
}

function RefundPaymentForm({ payment, open, onOpenChange, onRefunded, prefill }: RefundPaymentDialogProps) {
  const queryClient = useQueryClient();
  const left = payment.refundable_amount;
  const nothingLeft = toCents(left) <= 0;
  const customer = payment.customer?.name ?? 'the customer';
  const invoice = payment.invoice;

  const startCategory = REASONS.find((r) => r.value === prefill?.category)?.value ?? 'CUSTOMER_REQUEST';
  const startReason = prefill?.reason?.trim() ? prefill.reason : null;

  const [amountText, setAmountText] = useState((prefill ? prefill.amount : left).toFixed(2));
  const [amountError, setAmountError] = useState<string | null>(null);
  const [category, setCategory] = useState<RefundCategory>(startCategory);
  const [reason, setReason] = useState(startReason ?? labelOf(startCategory));
  const [reasonTouched, setReasonTouched] = useState(startReason != null);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  // A second press while the first is on its way would refund twice; the ref closes the gap before React re-renders.
  const sending = useRef(false);

  const parsed = Number(amountText.replace(/[$,\s]/g, ''));
  const valid = Number.isFinite(parsed) && parsed > 0 && toCents(parsed) <= toCents(left);
  const shown = valid ? parsed : left;

  const isBank = payment.method === 'ACH';
  const pastWindow = isBank && isPastBankRefundWindow({ method: payment.method, paid_at: payment.date });

  const mutation = useMutation({
    mutationFn: (amount: number) =>
      refundInvoice(invoice!.id, { amount, payment_id: payment.id, reason_category: category, reason: reason.trim() }),
    onSuccess: (_data, amount) => {
      toast.success(`Refunded ${formatCurrency(amount)} to ${payment.customer?.name ?? 'the customer'}`);
      void queryClient.invalidateQueries({ queryKey: paymentsPageKeys.all });
      onRefunded?.();
      onOpenChange(false);
    },
    onError: (err) => setServerError(extractApiError(err, 'Could not refund this payment.')),
    onSettled: () => { sending.current = false; },
  });

  const submit = () => {
    if (sending.current || !invoice) return;
    setServerError(null);
    if (!(Number.isFinite(parsed) && parsed > 0)) {
      setAmountError('Enter an amount above $0.00.');
      amountRef.current?.focus();
      return;
    }
    if (toCents(parsed) > toCents(left)) {
      setAmountError(`Enter ${formatCurrency(left)} or less.`);
      amountRef.current?.focus();
      return;
    }
    if (!reason.trim()) {
      setReasonError('Enter a short reason.');
      reasonRef.current?.focus();
      return;
    }
    setAmountError(null);
    setReasonError(null);
    sending.current = true;
    mutation.mutate(Math.round(parsed * 100) / 100);
  };

  const changeCategory = (next: string) => {
    const value = next as RefundCategory;
    setCategory(value);
    // The text follows the category until the person writes their own.
    if (!reasonTouched) setReason(labelOf(value));
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!mutation.isPending) onOpenChange(next); }}>
      <DialogContent intent="form" className={`sm:max-w-md ${PHONE_TAP_AREA}`}>
        <DialogHeader>
          <DialogTitle>Refund payment</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          {nothingLeft ? (
            <Alert tone="warning" role="status">Nothing is left to refund on this payment.</Alert>
          ) : (
            <>
          <p className="text-sm">
            Return {formatCurrency(shown)} to {customer} for invoice {invoice?.number ?? ''}. This cannot be undone.
          </p>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="refund-amount">Amount</Label>
            <Input
              ref={amountRef}
              id="refund-amount"
              kind="money"
              className="text-right tabular-nums"
              value={amountText}
              aria-invalid={amountError ? true : undefined}
              aria-describedby={amountError ? 'refund-amount-error refund-amount-hint' : 'refund-amount-hint'}
              onChange={(e) => { setAmountText(e.target.value); setAmountError(null); }}
            />
            {amountError && <p id="refund-amount-error" className="text-destructive text-[13px]">{amountError}</p>}
            <p id="refund-amount-hint" className="text-muted-foreground text-[13px]">{formatCurrency(left)} left to refund</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="refund-reason-category">Reason</Label>
            <SelectField
              id="refund-reason-category"
              value={category}
              onValueChange={changeCategory}
              options={REASONS}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="refund-reason">Note</Label>
            <Textarea
              ref={reasonRef}
              id="refund-reason"
              rows={2}
              maxLength={500}
              value={reason}
              aria-invalid={reasonError ? true : undefined}
              aria-describedby={reasonError ? 'refund-reason-error' : undefined}
              onChange={(e) => { setReason(e.target.value); setReasonTouched(true); setReasonError(null); }}
            />
            {reasonError && <p id="refund-reason-error" className="text-destructive text-[13px]">{reasonError}</p>}
          </div>

          {isBank && (
            <Alert tone="warning" role="status">{pastWindow ? BANK_REFUND_WINDOW_MESSAGE : BANK_DUAL_CREDIT_WARNING}</Alert>
          )}
          {serverError && <Alert tone="danger" role="alert">{serverError}</Alert>}
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            {nothingLeft ? 'Close' : 'Cancel'}
          </Button>
          {!nothingLeft && (
            <Button type="button" variant="destructive" onClick={submit} disabled={mutation.isPending || pastWindow}>
              Refund {formatCurrency(shown)}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
