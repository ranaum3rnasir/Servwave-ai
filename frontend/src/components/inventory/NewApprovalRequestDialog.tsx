import type React from "react";
import { useEffect, useState } from "react";
import {
  ArrowRight,
  Briefcase,
  Mail,
  Package,
  ScanLine,
  Send,
  Trash2,
  Truck,
  Undo2,
} from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { SelectField } from "@/components/form/SelectField";
import {
  useInventoryItems,
  useInventoryJobs,
  useTechs,
  useCreateApproval,
  type Location,
  type StockApproval,
} from "@/lib/api/inventory";
// `ApprovalActionType` is not re-exported by the seam yet — see `concerns`.
// Type-only `_mock` import is allowed by the port rules when the seam lacks a
// needed type.
import type { ApprovalActionType } from "@/lib/api/_mock/inventory";
import { ScanDialog } from "@/components/inventory/ScanDialog";
import { ApprovalEmailDialog } from "@/components/inventory/ApprovalEmailDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/patterns/FormField";

type Props = {
  open: boolean;
  onClose: () => void;
  locations: Location[];
  // Optional parent sync hook. The dialog persists via the seam
  // (`useCreateApproval`) itself; when provided, the parent receives the same
  // payload so its local view can stay in sync. Preserves the Emanuel contract
  // without depending on the parent to mint the created entity.
  onSubmit?: (request: Omit<StockApproval, "id" | "status">) => void;
  onEmailSent?: (payload: {
    approvalId: string;
    to: string[];
    subject: string;
  }) => void;
};

const typeOptions: {
  value: ApprovalActionType;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  hint: string;
  needsTo: boolean;
  needsJob: boolean;
  tint: string;
}[] = [
  {
    value: "consume_on_job",
    label: "Consume on Job",
    icon: Briefcase,
    hint: "Tech installs the part at a customer site — depletes the tech's van stock.",
    needsTo: false,
    needsJob: true,
    tint: "border-primary/40 bg-primary-subtle",
  },
  {
    value: "transfer_to_van",
    label: "Transfer to Van",
    icon: Truck,
    hint: "Load van from warehouse / counter for an upcoming job.",
    needsTo: true,
    needsJob: false,
    tint: "border-info/20 bg-info/10",
  },
  {
    value: "return_to_warehouse",
    label: "Return to Warehouse",
    icon: Undo2,
    hint: "Tech returns unused stock at end of day or after job completion.",
    needsTo: true,
    needsJob: false,
    tint: "border-success/20 bg-success/10",
  },
  {
    value: "writeoff",
    label: "Write-off",
    icon: Trash2,
    hint: "Damaged / lost / shrinkage — adjusts stock down with required reason.",
    needsTo: false,
    needsJob: false,
    tint: "border-danger/20 bg-danger/10",
  },
];

