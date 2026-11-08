import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { Eye, PackagePlus, Truck } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SelectField } from "@/components/form/SelectField";
import { FormField } from "@/components/patterns/FormField";
import {
  useInventoryItems,
  usePurchaseOrders,
  useRestock,
  useTransferStock,
  type Item,
  type Location,
} from "@/lib/api/inventory";
import { useOrganization } from "@/lib/api/organization";
import { extractApiError } from "@/lib/utils";
import { extractShortage } from "@/lib/stockToasts";
import { POPreviewDialog } from "@/components/inventory/POPreviewDialog";
import { Button } from "@/components/ui/button";

type Props = {
  open: boolean;
  onClose: () => void;
  initialItemId?: string;
  locations: Location[];
  items?: Item[]; // live items from parent; falls back to seam when unset
  onSubmitted: (msg: string) => void;
};

export type RestockSource =
  | "vendor_po"
  | "manual_receive"
  | "customer_return"
  | "counted_in"
  | "truck_return";

const sources: {
  value: RestockSource;
  label: string;
  hint: string;
  needsRef?: string;
}[] = [
  {
    value: "vendor_po",
    label: "Vendor receipt (PO)",
    hint: "Backed by an open Purchase Order",
    needsRef: "PO number",
  },
  {
    value: "manual_receive",
    label: "Manual receive",
    hint: "No PO — emergency pickup, walk-in, or quick add",
    needsRef: "Packing slip / invoice #",
  },
  {
    value: "customer_return",
    label: "Customer return",
    hint: "Part returned by customer — back to stock",
    needsRef: "Job / RMA #",
  },
  {
    value: "counted_in",
    label: "Counted in (cycle count)",
    hint: "Variance discovered during cycle count",
  },
  {
    value: "truck_return",
    label: "Truck return to warehouse",
    hint: "Tech bringing unused stock back at end of day",
  },
];

