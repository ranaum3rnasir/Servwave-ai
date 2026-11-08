import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Briefcase, CheckCircle2, ChevronDown, ClipboardList, Plus, Search, Trash2, Truck, X } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/form/SelectField";
import { DatePicker } from "@/components/form/DatePicker";
import { FormField } from "@/components/patterns/FormField";
import { AddItemDialog, type NewItem } from "./AddItemDialog";
import type { NewPOInput, NewPOLineInput, PurchaseOrder } from "@/lib/api/inventory";
import type { Brand, Category, Item, Vendor } from "@/lib/api/inventory";
import type { InventoryJob } from "@/lib/api/inventory";
import { Button } from "@/components/ui/button";

/**
 * NewPODialog — create a new Purchase Order (PRD §7.X.4, rev 2026-05-28).
 *
 * Captures the standard PO field set:
 *  - Vendor (required) — picked from the inventory vendor list; the payload
 *    carries `vendorId` (the FK) plus the legacy `vendor` name snapshot
 *  - Line items (required, ≥1) — item picker + qty + unit cost; sku/name/uom
 *    auto-fill and the unit cost defaults from the catalog item (editable;
 *    blank = no cost known, sent as `null`)
 *  - Expected delivery date (optional)
 *  - Job link (optional) — picking a job sends `jobId` + `customerId`; the
 *    jobNumber / customer / site strings stay as the display fallback
 *  - Trade (optional) — categorizes the PO for filtering
 *
 * Saves as `draft` status on the Open tab. Operators mark it ordered from
 * PODetailDialog once they have placed it with the vendor (PR 2 lifecycle).
 * A draft carries no order date — "ordered" never means "created".
 *
 * Data seam: this dialog is presentational — vendors/items/existingPOs/jobs
 * arrive as props from PurchaseOrdersPage (which reads them via the
 * @/lib/api/inventory hooks). On submit it builds a NewPOInput (no
 * id, no poNumber — both server-assigned) and hands it to onCreate; the
 * parent persists via useCreatePO().mutateAsync(input).
 */

type Props = {
  open: boolean;
  onClose: () => void;
  onCreate: (po: NewPOInput) => void;
  vendors: Vendor[];
  items: Item[];
  /** Existing POs — surfaces items already on a PO when a job is linked
   *  (so the operator doesn't accidentally double-order). */
  existingPOs: PurchaseOrder[];
  /** Jobs in the system — drives the Job Link typeahead. */
  jobs: InventoryJob[];
  // ── Inline "+ Add a new item" support (rev 2026-05-28) ─────────────
  // When these are wired, every line-item picker exposes an "+ Add a
  // new item" footer that opens AddItemDialog. On save the new Item is
  // pushed via onAddItem AND auto-selected on the row that triggered
  // the dialog. Categories / brands / itemGroups / onAddVendor /
  // onAddCategory are all forwarded straight into AddItemDialog.
  onAddItem?: (item: Item) => void;
  onAddVendor?: (vendor: Vendor) => void;
  categories?: Category[];
  onAddCategory?: (category: Category) => void;
  brands?: Brand[];
};

type DraftLine = {
  // Unique key for React iteration — sku is reusable across rows in case
  // someone genuinely wants two lines for the same SKU (e.g. different
  // dates / cost centers in a future rev). Keyed independently.
  rowId: string;
  itemId: string; // "" when not yet picked
  qty: string;    // string for input control
  /** Money input as typed; "" = no cost known (sent as `null`). Pre-filled
   *  from the picked catalog item's unitCost and freely overridable. */
  unitCost: string;
};

/** Format a catalog cost for the money input: two decimals at most, no
 *  trailing ".00" noise, "" when the item carries no cost (cost-stripped
 *  response or never priced). */
function costToInput(cost: number | undefined): string {
  if (cost == null || !isFinite(cost)) return "";
  return String(Math.round(cost * 100) / 100);
}

function newDraftLine(index: number): DraftLine {
  return { rowId: `r_${Date.now()}_${index}`, itemId: "", qty: "1", unitCost: "" };
}

const TRADES = ["locksmith", "door", "security", "hvac", "plumbing", "multi"] as const;
type Trade = (typeof TRADES)[number];

