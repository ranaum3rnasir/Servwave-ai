import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import { extractApiError } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { AlertTriangle } from 'lucide-react';

interface WaiveDepositDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  estimateId: string;
  estimateStatus: string;
  paymentMethod?: string | null;
}

export function WaiveDepositDialog({ open, onOpenChange, estimateId, estimateStatus, paymentMethod }: WaiveDepositDialogProps) {
  const queryClient = useQueryClient();
  const isPending = estimateStatus === 'PENDING';
  const [action, setAction] = useState<'waive' | 'cancel'>('waive');

  const mutation = useMutation({
    mutationFn: async () => {
      const { data } = await api.post(`/api/estimates/${estimateId}/waive-deposit`, { action });
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['estimate', estimateId] });
      queryClient.invalidateQueries({ queryKey: ['estimates'] });
      onOpenChange(false);
      setAction('waive');
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Waive Deposit</DialogTitle>
          <DialogDescription>
            {isPending
              ? 'Choose what to do with the estimate after waiving the deposit.'
              : 'This will waive the deposit requirement for this estimate.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {paymentMethod && (
            <div className="flex items-start gap-2 rounded-lg bg-warning-surface border border-warning-border px-3 py-2">
              <AlertTriangle className="h-4 w-4 text-warning-text mt-0.5 shrink-0" />
              <p className="text-sm text-warning-text">
                The customer selected <span className="font-medium">{paymentMethod}</span> as their payment method. If they have already sent payment, you will need to return it manually.
              </p>
            </div>
          )}

          {isPending && (
            <div className="space-y-2">
              <Label>Action</Label>
              {/* Radio rows (label wraps its control) - not a FormField-shape site, left raw. */}
              <div className="space-y-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="waive-action"
                    value="waive"
                    checked={action === 'waive'}
                    onChange={() => setAction('waive')}
                    className="accent-primary"
                  />
                  <span className="text-sm">Waive deposit and approve estimate</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="waive-action"
                    value="cancel"
                    checked={action === 'cancel'}
                    onChange={() => setAction('cancel')}
                    className="accent-primary"
                  />
                  <span className="text-sm">Cancel estimate</span>
                </label>
              </div>
            </div>
          )}

          {mutation.error && (
            <p className="text-sm text-danger">
              {extractApiError(mutation.error, 'Failed to waive deposit')}
            </p>
          )}

          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              variant="solid"
              tone={action === 'cancel' ? 'danger' : 'brand'}
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending}
            >
              {mutation.isPending ? 'Processing...' : 'Confirm'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