export function RestockDialog({
  open,
  onClose,
  initialItemId,
  locations,
  items: itemsProp,
  onSubmitted,
}: Props) {
  // Falls back to the seam's items query when the parent doesn't pass live items.
  const { data: seedItems = [] } = useInventoryItems();
  const items = itemsProp ?? seedItems;
  const { data: purchaseOrders = [] } = usePurchaseOrders();
  const { data: org } = useOrganization();
  const restock = useRestock();
  const transferStock = useTransferStock();
  const [itemId, setItemId] = useState(initialItemId || items[0]?.id || "");

  // SRVW-92 - the destination must be a real location, never the hardcoded mock
  // seed "loc_wh_main". Prefer the org default ONLY when it still resolves against
  // the live `locations` prop (a stale/archived default would otherwise select an
  // id with no matching option and 404 the submit), else the first warehouse, else
  // the first location, else empty (which the submit guard below refuses to send).
  const defaultLocationId = useMemo(() => {
    const orgDefault = org?.default_inventory_location_id;
    if (orgDefault && locations.some((l) => l.id === orgDefault)) return orgDefault;
    return locations.find((l) => l.type === "warehouse")?.id ?? locations[0]?.id ?? "";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locations, org?.default_inventory_location_id]);

  const [locationId, setLocationId] = useState("");
  const [qty, setQty] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [source, setSource] = useState<RestockSource>("manual_receive");
  const [referenceNo, setReferenceNo] = useState("");
  const [notes, setNotes] = useState("");
  const [fromVanId, setFromVanId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [previewPONumber, setPreviewPONumber] = useState<string | null>(null);

  // If the typed reference matches an existing PO number, surface a "Preview" affordance
  const matchedPO = useMemo(() => {
    if (source !== "vendor_po") return null;
    const trimmed = referenceNo.trim();
    if (!trimmed) return null;
    return (
      purchaseOrders.find(
        (p) => p.poNumber.toLowerCase() === trimmed.toLowerCase(),
      ) ?? null
    );
  }, [referenceNo, source, purchaseOrders]);

  const item = useMemo(
    () => items.find((i) => i.id === itemId) ?? items[0],
    [itemId, items],
  );

  // Sync initial item, destination location & default cost when opening / item changes
  useEffect(() => {
    if (!open) return;
    if (initialItemId) setItemId(initialItemId);
    if (item) setUnitCost(String((item.unitCost ?? 0).toFixed(2)));
    setLocationId(defaultLocationId);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialItemId]);

  useEffect(() => {
    if (item) setUnitCost(String((item.unitCost ?? 0).toFixed(2)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId]);

  const loc = locations.find((l) => l.id === locationId);
  const currentAtLoc = item?.stock.find((s) => s.locationId === locationId);
  const currentOnHand = currentAtLoc?.onHand ?? 0;
  const newOnHand = currentOnHand + (parseInt(qty || "0", 10) || 0);
  const totalCost =
    (parseInt(qty || "0", 10) || 0) * (parseFloat(unitCost || "0") || 0);
  const activeSource = sources.find((s) => s.value === source)!;

  const vans = useMemo(
    () => locations.filter((l) => l.type === "truck"),
    [locations],
  );

  // On-hand for the chosen item at the chosen van — informs the picker subtitle
  function vanOnHand(vanId: string): number {
    return item?.stock.find((s) => s.locationId === vanId)?.onHand ?? 0;
  }

  function reset() {
    setQty("");
    if (item) setUnitCost(String((item.unitCost ?? 0).toFixed(2)));
    setSource("manual_receive");
    setReferenceNo("");
    setNotes("");
    setFromVanId("");
    setError(null);
  }

  async function submit() {
    if (!item) return setError("No item selected.");
    if (!locationId) return setError("Pick a destination location.");
    const q = parseInt(qty || "0", 10);
    const c = parseFloat(unitCost || "0");
    if (!q || q <= 0) return setError("Quantity must be greater than 0.");
    if (c < 0) return setError("Unit cost can't be negative.");
    if (activeSource.needsRef && !referenceNo.trim())
      return setError(`${activeSource.needsRef} is required for this source.`);
    if (source === "truck_return" && !fromVanId)
      return setError("Pick which van the stock is coming from.");
    if (source === "truck_return" && fromVanId === locationId)
      return setError("Source van and destination must be different.");
    if (restock.isPending || transferStock.isPending) return;
    setError(null);

    // Gating on `needsRef` here (not just on the source-chip click) is the
    // authoritative fix - it is what actually stops a stale typed reference
    // (e.g. "PO-2261" typed under Vendor receipt) from persisting onto a
    // cycle-count or truck-return ledger row after the source is switched.
    const ref = activeSource.needsRef ? referenceNo.trim() || undefined : undefined;
    // `item.unitCost == null` is the exact signal that the server stripped costs
    // from this response (a costed user's unitCost is never undefined - a null
    // DB column maps to 0). Omit the key entirely rather than send the prefilled
    // 0, which the server would otherwise persist as a literal 0.00 cost.
    const costFields = item.unitCost == null ? {} : { unitCost: c };
    const locName = locations.find((l) => l.id === locationId)?.name ?? "location";

    try {
      if (source === "truck_return") {
        await transferStock.mutateAsync({
          itemId: item.id,
          fromId: fromVanId,
          toId: locationId,
          qty: q,
          reason: notes.trim() ? `Truck return · ${notes.trim()}` : "Truck return",
        });
      } else {
        await restock.mutateAsync({
          itemId: item.id,
          locationId,
          qty: q,
          ...costFields,
          source,
          reference: ref,
          notes: notes.trim() || undefined,
        });
      }
    } catch (err: unknown) {
      const shortage = extractShortage(err);
      if (shortage) {
        setError(`Not enough stock at the source - ${shortage.available} available.`);
      } else {
        setError(extractApiError(err, "Could not record the receipt - try again."));
      }
      return;
    }

    onSubmitted(`✓ Received ${q} × ${item.sku} into ${locName}`);
    reset();
    onClose();
  }

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title="Restock Inventory"
        subtitle={
          source === "truck_return"
            ? "Posts an immutable stock_movement entry (type: transfer) - moves on-hand from the van to the destination."
            : "Posts an immutable stock_movement entry (type: receive) and adds to on-hand at the destination."
        }
        size="lg"
        footer={
          <>
            <Button variant="outline" size="sm"
              onClick={onClose}
            >
              Cancel
            </Button>
            {/* --success and --sage-700 share the same RGB (tokens.css), so
                solid/business reproduces this CTA's background exactly. */}
            <Button variant="solid" tone="business" size="sm"
              onClick={submit}
              disabled={restock.isPending || transferStock.isPending}
            >
              <PackagePlus className="h-3.5 w-3.5" />
              {restock.isPending || transferStock.isPending
                ? "Receiving…"
                : `Receive ${qty || "0"} ${item?.uom ?? ""}`}
            </Button>
          </>
        }
      >
        {error && (
          <div className="mb-3 rounded-md border border-danger/20 bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </div>
        )}

        <div className="flex flex-col gap-4">
          {/* Item + Location */}
          {/* Not converted to FormField: SelectField's own API has no `id`
              and does not spread the rest of its props onto the trigger, so
              FormField's generated id would reach no element and the label
              would point at nothing (same structural block as LeadFormPage's
              TimeSelect deferral). The local `Field` helper stays defined
              for this and the three other SelectField/segmented-control
              sites below. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Item">
              <SelectField
                aria-label="Item"
                value={itemId}
                onValueChange={setItemId}
                className={selectCls}
                options={items
                  .filter((i) => i.kind === "material")
                  .map((i) => ({ value: i.id, label: `${i.sku} — ${i.name}` }))}
              />
            </Field>
            <Field label="Receive into Location">
              <SelectField
                aria-label="Receive into location"
                value={locationId}
                onValueChange={setLocationId}
                className={selectCls}
                options={locations.map((l) => ({
                  value: l.id,
                  label: `${l.name}${l.type === "truck" && l.primaryTech ? ` · ${l.primaryTech}` : ""}`,
                }))}
              />
            </Field>
          </div>

          {/* Source pill selector */}
          {/* Not converted to FormField: a segmented toggle-chip row (multiple
              buttons acting as one radio group) plus a trailing hint
              paragraph, not a single control cloneElement or the render-prop
              form can hand one id to - the same radio/toggle-row shape
              FormField's own header comment excludes. */}
          <Field label="Source">
            {/* Deferred: segmented toggle-chip row — not Button-shaped. */}
            <div className="flex flex-wrap gap-1.5">
              {sources.map((s) => {
                const active = source === s.value;
                return (
                  <button
                    key={s.value}
                    type="button"
                    onClick={() => {
                      setSource(s.value);
                      // UI-consistency half of the stale-reference fix - the
                      // authoritative half is the needsRef gate in submit().
                      if (!s.needsRef) setReferenceNo("");
                    }}
                    className={[
                      "rounded-md border px-2.5 py-1.5 text-xs font-medium transition",
                      active
                        ? "border-primary bg-primary-subtle text-primary ring-1 ring-primary/20"
                        : "border-border bg-surface-light text-text-secondary hover:bg-background-light",
                    ].join(" ")}
                    title={s.hint}
                  >
                    {s.label}
                  </button>
                );
              })}
            </div>
            <p className="mt-1 text-[11px] text-text-secondary">
              {activeSource.hint}
            </p>
          </Field>

          {/* From-van picker — only when source = truck_return */}
          {/* Not converted to FormField: SelectField non-forwarding (see the
              Item/Receive-into-Location comment above) - blocked regardless
              of the no-vans-configured branch above it. */}
          {source === "truck_return" && (
            <Field label="From which van" required>
              {vans.length === 0 ? (
                <p className="rounded-md border border-warning/20 bg-warning/10 px-2.5 py-1.5 text-[11px] text-warning">
                  No vans configured. Add a Truck-type location to record returns.
                </p>
              ) : (
                <>
                  <SelectField
                    aria-label="From which van"
                    value={fromVanId || "NONE"}
                    onValueChange={(v) => setFromVanId(v === "NONE" ? "" : v)}
                    className={selectCls}
                    options={[
                      { value: "NONE", label: "Select a van…" },
                      ...vans.map((v) => {
                        const isDest = v.id === locationId;
                        return {
                          value: v.id,
                          label: `🚚 ${v.name}${v.primaryTech ? ` · ${v.primaryTech}` : ""} · ${vanOnHand(v.id)} on hand${isDest ? " (destination)" : ""}`,
                          disabled: isDest,
                        };
                      }),
                    ]}
                  />
                  {fromVanId && (
                    <p className="mt-1 text-[11px] text-text-secondary">
                      Will decrement{" "}
                      <span className="font-mono">{qty || "0"}</span> {item?.uom} from{" "}
                      <span className="font-medium text-text-primary">
                        {vans.find((v) => v.id === fromVanId)?.name}
                      </span>
                      {" "}and add to{" "}
                      <span className="font-medium text-text-primary">
                        {loc?.name}
                      </span>
                      .
                    </p>
                  )}
                </>
              )}
            </Field>
          )}

          {/* Qty + Cost + Reference */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <FormField label={`Quantity (${item?.uom ?? ""})`} required gap={1}>
              <Input
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                type="number"
                min="1"
                step="1"
                placeholder="0"
                className={inputCls}
                autoFocus
              />
            </FormField>
            {source !== "truck_return" && item?.unitCost != null ? (
              <FormField
                label="Unit Cost ($)"
                gap={1}
                hint="Recorded on this receipt only - it does not change the catalog cost."
              >
                <Input
                  value={unitCost}
                  onChange={(e) => setUnitCost(e.target.value)}
                  type="number"
                  step="0.01"
                  min="0"
                  className={inputCls}
                />
              </FormField>
            ) : (
              <div />
            )}
            {activeSource.needsRef ? (
              <FormField label={activeSource.needsRef} required gap={1}>
                {(fieldProps) => (
                  <>
                    <div className="flex items-center gap-1.5">
                      <Input
                        {...fieldProps}
                        value={referenceNo}
                        onChange={(e) => setReferenceNo(e.target.value)}
                        placeholder={
                          source === "vendor_po"
                            ? "PO-2261"
                            : source === "manual_receive"
                              ? "Slip #"
                              : "J-1842 / RMA #"
                        }
                        className={`${inputCls} flex-1`}
                        list={source === "vendor_po" ? "restock-po-list" : undefined}
                      />
                      {source === "vendor_po" && (
                        <Button variant="outline" tone="neutral" size="3xs"
                          type="button"
                          onClick={() => {
                            if (matchedPO) setPreviewPONumber(matchedPO.poNumber);
                          }}
                          disabled={!matchedPO}
                          className="gap-1"
                          title={matchedPO ? `Preview ${matchedPO.poNumber} as PDF · print` : "Type a known PO# to preview"}
                        >
                          <Eye className="h-3 w-3 text-primary" />
                          Preview
                        </Button>
                      )}
                    </div>
                    {source === "vendor_po" && (
                      <datalist id="restock-po-list">
                        {purchaseOrders.map((p) => (
                          <option key={p.id} value={p.poNumber}>
                            {p.vendor} · {p.lines.length} ln
                          </option>
                        ))}
                      </datalist>
                    )}
                  </>
                )}
              </FormField>
            ) : (
              <div />
            )}
          </div>

          <FormField label="Notes" gap={1}>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              maxLength={1000}
              placeholder="Optional · special handling, who received, condition notes"
              className={`${inputCls} resize-none`}
            />
          </FormField>

          {/* Live preview */}
          {loc && (
            <div className="rounded-md border border-success/20 bg-success/10 px-3 py-2.5">
              <div className="flex items-baseline justify-between">
                <p className="text-xs font-semibold uppercase tracking-wide text-success">
                  Preview
                </p>
                {source !== "truck_return" && item?.unitCost != null && (
                  <p className="font-mono text-[11px] text-success">
                    Total cost ${totalCost.toFixed(2)}
                  </p>
                )}
              </div>
              <div className="mt-1 flex items-center gap-2 text-sm">
                {loc.type === "truck" && (
                  <Truck className="h-4 w-4 text-success" />
                )}
                <span className="font-medium text-text-primary">{loc.name}</span>
                <span className="text-text-secondary">·</span>
                <span className="font-mono text-text-secondary">
                  {currentOnHand}
                </span>
                <span className="text-text-secondary">→</span>
                <span className="font-mono font-semibold text-success">
                  {newOnHand}
                </span>
                <span className="text-xs text-text-secondary">
                  {item?.uom} on hand after receive
                </span>
              </div>
              {item?.serialized && (
                <p className="mt-1.5 text-[11px] text-warning">
                  ⚠ Serialized item — you'll be prompted to scan each serial after
                  save.
                </p>
              )}
            </div>
          )}
        </div>
      </Modal>

      <POPreviewDialog
        open={!!previewPONumber}
        onClose={() => setPreviewPONumber(null)}
        poNumber={previewPONumber}
        zIndex={80}
        lockEscape
      />
    </>
  );
}

// Input/Textarea now own their own border/radius/background/focus-ring
// appearance (design-system layering guard) - this constant is layout-only.
const inputCls = "w-full px-2.5 py-1.5";
const selectCls =
  "w-full rounded-md border border-border bg-surface-light px-2.5 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">
        {label}
        {required && <span className="ml-0.5 text-danger">*</span>}
      </span>
      {children}
    </label>
  );
}
