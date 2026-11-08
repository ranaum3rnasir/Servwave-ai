import type React from "react";
import { useEffect, useState } from "react";
import {
  CheckCircle2,
  ChevronRight,
  Clock,
  MapPin,
  Plus,
  ShieldCheck,
  Truck,
  User,
  XCircle,
} from "lucide-react";
import type {
  StockApproval,
  ApprovalModification,
} from "@/lib/api/inventory";
import {
  useStockApprovals,
  useCreateApproval,
  useDecideApproval,
} from "@/lib/api/inventory";
import { useAppAbility } from "@/contexts/AbilityContext";
import { useAuthStore } from "@/stores/auth.store";
import { ApprovalDetailDialog } from "./ApprovalDetailDialog";
import { NewApprovalRequestDialog } from "./NewApprovalRequestDialog";
import type { Location } from "@/lib/api/inventory";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { StatusBadge } from "@/components/data/status-badge";
import { KpiTile } from "@/components/data/KpiStrip";

// approvalTypeLabel / approvalTypeTint are pure presentational helpers that
// live in lib/api/_mock/inventory/stock-approvals.ts. The seam
// (lib/api/inventory.ts) re-exports the StockApproval types but NOT these two
// helpers, and components may not import _mock directly. They are inlined here
// (token-normalized) until the seam re-exports them — see `concerns`.
type ApprovalActionType = StockApproval["type"];

function approvalTypeLabel(t: ApprovalActionType): string {
  switch (t) {
    case "consume_on_job":
      return "Consume on Job";
    case "return_to_warehouse":
      return "Return to Warehouse";
    case "writeoff":
      return "Write-off";
    case "transfer_to_van":
      return "Transfer to Van";
  }
}

function approvalTypeTint(t: ApprovalActionType): string {
  switch (t) {
    case "consume_on_job":
      return "bg-primary/10 text-primary ring-primary/20";
    case "return_to_warehouse":
      return "bg-success/10 text-success ring-success/20";
    case "writeoff":
      return "bg-danger/10 text-danger ring-danger/20";
    case "transfer_to_van":
      return "bg-info/10 text-info ring-info/20";
  }
}

type Props = {
  onToast: (msg: string) => void;
  locations: Location[];
  // Forwarded from InventoryPage when the TopBar bell fires a
  // pending_approval intent. The `nonce` changes on every click so the
  // effect re-runs even when the same id is re-clicked.
  pendingIntent?: { id: string; nonce: number } | null;
};

const filterTabs: { value: "all" | "pending" | "approved" | "rejected"; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "all", label: "All" },
];

