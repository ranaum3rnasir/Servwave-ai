import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { setEstimateStatusTo } from '@/lib/api/estimates';
import { ESTIMATE_STATUS } from '@/constants/estimateStatus';
import { extractApiError } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { FormField } from '@/components/patterns/FormField';

interface CancelEstimateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  estimateId: string;
}

export function CancelEstimateDialog({ open, onOpenChange, estimateId }: CancelEstimateDialogProps) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');

  // Spec B1 — routes through the free status setter, not POST /cancel. That endpoint still gates
  // on DRAFT/SENT/PENDING, so archiving a won or declined estimate (legal now) would 400 there.
  // The setter raises the same `estimate.cancelled` verb, so the notification feed is unchanged,
  // and it also clears the stamps of whichever status the estimate is leaving.
  const mutation = useMutation({
    mutationFn: async () => setEstimateStatusTo(estimateId, ESTIMATE_STATUS.ARCHIVED, { cancelled_reason: reason }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['estimate', estimateId] });
      queryClient.invalidateQueries({ queryKey: ['estimates'] });
      onOpenChange(false);
      setReason('');
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          {/* D14 (2026-07-21) — relabeled "Archive" (was "Cancel"). The endpoint
              (POST .../cancel), the cancelled_reason field, and the estimate.cancelled verb are
              unchanged — this is copy-only. */}
          <DialogTitle>Archive Estimate</DialogTitle>
          {/* Spec B1 - "This action cannot be undone" stopped being true when archive stopped being
              terminal: an archived estimate moves to any other status from the pill. The reason
              stays required, because recording it is what the archive is FOR. */}
          <DialogDescription>
            The estimate leaves the active pipeline. You can move it back later from the status
            picker. Please provide a reason.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <FormField label="Reason *">
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="Why is this estimate being archived?"
            />
          </FormField>

          {mutation.error && (
            <p className="text-sm text-danger">
              {extractApiError(mutation.error, 'Failed to archive estimate')}
            </p>
          )}

          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Keep Open
            </Button>
            <Button
              variant="solid" tone="danger"
              onClick={() => mutation.mutate()}
              disabled={!reason.trim() || mutation.isPending}
            >
              {mutation.isPending ? 'Archiving...' : 'Archive Estimate'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
