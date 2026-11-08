import { Filter } from 'lucide-react';
import type { PipelineStage } from '@/lib/api/dashboard';
import { WidgetCard, money0 } from './_shared';

export default function PipelineFunnel({
  stages,
  navigate,
}: {
  stages: PipelineStage[];
  navigate: (to: string) => void;
}) {
  const maxAmt = Math.max(1, ...stages.filter((s) => s.kind === 'amount').map((s) => s.value));
  return (
    <WidgetCard title="Revenue Pipeline" icon={<Filter className="h-4 w-4 text-text-secondary" />} right={<span className="text-[11px] text-text-secondary">where $ is flowing</span>}>
      <div className="p-4 space-y-1.5">
        {stages.map((s) => {
          const pct = s.kind === 'amount' ? Math.max(8, (s.value / maxAmt) * 100) : 100;
          return (
            // Full-width list-row click target (stage label + progress bar + amount), not a
            // Button-shaped control - left raw per the program's non-Button-shape carve-out.
            <button
              key={s.key}
              type="button"
              onClick={() => navigate(s.link)}
              className="flex items-center gap-2.5 w-full text-left hover:bg-background-light rounded-md px-1 py-0.5 transition-colors"
            >
              <span className="w-16 shrink-0 text-[11px] font-semibold text-text-secondary">{s.label}</span>
              <span className="flex-1 h-[18px] rounded bg-border-soft overflow-hidden">
                <span className="block h-full rounded bg-gradient-to-r from-sage-500 to-sage-700" style={{ width: `${pct}%` }} />
              </span>
              <span className="w-14 text-right text-[11px] font-bold tabular-nums text-text-primary">
                {s.kind === 'amount' ? money0(s.value) : s.value}
              </span>
            </button>
          );
        })}
      </div>
    </WidgetCard>
  );
}
