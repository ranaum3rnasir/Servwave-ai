// S3.2 - vendor spend is keyed on the vendor's id, counts ordered-or-later POs
// only, and prices lines by the one money rule (line -> catalog -> 0).
import { describe, it, expect } from "vitest";
import type { PurchaseOrder, POStatus, Vendor } from "@/lib/api/inventory";
import {
  computeAllVendorSpend,
  computeVendorSpend,
  recentPOs,
  SPEND_PO_STATUSES,
} from "@/lib/inventory/vendor-spend";

const NOW = new Date("2026-09-15T12:00:00Z");

const ACME: Vendor = { id: "v-acme", name: "Acme Supply", category: "HVAC", status: "active" } as Vendor;
const BORDER: Vendor = { id: "v-border", name: "Border Parts", category: "Electrical", status: "active" } as Vendor;

let n = 0;
function po(over: Partial<PurchaseOrder> & { status: POStatus }): PurchaseOrder {
  n += 1;
  return {
    id: `po-${n}`,
    poNumber: `PO-${1000 + n}`,
    vendor: "Acme Supply",
    vendorId: "v-acme",
    orderedAt: "2026-09-02T00:00:00Z",
    orderedBy: null,
    receivedAt: null,
    leadTimeDays: null,
    notes: null,
    signatureData: null,
    signatureName: null,
    signatureAt: null,
    createdAt: "2026-09-01T00:00:00Z",
    lines: [{ id: `l-${n}`, itemSku: "CAP-01", itemName: "Run Capacitor", uom: "ea", qtyOrdered: 4, qtyReceived: 0, unitCost: 10 }],
    ...over,
  };
}

describe("computeVendorSpend - which POs count", () => {
  it("counts ordered, partial, received and closed; never draft or cancelled", () => {
    expect([...SPEND_PO_STATUSES].sort()).toEqual(["closed", "ordered", "partial", "received"]);
    const pos = [
      po({ status: "draft", orderedAt: null }),
      po({ status: "cancelled" }),
      po({ status: "ordered" }),
      po({ status: "partial" }),
      po({ status: "received" }),
      po({ status: "closed" }),
    ];
    const spend = computeVendorSpend(ACME, pos, NOW);
    expect(spend.allTime).toBe(4 * 40);
    expect(spend.poCount).toBe(4);
    expect(spend.ytd).toBe(160);
    expect(spend.ytdPoCount).toBe(4);
  });

  it("a draft contributes $0 to its vendor's spend", () => {
    const spend = computeVendorSpend(ACME, [po({ status: "draft", orderedAt: null })], NOW);
    expect(spend.allTime).toBe(0);
    expect(spend.ytd).toBe(0);
    expect(spend.poCount).toBe(0);
    expect(spend.lastOrderedAt).toBeNull();
    expect(spend.topItemSku).toBeNull();
  });
});

describe("computeVendorSpend - keyed on vendorId", () => {
  it("matches by vendorId, so a renamed vendor keeps its spend", () => {
    const pos = [po({ status: "ordered", vendor: "Acme Supply (old name)", vendorId: "v-acme" })];
    const renamed: Vendor = { ...ACME, name: "ACME Industrial" };
    expect(computeVendorSpend(renamed, pos, NOW).allTime).toBe(40);
  });

  it("does not credit a PO carrying another vendor's id, even under the same display name", () => {
    const pos = [po({ status: "ordered", vendor: "Acme Supply", vendorId: "v-border" })];
    expect(computeVendorSpend(ACME, pos, NOW).allTime).toBe(0);
    expect(computeVendorSpend(BORDER, pos, NOW).allTime).toBe(40);
  });

  it("a legacy PO with no vendorId falls back to the name snapshot (pre-id rows keep their history)", () => {
    const pos = [po({ status: "received", vendor: "Acme Supply", vendorId: undefined })];
    expect(computeVendorSpend(ACME, pos, NOW).allTime).toBe(40);
    expect(computeVendorSpend(BORDER, pos, NOW).allTime).toBe(0);
  });
});

