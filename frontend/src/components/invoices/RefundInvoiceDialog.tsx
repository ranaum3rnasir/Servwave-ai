import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Modal } from '@/components/ui/modal';
import { GiveBackLedger, EMPTY, MINUS } from '@/components/invoices/GiveBackLedger';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { SelectField } from '@/components/form/SelectField';
import { formatCurrency, extractApiError } from '@/lib/utils';
import { refundInvoice } from '@/lib/api/invoices';
import type { RefundCategory, PaymentMethod, Refund } from '@/types/entities';
import { PAYMENT_METHOD_LABELS, PAYMENT_METHOD_ORDER } from '@/lib/payment-methods';

interface RefundPaymentOption {
  id: string;
  amount: number | string;
  method: string;
  paid_at: string;
}

interface RefundInvoiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoiceId: string;
  /** Client-side cap: the net amount paid (backend re-enforces server-side). */
  netPaid: number;
  /** Recorded payments — drives the optional payment_id select. */
  payments?: RefundPaymentOption[];
  /** Existing refunds for the ledger (GET may omit; render defensively). */
  refunds?: Refund[];
}

// Aligned to the 6-value backend REFUND_CATEGORIES (RefundCategory union).
const REASON_CATEGORIES: { value: RefundCategory; label: string }[] = [
  { value: 'CUSTOMER_REQUEST', label: 'Customer request' },
  { value: 'ERROR', label: 'Billing error' },
  { value: 'GOODWILL', label: 'Goodwill' },
  { value: 'OVERPAYMENT', label: 'Overpayment' },
  { value: 'CHARGEBACK', label: 'Chargeback' },
  { value: 'OTHER', label: 'Other' },
];

// R5b (2026-07-22) — derived from the shared list (was a hand-maintained duplicate) so D3's +4
// values reach every payment-method picker in the app, not just the ones someone remembered.
const PAYMENT_METHODS: { value: PaymentMethod; label: string }[] = PAYMENT_METHOD_ORDER.map((value) => ({
  value,
  label: PAYMENT_METHOD_LABELS[value],
}));

