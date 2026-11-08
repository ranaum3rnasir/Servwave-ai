// S3.2 - the one money rule: line cost, then catalog cost, then zero.
import { describe, it, expect } from "vitest";
import { lineHasCost, lineTotal, lineUnitCost, poTotal } from "@/lib/inventory/po-money";

function line(over: { qtyOrdered?: number; unitCost?: number; catalogUnitCost?: number | null }) {
  return { itemSku: "X", itemName: "X", uom: "EA", qtyOrdered: 2, qtyReceived: 0, ...over };
}

describe("lineUnitCost", () => {
  it("the line's own unit cost wins over the catalog cost", () => {
    expect(lineUnitCost(line({ unitCost: 12.5, catalogUnitCost: 99 }))).toBe(12.5);
  });

  it("a $0 line cost is a real price - it is NOT overridden by the catalog", () => {
    expect(lineUnitCost(line({ unitCost: 0, catalogUnitCost: 99 }))).toBe(0);
  });

  it("falls back to the catalog cost when the line has none", () => {
    expect(lineUnitCost(line({ catalogUnitCost: 7.25 }))).toBe(7.25);
  });

  it("is zero when neither source has a price", () => {
    expect(lineUnitCost(line({}))).toBe(0);
    expect(lineUnitCost(line({ catalogUnitCost: null }))).toBe(0);
  });
});

describe("lineHasCost", () => {
  it("is true for either source and false for neither", () => {
    expect(lineHasCost(line({ unitCost: 0 }))).toBe(true);
    expect(lineHasCost(line({ catalogUnitCost: 3 }))).toBe(true);
    expect(lineHasCost(line({ catalogUnitCost: null }))).toBe(false);
    expect(lineHasCost(line({}))).toBe(false);
  });
});

describe("lineTotal / poTotal", () => {
  it("prices each line by the rule and sums them", () => {
    expect(lineTotal(line({ qtyOrdered: 3, catalogUnitCost: 4 }))).toBe(12);
    const po = {
      lines: [
        line({ qtyOrdered: 3, unitCost: 10, catalogUnitCost: 1 }), // 30 - line cost wins
        line({ qtyOrdered: 2, catalogUnitCost: 5.5 }),             // 11 - catalog fallback
        line({ qtyOrdered: 9 }),                                   // 0  - unpriced
      ],
    };
    expect(poTotal(po)).toBe(41);
  });

  it("an empty PO totals zero", () => {
    expect(poTotal({ lines: [] })).toBe(0);
  });
});
