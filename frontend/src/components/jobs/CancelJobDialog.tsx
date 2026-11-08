import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import api from '@/lib/axios';
import { extractApiError } from '@/lib/utils';
import { listJobLines } from '@/lib/api/jobs';
import { refreshAfterVisitWrite } from '@/lib/refreshAfterVisitWrite';
import { useLogisticOrders, type LogisticOrderListRow } from '@/lib/api/logisticOrders';
import { StatusBadge } from '@/components/data/status-badge';
import { useFeature } from '@/lib/entitlements';
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

interface CancelJobDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobId: string;
}

/**
 * Aggregated consequence per LO (spec §12 rec 6 — one line, no per-line list). PROCESSED LOs
 * auto-return their stock on job cancel; open LOs just become CANCELLED; already-terminal LOs
 * don't change. The list row carries `lineCount` (return-movement count), not a summed-qty
 * total, so the consequence is phrased in items, not units.
 */
function loConsequence(lo: LogisticOrderListRow): string {
  if (lo.status === 'PROCESSED') {
    return `returns ${lo.lineCount} item${lo.lineCount === 1 ? '' : 's'} to stock`;
  }
  if (lo.status === 'CANCELLED' || lo.status === 'RETURNED') return 'no change';
  return 'will be cancelled';
}

export function CancelJobDialog({ open, onOpenChange, jobId }: CancelJobDialogProps) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');

  // Inventory P1 §4 — lazy count of SYNCED lines (cache-shared with the Items tab):
  // cancelling auto-returns their stock server-side, so say so up front. Cancel is
  // terminal (no un-cancel), hence no re-sync language.
  const { data: lineData } = useQuery({
    queryKey: ['job-line-items', jobId],
    queryFn: () => listJobLines(jobId),
    enabled: open,
  });
  const syncedCount = (lineData?.lines ?? []).filter((l) => l.stock_status === 'SYNCED').length;

  // LO §5 job-cancel dialog — list the job's Logistic Orders + what returns. Lazy (enabled:open);
  // 403s for non-readers resolve to no rows (retry:false in the hook), degrading to the reason box.
  // Also skipped without the Scale `inventory` entitlement: the route 402s there, and an org that
  // cannot own Logistic Orders has none to warn about. Cancelling a job stays fully available.
  const hasInventory = useFeature('inventory');
  const { data: loData } = useLogisticOrders(
    { job_id: jobId },
    { enabled: open && hasInventory },
  );
  const loRows = loData?.data ?? [];

  const mutation = useMutation({
    mutationFn: async () => {
      const { data } = await api.post(`/api/jobs/${jobId}/cancel`, { cancelled_reason: reason });
      return data;
    },
    onSuccess: () => {
      // Cancelling the job cancels its live visits in the same transaction (multi-visit,
      // job.controller cancel()), so it is a visit write.
      refreshAfterVisitWrite(queryClient, { jobId });
      // Anchored LOs may flip to CANCELLED/RETURNED server-side — refresh their lists.
      queryClient.invalidateQueries({ queryKey: ['logistic-orders'] });
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      onOpenChange(false);
      setReason('');
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Cancel Job</DialogTitle>
          <DialogDescription>
            This action cannot be undone. Please provide a reason.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {loRows.length > 0 && (
            <div className="space-y-2 rounded-lg border border-border bg-background-light p-3 text-sm">
              <p className="font-medium text-text-primary">Logistic orders on this job</p>
              <ul className="space-y-1.5">
                {loRows.map((lo) => (
                  <li key={lo.id} className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <code className="truncate font-mono text-xs text-text-primary">{lo.number}</code>
                      <StatusBadge domain="logisticOrder" status={lo.status} />
                    </span>
                    <span className="shrink-0 text-xs text-text-secondary">{loConsequence(lo)}</span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-text-secondary">
                Processed orders return their stock automatically.
              </p>
            </div>
          )}

          {syncedCount > 0 && (
            <div className="flex gap-2 rounded-lg border border-warning/20 bg-warning/10 p-3 text-sm text-warning">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{syncedCount} synced inventory item(s) will be returned to stock.</span>
            </div>
          )}

          <div>
            <Label>Reason *</Label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="Why is this job being cancelled?"
            />
          </div>

          {mutation.error && (
            <p className="text-sm text-danger">
              {extractApiError(mutation.error, 'Failed to cancel job')}
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
              {mutation.isPending ? 'Cancelling...' : 'Cancel Job'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
