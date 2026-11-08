/**
 * costModel.ts — the shared cost/margin model (D2/D8/D18, R3 2026-07-21).
 *
 * ONE model for all three entities: Estimate (R3, first consumer), then Job + Invoice (R3b),
 * replacing their prior item_type-based (MATERIAL/non-MATERIAL) cost split and costed-basis
 * margin. Deliberately simple, no exclusion rules: a line with no unit_cost contributes $0 to
 * item cost (not excluded from the ratio) — profit % is null only when revenue is 0.
 *
 *   itemCost   = Σ(quantity × unit_cost) over all line items, unit_cost null -> 0
 *              + Σ(scope.internal_cost) over scopes with a flat_price set, internal_cost null -> 0
 *   laborCost  = laborHours × org labor_rate (crew hours, NOT derived from any line's item_type)
 *   overheadAmount = overhead.mode === 'FIXED' ? overhead.value : revenueExclTax × (overhead.value / 100)
 *   totalCost  = itemCost + laborCost + overheadAmount
 *   profit     = revenueExclTax - totalCost, shown as both an amount and a percentage
 *   profitPct  = revenueExclTax > 0 ? round1(profit / revenueExclTax × 100) : null
 *
 * revenueExclTax is the estimate's subtotal AFTER its own discount but BEFORE tax (tax is the
 * state's, not the business's — Ran's 2026-07-20 ruling) — i.e. Estimate's `discountedSubtotal`
 * (subtotal - discount_amount), never total_amount.
 */

export type OverheadMode = 'PERCENTAGE' | 'FIXED';

export interface CostModelLineItem {
  quantity: number | string;
  unit_cost?: number | string | null;
}

export interface CostModelScope {
  flat_price: number | string | null | undefined;
  internal_cost?: number | string | null;
}

export interface OverheadConfig {
  mode: OverheadMode;
  value: number;
}

export interface CostSummary {
  itemCost: number;
  laborCost: number;
  overheadAmount: number;
  totalCost: number;
  profitAmount: number;
  /** null only when revenueExclTax is 0 — never reported as a fake 100%/0%. */
  profitPercent: number | null;
}

function toNum(v: number | string | null | undefined): number {
  if (v == null) return 0;
  return typeof v === 'number' ? v : Number(v);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function calculateCostSummary(
  lineItems: CostModelLineItem[],
  scopes: CostModelScope[],
  laborHours: number | string | null | undefined,
  laborRate: number | string | null | undefined,
  overhead: OverheadConfig,
  revenueExclTax: number,
): CostSummary {
  const itemLineCost = lineItems.reduce((sum, l) => sum + toNum(l.unit_cost) * toNum(l.quantity), 0);
  const scopeCost = scopes
    .filter((s) => s.flat_price != null)
    .reduce((sum, s) => sum + toNum(s.internal_cost), 0);
  const itemCost = Math.round((itemLineCost + scopeCost) * 100) / 100;

  const laborCost = Math.round(toNum(laborHours) * toNum(laborRate) * 100) / 100;

  const overheadAmount = Math.round(
    (overhead.mode === 'FIXED' ? overhead.value : revenueExclTax * (overhead.value / 100)) * 100,
  ) / 100;

  const totalCost = Math.round((itemCost + laborCost + overheadAmount) * 100) / 100;
  const profitAmount = Math.round((revenueExclTax - totalCost) * 100) / 100;
  const profitPercent = revenueExclTax > 0 ? round1((profitAmount / revenueExclTax) * 100) : null;

  return { itemCost, laborCost, overheadAmount, totalCost, profitAmount, profitPercent };
}

/**
 * Resolve the EFFECTIVE overhead config: the estimate's own override when BOTH overhead_mode and
 * overhead_value are set, else the org default — mirrors the backend's resolveDepositAmount /
 * the existing deposit_type/deposit_value override pattern exactly.
 */
export function resolveOverhead(
  entity: { overhead_mode?: OverheadMode | null; overhead_value?: number | string | null },
  org: { overhead_mode?: OverheadMode | null; overhead_value?: number | string | null } | null | undefined,
): OverheadConfig {
  const hasOverride = entity.overhead_mode != null && entity.overhead_value != null;
  const mode: OverheadMode = hasOverride ? (entity.overhead_mode as OverheadMode) : (org?.overhead_mode ?? 'PERCENTAGE');
  const value = hasOverride ? toNum(entity.overhead_value) : toNum(org?.overhead_value);
  return { mode, value };
}