export function NewPODialog({
  open,
  onClose,
  onCreate,
  vendors,
  items,
  existingPOs,
  jobs,
  onAddItem,
  onAddVendor,
  categories = [],
  onAddCategory,
  brands = [],
}: Props) {
  // When set, the "Add Item" dialog is open and on save we auto-select
  // the new item on this row of the line-items table. null = dialog closed.
  const [addItemForRow, setAddItemForRow] = useState<string | null>(null);
  const [vendorId, setVendorId] = useState("");
  const [expectedDate, setExpectedDate] = useState(""); // yyyy-mm-dd
  const [jobNumber, setJobNumber] = useState("");
  const [customer, setCustomer] = useState("");
  const [site, setSite] = useState("");
  const [trade, setTrade] = useState<Trade | "">("");
  // Job typeahead — searches across job#, customer, site simultaneously.
  // When the user picks a match, all four fields above auto-fill and the
  // linkedJobId is set so we can show a "✓ Linked to J-####" pill. Manual
  // edits to the auto-filled fields don't break the link — the operator
  // sees the link banner until they explicitly Unlink.
  const [jobSearch, setJobSearch] = useState("");
  const [linkedJobId, setLinkedJobId] = useState<string | null>(null);
  const [jobDropdownOpen, setJobDropdownOpen] = useState(false);
  const jobBoxRef = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<DraftLine[]>([newDraftLine(0)]);
  const [error, setError] = useState<string | null>(null);

  // Reset whenever the dialog opens (keeps stale state from leaking between
  // successive PO creations). Done during render off a "previous open" value
  // rather than in an effect, so the reset never cascades a second render.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setVendorId("");
      setExpectedDate("");
      setJobNumber("");
      setCustomer("");
      setSite("");
      setTrade("");
      setJobSearch("");
      setLinkedJobId(null);
      setJobDropdownOpen(false);
      setLines([newDraftLine(0)]);
      setError(null);
    }
  }

  // Close the typeahead dropdown when the user clicks outside it.
  useEffect(() => {
    if (!jobDropdownOpen) return;
    function onDown(e: MouseEvent) {
      if (!jobBoxRef.current) return;
      if (!jobBoxRef.current.contains(e.target as Node)) {
        setJobDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [jobDropdownOpen]);

  // Match jobs by job# OR customer OR site OR trade. Empty query → top 6
  // open jobs (status scheduled / in_progress), sorted by scheduledFor asc
  // so the most imminent job is on top of the suggestions list.
  const jobMatches = useMemo(() => {
    const q = jobSearch.trim().toLowerCase();
    if (!q) {
      return jobs
        .filter((j) => j.status === "scheduled" || j.status === "in_progress")
        .slice()
        .sort((a, b) => {
          const at = a.scheduledFor ? new Date(a.scheduledFor).getTime() : Infinity;
          const bt = b.scheduledFor ? new Date(b.scheduledFor).getTime() : Infinity;
          return at - bt;
        })
        .slice(0, 6);
    }
    return jobs
      .filter((j) => {
        const hay = `${j.jobNumber} ${j.customer} ${j.site} ${j.trade}`.toLowerCase();
        return hay.includes(q);
      })
      .slice(0, 6);
  }, [jobs, jobSearch]);

  function pickJob(j: InventoryJob) {
    setLinkedJobId(j.id);
    setJobNumber(j.jobNumber);
    setCustomer(j.customer);
    setSite(j.site);
    setTrade(j.trade as Trade);
    setJobSearch("");
    setJobDropdownOpen(false);
  }

  function unlinkJob() {
    setLinkedJobId(null);
    // Clear the auto-filled fields too — if the user wants to keep them
    // they were free to edit before clicking Unlink. Clearing is the
    // honest behavior for "this PO isn't tied to a job anymore."
    setJobNumber("");
    setCustomer("");
    setSite("");
    setTrade("");
    setJobSearch("");
  }

  // ─── Existing open POs for the linked job (informational only) ──────────
  // When the operator picks a job that already has an open PO, surface the
  // SKUs + qty so they don't accidentally double-order something the vendor
  // is already shipping. Pulls from any PO in draft/sent/partial states for
  // the same job# — closed/received POs aren't relevant for double-order risk.
  const jobsOpenPOs = useMemo(() => {
    if (!linkedJobId) return [];
    const job = jobs.find((j) => j.id === linkedJobId);
    if (!job) return [];
    return existingPOs.filter(
      (p) =>
        p.jobNumber === job.jobNumber &&
        (p.status === "draft" || p.status === "ordered" || p.status === "partial"),
    );
  }, [linkedJobId, jobs, existingPOs]);

  // Friendly summary line for the linked-job pill.
  const linkedJob = linkedJobId
    ? jobs.find((j) => j.id === linkedJobId) ?? null
    : null;

  // The picked vendor's display name — item grouping and the legacy `vendor`
  // snapshot both key on it; the payload's identity is `vendorId`.
  const vendorName = useMemo(
    () => vendors.find((v) => v.id === vendorId)?.name ?? "",
    [vendors, vendorId],
  );

  // Sorted active vendor list for the dropdown.
  const vendorOptions = useMemo(
    () =>
      vendors
        .filter((v) => v.status !== "inactive")
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name)),
    [vendors],
  );

  // When the vendor changes, narrow the item picker to that vendor's catalog
  // — but keep an "all items" fallback so operators can still grab an item
  // from a different vendor if needed (e.g. cross-shipped). Items whose
  // vendor.name matches the chosen vendor come first.
  const sortedItems = useMemo(() => {
    const list = items.filter((i) => i.status !== "discontinued");
    if (!vendorName) {
      return list.slice().sort((a, b) => a.name.localeCompare(b.name));
    }
    return list.slice().sort((a, b) => {
      const am = a.vendor === vendorName ? 0 : 1;
      const bm = b.vendor === vendorName ? 0 : 1;
      if (am !== bm) return am - bm;
      return a.name.localeCompare(b.name);
    });
  }, [items, vendorName]);

  function addLine() {
    setLines((ls) => [...ls, newDraftLine(ls.length)]);
  }

  function removeLine(rowId: string) {
    setLines((ls) => (ls.length <= 1 ? ls : ls.filter((l) => l.rowId !== rowId)));
  }

  function updateLine(rowId: string, patch: Partial<DraftLine>) {
    setLines((ls) => ls.map((l) => (l.rowId === rowId ? { ...l, ...patch } : l)));
  }

  /** Picking an item also (re)defaults the line's unit cost from the catalog —
   *  the operator can still override or blank it afterwards. */
  function pickItemForLine(rowId: string, item: Item | undefined, itemId: string) {
    updateLine(rowId, { itemId, unitCost: costToInput(item?.unitCost) });
  }

  /**
   * Build a full Item from an AddItemDialog NewItem payload and register it
   * via onAddItem so it's available across the rest of the session. Matches
   * the InventoryPage handleSave shape (sub-§5.4.A) — id auto-generated,
   * status "active", stock seeded from `startingStock`, updatedAt = now.
   *
   * Returns the full Item so the caller can immediately auto-select it on
   * the line-row that triggered the dialog.
   */
  function registerNewItem(payload: NewItem): Item {
    const newItem: Item = {
      id: `itm_new_${Date.now()}`,
      sku: payload.sku,
      mpn: payload.mpn,
      modelNumber: payload.modelNumber,
      name: payload.name,
      category: payload.category,
      trade: payload.trade as Item["trade"],
      kind: payload.kind as Item["kind"],
      uom: payload.uom,
      unitCost: payload.unitCost,
      sellPrice: payload.sellPrice,
      serialized: payload.serialized,
      hazmat: payload.hazmat,
      status: "active",
      vendor: payload.vendor,
      photoUrl: payload.photoUrl,
      brandId: payload.brandId,
      visibility: payload.visibility,
      stock: payload.startingStock.map((s) => ({
        locationId: s.locationId,
        onHand: s.qty,
        min: s.min,
        max: s.max,
      })),
      updatedAt: new Date().toISOString(),
    };
    onAddItem?.(newItem);
    return newItem;
  }

  function submit() {
    if (!vendorId || !vendorName) return setError("Pick a vendor.");
    // Validate every line: must have an item, a positive qty and a unit cost
    // that is blank or a non-negative amount.
    const cleanLines: NewPOLineInput[] = [];
    for (const l of lines) {
      const it = items.find((i) => i.id === l.itemId);
      if (!it) {
        return setError("Every line needs an item picked.");
      }
      const qty = Number(l.qty);
      if (!isFinite(qty) || qty <= 0) {
        return setError(`Quantity for "${it.name}" must be greater than 0.`);
      }
      const costRaw = l.unitCost.trim();
      const unitCost = costRaw === "" ? null : Number(costRaw);
      if (unitCost != null && (!isFinite(unitCost) || unitCost < 0)) {
        return setError(`Unit cost for "${it.name}" must be 0 or more (leave it blank if unknown).`);
      }
      cleanLines.push({
        itemSku: it.sku,
        itemName: it.name,
        uom: it.uom,
        qtyOrdered: qty,
        qtyReceived: 0,
        unitCost: unitCost == null ? null : Math.round(unitCost * 100) / 100,
      });
    }
    if (!cleanLines.length) {
      return setError("Add at least one line item.");
    }

    // No id / poNumber here — the server assigns the PO number (P0 §A). No
    // orderedAt either: a draft is created unordered whatever the client sends.
    const po: NewPOInput = {
      vendor: vendorName,
      vendorId,
      status: "draft",
      jobId: linkedJob?.id,
      customerId: linkedJob?.customerId,
      jobNumber: jobNumber.trim() || undefined,
      customer: customer.trim() || undefined,
      site: site.trim() || undefined,
      trade: trade || undefined,
      expectedDate: expectedDate ? new Date(expectedDate).toISOString() : undefined,
      lines: cleanLines,
    };
    onCreate(po);
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create Purchase Order"
      subtitle="Saves as a draft on the Open tab. Mark it as ordered from PO Detail once you have placed it with the vendor."
      // xl (max-w-4xl) gives the 5-column line-item table enough room to
      // render Item · Qty · UoM · Unit cost · Delete without the action
      // column being pushed off the right edge of the dialog.
      size="xl"
      footer={
        <>
          <Button variant="outline" size="sm"
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button size="sm"
            onClick={submit}
          >
            <Plus className="h-3.5 w-3.5" />
            Save Draft PO
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
        {/* ─── Vendor + expected date row ─── */}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {/* Not converted to FormField: SelectField's own API has no `id`
              and does not spread the rest of its props onto the trigger, so
              FormField's generated id would reach no element and the label
              would point at nothing (same structural block as LeadFormPage's
              TimeSelect deferral) - and the leading Truck icon makes this a
              two-element wrapper on top of that. The local `Field` helper
              stays defined for this and the Trade site below. */}
          <Field label="Vendor" required>
            <div className="relative">
              <Truck className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-secondary" />
              <SelectField
                aria-label="Vendor"
                value={vendorId || "NONE"}
                onValueChange={(v) => setVendorId(v === "NONE" ? "" : v)}
                className={`${inputCls} pl-7`}
                options={[
                  { value: "NONE", label: "— pick a vendor —" },
                  ...vendorOptions.map((v) => ({ value: v.id, label: v.name })),
                ]}
              />
            </div>
          </Field>

          <FormField label="Expected Delivery" optional gap={1}>
            <DatePicker value={expectedDate} onChange={setExpectedDate} />
          </FormField>
        </div>

        {/* ─── Optional job link ─── */}
        <fieldset className="rounded-md border border-border px-3 py-3">
          <legend className="px-1 text-[11px] font-medium uppercase tracking-wide text-text-secondary">
            Job Link (optional)
          </legend>

          {/* Job typeahead — searches across job#, customer, site, trade.
              Picking a match auto-fills the four fields below; manual
              edits stay possible after. Unlink clears the link + fields. */}
          {linkedJob ? (
            <div className="mb-3 flex items-center justify-between gap-2 rounded-md border border-success/20 bg-success/10 px-3 py-2 text-xs">
              <div className="flex min-w-0 items-center gap-2 text-success">
                <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0" />
                <div className="min-w-0">
                  <div className="truncate">
                    <span className="font-mono font-semibold">{linkedJob.jobNumber}</span>
                    <span className="text-success"> · {linkedJob.customer}</span>
                  </div>
                  <div className="truncate text-[10px] text-success">
                    {linkedJob.site}
                  </div>
                </div>
              </div>
              {/* Deferred: text-success hover:underline link — no link+success
                  tone is minted (link only has brand). Left raw. */}
              <button
                type="button"
                onClick={unlinkJob}
                className="inline-flex flex-shrink-0 items-center gap-0.5 rounded text-[11px] font-medium text-success hover:underline"
                title="Unlink job and clear the fields below"
              >
                <X className="h-3 w-3" />
                Unlink
              </button>
            </div>
          ) : (
            <div className="mb-3" ref={jobBoxRef}>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-secondary" />
                <Input
                  value={jobSearch}
                  onChange={(e) => {
                    setJobSearch(e.target.value);
                    setJobDropdownOpen(true);
                  }}
                  onFocus={() => setJobDropdownOpen(true)}
                  placeholder="Find a job by # · customer · site…"
                  className="w-full px-2.5 py-1.5 pl-7"
                />
                {jobDropdownOpen && jobMatches.length > 0 && (
                  <div className="absolute left-0 right-0 top-full z-10 mt-1 max-h-64 overflow-y-auto rounded-md border border-border bg-surface-light shadow-lg">
                    {!jobSearch.trim() && (
                      <div className="border-b border-border bg-background-light px-3 py-1.5 text-[10px] uppercase tracking-wide text-text-secondary">
                        Open jobs · closest first
                      </div>
                    )}
                    {/* Deferred: dropdown/typeahead result rows — list-row
                        click targets, not Button-shaped. */}
                    {jobMatches.map((j) => (
                      <button
                        key={j.id}
                        type="button"
                        onClick={() => pickJob(j)}
                        className="flex w-full items-start gap-2 border-b border-border px-3 py-2 text-left text-xs last:border-b-0 hover:bg-primary-subtle"
                      >
                        <Briefcase className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-primary" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono font-semibold text-primary">
                              {j.jobNumber}
                            </span>
                            <span className="rounded-full bg-background-light px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-text-secondary">
                              {j.trade}
                            </span>
                          </div>
                          <div className="truncate font-medium text-text-primary">
                            {j.customer}
                          </div>
                          <div className="truncate text-[10px] text-text-secondary">
                            {j.site}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
                {jobDropdownOpen && jobSearch.trim() && jobMatches.length === 0 && (
                  <div className="absolute left-0 right-0 top-full z-10 mt-1 rounded-md border border-border bg-surface-light px-3 py-2 text-xs text-text-secondary shadow-lg">
                    No matching jobs. Fill in the fields below to record a custom job link.
                  </div>
                )}
              </div>
              <p className="mt-1 text-[10px] text-text-secondary">
                Searches across job #, customer, and site. Picking a match auto-fills the
                fields below — or type the details manually for one-off POs.
              </p>
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <FormField label="Job #" gap={1}>
              <Input
                value={jobNumber}
                onChange={(e) => setJobNumber(e.target.value)}
                placeholder="J-1870"
                className="w-full px-2.5 py-1.5"
              />
            </FormField>
            <FormField label="Customer" gap={1}>
              <Input
                value={customer}
                onChange={(e) => setCustomer(e.target.value)}
                placeholder="Equinox Hudson Yards"
                className="w-full px-2.5 py-1.5"
              />
            </FormField>
            {/* Not converted to FormField: SelectField non-forwarding (see
                the Vendor comment above). */}
            <Field label="Trade">
              <SelectField
                aria-label="Trade"
                value={trade || "NONE"}
                onValueChange={(v) => setTrade(v === "NONE" ? "" : (v as Trade))}
                className={inputCls}
                options={[
                  { value: "NONE", label: "— none —" },
                  ...TRADES.map((t) => ({ value: t, label: t })),
                ]}
              />
            </Field>
          </div>
          <div className="mt-3">
            <FormField label="Site / Notes" gap={1}>
              <Input
                value={site}
                onChange={(e) => setSite(e.target.value)}
                placeholder="33 Hudson Yards, NY · Lobby 1 access control"
                className="w-full px-2.5 py-1.5"
              />
            </FormField>
          </div>
        </fieldset>

        {/* ─── Existing-PO callout — only shown when the linked job already
             has one or more open POs. Helps the operator avoid double-ordering
             SKUs that the vendor is already shipping. ─── */}
        {jobsOpenPOs.length > 0 && (
          <div className="rounded-md border border-warning/20 bg-warning/10 px-3 py-2 text-[12px] text-warning">
            <div className="mb-1 flex items-center gap-1.5 font-semibold">
              <ClipboardList className="h-3.5 w-3.5" />
              This job already has {jobsOpenPOs.length} open PO
              {jobsOpenPOs.length === 1 ? "" : "s"} — review before adding lines
            </div>
            <ul className="ml-5 list-disc space-y-0.5">
              {jobsOpenPOs.map((p) => {
                const ord = p.lines.reduce((s, l) => s + l.qtyOrdered, 0);
                const rec = p.lines.reduce((s, l) => s + l.qtyReceived, 0);
                return (
                  <li key={p.id}>
                    <span className="font-mono font-semibold">{p.poNumber}</span>{" "}
                    · {p.vendor} · {p.lines.length} item
                    {p.lines.length === 1 ? "" : "s"} ({rec}/{ord} units received)
                  </li>
                );
              })}
            </ul>
            <div className="mt-1 text-[11px] text-warning">
              Items on those POs are already in flight — add lines here only
              for SKUs the existing POs don't cover.
            </div>
          </div>
        )}

        {/* ─── Line items ─── */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">
              Line Items <span className="text-danger">*</span>
            </span>
            {/* outline/neutral's idle text is unset (inherits ambient page
                default) rather than the raw's explicit text-secondary — the
                same accepted trade-off as the primitive's other 202
                outline/neutral call sites (see button.tsx's own header note). */}
            <Button variant="outline" tone="neutral" size="sm"
              type="button"
              onClick={addLine}
              className="gap-1"
            >
              <Plus className="h-3 w-3" />
              Add line
            </Button>
          </div>
          <div className="overflow-hidden rounded-md ring-1 ring-border">
            <table className="min-w-full text-sm">
              <thead className="bg-background-light text-left text-[11px] uppercase tracking-wide text-text-secondary">
                <tr>
                  <th className="px-3 py-2">Item</th>
                  {/* min-w-[6.5rem] forces a hard floor on the Qty column —
                      plain `w-28` is treated as a preference by the table
                      layout algorithm and gets squeezed by the long Item
                      column, which hid the digit behind the spinner. */}
                  <th className="min-w-[6.5rem] px-3 py-2 text-center">Qty</th>
                  <th className="min-w-[3.5rem] px-3 py-2">UoM</th>
                  <th className="min-w-[7rem] px-3 py-2 text-right">Unit cost</th>
                  <th className="min-w-[3rem] px-3 py-2 text-center"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {lines.map((l) => {
                  const it = items.find((i) => i.id === l.itemId);
                  return (
                    <tr key={l.rowId}>
                      <td className="px-3 py-2">
                        <ItemPicker
                          items={sortedItems}
                          selectedId={l.itemId}
                          vendorName={vendorName}
                          onPick={(itemId) =>
                            pickItemForLine(
                              l.rowId,
                              items.find((i) => i.id === itemId),
                              itemId,
                            )
                          }
                          onRequestAddNew={
                            onAddItem
                              ? () => setAddItemForRow(l.rowId)
                              : undefined
                          }
                        />
                      </td>
                      <td className="px-3 py-2">
                        <Input
                          type="number"
                          min="1"
                          step="1"
                          value={l.qty}
                          onChange={(e) =>
                            updateLine(l.rowId, { qty: e.target.value })
                          }
                          // appearance-none + the [&::-webkit-inner-spin-button]
                          // utility suppress the native ↑↓ spinner arrows that
                          // were overlapping with the right-aligned digit and
                          // making the qty invisible in narrow columns.
                          className="w-full px-2.5 py-1.5 text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        />
                      </td>
                      <td className="px-3 py-2 text-xs text-text-secondary">
                        {it?.uom ?? "—"}
                      </td>
                      <td className="px-3 py-2">
                        {/* Money input: defaults from the catalog on pick, two
                            decimals, blank allowed (= no cost known → null).
                            Same spinner suppression as Qty. */}
                        <Input
                          type="number"
                          min="0"
                          step="0.01"
                          inputMode="decimal"
                          placeholder="—"
                          aria-label={it ? `Unit cost for ${it.name}` : "Unit cost"}
                          value={l.unitCost}
                          onChange={(e) =>
                            updateLine(l.rowId, { unitCost: e.target.value })
                          }
                          className="w-full px-2.5 py-1.5 text-right [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        />
                      </td>
                      <td className="px-2 py-2 text-center">
                        {/* Deferred: neutral idle + danger hover-reveal on an
                            OUTLINE (bordered) icon button — no minted cell has
                            both; only ghost/danger#reveal exists (no border),
                            and outline/neutral has no danger-reveal hover.
                            Left raw rather than dropping either cue. */}
                        <button
                          type="button"
                          onClick={() => removeLine(l.rowId)}
                          disabled={lines.length <= 1}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-surface-light text-text-secondary transition hover:border-danger/20 hover:bg-danger/10 hover:text-danger disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:border-border disabled:hover:bg-surface-light disabled:hover:text-text-secondary"
                          title={
                            lines.length <= 1
                              ? "At least one line is required"
                              : "Remove this line item"
                          }
                          aria-label="Remove line"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-1 text-[10px] text-text-secondary">
            Click the item field to open the full search — by name, SKU, MPN, or category,
            with vendor-catalog grouping and a *"+ Add a new item"* path for custom /
            one-off parts that aren't in the price book yet. Unit cost fills in from the
            catalog — override it with the vendor's quote, or leave it blank if unknown.
          </p>
        </div>
      </div>

      {/* Inline AddItemDialog — opened by "+ Add a new item" from the
          ItemSearchModal footer. zIndex={80} so it stacks cleanly above
          ItemSearchModal (70) which sits above NewPODialog (default 50).
          On save we register the item via the parent's onAddItem callback
          AND auto-select it on the row that triggered the dialog. */}
      {onAddItem && (
        <AddItemDialog
          open={!!addItemForRow}
          onClose={() => setAddItemForRow(null)}
          vendors={vendors}
          onAddVendor={(v) => onAddVendor?.(v)}
          categories={categories}
          onAddCategory={(c) => onAddCategory?.(c)}
          brands={brands}
          zIndex={80}
          // SRVW-91: this mount's onSave calls registerNewItem, which builds a local
          // itm_new_* row and never reaches the server, so no starting stock or reserve
          // level entered here could be saved. Hide the panel rather than leave it as
          // theatre; wiring the item itself is SRVW-93.
          showStartingStock={false}
          onSave={(payload) => {
            const newItem = registerNewItem(payload);
            if (addItemForRow) {
              pickItemForLine(addItemForRow, newItem, newItem.id);
            }
            setAddItemForRow(null);
          }}
        />
      )}
    </Modal>
  );
}

/**
 * ItemPicker — full-view modal item browser (rev 2026-05-28).
 *
 * Closed state: shows a trigger button that looks like a form input —
 *   the picked item's name + SKU, or "— pick an item —" placeholder,
 *   with a chevron on the right edge.
 *
 * Click → opens `ItemSearchModal` (a full Modal at zIndex={70}) so the
 * browser escapes NewPODialog's body overflow constraints. The modal
 * gives the operator a proper search-and-browse surface:
 *   - Large search input at top (autofocused) — filters by
 *     name / SKU / MPN / category in real time.
 *   - **Category filter chips** in a horizontally-scrollable row —
 *     click a chip to narrow the list to that category; "All" resets.
 *   - **Vendor-aware grouping** preserved inside — when a vendor is
 *     selected on the parent PO, items from that vendor's catalog
 *     float to the top under a sub-header; cross-vendor items render
 *     below a divider with the actual vendor surfaced in the row.
 *   - Tall scrollable list (24rem / ~12 items visible at once).
 *   - "+ Add a new item" button in the modal header — closes the
 *     browser modal and opens AddItemDialog scoped to the row.
 */
function ItemPicker({
  items,
  selectedId,
  vendorName,
  onPick,
  onRequestAddNew,
}: {
  items: Item[];
  selectedId: string;
  vendorName: string;
  onPick: (itemId: string) => void;
  onRequestAddNew?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = items.find((i) => i.id === selectedId) ?? null;

  return (
    <>
      {/* Deferred: combobox/select-trigger styled as a form field (shares
          inputCls with real Input/Select controls) — not a Button-shaped CTA. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`${inputCls} flex w-full items-center justify-between gap-2 text-left ${
          selected ? "text-text-primary" : "text-text-secondary"
        }`}
      >
        <span className="min-w-0 truncate">
          {selected ? (
            <>
              <span className="font-medium">{selected.name}</span>
              <span className="ml-1 font-mono text-[11px] text-text-secondary">
                ({selected.sku})
              </span>
            </>
          ) : (
            "— pick an item —"
          )}
        </span>
        <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-text-secondary" />
      </button>

      <ItemSearchModal
        open={open}
        onClose={() => setOpen(false)}
        items={items}
        selectedId={selectedId}
        vendorName={vendorName}
        onPick={(id) => {
          onPick(id);
          setOpen(false);
        }}
        onRequestAddNew={
          onRequestAddNew
            ? () => {
                setOpen(false);
                onRequestAddNew();
              }
            : undefined
        }
      />
    </>
  );
}

/**
 * ItemSearchModal — the full-view item browser.
 *
 * Renders at zIndex={70} on top of NewPODialog (default 50) so it
 * escapes the parent's body overflow. Uses the shared Modal shell so
 * Escape / × / backdrop close paths work uniformly with the rest of
 * the app's modals.
 */
function ItemSearchModal({
  open,
  onClose,
  items,
  selectedId,
  vendorName,
  onPick,
  onRequestAddNew,
}: {
  open: boolean;
  onClose: () => void;
  items: Item[];
  selectedId: string;
  vendorName: string;
  onPick: (itemId: string) => void;
  onRequestAddNew?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Autofocus the search on open + reset state on close.
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setQuery("");
      setCategoryFilter("");
    }
  }, [open]);

  // Every unique category present in the items list — used to build
  // the filter chip row. Sorted alphabetically with each chip showing
  // the count of items in that category.
  const categoryCounts = useMemo(() => {
    const map = new Map<string, number>();
    items.forEach((i) => {
      if (i.category) map.set(i.category, (map.get(i.category) ?? 0) + 1);
    });
    return Array.from(map.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, count]) => ({ name, count }));
  }, [items]);

  // Apply both filters (search query + selected category).
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((i) => {
      if (categoryFilter && i.category !== categoryFilter) return false;
      if (!q) return true;
      const hay = `${i.name} ${i.sku} ${i.mpn ?? ""} ${i.category}`.toLowerCase();
      return hay.includes(q);
    });
  }, [items, query, categoryFilter]);

  // Vendor-aware split — chosen vendor's items float to the top.
  const vendorHalf = vendorName
    ? filtered.filter((i) => i.vendor === vendorName)
    : filtered;
  const crossVendorHalf = vendorName
    ? filtered.filter((i) => i.vendor !== vendorName)
    : [];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Pick an item"
      subtitle={
        vendorName
          ? `Items in ${vendorName}'s catalog show first. Cross-vendor items are still available below.`
          : "Search across the full item catalog by name, SKU, MPN, or category."
      }
      size="lg"
      footer={
        <>
          {/* Deferred: tinted bg-primary-subtle "soft" fill — that structure is
              published in the W1 vocabulary but not yet minted in button.tsx
              (see its header comment); no solid/outline/ghost cell reproduces
              a light tinted-background pill. Left raw. */}
          {onRequestAddNew && (
            <button
              type="button"
              onClick={onRequestAddNew}
              className="mr-auto inline-flex items-center gap-1.5 rounded-md bg-primary-subtle px-3 py-1.5 text-sm font-semibold text-primary hover:bg-primary/10"
            >
              <Plus className="h-3.5 w-3.5" />
              Add a new item
              <span className="text-[10px] font-normal text-primary/70">
                custom / one-off
              </span>
            </button>
          )}
          <Button variant="outline" size="sm"
            type="button"
            onClick={onClose}
          >
            Cancel
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {/* Big search input */}
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search items…"
            className="w-full px-3 py-2 pl-9"
          />
        </div>

        {/* Category filter chips — horizontally scrollable row */}
        {categoryCounts.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
              Category:
            </span>
            {/* Deferred: segmented filter-chip toggle row — not Button-shaped. */}
            <button
              type="button"
              onClick={() => setCategoryFilter("")}
              className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium transition ${
                !categoryFilter
                  ? "bg-primary text-on-fill"
                  : "bg-background-light text-text-secondary hover:bg-border"
              }`}
            >
              All · {items.length}
            </button>
            {categoryCounts.map((c) => (
              <button
                key={c.name}
                type="button"
                onClick={() =>
                  setCategoryFilter(categoryFilter === c.name ? "" : c.name)
                }
                className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium transition ${
                  categoryFilter === c.name
                    ? "bg-primary text-on-fill"
                    : "bg-background-light text-text-secondary hover:bg-border"
                }`}
              >
                {c.name} · {c.count}
              </button>
            ))}
          </div>
        )}

        {/* Result count + active-filter strip */}
        <div className="flex items-center justify-between border-y border-border py-1.5 text-[11px] text-text-secondary">
          <span>
            Showing <span className="font-semibold text-text-primary">{filtered.length}</span>{" "}
            of {items.length} items
            {categoryFilter && (
              <span className="ml-1 text-primary">
                · {categoryFilter}
              </span>
            )}
            {query.trim() && (
              <span className="ml-1 text-primary">
                · matching "{query.trim()}"
              </span>
            )}
          </span>
          {(categoryFilter || query) && (
            // link/brand text-primary matches the raw's text-primary exactly;
            // the raw set no explicit type size (inherited ambient), so
            // size={null}'s inline flow with base text-sm is a close match,
            // not a disclosed regression.
            <Button variant="link" tone="brand" size={null}
              type="button"
              onClick={() => {
                setCategoryFilter("");
                setQuery("");
              }}
            >
              Clear filters
            </Button>
          )}
        </div>

        {/* Scrollable item list */}
        <div className="max-h-[24rem] overflow-y-auto rounded-md border border-border">
          {filtered.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-text-secondary">
              No items match the current filters.
              {onRequestAddNew && (
                <div className="mt-2 text-xs text-text-secondary">
                  Use <span className="font-semibold">+ Add a new item</span> below to
                  create a custom one.
                </div>
              )}
            </div>
          ) : (
            <>
              {vendorName && vendorHalf.length > 0 && (
                <div className="sticky top-0 z-10 border-b border-border bg-primary-subtle px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                  {vendorName} catalog · {vendorHalf.length}
                </div>
              )}
              {vendorHalf.map((i) => (
                <ItemRow
                  key={i.id}
                  item={i}
                  selected={i.id === selectedId}
                  onPick={() => onPick(i.id)}
                />
              ))}
              {vendorName && crossVendorHalf.length > 0 && (
                <div className="sticky top-0 z-10 border-y border-border bg-background-light px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
                  Cross-vendor · {crossVendorHalf.length}
                </div>
              )}
              {crossVendorHalf.map((i) => (
                <ItemRow
                  key={i.id}
                  item={i}
                  selected={i.id === selectedId}
                  onPick={() => onPick(i.id)}
                  showVendor
                />
              ))}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

function ItemRow({
  item,
  selected,
  onPick,
  showVendor,
}: {
  item: Item;
  selected: boolean;
  onPick: () => void;
  showVendor?: boolean;
}) {
  return (
    // Deferred: item search-result list row — a list-row click target, not
    // Button-shaped.
    <button
      type="button"
      onClick={onPick}
      className={`flex w-full items-start gap-3 border-b border-border px-3 py-2 text-left last:border-b-0 hover:bg-primary-subtle ${
        selected ? "bg-primary-subtle/60" : ""
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium text-text-primary">
            {item.name}
          </span>
          {selected && (
            <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 text-primary" />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-text-secondary">
          <span className="font-mono">{item.sku}</span>
          {item.category && (
            <>
              <span>·</span>
              <span>{item.category}</span>
            </>
          )}
          {item.uom && (
            <>
              <span>·</span>
              <span>per {item.uom}</span>
            </>
          )}
          {showVendor && (
            <>
              <span>·</span>
              <span className="text-text-secondary">{item.vendor}</span>
            </>
          )}
        </div>
      </div>
    </button>
  );
}

const inputCls =
  "w-full rounded-md border border-border px-2.5 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";

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
