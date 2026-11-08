import { useEffect, useMemo, useState } from "react";
import {
  AlertOctagon,
  ArrowRight,
  Briefcase,
  Calendar,
  CheckCircle2,
  Clock,
  Download,
  FileText,
  History,
  Mail,
  MapPin,
  Package,
  Pencil,
  Printer,
  Save,
  ShieldCheck,
  ThumbsDown,
  ThumbsUp,
  Truck,
} from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { UploadedImage } from "@/components/ui/uploaded-image";
import {
  approvalTypeLabel,
  approvalTypeTint,
  tradeColor,
  useInventoryItems,
  useTechs,
  useInventoryJobs,
  useDecideApproval,
  type ApprovalModification,
  type StockApproval,
} from "@/lib/api/inventory";
import { ApprovalEmailDialog } from "@/components/inventory/ApprovalEmailDialog";
import { SignatureField } from "@/components/inventory/SignatureField";
import { fmtSignedAt, type SignatureValue } from "@/lib/inventory/signatures";
import { useAppAbility } from "@/contexts/AbilityContext";
import { useAuthStore } from "@/stores/auth.store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { StatusBadge } from "@/components/data/status-badge";
import { useScheduleTimezone } from '@/lib/schedule-tz';

type EditablePatch = Partial<
  Pick<
    StockApproval,
    "qty" | "reason" | "jobNumber" | "customer" | "serialCaptured" | "toLocationName"
  >
> & { modifications?: ApprovalModification[] };

type Props = {
  open: boolean;
  onClose: () => void;
  approval: StockApproval | null;
  canApprove: boolean;
  onApprove: (id: string, comment?: string) => void;
  onReject: (id: string, comment: string) => void;
  onEdit?: (id: string, patch: EditablePatch) => void;
  onEmailSent?: (payload: {
    approvalId: string;
    to: string[];
    subject: string;
  }) => void;
};

type DraftFields = {
  qty: number;
  reason: string;
  jobNumber: string;
  customer: string;
  serialCaptured: string;
  toLocationName: string;
};

function toDraft(a: StockApproval): DraftFields {
  return {
    qty: a.qty,
    reason: a.reason ?? "",
    jobNumber: a.jobNumber ?? "",
    customer: a.customer ?? "",
    serialCaptured: a.serialCaptured ?? "",
    toLocationName: a.toLocationName ?? "",
  };
}

function diffDraft(orig: StockApproval, d: DraftFields): {
  patch: EditablePatch;
  summary: string[];
} {
  const patch: EditablePatch = {};
  const summary: string[] = [];
  const origDraft = toDraft(orig);
  if (d.qty !== origDraft.qty) {
    patch.qty = d.qty;
    summary.push(`qty ${origDraft.qty} → ${d.qty}`);
  }
  if (d.reason !== origDraft.reason) {
    patch.reason = d.reason || undefined;
    summary.push("reason");
  }
  if (d.jobNumber !== origDraft.jobNumber) {
    patch.jobNumber = d.jobNumber || undefined;
    summary.push(`job ${origDraft.jobNumber || "—"} → ${d.jobNumber || "—"}`);
  }
  if (d.customer !== origDraft.customer) {
    patch.customer = d.customer || undefined;
    summary.push("customer");
  }
  if (d.serialCaptured !== origDraft.serialCaptured) {
    patch.serialCaptured = d.serialCaptured || undefined;
    summary.push("serial");
  }
  if (d.toLocationName !== origDraft.toLocationName) {
    patch.toLocationName = d.toLocationName || undefined;
    summary.push(`dest → ${d.toLocationName || "—"}`);
  }
  return { patch, summary };
}

