// Pop-out shown when a low_stock or backorder alert row is clicked from
// the TopBar bell. Surfaces the item + per-location stock + a primary
// "Restock now" CTA so the operator can act in one click instead of
// scanning the filtered list. Walking away (Close) keeps the underlying
// Items tab filtered + the item selected in the side drawer so the
// alternative path "browse to it" is still right there.
//
// Per PRD §5.4.A.ix v4.

import { Boxes, Package, ShoppingCart, Truck, Warehouse } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { UploadedImage } from "@/components/ui/uploaded-image";
import type { Item, Location } from "@/lib/api/inventory";
import { Button } from "@/components/ui/button";

type Props = {
  open: boolean;
  onClose: () => void;
  item: Item | null;
  locations: Location[];
  // "low_stock" → restock CTA copy says "Restock now"; "backorder" → "Restock now"
  // (vendor already owes us product) + a small amber note that the vendor is overdue.
  kind: "low_stock" | "backorder";
  /** #2043 - optional in the same shape as `onGeneratePO` below: only passed
   *  when the viewer holds `update Inventory` (`POST /api/inventory/restock`). */
  onRestock?: () => void;
  /** Inventory P2 (D16 entry #3): opens the Generate-PO proposals dialog. Only
   *  passed when the viewer holds `create PurchaseOrder`; "Restock now" (manual
   *  receipt) stays the primary for the bell-alert flow. */
  onGeneratePO?: () => void;
};

function locIcon(type?: string) {
  if (type === "warehouse")
    return <Warehouse className="h-3.5 w-3.5 text-text-secondary" />;
  if (type === "truck")
    return <Truck className="h-3.5 w-3.5 text-text-secondary" />;
  if (type === "counter")
    return <Boxes className="h-3.5 w-3.5 text-text-secondary" />;
  return <Package className="h-3.5 w-3.5 text-text-secondary" />;
}

export function LowStockActionDialog({
  open,
  onClose,
  item,
  locations,
  kind,
  onRestock,
  onGeneratePO,
}: Props) {
  if (!item) return null;

  const locName = new Map(locations.map((l) => [l.id, l]));
  const offendingLocations = item.stock
    .filter((s) => s.min != null && s.onHand < s.min)
    .map((s) => ({ s, loc: locName.get(s.locationId) }));
  const totalOnHand = item.stock.reduce((sum, s) => sum + s.onHand, 0);

  const title =
    kind === "backorder"
      ? `On backorder · ${item.sku}`
      : `Low stock · ${item.sku}`;
  const subtitle =
    kind === "backorder"
      ? `Vendor ${item.vendor} owes us product — chase the order or restock from another source.`
      : `One or more locations dropped below their reorder threshold.`;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      size="md"
      footer={
        <>
          <Button variant="outline" size="sm"
            onClick={onClose}
            title="Close this pop-up — the item stays filtered in the list so you can come back to it"
          >
            Close
          </Button>
          {onGeneratePO && (
            <Button variant="outline" size="sm"
              onClick={onGeneratePO}
              className="inline-flex items-center gap-1.5"
              title="Propose draft purchase orders for everything below its reorder threshold"
            >
              <ShoppingCart className="h-3.5 w-3.5" />
              Generate PO
            </Button>
          )}
          {onRestock && (
            <Button size="sm"
              onClick={onRestock}
            >
              <Package className="h-3.5 w-3.5" />
              Restock now
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        {/* Item card */}
        <div className="flex items-center gap-3 rounded-md border border-border bg-surface-light p-3">
          {item.photoUrl ? (
            <UploadedImage
              src={item.photoUrl}
              alt={item.name}
              radius="sm"
              edge="border"
              className="h-14 w-14 shrink-0"
            />
          ) : (
            <div className="grid h-14 w-14 shrink-0 place-items-center rounded border border-border bg-background-light text-[10px] font-semibold text-text-secondary">
              {item.sku.slice(0, 3)}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-text-primary">
              {item.name}
            </p>
            <p className="mt-0.5 text-[11px] text-text-secondary">
              {item.category} · {item.uom} · vendor {item.vendor}
            </p>
            <p className="mt-1 text-[11px] text-text-secondary">
              <span className="font-medium">{totalOnHand}</span> on hand across{" "}
              {item.stock.length}{" "}
              {item.stock.length === 1 ? "location" : "locations"}
            </p>
          </div>
        </div>

        {/* Offending locations table */}
        {kind === "low_stock" && offendingLocations.length > 0 && (
          <div className="rounded-md border border-warning/20 bg-warning/10">
            <p className="border-b border-warning/20 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-warning">
              Below reorder threshold
            </p>
            <ul className="divide-y divide-warning">
              {offendingLocations.map(({ s, loc }) => (
                <li
                  key={s.locationId}
                  className="flex items-center justify-between gap-2 px-3 py-1.5 text-[12px]"
                >
                  <span className="flex items-center gap-1.5 text-text-secondary">
                    {locIcon(loc?.type)}
                    {loc?.name ?? s.locationId}
                  </span>
                  <span className="font-mono text-text-primary">
                    {s.onHand}
                    <span className="text-text-secondary"> / {s.min} min</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {kind === "backorder" && (
          <div className="rounded-md border border-danger/20 bg-danger/10 px-3 py-2 text-[12px] text-danger">
            This item's vendor delivery is overdue. <strong>Restock</strong> writes
            an immediate receipt against a manual count or alternate-source
            vendor; the existing back-ordered PO line stays open so you don't
            double-pay.
          </div>
        )}

        <p className="text-[10.5px] text-text-secondary">
          Walking away? Close this pop-up — the item stays filtered + selected
          on the Items tab so you can come back to it without re-finding it.
        </p>
      </div>
    </Modal>
  );
}
