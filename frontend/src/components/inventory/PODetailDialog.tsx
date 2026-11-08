import type React from "react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  CheckCircle2,
  ChevronRight,
  Eye,
  FileText,
  PackageCheck,
  Pencil,
  Plus,
  RotateCcw,
  ShoppingCart,
  Trash2,
  Truck,
} from "lucide-react";
import { SelectField } from "@/components/form/SelectField";
import { FormField } from "@/components/patterns/FormField";
import { Modal } from "@/components/ui/modal";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { DatePicker } from "@/components/form/DatePicker";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/ui/empty-state";
import { toast } from "@/components/ui/use-toast";
import { extractApiError, formatCurrency } from "@/lib/utils";
import { formatExactDay } from "@/lib/format-date";
import { POPreviewDialog } from "@/components/inventory/POPreviewDialog";
import {
  INVENTORY_LOCATIONS_SETTINGS_PATH,
  NoInventoryLocationDialog,
} from "@/components/inventory/NoInventoryLocationDialog";
import {
  PO_STATUSES,
  useDeletePO,
  useInventoryItems,
  useInventoryJobs,
  useLocations,
  useMarkOrdered,
  useUpdatePO,
  usePOActivity,
  useVendors,
} from "@/lib/api/inventory";
import { useOrganization } from "@/lib/api/organization";
import { useAppAbility } from "@/contexts/AbilityContext";
import { lineHasCost, lineUnitCost, poTotal } from "@/lib/inventory/po-money";
import type {
  InventoryJob,
  Item,
  PurchaseOrder,
  POLine,
  POActivityEvent,
  POStatus,
  UpdatePOPayload,
} from "@/lib/api/inventory";
import { Button } from "@/components/ui/button";
import {
  STATUS_INTENT_CLASSES,
  STATUS_REGISTRY,
} from "@/design-system/status-registry";
import { useConfirm } from "@/hooks/useConfirm";

/**
 * PODetailDialog — v0.1 (PRD §7.X.3, rev 2026-05-28).
 *
 * Opens when a PO row is clicked anywhere on the Purchase Orders page. Shows
 * the full PO information in a 2-tab body (Lines · Activity) with a
 * status-adaptive footer action set.
 *
 * ServWave never sends a PO to a vendor (Purchasing Audit Verdict, PR 1): there
 * is no Send/Email action here. The lifecycle is the buyer's own (PR 2, S2.2):
 *   draft → "Mark as ordered" (dated, attributed by the server)
 *   ordered / partial → Receive
 *   received → Close PO · closed → Reopen · cancelled → nothing
 * A status select offers every status by hand; picking Received / Partial opens
 * the Receive dialog pre-filled with the remaining quantities (with a "Skip,
 * just set the status" escape), picking Cancelled asks first. Delete sits
 * behind a warning and, when the server refuses with PO_HAS_RECEIPTS, the same
 * dialog explains and offers Cancel PO instead. "Notes to the vendor" is edited
 * here and printed by the preview.
 *
 * Edit mode (PR 3, S3.3): the header — vendor (by id, writing vendorId AND the
 * name snapshot), expected date, job link, customer, site, trade, notes — is
 * editable on every status; the lines (qty, unit cost, remove, add from the
 * catalog or free text) only while the PO is a draft. Save sends ONE PATCH with
 * just the fields that changed (plus the full `lines` array on a draft); the
 * server's 409 PO_LINES_FROZEN is rendered verbatim and the form stays open.
 *
 * ALPHA port note: the Receive-mode commit calls the `onReceive` callback; the
 * parent Purchase Orders page persists it via `useReceivePO().mutate(payload)`
 * (lib/api/inventory.ts) and passes back the updated PO via the `po` prop.
 * Lifecycle writes are made HERE (useUpdatePO / useMarkOrdered / useDeletePO)
 * and reported up through `onUpdated` / `onDeleted` so the grid can fold the
 * server's PO in before the invalidated query refetches.
 */

type Tab = "lines" | "activity";

export type ReceiveSubmit = {
  poId: string;
  /** D14 — the receive destination, always sent by the dialog. */
  destinationLocationId: string;
  /** Identity by PO line id, not SKU (D2 — SKU may be blank/duplicate). */
  lines: { lineId: string; qtyReceived: number }[];
};

type Props = {
  open: boolean;
  onClose: () => void;
  po: PurchaseOrder | null;
  /** Called when the user saves a receive event from the Lines tab.
   *  Parent persists via lib/api/inventory.useReceivePO().mutate() and
   *  passes back the updated PO via the `po` prop so the dialog re-renders.
   */
  onReceive?: (event: ReceiveSubmit) => void;
  /** The server's PO after a lifecycle write made here (mark as ordered, a
   *  status move, notes). The parent swaps it into its grid and hands it back
   *  via `po`. */
  onUpdated?: (po: PurchaseOrder) => void;
  /** The PO was deleted on the server; the parent drops the row. */
  onDeleted?: (id: string) => void;
};

const fmtMoney = formatCurrency;

