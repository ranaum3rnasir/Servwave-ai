import { useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { ArrowRight, Briefcase, Eye, FileText, Package, Truck } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { POPreviewDialog } from "@/components/inventory/POPreviewDialog";
import { SelectField } from "@/components/form/SelectField";
import { FormField } from "@/components/patterns/FormField";
import { EmptyState } from "@/components/ui/empty-state";
import {
  useInventoryJobs,
  usePurchaseOrders,
  type Item,
  type Location,
  type PurchaseOrder,
  type InventoryJob,
} from "@/lib/api/inventory";
import { Button } from "@/components/ui/button";
import { formatExactDay } from "@/lib/format-date";

type Props = {
  open: boolean;
  onClose: () => void;
  /** The catalog the PARENT is showing. Deliberately a prop, not a
   *  `useInventoryItems()` call of our own: the page fetches with
   *  `useInventoryItems(showArchived)`, so a self-fetch here lands on a
   *  different query key and a different cache. With "Show archived" on, the
   *  row the user opened is then absent from our list and cannot be resolved
   *  at all. */
  items: Item[];
  initialItemId?: string;
  locations: Location[];
  onSubmit: (payload: {
    item: Item;
    fromId: string;
    toId: string;
    qty: number;
    reason: string;
  }) => void;
  onBulkStageTransfer?: (payload: {
    fromId: string;
    sourceType: "po" | "job";
    sourceRef: string;
    customer?: string;
    lines: {
      itemSku: string;
      itemName: string;
      qty: number;
    }[];
    reason: string;
  }) => void;
  /** Server-side error for the single-item → location transfer (e.g. a 409
   *  SHORTAGE from a stale-cache over-draw). Rendered above the submit button;
   *  the dialog is kept open by the parent (via `open`) while this is set. */
  errorMessage?: string;
  /** True while the parent's submit mutation is in flight. Disables the
   *  Submit button so a second click before the network round-trip resolves
   *  cannot fire a duplicate, non-idempotent transfer. */
  submitting?: boolean;
};

type TransferMode = "single" | "by_po" | "by_job";
type SingleDestType = "location" | "job_or_po";
type PickedDest =
  | { kind: "job"; id: string }
  | { kind: "po"; id: string }
  | null;

const reasons = [
  "Restock van for morning routes",
  "Tech requested for active job",
  "Balance stock across vans",
  "Return excess to warehouse",
  "Customer site staging",
];

export function TransferDialog({
  open,
  onClose,
  initialItemId,
  items,
  locations,
  onSubmit,
  onBulkStageTransfer,
  errorMessage,
  submitting,
}: Props) {
  const { data: purchaseOrders = [] } = usePurchaseOrders();
  const { data: allJobs = [] } = useInventoryJobs();

  const [mode, setMode] = useState<TransferMode>("single");
  const [itemId, setItemId] = useState(initialItemId ?? "");
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState(reasons[0]!);
  const [poId, setPoId] = useState("");
  const [jobId, setJobId] = useState("");
  // Single-item destination type (location vs. job-or-po) — lets a one-item
  // transfer route directly to a job or PO staging area, deducting from source.
  const [singleDestType, setSingleDestType] = useState<SingleDestType>("location");
  const [pickedDest, setPickedDest] = useState<PickedDest>(null);
  const [singleDestSearch, setSingleDestSearch] = useState("");
  const [bulkSelected, setBulkSelected] = useState<Record<string, boolean>>({});
  const [bulkQty, setBulkQty] = useState<Record<string, string>>({});
  const [poSearch, setPoSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [previewPONumber, setPreviewPONumber] = useState<string | null>(null);

  // Default the item picker to the first material item once the seam resolves
  // (Emanuel seeded `items[0].id` at module-load; the seam hydrates async).
  useEffect(() => {
    if (!itemId && items.length > 0) {
      const firstMaterial = items.find((i) => i.kind === "material") ?? items[0];
      if (firstMaterial) setItemId(firstMaterial.id);
    }
  }, [itemId, items]);

  // SRVW-93 - fromId/toId used to default to the prototype's fabricated ids
  // ("loc_wh_main"/"loc_van_mike"), which transferSchema's z.string().uuid()
  // check rejects. Derive real defaults at render instead of writing them
  // into state from an effect, so a user's own choice is never clobbered and
  // no state write happens outside a user event.
  const defaultFromId = useMemo(
    () => (locations.length === 0 ? "" : (locations.find((l) => l.type === "warehouse")?.id ?? locations[0]!.id)),
    [locations],
  );
  const defaultToId = useMemo(
    () => (locations.length === 0 ? "" : (locations.find((l) => l.id !== defaultFromId)?.id ?? defaultFromId)),
    [locations, defaultFromId],
  );
  const effectiveFromId = fromId || defaultFromId;
  const effectiveToId = toId || defaultToId;

  // Reset the local fields once the dialog actually closes (the single-item ->
  // location path no longer self-closes on submit - the parent only flips
  // `open` to false on a real success, keeping it open on a 409 SHORTAGE).
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current && !open) {
      setQty("");
      setError(null);
    }
    // The parent mounts this dialog unconditionally, so `initialItemId` was
    // only ever read by the useState initializer - on the very first mount,
    // when nothing is selected yet. Every later open kept whatever the latch
    // effect below had parked on `itemId` (the first material item), which is
    // why opening Transfer on a row showed a different item, 0 on-hand at
    // every location and Max (0). Re-seed on the closed -> open edge, and
    // clear the per-session location/quantity choices with it.
    if (!wasOpen.current && open) {
      setItemId(initialItemId ?? "");
      setFromId("");
      setToId("");
      setQty("");
      setError(null);
    }
    wasOpen.current = open;
  }, [open, initialItemId]);

  // Reset bulk selection when PO/Job changes
  useEffect(() => {
    if (mode === "by_po" && poId) {
      const po = purchaseOrders.find((p) => p.id === poId);
      if (po) {
        const next: Record<string, boolean> = {};
        const nextQ: Record<string, string> = {};
        po.lines.forEach((l, idx) => {
          next[`${poId}_${idx}`] = true;
          nextQ[`${poId}_${idx}`] = String(l.qtyOrdered - l.qtyReceived || l.qtyOrdered);
        });
        setBulkSelected(next);
        setBulkQty(nextQ);
      }
    }
    if (mode === "by_job" && jobId) {
      // Find any PO linked to this job
      const job = allJobs.find((j) => j.id === jobId);
      if (job) {
        const linkedPOs = purchaseOrders.filter(
          (p) => p.jobNumber === job.jobNumber,
        );
        const next: Record<string, boolean> = {};
        const nextQ: Record<string, string> = {};
        linkedPOs.forEach((po) => {
          po.lines.forEach((l, idx) => {
            next[`${po.id}_${idx}`] = true;
            nextQ[`${po.id}_${idx}`] = String(l.qtyOrdered - l.qtyReceived || l.qtyOrdered);
          });
        });
        setBulkSelected(next);
        setBulkQty(nextQ);
      }
    }
  }, [mode, poId, jobId, purchaseOrders, allJobs]);

  const filteredPOs = useMemo(() => {
    const q = poSearch.trim().toLowerCase();
    return purchaseOrders.filter((p) => {
      if (p.status === "received" || p.status === "closed") return false;
      if (!q) return true;
      return (
        p.poNumber.toLowerCase().includes(q) ||
        p.vendor.toLowerCase().includes(q) ||
        (p.jobNumber ?? "").toLowerCase().includes(q) ||
        (p.customer ?? "").toLowerCase().includes(q)
      );
    });
  }, [poSearch, purchaseOrders]);

  const selectedPO = purchaseOrders.find((p) => p.id === poId);
  const selectedJob = allJobs.find((j) => j.id === jobId);
  const jobLinkedPOs = selectedJob
    ? purchaseOrders.filter((p) => p.jobNumber === selectedJob.jobNumber)
    : [];

  // Cross-search: query both jobs AND open POs simultaneously.
  // Type "J-1850" → job. Type "PO-2305" → PO. Type "rolex" → both.
  type DestResult =
    | {
        kind: "job";
        id: string;
        title: string;
        sub: string;
        meta?: string;
      }
    | {
        kind: "po";
        id: string;
        title: string;
        sub: string;
        meta?: string;
      };

  const singleDestSearchResults = useMemo<DestResult[]>(() => {
    if (singleDestType !== "job_or_po") return [];
    const q = singleDestSearch.trim().toLowerCase();
    const jobResults: DestResult[] = allJobs
      .filter((j) => {
        if (!q) return true;
        return (
          j.jobNumber.toLowerCase().includes(q) ||
          j.customer.toLowerCase().includes(q) ||
          (j.site ?? "").toLowerCase().includes(q)
        );
      })
      .map((j) => ({
        kind: "job" as const,
        id: j.id,
        title: `${j.jobNumber} · ${j.customer}`,
        sub: j.site ?? "",
        meta: j.trade,
      }));
    const poResults: DestResult[] = purchaseOrders
      .filter((p) => {
        if (p.status === "received" || p.status === "closed") return false;
        if (!q) return true;
        return (
          p.poNumber.toLowerCase().includes(q) ||
          p.vendor.toLowerCase().includes(q) ||
          (p.jobNumber ?? "").toLowerCase().includes(q) ||
          (p.customer ?? "").toLowerCase().includes(q)
        );
      })
      .map((p) => ({
        kind: "po" as const,
        id: p.id,
        title: `${p.poNumber} · ${p.vendor}`,
        sub: p.jobNumber
          ? `${p.jobNumber} · ${p.customer ?? ""}`
          : "No job linked",
        meta: `${p.lines.length} ln`,
      }));
    // Rank: exact prefix matches first (e.g. "J-185" → J-1850 before just Rolex)
    const rank = (r: DestResult) => {
      const id = (r.title.split(" · ")[0] ?? "").toLowerCase();
      return id.startsWith(q) ? 0 : 1;
    };
    return [...jobResults, ...poResults].sort((a, b) => rank(a) - rank(b)).slice(0, 30);
  }, [singleDestType, singleDestSearch, allJobs, purchaseOrders]);

  const pickedJob = pickedDest?.kind === "job" ? allJobs.find((j) => j.id === pickedDest.id) : undefined;
  const pickedPO = pickedDest?.kind === "po" ? purchaseOrders.find((p) => p.id === pickedDest.id) : undefined;

  const item = useMemo(() => items.find((i) => i.id === itemId), [items, itemId]);
  const fromStock = item?.stock.find((s) => s.locationId === effectiveFromId);
  const toStock = item?.stock.find((s) => s.locationId === effectiveToId);
  const available = fromStock ? fromStock.onHand : 0;
  const fromLoc = locations.find((l) => l.id === effectiveFromId);
  const toLoc = locations.find((l) => l.id === effectiveToId);

  function submit() {
    if (mode === "single") {
      if (!item) return setError("Select an item.");
      const q = parseInt(qty || "0", 10);
      if (!q || q <= 0) return setError("Enter a quantity > 0.");
      if (q > available)
        return setError(
          `Only ${available} available at ${fromLoc?.name ?? "source"} (after reservations).`,
        );

      if (singleDestType === "location") {
        if (effectiveFromId === effectiveToId) return setError("From and To must be different.");
        setError(null);
        // Don't self-close here - the parent owns `open` and only closes it on
        // a confirmed success, so a 409 SHORTAGE (surfaced via `errorMessage`)
        // leaves the dialog open with the entered values intact for a retry.
        onSubmit({ item, fromId: effectiveFromId, toId: effectiveToId, qty: q, reason });
        return;
      }

      // Single item routed to a Job's or PO's staging area
      if (!onBulkStageTransfer) {
        return setError("Staging for a job is created from the Staging tab.");
      }
      if (!pickedDest) return setError("Pick a destination job or PO.");
      if (pickedDest.kind === "job") {
        if (!pickedJob) return setError("Picked job not found.");
        onBulkStageTransfer({
          fromId: effectiveFromId,
          sourceType: "job",
          sourceRef: pickedJob.jobNumber,
          customer: pickedJob.customer,
          lines: [{ itemSku: item.sku, itemName: item.name, qty: q }],
          reason,
        });
      } else {
        if (!pickedPO) return setError("Picked PO not found.");
        onBulkStageTransfer({
          fromId: effectiveFromId,
          sourceType: "po",
          sourceRef: pickedPO.poNumber,
          customer: pickedPO.customer,
          lines: [{ itemSku: item.sku, itemName: item.name, qty: q }],
          reason,
        });
      }
      setQty("");
      setError(null);
      onClose();
      return;
    }

    // Bulk stage modes (by_po / by_job)
    if (!onBulkStageTransfer) {
      return setError("Staging for a job is created from the Staging tab.");
    }
    const collected: { itemSku: string; itemName: string; qty: number }[] = [];
    let sourceRef = "";
    let customer: string | undefined;

    if (mode === "by_po") {
      if (!selectedPO) return setError("Pick a PO to transfer from.");
      sourceRef = selectedPO.poNumber;
      customer = selectedPO.customer;
      selectedPO.lines.forEach((l, idx) => {
        const key = `${selectedPO.id}_${idx}`;
        if (!bulkSelected[key]) return;
        const q = parseInt(bulkQty[key] || "0", 10);
        if (q > 0) collected.push({ itemSku: l.itemSku, itemName: l.itemName, qty: q });
      });
    } else if (mode === "by_job") {
      if (!selectedJob) return setError("Pick a job to transfer for.");
      sourceRef = selectedJob.jobNumber;
      customer = selectedJob.customer;
      jobLinkedPOs.forEach((po) => {
        po.lines.forEach((l, idx) => {
          const key = `${po.id}_${idx}`;
          if (!bulkSelected[key]) return;
          const q = parseInt(bulkQty[key] || "0", 10);
          if (q > 0) collected.push({ itemSku: l.itemSku, itemName: l.itemName, qty: q });
        });
      });
    }

    if (collected.length === 0)
      return setError("Select at least one line with qty > 0.");

    onBulkStageTransfer({
      fromId: effectiveFromId,
      sourceType: mode === "by_po" ? "po" : "job",
      sourceRef,
      customer,
      lines: collected,
      reason,
    });
    setError(null);
    onClose();
  }

  return (
    <>
    <Modal
      open={open}
      onClose={onClose}
      title="Transfer Stock Between Locations"
      size="lg"
      footer={
        <>
          <Button variant="outline" size="sm"
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting} size="sm">
            {submitting ? "Submitting..." : "Submit Transfer"}
          </Button>
        </>
      }
    >
      {error && (
        <div className="mb-3 rounded-md border border-danger/20 bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}

      {errorMessage && (
        <div className="mb-3 rounded-md border border-danger/20 bg-danger/10 px-3 py-2 text-xs text-danger">
          {errorMessage}
        </div>
      )}

      <div className="flex flex-col gap-4">
        {/* Mode toggle */}
        <div className="flex gap-1.5 rounded-md bg-background-light p-1">
          <ModeButton
            active={mode === "single"}
            onClick={() => setMode("single")}
            icon={Package}
            label="Single item"
          />
          <ModeButton
            active={mode === "by_po"}
            icon={FileText}
            label="By PO"
            disabled
            title="Staging material for a job is created from the Staging tab"
          />
          <ModeButton
            active={mode === "by_job"}
            icon={Briefcase}
            label="By Job"
            disabled
            title="Staging material for a job is created from the Staging tab"
          />
        </div>

        {mode === "by_po" && (
          <BulkPOSection
            poId={poId}
            setPoId={setPoId}
            poSearch={poSearch}
            setPoSearch={setPoSearch}
            filteredPOs={filteredPOs}
            selectedPO={selectedPO}
            bulkSelected={bulkSelected}
            setBulkSelected={setBulkSelected}
            bulkQty={bulkQty}
            setBulkQty={setBulkQty}
          />
        )}

        {mode === "by_job" && (
          <BulkJobSection
            jobId={jobId}
            setJobId={setJobId}
            allJobs={allJobs}
            selectedJob={selectedJob}
            jobLinkedPOs={jobLinkedPOs}
            bulkSelected={bulkSelected}
            setBulkSelected={setBulkSelected}
            bulkQty={bulkQty}
            setBulkQty={setBulkQty}
          />
        )}

        {mode === "single" && (<>
        {/* Item picker */}
        {/* Not converted to FormField: SelectField's own API has no `id` and
            does not spread the rest of its props onto the trigger, so
            FormField's generated id would reach no element and the label
            would point at nothing (same structural block as LeadFormPage's
            TimeSelect deferral). Every other SelectField-paired label in
            this file (Reason x2, LocationPicker's From/To, BulkPOSection,
            BulkJobSection) is blocked the same way. */}
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">
            Item
          </span>
          <SelectField
            aria-label="Item"
            value={itemId}
            onValueChange={setItemId}
            className="w-full rounded-md border border-border bg-surface-light px-2.5 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            options={items
              .filter((i) => i.kind === "material")
              .map((i) => ({ value: i.id, label: `${i.sku} — ${i.name}` }))}
          />
        </label>

        {/* Destination type pills */}
        <div>
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-text-secondary">
            Transfer To
          </p>
          <div className="flex gap-1.5 rounded-md bg-background-light p-1">
            <DestPill
              active={singleDestType === "location"}
              onClick={() => {
                setSingleDestType("location");
                setPickedDest(null);
              }}
              icon={Truck}
              label="Location"
              hint="Direct stock movement van → van or warehouse → van"
            />
            <DestPill
              active={singleDestType === "job_or_po"}
              icon={Briefcase}
              label="Job / PO"
              hint="Staging material for a job is created from the Staging tab"
              disabled
            />
          </div>
        </div>

        {/* From → To */}
        <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-3">
          <LocationPicker
            label="From"
            value={effectiveFromId}
            onChange={setFromId}
            item={item}
            locations={locations}
          />
          <div className="pb-2">
            <ArrowRight className="h-5 w-5 text-text-secondary" />
          </div>
          {singleDestType === "location" && (
            <LocationPicker
              label="To Location"
              value={effectiveToId}
              onChange={setToId}
              item={item}
              locations={locations}
            />
          )}
          {singleDestType === "job_or_po" && (
            <SearchablePicker
              label="To Job or PO"
              searchValue={singleDestSearch}
              onSearch={setSingleDestSearch}
              selectedLabel={
                pickedJob
                  ? `[Job] ${pickedJob.jobNumber} · ${pickedJob.customer}`
                  : pickedPO
                    ? `[PO] ${pickedPO.poNumber} · ${pickedPO.vendor}`
                    : ""
              }
              placeholder="Type J-1850 · PO-2305 · vendor · customer…"
              options={singleDestSearchResults.map((r) => ({
                id: `${r.kind}_${r.id}`,
                title: `${r.kind === "job" ? "Job" : "PO"} · ${r.title}`,
                sub: r.sub + (r.meta ? ` · ${r.meta}` : ""),
              }))}
              onSelect={(compoundId) => {
                const [kind, ...rest] = compoundId.split("_");
                const id = rest.join("_");
                if (kind === "job" || kind === "po") {
                  setPickedDest({ kind, id });
                  setSingleDestSearch("");
                }
              }}
              onClear={() => setPickedDest(null)}
            />
          )}
        </div>

        {/* Truck context strip — only for location dest */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <LocationCard loc={fromLoc} stock={fromStock} />
          {singleDestType === "location" ? (
            <LocationCard loc={toLoc} stock={toStock} />
          ) : pickedJob ? (
            <StagingDestCard
              title="Job staging"
              top={`${pickedJob.jobNumber} · ${pickedJob.customer}`}
              sub={pickedJob.site ?? ""}
              meta={
                pickedJob.scheduledFor
                  ? `Scheduled ${new Date(
                      pickedJob.scheduledFor,
                    ).toLocaleDateString(undefined, {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                    })}`
                  : ""
              }
            />
          ) : pickedPO ? (
            <StagingDestCard
              title="PO staging"
              top={`${pickedPO.poNumber} · ${pickedPO.vendor}`}
              sub={
                pickedPO.jobNumber
                  ? `${pickedPO.jobNumber} · ${pickedPO.customer ?? ""}`
                  : "No job linked"
              }
              meta={
                pickedPO.expectedDate
                  ? `ETA ${formatExactDay(pickedPO.expectedDate, {
                      month: "short",
                      day: "numeric",
                    })}`
                  : ""
              }
              onPreviewPO={() => setPreviewPONumber(pickedPO.poNumber)}
            />
          ) : (
            <div className="rounded-md border border-dashed border-border bg-background-light/40 px-3 py-2.5 text-xs text-text-secondary">
              Type a job # or PO # above (or search by customer/vendor) — the
              system finds it automatically.
            </div>
          )}
        </div>

        {/* Qty + Reason */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <FormField label={`Quantity (${item?.uom ?? "EA"})`} gap={1}>
            {(fieldProps) => (
              <div className="flex items-center gap-2">
                <Input
                  {...fieldProps}
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  type="number"
                  step="1"
                  placeholder="0"
                  className="w-full px-2.5 py-2"
                />
                {/* Not converted to Button: outline/neutral sets no idle text
                    colour (button.tsx's own header note), and this row's
                    ambient wrapper sets none either - the raw's text-secondary
                    would silently fall through to near-black. */}
                <button
                  type="button"
                  onClick={() => setQty(String(available))}
                  className="rounded-md border border-border bg-background-light px-2 py-1 text-xs text-text-secondary hover:bg-background-light"
                  title="Max available"
                >
                  Max ({available})
                </button>
              </div>
            )}
          </FormField>
          {/* Not converted to FormField: SelectField non-forwarding (see the
              Item picker comment above). */}
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">
              Reason
            </span>
            <SelectField
              aria-label="Reason"
              value={reason}
              onValueChange={setReason}
              className="w-full rounded-md border border-border bg-surface-light px-2.5 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              options={reasons.map((r) => ({ value: r, label: r }))}
            />
          </label>
        </div>

        {/* Serial reminder */}
        {item?.serialized && (
          <div className="rounded-md border border-warning/20 bg-warning/10 px-3 py-2 text-xs text-warning">
            <strong>Serialized item:</strong> approval required for transfer.
            Driver will scan each serial during handoff.
          </div>
        )}
        </>)}

        {/* Bulk-mode reason + destination footer */}
        {/* Not converted to FormField: SelectField non-forwarding (see the
            Item picker comment above) - the From Location site also carries
            a second sibling (the "auto-set" note) under the same label. */}
        {(mode === "by_po" || mode === "by_job") && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">
                From Location
              </span>
              <SelectField
                aria-label="From location"
                value={effectiveFromId}
                onValueChange={setFromId}
                className="w-full rounded-md border border-border bg-surface-light px-2.5 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                options={locations
                  .filter((l) => l.type === "warehouse" || l.type === "counter")
                  .map((l) => ({ value: l.id, label: l.name }))}
              />
              <span className="text-[10px] text-text-secondary">
                Destination is the job staging area (auto-set).
              </span>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">
                Reason
              </span>
              <SelectField
                aria-label="Reason"
                value={reason}
                onValueChange={setReason}
                className="w-full rounded-md border border-border bg-surface-light px-2.5 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                options={reasons.map((r) => ({ value: r, label: r }))}
              />
            </label>
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

function DestPill({
  active,
  onClick,
  icon: Icon,
  label,
  hint,
  disabled,
}: {
  active: boolean;
  onClick?: () => void;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  hint: string;
  disabled?: boolean;
}) {
  return (
    // Not converted to Button: segmented pill-toggle control (Location /
    // Job-or-PO), not a Button shape.
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={hint}
      className={[
        "flex flex-1 flex-col items-start gap-0.5 rounded-md px-2.5 py-1.5 text-left transition",
        disabled ? "cursor-not-allowed opacity-50" : "",
        active
          ? "bg-surface-light text-primary shadow-sm ring-1 ring-primary/20"
          : "text-text-secondary hover:bg-surface-light/60",
      ].join(" ")}
    >
      <div className="flex items-center gap-1.5 text-xs font-semibold">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <p className="text-[10px] leading-tight text-text-secondary">{hint}</p>
    </button>
  );
}

function SearchablePicker({
  label,
  searchValue,
  onSearch,
  selectedLabel,
  placeholder,
  options,
  onSelect,
  onClear,
}: {
  label: string;
  searchValue: string;
  onSearch: (v: string) => void;
  selectedLabel: string;
  placeholder: string;
  options: { id: string; title: string; sub: string }[];
  onSelect: (id: string) => void;
  onClear: () => void;
}) {
  return (
    <FormField label={label} gap={1}>
      {(fieldProps) => (
        selectedLabel ? (
          <div className="flex items-center gap-2 rounded-md border border-success/20 bg-success/10 px-2.5 py-2 text-sm">
            <span className="flex-1 truncate font-medium text-success">
              ✓ {selectedLabel}
            </span>
            {/* Not converted to Button: close-X affordance inside a chip. */}
            <button
              type="button"
              onClick={onClear}
              className="rounded p-0.5 text-success hover:bg-success/10"
              aria-label="Clear selection"
            >
              ×
            </button>
          </div>
        ) : (
          <>
            <Input
              {...fieldProps}
              value={searchValue}
              onChange={(e) => onSearch(e.target.value)}
              placeholder={placeholder}
              className="w-full px-2.5 py-2"
            />
            {searchValue && options.length > 0 && (
              <ul className="max-h-48 overflow-y-auto rounded-md border border-border bg-surface-light shadow-sm">
                {options.map((o) => (
                  <li key={o.id}>
                    {/* Not converted to Button: dropdown/search-result
                        list-row target. */}
                    <button
                      type="button"
                      onClick={() => onSelect(o.id)}
                      className="block w-full px-3 py-1.5 text-left text-xs hover:bg-primary-subtle"
                    >
                      <p className="font-semibold text-text-primary">{o.title}</p>
                      {o.sub && <p className="text-[10px] text-text-secondary">{o.sub}</p>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {searchValue && options.length === 0 && (
              <EmptyState density="flush" title="No matches." />
            )}
          </>
        )
      )}
    </FormField>
  );
}

function StagingDestCard({
  title,
  top,
  sub,
  meta,
  onPreviewPO,
}: {
  title: string;
  top: string;
  sub: string;
  meta: string;
  onPreviewPO?: () => void;
}) {
  return (
    <div className="rounded-md border border-primary/20 bg-primary-subtle/40 p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-primary">
          {title}
        </p>
        {onPreviewPO && (
          // Not converted to Button: outline/neutral sets no idle text
          // colour (button.tsx's own header note), and this row's ambient
          // wrapper sets none either - the raw's text-secondary would
          // silently fall through to near-black.
          <button
            type="button"
            onClick={onPreviewPO}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-light px-1.5 py-0.5 text-[10px] font-semibold text-text-secondary hover:bg-background-light"
            title="Preview PO as PDF · print"
          >
            <Eye className="h-2.5 w-2.5 text-primary" />
            Preview PO
          </button>
        )}
      </div>
      <p className="mt-0.5 text-sm font-semibold text-text-primary">{top}</p>
      {sub && <p className="text-[11px] text-text-secondary">{sub}</p>}
      {meta && (
        <p className="mt-1 text-[10px] text-warning">⏱ {meta}</p>
      )}
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  icon: Icon,
  label,
  disabled,
  title,
}: {
  active: boolean;
  onClick?: () => void;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  disabled?: boolean;
  title?: string;
}) {
  return (
    // Not converted to Button: segmented mode-toggle control, not a Button
    // shape.
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={[
        "flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition",
        disabled ? "cursor-not-allowed opacity-50" : "",
        active
          ? "bg-surface-light text-primary shadow-sm ring-1 ring-primary/20"
          : "text-text-secondary hover:bg-surface-light/60",
      ].join(" ")}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

function BulkPOSection({
  poId,
  setPoId,
  poSearch,
  setPoSearch,
  filteredPOs,
  selectedPO,
  bulkSelected,
  setBulkSelected,
  bulkQty,
  setBulkQty,
}: {
  poId: string;
  setPoId: (v: string) => void;
  poSearch: string;
  setPoSearch: (v: string) => void;
  filteredPOs: PurchaseOrder[];
  selectedPO: PurchaseOrder | undefined;
  bulkSelected: Record<string, boolean>;
  setBulkSelected: (v: Record<string, boolean>) => void;
  bulkQty: Record<string, string>;
  setBulkQty: (v: Record<string, string>) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {/* Not converted to FormField: two real controls (a search Input and a
          SelectField picker) share this one label. SelectField's own API has
          no `id` and does not spread the rest of its props onto the trigger
          (same structural block as LeadFormPage's TimeSelect deferral), so
          even the render-prop form can only wire the id onto one of the two
          - leaving the other with no id-based association either way, which
          a single FormField label isn't meant to express. */}
      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">
          Search / Pick PO
        </span>
        <Input
          value={poSearch}
          onChange={(e) => setPoSearch(e.target.value)}
          placeholder="Type PO #, vendor, job, customer…"
          className="w-full px-2.5 py-1.5"
        />
        <SelectField
          aria-label="Search / pick PO"
          value={poId || "NONE"}
          onValueChange={(v) => setPoId(v === "NONE" ? "" : v)}
          className="w-full rounded-md border border-border bg-surface-light px-2.5 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          options={[
            { value: "NONE", label: `— Select a PO (${filteredPOs.length} match) —` },
            ...filteredPOs.map((p) => ({
              value: p.id,
              label: `${p.poNumber} · ${p.vendor}${p.jobNumber ? ` · ${p.jobNumber} ${p.customer ?? ""}` : ""}`,
            })),
          ]}
        />
      </label>

      {selectedPO && (
        <div className="rounded-md border border-primary/20 bg-primary-subtle/40 p-2.5">
          <div className="mb-1.5 flex items-center justify-between text-xs">
            <span className="font-semibold text-primary">
              {selectedPO.poNumber} · {selectedPO.vendor}
            </span>
            {selectedPO.jobNumber && (
              <span className="text-text-secondary">
                {selectedPO.jobNumber} · {selectedPO.customer}
              </span>
            )}
          </div>
          <BulkLines
            keyPrefix={selectedPO.id}
            lines={selectedPO.lines}
            bulkSelected={bulkSelected}
            setBulkSelected={setBulkSelected}
            bulkQty={bulkQty}
            setBulkQty={setBulkQty}
          />
        </div>
      )}
    </div>
  );
}

function BulkJobSection({
  jobId,
  setJobId,
  allJobs,
  selectedJob,
  jobLinkedPOs,
  bulkSelected,
  setBulkSelected,
  bulkQty,
  setBulkQty,
}: {
  jobId: string;
  setJobId: (v: string) => void;
  allJobs: InventoryJob[];
  selectedJob: InventoryJob | undefined;
  jobLinkedPOs: PurchaseOrder[];
  bulkSelected: Record<string, boolean>;
  setBulkSelected: (v: Record<string, boolean>) => void;
  bulkQty: Record<string, string>;
  setBulkQty: (v: Record<string, string>) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {/* Not converted to FormField: SelectField non-forwarding (see the
          Item picker comment above). */}
      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">
          Pick Job
        </span>
        <SelectField
          aria-label="Pick job"
          value={jobId || "NONE"}
          onValueChange={(v) => setJobId(v === "NONE" ? "" : v)}
          className="w-full rounded-md border border-border bg-surface-light px-2.5 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          options={[
            { value: "NONE", label: "— Select a job —" },
            ...allJobs.map((j) => ({
              value: j.id,
              label: `${j.jobNumber} · ${j.customer} · ${j.trade}`,
            })),
          ]}
        />
      </label>

      {selectedJob && (
        <div className="rounded-md border border-primary/20 bg-primary-subtle/40 p-2.5">
          <div className="mb-1.5 flex items-center justify-between text-xs">
            <span className="font-semibold text-primary">
              {selectedJob.jobNumber} · {selectedJob.customer}
            </span>
            <span className="text-text-secondary">{selectedJob.site}</span>
          </div>
          {jobLinkedPOs.length === 0 ? (
            <p className="text-xs text-text-secondary">
              No open POs linked to this job. Create one first, or use Single
              Item mode to transfer ad-hoc.
            </p>
          ) : (
            jobLinkedPOs.map((po) => (
              <div key={po.id} className="mt-1 border-t border-primary/20 pt-1.5 first:border-t-0 first:pt-0">
                <p className="mb-1 text-[10px] font-mono font-semibold text-primary">
                  {po.poNumber} · {po.vendor}
                </p>
                <BulkLines
                  keyPrefix={po.id}
                  lines={po.lines}
                  bulkSelected={bulkSelected}
                  setBulkSelected={setBulkSelected}
                  bulkQty={bulkQty}
                  setBulkQty={setBulkQty}
                />
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function BulkLines({
  keyPrefix,
  lines,
  bulkSelected,
  setBulkSelected,
  bulkQty,
  setBulkQty,
}: {
  keyPrefix: string;
  lines: { itemSku: string; itemName: string; uom: string; qtyOrdered: number; qtyReceived: number }[];
  bulkSelected: Record<string, boolean>;
  setBulkSelected: (v: Record<string, boolean>) => void;
  bulkQty: Record<string, string>;
  setBulkQty: (v: Record<string, string>) => void;
}) {
  return (
    <div className="space-y-1">
      {lines.map((l, idx) => {
        const k = `${keyPrefix}_${idx}`;
        const checked = !!bulkSelected[k];
        return (
          // Not converted to FormField: this label WRAPS a checkbox (the row's
          // selection toggle) plus a second real control (the qty Input) on
          // the same horizontal row - a checkbox-row shape FormField's own
          // header comment excludes, not the vertical label-above-a-single-
          // control column FormField renders.
          <label
            key={k}
            className="flex items-center gap-2 rounded-md bg-surface-light px-2 py-1.5 text-xs"
          >
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) =>
                setBulkSelected({ ...bulkSelected, [k]: e.target.checked })
              }
              className="h-3.5 w-3.5 rounded border-border text-primary focus:ring-primary"
            />
            <code className="font-mono text-[10px] text-text-secondary">{l.itemSku}</code>
            <span className="flex-1 truncate text-text-secondary">{l.itemName}</span>
            <Input
              type="number"
              min="0"
              value={bulkQty[k] ?? ""}
              onChange={(e) => setBulkQty({ ...bulkQty, [k]: e.target.value })}
              disabled={!checked}
              className="w-14 px-1 py-0.5 text-right text-[11px]"
            />
            <span className="text-[10px] text-text-secondary">{l.uom}</span>
            <span className="text-[10px] text-text-secondary">of {l.qtyOrdered}</span>
          </label>
        );
      })}
    </div>
  );
}

function LocationPicker({
  label,
  value,
  onChange,
  item,
  locations,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  item: Item | undefined;
  locations: Location[];
}) {
  return (
    // Not converted to FormField: SelectField non-forwarding (see the Item
    // picker comment above) - used at both the From and To Location call
    // sites, both blocked the same way.
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">
        {label}
      </span>
      <SelectField
        aria-label={label}
        value={value}
        onValueChange={onChange}
        className="w-full rounded-md border border-border bg-surface-light px-2.5 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
        options={locations.map((l) => {
          const s = item?.stock.find((x) => x.locationId === l.id);
          return {
            value: l.id,
            label: `${l.name} ${s ? `· ${s.onHand} on-hand` : "· 0 on-hand"}`,
          };
        })}
      />
    </label>
  );
}

function LocationCard({
  loc,
  stock,
}: {
  loc?: { name: string; type: string; primaryTech?: string; vehicle?: string };
  stock?: { onHand: number; min?: number; max?: number };
}) {
  const onHand = stock?.onHand ?? 0;
  const isTruck = loc?.type === "truck";
  return (
    <div className="rounded-md border border-border bg-background-light p-3">
      <div className="flex items-center gap-2">
        {isTruck && <Truck className="h-4 w-4 text-primary" />}
        <p className="text-sm font-semibold text-text-primary">{loc?.name ?? "—"}</p>
      </div>
      {loc?.primaryTech && (
        <p className="mt-0.5 text-[11px] text-text-secondary">
          {loc.primaryTech} · {loc.vehicle}
        </p>
      )}
      <div className="mt-2 grid grid-cols-2 gap-1 text-xs">
        <div>
          <span className="block text-[10px] uppercase text-text-secondary">
            On hand
          </span>
          <span className="font-mono font-semibold text-text-primary">
            {onHand}
          </span>
        </div>
        <div>
          <span className="block text-[10px] uppercase text-text-secondary">
            Avail
          </span>
          <span className="font-mono font-semibold text-success">
            {onHand}
          </span>
        </div>
      </div>
    </div>
  );
}
