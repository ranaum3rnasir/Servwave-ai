import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { FormField } from '@/components/patterns/FormField';
import { SelectField } from '@/components/form/SelectField';
import { formatCurrency, extractApiError } from '@/lib/utils';
import type { RefundCategory } from '@/types/entities';

interface RefundDepositDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The estimate this deposit belongs to (used for cache invalidation only). */
  estimateId: string;
  /** The kind=DEPOSIT Invoice id — the unified refund surface (Phase 5 fold). */
  depositInvoiceId: string;
  depositAmount: number;
  hasStripePayment: boolean;
}

// Maps to the unified Invoice refund schema (REFUND_CATEGORIES in invoice.controller.ts).
// Values are kept in lockstep with the shared RefundCategory union (@/types/entities).
const REASON_CATEGORIES: { value: RefundCategory; label: string }[] = [
  { value: 'CUSTOMER_REQUEST', label: 'Customer request' },
  { value: 'ERROR', label: 'Billing error' },
  { value: 'GOODWILL', label: 'Goodwill' },
  { value: 'OVERPAYMENT', label: 'Overpayment' },
  { value: 'CHARGEBACK', label: 'Chargeback' },
  { value: 'OTHER', label: 'Other' },
] as const;

export function RefundDepositDialog({ open, onOpenChange, estimateId, depositInvoiceId, depositAmount, hasStripePayment }: RefundDepositDialogProps) {
  const queryClient = useQueryClient();
  const [reasonCategory, setReasonCategory] = useState('');
  const [reason, setReason] = useState('');

  const mutation = useMutation({
    mutationFn: async () => {
      // Unified Invoice refund on the kind=DEPOSIT invoice (replaces the removed
      // POST /api/estimates/:id/refund-deposit). Full-balance refund (no amount).
      const { data } = await api.post(`/api/invoices/${depositInvoiceId}/refund`, {
        reason_category: reasonCategory,
        reason,
      });
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['estimate', estimateId] });
      queryClient.invalidateQueries({ queryKey: ['estimates'] });
      onOpenChange(false);
      setReasonCategory('');
      setReason('');
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="refund-deposit-dialog">
        <DialogHeader>
          <DialogTitle>Refund Deposit</DialogTitle>
          <DialogDescription>
            This refunds the deposit on the deposit invoice. This action cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-lg bg-background-light/50 border border-border/50 px-3 py-2 space-y-1">
            <p className="text-sm text-text-secondary">Refund amount: <span className="font-semibold text-text-primary">{formatCurrency(depositAmount)}</span></p>
            <p className="text-xs text-text-secondary">
              {hasStripePayment
                ? 'The refund will be processed automatically via Stripe.'
                : 'Please record that the refund has been processed manually.'}
            </p>
          </div>

          {/* Not a FormField: SelectField's props are a closed list (value /
              onValueChange / options / placeholder / disabled / className /
              aria-label) with no id or aria-* passthrough, so the id FormField
              generates would be dropped on the floor and the label would point
              at nothing. Wiring it needs a change to SelectField, not to this
              call site. */}
          <div>
            <Label>Reason category *</Label>
            <SelectField
              aria-label="Reason category"
              value={reasonCategory}
              onValueChange={setReasonCategory}
              placeholder="Select a reason..."
              className="w-full h-10"
              options={REASON_CATEGORIES.map((cat) => ({ value: cat.value, label: cat.label }))}
            />
          </div>

          <FormField label="Reason details *">
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="Provide details about this refund..."
            />
          </FormField>

          {mutation.error && (
            <p className="text-sm text-danger">
              {extractApiError(mutation.error, 'Failed to refund deposit')}
            </p>
          )}

          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              variant="solid" tone="danger"
              data-testid="refund-deposit-submit"
              onClick={() => mutation.mutate()}
              disabled={!reasonCategory || !reason.trim() || mutation.isPending}
            >
              {mutation.isPending ? 'Processing...' : 'Issue Refund'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