function fmtDate(iso?: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// expectedDate is a calendar day, not an instant, so it is read in UTC.
function fmtDay(iso?: string): string {
  if (!iso) return "—";
  return formatExactDay(iso, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Today as a YYYY-MM-DD day value, in the browser's own calendar day. */
function todayISODate(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A picked calendar day → the instant at local midnight, as the API's datetime. */
function dayToInstant(day: string): string {
  return new Date(`${day}T00:00:00`).toISOString();
}

// Every status the picker offers, labelled off the registry so the dialog and
// the grid chips cannot disagree on a word.
const STATUS_OPTIONS = PO_STATUSES.map((value) => ({
  value,
  label: STATUS_REGISTRY.purchaseOrder[value]?.label ?? value,
}));

type DeleteState = null | "confirm" | { blocked: string };

// ─── Edit mode (S3.3) ───
const TRADES = ["locksmith", "door", "security", "hvac", "plumbing", "multi"] as const;
type Trade = (typeof TRADES)[number];
// Radix Select refuses an empty-string item value, so "nothing picked" and "the
// PO's legacy name-only vendor" each get a sentinel that never reaches the wire.
const NO_PICK = "__none__";
const LEGACY_VENDOR = "__legacy_vendor__";

type HeaderDraft = {
  vendorId: string;
  /** YYYY-MM-DD day for the DatePicker, '' when unset. */
  expectedDate: string;
  jobId: string;
  customer: string;
  site: string;
  trade: Trade | "";
};

type EditLine = {
  key: string;
  itemSku: string;
  itemName: string;
  uom: string;
  /** Kept as typed so a half-entered "1." survives a re-render. */
  qtyOrdered: string;
  qtyReceived: number;
  /** '' = no cost (travels as no `unitCost`, which the server stores as null). */
  unitCost: string;
  priceBookItemId?: string;
};

function seedHeader(po: PurchaseOrder): HeaderDraft {
  return {
    vendorId: po.vendorId ?? (po.vendor ? LEGACY_VENDOR : NO_PICK),
    expectedDate: po.expectedDate ? po.expectedDate.slice(0, 10) : "",
    jobId: po.jobId ?? NO_PICK,
    customer: po.customer ?? "",
    site: po.site ?? "",
    trade: po.trade ?? "",
  };
}

function seedLines(po: PurchaseOrder): EditLine[] {
  return po.lines.map((l, i) => ({
    key: l.id ?? `seed_${i}`,
    itemSku: l.itemSku,
    itemName: l.itemName,
    uom: l.uom,
    qtyOrdered: String(l.qtyOrdered),
    qtyReceived: l.qtyReceived,
    unitCost: l.unitCost != null ? String(l.unitCost) : "",
    priceBookItemId: l.priceBookItemId,
  }));
}

let editLineSeq = 0;
function newLineKey(): string {
  editLineSeq += 1;
  return `new_${editLineSeq}`;
}

export function PODetailDialog({ open, onClose, po, onReceive, onUpdated, onDeleted }: Props) {
  const { confirm, confirmDialog } = useConfirm();
  const ability = useAppAbility();
  const canUpdatePO = ability.can("update", "PurchaseOrder");
  const canDeletePO = ability.can("delete", "PurchaseOrder");
  const [tab, setTab] = useState<Tab>("lines");
  const [showPreview, setShowPreview] = useState(false);

  // ─── Receive destination (D14) ───
  // Same pattern as SyncStockDialog (incl. the 403-fallback single-option
  // branch). Re-seeded on enterReceive() to the ORG default — deliberately NOT
  // stockLocationMemory (that helper remembers deduction sources; the
  // receiving-dock default is the org's: "DEC3 becomes the default, not the rule").
  const locationsQuery = useLocations();
  const { data: org } = useOrganization();
  const updatePO = useUpdatePO();
  const markOrdered = useMarkOrdered();
  const deletePO = useDeletePO();
  const [receiveDestId, setReceiveDestId] = useState("");

  // ─── Receive mode (Lines tab) ───
  // When receiving: rows show editable Received inputs + Receive +1/All
  // per-row, footer swaps to Cancel · Save Receipt. Draft state is held
  // in `receiveDraft` keyed by SKU; commit on Save calls onReceive().
  const [receiving, setReceiving] = useState(false);
  const [receiveDraft, setReceiveDraft] = useState<Record<string, number>>({});
  // Set when receive mode was opened BY THE STATUS PICKER (Received / Partial):
  // the footer then also offers "Skip, just set the status".
  const [pendingStatus, setPendingStatus] = useState<POStatus | null>(null);
  // S4.3: the "No inventory location" dialog pops when receive mode opens with
  // nothing to receive into. Closing it keeps receive mode (Skip is still a
  // valid way out) - this flag is what "closed" means until the next enterReceive.
  const [noLocationDismissed, setNoLocationDismissed] = useState(false);

  // ─── Lifecycle dialogs ───
  const [markOrderedOpen, setMarkOrderedOpen] = useState(false);
  const [orderedOn, setOrderedOn] = useState(todayISODate);
  const [deleteState, setDeleteState] = useState<DeleteState>(null);

  // ─── Notes to the vendor ───
  // Edited here, printed by the preview. Saved on blur, only when changed —
  // except in edit mode, where the notes ride the one Save PATCH instead.
  const [notesDraft, setNotesDraft] = useState("");

  // ─── Edit mode (S3.3) ───
  // Exclusive with receive mode. The header draft is diffed against the PO on
  // Save so only changed fields go over the wire; the lines draft is sent whole
  // (the server replaces lines), and only while the PO is a draft.
  const [editing, setEditing] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [header, setHeader] = useState<HeaderDraft | null>(null);
  const [lineDraft, setLineDraft] = useState<EditLine[]>([]);
  const [linesDirty, setLinesDirty] = useState(false);
  const vendorsQuery = useVendors();
  const itemsQuery = useInventoryItems();
  const jobsQuery = useInventoryJobs();

  // Re-seed the draft from the current PO whenever the dialog opens or the PO
  // prop swaps — keyed on OBJECT identity: the parent passes back the server's
  // updated PO after a successful receive (a new object), which both re-seeds
  // the draft and exits receive mode. A failed receive changes nothing, so the
  // dialog stays in receive mode with the draft intact (§5b).
  useEffect(() => {
    if (!po) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the receive draft mirrors the server-owned `po` prop; it is re-seeded when the parent hands back a new object
    setReceiving(false);
    setPendingStatus(null);
    setReceiveDraft(
      Object.fromEntries(po.lines.map((l) => [l.id!, l.qtyReceived])),
    );
    setNotesDraft(po.notes ?? "");
    setEditing(false);
    setEditError(null);
  }, [po, open]);

  if (!po) return null;

  const totalOrd = po.lines.reduce((s, l) => s + l.qtyOrdered, 0);
  const totalRec = po.lines.reduce((s, l) => s + l.qtyReceived, 0);
  // One money rule (S3.2): line cost, then the linked catalog item's cost, then
  // $0 — the same helper the grid, CSV, preview and vendor spend use. A line
  // with no price from either source counts $0 here and renders "—" (LineRow).
  const subtotal = poTotal(po);
  const total = subtotal; // D6: PO is tax-exclusive (subtotal-only), consistent with reports + email
  const pctReceived = totalOrd === 0 ? 0 : Math.round((totalRec / totalOrd) * 100);

  // Status chip resolves through the shared status registry, so the PO lifecycle
  // spells its meaning (label + intent) in exactly one place. The `??` fallback is
  // unreachable today - POStatus is 6/6 covered by STATUS_REGISTRY.purchaseOrder -
  // and exists only because tsconfig sets noUncheckedIndexedAccess.
  const statusEntry = STATUS_REGISTRY.purchaseOrder[po.status] ?? {
    label: po.status,
    intent: "neutral" as const,
  };
  const def = {
    label: statusEntry.label,
    // STATUS_INTENT_CLASSES ships a border colour token next to the
    // surface and text roles. It is INERT on this chip, deliberately: the chip
    // rendered below in the header summary card carries no `border` width class,
    // and Tailwind preflight zeroes every border to no width, so the colour never paints.
    // This chip has never had a hairline. DO NOT "fix" the inertness by adding a
    // `border` class - that would grow all six PO status chips by ~2px on each
    // axis and is a fresh, undecided appearance change on a surface that never
    // had a hairline to begin with.
    cls: STATUS_INTENT_CLASSES[statusEntry.intent],
  };

  // §3.6 single-receive-path: a staged PO receives via the Staging view ONLY.
  const staged = po.stagedAsJobStageId != null;

  // 403-fallback: without read Inventory the locations query errors — offer the
  // org default as the single option (SyncStockDialog's exact branch).
  const locations = locationsQuery.data ?? [];
  const fallbackDefaultId = org?.default_inventory_location_id ?? null;
  const usingFallback = locationsQuery.isError && locations.length === 0;
  const destOptions = usingFallback
    ? fallbackDefaultId
      ? [{ id: fallbackDefaultId, label: "Org default location" }]
      : []
    : locations.map((loc) => ({
        id: loc.id,
        label: `${loc.name}${loc.branch ? ` · ${loc.branch}` : ""}`,
      }));
  // Settled with nowhere to receive into: no location rows (or, on the 403
  // fallback, no org default). While the query is still loading it is not
  // "none" yet - the dialog would flash on every open otherwise.
  const noLocation = !locationsQuery.isLoading && destOptions.length === 0;

  // Belt-and-braces over-receive guard (stale props can outrun the input clamp);
  // the server's 400 OVER_RECEIVE stays the authority.
  const overReceived = po.lines.filter(
    (l) => (receiveDraft[l.id!] ?? l.qtyReceived) > l.qtyOrdered,
  );

  // Enter receive mode: jump to Lines tab + flip receiving on. Unreachable for
  // staged POs (their primary action is disabled — defense in depth here).
  // `prefillRemaining` (the status picker's path) seeds every line at its
  // ordered quantity, i.e. "receive everything still outstanding".
  function enterReceive(prefillRemaining = false) {
    if (po!.stagedAsJobStageId != null) return;
    setTab("lines");
    setReceiving(true);
    setNoLocationDismissed(false);
    setReceiveDestId(org?.default_inventory_location_id ?? "");
    setReceiveDraft(
      Object.fromEntries(
        po!.lines.map((l) => [l.id!, prefillRemaining ? l.qtyOrdered : l.qtyReceived]),
      ),
    );
  }

  function exitReceive() {
    setReceiving(false);
    setPendingStatus(null);
    setReceiveDraft(Object.fromEntries(po!.lines.map((l) => [l.id!, l.qtyReceived])));
  }

  function reportError(err: unknown, fallback: string) {
    toast({ title: extractApiError(err, fallback), variant: "destructive" });
  }

  // One PATCH for every hand-picked status. The server stamps / clears
  // receivedAt as a side effect and writes the from/to audit row.
  function applyStatus(next: POStatus, after?: () => void) {
    updatePO.mutate(
      { id: po!.id, status: next },
      {
        onSuccess: (r) => {
          onUpdated?.(r.purchaseOrder);
          after?.();
        },
        onError: (err) => reportError(err, "Could not change the PO status"),
      },
    );
  }

  function openMarkOrdered() {
    setOrderedOn(todayISODate());
    setMarkOrderedOpen(true);
  }

  function submitMarkOrdered() {
    markOrdered.mutate(
      { id: po!.id, ...(orderedOn ? { orderedAt: dayToInstant(orderedOn) } : {}) },
      {
        onSuccess: (r) => {
          setMarkOrderedOpen(false);
          onUpdated?.(r.purchaseOrder);
        },
        onError: (err) => reportError(err, "Could not mark the PO as ordered"),
      },
    );
  }

  async function handleStatusPick(value: string) {
    const next = value as POStatus;
    if (next === po!.status) return;

    if (next === "received" || next === "partial") {
      // A staged PO has one receive path (Staging); here the status just moves.
      if (staged) { applyStatus(next); return; }
      setPendingStatus(next);
      enterReceive(true);
      return;
    }

    if (next === "cancelled") {
      const ok = await confirm({
        title: `Cancel ${po!.poNumber}?`,
        description:
          "The PO leaves the Open list and moves to History as Cancelled. Nothing is deleted and no stock moves.",
        confirmLabel: "Cancel PO",
        cancelLabel: "Keep PO",
        tone: "danger",
      });
      if (!ok) return;
      applyStatus("cancelled");
      return;
    }

    // "Ordered" on a PO that was never marked goes through Mark as ordered, so
    // the date and the buyer are recorded; re-entering ordered from a later
    // status is a plain move (the original order date stands).
    if (next === "ordered" && !po!.orderedAt) { openMarkOrdered(); return; }

    applyStatus(next);
  }

  function saveNotes() {
    if (editing) return; // the notes ride the Save PATCH in edit mode
    const next = notesDraft.trim();
    if (next === (po!.notes ?? "").trim()) return;
    updatePO.mutate(
      { id: po!.id, notes: next || null },
      {
        onSuccess: (r) => onUpdated?.(r.purchaseOrder),
        onError: (err) => reportError(err, "Could not save the notes"),
      },
    );
  }

  // ─── Edit mode (S3.3) ───
  function enterEdit() {
    if (receiving) return;
    setHeader(seedHeader(po!));
    setLineDraft(seedLines(po!));
    setLinesDirty(false);
    setEditError(null);
    setEditing(true);
  }

  function exitEdit() {
    setEditing(false);
    setEditError(null);
    setHeader(null);
    setLineDraft([]);
    setLinesDirty(false);
    setNotesDraft(po!.notes ?? "");
  }

  function patchHeader(patch: Partial<HeaderDraft>) {
    setHeader((h) => (h ? { ...h, ...patch } : h));
  }

  // Picking a job fills the display fields from it (the same behaviour as Create
  // PO); "No job" only unlinks — the typed customer / site stay as they are.
  function pickJob(jobId: string) {
    if (jobId === NO_PICK) { patchHeader({ jobId: NO_PICK }); return; }
    const job = (jobsQuery.data ?? []).find((j) => j.id === jobId);
    patchHeader({
      jobId,
      ...(job ? { customer: job.customer, site: job.site, trade: job.trade } : {}),
    });
  }

  function updateLine(key: string, patch: Partial<EditLine>) {
    setLineDraft((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
    setLinesDirty(true);
  }

  function removeLine(key: string) {
    setLineDraft((ls) => ls.filter((l) => l.key !== key));
    setLinesDirty(true);
  }

  function addCatalogLine(itemId: string) {
    const item = (itemsQuery.data ?? []).find((i) => i.id === itemId);
    if (!item) return;
    setLineDraft((ls) => [
      ...ls,
      {
        key: newLineKey(),
        itemSku: item.sku,
        itemName: item.name,
        uom: item.uom,
        qtyOrdered: "1",
        qtyReceived: 0,
        unitCost: item.unitCost != null ? String(item.unitCost) : "",
        priceBookItemId: item.id,
      },
    ]);
    setLinesDirty(true);
  }

  function addFreeTextLine() {
    setLineDraft((ls) => [
      ...ls,
      { key: newLineKey(), itemSku: "", itemName: "", uom: "EA", qtyOrdered: "1", qtyReceived: 0, unitCost: "" },
    ]);
    setLinesDirty(true);
  }

  /** The lines draft as the API's POLine[]; a string on failure. */
  function buildLines(): POLine[] | string {
    if (lineDraft.length === 0) return "A PO needs at least one line.";
    const out: POLine[] = [];
    for (const l of lineDraft) {
      const name = l.itemName.trim();
      if (!name) return "Every line needs a description.";
      const uom = l.uom.trim();
      if (!uom) return `Line "${name}" needs a unit of measure.`;
      const qty = Number(l.qtyOrdered);
      if (!Number.isFinite(qty) || qty <= 0) return `Quantity for "${name}" must be greater than 0.`;
      const line: POLine = {
        itemSku: l.itemSku,
        itemName: name,
        uom,
        qtyOrdered: qty,
        qtyReceived: l.qtyReceived,
      };
      if (l.unitCost.trim() !== "") {
        const cost = Number(l.unitCost);
        if (!Number.isFinite(cost) || cost < 0) return `Unit cost for "${name}" must be 0 or more.`;
        line.unitCost = cost;
      }
      if (l.priceBookItemId) line.priceBookItemId = l.priceBookItemId;
      out.push(line);
    }
    return out;
  }

  function saveEdit() {
    if (!header) return;
    const cur = po!;
    const patch: Omit<UpdatePOPayload, "id"> = {};

    if (header.vendorId !== NO_PICK && header.vendorId !== LEGACY_VENDOR && header.vendorId !== (cur.vendorId ?? "")) {
      const row = (vendorsQuery.data ?? []).find((v) => v.id === header.vendorId);
      patch.vendorId = header.vendorId;
      // Both the FK and the name snapshot, so the grid and the document agree at once.
      if (row) patch.vendor = row.name;
    }
    if (header.expectedDate !== (cur.expectedDate ? cur.expectedDate.slice(0, 10) : "")) {
      // A calendar day, read back in UTC by the grid (fmtDay) — sent as UTC midnight.
      patch.expectedDate = header.expectedDate ? new Date(header.expectedDate).toISOString() : null;
    }
    const jobId = header.jobId === NO_PICK ? "" : header.jobId;
    if (jobId !== (cur.jobId ?? "")) patch.jobId = jobId || null;
    if (header.customer.trim() !== (cur.customer ?? "")) patch.customer = header.customer.trim() || null;
    if (header.site.trim() !== (cur.site ?? "")) patch.site = header.site.trim() || null;
    if (header.trade !== (cur.trade ?? "")) patch.trade = header.trade || null;
    const notes = notesDraft.trim();
    if (notes !== (cur.notes ?? "").trim()) patch.notes = notes || null;

    if (cur.status === "draft" && linesDirty) {
      const built = buildLines();
      if (typeof built === "string") { setEditError(built); return; }
      patch.lines = built;
    }

    if (Object.keys(patch).length === 0) { exitEdit(); return; }

    setEditError(null);
    updatePO.mutate(
      { id: cur.id, ...patch },
      {
        onSuccess: (r) => {
          exitEdit();
          onUpdated?.(r.purchaseOrder);
        },
        onError: (err) => {
          const data = (err as { response?: { data?: { error?: string; message?: string } } })
            ?.response?.data;
          if (data?.error === "PO_LINES_FROZEN") {
            setEditError(data.message ?? "Lines can only be edited while the PO is in Draft");
            return;
          }
          setEditError(extractApiError(err, "Could not save the PO"));
        },
      },
    );
  }

  function submitDelete() {
    deletePO.mutate(po!.id, {
      onSuccess: () => {
        setDeleteState(null);
        onDeleted?.(po!.id);
        onClose();
      },
      onError: (err) => {
        const data = (err as { response?: { data?: { error?: string; message?: string } } })
          ?.response?.data;
        if (data?.error === "PO_HAS_RECEIPTS") {
          setDeleteState({
            blocked:
              data.message ??
              "Stock has been received against this PO. Correct the receipt to zero first, or cancel the PO instead.",
          });
          return;
        }
        setDeleteState(null);
        reportError(err, "Could not delete the PO");
      },
    });
  }

  // D3: close a received PO (nothing open) or force-close a partial (confirm first).
  async function handleClose() {
    const openCount = po!.lines.filter((l) => l.qtyReceived < l.qtyOrdered).length;
    if (
      openCount > 0 &&
      !(await confirm({
        title: `${openCount} item(s) still open - close this PO anyway?`,
        confirmLabel: "Close anyway",
        tone: "danger",
      }))
    )
      return;
    updatePO.mutate({ id: po!.id, status: "closed" }, { onSuccess: () => onClose() });
  }

  // Status-adaptive primary action (PRD §7.X.3 footer matrix, PR 2 lifecycle)
  const primaryAction = ((): {
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    onClick?: () => void;
    disabled?: boolean;
  } | null => {
    switch (po.status) {
      case "draft":
        // Nothing is sent from here: the buyer places the order their own way
        // and records that it happened.
        return { label: "Mark as ordered", icon: ShoppingCart, onClick: openMarkOrdered };
      case "ordered":
        return staged
          ? { label: "Received via Staging", icon: PackageCheck, disabled: true }
          : { label: "Receive items", icon: PackageCheck, onClick: () => enterReceive() };
      case "partial":
        return staged
          ? { label: "Received via Staging", icon: PackageCheck, disabled: true }
          : { label: "Receive remaining", icon: PackageCheck, onClick: () => enterReceive() };
      case "received":
        return { label: "Close PO", icon: CheckCircle2, onClick: handleClose };
      case "closed":
        // Book-keeping is the buyer's: a closed PO reopens to received.
        return { label: "Reopen", icon: RotateCcw, onClick: () => applyStatus("received") };
      case "cancelled":
        return null;
    }
  })();

  const busy = updatePO.isPending || markOrdered.isPending || deletePO.isPending;

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        size="xl"
        title={`${po.poNumber} · ${po.vendor}`}
        subtitle={
          po.customer
            ? `${po.jobNumber ? po.jobNumber + " · " : ""}${po.customer}${po.site ? " · " + po.site : ""}`
            : "No job link"
        }
        footer={
          editing ? (
            // ─── Edit mode footer ───
            <div className="flex w-full items-center justify-between gap-2">
              <div className="text-[11px] text-text-secondary">
                <span className="font-semibold text-primary">Editing</span>
                {po.status === "draft"
                  ? " · header and lines"
                  : " · header only — lines are frozen once a PO leaves Draft"}
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={exitEdit} disabled={updatePO.isPending}>
                  Cancel
                </Button>
                <Button size="sm" onClick={saveEdit} disabled={updatePO.isPending}>
                  Save changes
                </Button>
              </div>
            </div>
          ) : receiving ? (
            // ─── Receive mode footer ───
            <div className="flex w-full items-center justify-between gap-2">
              <div className="text-[11px] text-text-secondary">
                <span className="font-semibold text-success">Receive mode</span>{" "}
                · adjust qty per line · stock auto-updates on save
                {overReceived[0] != null && (
                  <span className="ml-2 font-semibold text-danger">
                    Received can&apos;t exceed ordered (line {overReceived[0].itemSku || overReceived[0].itemName}:{" "}
                    {receiveDraft[overReceived[0].id!]}/{overReceived[0].qtyOrdered})
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={exitReceive}>
                  Cancel
                </Button>
                {pendingStatus && (
                  // The status picker opened this receive: the buyer may set the
                  // status without touching stock (a paper receipt, a correction).
                  <Button variant="outline" size="sm"
                    disabled={busy}
                    onClick={() => {
                      const next = pendingStatus;
                      exitReceive();
                      applyStatus(next);
                    }}
                  >
                    Skip, just set the status
                  </Button>
                )}
                {/* --success and --sage-700 share the same RGB (tokens.css) so
                    solid/business reproduces this CTA's background exactly. */}
                <Button variant="solid" tone="business" size="sm"
                  disabled={!receiveDestId || overReceived.length > 0}
                  onClick={() => {
                    const lines = po.lines.map((l) => ({
                      lineId: l.id!,
                      qtyReceived: receiveDraft[l.id!] ?? l.qtyReceived,
                    }));
                    // Receive mode exits only when the parent hands back the
                    // server's updated PO (the re-seed effect below) — a failed
                    // save (400 OVER_RECEIVE / 409) leaves the dialog in
                    // receive mode with the draft intact (§5b/§5d).
                    onReceive?.({ poId: po.id, destinationLocationId: receiveDestId, lines });
                  }}
                >
                  <PackageCheck className="h-3.5 w-3.5" />
                  Save Receipt
                </Button>
              </div>
            </div>
          ) : (
            // ─── Normal footer ───
            <div className="flex w-full items-center justify-between">
              <div className="flex items-center gap-3 text-[11px] text-text-secondary">
                {/* Danger, and away from the primary action: the server decides
                    whether a delete is allowed (409 PO_HAS_RECEIPTS otherwise). */}
                {canDeletePO && (
                  <Button variant="outline" tone="danger" size="sm"
                    disabled={busy}
                    onClick={() => setDeleteState("confirm")}
                    className="inline-flex items-center gap-1.5"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete
                  </Button>
                )}
                {po.status === "partial" && (
                  <span>
                    Received {totalRec} of {totalOrd} units ·{" "}
                    <span className="font-semibold text-warning">{pctReceived}% complete</span>
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm"
                  onClick={onClose}
                >
                  Close
                </Button>
                {canUpdatePO && (
                  <Button variant="outline" size="sm"
                    onClick={enterEdit}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    Edit
                  </Button>
                )}
                <Button variant="outline" size="sm"
                  onClick={() => setShowPreview(true)}
                  className="inline-flex items-center gap-1.5"
                >
                  <Eye className="h-3.5 w-3.5" />
                  Preview / Print
                </Button>
                {canUpdatePO && po.status === "partial" && (
                  <Button variant="outline" size="sm"
                    onClick={handleClose}
                    disabled={updatePO.isPending}
                    className="inline-flex items-center gap-1.5 disabled:opacity-60"
                  >
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Close PO
                  </Button>
                )}
                {canUpdatePO && primaryAction &&
                  (primaryAction.disabled ? (
                    // Staged PO (§3.6 / QA-611): the single receive path is the
                    // Staging view — direct receive stays disabled with a pointer.
                    <span className="inline-flex items-center gap-2">
                      {/* solid/neutral is the only minted solid+neutral cell;
                          idle shade (bg-border-soft vs raw's bg-border, text
                          -primary vs raw's text-secondary) is the closest
                          available match, dimmed further by Button's own
                          disabled:opacity-50. */}
                      <Button variant="solid" tone="neutral" size="sm"
                        disabled
                        title="This PO is staged to a job — receive it from the Staging view"
                      >
                        <primaryAction.icon className="h-3.5 w-3.5" />
                        {primaryAction.label}
                      </Button>
                      <Link
                        to="/inventory/staging"
                        className="text-xs font-semibold text-primary hover:underline"
                      >
                        Open Staging →
                      </Link>
                    </span>
                  ) : (
                    <Button size="sm"
                      disabled={busy}
                      onClick={primaryAction.onClick}
                    >
                      <primaryAction.icon className="h-3.5 w-3.5" />
                      {primaryAction.label}
                    </Button>
                  ))}
              </div>
            </div>
          )
        }
      >
        {/* ─── Header summary card ─── */}
        <div className="-mx-5 -mt-4 border-b border-border bg-background-light px-5 py-3">
          <div className="flex flex-wrap items-center gap-3">
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${def.cls}`}
            >
              {def.label}
            </span>
            {/* Free movement between every status, by hand (PR 2). When the
                requester lacks update PurchaseOrder, only the status chip
                above renders - the status stays readable, nothing is hidden. */}
            {canUpdatePO && (
              <SelectField
                value={po.status}
                onValueChange={(v) => { void handleStatusPick(v); }}
                options={STATUS_OPTIONS}
                aria-label="Status"
                size="xs"
                disabled={busy || receiving || editing}
                className="h-7 w-[150px]"
              />
            )}
            {!editing && (
              <div className="flex items-center gap-1.5 text-xs text-text-secondary">
                <Truck className="h-3.5 w-3.5 text-text-secondary" />
                {po.vendor}
              </div>
            )}
            {!editing && po.trade && (
              <span className="rounded-full bg-surface-light px-2 py-0.5 text-[11px] font-medium text-text-secondary ring-1 ring-border">
                {po.trade}
              </span>
            )}
            <div className="ml-auto flex items-center gap-4 text-[11px] text-text-secondary">
              <div>
                <span className="text-text-secondary">Ordered</span>{" "}
                <span className="font-semibold text-text-primary">
                  {fmtDate(po.orderedAt)}
                </span>
                {po.orderedBy && (
                  <span className="text-text-secondary"> by {po.orderedBy.name}</span>
                )}
              </div>
              {!editing && (
                <>
                  <ChevronRight className="h-3 w-3 text-secondary" />
                  <div>
                    <span className="text-text-secondary">Expected</span>{" "}
                    <span className="font-semibold text-text-primary">
                      {fmtDay(po.expectedDate)}
                    </span>
                  </div>
                </>
              )}
              {po.receivedAt && (
                <>
                  <ChevronRight className="h-3 w-3 text-secondary" />
                  <div>
                    <span className="text-text-secondary">Received</span>{" "}
                    <span className="font-semibold text-text-primary">
                      {fmtDate(po.receivedAt)}
                    </span>
                  </div>
                </>
              )}
            </div>
          </div>
          {editing && header && (
            <EditHeaderForm
              header={header}
              po={po}
              vendors={vendorsQuery.data ?? []}
              jobs={jobsQuery.data ?? []}
              onChange={patchHeader}
              onPickJob={pickJob}
            />
          )}
          {editError && (
            <div role="alert" className="mt-3 rounded-md border border-danger/20 bg-danger/10 px-3 py-2 text-xs text-danger">
              {editError}
            </div>
          )}
          <div className="mt-3">
            {canUpdatePO ? (
              <FormField
                label="Notes to the vendor"
                hint={editing ? "Printed on the PO document. Saved with your changes." : "Printed on the PO document. Saved when you leave the field."}
              >
                <Textarea
                  size="sm"
                  value={notesDraft}
                  onChange={(e) => setNotesDraft(e.target.value)}
                  onBlur={saveNotes}
                  placeholder="Delivery instructions, account references, anything the vendor should read…"
                  maxLength={5000}
                />
              </FormField>
            ) : (
              <FormField label="Notes to the vendor">
                <p className="text-sm italic text-text-secondary">
                  {notesDraft.trim() || "No notes to the vendor."}
                </p>
              </FormField>
            )}
          </div>
        </div>

        {/* ─── Inner tab strip ─── */}
        <div className="-mx-5 flex items-center gap-1 border-b border-border bg-surface-light px-5">
          <InnerTab
            active={tab === "lines"}
            onClick={() => setTab("lines")}
            label="Lines"
            count={po.lines.length}
            icon={FileText}
          />
          <InnerTab
            active={tab === "activity"}
            onClick={() => setTab("activity")}
            label="Activity"
            icon={Activity}
          />
        </div>

        {/* ─── Tab body ─── */}
        <div className="pt-4">
          {tab === "lines" && editing && po.status === "draft" && (
            <LinesEditor
              lines={lineDraft}
              items={itemsQuery.data ?? []}
              onUpdate={updateLine}
              onRemove={removeLine}
              onAddCatalog={addCatalogLine}
              onAddFreeText={addFreeTextLine}
            />
          )}
          {tab === "lines" && !(editing && po.status === "draft") && (
            <LinesTab
              po={po}
              subtotal={subtotal}
              total={total}
              receiving={receiving}
              receiveDraft={receiveDraft}
              receiveDestId={receiveDestId}
              onReceiveDestChange={setReceiveDestId}
              destOptions={destOptions}
              onDraftChange={(lineId, val) =>
                setReceiveDraft((prev) => ({ ...prev, [lineId]: val }))
              }
              onReceiveAll={() => {
                setReceiveDraft(
                  Object.fromEntries(po.lines.map((l) => [l.id!, l.qtyOrdered])),
                );
              }}
              onResetDraft={() => {
                setReceiveDraft(
                  Object.fromEntries(po.lines.map((l) => [l.id!, l.qtyReceived])),
                );
              }}
            />
          )}
          {tab === "activity" && <ActivityTab poId={po.id} />}
        </div>
      </Modal>

      <POPreviewDialog
        open={showPreview}
        onClose={() => setShowPreview(false)}
        po={po}
        lockEscape
      />

      {/* Mark as ordered: the date defaults to today and may be back-dated. */}
      {/* S4.3 (B12): the one answer for "there is nowhere to put the parts". */}
      <NoInventoryLocationDialog
        open={receiving && noLocation && !noLocationDismissed}
        onClose={() => setNoLocationDismissed(true)}
      />

      <ConfirmDialog
        open={markOrderedOpen}
        onOpenChange={(next) => { if (!next) setMarkOrderedOpen(false); }}
        title={`Mark ${po.poNumber} as ordered`}
        description="Record that you placed this order with the vendor. The date and your name go on the PO."
        icon={ShoppingCart}
        confirmLabel="Mark as ordered"
        onConfirm={submitMarkOrdered}
        isLoading={markOrdered.isPending}
      >
        <FormField label="Ordered on">
          <DatePicker value={orderedOn} onChange={setOrderedOn} max={todayISODate()} />
        </FormField>
      </ConfirmDialog>

      {/* Delete: a warning first; when the server refuses (stock received), the
          same dialog explains and offers Cancel PO instead. */}
      <ConfirmDialog
        open={deleteState !== null}
        onOpenChange={(next) => { if (!next) setDeleteState(null); }}
        icon={Trash2}
        tone="danger"
        title={
          deleteState !== null && typeof deleteState === "object"
            ? "This PO can't be deleted"
            : `Delete ${po.poNumber}?`
        }
        description={
          deleteState !== null && typeof deleteState === "object"
            ? deleteState.blocked
            : "This removes the PO and its lines for good. It cannot be undone."
        }
        confirmLabel={
          deleteState !== null && typeof deleteState === "object"
            ? (canUpdatePO ? "Cancel PO instead" : "Close")
            : "Delete PO"
        }
        cancelLabel={deleteState !== null && typeof deleteState === "object" ? "Keep PO" : "Keep"}
        isLoading={deletePO.isPending || updatePO.isPending}
        onConfirm={() => {
          if (deleteState !== null && typeof deleteState === "object") {
            // The fallback is an UPDATE (applyStatus) behind a DELETE-gated
            // control - offer it only with update PurchaseOrder (R3).
            if (canUpdatePO) applyStatus("cancelled", () => setDeleteState(null));
            else setDeleteState(null);
            return;
          }
          submitDelete();
        }}
      />

      {confirmDialog}
    </>
  );
}

// ─── Edit mode: header form (S3.3) ──────────────────────────────────────────
function EditHeaderForm({
  header,
  po,
  vendors,
  jobs,
  onChange,
  onPickJob,
}: {
  header: HeaderDraft;
  po: PurchaseOrder;
  vendors: { id: string; name: string }[];
  jobs: InventoryJob[];
  onChange: (patch: Partial<HeaderDraft>) => void;
  onPickJob: (jobId: string) => void;
}) {
  const vendorOptions = [
    { value: NO_PICK, label: "— pick a vendor —" },
    // A name-only vendor from before the FK existed stays selectable as itself.
    ...(!po.vendorId && po.vendor ? [{ value: LEGACY_VENDOR, label: `${po.vendor} (not in the vendor list)` }] : []),
    ...vendors
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((v) => ({ value: v.id, label: v.name })),
  ];
  const jobOptions = [
    { value: NO_PICK, label: "— no job —" },
    // The linked job may not be in the open-jobs list any more; keep it pickable.
    ...(po.jobId && !jobs.some((j) => j.id === po.jobId)
      ? [{ value: po.jobId, label: po.jobNumber ?? "Linked job" }]
      : []),
    ...jobs.map((j) => ({ value: j.id, label: `${j.jobNumber} · ${j.customer}` })),
  ];
  return (
    <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
      <FormField label="Vendor" gap={1}>
        {(f) => (
          <SelectField
            id={f.id}
            aria-label="Vendor"
            value={header.vendorId}
            onValueChange={(v) => onChange({ vendorId: v })}
            options={vendorOptions}
            size="sm"
          />
        )}
      </FormField>
      <FormField label="Expected delivery" gap={1}>
        <DatePicker value={header.expectedDate} onChange={(v) => onChange({ expectedDate: v })} />
      </FormField>
      <FormField label="Trade" gap={1}>
        {(f) => (
          <SelectField
            id={f.id}
            aria-label="Trade"
            value={header.trade || NO_PICK}
            onValueChange={(v) => onChange({ trade: v === NO_PICK ? "" : (v as Trade) })}
            options={[{ value: NO_PICK, label: "— none —" }, ...TRADES.map((t) => ({ value: t, label: t }))]}
            size="sm"
          />
        )}
      </FormField>
      <FormField label="Job" gap={1} hint="Picking a job fills customer, site and trade.">
        {(f) => (
          <SelectField
            id={f.id}
            aria-label="Job"
            value={header.jobId}
            onValueChange={onPickJob}
            options={jobOptions}
            size="sm"
          />
        )}
      </FormField>
      <FormField label="Customer" gap={1}>
        <Input
          value={header.customer}
          onChange={(e) => onChange({ customer: e.target.value })}
          maxLength={200}
        />
      </FormField>
      <FormField label="Site" gap={1}>
        <Input
          value={header.site}
          onChange={(e) => onChange({ site: e.target.value })}
          maxLength={500}
        />
      </FormField>
    </div>
  );
}

// ─── Edit mode: line editor, drafts only (S3.3) ─────────────────────────────
function LinesEditor({
  lines,
  items,
  onUpdate,
  onRemove,
  onAddCatalog,
  onAddFreeText,
}: {
  lines: EditLine[];
  items: Item[];
  onUpdate: (key: string, patch: Partial<EditLine>) => void;
  onRemove: (key: string) => void;
  onAddCatalog: (itemId: string) => void;
  onAddFreeText: () => void;
}) {
  const catalogOptions = items
    .filter((i) => i.status !== "discontinued" && i.isActive !== false)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((i) => ({ value: i.id, label: `${i.name}${i.sku ? ` (${i.sku})` : ""}` }));
  const subtotal = lines.reduce((s, l) => {
    const qty = Number(l.qtyOrdered) || 0;
    const cost = l.unitCost.trim() === "" ? 0 : Number(l.unitCost) || 0;
    return s + qty * cost;
  }, 0);
  const cellInput = "w-full px-2 py-1 text-sm";
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <SelectField
            aria-label="Add from catalog"
            value=""
            onValueChange={onAddCatalog}
            options={catalogOptions}
            placeholder="Add from catalog…"
            size="sm"
            className="min-w-[240px]"
          />
          <Button variant="outline" tone="neutral" size="sm" onClick={onAddFreeText} className="gap-1">
            <Plus className="h-3 w-3" />
            Add free-text line
          </Button>
        </div>
        <span className="text-[11px] text-text-secondary">
          Lines save with the PO. Blank unit cost = no cost.
        </span>
      </div>

      <div className="overflow-hidden rounded-card border border-border">
        <table className="min-w-full text-sm">
          <thead className="border-b border-border bg-background-light text-left text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
            <tr>
              <th className="px-3 py-2 w-10">#</th>
              <th className="px-3 py-2">SKU</th>
              <th className="px-3 py-2">Description</th>
              <th className="px-3 py-2 w-24">UoM</th>
              <th className="px-3 py-2 w-28 text-right">Qty</th>
              <th className="px-3 py-2 w-32 text-right">Unit $</th>
              <th className="px-3 py-2 text-right">Ext.</th>
              <th className="px-3 py-2 w-12"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {lines.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-xs text-text-secondary">
                  No lines — add one from the catalog or as free text.
                </td>
              </tr>
            )}
            {lines.map((line, idx) => {
              const qty = Number(line.qtyOrdered) || 0;
              const cost = line.unitCost.trim() === "" ? null : Number(line.unitCost) || 0;
              return (
                <tr key={line.key}>
                  <td className="px-3 py-2 text-xs text-text-secondary">{idx + 1}</td>
                  <td className="px-3 py-2 font-mono text-xs text-text-primary">{line.itemSku || "—"}</td>
                  <td className="px-3 py-2">
                    <Input
                      aria-label="Description"
                      value={line.itemName}
                      onChange={(e) => onUpdate(line.key, { itemName: e.target.value })}
                      placeholder="Describe the item"
                      className={cellInput}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <Input
                      aria-label="UoM"
                      value={line.uom}
                      onChange={(e) => onUpdate(line.key, { uom: e.target.value })}
                      className={cellInput}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <Input
                      aria-label="Qty"
                      type="number"
                      min={0}
                      step="0.01"
                      value={line.qtyOrdered}
                      onChange={(e) => onUpdate(line.key, { qtyOrdered: e.target.value })}
                      className={`${cellInput} text-right`}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <Input
                      aria-label="Unit cost"
                      type="number"
                      min={0}
                      step="0.01"
                      value={line.unitCost}
                      onChange={(e) => onUpdate(line.key, { unitCost: e.target.value })}
                      placeholder="—"
                      className={`${cellInput} text-right`}
                    />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums font-medium text-text-primary">
                    {cost != null ? fmtMoney(qty * cost) : "—"}
                  </td>
                  <td className="px-2 py-2 text-center">
                    <Button
                      variant="ghost"
                      tone="danger"
                      revealOnHover
                      size="icon"
                      onClick={() => onRemove(line.key)}
                      aria-label="Remove line"
                      title="Remove this line"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="border-t border-border bg-background-light text-sm">
            <tr>
              <td colSpan={6} className="px-3 py-2 text-right text-xs text-text-secondary">
                Subtotal
              </td>
              <td colSpan={2} className="px-3 py-2 text-right tabular-nums text-text-primary">
                {fmtMoney(subtotal)}
              </td>
            </tr>
            <tr className="border-t border-border">
              <td colSpan={6} className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-text-primary">
                Total
              </td>
              <td colSpan={2} className="px-3 py-2 text-right tabular-nums text-base font-bold text-text-primary">
                {fmtMoney(subtotal)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

// ─── Lines tab ──────────────────────────────────────────────────────────────
function LinesTab({
  po,
  subtotal,
  total,
  receiving,
  receiveDraft,
  receiveDestId,
  onReceiveDestChange,
  destOptions,
  onDraftChange,
  onReceiveAll,
  onResetDraft,
}: {
  po: PurchaseOrder;
  subtotal: number;
  total: number;
  receiving: boolean;
  receiveDraft: Record<string, number>;
  receiveDestId: string;
  onReceiveDestChange: (id: string) => void;
  destOptions: { id: string; label: string }[];
  onDraftChange: (lineId: string, value: number) => void;
  onReceiveAll: () => void;
  onResetDraft: () => void;
}) {
  return (
    <div className="space-y-2">
      {/* Receive-mode quick-action strip — left side picks the destination (D14). */}
      {receiving && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-success/20 bg-success/10 px-3 py-2 text-xs text-success">
          <div className="flex items-center gap-2">
            <span className="font-semibold">Receive into</span>
            {destOptions.length === 0 ? (
              // The dialog (NoInventoryLocationDialog) explains; once closed
              // this keeps the way forward one click away.
              <Link
                to={INVENTORY_LOCATIONS_SETTINGS_PATH}
                className="font-semibold text-primary hover:underline"
              >
                No inventory location yet · Add one in Settings →
              </Link>
            ) : (
              <SelectField
                // Was `receiveDestId || undefined`, which flipped the Radix root
                // between controlled and uncontrolled on an empty id. '' is the
                // same placeholder/empty state to Radix and keeps it controlled
                // throughout.
                value={receiveDestId}
                onValueChange={onReceiveDestChange}
                aria-label="Receive into"
                size="xs"
                className="h-7 min-w-[200px]"
                placeholder="Pick a location…"
                options={destOptions.map((o) => ({ value: o.id, label: o.label }))}
              />
            )}
          </div>
          <div className="flex items-center gap-1.5">
            {/* Deferred: outline/neutral's idle text is unset (inherits) — this
                row's wrapper sets ambient text-success (line ~521), so
                inheriting would render the label green instead of the
                intended secondary-gray. Left raw. */}
            <button
              onClick={onResetDraft}
              className="inline-flex items-center gap-1 rounded border border-border bg-surface-light px-2 py-0.5 text-[11px] font-medium text-text-secondary hover:bg-background-light"
            >
              <RotateCcw className="h-3 w-3" />
              Reset
            </button>
            {/* Deferred: no outline+success cell is minted (only
                outline/neutral and outline/danger exist). Left raw. */}
            <button
              onClick={onReceiveAll}
              className="inline-flex items-center gap-1 rounded border border-success/20 bg-surface-light px-2 py-0.5 text-[11px] font-semibold text-success hover:bg-success/10"
            >
              <PackageCheck className="h-3 w-3" />
              Receive all
            </button>
          </div>
        </div>
      )}

      <div className="overflow-hidden rounded-card border border-border">
        <table className="min-w-full text-sm">
          <thead className="border-b border-border bg-background-light text-left text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
            <tr>
              <th className="px-3 py-2 w-10">#</th>
              <th className="px-3 py-2">SKU</th>
              <th className="px-3 py-2">Description</th>
              <th className="px-3 py-2">UoM</th>
              <th className="px-3 py-2 text-right">Ordered</th>
              <th className="px-3 py-2 text-right">Received</th>
              <th className="px-3 py-2 text-right">Unit $</th>
              <th className="px-3 py-2 text-right">Ext.</th>
              {receiving && <th className="px-3 py-2"></th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {po.lines.map((line, idx) => (
              <LineRow
                key={line.id ?? idx}
                idx={idx}
                line={line}
                receiving={receiving}
                draftValue={receiveDraft[line.id!] ?? line.qtyReceived}
                onDraftChange={(v) => onDraftChange(line.id!, v)}
              />
            ))}
          </tbody>
          <tfoot className="border-t border-border bg-background-light text-sm">
            <tr>
              <td
                colSpan={receiving ? 7 : 6}
                className="px-3 py-2 text-right text-xs text-text-secondary"
              >
                Subtotal
              </td>
              <td colSpan={2} className="px-3 py-2 text-right tabular-nums text-text-primary">
                {fmtMoney(subtotal)}
              </td>
            </tr>
            <tr className="border-t border-border">
              <td
                colSpan={receiving ? 7 : 6}
                className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-text-primary"
              >
                Total
              </td>
              <td colSpan={2} className="px-3 py-2 text-right tabular-nums text-base font-bold text-text-primary">
                {fmtMoney(total)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

function LineRow({
  idx,
  line,
  receiving,
  draftValue,
  onDraftChange,
}: {
  idx: number;
  line: POLine;
  receiving: boolean;
  draftValue: number;
  onDraftChange: (v: number) => void;
}) {
  // One money rule (S3.2): the line's own cost, else the catalog item's cost.
  // No price from either source — render "—", never a fake number.
  const unit = lineHasCost(line) ? lineUnitCost(line) : null;
  const ext = unit != null ? line.qtyOrdered * unit : null;
  const recVal = receiving ? draftValue : line.qtyReceived;
  const recPct = line.qtyOrdered === 0 ? 0 : recVal / line.qtyOrdered;
  return (
    <tr className="hover:bg-background-light">
      <td className="px-3 py-2 text-xs text-text-secondary">{idx + 1}</td>
      <td className="px-3 py-2 font-mono text-xs text-text-primary">
        {line.itemSku}
      </td>
      <td className="px-3 py-2 text-sm text-text-secondary">{line.itemName}</td>
      <td className="px-3 py-2 text-xs text-text-secondary">{line.uom}</td>
      <td className="px-3 py-2 text-right tabular-nums text-text-primary">
        {line.qtyOrdered}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {receiving ? (
          <div className="inline-flex items-center gap-1">
            <Input
              type="number"
              min={0}
              max={line.qtyOrdered}
              step="0.01"
              value={draftValue}
              onChange={(e) => {
                // Quantities are Decimal since P0 — parseFloat, clamped to [0, ordered].
                const v = Math.max(
                  0,
                  Math.min(line.qtyOrdered, parseFloat(e.target.value) || 0),
                );
                onDraftChange(v);
              }}
              className="w-16 px-1.5 py-0.5 text-right"
            />
            <span className="font-mono text-xs text-text-secondary">
              / {line.qtyOrdered}
            </span>
          </div>
        ) : (
          <>
            <span
              className={
                recPct === 1
                  ? "font-semibold text-success"
                  : recPct > 0
                    ? "font-semibold text-warning"
                    : "text-text-secondary"
              }
            >
              {line.qtyReceived}
            </span>
            <span className="text-text-secondary"> / {line.qtyOrdered}</span>
          </>
        )}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-text-secondary">
        {unit != null ? fmtMoney(unit) : "—"}
      </td>
      <td className="px-3 py-2 text-right tabular-nums font-medium text-text-primary">
        {ext != null ? fmtMoney(ext) : "—"}
      </td>
      {receiving && (
        <td className="px-3 py-2 text-right">
          {draftValue < line.qtyOrdered ? (
            // Deferred: no outline+success cell is minted, and this is a
            // small inline table-row increment affordance. Left raw.
            <button
              onClick={() => onDraftChange(Math.min(line.qtyOrdered, draftValue + 1))}
              className="rounded-md border border-success/20 bg-success/10 px-2 py-0.5 text-[11px] font-semibold text-success hover:bg-success/10"
              title="Receive one more unit of this line"
            >
              + 1
            </button>
          ) : (
            <span
              className="inline-flex items-center gap-1 text-[11px] text-success"
              title="Line fully received"
            >
              <CheckCircle2 className="h-3 w-3" />
              Full
            </span>
          )}
        </td>
      )}
    </tr>
  );
}

// ─── Activity tab (D7) — REAL timeline from the server ───────────────────────
// Merged server-side from the audit log (created/updated/received + the actual
// actor) and the historical email rows from before sending was removed.
// Replaces the old synthesized stub that fabricated actor names and timestamps
// off PO status.
const ACTIVITY_TONE: Record<POActivityEvent["kind"], string> = {
  created: "bg-background-light text-text-secondary",
  updated: "bg-primary-subtle text-primary",
  email_sent: "bg-primary-subtle text-primary",
  received: "bg-success/10 text-success",
  event: "bg-background-light text-text-secondary",
};

const ACTIVITY_LABEL: Record<POActivityEvent["kind"], string> = {
  created: "created",
  updated: "updated",
  email_sent: "email",
  received: "received",
  event: "event",
};

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function ActivityTab({ poId }: { poId: string }) {
  const { data: events = [], isLoading, isError } = usePOActivity(poId);

  if (isLoading) {
    return (
      <div className="py-8 text-center text-sm text-text-secondary">
        Loading activity…
      </div>
    );
  }
  if (isError) {
    return (
      <div className="rounded-md border border-danger/20 bg-danger/10 px-3 py-2 text-[11px] text-danger">
        Couldn&apos;t load the activity timeline. Please try again.
      </div>
    );
  }
  if (events.length === 0) {
    return <EmptyState variant="card" title="No activity recorded yet." />;
  }

  return (
    <ul className="space-y-2">
      {events.map((e) => (
        <li
          key={e.id}
          className="flex items-start gap-3 rounded-md border border-border bg-surface-light px-3 py-2"
        >
          <span
            className={`mt-0.5 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize ${ACTIVITY_TONE[e.kind]}`}
          >
            {ACTIVITY_LABEL[e.kind]}
          </span>
          <div className="flex-1">
            <div className="text-sm font-medium text-text-primary">{e.summary}</div>
            {e.detail && (
              <div className="text-[11px] text-text-secondary">{e.detail}</div>
            )}
            <div className="text-[11px] text-text-secondary">
              {e.actor ? `${e.actor} · ` : ""}
              {fmtDateTime(e.at)}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

// ─── Inner tab button ───────────────────────────────────────────────────────
function InnerTab({
  active,
  onClick,
  label,
  count,
  icon: Icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    // Deferred: segmented tab-strip control — not Button-shaped.
    <button
      onClick={onClick}
      className={[
        "inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition",
        active
          ? "border-primary font-semibold text-primary"
          : "border-transparent text-text-secondary hover:text-text-primary",
      ].join(" ")}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
      {count != null && (
        <span
          className={[
            "rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
            active ? "bg-primary text-on-fill" : "bg-secondary-light text-text-secondary",
          ].join(" ")}
        >
          {count}
        </span>
      )}
    </button>
  );
}