export function RefundInvoiceDialog({
  open,
  onOpenChange,
  invoiceId,
  netPaid,
  payments = [],
  refunds = [],
}: RefundInvoiceDialogProps) {
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<PaymentMethod | ''>('');
  const [paymentId, setPaymentId] = useState('');
  const [nonTaxableConcession, setNonTaxableConcession] = useState(false);
  const [reasonCategory, setReasonCategory] = useState<RefundCategory | ''>('');
  const [reason, setReason] = useState('');

  const parsedAmount = amount.trim() === '' ? undefined : Number(amount);
  const amountInvalid =
    parsedAmount !== undefined && (Number.isNaN(parsedAmount) || parsedAmount <= 0 || parsedAmount > netPaid);

  const reset = () => {
    setAmount('');
    setMethod('');
    setPaymentId('');
    setNonTaxableConcession(false);
    setReasonCategory('');
    setReason('');
  };

  const mutation = useMutation({
    mutationFn: async () => {
      return refundInvoice(invoiceId, {
        amount: parsedAmount,
        payment_id: paymentId || undefined,
        method: method || undefined,
        non_taxable_concession: nonTaxableConcession || undefined,
        reason_category: reasonCategory as RefundCategory,
        reason,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoice', invoiceId] });
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      onOpenChange(false);
      reset();
    },
  });

  const ledger = refunds ?? [];

  return (
    <Modal
      open={open}
      onClose={() => onOpenChange(false)}
      title="Refund Invoice"
      subtitle="Issue a partial or full refund. Leave the amount blank to refund the full net-paid balance."
      width="sm"
      data-testid="refund-invoice-dialog"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="solid" tone="danger"
            data-testid="refund-invoice-submit"
            onClick={() => mutation.mutate()}
            disabled={!reasonCategory || !reason.trim() || amountInvalid || mutation.isPending}
          >
            {mutation.isPending ? 'Processing...' : 'Issue Refund'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <GiveBackLedger
          rows={ledger}
          columns={[
            {
              key: 'date',
              label: 'Date',
              render: (r) => (
                <span className="whitespace-nowrap">
                  {r.created_at ? new Date(r.created_at).toLocaleDateString('en-US') : EMPTY}
                </span>
              ),
            },
            {
              key: 'amount',
              label: 'Amount',
              numeric: true,
              render: (r) => (
                <span className="text-danger-text">{MINUS}{formatCurrency(Number(r.amount))}</span>
              ),
            },
            { key: 'method', label: 'Method', render: (r) => (r.method || EMPTY).replace('_', ' ') },
            {
              key: 'reason',
              label: 'Reason',
              render: (r) => (
                <>
                  {r.reason_category || EMPTY}
                  {r.non_taxable_concession && <span className="text-text-secondary"> · non-tax</span>}
                </>
              ),
            },
          ]}
        />

        <div className="space-y-1 rounded-lg border border-border bg-background-light px-3 py-2">
          <p className="text-sm text-text-secondary">
            Net paid: <span className="font-semibold text-text-primary">{formatCurrency(netPaid)}</span>
          </p>
          <p className="text-xs text-text-secondary">
            Card refunds are processed automatically via Stripe; manual methods record the give-back.
          </p>
        </div>

        <div>
          <Label>Amount</Label>
          <Input
            type="number"
            data-testid="refund-amount-input"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            min={0.01}
            max={netPaid}
            step={0.01}
            placeholder={`Full refund (${formatCurrency(netPaid)})`}
          />
          {amountInvalid && (
            <p className="text-xs text-danger mt-1">Amount must be between 0 and {formatCurrency(netPaid)}.</p>
          )}
        </div>

        <div>
          <Label>Refund method</Label>
          <SelectField
            aria-label="Refund method"
            value={method || 'NONE'}
            onValueChange={(v) => setMethod(v === 'NONE' ? '' : (v as PaymentMethod))}
            className="w-full h-9"
            options={[
              { value: 'NONE', label: 'Auto (match original payment)' },
              ...PAYMENT_METHODS.map((m) => ({ value: m.value, label: m.label })),
            ]}
          />
        </div>

        {payments.length > 0 && (
          <div>
            <Label>Reverse a specific payment</Label>
            <SelectField
              aria-label="Reverse a specific payment"
              value={paymentId || 'NONE'}
              onValueChange={(v) => setPaymentId(v === 'NONE' ? '' : v)}
              className="w-full h-9"
              options={[
                { value: 'NONE', label: 'Auto / oldest' },
                ...payments.map((p) => ({
                  value: p.id,
                  label: `${formatCurrency(Number(p.amount))} · ${p.method.replace('_', ' ')} · ${new Date(p.paid_at).toLocaleDateString('en-US')}`,
                })),
              ]}
            />
          </div>
        )}

        <div className="flex items-center gap-2">
          <Checkbox
            id="refund-non-taxable"
            checked={nonTaxableConcession}
            onCheckedChange={(checked) => setNonTaxableConcession(Boolean(checked))}
          />
          <Label htmlFor="refund-non-taxable" className="cursor-pointer">
            Non-taxable concession (do not reverse tax)
          </Label>
        </div>

        <div>
          <Label>Reason category *</Label>
          <SelectField
            aria-label="Reason category"
            value={reasonCategory}
            onValueChange={(v) => setReasonCategory(v as RefundCategory | '')}
            placeholder="Select a reason..."
            className="w-full h-9"
            options={REASON_CATEGORIES.map((cat) => ({ value: cat.value, label: cat.label }))}
          />
        </div>

        <div>
          <Label>Reason details *</Label>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="Provide details about this refund..."
          />
        </div>

        {mutation.error && (
          <p className="text-sm text-danger">
            {extractApiError(mutation.error, 'Failed to refund invoice')}
          </p>
        )}
      </div>
    </Modal>
  );
}
