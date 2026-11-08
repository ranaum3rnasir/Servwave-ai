import { useMutation, useQueryClient } from '@tanstack/react-query';
import { voidEstimateApproval } from '@/lib/api/estimates';
import { extractApiError } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

interface VoidApprovalDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  estimateId: string;
  estimateNumber: string;
  // D13's guarded unwind: named here so staff sees exactly what gets detached before confirming.
  jobNumber?: string | null;
}

export function VoidApprovalDialog({
  open,
  onOpenChange,
  estimateId,
  estimateNumber,
  jobNumber,
}: VoidApprovalDialogProps) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => voidEstimateApproval(estimateId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['estimate', estimateId] });
      queryClient.invalidateQueries({ queryKey: ['estimates'] });
      onOpenChange(false);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Void approval on {estimateNumber}?</DialogTitle>
          <DialogDescription>
            {jobNumber
              ? `Job ${jobNumber} was already created from this estimate and stays exactly as it is — voiding only moves the estimate itself back to Sent so it can be corrected and re-approved.`
              : 'This will move the estimate back to Sent so it can be corrected and re-approved.'}
          </DialogDescription>
        </DialogHeader>

        {mutation.error && (
          <p className="text-sm text-danger">
            {extractApiError(mutation.error, 'Failed to void approval')}
          </p>
        )}

        <div className="flex justify-end gap-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Keep Approved
          </Button>
          <Button
            variant="solid" tone="danger"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? 'Voiding...' : 'Void Approval'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
