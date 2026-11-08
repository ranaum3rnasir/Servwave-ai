import { useState } from 'react';
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

interface BulkCancelJobsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  count: number;
  isPending: boolean;
  onConfirm: (reason: string) => void;
}

/**
 * Bulk counterpart to CancelJobDialog. Per-job Logistic Order / synced-line detail can't be shown
 * for a batch (those queries are per-jobId), so this states the consequence in one static line
 * instead; the ACTUAL voided-invoice count comes back in the bulk-status response and lands in
 * the toast (JobsPage's bulkStatusMutation), not here - this dialog owns no mutation of its own.
 */
export function BulkCancelJobsDialog({ open, onOpenChange, count, isPending, onConfirm }: BulkCancelJobsDialogProps) {
  const [reason, setReason] = useState('');

  const handleClose = (next: boolean) => {
    if (!next) setReason('');
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Cancel {count} job{count === 1 ? '' : 's'}</DialogTitle>
          <DialogDescription>
            This action cannot be undone. Open invoices on these jobs will be voided to zero and
            any synced inventory will be returned. Please provide a reason.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label>Reason *</Label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="Why are these jobs being cancelled?"
            />
          </div>

          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={() => handleClose(false)}>
              Keep Open
            </Button>
            <Button
              variant="solid" tone="danger"
              onClick={() => onConfirm(reason)}
              disabled={!reason.trim() || isPending}
            >
              {isPending ? 'Cancelling...' : 'Cancel Job'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
