import { useState } from "react";
import { AlertOctagon, Trash2 } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import type { Item, Location } from "@/lib/api/inventory";
import { Button } from "@/components/ui/button";

type Props = {
  open: boolean;
  onClose: () => void;
  location: Location | null;
  items: Item[];
  onDelete: (locationId: string) => Promise<void>;
};

export function DeleteLocationDialog({
  open,
  onClose,
  location,
  items,
  onDelete,
}: Props) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!location) return null;

  // Advisory only - the server's 409 is the real guard (it counts non-zero
  // stock_balances and the org default location, neither of which the client
  // can see in full).
  const stockedItems = items.filter((i) =>
    i.stock.some((s) => s.locationId === location.id && s.onHand > 0),
  );
  const isBlocked = stockedItems.length > 0;

  async function handleDelete() {
    setError(null);
    setBusy(true);
    try {
      await onDelete(location!.id);
      onClose();
    } catch (err: unknown) {
      const message = (err as { response?: { data?: { error?: string } } })
        .response?.data?.error;
      setError(message ?? "Could not delete this location - please try again.");
    } finally {
      setBusy(false);
    }
  }

  function handleClose() {
    setError(null);
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={`Delete location · ${location.name}`}
      subtitle="Deleting removes the location from every picker. Movement history is kept."
      size="lg"
      footer={
        <>
          <Button variant="outline" size="sm" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            variant="solid"
            tone="danger"
            size="sm"
            disabled={isBlocked || busy}
            onClick={handleDelete}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {busy ? "Deleting…" : "Delete location"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && (
          <div className="rounded-md border border-danger/20 bg-danger/10 p-3 text-xs text-danger">
            {error}
          </div>
        )}

        {isBlocked ? (
          <div className="rounded-md border border-danger/20 bg-danger/10 p-3">
            <p className="flex items-center gap-1.5 text-sm font-semibold text-danger">
              <AlertOctagon className="h-4 w-4" />
              Cannot delete - this location still holds stock
            </p>
            <p className="mt-1 text-xs text-danger">
              Transfer or zero out the stock below first. The server refuses the
              delete while any balance is non-zero.
            </p>
          </div>
        ) : (
          <div className="rounded-md border border-success/20 bg-success/10 p-3 text-xs text-success">
            No items are stocked at this location. Deletion is safe.
          </div>
        )}

        {stockedItems.length > 0 && (
          <div className="rounded-md border border-border bg-surface-light">
            <p className="border-b border-border px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
              {stockedItems.length} item{stockedItems.length === 1 ? "" : "s"}{" "}
              stocked here
            </p>
            <ul className="divide-y divide-border">
              {stockedItems.slice(0, 6).map((i) => (
                <li
                  key={i.id}
                  className="flex items-center gap-2 px-3 py-1.5 text-xs"
                >
                  <code className="font-mono text-text-secondary">{i.sku}</code>
                  <span className="truncate text-text-secondary">{i.name}</span>
                  <span className="ml-auto font-mono font-semibold text-text-primary">
                    {i.stock.find((s) => s.locationId === location.id)?.onHand}
                  </span>
                </li>
              ))}
              {stockedItems.length > 6 && (
                <li className="px-3 py-1.5 text-[11px] italic text-text-secondary">
                  + {stockedItems.length - 6} more…
                </li>
              )}
            </ul>
          </div>
        )}

        {!isBlocked && (
          <div className="rounded-md border border-warning/20 bg-warning/10 p-3 text-xs text-warning">
            Past stock movements keep their record, but they will no longer name
            this location as their source or destination. This cannot be undone.
          </div>
        )}
      </div>
    </Modal>
  );
}
