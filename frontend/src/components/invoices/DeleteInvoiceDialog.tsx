import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import api from '@/lib/axios';
import { extractApiError } from '@/lib/utils';
import { useLogisticOrders, type LogisticOrderListRow } from '@/lib/api/logisticOrders';
import { useModuleAccess } from '@/lib/entitlements';
import { StatusBadge } from '@/components/data/status-badge';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';

interface DeleteInvoiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoiceId: string;
  syncedLineCount: number;
  onSuccess: () => void;
}

/** Mirrors CancelJobDialog's loConsequence — a PROCESSED LO returns its stock on delete
 *  (E13), open orders are untouched (invoice delete cascades no LO status change), and
 *  already-terminal orders show no change. */
function loConsequence(lo: LogisticOrderListRow): string {
  if (lo.status === 'PROCESSED') {
    return `returns ${lo.lineCount} item${lo.lineCount === 1 ? '' : 's'} to stock`;
  }
  if (lo.status === 'CANCELLED' || lo.status === 'RETURNED') return 'no change';
  return 'no change';
}

export function DeleteInvoiceDialog({
  open,
  onOpenChange,
  invoiceId,
  syncedLineCount,
  onSuccess,
}: DeleteInvoiceDialogProps) {
  const queryClient = useQueryClient();

  // LO §5-style consequence list — lazy (enabled:open); 403s for non-readers resolve to no
  // rows (retry:false in the hook), degrading to the plain confirmation.
  // Also skipped without the Scale `inventory` entitlement or LogisticOrder read grant: the
  // route 402s/403s there, and an org/user that cannot read Logistic Orders has none to warn
  // about. Deleting the invoice stays fully available (SRVW-94, mirroring CancelJobDialog).
  const canUseLogisticOrders = useModuleAccess('inventory', 'read', 'LogisticOrder');
  const { data: loData } = useLogisticOrders(
    { invoice_id: invoiceId },
    { enabled: open && canUseLogisticOrders },
  );
  const loRows = loData?.data ?? [];

  const mutation = useMutation({
    mutationFn: async () => {
      await api.delete(`/api/invoices/${invoiceId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['logistic-orders'] });
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      onOpenChange(false);
      onSuccess();
    },
  });

  return (
    <Modal
      open={open}
      onClose={() => onOpenChange(false)}
      title="Delete Invoice"
      subtitle="This action cannot be undone."
      width="sm"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button variant="solid" tone="danger" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {mutation.isPending ? 'Deleting...' : 'Delete Invoice'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {loRows.length > 0 && (
          <div className="space-y-2 rounded-lg border border-border bg-background-light p-3 text-sm">
            <p className="font-medium text-text-primary">Logistic orders on this invoice</p>
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

        {syncedLineCount > 0 && (
          <div className="flex gap-2 rounded-lg border border-warning/20 bg-warning/10 p-3 text-sm text-warning">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{syncedLineCount} synced inventory item(s) will be returned to stock.</span>
          </div>
        )}

        {mutation.error && (
          <p className="text-sm text-danger">
            {extractApiError(mutation.error, 'Failed to delete invoice')}
          </p>
        )}
      </div>
    </Modal>
  );
}