export function ApprovalsView({ onToast, locations, pendingIntent }: Props) {
  // Seed from the seam, then mirror into local state so the prototype's
  // in-session optimistic updates (decide / edit / new request) still reflect
  // immediately. Track-2: the mutations persist server-side and the refetch
  // becomes the source of truth.
  const { data: seedApprovals = [] } = useStockApprovals();
  const createApproval = useCreateApproval();
  const decideApproval = useDecideApproval();
  const ability = useAppAbility();
  const user = useAuthStore((s) => s.user);
  const reviewerName = user
    ? `${user.first_name} ${user.last_name}`.trim()
    : "You";

  const [approvals, setApprovals] = useState<StockApproval[]>(seedApprovals);
  const [filter, setFilter] = useState<"all" | "pending" | "approved" | "rejected">(
    "pending",
  );
  const [openDetailId, setOpenDetailId] = useState<string | null>(null);
  const [showNewRequest, setShowNewRequest] = useState(false);
  const openDetail = approvals.find((a) => a.id === openDetailId) ?? null;

  // Re-seed local state when the query resolves / refetches.
  useEffect(() => {
    setApprovals(seedApprovals);
  }, [seedApprovals]);

  // Bell-driven open: when InventoryPage receives a pending_approval intent,
  // it forwards { id, nonce } here. We flip the filter to Pending so the
  // row stays visible behind the dialog, then open the detail dialog by id.
  // Per PRD §5.4.A.ix v2.
  useEffect(() => {
    if (!pendingIntent) return;
    setFilter("pending");
    setOpenDetailId(pendingIntent.id);
  }, [pendingIntent?.id, pendingIntent?.nonce]);

  const canApprove = ability.can("manage", "Inventory");

  const filtered = approvals.filter((a) =>
    filter === "all" ? true : a.status === filter,
  );
  const counts = {
    pending: approvals.filter((a) => a.status === "pending").length,
    approved: approvals.filter((a) => a.status === "approved").length,
    rejected: approvals.filter((a) => a.status === "rejected").length,
    all: approvals.length,
  };

  function decide(id: string, decision: "approved" | "rejected", comment?: string) {
    setApprovals((prev) =>
      prev.map((a) =>
        a.id === id
          ? {
              ...a,
              status: decision,
              reviewedAt: new Date().toISOString(),
              reviewedByName: reviewerName,
              reviewComment: comment,
            }
          : a,
      ),
    );
    decideApproval.mutate({ id, decision, comment });
    const apr = approvals.find((a) => a.id === id);
    onToast(
      decision === "approved"
        ? `✓ Approved ${apr?.qty} × ${apr?.itemSku} · stock movement posted`
        : `✗ Rejected request from ${apr?.requestedByTechName} · ${apr?.itemSku}`,
    );
  }

  function applyEdit(id: string, patch: Partial<StockApproval>) {
    setApprovals((prev) =>
      prev.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    );
    const apr = approvals.find((a) => a.id === id);
    const mods: ApprovalModification[] | undefined = patch.modifications;
    const latest = mods?.[mods.length - 1];
    const isPostDecision = latest?.postDecision;
    onToast(
      isPostDecision
        ? `✏️ ${apr?.itemSku} edited after decision · audit logged (${latest?.note})`
        : `✏️ ${apr?.itemSku} updated · ${latest?.note ?? "changes saved"}`,
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Header */}
      <div className="border-b border-border bg-surface-light px-6 py-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-xs text-text-secondary">
              <span>Operations</span>
              <ChevronRight className="h-3 w-3" />
              <span>Inventory</span>
              <ChevronRight className="h-3 w-3" />
              <span className="font-medium text-text-primary">Stock-Out Approvals</span>
            </div>
            {/* tracking-tight dropped: Heading has no letter-spacing axis (heading.tsx
                header comment, "NOT COVERED, DELIBERATELY"). mt-1 kept, it's layout. */}
            <Heading className="mt-1">Stock-Out Approvals</Heading>
            <p className="mt-0.5 text-sm text-text-secondary">
              Field-tech scans queue here before stock leaves a van or warehouse.{" "}
              {canApprove ? (
                <span className="inline-flex items-center gap-1 font-medium text-success">
                  <ShieldCheck className="h-3 w-3" />
                  You can approve or reject as {reviewerName}
                  {user?.role ? ` (${user.role})` : ""}.
                </span>
              ) : (
                <span className="text-warning">
                  Your role can view but not approve.
                </span>
              )}
            </p>
          </div>
          <Button size="sm"
            onClick={() => setShowNewRequest(true)}
          >
            <Plus className="h-4 w-4" />
            New Request
          </Button>
        </div>

        {/* Stats — click to filter */}
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KpiTile
            label="Pending"
            value={counts.pending}
            tone="warning"
            icon={Clock}
            active={filter === "pending"}
            onClick={() => setFilter("pending")}
          />
          <KpiTile
            label="Approved Today"
            value={counts.approved}
            tone="success"
            icon={CheckCircle2}
            active={filter === "approved"}
            onClick={() => setFilter("approved")}
          />
          <KpiTile
            label="Rejected"
            value={counts.rejected}
            tone="danger"
            icon={XCircle}
            active={filter === "rejected"}
            onClick={() => setFilter("rejected")}
          />
          <KpiTile
            label="Total"
            value={counts.all}
            tone="strong"
            icon={ShieldCheck}
            active={filter === "all"}
            onClick={() => setFilter("all")}
          />
        </div>
      </div>

      {/* Filter chips */}
      <div className="flex items-center gap-2 overflow-x-auto border-b border-border bg-surface-light px-6 py-2.5">
        <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
          Filter
        </span>
        {filterTabs.map((t) => {
          const active = filter === t.value;
          return (
            // Raw by design: a segmented filter-tab control, not
            // Button-shaped.
            <button
              key={t.value}
              onClick={() => setFilter(t.value)}
              className={[
                "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium transition",
                active
                  ? "bg-primary text-on-fill"
                  : "bg-background-light text-text-primary hover:bg-border",
              ].join(" ")}
            >
              {t.label}
              <span
                className={[
                  "rounded-full px-1.5 text-[10px] font-semibold",
                  active ? "bg-on-fill/30 text-on-fill" : "bg-surface-light text-text-primary",
                ].join(" ")}
              >
                {counts[t.value]}
              </span>
            </button>
          );
        })}
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto bg-background-light px-6 py-4">
        <div className="space-y-2">
          {filtered.length === 0 && (
            <div className="rounded-card border border-dashed border-border bg-surface-light px-6 py-12 text-center text-sm text-text-secondary">
              No {filter === "all" ? "" : filter} approvals to show.
            </div>
          )}
          {filtered.map((a) => (
            <ApprovalCard
              key={a.id}
              approval={a}
              onOpenDetail={() => setOpenDetailId(a.id)}
            />
          ))}
        </div>
      </div>

      <ApprovalDetailDialog
        open={!!openDetail}
        approval={openDetail}
        onClose={() => setOpenDetailId(null)}
        canApprove={canApprove}
        onApprove={(id, comment) => decide(id, "approved", comment)}
        onReject={(id, comment) => decide(id, "rejected", comment)}
        onEdit={applyEdit}
        onEmailSent={(p) =>
          onToast(
            `📧 Approval request emailed to ${p.to.length} recipient${p.to.length === 1 ? "" : "s"} · ${p.to.join(", ")}`,
          )
        }
      />

      <NewApprovalRequestDialog
        open={showNewRequest}
        onClose={() => setShowNewRequest(false)}
        locations={locations}
        onSubmit={(req) => {
          const newApproval: StockApproval = {
            ...req,
            id: `apr_new_${Date.now()}`,
            status: "pending",
          };
          setApprovals((prev) => [newApproval, ...prev]);
          setFilter("pending");
          createApproval.mutate(newApproval);
          onToast(
            `📋 Approval request submitted · ${req.qty} × ${req.itemSku} · ${req.requestedByTechName}`,
          );
          return newApproval;
        }}
        onEmailSent={(p) =>
          onToast(
            `📧 Approval request emailed to ${p.to.length} recipient${p.to.length === 1 ? "" : "s"} · ${p.to.join(", ")}`,
          )
        }
      />
    </div>
  );
}

