import { useReceivePO, useLocations } from '@/lib/api/inventory';
import type { PurchaseOrder } from '@/lib/api/inventory';
import type { ReceiveSubmit } from '@/components/inventory/PODetailDialog';
import { extractApiError } from '@/lib/utils';
import { toast } from '@/ui-kit/components/ui/sonner';

/**
 * Receiving against a purchase order from its detail dialog: the save, the success toast and the server's refusals as
 * toasts. Shared by the Purchase Orders page and the single-order page a link from a job opens, so the dialog behaves
 * the same wherever it is mounted. `onReceived` gets the server's order, which the host swaps into what it shows.
 */
export function usePurchaseOrderReceive(onReceived: (po: PurchaseOrder) => void) {
  const receivePO = useReceivePO();
  // Resolves the receive destination's display name for the success toast.
  const { data: locations = [] } = useLocations();

  return function handleReceive(event: ReceiveSubmit) {
    receivePO.mutate(event, {
      onSuccess: (r) => {
        const serverPO = r.purchaseOrder;
        onReceived(serverPO);
        const locationName = locations.find((l) => l.id === event.destinationLocationId)?.name ?? 'stock';
        toast(`✓ ${serverPO.poNumber} updated · received into ${locationName}`);
      },
      onError: (err) => {
        // Matches the real server contracts (inv-po.controller.receivePurchaseOrder):
        //   400 OVER_RECEIVE       -> { error, item_sku, qty_ordered, qty_received }
        //   409 STAGED_PO          -> { error, message, staged_skus: string[] }
        //   409 NO_STOCK_LOCATION  -> { error, message }
        const data = (err as {
          response?: {
            data?: {
              error?: string;
              message?: string;
              item_sku?: string;
              qty_ordered?: number;
              qty_received?: number;
              staged_skus?: string[];
            };
          };
        })?.response?.data;

        if (data?.error === 'OVER_RECEIVE') {
          toast.error("Received can't exceed ordered", {
            description: data.item_sku
              ? `${data.item_sku}: tried to receive ${data.qty_received ?? '?'}, only ${data.qty_ordered ?? '?'} ordered`
              : undefined,
          });
          return;
        }

        if (data?.error === 'STAGED_PO') {
          const skus = (data.staged_skus ?? []).join(', ');
          toast.error('Receive staged items from the Staging view', {
            description: skus ? `Staged line${skus.includes(',') ? 's' : ''}: ${skus}` : data.message,
          });
          return;
        }

        if (data?.error === 'NO_STOCK_LOCATION') {
          // The dialog normally catches this before the POST (no destination
          // options); the server is the authority when it slips through.
          toast.error('No inventory location yet', {
            description: data.message ?? 'Add an inventory location under Settings → Locations before receiving.',
          });
          return;
        }

        toast.error(extractApiError(err, 'Failed to save the receipt'));
      },
    });
  }
}
