import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { SelectField } from '@/components/form/SelectField';
import { AlertTriangle } from 'lucide-react';
import { formatCurrency, extractApiError } from '@/lib/utils';
import { voidPayment } from '@/lib/api/invoices';
import type { VoidPaymentReason } from '@/types/entities';

interface VoidPaymentTarget {
  id: string;
  amount: number | string;
  method: string;
  reference_number: string | null;
}

interface VoidPaymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoiceId: string;
  payment: VoidPaymentTarget;
}

// Only the 4 manual void categories — CHARGEBACK is reserved for the chargeback path.
type ManualVoidCategory = Exclude<VoidPaymentReason, 'CHARGEBACK'>;

const VOID_CATEGORIES: { value: ManualVoidCategory; label: string }[] = [
  { value: 'BOUNCED', label: 'Bounced (NSF / returned)' },
  { value: 'ERROR', label: 'Entry error' },
  { value: 'DUPLICATE', label: 'Duplicate payment' },
  { value: 'WRONG_INVOICE', label: 'Applied to wrong invoice' },
];

export function VoidPaymentDialog({
  open,
  onOpenChange,
  invoiceId,
  payment,
}: VoidPaymentDialogProps) {
  const queryClient = useQueryClient();
  const [voidCategory, setVoidCategory] = useState<ManualVoidCategory | ''>('');
  const [reason, setReason] = useState('');

  const reset = () => {
    setVoidCategory('');
    setReason('');
  };

  const mutation = useMutation({
    mutationFn: async () => {
      return voidPayment(invoiceId, {
        payment_id: payment.id,
        void_category: voidCategory as ManualVoidCategory,
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

  return (
    <Modal
      open={open}
      onClose={() => onOpenChange(false)}
      title="Void Payment"
      subtitle="Reverse this recorded payment. The record is preserved and marked as voided."
      width="xs"
      data-testid="void-payment-dialog"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="solid" tone="danger"
            data-testid="void-payment-submit"
            onClick={() => mutation.mutate()}
            disabled={!voidCategory || !reason.trim() || mutation.isPending}
          >
            {mutation.isPending ? 'Voiding...' : 'Void Payment'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex gap-2 rounded-lg border border-warning-border bg-warning-surface p-3 text-sm text-warning-text">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Voiding {formatCurrency(Number(payment.amount))} · {payment.method.replace('_', ' ')}
            {payment.reference_number && <> · ref {payment.reference_number}</>} re-opens the
            invoice balance. This action cannot be undone.
          </span>
        </div>

        <div>
          <Label>Reason category *</Label>
          <SelectField
            aria-label="Reason category"
            value={voidCategory}
            onValueChange={(v) => setVoidCategory(v as ManualVoidCategory | '')}
            placeholder="Select a reason..."
            className="w-full h-9"
            options={VOID_CATEGORIES.map((c) => ({ value: c.value, label: c.label }))}
          />
        </div>

        <div>
          <Label>Reason details *</Label>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="Why is this payment being voided?"
          />
        </div>

        {mutation.error && (
          <p className="text-sm text-danger">
            {extractApiError(mutation.error, 'Failed to void payment')}
          </p>
        )}
      </div>
    </Modal>
  );
}
