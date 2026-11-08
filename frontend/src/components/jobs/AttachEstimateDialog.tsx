/**
 * AttachEstimateDialog - "Attach estimate" (transition 16, job-items-estimate-parity Part C).
 *
 * Lets an admin/dispatcher pick an existing, unattached, in-flight estimate for this job's
 * customer and attach it via POST /api/estimates/:id/attach-to-job. The backend enforces the
 * real guards (same customer, no recorded money, not already attached) - this dialog's client-
 * side filtering just keeps the picker list free of options that would 400/409 on submit; it is
 * not itself a security boundary.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusBadge } from '@/components/data/status-badge';
import { FileText, Loader2 } from 'lucide-react';
import { cn, formatCurrency, extractApiError } from '@/lib/utils';
import { listCustomerEstimates, attachEstimateToJob } from '@/lib/api/estimates';
import { toast } from '@/components/ui/use-toast';

// Mirrors attachToJob's own DRAFT/SENT/PENDING allow-list (backend/src/controllers/estimate.controller.ts).
const ATTACHABLE_STATUSES = new Set(['DRAFT', 'SENT', 'PENDING']);

export interface AttachEstimateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobId: string;
  customerId: string;
}

export function AttachEstimateDialog({ open, onOpenChange, jobId, customerId }: AttachEstimateDialogProps) {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data: estimates, isLoading } = useQuery({
    queryKey: ['customer-estimates', customerId],
    queryFn: () => listCustomerEstimates(customerId),
    enabled: open && Boolean(customerId),
  });

  const attachable = (estimates ?? []).filter((e) => e.job_id == null && ATTACHABLE_STATUSES.has(e.status));

  const attachMutation = useMutation({
    mutationFn: (estimateId: string) => attachEstimateToJob(estimateId, jobId),
    onSuccess: ({ estimate }) => {
      queryClient.invalidateQueries({ queryKey: ['job', jobId] });
      queryClient.invalidateQueries({ queryKey: ['customer-estimates', customerId] });
      toast({ title: `Estimate ${estimate.estimate_number} attached` });
      setSelectedId(null);
      onOpenChange(false);
    },
    onError: (err) => {
      toast({ title: extractApiError(err, 'Failed to attach estimate'), variant: 'destructive' });
    },
  });

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!attachMutation.isPending) { setSelectedId(null); onOpenChange(next); } }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Attach estimate</DialogTitle>
          <DialogDescription>
            Pick an existing estimate for this customer to attach to this job. Its deposit (if paid)
            will credit against this job&apos;s invoices, and its number will be re-keyed into this
            job&apos;s own series.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-text-secondary" aria-hidden />
          </div>
        ) : attachable.length === 0 ? (
          <EmptyState icon={FileText} title="No attachable estimates" description="This customer has no unattached draft or sent estimate." />
        ) : (
          <div className="max-h-80 space-y-2 overflow-y-auto">
            {attachable.map((e) => (
              <button
                key={e.id}
                type="button"
                onClick={() => setSelectedId(e.id)}
                className={cn(
                  'flex w-full items-center justify-between gap-3 rounded-card border px-3 py-2.5 text-left transition-colors',
                  selectedId === e.id ? 'border-primary bg-primary-subtle' : 'border-border hover:bg-background-light',
                )}
              >
                <span className="flex flex-col">
                  <span className="text-sm font-bold text-text-primary">{e.estimate_number}</span>
                  <StatusBadge domain="estimate" status={e.status} />
                </span>
                <span className="text-sm font-semibold tabular-nums text-text-primary">
                  {formatCurrency(Number(e.total_amount))}
                </span>
              </button>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={attachMutation.isPending}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="solid"
            tone="business"
            disabled={!selectedId || attachMutation.isPending}
            onClick={() => selectedId && attachMutation.mutate(selectedId)}
          >
            {attachMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            Attach
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
