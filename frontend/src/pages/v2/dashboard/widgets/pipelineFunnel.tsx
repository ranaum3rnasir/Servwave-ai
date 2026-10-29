import { Filter } from 'lucide-react';

import type { PipelineStage } from '@/lib/api/dashboard';
import { formatCurrencyWhole } from '@/lib/utils';
import { Button } from '@/ui-kit/components/ui/button';

import { WidgetCard } from '../components/widgetCard';

/**
 * The revenue funnel - plain divs and a gradient, NOT a chart library, despite
 * the name. That matters here: the bar is a presentation of a number, so the
 * width maths is the behaviour and is carried over exactly.
 *
 *   maxAmt is the largest AMOUNT stage, floored at 1 so an all-zero pipeline
 *   cannot divide by zero;
 *   an amount row is `max(8, value/maxAmt*100)` percent wide, so a tiny but
 *   non-zero stage still reads as present;
 *   a COUNT row (Leads) is always 100 percent - it is not on the money scale
 *   and rendering it against maxAmt would be meaningless.
 *
 * Stage links come from the server (`dashboard-metrics.ts`), including the two
 * that carry a query string, and are used as given.
 */
export default function PipelineFunnel({
  stages,
  navigate,
}: {
  stages: PipelineStage[];
  navigate: (to: string) => void;
}) {
  const maxAmt = Math.max(1, ...stages.filter((s) => s.kind === 'amount').map((s) => s.value));
  return (
    <WidgetCard
      title="Revenue Pipeline"
      icon={<Filter className="h-4 w-4 text-muted-foreground" />}
      right={<span className="text-[11px] text-muted-foreground">where $ is flowing</span>}
    >
      <div className="space-y-1.5 p-4">
        {stages.map((s) => {
          const pct = s.kind === 'amount' ? Math.max(8, (s.value / maxAmt) * 100) : 100;
          return (
            <Button
              key={s.key}
              type="button"
              variant="ghost"
              size={null}
              onClick={() => navigate(s.link)}
              className="h-auto w-full justify-start gap-2.5 rounded-md px-1 py-0.5 text-left font-normal"
            >
              <span className="w-16 shrink-0 text-[11px] font-semibold text-muted-foreground">{s.label}</span>
              <span className="h-[18px] flex-1 overflow-hidden rounded bg-border-soft">
                <span className="block h-full rounded bg-gradient-to-r from-sage-500 to-sage-700" style={{ width: `${pct}%` }} />
              </span>
              <span className="w-14 text-right text-[11px] font-bold tabular-nums text-foreground">
                {s.kind === 'amount' ? formatCurrencyWhole(s.value) : s.value}
              </span>
            </Button>
          );
        })}
      </div>
    </WidgetCard>
  );
}