export function NewApprovalRequestDialog({
  open,
  onClose,
  locations,
  onSubmit,
  onEmailSent,
}: Props) {
  // Data via the seam (mock-backed today, /api/inventory/* in Track 2).
  const { data: allItems = [] } = useInventoryItems();
  const { data: allJobs = [] } = useInventoryJobs();
  const { data: allTechs = [] } = useTechs();
  const createApproval = useCreateApproval();

  const [type, setType] = useState<ApprovalActionType>("transfer_to_van");
  const [requesterTechId, setRequesterTechId] = useState("tech_carlos");
  const [itemSku, setItemSku] = useState("");
  const [qty, setQty] = useState("");
  const [fromLocationId, setFromLocationId] = useState("loc_wh_main");
  const [toLocationId, setToLocationId] = useState("loc_van_carlos");
  const [jobId, setJobId] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showScan, setShowScan] = useState(false);
  const [pendingEmail, setPendingEmail] = useState<StockApproval | null>(null);

  // Seed the item default once the seam delivers items (Emanuel read
  // `allItems[0].sku` at module load; the async seam needs this deferred).
  useEffect(() => {
    if (!itemSku && allItems.length > 0) {
      setItemSku(allItems[0]!.sku);
    }
  }, [allItems, itemSku]);

  const opt = typeOptions.find((o) => o.value === type) ?? typeOptions[0]!;
  const driverTechs = allTechs.filter(
    (t) => t.role === "field_tech" || t.role === "subcontractor",
  );
  const item = allItems.find((i) => i.sku === itemSku);
  const fromLoc = locations.find((l) => l.id === fromLocationId);
  const toLoc = locations.find((l) => l.id === toLocationId);
  const job = jobId ? allJobs.find((j) => j.id === jobId) : undefined;
  const tech = allTechs.find((t) => t.id === requesterTechId);

  function reset() {
    setType("transfer_to_van");
    setRequesterTechId("tech_carlos");
    setItemSku(allItems[0]?.sku ?? "");
    setQty("");
    setFromLocationId("loc_wh_main");
    setToLocationId("loc_van_carlos");
    setJobId("");
    setReason("");
    setError(null);
  }

  // Validate + construct the request payload. Returns null when validation fails
  // (and sets the error banner). Used by both Submit and Submit+Email paths.
  function buildRequest(): Omit<StockApproval, "id" | "status"> | null {
    if (!tech) {
      setError("Pick a requester tech.");
      return null;
    }
    if (!item) {
      setError("Pick an item.");
      return null;
    }
    const q = parseInt(qty || "0", 10);
    if (!q || q <= 0) {
      setError("Quantity must be > 0.");
      return null;
    }
    if (opt.needsTo && !toLoc) {
      setError("Pick a destination location.");
      return null;
    }
    if (opt.needsJob && !jobId) {
      setError("Pick a job for consume.");
      return null;
    }
    if (!reason.trim()) {
      setError("Reason is required.");
      return null;
    }
    setError(null);
    return {
      requestedAt: new Date().toISOString(),
      requestedByTechId: tech.id,
      requestedByTechName: tech.name,
      type,
      itemSku: item.sku,
      itemName: item.name,
      uom: item.uom,
      qty: q,
      fromLocationId,
      fromLocationName: fromLoc?.name ?? fromLocationId,
      toLocationId: opt.needsTo ? toLocationId : undefined,
      toLocationName: opt.needsTo ? toLoc?.name : undefined,
      jobNumber: job?.jobNumber,
      customer: job?.customer,
      reason: reason.trim(),
    };
  }

  // Persist the request through the seam and return the created StockApproval
  // (with a synthesized id + pending status) so the email composer can
  // reference it. The optional parent `onSubmit` is also notified for sync.
  function persist(
    req: Omit<StockApproval, "id" | "status">,
  ): StockApproval {
    const created: StockApproval = {
      ...req,
      id: `apr_new_${Date.now()}`,
      status: "pending",
    };
    createApproval.mutate(created);
    onSubmit?.(req);
    return created;
  }

  function submit() {
    const req = buildRequest();
    if (!req) return;
    persist(req);
    reset();
    onClose();
  }

  // Submit, then open the email composer for the freshly-created approval.
  function submitAndEmail() {
    const req = buildRequest();
    if (!req) return;
    const created = persist(req);
    setPendingEmail(created);
    // Don't reset/close yet — the user is still composing. We close after the
    // email composer is dismissed (sent or cancelled).
  }

  function closeEmailComposer() {
    setPendingEmail(null);
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
      lockEscape={showScan || !!pendingEmail}
      title="New Stock-Out Approval Request"
      subtitle="Submit on behalf of a field tech — the request lands in the queue at the top, pending sign-off."
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
          {/* Raw by design: a brand-tinted outline button (border-primary/40,
              text-primary, hover:bg-primary-subtle) - no minted outline/brand
              cell exists (outline only has neutral + danger tones). */}
          <button
            onClick={submitAndEmail}
            className="inline-flex items-center gap-1.5 rounded-md border border-primary/40 bg-surface-light px-3 py-1.5 text-sm font-semibold text-primary hover:bg-primary-subtle"
            title="Submit the request AND email the approval team (logistics manager · admin · owner) with full context"
          >
            <Mail className="h-3.5 w-3.5" />
            Submit + Email Team
          </button>
          <Button size="sm"
            onClick={submit}
          >
            <Send className="h-3.5 w-3.5" />
            Submit for Approval
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
        {/* Type selector */}
        <div>
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-text-secondary">
            Action Type
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {typeOptions.map((o) => {
              const Icon = o.icon;
              const active = type === o.value;
              return (
                // Raw by design: a segmented toggle control (single-select
                // action-type card grid), not Button-shaped.
                <button
                  key={o.value}
                  type="button"
                  onClick={() => setType(o.value)}
                  className={[
                    "flex flex-col items-start gap-1 rounded-md border-2 p-2.5 text-left transition",
                    active ? o.tint : "border-border bg-surface-light hover:bg-background-light",
                  ].join(" ")}
                >
                  <Icon
                    className={[
                      "h-4 w-4",
                      active ? "text-text-primary" : "text-text-secondary",
                    ].join(" ")}
                  />
                  <span className="text-xs font-semibold text-text-primary">
                    {o.label}
                  </span>
                  <span className="text-[10px] leading-tight text-text-secondary">
                    {o.hint}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Requester + item */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {/* Not converted to FormField: SelectField's own API has no `id`
              and does not spread the rest of its props onto the trigger, so
              FormField's generated id would reach no element and the label
              would point at nothing (same structural block as LeadFormPage's
              TimeSelect deferral). This site also has a second sibling
              (the branch/vehicle line) under the same label. */}
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">
              Requested By (Tech)
            </span>
            <SelectField
              aria-label="Requested by (tech)"
              value={requesterTechId}
              onValueChange={setRequesterTechId}
              className={selectCls}
              options={driverTechs.map((t) => ({
                value: t.id,
                label: `${t.name} · ${t.primaryTrade}${t.role === "subcontractor" ? " · 1099" : ""}`,
              }))}
            />
            {tech && (
              <span className="text-[11px] text-text-secondary">
                {tech.branch}
                {tech.vehicle ? ` · ${tech.vehicle}` : ""}
              </span>
            )}
          </label>
          {/* Not converted to FormField: SelectField non-forwarding (see the
              Requested By comment above), plus a second sibling control
              (the Scan trigger) under the same label. */}
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">
              Item
            </span>
            <div className="flex min-w-0 gap-1">
              <SelectField
                aria-label="Item"
                value={itemSku}
                onValueChange={setItemSku}
                className={`min-w-0 flex-1 truncate ${selectCls}`}
                options={allItems
                  .filter((i) => i.kind === "material")
                  .map((i) => ({
                    value: i.sku,
                    label: `${i.sku} — ${i.name.slice(0, 36)}`,
                  }))}
              />
              {/* Raw by design: a brand-tinted outline/filled hybrid
                  (border-primary/40, bg-primary-subtle, text-primary) - no
                  minted cell reproduces this look. */}
              <button
                type="button"
                onClick={() => setShowScan(true)}
                title="Scan barcode / QR / phone camera to find item"
                aria-label="Scan to find item"
                className="flex flex-shrink-0 items-center gap-1 rounded-md border border-primary/40 bg-primary-subtle px-2 text-xs font-semibold text-primary hover:bg-primary-subtle"
              >
                <ScanLine className="h-3.5 w-3.5" />
                Scan
              </button>
            </div>
          </label>
        </div>

        {/* Qty + From + To */}
        <div className="grid grid-cols-12 gap-3">
          <div className="col-span-2">
            <FormField label={<>Quantity ({item?.uom})</>} gap={1}>
              <Input
                type="number"
                min="1"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                placeholder="0"
                className={inputCls}
                autoFocus
              />
            </FormField>
          </div>
          {/* Not converted to FormField: SelectField non-forwarding (see the
              Requested By comment above). */}
          <label className="col-span-5 flex flex-col gap-1">
            <span className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">
              From Location
            </span>
            <SelectField
              aria-label="From location"
              value={fromLocationId}
              onValueChange={setFromLocationId}
              className={selectCls}
              options={locations.map((l) => ({ value: l.id, label: l.name }))}
            />
          </label>
          {opt.needsTo && (
            // Not converted to FormField: SelectField non-forwarding (see the
            // Requested By comment above).
            <label className="col-span-5 flex flex-col gap-1">
              <span className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-text-secondary">
                <ArrowRight className="h-3 w-3" /> To Location
              </span>
              <SelectField
                aria-label="To location"
                value={toLocationId}
                onValueChange={setToLocationId}
                className={selectCls}
                options={locations.map((l) => ({ value: l.id, label: l.name }))}
              />
            </label>
          )}
        </div>

        {/* Job (consume only) */}
        {opt.needsJob && (
          // Not converted to FormField: SelectField non-forwarding (see the
          // Requested By comment above).
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">
              Linked Job
            </span>
            <SelectField
              aria-label="Linked job"
              value={jobId || "NONE"}
              onValueChange={(v) => setJobId(v === "NONE" ? "" : v)}
              className={selectCls}
              options={[
                { value: "NONE", label: "— select a job —" },
                ...allJobs.map((j) => ({
                  value: j.id,
                  label: `${j.jobNumber} · ${j.customer} · ${j.trade}`,
                })),
              ]}
            />
          </label>
        )}

        {/* Reason */}
        <FormField label="Reason" gap={1}>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder={
              type === "consume_on_job"
                ? "What's being installed and where on site"
                : type === "transfer_to_van"
                  ? "Why this stock is being loaded — job prep, replenish, etc."
                  : type === "return_to_warehouse"
                    ? "Excess from job · condition · why returning"
                    : "Why writing off — damaged, lost, expired, etc."
            }
            className={`${inputCls} resize-none`}
          />
        </FormField>

        {/* Nested scan picker — opens on top of this dialog */}
        <ScanDialog
          open={showScan}
          onClose={() => setShowScan(false)}
          pickerMode
          onMatch={(matched) => {
            setItemSku(matched.sku);
            setShowScan(false);
          }}
        />

        {/* Preview / context */}
        <div className="rounded-md border border-border bg-background-light p-3">
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
            Preview
          </p>
          <div className="flex items-center gap-2 text-sm">
            <Package className="h-4 w-4 text-text-secondary" />
            <span className="font-mono text-xs text-text-secondary">{itemSku}</span>
            <span className="font-semibold text-text-primary">
              {qty || "0"} {item?.uom}
            </span>
            <span className="text-text-secondary">→</span>
            <span className="text-text-secondary">{opt.label}</span>
            {job && (
              <>
                <span className="text-text-secondary">·</span>
                <span className="font-mono text-xs text-text-secondary">
                  {job.jobNumber}
                </span>
                <span className="text-xs text-text-secondary">· {job.customer}</span>
              </>
            )}
          </div>
        </div>
      </div>
    </Modal>

    <ApprovalEmailDialog
      open={!!pendingEmail}
      onClose={closeEmailComposer}
      approval={pendingEmail}
      zIndex={80}
      lockEscape
      onSent={(payload) => {
        if (pendingEmail) {
          onEmailSent?.({
            approvalId: pendingEmail.id,
            to: payload.to,
            subject: payload.subject,
          });
        }
        closeEmailComposer();
      }}
    />
    </>
  );
}

const inputCls = "w-full px-2.5 py-1.5";

// SelectField isn't a design-system primitive under the layering guard, so it
// keeps its prior appearance verbatim, independent of the now-stripped inputCls.
const selectCls =
  "w-full rounded-md border border-border bg-surface-light px-2.5 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-subtle";