export function ApprovalDetailDialog({
  open,
  onClose,
  approval,
  canApprove,
  onApprove,
  onReject,
  onEdit,
  onEmailSent,
}: Props) {
  const ability = useAppAbility();
  const authUser = useAuthStore((s) => s.user);
  // ALPHA auth user has first_name/last_name (no single `name`); derive identity.
  const currentUserId = authUser?.id ?? "";
  const currentUserName = authUser
    ? `${authUser.first_name} ${authUser.last_name}`.trim()
    : "";
  const currentUserRole = authUser?.role ?? "";

  // Seam data (replaces Emanuel's module-scope arrays).
  const { data: allItems = [] } = useInventoryItems();
  const { data: allTechs = [] } = useTechs();
  const { data: allJobs = [] } = useInventoryJobs();
  const decideApproval = useDecideApproval();
  const tz = useScheduleTimezone();

  const [rejectComment, setRejectComment] = useState("");
  const [approveComment, setApproveComment] = useState("");
  const [mode, setMode] = useState<"view" | "rejecting">("view");
  const [showEmailDialog, setShowEmailDialog] = useState(false);
  const [approverSig, setApproverSig] = useState<SignatureValue | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState<DraftFields | null>(null);

  // Reset edit state whenever the dialog re-opens or the approval changes.
  useEffect(() => {
    if (!open) {
      setIsEditing(false);
      setDraft(null);
    }
  }, [open, approval?.id]);

  // CASL: managing Inventory permits editing an approval request (Track-2: a
  // dedicated `manage StockApproval` grant).
  const editable = ability.can("manage", "Inventory");
  const diff = useMemo(() => {
    if (!approval || !draft) return { patch: {}, summary: [] as string[] };
    return diffDraft(approval, draft);
  }, [approval, draft]);
  const hasChanges = Object.keys(diff.patch).length > 0;
  const qtyValid = !draft || draft.qty > 0;

  // Inject print-isolated CSS while open so Save-as-PDF / Print only render the doc body.
  useEffect(() => {
    if (!open) return;
    const style = document.createElement("style");
    style.id = "approval-print-style";
    style.textContent = `
      @media print {
        body * { visibility: hidden !important; }
        .approval-print-root, .approval-print-root * { visibility: visible !important; }
        .approval-print-root {
          position: fixed !important;
          inset: 0 !important;
          margin: 0 !important;
          padding: 14mm 16mm !important;
          background: white !important;
          box-shadow: none !important;
          overflow: visible !important;
          color: rgb(var(--text-primary)) !important;
        }
        .approval-print-hide { display: none !important; }
        @page { size: Letter; margin: 0; }
      }
    `;
    document.head.appendChild(style);
    return () => {
      const el = document.getElementById("approval-print-style");
      if (el) el.remove();
    };
  }, [open]);

  if (!approval) return null;

  function handlePrint() {
    // Browser print dialog includes "Save as PDF" as a destination.
    window.print();
  }

  const tech = allTechs.find((t) => t.id === approval.requestedByTechId);
  const job = approval.jobNumber
    ? allJobs.find((j) => j.jobNumber === approval.jobNumber)
    : undefined;
  const item = allItems.find((i) => i.sku === approval.itemSku);

  function handleApprove() {
    if (!approval) return;
    if (!approverSig) return; // gated by signature
    const note = approveComment.trim();
    const sigNote = `Signed by ${approverSig.fullName} · ${fmtSignedAt(approverSig.signedAt, tz)}`;
    const combined = note ? `${note} — ${sigNote}` : sigNote;
    // Seam mutation (mock resolves; Track 2 -> POST /api/inventory/stock-approvals/decide).
    decideApproval.mutate({
      id: approval.id,
      decision: "approved",
      comment: combined,
      signature: approverSig,
    });
    onApprove(approval.id, combined);
    setApproveComment("");
    setApproverSig(null);
    onClose();
  }

  function handleReject() {
    if (!approval || !rejectComment.trim()) return;
    const comment = rejectComment.trim();
    decideApproval.mutate({ id: approval.id, decision: "rejected", comment });
    onReject(approval.id, comment);
    setRejectComment("");
    setMode("view");
    onClose();
  }

  function startEditing() {
    if (!approval) return;
    setDraft(toDraft(approval));
    setIsEditing(true);
    setMode("view");
  }

  function cancelEditing() {
    setIsEditing(false);
    setDraft(null);
  }

  function saveEdits() {
    if (!approval || !draft || !onEdit) return;
    if (!hasChanges || !qtyValid) return;
    const postDecision = approval.status !== "pending";
    const note = diff.summary.join(", ");
    const entry: ApprovalModification = {
      at: new Date().toISOString(),
      byName: currentUserName,
      note: note || "edited",
      postDecision,
    };
    const patch: EditablePatch = {
      ...diff.patch,
      modifications: [...(approval.modifications ?? []), entry],
    };
    onEdit(approval.id, patch);
    setIsEditing(false);
    setDraft(null);
  }

  return (
    <>
    <Modal
      open={open}
      onClose={() => {
        setRejectComment("");
        setApproveComment("");
        setMode("view");
        cancelEditing();
        onClose();
      }}
      lockEscape={showEmailDialog || isEditing}
      title={`Stock-Out Request · ${approval.itemSku}`}
      subtitle={`Submitted by ${approval.requestedByTechName} on ${new Date(approval.requestedAt).toLocaleString('en-US')}`}
      size="xl"
      editAction={
        onEdit && editable && !isEditing && mode === "view"
          ? {
              label: "Edit",
              onClick: startEditing,
              icon: <Pencil className="h-3.5 w-3.5" />,
            }
          : undefined
      }
      footer={
        isEditing ? (
          <>
            <Button variant="outline" size="sm"
              onClick={cancelEditing}
            >
              Cancel
            </Button>
            <Button size="sm"
              onClick={saveEdits}
              disabled={!hasChanges || !qtyValid}
              title={
                !hasChanges
                  ? "No changes to save"
                  : !qtyValid
                    ? "Quantity must be greater than zero"
                    : approval.status === "pending"
                      ? "Save changes"
                      : "Save changes — will be logged as post-decision edit"
              }
            >
              <Save className="h-3.5 w-3.5" />
              Save Changes
            </Button>
          </>
        ) : approval.status === "pending" && canApprove ? (
          mode === "view" ? (
            <>
              <Button variant="outline" size="sm"
                onClick={() => {
                  setRejectComment("");
                  setApproveComment("");
                  onClose();
                }}
              >
                Close
              </Button>
              {/* Raw by design: no minted outline+brand cell exists (outline
                  only has neutral + danger tones). */}
              <button
                onClick={() => setShowEmailDialog(true)}
                className="inline-flex items-center gap-1.5 rounded-md border border-primary/20 bg-surface-light px-3 py-1.5 text-sm font-semibold text-primary hover:bg-primary/10"
                title="Email this request to the approval team"
              >
                <Mail className="h-3.5 w-3.5" />
                Email Team
              </button>
              <Button variant="outline" size="sm"
                onClick={handlePrint}
                title="Save as PDF via browser print dialog"
                className="inline-flex items-center gap-1.5"
              >
                <Download className="h-3.5 w-3.5" />
                Save as PDF
              </Button>
              <Button variant="outline" size="sm"
                onClick={handlePrint}
                title="Print this approval request"
                className="inline-flex items-center gap-1.5"
              >
                <Printer className="h-3.5 w-3.5" />
                Print
              </Button>
              <Button
                variant="outline"
                tone="danger"
                size="sm"
                onClick={() => setMode("rejecting")}
              >
                <ThumbsDown className="h-3.5 w-3.5" />
                Reject
              </Button>
              <Button
                variant="solid"
                tone="business"
                size="sm"
                onClick={handleApprove}
                disabled={!approverSig}
                title={
                  approverSig
                    ? "Approve and post the stock movement"
                    : "Sign the approval block below to enable"
                }
              >
                <ThumbsUp className="h-3.5 w-3.5" />
                Approve · post movement
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" size="sm"
                onClick={() => setMode("view")}
              >
                Cancel
              </Button>
              <Button
                variant="solid"
                tone="danger"
                size="sm"
                onClick={handleReject}
                disabled={!rejectComment.trim()}
              >
                <ThumbsDown className="h-3.5 w-3.5" />
                Confirm Reject
              </Button>
            </>
          )
        ) : (
          <>
            <Button variant="outline" size="sm"
              onClick={onClose}
            >
              Close
            </Button>
            {/* Raw by design: no minted outline+brand cell exists (outline
                only has neutral + danger tones). */}
            <button
              onClick={() => setShowEmailDialog(true)}
              className="inline-flex items-center gap-1.5 rounded-md border border-primary/20 bg-surface-light px-3 py-1.5 text-sm font-semibold text-primary hover:bg-primary/10"
              title="Email this request"
            >
              <Mail className="h-3.5 w-3.5" />
              Email
            </button>
            <Button variant="outline" size="sm"
              onClick={handlePrint}
              title="Save as PDF via browser print dialog"
              className="inline-flex items-center gap-1.5"
            >
              <Download className="h-3.5 w-3.5" />
              Save as PDF
            </Button>
            <Button size="sm"
              onClick={handlePrint}
              title="Print this approval request"
            >
              <Printer className="h-3.5 w-3.5" />
              Print
            </Button>
          </>
        )
      }
    >
      <div className="approval-print-root flex flex-col gap-4">
        {/* Top status + type strip */}
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-background-light/40 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ${approvalTypeTint(approval.type)}`}
            >
              {approvalTypeLabel(approval.type)}
            </span>
            <StatusBadge domain="approval" status={approval.status} />
            <code className="font-mono text-[11px] text-text-secondary">
              req {approval.id}
            </code>
          </div>
          <div className="flex items-center gap-1 text-xs text-text-secondary">
            <Clock className="h-3 w-3" />
            {new Date(approval.requestedAt).toLocaleString('en-US', {
              weekday: "short",
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </div>
        </div>

        {/* Three-column overview: Item · Movement · Tech/Job */}
        <div className="grid grid-cols-12 gap-3">
          {/* Item card */}
          <div className="col-span-4 rounded-md border border-border bg-surface-light p-3">
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
              Item
            </p>
            <div className="flex gap-2">
              {item?.photoUrl ? (
                <UploadedImage
                  src={item.photoUrl}
                  alt={item.name}
                  radius="md"
                  edge="ring"
                  className="h-12 w-12 flex-shrink-0"
                />
              ) : (
                <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-md bg-background-light ring-1 ring-border">
                  <Package className="h-5 w-5 text-text-secondary" />
                </div>
              )}
              <div className="min-w-0">
                <code className="font-mono text-[11px] text-text-secondary">
                  {approval.itemSku}
                </code>
                <p className="text-sm font-semibold text-text-primary">
                  {approval.itemName}
                </p>
                {item && (
                  <div className="mt-0.5 flex flex-wrap items-center gap-1">
                    <span
                      className={`rounded-full px-1.5 py-0.5 text-[9px] font-medium ring-1 ${tradeColor[item.trade] ?? ""}`}
                    >
                      {item.trade}
                    </span>
                    <span className="rounded-full bg-background-light px-1.5 py-0.5 text-[9px] text-text-secondary">
                      {item.category}
                    </span>
                  </div>
                )}
              </div>
            </div>
            {item && (
              <div className="mt-2 grid grid-cols-2 gap-2 border-t border-border pt-2 text-[11px]">
                <div>
                  <span className="block text-[9px] uppercase text-text-secondary">
                    Unit Cost
                  </span>
                  <span className="font-mono font-semibold text-text-primary">
                    ${(item.unitCost ?? 0).toFixed(2)}
                  </span>
                </div>
                <div>
                  <span className="block text-[9px] uppercase text-text-secondary">
                    Vendor
                  </span>
                  <span className="text-text-secondary">{item.vendor}</span>
                </div>
              </div>
            )}
          </div>

          {/* Movement card */}
          <div className="col-span-4 rounded-md border border-primary/20 bg-primary/5 p-3">
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
              Movement Request
            </p>
            <div className="text-center">
              {isEditing && draft ? (
                <div className="flex items-center justify-center gap-2">
                  <Input
                    type="number"
                    min={1}
                    value={draft.qty}
                    onChange={(e) =>
                      setDraft({ ...draft, qty: Number(e.target.value) || 0 })
                    }
                    invalid={!qtyValid}
                    className="w-20 px-2 py-1 text-center"
                  />
                  <span className="text-base font-normal text-text-secondary">
                    {approval.uom}
                  </span>
                </div>
              ) : (
                <p className="text-3xl font-bold text-text-primary">
                  {approval.qty}
                  <span className="ml-1 text-base font-normal text-text-secondary">
                    {approval.uom}
                  </span>
                </p>
              )}
              {item && (
                <p className="mt-0.5 font-mono text-[11px] text-text-secondary">
                  ≈ ${((isEditing && draft ? draft.qty : approval.qty) * (item.unitCost ?? 0)).toFixed(2)} value
                </p>
              )}
            </div>
            <div className="mt-2 border-t border-primary/20 pt-2">
              <div className="flex items-center gap-1.5 text-xs">
                <Truck className="h-3.5 w-3.5 text-text-secondary" />
                <span className="font-medium text-text-primary">
                  {approval.fromLocationName}
                </span>
              </div>
              {isEditing && draft ? (
                <div className="mt-1 flex items-center gap-1.5 text-xs">
                  <ArrowRight className="h-3 w-3 text-text-secondary" />
                  <MapPin className="h-3.5 w-3.5 text-success" />
                  <Input
                    value={draft.toLocationName}
                    onChange={(e) =>
                      setDraft({ ...draft, toLocationName: e.target.value })
                    }
                    placeholder="Destination location"
                    className="px-1.5 py-0.5"
                  />
                </div>
              ) : (
                approval.toLocationName && (
                  <div className="mt-1 flex items-center gap-1.5 text-xs">
                    <ArrowRight className="h-3 w-3 text-text-secondary" />
                    <MapPin className="h-3.5 w-3.5 text-success" />
                    <span className="font-medium text-text-primary">
                      {approval.toLocationName}
                    </span>
                  </div>
                )
              )}
              {isEditing && draft ? (
                <div className="mt-2 rounded bg-surface-light px-2 py-1 text-[10px]">
                  <span className="text-text-secondary">Serial captured:</span>{" "}
                  <Input
                    value={draft.serialCaptured}
                    onChange={(e) =>
                      setDraft({ ...draft, serialCaptured: e.target.value })
                    }
                    placeholder="e.g. HES-A8821"
                    className="ml-1 px-1 py-0.5"
                  />
                </div>
              ) : (
                approval.serialCaptured && (
                  <div className="mt-2 rounded bg-surface-light px-2 py-1 text-[10px]">
                    <span className="text-text-secondary">Serial captured:</span>{" "}
                    <code className="font-mono font-semibold text-text-primary">
                      {approval.serialCaptured}
                    </code>
                  </div>
                )
              )}
            </div>
          </div>

          {/* Tech + Job card */}
          <div className="col-span-4 rounded-md border border-border bg-surface-light p-3">
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
              Requested By
            </p>
            <div className="flex items-start gap-2">
              <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                {approval.requestedByTechName
                  .split(" ")
                  .map((n) => n[0] ?? "")
                  .join("")
                  .slice(0, 2)}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-text-primary">
                  {approval.requestedByTechName}
                </p>
                {tech && (
                  <>
                    <p className="text-[11px] capitalize text-text-secondary">
                      {tech.role.replace("_", " ")}
                      {tech.primaryTrade ? ` · ${tech.primaryTrade}` : ""}
                    </p>
                    <p className="text-[10px] text-text-secondary">{tech.branch}</p>
                    {tech.vehicle && (
                      <p className="text-[10px] text-text-secondary">
                        🚐 {tech.vehicle}
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>
            {tech?.certs && tech.certs.length > 0 && (
              <div className="mt-2 border-t border-border pt-2">
                <p className="mb-1 text-[9px] font-semibold uppercase text-text-secondary">
                  Certifications
                </p>
                <div className="flex flex-wrap gap-1">
                  {tech.certs.map((c) => (
                    <span
                      key={c}
                      className="rounded bg-background-light px-1.5 py-0.5 text-[10px] text-text-secondary"
                    >
                      {c}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Job context (full row) */}
        {(approval.jobNumber || approval.customer || isEditing) && (
          <div className="rounded-md border border-success/20 bg-success/10 p-3">
            <p className="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-success">
              <Briefcase className="h-3 w-3" />
              Job Context
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <div>
                <span className="block text-[9px] uppercase text-text-secondary">
                  Job #
                </span>
                {isEditing && draft ? (
                  <Input
                    value={draft.jobNumber}
                    onChange={(e) =>
                      setDraft({ ...draft, jobNumber: e.target.value })
                    }
                    placeholder="e.g. J-1850"
                    className="px-1.5 py-0.5"
                  />
                ) : (
                  <span className="font-mono font-semibold text-text-primary">
                    {approval.jobNumber ?? "—"}
                  </span>
                )}
              </div>
              <div>
                <span className="block text-[9px] uppercase text-text-secondary">
                  Customer
                </span>
                {isEditing && draft ? (
                  <Input
                    value={draft.customer}
                    onChange={(e) =>
                      setDraft({ ...draft, customer: e.target.value })
                    }
                    placeholder="Customer name"
                    className="px-1.5 py-0.5"
                  />
                ) : (
                  <span className="text-text-primary">
                    {approval.customer ?? "—"}
                  </span>
                )}
              </div>
              {job && (
                <>
                  <div>
                    <span className="block text-[9px] uppercase text-text-secondary">
                      Site
                    </span>
                    <span className="truncate text-text-secondary">{job.site}</span>
                  </div>
                  {job.scheduledFor && (
                    <div>
                      <span className="block text-[9px] uppercase text-text-secondary">
                        Scheduled
                      </span>
                      <span className="flex items-center gap-1 text-text-secondary">
                        <Calendar className="h-3 w-3" />
                        {new Date(job.scheduledFor).toLocaleString('en-US', {
                          weekday: "short",
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>
                  )}
                </>
              )}
            </div>
            {!job && approval.jobNumber && (
              <p className="mt-2 text-[10px] text-text-secondary">
                <Button variant="link" size={null}>Open Job →</Button>
              </p>
            )}
          </div>
        )}

        {/* Reason */}
        {(approval.reason || isEditing) && (
          <div className="rounded-md border border-border bg-surface-light p-3">
            <p className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
              <FileText className="h-3 w-3" />
              Tech's Reason
            </p>
            {isEditing && draft ? (
              <Textarea
                value={draft.reason}
                onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
                rows={2}
                placeholder="Describe what / where / why"
                className="resize-none px-2.5 py-1.5"
              />
            ) : (
              <p className="text-sm italic text-text-secondary">
                "{approval.reason}"
              </p>
            )}
          </div>
        )}

        {/* Decision audit (only if already decided) */}
        {approval.reviewedByName && (
          <div
            className={[
              "rounded-md border p-3",
              approval.status === "approved"
                ? "border-success/20 bg-success/10"
                : "border-danger/20 bg-danger/10",
            ].join(" ")}
          >
            <p
              className={[
                "mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide",
                approval.status === "approved"
                  ? "text-success"
                  : "text-danger",
              ].join(" ")}
            >
              {approval.status === "approved" ? (
                <CheckCircle2 className="h-3 w-3" />
              ) : (
                <AlertOctagon className="h-3 w-3" />
              )}
              {approval.status === "approved" ? "Approved" : "Rejected"}
            </p>
            <p className="text-sm text-text-secondary">
              By <strong>{approval.reviewedByName}</strong>
              {approval.reviewedAt && (
                <span className="text-text-secondary">
                  {" "}
                  · {new Date(approval.reviewedAt).toLocaleString('en-US')}
                </span>
              )}
            </p>
            {approval.reviewComment && (
              <p className="mt-1 text-xs italic text-text-secondary">
                "{approval.reviewComment}"
              </p>
            )}
          </div>
        )}

        {/* Modifications history */}
        {approval.modifications && approval.modifications.length > 0 && (
          <div className="rounded-md border border-border bg-surface-light p-3">
            <p className="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
              <History className="h-3 w-3" />
              Modifications
            </p>
            <ul className="space-y-1">
              {approval.modifications.map((m, idx) => (
                <li
                  key={idx}
                  className="flex items-start gap-2 text-xs text-text-secondary"
                >
                  <span className="font-mono text-[10px] text-text-secondary">
                    {new Date(m.at).toLocaleString('en-US', {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                  <span className="flex-1">
                    <strong>{m.byName}</strong>{" "}
                    <span className="text-text-secondary">edited</span>{" "}
                    <span className="italic">{m.note}</span>
                    {m.postDecision && (
                      <span className="ml-1 inline-flex items-center gap-0.5 rounded bg-warning/10 px-1 py-0.5 text-[9px] font-semibold uppercase text-warning ring-1 ring-warning/20">
                        post-decision
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* In-edit banner */}
        {isEditing && (
          <div className="approval-print-hide rounded-md border border-warning/20 bg-warning/10 p-3 text-xs text-warning">
            Editing this request. Use <strong>Save Changes</strong> below to
            commit, or <strong>Cancel</strong> to discard.
            {approval.status !== "pending" && (
              <>
                {" "}
                This request was already{" "}
                <strong>{approval.status}</strong> — edits will be marked{" "}
                <em>post-decision</em> in the audit log.
              </>
            )}
          </div>
        )}

        {/* Approve / Reject input (when pending + can approve) */}
        {!isEditing && approval.status === "pending" && canApprove && mode === "view" && (
          <div className="approval-print-hide space-y-3 rounded-md border border-border bg-background-light/40 p-3">
            <div>
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
                Approval Note (optional)
              </p>
              <Input
                value={approveComment}
                onChange={(e) => setApproveComment(e.target.value)}
                placeholder="e.g. Confirmed serial match with customer"
                className="px-2.5 py-1.5"
              />
            </div>
            {/* Approver e-signature — gates the Approve button. */}
            <div className="rounded-md border border-primary/10 bg-surface-light p-3">
              <SignatureField
                role="Approver Signature"
                signerId={currentUserId}
                defaultName={currentUserName}
                signerLabel={`${currentUserName} (${currentUserRole.toLowerCase().replace("_", " ")})`}
                currentUser={{ id: currentUserId, name: currentUserName }}
                value={approverSig}
                onSign={setApproverSig}
                onClear={() => setApproverSig(null)}
              />
              {!approverSig && (
                <p className="mt-2 text-[10px] italic text-text-secondary">
                  Required: sign above to enable "Approve · post movement".
                </p>
              )}
            </div>
          </div>
        )}

        {approval.status === "pending" && canApprove && mode === "rejecting" && (
          <div className="approval-print-hide rounded-md border border-danger/20 bg-danger/10 p-3">
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-danger">
              Rejection Reason (required)
            </p>
            <Textarea
              value={rejectComment}
              onChange={(e) => setRejectComment(e.target.value)}
              placeholder="Why are you rejecting this? (the tech sees this)"
              rows={2}
              className="resize-none px-2.5 py-1.5"
              autoFocus
            />
          </div>
        )}

        {approval.status === "pending" && !canApprove && (
          <div className="approval-print-hide rounded-md border border-warning/20 bg-warning/10 p-3 text-xs text-warning">
            <ShieldCheck className="mr-1 inline h-3 w-3" />
            Your role can view this request but cannot approve it. Ask a
            warehouse manager, inventory admin, or owner.
          </div>
        )}
      </div>
    </Modal>

    <ApprovalEmailDialog
      open={showEmailDialog}
      onClose={() => setShowEmailDialog(false)}
      approval={approval}
      zIndex={80}
      lockEscape
      onSent={(payload) => {
        onEmailSent?.({
          approvalId: approval.id,
          to: payload.to,
          subject: payload.subject,
        });
        setShowEmailDialog(false);
      }}
    />
    </>
  );
}
