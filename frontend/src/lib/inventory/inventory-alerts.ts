// Aggregates everything in inventory that's currently asking for the
// operator's attention into one categorized list — the dataset behind the
// TopBar bell dropdown (rev 2026-05-27). Read-only / pure: never mutates the
// inputs and can be re-computed on every render.
//
// IMPORTANT (ALPHA port): callers must feed this LIVE query data. Emanuel
// computed these counts ONCE at module-load (non-reactive) by importing the
// seed arrays directly. In ALPHA, consumers must pass the seam hooks' `data`
// (useInventoryItems/useLocations/usePurchaseOrders/useJobStages) into
// `computeInventoryAlerts`, never a module import.
//
// Per PRD §7.4.A (job staging), §5.4.A (low stock + backorder KPIs), §7.4
// (PO partial-receive follow-up). The stock-approvals input was removed with
// the feature-parking of /stock-approvals (P0 §C / QA-901).

import { isLowStock } from "@/lib/api/inventory";
import type {
  Item,
  Location,
  PurchaseOrder,
  JobStage,
} from "@/lib/api/inventory";

export type InventoryAlertKind =
  | "low_stock"
  | "backorder"
  | "staging_ready"
  | "staging_no_area"
  | "po_partial";

export type InventoryAlertSeverity = "critical" | "warning" | "info";

export type InventoryAlert = {
  id: string;
  kind: InventoryAlertKind;
  severity: InventoryAlertSeverity;
  title: string;
  subtitle: string;
  // ISO timestamp of when the alert-worthy state was last touched — the
  // dropdown sorts within a section by this desc so the freshest signal
  // sits on top (e.g. an approval requested 9 min ago beats one from
  // yesterday).
  at?: string;
  // Optional structured ref so a future rev can wire a per-row jump to the
  // relevant page / dialog.
  ref?: {
    itemSku?: string;
    poNumber?: string;
    stageId?: string;
  };
};

export type InventoryAlertGroup = {
  kind: InventoryAlertKind;
  label: string;
  alerts: InventoryAlert[];
};

const KIND_ORDER: InventoryAlertKind[] = [
  "backorder",
  "low_stock",
  "staging_no_area",
  "po_partial",
  "staging_ready",
];

const KIND_LABEL: Record<InventoryAlertKind, string> = {
  backorder: "On backorder",
  low_stock: "Low stock",
  staging_no_area: "Staging area not set",
  po_partial: "POs partially received",
  staging_ready: "Ready for pickup",
};

function locationNameMap(locations: Location[]): Map<string, string> {
  return new Map(locations.map((l) => [l.id, l.name]));
}

export function computeInventoryAlerts(input: {
  items: Item[];
  locations: Location[];
  purchaseOrders: PurchaseOrder[];
  jobStages: JobStage[];
}): InventoryAlert[] {
  const { items, locations, purchaseOrders, jobStages } = input;
  const locName = locationNameMap(locations);
  const out: InventoryAlert[] = [];

  // ── Low stock — material-only, any location below min ────────────
  for (const item of items) {
    if (item.kind !== "material") continue;
    if (item.status === "on_backorder") continue; // backorder owns the surface
    if (!isLowStock(item)) continue;
    const offending = item.stock
      .filter((s) => s.min != null && s.onHand < s.min)
      .map((s) => `${locName.get(s.locationId) ?? s.locationId}: ${s.onHand}/${s.min}`)
      .join(" · ");
    out.push({
      id: `low_${item.id}`,
      kind: "low_stock",
      severity: "warning",
      title: `${item.name}`,
      subtitle: `${item.sku} · ${offending || "below min"}`,
      at: item.updatedAt,
      ref: { itemSku: item.sku },
    });
  }

  // ── Backorder — flag items the vendor still owes us ───────────────
  for (const item of items) {
    if (item.status !== "on_backorder") continue;
    out.push({
      id: `bo_${item.id}`,
      kind: "backorder",
      severity: "critical",
      title: item.name,
      subtitle: `${item.sku} · vendor ${item.vendor}`,
      at: item.updatedAt,
      ref: { itemSku: item.sku },
    });
  }

  // ── Job staging — ready for pickup, tech needs to drive over ─────
  for (const stage of jobStages) {
    if (stage.status === "ready_for_pickup") {
      out.push({
        id: `stg_ready_${stage.id}`,
        kind: "staging_ready",
        severity: "info",
        title: `${stage.jobNumber} · ${stage.customer}`,
        subtitle: stage.assignedTech
          ? `Ready · ${stage.assignedTech}${stage.stagedArea ? ` · ${stage.stagedArea}` : ""}`
          : `Ready · pickup tech not assigned`,
        at: stage.updatedAt ?? stage.createdAt,
        ref: { stageId: stage.id },
      });
    }
    // Stage is fully received but no staging area marked → tech can't find the parts
    const needsArea =
      (stage.status === "complete" || stage.status === "ready_for_pickup") &&
      !stage.stagedArea;
    if (needsArea) {
      out.push({
        id: `stg_noarea_${stage.id}`,
        kind: "staging_no_area",
        severity: "warning",
        title: `${stage.jobNumber} · ${stage.customer}`,
        subtitle: `Tell the tech where in the warehouse — area not set`,
        at: stage.updatedAt ?? stage.createdAt,
        ref: { stageId: stage.id },
      });
    }
  }

  // ── POs partially received — chase the remainder ─────────────────
  for (const po of purchaseOrders) {
    if (po.status !== "partial") continue;
    const totalOrdered = po.lines.reduce((s, l) => s + l.qtyOrdered, 0);
    const totalReceived = po.lines.reduce((s, l) => s + (l.qtyReceived ?? 0), 0);
    const remaining = totalOrdered - totalReceived;
    out.push({
      id: `po_${po.id}`,
      kind: "po_partial",
      severity: "warning",
      title: `${po.poNumber} · ${po.vendor}`,
      subtitle: `${remaining} of ${totalOrdered} ${remaining === 1 ? "unit" : "units"} still owed${
        po.jobNumber ? ` · ${po.jobNumber}` : ""
      }`,
      // A partial PO has been ordered, but the type allows null (drafts) - fall back to creation.
      at: po.orderedAt ?? po.createdAt,
      ref: { poNumber: po.poNumber },
    });
  }

  return out;
}

export function groupAlerts(alerts: InventoryAlert[]): InventoryAlertGroup[] {
  const map = new Map<InventoryAlertKind, InventoryAlert[]>();
  for (const a of alerts) {
    const list = map.get(a.kind) ?? [];
    list.push(a);
    map.set(a.kind, list);
  }
  // Sort within each group: freshest first.
  for (const list of map.values()) {
    list.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  }
  return KIND_ORDER.filter((k) => (map.get(k)?.length ?? 0) > 0).map((kind) => ({
    kind,
    label: KIND_LABEL[kind],
    alerts: map.get(kind) ?? [],
  }));
}

export function severityCounts(alerts: InventoryAlert[]): {
  critical: number;
  warning: number;
  info: number;
} {
  let critical = 0;
  let warning = 0;
  let info = 0;
  for (const a of alerts) {
    if (a.severity === "critical") critical++;
    else if (a.severity === "warning") warning++;
    else info++;
  }
  return { critical, warning, info };
}

// Compact relative-time string used in the dropdown rows. Keeps the dropdown
// scannable — full timestamps are surfaced on hover via title attribute.
export function relativeShort(iso: string | undefined, now = new Date()): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!isFinite(t)) return "";
  const diff = now.getTime() - t;
  if (diff < 0) return "now";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk}w ago`;
  const mo = Math.floor(day / 30);
  return `${mo}mo ago`;
}