describe("computeVendorSpend - priced by the one money rule", () => {
  it("line cost wins, catalog cost is the fallback, unpriced lines are $0", () => {
    const pos = [
      po({
        status: "ordered",
        lines: [
          { id: "a", itemSku: "A", itemName: "A", uom: "ea", qtyOrdered: 2, qtyReceived: 0, unitCost: 10, catalogUnitCost: 99 }, // 20
          { id: "b", itemSku: "B", itemName: "B", uom: "ea", qtyOrdered: 3, qtyReceived: 0, catalogUnitCost: 5 },              // 15
          { id: "c", itemSku: "C", itemName: "C", uom: "ea", qtyOrdered: 7, qtyReceived: 0 },                                  // 0
        ],
      }),
    ];
    const spend = computeVendorSpend(ACME, pos, NOW);
    expect(spend.allTime).toBe(35);
    expect(spend.topItemSku).toBe("A");
    expect(spend.avgPoSize).toBe(35);
  });
});

describe("computeVendorSpend - period buckets", () => {
  it("YTD / this month / last month follow orderedAt; MoM delta is signed", () => {
    const pos = [
      po({ status: "received", orderedAt: "2026-09-03T00:00:00Z" }),            // this month  40
      po({ status: "received", orderedAt: "2026-08-20T00:00:00Z" }),            // last month  40
      po({ status: "received", orderedAt: "2026-08-02T00:00:00Z" }),            // last month  40
      po({ status: "closed",   orderedAt: "2026-01-10T00:00:00Z" }),            // YTD only    40
      po({ status: "closed",   orderedAt: "2025-12-10T00:00:00Z" }),            // prior year  40
    ];
    const spend = computeVendorSpend(ACME, pos, NOW);
    expect(spend.allTime).toBe(200);
    expect(spend.ytd).toBe(160);
    expect(spend.ytdPoCount).toBe(4);
    expect(spend.thisMonth).toBe(40);
    expect(spend.lastMonth).toBe(80);
    expect(spend.momDelta).toBe(-40);
    expect(spend.momDeltaPct).toBeCloseTo(-0.5);
    expect(spend.lastOrderedAt).toBe("2026-09-03T00:00:00Z");
  });
});

describe("computeAllVendorSpend", () => {
  it("is keyed on vendor id and has a $0 entry for every vendor, spend or not", () => {
    const index = computeAllVendorSpend([ACME, BORDER], [po({ status: "ordered" })], NOW);
    expect([...index.keys()].sort()).toEqual(["v-acme", "v-border"]);
    expect(index.get("v-acme")?.ytd).toBe(40);
    expect(index.get("v-border")).toMatchObject({ vendorId: "v-border", vendorName: "Border Parts", ytd: 0, allTime: 0, poCount: 0 });
  });
});

describe("recentPOs", () => {
  it("matches by id (name fallback for legacy rows), newest first, capped at n", () => {
    const pos = [
      po({ status: "draft", orderedAt: null, createdAt: "2026-09-10T00:00:00Z", poNumber: "NEWEST-DRAFT" }),
      po({ status: "ordered", orderedAt: "2026-09-05T00:00:00Z", poNumber: "MID" }),
      po({ status: "ordered", orderedAt: "2026-09-01T00:00:00Z", poNumber: "OLD", vendor: "Acme Supply", vendorId: undefined }),
      po({ status: "ordered", orderedAt: "2026-09-08T00:00:00Z", poNumber: "OTHER", vendorId: "v-border" }),
    ];
    expect(recentPOs(ACME, pos, 2).map((p) => p.poNumber)).toEqual(["NEWEST-DRAFT", "MID"]);
    expect(recentPOs(ACME, pos, 5).map((p) => p.poNumber)).toEqual(["NEWEST-DRAFT", "MID", "OLD"]);
  });
});
