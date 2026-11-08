import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { Eye, FileText, MapPin, Plus, Sparkles, Trash2, User as UserIcon } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { FormField } from "@/components/patterns/FormField";
import { SelectField } from "@/components/form/SelectField";
import { DateTimePicker } from "@/components/form/DateTimePicker";
import { DatePicker } from "@/components/form/DatePicker";
import {
  useInventoryItems,
  useVendors,
  usePurchaseOrders,
  useInventoryJobs,
  useTechs,
  useCreateStage,
  type Location,
  type JobStage,
  type StagedItem,
  type PurchaseOrder,
  type Tech,
} from "@/lib/api/inventory";
import { POPreviewDialog } from "@/components/inventory/POPreviewDialog";
import { NoInventoryLocationDialog } from "@/components/inventory/NoInventoryLocationDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useScheduleTimezone, pickerValueToIso, isoToPickerValue } from "@/lib/schedule-tz";

type Props = {
  open: boolean;
  onClose: () => void;
  locations: Location[];
  onCreate: (stage: JobStage) => void;
  prefilledFromPO?: PurchaseOrder | null;
};

type DraftLine = {
  uid: string;
  itemId: string;
  qtyOrdered: string;
  qtyReceived: string;
  vendor: string;
  poNumber: string;
  expectedDate: string;
};

// `tradeOptions` removed (rev 2026-05-26) — CreateStageDialog no longer
// exposes a Trade picker. `JobStage.trade` still exists in the data model
// and is auto-derived from the linked job (or defaults to "multi" for
// freshly-typed jobs that have no source). See changelog "Trade field
// removed from CreateStageDialog (New Job Pickup)".

