import { useEffect, useMemo, useState } from "react";
import { Mail, Paperclip, Send, X } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { FormField } from "@/components/patterns/FormField";
import { useTechs, useBranches, useInventoryItems } from "@/lib/api/inventory";
import type { StockApproval } from "@/lib/api/inventory";
import { useOrganization } from "@/lib/api/organization";
// `ApprovalActionType` + `approvalTypeLabel` are not re-exported by the seam
// (`lib/api/inventory.ts`) yet — see `concerns`. Type-only `_mock` import is
// allowed by the port rules when the seam lacks a needed type; the runtime
// label helper is reproduced locally below so we never import a value from
// `_mock`.
import type { ApprovalActionType } from "@/lib/api/_mock/inventory";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type Props = {
  open: boolean;
  onClose: () => void;
  approval: StockApproval | null;
  // Kept for API compatibility with the Emanuel caller (NewApprovalRequestDialog
  // passes zIndex={80}). The shadcn Dialog/Radix portal handles nested stacking
  // automatically, so this is accepted but not forwarded to the Modal adapter.
  zIndex?: number;
  lockEscape?: boolean;
  onSent: (payload: { to: string[]; subject: string; body: string }) => void;
};

// Local copy of the seam helper until it is re-exported (see `concerns`).
const APPROVAL_TYPE_LABELS: Record<ApprovalActionType, string> = {
  consume_on_job: "Consume on Job",
  transfer_to_van: "Transfer to Van",
  return_to_warehouse: "Return to Warehouse",
  writeoff: "Write-off",
};
function approvalTypeLabel(t: ApprovalActionType): string {
  return APPROVAL_TYPE_LABELS[t] ?? t;
}

// Deterministic mailbox derivation for the prototype (matches EmailComposeDialog).
const MOCK_MAILBOX_DOMAIN = "servwave.com";
function emailFor(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(".");
  return slug ? `${slug}@${MOCK_MAILBOX_DOMAIN}` : `team@${MOCK_MAILBOX_DOMAIN}`;
}

