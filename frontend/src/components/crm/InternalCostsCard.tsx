/**
 * InternalCostsCard — Card B, staff-only cost/margin breakdown shared by Estimate, Job and Invoice
 * (R3/R3b, 2026-07-21, D2/D8/D18's shared cost model — see `@/lib/costModel`). Pure presentational
 * + local draft state; the parent owns persistence (each entity has its own update endpoint/cache
 * shape) via `onCommitLaborHours`/`onCommitOverhead`. The parent also gates whether to render this
 * card at all on `canSeePricing` — this card does not re-check permissions itself.
 *
 * Rows: Item cost (line items + priced scopes) · Labor cost (hours × org rate, editable hours) ·
 * Overhead (org default or a live per-entity override — no "override" wording anywhere in this
 * UI, per Ran's ruling: the value is simply editable, and changing it silently becomes the
 * entity's own setting) · Total cost · Profit ($ and %) · an optional, visually-fenced-off
 * "Materials purchased (POs)" additive row (Job only, D15 PO actuals — never part of the roll-up).
 */
import { useState } from 'react';
import { Info } from 'lucide-react';
import { cn, formatCurrency } from '@/lib/utils';
import { SectionCard } from '@/components/jobs/overview/SectionCard';
import { Input } from '@/components/ui/input';
import { SelectField, type SelectFieldOption } from '@/components/form/SelectField';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { calculateCostSummary, resolveOverhead, type OverheadMode, type CostModelLineItem, type CostModelScope } from '@/lib/costModel';

export interface InternalCostsCardProps {
  lineItems: CostModelLineItem[];
  scopes: CostModelScope[];
  laborHours?: number | string | null;
  overheadMode?: OverheadMode | null;
  overheadValue?: number | string | null;
  /** subtotal AFTER discount, BEFORE tax — the revenue basis margin is computed against. */
  discountedSubtotal: number;
  orgLaborRate: number | string;
  orgOverheadMode: OverheadMode;
  orgOverheadValue: number | string;
  /** Lock policy from the page — same gate the entity's other editable-row cards use. */
  canEditNow: boolean;
  onCommitLaborHours: (hours: number | null) => void;
  onCommitOverhead: (mode: OverheadMode, value: number) => void;
  /**
   * D15 — actual material spend received on a job's linked purchase orders. ADDITIVE DISPLAY ROW
   * ONLY: never read by calculateCostSummary or the Item/Labor/Overhead/Total-cost rows above it —
   * the dashed divider is the visual contract that this row sits outside the roll-up. Job-only;
   * Estimate/Invoice never pass it. `null`/omitted hides the row.
   */
  materialsPurchased?: { amount: number; lineCount: number } | null;
}

/** Module-scope so the array identity is stable across renders. */
const OVERHEAD_MODE_OPTIONS: SelectFieldOption[] = [
  { value: 'PERCENTAGE', label: '%' },
  { value: 'FIXED', label: '$' },
];