function ApprovalCard({
  approval,
  onOpenDetail,
}: {
  approval: StockApproval;
  onOpenDetail: () => void;
}) {
  return (
    // Raw by design: a whole-card click target, not Button-shaped.
    <button
      onClick={onOpenDetail}
      className="group flex w-full items-start gap-3 overflow-hidden rounded-card border border-border bg-surface-light px-4 py-3 text-left shadow-sm transition hover:border-primary/40 hover:shadow-md"
    >
      <div className="flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ring-1 ${approvalTypeTint(approval.type)}`}
          >
            {approvalTypeLabel(approval.type)}
          </span>
          <code className="rounded bg-background-light px-1.5 py-0.5 font-mono text-[11px] text-text-primary">
            {approval.itemSku}
          </code>
          <span className="text-sm font-medium text-text-primary">
            {approval.qty} {approval.uom}
          </span>
          <span className="text-sm text-text-secondary">·</span>
          <span className="truncate text-sm text-text-secondary">
            {approval.itemName}
          </span>
          <StatusBadge domain="approval" status={approval.status} className="ml-auto" />
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-secondary">
          <span className="flex items-center gap-1">
            <User className="h-3 w-3" />
            {approval.requestedByTechName}
          </span>
          <span className="flex items-center gap-1">
            <Truck className="h-3 w-3" />
            From {approval.fromLocationName}
          </span>
          {approval.toLocationName && (
            <span className="flex items-center gap-1">
              <MapPin className="h-3 w-3" />→ {approval.toLocationName}
            </span>
          )}
          {approval.jobNumber && (
            <span className="flex items-center gap-1">
              <span className="font-mono">{approval.jobNumber}</span>
              {approval.customer && <span>· {approval.customer}</span>}
            </span>
          )}
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {new Date(approval.requestedAt).toLocaleString('en-US', {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
          <span className="ml-auto text-[10px] font-medium text-primary opacity-0 transition group-hover:opacity-100">
            Open full transaction →
          </span>
        </div>
      </div>
    </button>
  );
}
