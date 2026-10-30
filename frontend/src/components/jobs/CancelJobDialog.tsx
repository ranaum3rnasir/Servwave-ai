import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import api from '@/lib/axios';
import { extractApiError } from '@/lib/utils';
import { invoiceRowNote, type PaidInvoiceConflictRow } from '@/components/jobs/cancelInvoiceNote';
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
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { CancelReasonFields } from '@/components/jobs/CancelReasonFields';

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

/** The affected invoices when the cancel was refused because open invoices carry payments. */
function paymentsConflict(err: unknown): PaidInvoiceConflictRow[] | null {
  const res = (err as { response?: { status?: number; data?: { code?: string; invoices?: unknown } } })?.response;
  if (res?.status !== 409 || res.data?.code !== 'JOB_CANCEL_HAS_PAYMENTS') return null;
  return Array.isArray(res.data.invoices) ? (res.data.invoices as PaidInvoiceConflictRow[]) : [];
}

export function CancelJobDialog({ open, onOpenChange, jobId }: CancelJobDialogProps) {
  const queryClient = useQueryClient();
  // S06.15: the reason is picked from the company's list (its code); the note beside it is optional.
  const [reasonCode, setReasonCode] = useState('');
  const [note, setNote] = useState('');
  // #891: set when the API refuses the cancel because open invoices carry payments. The dialog
  // then lists them. Payments slice W3: with two outcomes (an unpaid invoice can be voided) the
  // safe one, keep, is preselected; with only one outcome there is no choice to make at all.
  const [conflict, setConflict] = useState<PaidInvoiceConflictRow[] | null>(null);
  const [invoiceChoice, setInvoiceChoice] = useState<'keep' | 'void' | null>(null);
  // Only invoices without payments can be voided; offer the void choice only when one is listed.
  const anyUnpaid = (conflict ?? []).some((inv) => !inv.has_payments);

  // Everything typed or chosen belongs to ONE job and ONE opening of the dialog. Callers reuse a
  // single instance across jobs (SchedulePage switches its jobId), so a conflict list or an
  // invoice choice left over from another job would be sent for this one. Reset when the dialog
  // closes or moves to another job (adjusting state during render, not in an effect).
  const [scope, setScope] = useState({ jobId, open });
  if (scope.jobId !== jobId || scope.open !== open) {
    setScope({ jobId, open });
    if (scope.jobId !== jobId || !open) {
      setReasonCode('');
      setNote('');
      setConflict(null);
      setInvoiceChoice(null);
    }
  }

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
      const { data } = await api.post(`/api/jobs/${jobId}/cancel`, {
        cancel_reason_code: reasonCode,
        ...(note.trim() ? { cancelled_reason: note.trim() } : {}),
        // Sent only once chosen - the API treats an absent key as "no choice made" (#891).
        ...(invoiceChoice !== null ? { void_invoices: invoiceChoice === 'void' } : {}),
      });
      return data;
    },
    onError: (err) => {
      const rows = paymentsConflict(err);
      if (rows) {
        setConflict(rows);
        setInvoiceChoice('keep');
      }
    },
    onSuccess: () => {
      // Cancelling the job cancels its live visits in the same transaction (multi-visit,
      // job.controller cancel()), so it is a visit write.
      refreshAfterVisitWrite(queryClient, { jobId });
      // Anchored LOs may flip to CANCELLED/RETURNED server-side — refresh their lists.
      queryClient.invalidateQueries({ queryKey: ['logistic-orders'] });
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      onOpenChange(false);
      setReasonCode('');
      setNote('');
      setConflict(null);
      setInvoiceChoice(null);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent intent="form" className="max-w-md">
        <DialogHeader>
          <DialogTitle>Cancel Job</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* #891: the cancel was refused because the job's invoices carry payments - name them and ask. */}
          {conflict && (
            <div className="space-y-3 rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm">
              <div className="space-y-1">
                <p className="font-medium text-text-primary">This job's invoices have payments</p>
              </div>
              <ul className="space-y-1.5">
                {conflict.map((inv) => (
                  <li key={inv.id} className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <code className="truncate font-mono text-xs text-text-primary">{inv.invoice_number}</code>
                      <StatusBadge domain="invoice" status={inv.status} />
                    </span>
                    <span className="shrink-0 text-xs text-text-secondary">{invoiceRowNote(inv)}</span>
                  </li>
                ))}
              </ul>
              {anyUnpaid ? (
              /* Radio rows (label wraps its control), the WaiveDepositDialog shape. */
              <div className="space-y-2">
                <label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="radio"
                    name="cancel-job-invoices"
                    value="keep"
                    checked={invoiceChoice === 'keep'}
                    onChange={() => setInvoiceChoice('keep')}
                    className="mt-1 accent-primary"
                  />
                  <span>
                    <span className="block text-sm">Keep the invoices as they are</span>
                    <span className="block text-xs text-text-secondary">
                      The job is cancelled. The invoices and their payments don't change.
                    </span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="radio"
                    name="cancel-job-invoices"
                    value="void"
                    checked={invoiceChoice === 'void'}
                    onChange={() => setInvoiceChoice('void')}
                    className="mt-1 accent-primary"
                  />
                  <span>
                    <span className="block text-sm">Void the unpaid invoices to $0</span>
                    <span className="block text-xs text-text-secondary">
                      The job is cancelled. Invoices with payments are kept. Voiding cannot be undone.
                    </span>
                  </span>
                </label>
              </div>
              ) : (
                <p className="text-sm text-text-primary">The invoice stays as it is. Refund it separately.</p>
              )}
            </div>
          )}

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

          <CancelReasonFields code={reasonCode} onCodeChange={setReasonCode} note={note} onNoteChange={setNote} />

          {mutation.error && !paymentsConflict(mutation.error) && (
            <p className="text-sm text-danger">
              {extractApiError(mutation.error, 'Failed to cancel job')}
            </p>
          )}
        </div>

        <DialogFooter className="gap-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Keep Open
          </Button>
          <Button
            variant="solid" tone="danger"
            onClick={() => mutation.mutate()}
            disabled={!reasonCode || mutation.isPending}
          >
            {mutation.isPending ? 'Cancelling...' : 'Cancel Job'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
