import type { ScoreboardEntry, LeadSource } from '@/lib/api/dashboard';
import { WidgetCard, money0 } from './_shared';

export function RankedBarList({
  title,
  icon,
  entries,
  onRowClick,
}: {
  title: string;
  icon: string;
  entries: ScoreboardEntry[];
  onRowClick: (e: ScoreboardEntry) => void;
}) {
  const max = Math.max(1, ...entries.map((e) => e.revenue));
  return (
    <WidgetCard
      title={`${icon} ${title}`}
      right={<span className="text-[11px] text-text-secondary">14 days</span>}
    >
      <div className="p-3 space-y-1.5">
        {entries.map((e, i) => (
          // Full-width list-row click target (name + revenue bar + job count), not a
          // Button-shaped control - left raw per the program's non-Button-shape carve-out.
          <button
            key={`${e.user_id}-${i}`}
            type="button"
            onClick={() => onRowClick(e)}
            className="flex items-center gap-2.5 w-full hover:bg-background-light rounded-md px-1 py-1 transition-colors"
          >
            <span className="w-[74px] shrink-0 text-left text-[11px] font-semibold text-text-primary truncate">{e.name}</span>
            <span className="flex-1 h-4 rounded bg-border-soft overflow-hidden">
              <span
                className="h-full flex items-center justify-end pr-1.5 rounded bg-sage-700 text-[9px] font-bold text-on-fill"
                style={{ width: `${Math.max(18, (e.revenue / max) * 100)}%` }}
              >
                {money0(e.revenue)}
              </span>
            </span>
            <span className="w-12 shrink-0 text-right text-[10px] text-text-secondary">
              {e.jobs} {e.jobs === 1 ? 'job' : 'jobs'}
            </span>
          </button>
        ))}
      </div>
    </WidgetCard>
  );
}

export function LeadSourcesWidget({
  sources,
  navigate,
}: {
  sources: LeadSource[];
  navigate: (to: string) => void;
}) {
  return (
    <WidgetCard title="🌐 Top Lead Sources" right={<span className="text-[11px] text-text-secondary">leads · revenue</span>}>
      <div className="px-5 py-2">
        {sources.map((s) => (
          // Full-width list-row click target (label + lead % + revenue), not a Button-shaped
          // control - left raw per the program's non-Button-shape carve-out.
          <button
            key={s.source}
            type="button"
            onClick={() => navigate(`/leads?source=${s.source}`)}
            className="flex items-center gap-2 w-full py-1.5 text-[11px] border-b border-border-soft last:border-0 hover:bg-background-light transition-colors"
          >
            <span className="flex-1 text-left font-semibold text-text-primary">{s.label}</span>
            <span className="text-text-primary tabular-nums">{s.lead_pct}%</span>
            <span className="text-text-secondary text-[10px] w-24 text-right tabular-nums">· {money0(s.revenue)}</span>
          </button>
        ))}
      </div>
    </WidgetCard>
  );
}
