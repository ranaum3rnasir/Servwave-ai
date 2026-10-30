import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import api from '@/lib/axios';
import { StatusBadge } from '@/components/data/status-badge';
import { invoiceRowNote } from '@/components/jobs/cancelInvoiceNote';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { DialogList } from '@/ui-kit/components/ui/dialogList';
import { CancelReasonFields } from '@/components/jobs/CancelReasonFields';

interface BulkCancelJobsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  count: number;
  /** The selected jobs, read for the invoices carrying money that the cancel will keep (#891). */
  jobIds: string[];
  isPending: boolean;
  /** One reason (its code from the company's list) and one optional note for the whole batch. */
  onConfirm: (reasonCode: string, note: string, voidInvoices: boolean) => void;
  /**
   * What the batch did, once it ran with some jobs refused: the dialog then lists each refused job with its reason instead
   * of the form. Jobs the batch cancelled are only counted; a refused job (a Done one, or one out of the person's reach) is
   * named.
   */
  result?: BulkCancelResult | null;
  /** Job numbers by job id, for naming the refused jobs. */
  jobNumbers?: Record<string, string>;
}

export interface BulkCancelResult {
  cancelledCount: number;
  refused: { id: string; error: string }[];
}

/** One invoice carrying money on a selected job, from GET /api/jobs/cancel-preview (#891). */
interface KeptInvoiceRow {
  job_id: string;
  job_number: string;
  id: string;
  invoice_number: string;
  status: string;
  // Withheld by the API for a caller who can't see pricing.
  amount_paid?: number;
  amount_processing?: number;
}

/**
 * Bulk counterpart to CancelJobDialog. Per-job Logistic Order / synced-line detail can't be shown
 * for a batch (those queries are per-jobId), so this states the consequence in one static line
 * instead; the ACTUAL voided-invoice count comes back in the bulk-status response and lands in
 * the toast (the bulk bar's bulkStatusMutation), not here - this dialog owns no mutation of its own.
 *
 * #891: the batch carries one explicit choice for every selected job's open invoices. An invoice
 * with payments, a fully paid one included, is never voided under either choice: the dialog reads
 * those invoices for the selected jobs and lists them as kept before the user confirms.
 */
export function BulkCancelJobsDialog({ open, onOpenChange, count, jobIds, isPending, onConfirm, result, jobNumbers }: BulkCancelJobsDialogProps) {
  const [reasonCode, setReasonCode] = useState('');
  const [note, setNote] = useState('');
  // null until chosen - no default in either direction (#891).
  const [voidChoice, setVoidChoice] = useState<boolean | null>(null);

  const { data: keptData } = useQuery({
    queryKey: ['jobs-cancel-preview', jobIds],
    queryFn: async () => {
      const { data } = await api.get('/api/jobs/cancel-preview', { params: { ids: jobIds.join(',') } });
      return (data?.invoices ?? []) as KeptInvoiceRow[];
    },
    enabled: open && jobIds.length > 0 && !result,
  });
  const kept = keptData ?? [];

  // Each opening starts clean. Callers close the dialog by setting `open` themselves after a
  // confirm, so the reset keys off the prop (adjusting state during render, not in an effect).
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) {
      setReasonCode('');
      setNote('');
      setVoidChoice(null);
    }
  }

  if (result) {
    const { cancelledCount, refused } = result;
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent intent="form" className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {refused.length} job{refused.length === 1 ? '' : 's'} could not be cancelled
            </DialogTitle>
            <DialogDescription>
              {cancelledCount} job{cancelledCount === 1 ? ' was' : 's were'} cancelled.
            </DialogDescription>
          </DialogHeader>
          <DialogList as="ul" cap="max-h-64 overflow-y-auto" className="space-y-1.5 text-sm" aria-label="Jobs that could not be cancelled">
            {refused.map((job) => (
              <li key={job.id} className="flex items-start justify-between gap-3">
                <code className="shrink-0 font-mono text-xs text-text-primary">{jobNumbers?.[job.id] ?? 'Job'}</code>
                <span className="text-right text-xs text-text-secondary">{job.error}</span>
              </li>
            ))}
          </DialogList>
          <DialogFooter className="gap-3">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent intent="form" className="max-w-md">
        <DialogHeader>
          <DialogTitle>Cancel {count} job{count === 1 ? '' : 's'}</DialogTitle>
          <DialogDescription>
            Any synced inventory on these jobs will be returned to stock. One reason covers every job in the batch.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {kept.length > 0 && (
            <div className="space-y-2 rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm">
              <div className="space-y-1">
                <p className="font-medium text-text-primary">Invoices with payments</p>
                <p className="text-xs text-text-secondary">
                  These are kept as they are. A refund is a separate step after the cancel.
                </p>
              </div>
              <ul className="space-y-1.5">
                {kept.map((inv) => (
                  <li key={inv.id} className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <code className="truncate font-mono text-xs text-text-primary">{inv.invoice_number}</code>
                      <StatusBadge domain="invoice" status={inv.status} />
                      <span className="truncate text-xs text-text-secondary">{inv.job_number}</span>
                    </span>
                    <span className="shrink-0 text-xs text-text-secondary">
                      {invoiceRowNote({ ...inv, has_payments: true })}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="space-y-2 rounded-lg border border-border bg-background-light p-3 text-sm">
            <p className="font-medium text-text-primary">Open invoices on these jobs</p>
            {/* Radio rows (label wraps its control), the CancelJobDialog / WaiveDepositDialog shape. */}
            <label className="flex cursor-pointer items-start gap-2">
              <input
                type="radio"
                name="bulk-cancel-invoices"
                value="keep"
                checked={voidChoice === false}
                onChange={() => setVoidChoice(false)}
                className="mt-1 accent-primary"
              />
              <span>
                <span className="block text-sm">Keep the invoices as they are</span>
                <span className="block text-xs text-text-secondary">
                  The jobs are cancelled. Their invoices and payments don't change.
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2">
              <input
                type="radio"
                name="bulk-cancel-invoices"
                value="void"
                checked={voidChoice === true}
                onChange={() => setVoidChoice(true)}
                className="mt-1 accent-primary"
              />
              <span>
                <span className="block text-sm">Void the unpaid invoices to $0</span>
                <span className="block text-xs text-text-secondary">
                  Voiding cannot be undone. An invoice with payments is never voided; it is kept.
                </span>
              </span>
            </label>
          </div>

          <CancelReasonFields code={reasonCode} onCodeChange={setReasonCode} note={note} onNoteChange={setNote} many={count !== 1} />
        </div>

        <DialogFooter className="gap-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Keep Open
          </Button>
          <Button
            variant="solid" tone="danger"
            onClick={() => voidChoice !== null && onConfirm(reasonCode, note.trim(), voidChoice)}
            disabled={!reasonCode || isPending || voidChoice === null}
            disabledReason={!reasonCode ? 'Choose a reason' : voidChoice === null ? 'Choose what happens to the open invoices' : undefined}
          >
            {isPending ? 'Cancelling...' : count === 1 ? 'Cancel Job' : `Cancel ${count} jobs`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
