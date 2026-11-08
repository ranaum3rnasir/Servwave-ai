import { AlertOctagon, Archive, Trash2 } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import type { Item, Vendor, PurchaseOrder } from "@/lib/api/inventory";
import { Button } from "@/components/ui/button";

type Props = {
  open: boolean;
  onClose: () => void;
  vendor: Vendor | null;
  items: Item[];
  pos: PurchaseOrder[];
  onDelete: (vendorId: string) => void;
  onArchive: (vendorId: string) => void;
};

export function DeleteVendorDialog({
  open,
  onClose,
  vendor,
  items,
  pos,
  onDelete,
  onArchive,
}: Props) {
  if (!vendor) return null;

  const openPOStatuses: PurchaseOrder["status"][] = [
    "draft",
    "ordered",
    "partial",
  ];
  const openPOs = pos.filter(
    (p) =>
      (p.vendorId ? p.vendorId === vendor.id : p.vendor === vendor.name) &&
      openPOStatuses.includes(p.status),
  );
  const linkedItems = items.filter((i) => i.vendor === vendor.name);
  const isBlocked = openPOs.length > 0 || linkedItems.length > 0;

  function handleArchive() {
    onArchive(vendor!.id);
    onClose();
  }

  function handleDelete() {
    onDelete(vendor!.id);
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Archive vendor · ${vendor.name}`}
      subtitle={
        isBlocked
          ? "This vendor is still in use — archiving keeps history intact."
          : "Archiving hides the vendor from pickers; history stays intact."
      }
      size="lg"
      footer={
        <>
          <Button variant="outline" size="sm"
            onClick={onClose}
          >
            Cancel
          </Button>
          {/* Archive-first (QA-610/A-17): archiving is ALWAYS the primary action;
              hard delete demotes to a small link-button in the unblocked branch
              only. The client `isBlocked` heuristic is advisory — the server's
              409 VENDOR_HAS_POS is the real guard. */}
          {!isBlocked && (
            // Raw by design: a danger-toned text link (hover:underline, no
            // background) — no minted link/danger cell exists (link only has
            // brand), and ghost/danger would add an unwanted hover background
            // while dropping the underline.
            <button
              onClick={handleDelete}
              className="px-2 py-1.5 text-xs font-medium text-danger hover:underline"
            >
              <Trash2 className="mr-1 inline h-3 w-3" />
              Delete permanently
            </button>
          )}
          {/* Raw by design: no `warning` tone is minted on Button (see
              button.tsx header note - deferred, zero measured call sites);
              forcing danger or another tone would change the semantic colour
              from warning-amber to something else. */}
          <button
            onClick={handleArchive}
            className="inline-flex items-center gap-1.5 rounded-md bg-warning px-3 py-1.5 text-sm font-semibold text-on-fill shadow-sm hover:bg-warning"
            title="Soft-archive — keep history but hide from active lists"
          >
            <Archive className="h-3.5 w-3.5" />
            Archive vendor
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {isBlocked ? (
          <div className="rounded-md border border-danger/20 bg-danger/10 p-3">
            <p className="flex items-center gap-1.5 text-sm font-semibold text-danger">
              <AlertOctagon className="h-4 w-4" />
              Cannot delete — vendor is still in use
            </p>
            <p className="mt-1 text-xs text-danger">
              This vendor has purchase orders — vendors with POs archive instead
              (the server refuses deletion). Archiving keeps it linked to
              historical POs but hides it from active pickers.
            </p>
          </div>
        ) : (
          <div className="rounded-md border border-success/20 bg-success/10 p-3 text-xs text-success">
            No open POs and no inventory items reference this vendor. Deletion
            is safe.
          </div>
        )}

        {openPOs.length > 0 && (
          <div className="rounded-md border border-border bg-surface-light">
            <p className="border-b border-border px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
              {openPOs.length} open purchase order
              {openPOs.length === 1 ? "" : "s"}
            </p>
            <ul className="divide-y divide-border">
              {openPOs.map((po) => (
                <li
                  key={po.id}
                  className="flex items-center justify-between px-3 py-1.5 text-xs"
                >
                  <span>
                    <code className="font-mono font-semibold text-text-primary">
                      {po.poNumber}
                    </code>
                    {po.jobNumber && (
                      <span className="ml-2 text-text-secondary">
                        Job {po.jobNumber} · {po.customer ?? ""}
                      </span>
                    )}
                  </span>
                  <span className="rounded-full bg-background-light px-2 py-0.5 text-[9px] font-semibold uppercase text-text-secondary ring-1 ring-border">
                    {po.status}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {linkedItems.length > 0 && (
          <div className="rounded-md border border-border bg-surface-light">
            <p className="border-b border-border px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
              {linkedItems.length} inventory item
              {linkedItems.length === 1 ? "" : "s"} list this vendor
            </p>
            <ul className="divide-y divide-border">
              {linkedItems.slice(0, 6).map((i) => (
                <li
                  key={i.id}
                  className="flex items-center gap-2 px-3 py-1.5 text-xs"
                >
                  <code className="font-mono text-text-secondary">{i.sku}</code>
                  <span className="truncate text-text-secondary">{i.name}</span>
                </li>
              ))}
              {linkedItems.length > 6 && (
                <li className="px-3 py-1.5 text-[11px] italic text-text-secondary">
                  + {linkedItems.length - 6} more…
                </li>
              )}
            </ul>
          </div>
        )}

        {!isBlocked && (
          <div className="rounded-md border border-warning/20 bg-warning/10 p-3 text-xs text-warning">
            Heads up: hard-delete is permanent. If you want this vendor back
            later, you'll have to re-create it. Prefer soft-archive when in
            doubt.
          </div>
        )}
      </div>
    </Modal>
  );
}