export function InternalCostsCard({
  lineItems,
  scopes,
  laborHours,
  overheadMode,
  overheadValue,
  discountedSubtotal,
  orgLaborRate,
  orgOverheadMode,
  orgOverheadValue,
  canEditNow,
  onCommitLaborHours,
  onCommitOverhead,
  materialsPurchased,
}: InternalCostsCardProps) {
  const [laborHoursDraft, setLaborHoursDraft] = useState<string | null>(null);
  const [overheadValueDraft, setOverheadValueDraft] = useState<string | null>(null);

  const overhead = resolveOverhead(
    { overhead_mode: overheadMode, overhead_value: overheadValue },
    { overhead_mode: orgOverheadMode, overhead_value: orgOverheadValue },
  );
  const summary = calculateCostSummary(lineItems, scopes, laborHours, orgLaborRate, overhead, discountedSubtotal);

  const laborHoursDisplay = laborHoursDraft ?? (laborHours != null ? String(laborHours) : '');
  const overheadValueDisplay = overheadValueDraft ?? String(overhead.value);

  function commitLaborHours(raw: string) {
    setLaborHoursDraft(null);
    const trimmed = raw.trim();
    const hours = trimmed === '' ? null : Number(trimmed);
    if (hours !== null && (Number.isNaN(hours) || hours < 0)) return;
    if (hours === (laborHours != null ? Number(laborHours) : null)) return;
    onCommitLaborHours(hours);
  }

  function commitOverheadValue(raw: string) {
    setOverheadValueDraft(null);
    const trimmed = raw.trim();
    const value = trimmed === '' ? 0 : Number(trimmed);
    if (Number.isNaN(value) || value < 0) return;
    if (value === overhead.value) return;
    onCommitOverhead(overhead.mode, value);
  }

  function changeOverheadMode(mode: OverheadMode) {
    // Carry over an uncommitted typed value rather than discarding it silently on mode switch.
    const draftValue = overheadValueDraft != null ? Number(overheadValueDraft.trim()) : NaN;
    const value = !Number.isNaN(draftValue) && draftValue >= 0 ? draftValue : overhead.value;
    setOverheadValueDraft(null);
    if (mode === overhead.mode && value === overhead.value) return;
    onCommitOverhead(mode, value);
  }

  return (
    <SectionCard
      title="Internal costs"
      meta={<span className="text-[11px] font-medium text-text-secondary">Not shown to customer</span>}
    >
      <div className="flex flex-col">
        <div className="flex items-center justify-between py-1.5">
          <span className="text-sm text-text-secondary">Item cost</span>
          <span className="tabular-nums text-sm">{formatCurrency(summary.itemCost)}</span>
        </div>

        <div className="flex items-center justify-between py-1.5">
          <span className="text-sm text-text-secondary">
            Labor cost
            <span className="ml-1.5 text-xs font-normal text-text-secondary/70">
              · {formatCurrency(orgLaborRate)}/hr ×
            </span>
          </span>
          <div className="flex items-center gap-2">
            {canEditNow ? (
              <Input
                type="number"
                min={0}
                step="0.25"
                value={laborHoursDisplay}
                onChange={(e) => setLaborHoursDraft(e.target.value)}
                onBlur={(e) => commitLaborHours(e.target.value)}
                size="xs"
                className="h-7 w-20 text-right"
                aria-label="Labor hours"
                placeholder="0"
              />
            ) : (
              <span className="tabular-nums text-sm">{laborHours ?? 0}h</span>
            )}
            <span className="tabular-nums text-sm">{formatCurrency(summary.laborCost)}</span>
          </div>
        </div>

        <div className="flex items-center justify-between py-1.5">
          <span className="text-sm text-text-secondary">Overhead</span>
          <div className="flex items-center gap-2">
            {canEditNow ? (
              <>
                <SelectField
                  value={overhead.mode}
                  onValueChange={(v) => changeOverheadMode(v as OverheadMode)}
                  className="h-7 w-auto px-1 text-xs"
                  aria-label="Overhead mode"
                  options={OVERHEAD_MODE_OPTIONS}
                />
                <Input
                  type="number"
                  min={0}
                  step="0.1"
                  value={overheadValueDisplay}
                  onChange={(e) => setOverheadValueDraft(e.target.value)}
                  onBlur={(e) => commitOverheadValue(e.target.value)}
                  size="xs"
                  className="h-7 w-20 text-right"
                  aria-label="Overhead value"
                />
              </>
            ) : null}
            <span className="tabular-nums text-sm">{formatCurrency(summary.overheadAmount)}</span>
          </div>
        </div>

        <div className="mt-1 flex items-center justify-between border-t border-border pt-2.5">
          <span className="text-sm font-bold text-text-primary">Total cost</span>
          <span className="tabular-nums text-base font-extrabold text-text-primary">
            {formatCurrency(summary.totalCost)}
          </span>
        </div>

        <div className="mt-1 flex items-center justify-between border-t border-border pt-2.5">
          <span className="text-sm font-bold text-text-primary">Profit</span>
          <span
            className={cn(
              'tabular-nums text-base font-extrabold',
              summary.profitPercent == null ? 'text-text-secondary' : summary.profitPercent >= 0 ? 'text-sage-700' : 'text-danger',
            )}
          >
            {summary.profitPercent == null ? '—' : `${formatCurrency(summary.profitAmount)} (${summary.profitPercent}%)`}
          </span>
        </div>
        {summary.profitPercent != null && (
          <p className="mt-1 text-[10.5px] text-text-secondary">
            Revenue {formatCurrency(discountedSubtotal)} (excl. tax) − total cost {formatCurrency(summary.totalCost)}.
          </p>
        )}

        {/* D15 — PO actuals, visually fenced off from the roll-up above. Zero-amount with
            lineCount > 0 still renders (a received-at-$0 PO is information); the parent passes
            null when lineCount === 0. */}
        {materialsPurchased != null && (
          <div className="mt-2 border-t border-dashed border-border pt-2">
            <div className="flex items-center justify-between py-1">
              <span className="inline-flex items-center gap-1 text-sm text-text-secondary">
                Materials purchased (POs)
                <TooltipProvider delayDuration={150}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        role="img"
                        aria-label="About materials purchased"
                        tabIndex={0}
                        className="inline-flex cursor-help"
                      >
                        <Info className="h-3.5 w-3.5 text-text-secondary" />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-[260px]">
                      Actual material spend received on this job&apos;s linked purchase orders.
                      Reference only — the profit above is computed from labor hours and overhead,
                      not PO actuals.
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </span>
              <span className="tabular-nums text-sm">{formatCurrency(materialsPurchased.amount)}</span>
            </div>
            <p className="text-[10.5px] text-text-secondary">
              {materialsPurchased.lineCount} received PO line
              {materialsPurchased.lineCount === 1 ? '' : 's'} · actuals, not in profit
            </p>
          </div>
        )}
      </div>
    </SectionCard>
  );
}
