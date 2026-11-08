// Inventory P2 (D16 entry #3) — pure proposal builder for the low-stock →
// Generate PO flow. No React: refill math, grouping, and ordering only.
import { describe, it, expect } from 'vitest';
import { buildLowStockProposal } from '@/lib/inventory/low-stock-proposal';
import type { Item, Vendor, StockAtLocation } from '@/lib/api/inventory';

let seq = 0;
function makeItem(overrides: Partial<Item> & { stock: StockAtLocation[] }): Item {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-00000000000${seq}`,
    sku: `SKU-00${seq}`,
    name: `Item ${seq}`,
    category: 'Hardware',
    trade: 'security',
    kind: 'material',
    uom: 'EA',
    sellPrice: 10,
    serialized: false,
    hazmat: false,
    status: 'active',
    vendor: '',
    updatedAt: '2026-07-01T00:00:00Z',
    ...overrides,
  };
}

function makeVendor(name: string): Vendor {
  return {
    id: `vnd_${name.toLowerCase().replace(/\W+/g, '_')}`,
    name,
    category: 'Hardware',
    paymentTerms: 'Net 30',
    leadTimeDays: 3,
    transmitMethod: 'email',
    status: 'active',
  };
}

const LOC_A = 'aaaaaaa1-0000-4000-8000-000000000001';
const LOC_B = 'aaaaaaa2-0000-4000-8000-000000000002';

describe('buildLowStockProposal', () => {
  it('refills to max when configured, else to min', () => {
    const toMax = makeItem({ vendor: 'Acme', stock: [{ locationId: LOC_A, onHand: 2, min: 5, max: 20 }] });
    const toMin = makeItem({ vendor: 'Acme', stock: [{ locationId: LOC_A, onHand: 2, min: 5 }] });
    const groups = buildLowStockProposal([toMax, toMin], [makeVendor('Acme')]);

    expect(groups).toHaveLength(1);
    const bySku = new Map(groups[0]!.lines.map((l) => [l.item.sku, l.suggestedQty]));
    expect(bySku.get(toMax.sku)).toBe(18); // 20 − 2
    expect(bySku.get(toMin.sku)).toBe(3); // 5 − 2
  });

  it('sums the shortfall across multiple offending locations', () => {
    const item = makeItem({
      vendor: 'Acme',
      stock: [
        { locationId: LOC_A, onHand: 1, min: 4 }, // 3 short
        { locationId: LOC_B, onHand: 0, min: 2, max: 6 }, // 6 short (to max)
        { locationId: 'loc-ok', onHand: 50, min: 5 }, // not offending
      ],
    });
    const groups = buildLowStockProposal([item], [makeVendor('Acme')]);
    expect(groups[0]!.lines[0]!.suggestedQty).toBe(9);
  });

  it('groups by exact vendor-name match, named groups sorted alphabetically', () => {
    const a1 = makeItem({ vendor: 'Zeta Supply', stock: [{ locationId: LOC_A, onHand: 0, min: 1 }] });
    const b1 = makeItem({ vendor: 'Acme', stock: [{ locationId: LOC_A, onHand: 0, min: 1 }] });
    const b2 = makeItem({ vendor: 'Acme', stock: [{ locationId: LOC_A, onHand: 0, min: 2 }] });
    const groups = buildLowStockProposal([a1, b1, b2], [makeVendor('Acme'), makeVendor('Zeta Supply')]);

    expect(groups.map((g) => g.vendorName)).toEqual(['Acme', 'Zeta Supply']);
    expect(groups[0]!.lines).toHaveLength(2);
    expect(groups[0]!.vendor?.name).toBe('Acme');
  });

  it('collapses unmatched or empty vendor names into ONE null group, sorted last', () => {
    const unmatched = makeItem({ vendor: 'Ghost Vendor', stock: [{ locationId: LOC_A, onHand: 0, min: 1 }] });
    const empty = makeItem({ vendor: '', stock: [{ locationId: LOC_A, onHand: 0, min: 1 }] });
    const named = makeItem({ vendor: 'Acme', stock: [{ locationId: LOC_A, onHand: 0, min: 1 }] });
    const groups = buildLowStockProposal([unmatched, empty, named], [makeVendor('Acme')]);

    expect(groups.map((g) => g.vendorName)).toEqual(['Acme', null]);
    expect(groups[1]!.lines).toHaveLength(2);
    expect(groups[1]!.vendor).toBeUndefined();
  });

  it('clamps the suggestion to a minimum of 1 (fractional shortfalls round up)', () => {
    const item = makeItem({ vendor: 'Acme', stock: [{ locationId: LOC_A, onHand: 4.9, min: 5 }] });
    const groups = buildLowStockProposal([item], [makeVendor('Acme')]);
    expect(groups[0]!.lines[0]!.suggestedQty).toBe(1);
  });

  it('excludes items that are not low on stock', () => {
    const fine = makeItem({ vendor: 'Acme', stock: [{ locationId: LOC_A, onHand: 10, min: 5 }] });
    const noMin = makeItem({ vendor: 'Acme', stock: [{ locationId: LOC_A, onHand: 0 }] });
    expect(buildLowStockProposal([fine, noMin], [makeVendor('Acme')])).toEqual([]);
  });
});
