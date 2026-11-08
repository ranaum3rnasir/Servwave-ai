// Phone module — Blocked callers view.
//
// Faithful cut from Emanuel's PhonePage monolith (BlockedCallersView L8158-8279
// + its BlockNumberModal L8280-8412). Behavior is verbatim; the changes made:
//   1. Tailwind tokens swapped indigo/slate -> ALPHA design tokens
//      (primary / text-primary / text-secondary / border / background-light).
//      The rose/amber status tints in the avatar + pills are kept verbatim, as
//      is the slate-900 brand chrome on the header/CTA which maps to `primary`.
//   2. The reason dropdown was the monolith's portaled `CleanSelect` helper —
//      a single-view symbol that is NOT in the shared kernel. Since this is a
//      trivial 4-option fixed list, it was swapped to the shadcn `Select`
//      primitive.
//   3. The label/tone maps + the BlockedNumber/BlockReason types come from the
//      `@/lib/api/communication` seam. This view stays presentational: `blocked`
//      is the server list from GET /api/communication/blocked, and
//      `onBlock`/`onUnblock` are the shell's wrappers over the seam mutations
//      (POST /blocked and POST /blocked/unblock).
//
// View-specific note: BlockNumberModal now composes the shared `ui/modal`
// primitive (overlays consolidation) instead of its former hand-rolled fixed
// overlay — chrome only, all business logic kept verbatim.
import { useState } from "react";
import { Ban, BellOff, Plus, RotateCcw } from "lucide-react";
import {
  BLOCK_REASON_LABELS,
  BLOCK_REASON_TONE,
  fmtPhone,
  normalizeNAPhone,
  type BlockedNumber,
  type BlockReason,
} from "@/lib/api/communication";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { dayLabel } from "@/components/communication/phone/shared";
import { useScheduleTimezone } from '@/lib/schedule-tz';

/* ─────────────────── Blocked callers ─────────────────── */

export function BlockedCallersView({
  blocked,
  onBlock,
  onUnblock,
}: {
  blocked: BlockedNumber[];
  onBlock: (input: {
    number: string;
    name?: string;
    reason: BlockReason;
    note?: string;
  }) => void;
  onUnblock: (id: string) => void;
}) {
  const [modalOpen, setModalOpen] = useState(false);
  const tz = useScheduleTimezone();

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-on-fill">
            <Ban className="h-5 w-5" />
          </span>
          <div>
            <h2 className="text-lg font-bold text-text-primary">Blocked callers</h2>
            <p className="mt-0.5 max-w-xl text-[13px] text-text-secondary">
              Numbers muted inside ServWave: their calls and texts are still
              recorded, but they raise no alerts and no unread badges. ServWave
              does not block at the carrier, so a blocked number can still reach
              a forwarded phone.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-[13px] font-semibold text-on-fill shadow-sm hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" /> Block a number
        </button>
      </div>

      {/* List */}
      <div className="mt-5 overflow-hidden rounded-xl border border-border bg-surface-light">
        <div className="flex items-center justify-between border-b border-border bg-background-light px-4 py-2.5">
          <p className="text-[12px] font-semibold text-text-secondary">
            {blocked.length} blocked {blocked.length === 1 ? "number" : "numbers"}
          </p>
          <span className="inline-flex items-center gap-1 text-[11px] text-text-secondary">
            <BellOff className="h-3.5 w-3.5" /> Alerts muted, calls still logged
          </span>
        </div>

        {blocked.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <Ban className="mx-auto h-7 w-7 text-text-secondary" />
            <p className="mt-2 text-[13px] font-medium text-text-secondary">
              No blocked numbers
            </p>
            <p className="text-[12px] text-text-secondary">
              Press “Block a number” to mute a caller's alerts.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {blocked.map((b) => (
              <li
                key={b.id}
                className="flex items-center gap-3 px-4 py-3 hover:bg-background-light"
              >
                <span className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-danger/10 text-danger">
                  <Ban className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {/* New rows persist as +1XXXXXXXXXX; pre-2026-08 rows still
                        hold display form, which fmtPhone passes through. */}
                    <span className="font-mono text-[13px] font-semibold text-text-primary">
                      {fmtPhone(b.number)}
                    </span>
                    {b.name && (
                      <span className="text-[12px] text-text-secondary">{b.name}</span>
                    )}
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ${BLOCK_REASON_TONE[b.reason]}`}
                    >
                      {BLOCK_REASON_LABELS[b.reason]}
                    </span>
                  </div>
                  {b.note && (
                    <p className="mt-0.5 truncate text-[12px] text-text-secondary">
                      {b.note}
                    </p>
                  )}
                  <p className="mt-0.5 text-[11px] text-text-secondary">
                    Blocked {dayLabel(b.blockedAt, tz)} · {b.blockedBy}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onUnblock(b.id)}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-light px-2.5 py-1.5 text-[12px] font-semibold text-text-secondary hover:bg-background-light"
                >
                  <RotateCcw className="h-3.5 w-3.5" /> Unblock
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {modalOpen && (
        <BlockNumberModal
          onClose={() => setModalOpen(false)}
          onConfirm={(input) => {
            onBlock(input);
            setModalOpen(false);
          }}
        />
      )}
    </div>
  );
}

/* Small centered popup to block a number with a reason + optional note. */
function BlockNumberModal({
  onClose,
  onConfirm,
}: {
  onClose: () => void;
  onConfirm: (input: {
    number: string;
    reason: BlockReason;
    note?: string;
  }) => void;
}) {
  const [number, setNumber] = useState("");
  const [reason, setReason] = useState<BlockReason>("spam");
  const [note, setNote] = useState("");

  // The exact rule the server enforces: normalizeNAPhone here is the byte-identical
  // client mirror of the backend normaliser blockNumberSchema refines on, so the
  // dialog can never offer to submit what POST /blocked would 400.
  const canBlock = normalizeNAPhone(number.trim()) !== null;

  function submit() {
    if (!canBlock) return;
    onConfirm({ number: number.trim(), reason, note: note.trim() || undefined });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={
        <span className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-on-fill">
            <Ban className="h-4 w-4" />
          </span>
          Block a number
        </span>
      }
      size="sm"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canBlock}>
            <Ban className="h-4 w-4" /> Block number
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {/* Number */}
        <div>
          <label className="mb-1 block text-[12px] font-semibold text-text-secondary">
            Phone number
          </label>
          <input
            autoFocus
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="(212) 555-0123"
            className="w-full rounded-md border border-border bg-surface-light px-3 py-2 font-mono text-[14px] focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-subtle"
          />
        </div>

        {/* Reason */}
        <div>
          <label className="mb-1 block text-[12px] font-semibold text-text-secondary">
            Reason
          </label>
          <Select value={reason} onValueChange={(v) => setReason(v as BlockReason)}>
            <SelectTrigger aria-label="Block reason" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="spam">{BLOCK_REASON_LABELS.spam}</SelectItem>
              <SelectItem value="not_spam">{BLOCK_REASON_LABELS.not_spam}</SelectItem>
              <SelectItem value="customer">{BLOCK_REASON_LABELS.customer}</SelectItem>
              <SelectItem value="other">{BLOCK_REASON_LABELS.other}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Note */}
        <div>
          <label className="mb-1 block text-[12px] font-semibold text-text-secondary">
            Description <span className="font-normal text-text-secondary">(optional)</span>
          </label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            maxLength={1000}
            placeholder="Why are you blocking this number?"
            className="w-full resize-none rounded-md border border-border bg-surface-light px-3 py-2 text-[13px] focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-subtle"
          />
        </div>
      </div>
    </Modal>
  );
}