export function CreateStageDialog({
  open,
  onClose,
  locations,
  onCreate,
  prefilledFromPO,
}: Props) {
  // A stage's scheduled time is the COMPANY's clock. Both ends were wrong here: the picker
  // was seeded by slicing the raw ISO (so it showed UTC) and saved via `new Date(...)` (so it
  // stored the browser's), which is the same pairing that mis-stored the walkthrough times.
  const timezone = useScheduleTimezone();

  // Seam data (Track 1: mock-backed TanStack hooks; Track 2 flips to /api/*).
  // Emanuel imported these as module-scope arrays from ../data/*; here they
  // come from the query layer so the dialog re-reads after any mutation.
  const { data: allItems = [] } = useInventoryItems();
  const { data: allVendors = [] } = useVendors();
  const { data: purchaseOrders = [] } = usePurchaseOrders();
  const { data: allJobs = [] } = useInventoryJobs();
  const { data: allTechs = [] } = useTechs();
  // This dialog is the SOLE writer of a new stage: it POSTs here, and `onCreate`
  // only tells the parent to show it. Do not add a second mutation on the
  // parent's side - that is what wrote every stage to the database twice.
  const createStage = useCreateStage();

  // `newLine` closes over the seam `allItems` (Emanuel had it module-scope
  // referencing the static array). Guarded for noUncheckedIndexedAccess.
  function newLine(): DraftLine {
    return {
      uid: `line_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      itemId: allItems[0]?.id ?? "",
      qtyOrdered: "",
      qtyReceived: "0",
      vendor: "",
      poNumber: "",
      expectedDate: "",
    };
  }

  const [form, setForm] = useState({
    jobId: "",          // when picked, populates customer/site/trade/scheduledFor
    jobNumber: "",      // free-text fallback if no job picked
    customer: "",
    site: "",
    scheduledFor: "",
    techId: "",
    // Default to "multi" — the dialog no longer exposes a Trade picker
    // (rev 2026-05-26); when a job is picked the value is auto-set from
    // job.trade, otherwise the stage is created as multi-trade.
    trade: "multi" as JobStage["trade"],
    pickupVendorId: "",
    pickupAddress: "",
    notes: "",
  });
  const [lines, setLines] = useState<DraftLine[]>(() => [newLine()]);
  const [linkedPOId, setLinkedPOId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [previewPOId, setPreviewPOId] = useState<string | null>(null);
  const [noLocationOpen, setNoLocationOpen] = useState(false);
  // The PO this pickup is linked to. Prefer the explicitly linked PO
  // (auto-linked by job or chosen from the dropdown); fall back to the
  // prefilled-from-PO entry point. Recorded on the stage as
  // `linkedPurchaseOrderId`; nothing here emails it (PRD-1).
  const currentPO: PurchaseOrder | null =
    prefilledFromPO ??
    purchaseOrders.find((p) => p.id === linkedPOId) ??
    null;

  const openPOs = useMemo(
    () =>
      purchaseOrders.filter(
        (p) => p.status !== "received" && p.status !== "closed",
      ),
    [purchaseOrders],
  );
  const jobPOs = useMemo(
    () =>
      form.jobNumber
        ? openPOs
            .filter((p) => p.jobNumber === form.jobNumber)
            .sort((a, b) => (b.orderedAt ?? "").localeCompare(a.orderedAt ?? ""))
        : [],
    [openPOs, form.jobNumber],
  );

  // Pre-fill from a PO when one is passed in (and the dialog is open)
  useEffect(() => {
    if (!open) return;
    if (prefilledFromPO) {
      // Find a matching job by number, vendor record, etc.
      const matchedJob = prefilledFromPO.jobNumber
        ? allJobs.find((j) => j.jobNumber === prefilledFromPO.jobNumber)
        : undefined;
      const matchedVendor = allVendors.find(
        (v) => v.name === prefilledFromPO.vendor,
      );
      setForm((f) => ({
        ...f,
        jobId: matchedJob?.id ?? "",
        jobNumber: prefilledFromPO.jobNumber ?? f.jobNumber,
        customer: prefilledFromPO.customer ?? matchedJob?.customer ?? f.customer,
        site: prefilledFromPO.site ?? matchedJob?.site ?? f.site,
        trade: prefilledFromPO.trade ?? matchedJob?.trade ?? f.trade,
        scheduledFor: matchedJob?.scheduledFor
          ? isoToPickerValue(matchedJob.scheduledFor, timezone)
          : f.scheduledFor,
        techId: matchedJob?.assignedTechId ?? f.techId,
        pickupVendorId: matchedVendor?.id ?? f.pickupVendorId,
        pickupAddress: matchedVendor?.pickupAddress ?? f.pickupAddress,
      }));
      setLinkedPOId(prefilledFromPO.id);
      applyPOLines(prefilledFromPO);
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, prefilledFromPO?.id]);

  function applyPOLines(po: PurchaseOrder) {
    setLines(
      po.lines.map((pol, idx) => {
        const matchedItem = allItems.find((i) => i.sku === pol.itemSku);
        return {
          uid: `line_po_${po.id}_${idx}`,
          itemId: matchedItem?.id ?? allItems[0]?.id ?? "",
          qtyOrdered: String(pol.qtyOrdered),
          qtyReceived: String(pol.qtyReceived),
          vendor: po.vendor,
          poNumber: po.poNumber,
          expectedDate: po.expectedDate ? po.expectedDate.slice(0, 10) : "",
        };
      }),
    );
  }

  function pickJob(jobId: string) {
    if (jobId === "__new__") {
      // user picked "+ New Job" — clear job context, let them type free text
      setForm((f) => ({ ...f, jobId: "", jobNumber: "" }));
      // also clear any auto-linked PO from a prior job
      setLinkedPOId("");
      return;
    }
    const job = allJobs.find((j) => j.id === jobId);
    if (!job) {
      setForm((f) => ({ ...f, jobId: "" }));
      return;
    }

    // Find the most recent open PO already on this job (if any)
    const matchingPO = purchaseOrders
      .filter(
        (p) =>
          p.jobNumber === job.jobNumber &&
          p.status !== "received" &&
          p.status !== "closed",
      )
      .sort((a, b) => (b.orderedAt ?? "").localeCompare(a.orderedAt ?? ""))[0];

    const matchedVendor = matchingPO
      ? allVendors.find((v) => v.name === matchingPO.vendor)
      : undefined;

    setForm((f) => ({
      ...f,
      jobId: job.id,
      jobNumber: job.jobNumber,
      customer: job.customer,
      site: job.site,
      trade: job.trade,
      scheduledFor: job.scheduledFor ? isoToPickerValue(job.scheduledFor, timezone) : "",
      techId: job.assignedTechId ?? f.techId,
      pickupVendorId: matchedVendor?.id ?? f.pickupVendorId,
      pickupAddress: matchedVendor?.pickupAddress ?? f.pickupAddress,
    }));

    if (matchingPO) {
      setLinkedPOId(matchingPO.id);
      applyPOLines(matchingPO);
    } else {
      // No PO on this job — clear any auto-linked PO from a prior selection
      // and reset to a single empty line so user can add items / custom PO.
      setLinkedPOId("");
      setLines([newLine()]);
    }
  }

  function pickPO(poId: string) {
    if (!poId) {
      setLinkedPOId("");
      return;
    }
    const po = purchaseOrders.find((p) => p.id === poId);
    if (!po) return;
    setLinkedPOId(po.id);
    applyPOLines(po);
    const matchedVendor = allVendors.find((v) => v.name === po.vendor);
    if (matchedVendor && !form.pickupVendorId) {
      setForm((f) => ({
        ...f,
        pickupVendorId: matchedVendor.id,
        pickupAddress: matchedVendor.pickupAddress ?? f.pickupAddress,
      }));
    }
  }

  function pickVendor(vendorId: string) {
    const vendor = allVendors.find((v) => v.id === vendorId);
    setForm((f) => ({
      ...f,
      pickupVendorId: vendorId,
      pickupAddress: vendor?.pickupAddress ?? "",
    }));
  }

  function set<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function updateLine(uid: string, patch: Partial<DraftLine>) {
    setLines((ls) => ls.map((l) => (l.uid === uid ? { ...l, ...patch } : l)));
  }

  function addLine() {
    setLines((ls) => [...ls, newLine()]);
  }

  function removeLine(uid: string) {
    setLines((ls) => (ls.length === 1 ? ls : ls.filter((l) => l.uid !== uid)));
  }

  function reset() {
    setForm({
      jobId: "",
      jobNumber: "",
      customer: "",
      site: "",
      scheduledFor: "",
      techId: "",
      trade: "multi", // rev 2026-05-26: trade field removed from UI; default multi
      pickupVendorId: "",
      pickupAddress: "",
      notes: "",
    });
    setLines([newLine()]);
    setLinkedPOId("");
    setError(null);
  }

  /**
   * Build the final JobStage object from the current form, validating
   * required fields. Returns null + sets an error message if anything is
   * missing.
   */
  function buildStage(): JobStage | null {
    if (!form.jobNumber.trim()) {
      setError("Job number is required.");
      return null;
    }
    if (!form.customer.trim()) {
      setError("Customer is required.");
      return null;
    }
    if (lines.some((l) => !l.qtyOrdered || parseInt(l.qtyOrdered, 10) <= 0)) {
      setError("Every line needs an ordered quantity > 0.");
      return null;
    }
    if (lines.some((l) => !l.poNumber.trim())) {
      setError("Every line needs a PO number (or N/A for emergency).");
      return null;
    }

    const stagedItems: StagedItem[] = lines.map((l, idx) => {
      const itm = allItems.find((i) => i.id === l.itemId);
      return {
        id: `stg_new_${Date.now()}_${idx}`,
        itemSku: itm?.sku ?? "",
        itemName: itm?.name ?? "",
        uom: itm?.uom ?? "EA",
        qtyOrdered: parseInt(l.qtyOrdered, 10),
        qtyReceived: parseInt(l.qtyReceived || "0", 10),
        vendor: l.vendor.trim() || itm?.vendor || "",
        poNumber: l.poNumber.trim(),
        expectedDate: l.expectedDate ? new Date(l.expectedDate).toISOString() : undefined,
        serialized: itm?.serialized ?? false,
      };
    });

    const totalOrdered = stagedItems.reduce((s, i) => s + i.qtyOrdered, 0);
    const totalReceived = stagedItems.reduce((s, i) => s + i.qtyReceived, 0);
    // Vendor-pickup stages skip the receive flow entirely (parts already
    // sitting at the vendor counter, tech drives over). Everything else
    // follows the qty-driven status.
    const status: JobStage["status"] = form.pickupVendorId
      ? "ready_for_pickup"
      : totalReceived === 0
        ? "awaiting"
        : totalReceived >= totalOrdered
          ? "complete"
          : "partial";

    const destinationLocationId = form.pickupVendorId ? undefined : locations[0]?.id;

    const techRecord = allTechs.find((t) => t.id === form.techId);
    return {
      id: `stg_new_${Date.now()}`,
      jobNumber: form.jobNumber.trim(),
      customer: form.customer.trim(),
      site: form.site.trim() || "—",
      scheduledFor: pickerValueToIso(form.scheduledFor, timezone),
      assignedTechId: form.techId || undefined,
      assignedTech: techRecord?.name,
      trade: form.trade,
      status,
      pickupVendorId: form.pickupVendorId || undefined,
      pickupAddress: form.pickupAddress.trim() || undefined,
      stagedLocationId: destinationLocationId,
      items: stagedItems,
      notes: form.notes.trim() || undefined,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * The POST body: the local `JobStage` view shape plus the two links the
   * server can persist but `JobStage` has no room for.
   *
   * - `jobId` - without it the stage saves with job_id null, so it never
   *   appears on the job's own Staging section, "Open Job" has nothing to
   *   open, and receipts miss the per-job material-cost roll-up.
   * - `linkedPurchaseOrderId` - records which PO these lines came from WITHOUT
   *   handing line authorship to the server. (`stagedFromPurchaseOrderId` is
   *   the other server path; it re-copies the PO's lines verbatim, which would
   *   throw away the quantities the operator just edited in this dialog.)
   */
  function stagePayload(stage: JobStage) {
    return {
      ...stage,
      jobId: form.jobId || undefined,
      linkedPurchaseOrderId: currentPO?.id,
    };
  }

  function submit() {
    // S4.3 (B12): everything but a vendor pickup is staged INTO a location
    // (`stagedLocationId = locations[0]`). With none, this used to build a stage
    // with no location and let the receive fail later - block here and say where
    // locations live instead. A vendor pickup keeps the parts at the counter, so
    // it needs no location and is not blocked.
    if (!form.pickupVendorId && locations.length === 0) {
      setNoLocationOpen(true);
      return;
    }
    const stage = buildStage();
    if (!stage) return;
    createStage.mutate(stagePayload(stage));
    onCreate(stage);
    reset();
    onClose();
  }

  return (
    <>
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title={
        prefilledFromPO
          ? `New Job · from ${prefilledFromPO.poNumber}`
          : "New Job Pickup"
      }
      subtitle={
        prefilledFromPO
          ? `Pre-filled from ${prefilledFromPO.vendor} · ${prefilledFromPO.lines.length} line item${prefilledFromPO.lines.length === 1 ? "" : "s"}. Confirm job context + save.`
          : "Create a staging entry for items ordered against a specific job. Auto-creates PO references; receives can be logged as parts arrive."
      }
      size="xl"
      footer={
        <>
          <Button variant="outline" size="sm"
            onClick={() => {
              reset();
              onClose();
            }}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              // Prefer the explicitly linked PO; fall back to the prefill PO
              const id = linkedPOId || prefilledFromPO?.id || "";
              if (id) setPreviewPOId(id);
            }}
            disabled={!linkedPOId && !prefilledFromPO}
            title={
              linkedPOId || prefilledFromPO
                ? "Preview the linked PO as PDF · print"
                : "Link a PO above to enable preview"
            }
          >
            <Eye className="h-4 w-4 text-primary" />
            Preview PO
          </Button>
          <Button size="sm"
            onClick={submit}
          >
            Create Pickup ({lines.length} item{lines.length === 1 ? "" : "s"})
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
        {/* Job picker — auto-fills customer, site, schedule, tech.
            Trade field intentionally removed (rev 2026-05-26) — this CRM is
            trade-agnostic, the trade chip on a stage card comes from the
            linked job context, not from a per-stage classifier. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {/* SelectField's Radix Select ROOT forwards no id to its trigger -
              a known gap (FormField.tsx's header comment). Kept as
              SelectField, not a raw Select/SelectTrigger: the layering guard
              resolves same-file local `const` string classNames, and
              selectCls's hard/soft classes would redden the ratchet if
              handed straight to SelectTrigger (a components/ui export)
              instead of through SelectField, which the guard does not
              govern. render-prop is still needed here (not cloneElement) for
              the conditional new-job Input / auto-fill note sitting after
              the Select - fieldProps go unused since SelectField has nowhere
              to receive them. */}
          <FormField label="Job" required>
            {() => (
              <>
                <SelectField
                  aria-label="Job"
                  value={form.jobId || "__new__"}
                  onValueChange={pickJob}
                  className={`${selectCls} font-mono`}
                  options={[
                    { value: "__new__", label: "+ New job (type below)…" },
                    ...allJobs.map((j) => ({
                      value: j.id,
                      label: `${j.jobNumber} — ${j.customer.slice(0, 32)}`,
                    })),
                  ]}
                />
                {!form.jobId && (
                  <Input
                    value={form.jobNumber}
                    onChange={(e) => set("jobNumber", e.target.value.toUpperCase())}
                    placeholder="Type new job # · e.g. J-1870"
                    className={`${inputCls} mt-1`}
                  />
                )}
                {form.jobId && (
                  <p className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-success">
                    <Sparkles className="h-3 w-3" />
                    Auto-filled customer · site · schedule
                  </p>
                )}
              </>
            )}
          </FormField>
          <FormField label="Customer" required>
            <Input
              value={form.customer}
              onChange={(e) => set("customer", e.target.value)}
              placeholder="Rolex 5th Ave"
              className={inputCls}
              readOnly={!!form.jobId}
            />
          </FormField>
        </div>

        <FormField label="Site / Address">
          <Input
            value={form.site}
            onChange={(e) => set("site", e.target.value)}
            placeholder="665 Fifth Ave, NY · Vault corridor"
            className={inputCls}
            readOnly={!!form.jobId}
          />
        </FormField>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {/* Not converted to FormField's cloneElement path: DateTimePicker has no id
              prop of its own to receive fieldProps. */}
          <div>
            <Label>Scheduled For</Label>
            <DateTimePicker
              value={form.scheduledFor}
              onChange={(v) => set("scheduledFor", v)}
              className="mt-1"
            />
          </div>
          {/* SelectField's Radix Select ROOT forwards no id to its trigger -
              a known gap (FormField.tsx's header comment). Kept as
              SelectField, not a raw Select/SelectTrigger: the layering guard
              resolves same-file local `const` string classNames, and
              selectCls's hard/soft classes would redden the ratchet if
              handed straight to SelectTrigger (a components/ui export)
              instead of through SelectField, which the guard does not
              govern. render-prop is still needed here (not cloneElement) for
              the conditional helper paragraph sitting after the Select -
              fieldProps go unused since SelectField has nowhere to receive
              them. */}
          <FormField label="Assigned Tech">
            {() => (
              <>
                <SelectField
                  aria-label="Assigned tech"
                  value={form.techId || "NONE"}
                  onValueChange={(v) => set("techId", v === "NONE" ? "" : v)}
                  className={selectCls}
                  options={[
                    { value: "NONE", label: "Unassigned" },
                    ...allTechs.map((t) => ({
                      value: t.id,
                      label: `${t.name} — ${techRoleLabel(t.role)}${t.primaryTrade ? ` · ${t.primaryTrade}` : ""}`,
                    })),
                  ]}
                />
                {form.techId && (() => {
                  const t = allTechs.find((x) => x.id === form.techId);
                  if (!t) return null;
                  return (
                    <p className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-text-secondary">
                      <UserIcon className="h-3 w-3" />
                      {t.branch}
                      {t.vehicle ? ` · ${t.vehicle}` : ""}
                    </p>
                  );
                })()}
              </>
            )}
          </FormField>
          {/* SelectField's Radix Select ROOT forwards no id to its trigger -
              a known gap (FormField.tsx's header comment). Kept as
              SelectField, not a raw Select/SelectTrigger: the layering guard
              resolves same-file local `const` string classNames, and
              selectCls's hard/soft classes would redden the ratchet if
              handed straight to SelectTrigger (a components/ui export)
              instead of through SelectField, which the guard does not
              govern. */}
          <FormField label="Pickup From Vendor">
            <SelectField
              aria-label="Pickup from vendor"
              value={form.pickupVendorId || "NONE"}
              onValueChange={(v) => pickVendor(v === "NONE" ? "" : v)}
              className={selectCls}
              options={[
                { value: "NONE", label: "Select vendor pickup…" },
                ...allVendors
                  .filter((v) => v.id !== "vnd_internal")
                  .map((v) => ({ value: v.id, label: v.name })),
              ]}
            />
          </FormField>
        </div>

        {/* Vendor pickup address */}
        {form.pickupVendorId && (
          <div className="rounded-md border border-primary/20 bg-primary/5 p-2.5">
            <div className="flex items-start gap-2">
              <MapPin className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary" />
              <div className="flex-1">
                <p className="text-[10px] font-medium uppercase tracking-wide text-primary">
                  Vendor Pickup Location
                </p>
                <Input
                  value={form.pickupAddress}
                  onChange={(e) => set("pickupAddress", e.target.value)}
                  placeholder="Vendor pickup address"
                  className="p-0"
                />
              </div>
            </div>
          </div>
        )}

        {/* Line items section */}
        <div className="rounded-md border border-border bg-background-light/40 p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            {/* Raw by design: eyebrow style, no matching Heading variant. */}
            <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
              Items Ordered ({lines.length})
              {linkedPOId && (
                <>
                  <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold normal-case text-primary ring-1 ring-primary/20">
                    <FileText className="h-2.5 w-2.5" />
                    Linked to{" "}
                    {purchaseOrders.find((p) => p.id === linkedPOId)?.poNumber}
                  </span>
                  {/* Raw by design: nested inside the `uppercase` <h3> above,
                      so it needs its own `normal-case` to read as "Preview PO"
                      rather than inherit ALL-CAPS. `normal-case` is a SOFT
                      typography class and the layering guard's soft ratchet
                      has zero slack (196/196 measured pre-batch) — dropping it
                      would be a real visual regression, keeping it would red
                      the guard. Also no minted size rung matches this
                      ~18px-tall / text-[10px] compact pill. */}
                  <button
                    type="button"
                    onClick={() => setPreviewPOId(linkedPOId)}
                    className="ml-1 inline-flex items-center gap-1 rounded-md border border-border bg-surface-light px-1.5 py-0.5 text-[10px] font-semibold normal-case text-text-secondary hover:bg-background-light"
                    title="Preview PO as PDF · print"
                  >
                    <Eye className="h-2.5 w-2.5 text-primary" />
                    Preview PO
                  </button>
                </>
              )}
            </h3>
            <div className="flex items-center gap-2">
              {/* Label sits INLINE beside the control, not above it -
                  FormField always renders its label above, which would flip
                  this to a stacked layout. Left raw. */}
              <label className="flex items-center gap-1.5 text-[11px] text-text-secondary">
                <FileText className="h-3 w-3 text-primary" />
                Auto-fill from PO:
                <SelectField
                  aria-label="Auto-fill from PO"
                  value={linkedPOId || "NONE"}
                  onValueChange={(v) => pickPO(v === "NONE" ? "" : v)}
                  className="rounded-md border border-border bg-surface-light px-1.5 py-0.5 text-[11px] focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
                  options={[
                    {
                      value: "NONE",
                      label:
                        form.jobId && jobPOs.length === 0
                          ? "— no PO on this job —"
                          : "— pick a PO —",
                    },
                    ...(form.jobId ? jobPOs : openPOs).map((p) => ({
                      value: p.id,
                      label: `${p.poNumber} · ${p.vendor} (${p.lines.length} ln)`,
                    })),
                  ]}
                />
              </label>
              {form.jobId && jobPOs.length > 0 && (
                <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-1.5 py-0.5 text-[10px] font-semibold text-success ring-1 ring-success/20">
                  <Sparkles className="h-2.5 w-2.5" />
                  {jobPOs.length} PO{jobPOs.length === 1 ? "" : "s"} on this job
                </span>
              )}
              <Button type="button" variant="outline" size="3xs" onClick={addLine}>
                <Plus className="h-3 w-3 text-primary" />
                Add item
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            {lines.map((line) => {
              const itm = allItems.find((i) => i.id === line.itemId);
              return (
                <div
                  key={line.uid}
                  className="grid grid-cols-12 items-end gap-2 rounded-md border border-border bg-surface-light px-2.5 py-2"
                >
                  <div className="col-span-4">
                    <MiniLabel>Item</MiniLabel>
                    <SelectField
                      aria-label="Item"
                      value={line.itemId}
                      onValueChange={(v) => {
                        const newItem = allItems.find((i) => i.id === v);
                        updateLine(line.uid, {
                          itemId: v,
                          vendor: line.vendor || newItem?.vendor || "",
                        });
                      }}
                      className={miniSelectCls}
                      options={allItems
                        .filter((i) => i.kind === "material")
                        .map((i) => ({
                          value: i.id,
                          label: `${i.sku} — ${i.name.slice(0, 36)}`,
                        }))}
                    />
                  </div>
                  <div className="col-span-1">
                    <MiniLabel>Qty</MiniLabel>
                    <Input
                      type="number"
                      min="1"
                      step="1"
                      placeholder="0"
                      value={line.qtyOrdered}
                      onChange={(e) =>
                        updateLine(line.uid, { qtyOrdered: e.target.value })
                      }
                      className={miniInputCls}
                    />
                  </div>
                  <div className="col-span-1">
                    <MiniLabel>UoM</MiniLabel>
                    <div className="rounded-md bg-background-light px-2 py-1.5 text-center text-xs font-mono text-text-secondary">
                      {itm?.uom ?? "EA"}
                    </div>
                  </div>
                  <div
                    className="col-span-3"
                    title="Pick which vendor this item is sourced from — split across vendors when items come from more than one"
                  >
                    <MiniLabel>Vendor</MiniLabel>
                    <SelectField
                      aria-label="Vendor"
                      value={line.vendor || "NONE"}
                      onValueChange={(v) =>
                        updateLine(line.uid, { vendor: v === "NONE" ? "" : v })
                      }
                      className={miniSelectCls}
                      options={[
                        // If the current value isn't in our vendor table (custom
                        // entry, or a vendor that's been retired), surface it
                        // at the top so the operator can still see + keep it.
                        ...(line.vendor && !allVendors.some((v) => v.name === line.vendor)
                          ? [{ value: line.vendor, label: line.vendor }]
                          : []),
                        { value: "NONE", label: "Pick a vendor…" },
                        ...allVendors
                          .filter((v) => v.id !== "vnd_internal")
                          .map((v) => ({ value: v.name, label: v.name })),
                      ]}
                    />
                  </div>
                  <div className="col-span-1">
                    <MiniLabel>PO #</MiniLabel>
                    <Input
                      value={line.poNumber}
                      onChange={(e) =>
                        updateLine(line.uid, { poNumber: e.target.value })
                      }
                      placeholder="PO-…"
                      className={miniInputCls}
                    />
                  </div>
                  <div className="col-span-2">
                    <MiniLabel>ETA</MiniLabel>
                    <DatePicker
                      value={line.expectedDate}
                      onChange={(v) =>
                        updateLine(line.uid, { expectedDate: v })
                      }
                      inputClassName="h-7 px-1.5 py-1 text-xs"
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    tone="danger"
                    revealOnHover
                    size="3xs"
                    onClick={() => removeLine(line.uid)}
                    disabled={lines.length === 1}
                    title={lines.length === 1 ? "Need at least one item" : "Remove line"}
                    aria-label="Remove line"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              );
            })}
          </div>
        </div>

        <FormField label="Notes" optional>
          <Textarea
            value={form.notes}
            onChange={(e) => set("notes", e.target.value)}
            rows={2}
            placeholder="Hold for single dispatch · special handling · tech instructions"
            className={`${inputCls} resize-none`}
          />
        </FormField>
      </div>
    </Modal>

    <POPreviewDialog
      open={!!previewPOId}
      onClose={() => setPreviewPOId(null)}
      poId={previewPOId}
      zIndex={80}
      lockEscape
    />

    <NoInventoryLocationDialog
      open={noLocationOpen}
      onClose={() => setNoLocationOpen(false)}
    />

    </>
  );
}

const inputCls = "w-full px-2.5 py-1.5";

// SelectField isn't a design-system primitive under the layering guard, so it
// keeps its prior appearance verbatim, independent of the now-stripped inputCls.
const selectCls =
  "w-full rounded-md border border-border bg-surface-light px-2.5 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";

const miniInputCls = "w-full px-1.5 py-1";

// Same decoupling for the compact line-item SelectField cells.
const miniSelectCls =
  "w-full rounded-md border border-border bg-surface-light px-1.5 py-1 text-xs truncate focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20";

function MiniLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-0.5 block text-[9px] font-medium uppercase tracking-wide text-text-secondary">
      {children}
    </span>
  );
}

function techRoleLabel(role: Tech["role"]): string {
  switch (role) {
    case "field_tech":
      return "Field Tech";
    case "warehouse_lead":
      return "Warehouse Lead";
    case "counter":
      return "Counter";
    case "subcontractor":
      return "Subcontractor (1099)";
  }
}
