// Vendor-spend rollups for the Vendors page (Purchasing Audit Verdict PR 3, S3.2).
//
// Spend is keyed on the vendor's ID (a rename keeps its history), counts only
// POs that were actually placed - ordered | partial | received | closed - and
// prices every line by the ONE money rule in `po-money` (line cost, then the
// linked catalog item's cost, then $0). Drafts and cancelled POs contribute
// nothing. The catalog is no longer joined by SKU here: the server ships
// `catalogUnitCost` on every line.

import type { POStatus, PurchaseOrder, Vendor } from "@/lib/api/inventory";
import { formatCurrencyWhole } from "@/lib/utils";
import { lineTotal, poTotal } from "@/lib/inventory/po-money";

export type VendorSpend = {
  vendorId: string;
  vendorName: string;
  allTime: number;
  ytd: number;
  thisMonth: number;
  lastMonth: number;
  momDelta: number;        // thisMonth - lastMonth (signed)
  momDeltaPct: number;     // thisMonth / lastMonth - 1; 0 if lastMonth==0
  poCount: number;         // all-time
  ytdPoCount: number;
  avgPoSize: number;       // all-time avg
  lastOrderedAt: string | null;
  topItemSku: string | null;   // most-ordered SKU by extension cost
  topItemName: string | null;
};

/** Statuses that count toward spend: the PO was placed with the vendor. */
export const SPEND_PO_STATUSES: ReadonlySet<POStatus> = new Set<POStatus>([
  "ordered",
  "partial",
  "received",
  "closed",
]);

type VendorKey = Pick<Vendor, "id" | "name">;

/**
 * Does this PO belong to the vendor? By id. A PO that predates vendor ids
 * (created from the PO page before S3.1, `vendorId` absent) falls back to its
 * name snapshot so pre-id history is not silently zeroed; a PO that DOES carry
 * an id never matches by name, so two vendors sharing a display name stay apart.
 */
export function poBelongsToVendor(po: Pick<PurchaseOrder, "vendor" | "vendorId">, vendor: VendorKey): boolean {
  return po.vendorId ? po.vendorId === vendor.id : po.vendor === vendor.name;
}

export function computeVendorSpend(
  vendor: VendorKey,
  pos: PurchaseOrder[],
  now: Date = new Date(),
): VendorSpend {
  const vendorPOs = pos.filter((p) => poBelongsToVendor(p, vendor) && SPEND_PO_STATUSES.has(p.status));

  const year = now.getFullYear();
  const month = now.getMonth();
  const lastMonthDate = new Date(now);
  lastMonthDate.setMonth(month - 1);
  const lastMonth = lastMonthDate.getMonth();
  const lastMonthYear = lastMonthDate.getFullYear();

  let allTime = 0;
  let ytd = 0;
  let thisMonth = 0;
  let lastMonthSpend = 0;
  let ytdPoCount = 0;
  let lastOrderedAt: string | null = null;
  const itemExtensions = new Map<string, { ext: number; name: string }>();

  for (const po of vendorPOs) {
    const total = poTotal(po);
    allTime += total;
    // Every counted PO has been marked ordered; createdAt is only a guard for
    // rows imported with a status but no date.
    const orderedIso = po.orderedAt ?? po.createdAt;
    const orderedDate = new Date(orderedIso);
    if (orderedDate.getFullYear() === year) {
      ytd += total;
      ytdPoCount += 1;
      if (orderedDate.getMonth() === month) thisMonth += total;
    }
    if (
      orderedDate.getFullYear() === lastMonthYear &&
      orderedDate.getMonth() === lastMonth
    ) {
      lastMonthSpend += total;
    }
    if (!lastOrderedAt || orderedDate > new Date(lastOrderedAt)) {
      lastOrderedAt = orderedIso;
    }
    for (const l of po.lines) {
      const ext = lineTotal(l);
      const prev = itemExtensions.get(l.itemSku);
      itemExtensions.set(l.itemSku, {
        ext: (prev?.ext ?? 0) + ext,
        name: l.itemName,
      });
    }
  }

  let topItemSku: string | null = null;
  let topItemName: string | null = null;
  let topExt = 0;
  for (const [sku, { ext, name }] of itemExtensions) {
    if (ext > topExt) {
      topExt = ext;
      topItemSku = sku;
      topItemName = name;
    }
  }

  const momDelta = thisMonth - lastMonthSpend;
  const momDeltaPct = lastMonthSpend > 0 ? thisMonth / lastMonthSpend - 1 : 0;
  const poCount = vendorPOs.length;
  const avgPoSize = poCount > 0 ? allTime / poCount : 0;

  return {
    vendorId: vendor.id,
    vendorName: vendor.name,
    allTime,
    ytd,
    thisMonth,
    lastMonth: lastMonthSpend,
    momDelta,
    momDeltaPct,
    poCount,
    ytdPoCount,
    avgPoSize,
    lastOrderedAt,
    topItemSku,
    topItemName,
  };
}

/** Keyed on vendor ID. Every vendor passed in gets an entry - $0 when it has no spend. */
export type VendorSpendIndex = Map<string, VendorSpend>;

export function computeAllVendorSpend(
  vendors: Vendor[],
  pos: PurchaseOrder[],
  now: Date = new Date(),
): VendorSpendIndex {
  const map: VendorSpendIndex = new Map();
  for (const v of vendors) {
    map.set(v.id, computeVendorSpend(v, pos, now));
  }
  return map;
}

export function totalSpendYTD(index: VendorSpendIndex): number {
  let sum = 0;
  for (const s of index.values()) sum += s.ytd;
  return sum;
}

export function totalSpendAllTime(index: VendorSpendIndex): number {
  let sum = 0;
  for (const s of index.values()) sum += s.allTime;
  return sum;
}

export function topVendorByYTD(index: VendorSpendIndex): VendorSpend | null {
  let top: VendorSpend | null = null;
  for (const s of index.values()) {
    if (!top || s.ytd > top.ytd) top = s;
  }
  return top;
}

export function vendorShareOfYTD(spend: VendorSpend, index: VendorSpendIndex): number {
  const total = totalSpendYTD(index);
  if (total <= 0) return 0;
  return spend.ytd / total;
}

/** The vendor's latest POs in ANY status (drafts included - this is history, not spend). */
export function recentPOs(
  vendor: VendorKey,
  pos: PurchaseOrder[],
  n: number = 5,
): PurchaseOrder[] {
  return [...pos]
    .filter((p) => poBelongsToVendor(p, vendor))
    .sort(
      (a, b) =>
        new Date(b.orderedAt ?? b.createdAt).getTime() - new Date(a.orderedAt ?? a.createdAt).getTime(),
    )
    .slice(0, n);
}

// Design rule: money renders as full comma-grouped numbers — no k/M
// abbreviations. Both helpers delegate to the app-wide formatter.
export function fmtMoney(n: number): string {
  return formatCurrencyWhole(n);
}

export function fmtMoneyFull(n: number): string {
  return formatCurrencyWhole(n);
}

export function fmtPct(n: number, digits: number = 1): string {
  return `${(n * 100).toFixed(digits)}%`;
}

export function fmtRelativeDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}
