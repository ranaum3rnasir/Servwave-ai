/**
 * AssetActionDialog — one dialog for the five asset verbs (P4):
 * assign / transfer / return / retire / note. Submits through useAssetAction;
 * a server 409 (raced state change, e.g. ALREADY_ASSIGNED) surfaces its
 * `error` string as an inline message instead of a toast.
 */
import type React from "react";
import { useEffect, useState } from "react";
import { ArchiveX, ArrowRightLeft, StickyNote, Undo2, UserPlus } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Textarea } from "@/components/ui/textarea";
import { SelectField } from "@/components/form/SelectField";
import { useAssetAction, type Asset } from "@/lib/api/inventory";
import { useUsers } from "@/lib/api/users";
import { extractApiError } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export type AssetActionMode = "assign" | "transfer" | "return" | "retire" | "note";

const TITLES: Record<AssetActionMode, string> = {
  assign: "Assign Asset",
  transfer: "Transfer Asset",
  return: "Return Asset",
  retire: "Retire Asset",
  note: "Add Note",
};

type Props = {
  open: boolean;
  mode: AssetActionMode;
  asset: Asset | null;
  onClose: () => void;
  onDone: (msg: string) => void;
};

export function AssetActionDialog({ open, mode, asset, onClose, onDone }: Props) {
  const action = useAssetAction();
  const usersQuery = useUsers();
  const [userId, setUserId] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setUserId("");
    setNote("");
    setError(null);
  }, [open, mode, asset?.id]);

  if (!asset) {
    return (
      <Modal open={open} onClose={onClose} title={TITLES[mode]} size="md">
        <p className="text-sm text-text-secondary">No asset selected.</p>
      </Modal>
    );
  }

  const needsUser = mode === "assign" || mode === "transfer";
  const holderName = asset.assigned_user
    ? `${asset.assigned_user.first_name} ${asset.assigned_user.last_name}`
    : null;
  // Assign/transfer target only active users; transfer hides the current holder.
  const pickableUsers = (usersQuery.data ?? []).filter(
    (u) =>
      u.is_active && !(mode === "transfer" && u.id === asset.assigned_user?.id),
  );
  const pickedUser = pickableUsers.find((u) => u.id === userId) ?? null;

  async function submit() {
    if (!asset) return;
    if (needsUser && !userId) return setError("Pick a technician.");
    if (mode === "note" && !note.trim()) return setError("Note is required.");
    setError(null);
    try {
      await action.mutateAsync({
        id: asset.id,
        action: mode,
        ...(needsUser ? { user_id: userId } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
    } catch (err) {
      // 409 guards (ALREADY_ASSIGNED / NOT_ASSIGNED / ASSET_RETIRED / raced
      // STATE_CONFLICT) carry a human-readable `error` string — show inline.
      setError(extractApiError(err, "Could not complete the action — try again."));
      return;
    }
    const doneMsg =
      mode === "assign"
        ? `✓ "${asset.name}" assigned to ${pickedUser ? `${pickedUser.first_name} ${pickedUser.last_name}` : "technician"}`
        : mode === "transfer"
          ? `✓ "${asset.name}" transferred to ${pickedUser ? `${pickedUser.first_name} ${pickedUser.last_name}` : "technician"}`
          : mode === "return"
            ? `✓ "${asset.name}" returned${holderName ? ` from ${holderName}` : ""}`
            : mode === "retire"
              ? `✓ "${asset.name}" retired`
              : `✓ Note added to "${asset.name}"`;
    onDone(doneMsg);
    onClose();
  }

  const Icon =
    mode === "assign"
      ? UserPlus
      : mode === "transfer"
        ? ArrowRightLeft
        : mode === "return"
          ? Undo2
          : mode === "retire"
            ? ArchiveX
            : StickyNote;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={TITLES[mode]}
      subtitle={`${asset.name}${asset.serial ? ` · ${asset.serial}` : ""}`}
      size="md"
      footer={
        <>
          <Button variant="outline" size="sm"
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={action.isPending}
            tone={mode === "retire" ? "danger" : "brand"}
            size="sm"
          >
            <Icon className="h-3.5 w-3.5" />
            {action.isPending ? "Saving…" : TITLES[mode]}
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
        {mode === "return" && (
          <p className="text-sm text-text-secondary">
            Return{" "}
            <span className="font-medium text-text-primary">{asset.name}</span>
            {holderName ? (
              <>
                {" "}
                from{" "}
                <span className="font-medium text-text-primary">
                  {holderName}
                </span>
                ?
              </>
            ) : (
              "?"
            )}
          </p>
        )}

        {mode === "retire" && (
          <div className="rounded-md border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">
            Retiring removes this asset from the active list; its history is
            kept.
            {holderName && (
              <span className="mt-1 block">
                Currently held by{" "}
                <span className="font-semibold">{holderName}</span> — retiring
                also returns it.
              </span>
            )}
          </div>
        )}

        {mode === "transfer" && holderName && (
          <p className="text-sm text-text-secondary">
            Currently held by{" "}
            <span className="font-medium text-text-primary">{holderName}</span>.
          </p>
        )}

        {needsUser && (
          <Field label={mode === "assign" ? "Assign to" : "Transfer to"} required>
            <SelectField
              value={userId}
              onValueChange={setUserId}
              aria-label={mode === "assign" ? "Assign to" : "Transfer to"}
              placeholder="Select technician…"
              className={inputCls}
              options={pickableUsers.map((u) => ({
                value: u.id,
                label: `${u.first_name} ${u.last_name} — ${u.role}`,
              }))}
            />
          </Field>
        )}

        <Field label="Note" required={mode === "note"}>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={mode === "note" ? 3 : 2}
            placeholder={
              mode === "note" ? "Chuck is wobbly — needs service" : "Optional note"
            }
            className={inputCls}
            aria-label="Note"
          />
        </Field>
      </div>
    </Modal>
  );
}

// Input/Textarea now own their own border/radius/background/focus-ring
// appearance (design-system layering guard) - this constant is layout-only.
const inputCls = "w-full px-2.5 py-1.5";

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
