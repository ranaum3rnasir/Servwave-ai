/**
 * LowStockView — the authoritative low-stock list (Inventory P5 §1).
 *
 * Server-computed per (item, location): every row is a StockBalance with a
 * configured min where on_hand < min (GET /api/inventory/low-stock). Unlike the
 * Stock page's KPI/filter detection this is NOT capped at the 100-item client
 * window. Each row bridges into P2's generate-PO-from-low-stock flow by
 * synthesizing Item objects for the existing GeneratePODialog (which re-derives
 * proposals via buildLowStockProposal — grouping/qty logic reused verbatim).
 */
import { useMemo, useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, ShoppingCart } from "lucide-react";
import { useLowStock, useLocations } from "@/lib/api/inventory";
import type { Item, LowStockRow } from "@/lib/api/inventory";
import { useAppAbility } from "@/contexts/AbilityContext";
import { SelectField } from "@/components/form/SelectField";
import { GeneratePODialog } from "@/components/inventory/GeneratePODialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";

/** Fractional Decimal quantities — render with up to 2 decimals. */
function fmtQty(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/**
 * Synthesize seam Items from low-stock rows so GeneratePODialog's proposal
 * builder (buildLowStockProposal → isLowStock) sees exactly the offending
 * stock rows, aggregated per item across locations. Only the fields the
 * builder reads are meaningful (id/sku/name/vendor/kind/status/stock);
 * the rest are benign defaults. Exported for tests.
 */
export function toProposalItems(rows: LowStockRow[]): Item[] {
  const byItem = new Map<string, Item>();
  for (const r of rows) {
    const existing = byItem.get(r.itemId);
    const item: Item =
      existing ??
      ({
        id: r.itemId,
        sku: r.sku,
        name: r.name,
        category: "",
        trade: "security",
        kind: (r.kind as Item["kind"]) ?? "material",
        uom: "ea",
        sellPrice: 0,
        serialized: false,
        hazmat: false,
        status: (r.status as Item["status"]) ?? "active",
        vendor: r.vendorName ?? "",
        stock: [],
        updatedAt: "",
      } as Item);
    item.stock.push({
      locationId: r.locationId,
      onHand: r.onHand,
      min: r.min,
      max: r.max ?? undefined,
    });
    byItem.set(r.itemId, item);
  }
  return [...byItem.values()];
}

export function LowStockView() {
  const ability = useAppAbility();
  const canCreatePO = ability.can("create", "PurchaseOrder");

  const [locationId, setLocationId] = useState<string>("all");
  const [page, setPage] = useState(1);
  const lowStockQuery = useLowStock({
    locationId: locationId === "all" ? undefined : locationId,
    page,
  });
  const { data: locations = [] } = useLocations();

  const rows = useMemo(() => lowStockQuery.data?.data ?? [], [lowStockQuery.data]);
  const meta = lowStockQuery.data?.meta;

  // null = closed; otherwise the synthetic Item scope handed to the dialog.
  const [dialogItems, setDialogItems] = useState<Item[] | null>(null);

  function openForItem(row: LowStockRow) {
    // The row plus its sibling locations for the same item (from the fetched page).
    setDialogItems(toProposalItems(rows.filter((r) => r.itemId === row.itemId)));
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="border-b border-border bg-surface-light px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            {/* tracking-tight dropped: Heading has no letter-spacing axis (heading.tsx
                header comment, "NOT COVERED, DELIBERATELY"). scale/weight/tone otherwise
                match this h1's rendered look exactly (all default values). */}
            <Heading>Low stock</Heading>
            <p className="mt-0.5 text-sm text-text-secondary">
              Every item-location below its configured minimum
              {meta ? ` · ${meta.total} row${meta.total === 1 ? "" : "s"}` : ""} —
              server-computed, not capped at the Stock page&apos;s 100-item window
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-56">
              <SelectField
                aria-label="Filter by location"
                value={locationId}
                onValueChange={(v) => {
                  setLocationId(v);
                  setPage(1);
                }}
                options={[
                  { value: "all", label: "All locations" },
                  ...locations.map((l) => ({ value: l.id, label: l.name })),
                ]}
              />
            </div>
            {/* Raw by design: a brand-tinted outline button (border-primary/30,
                bg-primary-subtle, text-primary) - no minted outline/brand
                cell exists (outline only has neutral + danger tones). */}
            {canCreatePO && rows.length > 0 && (
              <button
                onClick={() => setDialogItems(toProposalItems(rows))}
                className="inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary-subtle px-3 py-1.5 text-sm font-medium text-primary hover:bg-primary/10"
              >
                <ShoppingCart className="h-4 w-4" />
                Generate PO (all)
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="p-6">
        <div className="overflow-x-auto rounded-card border border-border bg-surface-light shadow-card">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="bg-background-light text-left text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
                <th className="border-b-2 border-border px-4 py-2">Item</th>
                <th className="border-b-2 border-border px-4 py-2">Location</th>
                <th className="border-b-2 border-border px-4 py-2 text-right">On hand</th>
                <th className="border-b-2 border-border px-4 py-2 text-right">Min</th>
                <th className="border-b-2 border-border px-4 py-2 text-right">Max</th>
                <th className="border-b-2 border-border px-4 py-2">Vendor</th>
                {canCreatePO && <th className="border-b-2 border-border px-4 py-2" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={`${r.itemId}-${r.locationId}`} className="hover:bg-background-light">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <div className="min-w-0">
                        <code className="font-mono text-[11px] text-text-secondary">{r.sku}</code>
                        <p className="truncate font-medium text-text-primary">{r.name}</p>
                      </div>
                      {!r.isActive && (
                        <span className="rounded-full bg-background-light px-1.5 py-0.5 text-[10px] font-semibold text-text-secondary ring-1 ring-border">
                          inactive
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-text-primary">{r.locationName}</td>
                  <td className="px-4 py-2.5 text-right">
                    <span className="inline-flex items-center gap-1 font-mono font-semibold text-warning">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      {fmtQty(r.onHand)}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-text-primary">{r.min}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-text-secondary">
                    {r.max ?? "—"}
                  </td>
                  <td className="px-4 py-2.5 text-text-secondary">{r.vendorName ?? "—"}</td>
                  {canCreatePO && (
                    <td className="px-4 py-2.5 text-right">
                      <Button
                        variant="outline"
                        size="3xs"
                        onClick={() => openForItem(r)}
                        aria-label={`Generate PO for ${r.name}`}
                      >
                        <ShoppingCart className="h-3.5 w-3.5 text-primary" />
                        Generate PO
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td
                    colSpan={canCreatePO ? 7 : 6}
                    className="px-6 py-16 text-center text-sm text-text-secondary"
                  >
                    <EmptyState
                      title={
                        lowStockQuery.isLoading
                          ? "Loading low-stock items…"
                          : "Nothing is below its minimum threshold."
                      }
                    />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {meta && meta.totalPages > 1 && (
          <div className="mt-3 flex items-center justify-end gap-2 text-sm text-text-secondary">
            <Button
              variant="outline"
              size="3xs"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              aria-label="Previous page"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span>
              Page {meta.page} of {meta.totalPages}
            </span>
            <Button
              variant="outline"
              size="3xs"
              onClick={() => setPage((p) => Math.min(meta.totalPages, p + 1))}
              disabled={page >= meta.totalPages}
              aria-label="Next page"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>

      <GeneratePODialog
        open={dialogItems !== null}
        onClose={() => setDialogItems(null)}
        items={dialogItems ?? []}
        locations={locations}
      />
    </div>
  );
}
