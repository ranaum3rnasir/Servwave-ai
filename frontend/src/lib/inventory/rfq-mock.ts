// MOCK-ONLY deterministic quote generator; feeds _mock data, NOT shipped as production logic.
//
// RFQ (Request-for-Quote) helper.
//
// Lets the user fan a list of line items out to multiple vendors and compare
// the quotes that come back BEFORE committing to a real PO. In production
// this is wired to vendor portals / email RFQ → quote ingestion → ranking.
// In the v1 prototype, quotes are generated deterministically from the
// catalog + vendor seeds so the UI can be exercised end-to-end without
// any backend.
//
// Composite score = 60% price · 25% lead time · 15% reliability. The vendor
// with the highest composite is flagged as `recommended: true`.
//
// ALPHA port note: Emanuel imported the `items`/`vendors` seed arrays directly
// at module scope. To honor data-seam discipline (no runtime _mock imports
// outside the seam), the catalog + vendor lists are now PARAMETERS — callers
// pass the live query data (useInventoryItems()/useVendors()) the same way
// computeVendorSpend/computeInventoryAlerts receive theirs.

import type { Item, Vendor } from "@/lib/api/inventory";

export type RFQLine = {
  itemSku: string;
  itemName: string;
  qty: number;
  uom: string;
};

export type VendorQuoteLine = {
  itemSku: string;
  itemName: string;
  qty: number;
  uom: string;
  unitCost: number;
  ext: number;
  leadTimeDays: number;
  inStock: boolean;
};

export type VendorQuote = {
  vendor: Vendor;
  lines: VendorQuoteLine[];
  total: number;
  avgLeadDays: number;
  reliabilityScore: number; // 0.0–5.0 stars
  pastJobsWithUs: number;   // confidence anchor for the operator
  recommended: boolean;
  rank: 1 | 2 | 3;
  compositeScore: number;   // 0.0–1.0; higher is better
  notes?: string;
};

const VARIANCE_BY_RANK: Record<number, number> = {
  0: 1.0,   // baseline — the "default" supplier from the catalog
  1: 1.07,  // slightly higher
  2: 0.93,  // slightly lower — often the underdog winner
};

/** Cheap deterministic hash → 0..1 for stable mock variation. */
function hash01(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return (h % 1000) / 1000;
}

/**
 * Generate 3 vendor quotes for the supplied line items.
 *
 * - First candidate = the default vendor on the items themselves (catalog `vendor` field
 *   of the most-expensive line — usually the one the buyer would have used by default).
 * - Other candidates = the next two non-Internal vendors by alphabetical order, skipping
 *   the first one so we always show three different vendors.
 *
 * Each quote applies a deterministic ±7% variance to unit cost, a deterministic
 * lead-time adjustment, and a reliability score derived from a vendor.id hash so
 * the comparison view is stable across re-opens.
 */
