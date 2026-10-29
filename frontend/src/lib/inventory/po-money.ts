// The ONE money rule for purchase orders (Purchasing Audit Verdict PR 3, S3.2).
//
// A line is priced by its own unit cost, else by the linked catalog item's unit
// cost, else $0 - exactly what the backend's job material-cost roll-up does
// (getJobMaterialCost). Every PO total on screen - grid column, CSV, detail
// dialog, print preview, vendor spend - goes through here, so the same PO can
// never show two numbers.
import type { POLine, PurchaseOrder } from "@/lib/api/inventory";

type PricedLine = Pick<POLine, "qtyOrdered" | "unitCost" | "catalogUnitCost">;

/** True when the line carries a real price from either source. Rows without one
 *  render "—" rather than a fake $0, while the aggregates still count them as $0. */
export function lineHasCost(line: Pick<POLine, "unitCost" | "catalogUnitCost">): boolean {
  return line.unitCost != null || line.catalogUnitCost != null;
}

/** unitCost → catalogUnitCost → 0. */
export function lineUnitCost(line: Pick<POLine, "unitCost" | "catalogUnitCost">): number {
  return line.unitCost ?? line.catalogUnitCost ?? 0;
}

/** qtyOrdered × lineUnitCost. */
export function lineTotal(line: PricedLine): number {
  return line.qtyOrdered * lineUnitCost(line);
}

/** Σ lineTotal over the PO's lines. Tax-exclusive (D6): subtotal and total agree. */
export function poTotal(po: Pick<PurchaseOrder, "lines">): number {
  return po.lines.reduce((sum, l) => sum + lineTotal(l), 0);
}
