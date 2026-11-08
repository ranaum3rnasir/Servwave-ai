import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import api from '@/lib/axios';
import { extractApiError } from '@/lib/utils';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { AlertTriangle } from 'lucide-react';

interface VoidInvoiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoiceId: string;
  invoiceNumber: string;
  onSuccess: () => void;
  /** Inventory P1 §4: invoice-born SYNCED lines — voiding auto-returns their stock. */
  syncedLineCount?: number;
}

export function VoidInvoiceDialog({
  open,
  onOpenChange,
  invoiceId,
  invoiceNumber,
  onSuccess,
  syncedLineCount,
}: VoidInvoiceDialogProps) {
  const [reason, setReason] = useState('');

  const mutation = useMutation({
    mutationFn: async () => {
      const { data } = await api.post(`/api/invoices/${invoiceId}/void`, { voided_reason: reason });
      return data;
    },
    onSuccess: () => {
      onSuccess();
      onOpenChange(false);
      setReason('');
    },
  });

  return (
    <Modal
      open={open}
      onClose={() => onOpenChange(false)}
      title="Void Invoice"
      subtitle="Please provide a reason for voiding this invoice."
      width="xs"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="solid" tone="danger"
            onClick={() => mutation.mutate()}
            disabled={!reason.trim() || mutation.isPending}
          >
            {mutation.isPending ? 'Voiding...' : 'Void Invoice'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex gap-2 rounded-lg border border-warning-border bg-warning-surface p-3 text-sm text-warning-text">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Voiding invoice {invoiceNumber} will preserve the record but mark it as cancelled.
            This action cannot be undone.
            {syncedLineCount != null && syncedLineCount > 0 && (
              <> {syncedLineCount} synced inventory item(s) will be returned to stock.</>
            )}
          </span>
        </div>

        <div>
          <Label>Reason *</Label>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="Why is this invoice being voided?"
          />
        </div>

        {mutation.error && (
          <p className="text-sm text-danger">
            {extractApiError(mutation.error, 'Failed to void invoice')}
          </p>
        )}
      </div>
    </Modal>
  );
}