export function generateQuotes(
  lines: RFQLine[],
  allItems: Item[],
  allVendors: Vendor[],
): VendorQuote[] {
  if (lines.length === 0) return [];

  // Pick the "default" vendor from the catalog item with the highest line ext.
  const catalogMatches: Array<{ line: RFQLine; item: Item | undefined; ext: number }> = lines.map(
    (l) => {
      const item = allItems.find((i) => i.sku === l.itemSku);
      const ext = (item?.unitCost ?? 0) * l.qty;
      return { line: l, item, ext };
    },
  );
  catalogMatches.sort((a, b) => b.ext - a.ext);
  const defaultVendorName = catalogMatches[0]?.item?.vendor;
  const defaultVendor = allVendors.find((v) => v.name === defaultVendorName);

  // Build candidate list — default vendor first, then 2 others.
  const others = allVendors
    .filter((v) => v.id !== "vnd_internal" && v.id !== defaultVendor?.id)
    .sort((a, b) => a.name.localeCompare(b.name));
  const candidates: Vendor[] = [];
  if (defaultVendor) candidates.push(defaultVendor);
  for (const v of others) {
    if (candidates.length >= 3) break;
    candidates.push(v);
  }
  // Pad if we somehow ended up with fewer than 3.
  while (candidates.length < 3 && candidates.length < allVendors.length - 1) {
    const next = allVendors.find(
      (v) => v.id !== "vnd_internal" && !candidates.find((c) => c.id === v.id),
    );
    if (!next) break;
    candidates.push(next);
  }

  // Generate a quote for each candidate.
  const quotes: VendorQuote[] = candidates.map((vendor, idx) => {
    const variance = VARIANCE_BY_RANK[idx] ?? 1;
    const quoteLines: VendorQuoteLine[] = lines.map((l) => {
      const item = allItems.find((i) => i.sku === l.itemSku);
      const baseCost = item?.unitCost ?? 0;
      // Lightly randomize per-line within ±3% so totals aren't a flat multiplier
      const lineNoise = 1 + (hash01(`${vendor.id}|${l.itemSku}`) - 0.5) * 0.06;
      const unitCost = +(baseCost * variance * lineNoise).toFixed(2);
      const ext = +(unitCost * l.qty).toFixed(2);
      // Stagger in-stock: idx=1 has some items on backorder
      const oneOutOfStock =
        idx === 1 && hash01(`${vendor.id}|${l.itemSku}|stock`) > 0.55;
      const leadTimeDays = (vendor.leadTimeDays ?? 0) + (oneOutOfStock ? 3 : 0);
      return {
        itemSku: l.itemSku,
        itemName: l.itemName,
        qty: l.qty,
        uom: l.uom,
        unitCost,
        ext,
        leadTimeDays,
        inStock: !oneOutOfStock,
      };
    });
    const total = +quoteLines.reduce((s, ql) => s + ql.ext, 0).toFixed(2);
    const avgLeadDays = Math.round(
      quoteLines.reduce((s, ql) => s + ql.leadTimeDays, 0) / quoteLines.length,
    );
    // Reliability: 3.5–5.0 stars, deterministic from id hash
    const reliabilityScore = +(3.5 + hash01(vendor.id) * 1.5).toFixed(1);
    // Past jobs: 4–60, deterministic from id hash
    const pastJobsWithUs = Math.round(4 + hash01(`${vendor.id}|past`) * 56);
    const anyOutOfStock = quoteLines.some((q) => !q.inStock);
    return {
      vendor,
      lines: quoteLines,
      total,
      avgLeadDays,
      reliabilityScore,
      pastJobsWithUs,
      recommended: false,
      rank: (idx + 1) as 1 | 2 | 3,
      compositeScore: 0, // filled below
      notes: anyOutOfStock
        ? "Some items on backorder — adds ~3 days to longest lead"
        : undefined,
    };
  });

  // Score + rank. Lower total / lead = better; higher reliability = better.
  const totals = quotes.map((q) => q.total);
  const leads = quotes.map((q) => q.avgLeadDays);
  const minTotal = Math.min(...totals) || 1;
  const minLead = Math.min(...leads) || 1;
  for (const q of quotes) {
    const priceScore = minTotal / q.total;
    const leadScore = minLead / Math.max(q.avgLeadDays, 1);
    const reliabilityNorm = q.reliabilityScore / 5;
    q.compositeScore = +(
      priceScore * 0.6 +
      leadScore * 0.25 +
      reliabilityNorm * 0.15
    ).toFixed(3);
  }

  // Pick the winner (highest composite). Tie-break by lower total.
  const winner = [...quotes].sort((a, b) => {
    if (b.compositeScore !== a.compositeScore)
      return b.compositeScore - a.compositeScore;
    return a.total - b.total;
  })[0];
  if (winner) winner.recommended = true;

  return quotes;
}

/** Returns the cheapest, fastest, and most-reliable badges for callouts. */
export function quoteSuperlatives(quotes: VendorQuote[]): {
  cheapestVendorId?: string;
  fastestVendorId?: string;
  mostReliableVendorId?: string;
} {
  if (quotes.length === 0) return {};
  // quotes is non-empty here (guarded above), so [0] is always defined.
  const cheap = [...quotes].sort((a, b) => a.total - b.total)[0]!;
  const fast = [...quotes].sort((a, b) => a.avgLeadDays - b.avgLeadDays)[0]!;
  const reliable = [...quotes].sort(
    (a, b) => b.reliabilityScore - a.reliabilityScore,
  )[0]!;
  return {
    cheapestVendorId: cheap.vendor.id,
    fastestVendorId: fast.vendor.id,
    mostReliableVendorId: reliable.vendor.id,
  };
}
