import { AlertTriangle } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import type { Item } from "@/lib/api/inventory";
import { totalOnHand } from "@/lib/api/inventory";
import { Button } from "@/components/ui/button";

type Props = {
  open: boolean;
  onClose: () => void;
  item: Item | null;
  // Delete is performed by the parent via useDeleteItem().mutate({ id }).
  onConfirm: () => void;
};

export function DeleteItemDialog({ open, onClose, item, onConfirm }: Props) {
  if (!item) return null;

  const onHand = totalOnHand(item);
  const hasStock = onHand > 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={hasStock ? "Archive item?" : "Delete item?"}
      subtitle="The item is permanently deleted if nothing references it, or archived instead if it's still in use elsewhere. Either way, an audit log entry is recorded."
      size="md"
      footer={
        <>
          <Button variant="outline" size="sm"
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            variant="solid"
            tone="danger"
            size="sm"
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {hasStock ? "Archive Item" : "Delete Item"}
          </Button>
        </>
      }
    >
      <div className="flex gap-3">
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-danger/10">
          <AlertTriangle className="h-5 w-5 text-danger" />
        </div>
        <div className="flex-1">
          <p className="text-sm text-text-secondary">
            {hasStock ? "Archive" : "Delete"}{" "}
            <span className="font-semibold text-text-primary">{item.name}</span>{" "}
            <code className="rounded bg-background-light px-1.5 py-0.5 font-mono text-xs">
              {item.sku}
            </code>
            ?
          </p>

          {hasStock && (
            <div className="mt-3 rounded-md border border-warning/20 bg-warning/10 p-3 text-xs text-warning">
              <p className="font-semibold">⚠ Stock exists for this item.</p>
              <ul className="mt-1 space-y-0.5 text-warning">
                <li>
                  · {onHand} on-hand across {item.stock.length} locations
                </li>
                <li>
                  · Because it still has on-hand stock, this item will be
                  archived, not permanently deleted.
                </li>
              </ul>
            </div>
          )}

          <div className="mt-3 rounded-md bg-background-light p-3 text-xs text-text-secondary">
            <p className="font-medium text-text-primary">What happens:</p>
            <ul className="mt-1 space-y-0.5">
              <li>
                · If nothing else references this item, it's permanently
                deleted. If it's still referenced (stock, a PO, an estimate,
                a job, etc.), it's archived instead.
              </li>
              <li>
                · Archived items are hidden from the Items grid and pickers,
                but can be restored any time via "Show archived" and the
                Restore action on the row - no time limit.
              </li>
              <li>
                · Past invoices, jobs, estimates, and POs are unaffected -
                they store their own snapshot of this item's name and price.
              </li>
              <li>· An audit log entry is recorded either way.</li>
            </ul>
          </div>
        </div>
      </div>
    </Modal>
  );
}
