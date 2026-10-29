/**
 * EstimateInternalCostsCard — thin Estimate-flavored wrapper around the shared
 * `@/components/crm/InternalCostsCard` (R3/R3b, 2026-07-21, D2/D8/D18's shared cost model —
 * see `@/lib/costModel`). Owns Estimate's own persistence: labor hours and overhead edits persist
 * via the SAME whole-document PATCH `EstimateReceiptCard` uses for discount/tax/deposit
 * (estimate-row fields, not line/scope rows). The parent gates whether to render this card at all
 * on `canSeePricing` — this card does not re-check permissions itself.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { extractApiError } from '@/lib/utils';
import { toast } from '@/components/ui/use-toast';
import { updateEstimate } from '@/lib/api/estimates';
import { InternalCostsCard } from '@/components/crm/InternalCostsCard';
import type { OverheadMode, CostModelLineItem, CostModelScope } from '@/lib/costModel';

export interface EstimateInternalCostsCardEstimate {
  id: string;
  line_items?: CostModelLineItem[];
  scopes?: CostModelScope[];
  labor_hours?: number | string | null;
  overhead_mode?: OverheadMode | null;
  overhead_value?: number | string | null;
  /** subtotal AFTER discount, BEFORE tax — the revenue basis margin is computed against. */
  discountedSubtotal: number;
}

export interface EstimateInternalCostsCardProps {
  estimate: EstimateInternalCostsCardEstimate;
  orgLaborRate: number | string;
  orgOverheadMode: OverheadMode;
  orgOverheadValue: number | string;
  /** §A1/A3 lock policy from the page — same gate EstimateReceiptCard's canEditNow uses. */
  canEditNow: boolean;
}

export function EstimateInternalCostsCard({
  estimate,
  orgLaborRate,
  orgOverheadMode,
  orgOverheadValue,
  canEditNow,
}: EstimateInternalCostsCardProps) {
  const queryClient = useQueryClient();

  const saveMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) => updateEstimate(estimate.id, body),
    onSuccess: (res) => {
      // SRVW-103 - merge, never replace: the response has no `tags` key (see
      // EstimateLineItemsEditor's docblock for the full contract).
      if (res?.estimate) {
        queryClient.setQueryData<Record<string, unknown>>(['estimate', estimate.id], (old) => ({
          ...(old ?? {}),
          ...(res.estimate as Record<string, unknown>),
        }));
      }
    },
    onError: (err: unknown) =>
      toast({ title: 'Could not save', description: extractApiError(err, 'Your change was not saved.'), variant: 'destructive' }),
  });

  return (
    <InternalCostsCard
      lineItems={estimate.line_items ?? []}
      scopes={estimate.scopes ?? []}
      laborHours={estimate.labor_hours}
      overheadMode={estimate.overhead_mode}
      overheadValue={estimate.overhead_value}
      discountedSubtotal={estimate.discountedSubtotal}
      orgLaborRate={orgLaborRate}
      orgOverheadMode={orgOverheadMode}
      orgOverheadValue={orgOverheadValue}
      canEditNow={canEditNow}
      onCommitLaborHours={(hours) => saveMutation.mutate({ labor_hours: hours })}
      onCommitOverhead={(mode, value) => saveMutation.mutate({ overhead_mode: mode, overhead_value: value })}
    />
  );
}