export function ApprovalEmailDialog({
  open,
  onClose,
  approval,
  lockEscape,
  onSent,
}: Props) {
  // Data via the seam (mock-backed today, /api/inventory/* in Track 2).
  const { data: allTechs = [] } = useTechs();
  const { data: branches = [] } = useBranches();
  const { data: allItems = [] } = useInventoryItems();
  const { data: org } = useOrganization();
  const brand = org?.name ?? "ServWave";

  const requester = useMemo(
    () =>
      approval?.requestedByTechId
        ? allTechs.find((t) => t.id === approval.requestedByTechId)
        : undefined,
    [approval?.requestedByTechId, allTechs],
  );

  const branch = useMemo(() => {
    const branchName = requester?.branch;
    if (!branchName) return branches[0];
    return (
      branches.find((b) =>
        b.name.toLowerCase().includes(branchName.toLowerCase().split(" ")[0]!),
      ) ?? branches[0]
    );
  }, [requester?.branch, branches]);

  const item = useMemo(
    () =>
      approval ? allItems.find((i) => i.sku === approval.itemSku) : undefined,
    [approval?.itemSku, allItems],
  );

  // Approver pool: warehouse leads / inventory admins at the branch + owner + manager.
  const recipientSuggestions = useMemo(() => {
    if (!approval) return [];
    const out: { label: string; email: string }[] = [];

    // Approval-pool roles: warehouse_lead, plus a generic Inventory Admin alias
    const approvers = allTechs.filter(
      (t) => t.role === "warehouse_lead" && t.branch === requester?.branch,
    );
    approvers.forEach((a) =>
      out.push({
        label: `${a.name} (Warehouse Lead · ${a.branch})`,
        email: emailFor(a.name),
      }),
    );

    if (branch?.managerName) {
      out.push({
        label: `${branch.managerName} (${branch.name} Manager)`,
        email: emailFor(branch.managerName),
      });
    }

    if (branch) {
      out.push({
        label: `Approvals · ${branch.name}`,
        email: `approvals@${MOCK_MAILBOX_DOMAIN}`,
      });
    }

    if (requester) {
      out.push({
        label: `${requester.name} (Requester · FYI)`,
        email: emailFor(requester.name),
      });
    } else if (approval.requestedByTechName) {
      out.push({
        label: `${approval.requestedByTechName} (Requester · FYI)`,
        email: emailFor(approval.requestedByTechName),
      });
    }

    return out;
  }, [approval, requester, branch, allTechs]);

  const [to, setTo] = useState<string[]>([]);
  const [cc, setCc] = useState<string[]>([]);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [toInput, setToInput] = useState("");
  const [ccInput, setCcInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Reset + pre-fill on open
  useEffect(() => {
    if (!open || !approval) return;
    const defaultTo = recipientSuggestions[0]?.email
      ? [recipientSuggestions[0].email]
      : [];
    setTo(defaultTo);
    setCc([]);
    setToInput("");
    setCcInput("");
    setSubject(
      `Stock-Out Approval Needed · ${approval.itemSku}${approval.jobNumber ? ` · Job ${approval.jobNumber}` : ""}`,
    );

    const value = item ? approval.qty * (item.unitCost ?? 0) : undefined;
    const lines = [
      `Hi team,`,
      ``,
      `Need your sign-off on a stock-out request from ${approval.requestedByTechName}.`,
      ``,
      `Request:`,
      `  • Type · ${approvalTypeLabel(approval.type)}`,
      `  • Item · ${approval.itemSku} — ${approval.itemName}`,
      `  • Quantity · ${approval.qty} ${approval.uom}${value !== undefined ? ` (≈ $${value.toFixed(2)} value)` : ""}`,
      `  • From · ${approval.fromLocationName}`,
      approval.toLocationName ? `  • To · ${approval.toLocationName}` : ``,
      approval.serialCaptured ? `  • Serial captured · ${approval.serialCaptured}` : ``,
      ``,
      approval.jobNumber || approval.customer
        ? `Job context:`
        : ``,
      approval.jobNumber ? `  • Job # · ${approval.jobNumber}` : ``,
      approval.customer ? `  • Customer · ${approval.customer}` : ``,
      ``,
      approval.reason
        ? `Tech's reason:\n  "${approval.reason}"`
        : ``,
      ``,
      `Open the request to approve or reject:`,
      `  ${window.location.origin}/approvals/${approval.id}`,
      ``,
      `— ${branch?.managerName ?? "Dispatch"} · ${brand} · ${branch?.name ?? ""}`,
    ]
      .filter((l) => l !== null && l !== undefined)
      .join("\n");
    setBody(lines);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, approval?.id, requester?.id, branch?.id, item?.id, org?.id]);

  if (!open || !approval) return null;

  function addRecipient(field: "to" | "cc", raw: string) {
    const value = raw.trim().replace(/[,;]+$/, "");
    if (!value) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      setError(`"${value}" isn't a valid email address.`);
      return;
    }
    setError(null);
    if (field === "to") {
      setTo((cur) => (cur.includes(value) ? cur : [...cur, value]));
      setToInput("");
    } else {
      setCc((cur) => (cur.includes(value) ? cur : [...cur, value]));
      setCcInput("");
    }
  }

  function removeRecipient(field: "to" | "cc", email: string) {
    if (field === "to") setTo((cur) => cur.filter((e) => e !== email));
    else setCc((cur) => cur.filter((e) => e !== email));
  }

  function send() {
    if (to.length === 0) {
      setError("Add at least one recipient in the To field.");
      return;
    }
    if (!subject.trim()) {
      setError("Subject is required.");
      return;
    }
    onSent({ to, subject: subject.trim(), body });
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Email Approval Request · ${approval.itemSku}`}
      subtitle="Notifies approvers with full context plus a direct link to approve or reject."
      size="lg"
      lockEscape={lockEscape}
      footer={
        <>
          <Button variant="outline" size="sm"
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button size="sm"
            onClick={send}
          >
            <Send className="h-4 w-4" />
            Send Email ({to.length} recipient{to.length === 1 ? "" : "s"})
          </Button>
        </>
      }
    >
      {error && (
        <div className="mb-3 rounded-md border border-danger/20 bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}

      <div className="flex flex-col gap-3">
        {/* Quick-add chips */}
        <div className="rounded-md border border-primary/30 bg-primary-subtle px-3 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-primary">
            Suggested recipients
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {recipientSuggestions.map((r) => {
              const already = to.includes(r.email) || cc.includes(r.email);
              return (
                // Raw by design: a segmented toggle/filter-chip control, not
                // Button-shaped.
                <button
                  key={r.email}
                  type="button"
                  onClick={() => {
                    if (!already) {
                      setTo((cur) =>
                        cur.includes(r.email) ? cur : [...cur, r.email],
                      );
                    }
                  }}
                  className={[
                    "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition",
                    already
                      ? "cursor-not-allowed border-success/20 bg-success/10 text-success"
                      : "border-border bg-surface-light text-text-secondary hover:border-primary hover:bg-primary-subtle",
                  ].join(" ")}
                  title={r.email}
                  disabled={already}
                >
                  <Mail className="h-2.5 w-2.5" />
                  {r.label}
                </button>
              );
            })}
          </div>
        </div>

        <FormField label="To" required>
          <RecipientField
            recipients={to}
            input={toInput}
            onInput={setToInput}
            onAdd={(v) => addRecipient("to", v)}
            onRemove={(e) => removeRecipient("to", e)}
          />
        </FormField>

        <FormField label="Cc">
          <RecipientField
            recipients={cc}
            input={ccInput}
            onInput={setCcInput}
            onAdd={(v) => addRecipient("cc", v)}
            onRemove={(e) => removeRecipient("cc", e)}
          />
        </FormField>

        <FormField label="Subject" required>
          <Input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="px-2.5 py-1.5"
          />
        </FormField>

        <FormField label="Message">
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={14}
            className="px-2.5 py-1.5"
          />
        </FormField>

        {/* Attachment chip */}
        <div className="flex items-center gap-2 rounded-md border border-border bg-background-light px-3 py-2 text-[11px] text-text-secondary">
          <Paperclip className="h-3.5 w-3.5 text-primary" />
          <span className="font-medium">Attachment:</span>
          <span className="font-mono">
            approval-request-{approval.id}.pdf
          </span>
          <span className="ml-auto text-[10px] text-text-secondary">
            Auto-generated from the live request
          </span>
        </div>
      </div>
    </Modal>
  );
}

function RecipientField({
  recipients,
  input,
  onInput,
  onAdd,
  onRemove,
  id,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
}: {
  recipients: string[];
  input: string;
  onInput: (v: string) => void;
  onAdd: (v: string) => void;
  onRemove: (email: string) => void;
  /** FormField's generated id - lands on the recipient text input, the
   *  labelable element in this compound chip-input. */
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-md border border-border px-1.5 py-1 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary-subtle">
      {recipients.map((email) => (
        <span
          key={email}
          className="inline-flex items-center gap-1 rounded-full bg-primary-subtle px-2 py-0.5 text-[11px] font-medium text-primary ring-1 ring-primary/20"
        >
          {email}
          {/* Raw by design: a close-X affordance inside a chip, not
              Button-shaped. */}
          <button
            type="button"
            onClick={() => onRemove(email)}
            className="rounded-full p-0.5 text-primary hover:bg-primary-subtle"
            aria-label={`Remove ${email}`}
          >
            <X className="h-2.5 w-2.5" />
          </button>
        </span>
      ))}
      <Input
        id={id}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        value={input}
        onChange={(e) => onInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "," || e.key === ";") {
            e.preventDefault();
            onAdd(input);
          } else if (e.key === "Backspace" && !input && recipients.length > 0) {
            onRemove(recipients[recipients.length - 1]!);
          }
        }}
        onBlur={() => {
          if (input.trim()) onAdd(input);
        }}
        placeholder="Type email + Enter…"
        className="flex-1 px-1 py-0.5"
      />
    </div>
  );
}
