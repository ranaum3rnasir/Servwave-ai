/**
 * Shared stock-warning / shortage helpers for the line editors.
 *
 * Relocated out of `components/inventory/SyncStockDialog.tsx` (spec §14 M2) so the Logistic
 * Orders work can delete SyncStockDialog later (LO-4) without breaking the Job / Invoice line
 * editors that still surface warn-mode over-draws and block-mode shortages. These are pure
 * response-shape parsers + one toast — no React, no dialog. SyncStockDialog now imports
 * `SyncStockShortage` from here.
 *
 * NB — the LO verbs raise a DIFFERENT, aggregate shortage (`details[]`, one entry per short
 * line); `extractShortage` only understands the single-line job/invoice shape. The LO picker /
 * editor parses the aggregate form via `extractLoError` in `lib/api/logisticOrders.ts`.
 */
import { toast } from '@/components/ui/use-toast';

export interface SyncStockShortage {
  location_name?: string;
  available: number;
  requested: number;
}

/**
 * Pull the 409 SHORTAGE payload out of a failed sync/add mutation, tolerating both the
 * wrapped `details` shape and the flat one. Returns null for any other error (callers
 * fall through to their generic error toast).
 */
export function extractShortage(err: unknown): SyncStockShortage | null {
  const response = (err as { response?: { status?: number; data?: Record<string, unknown> } })?.response;
  if (response?.status !== 409 || response.data?.error !== 'SHORTAGE') return null;
  const d = (response.data.details as Record<string, unknown> | undefined) ?? response.data;
  return {
    location_name: typeof d.location_name === 'string' ? d.location_name : undefined,
    available: Number(d.available ?? 0),
    requested: Number(d.requested ?? 0),
  };
}

/** Bulk sync result rows (§2.3): per-line statuses → "3 synced · 1 skipped" summary. */
export function summarizeSyncResults(results: unknown): string | null {
  if (!Array.isArray(results)) return null;
  const count = (status: string) =>
    (results as { status?: string }[]).filter((r) => r.status === status).length;
  const parts = [
    `${count('synced')} synced`,
    ...(count('skipped') > 0 ? [`${count('skipped')} skipped`] : []),
    ...(count('shortage') > 0 ? [`${count('shortage')} shortage`] : []),
  ];
  return parts.join(' · ');
}

/**
 * §2g — warn-mode surfacing. Call with any 2xx mutation response (line add / sync / qty
 * edit / bulk); toasts once when the deduction over-drew (org allows negatives). Handles
 * the `stock_warning` object, bulk `stock_warnings`, the `stock: { shortage: true,
 * on_hand_after }` result shape, and bulk `results[]` entries flagged `shortage: true`.
 * Default toast variant on purpose — this is a warning, not an error (no `warning`
 * variant exists in the toast system).
 */
export function toastStockWarning(data: unknown, label = 'This line'): void {
  if (!data || typeof data !== 'object') return;
  const d = data as Record<string, unknown>;
  const warnings: Record<string, unknown>[] = [];
  if (d.stock_warning && typeof d.stock_warning === 'object') {
    warnings.push(d.stock_warning as Record<string, unknown>);
  }
  if (Array.isArray(d.stock_warnings)) {
    warnings.push(...(d.stock_warnings as Record<string, unknown>[]));
  }
  const stock = d.stock as Record<string, unknown> | undefined;
  if (warnings.length === 0 && stock && stock.shortage === true) warnings.push(stock);
  if (warnings.length === 0 && Array.isArray(d.results)) {
    for (const r of d.results as Record<string, unknown>[]) {
      if (r.shortage === true) {
        warnings.push(r);
        break;
      }
    }
  }
  const w = warnings[0];
  if (!w) return;
  const location =
    typeof w.location_name === 'string' && w.location_name ? w.location_name : 'this location';
  const after = w.on_hand_after != null ? String(w.on_hand_after) : 'below zero';
  toast({
    title: 'Stock went negative',
    description: `${label} exceeded on-hand at ${location} — ${after} on hand after deduction.`,
  });
}
