// Pure proposal builder for the low-stock → Generate PO flow (Inventory P2,
// D16 entry #3, QA-612). No React — unit-testable in isolation.
//
// Flagged set = items failing `isLowStock` (seam helper). suggestedQty refills
// to max when configured, else to min. Groups key on `item.vendor` matched
// case-sensitively against `vendors[].name` (the same name-join
// DeleteVendorDialog already relies on); unmatched/empty vendor names
// collapse into ONE `vendorName: null` group ("No preferred vendor"), sorted
// last; named groups sort alphabetically.

import { isLowStock } from '@/lib/api/inventory';
import type { Item, Vendor } from '@/lib/api/inventory';

export type ProposalLine = { item: Item; suggestedQty: number };
export type VendorGroup = { vendorName: string | null; vendor?: Vendor; lines: ProposalLine[] };

export function buildLowStockProposal(items: Item[], vendors: Vendor[]): VendorGroup[] {
  const flagged = items.filter(isLowStock);

  const groups = new Map<string | null, VendorGroup>();
  for (const item of flagged) {
    // Σ over offending stock rows of (max ?? min) − onHand, min 1.
    const shortfall = item.stock
      .filter((s) => s.min != null && s.onHand < s.min)
      .reduce((sum, s) => sum + ((s.max ?? s.min!) - s.onHand), 0);
    const suggestedQty = Math.max(1, Math.ceil(shortfall));

    const vendor = item.vendor ? vendors.find((v) => v.name === item.vendor) : undefined;
    const key = vendor ? vendor.name : null;
    const group = groups.get(key) ?? { vendorName: key, vendor, lines: [] };
    group.lines.push({ item, suggestedQty });
    groups.set(key, group);
  }

  return Array.from(groups.values()).sort((a, b) => {
    if (a.vendorName === null) return 1; // null group last
    if (b.vendorName === null) return -1;
    return a.vendorName.localeCompare(b.vendorName);
  });
}
