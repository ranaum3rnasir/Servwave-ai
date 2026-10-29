import type { ScoreboardEntry, LeadSource } from '@/lib/api/dashboard';
import { formatCurrencyWhole } from '@/lib/utils';
import { Button } from '@/ui-kit/components/ui/button';

import { WidgetCard } from '../components/widgetCard';
import { preferV2Path } from '../../uiV2';

/**
 * A ranked revenue bar list - the tech and dispatch scoreboards.
 *
 * Bar maths carried over exactly: `max` is floored at 1, and each bar is
 * `max(18, revenue/max*100)` percent so the smallest earner still has room for
 * its own inset figure. The React key stays `${user_id}-${i}` because the
 * dispatch board can carry a null `user_id`.
 *
 * The `14 days` caption is COSMETIC and wrong - the server aggregates all
 * completed jobs with no date window. Reproduced as-is and logged in the
 * ledger rather than corrected here; changing it is a copy decision.
 */
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
      right={<span className="text-[11px] text-muted-foreground">14 days</span>}
    >
      <div className="space-y-1.5 p-3">
        {entries.map((e, i) => (
          <Button
            key={`${e.user_id}-${i}`}
            type="button"
            variant="ghost"
            size={null}
            onClick={() => onRowClick(e)}
            className="h-auto w-full justify-start gap-2.5 rounded-md px-1 py-1 font-normal"
          >
            <span className="w-[74px] shrink-0 truncate text-left text-[11px] font-semibold text-foreground">{e.name}</span>
            <span className="h-4 flex-1 overflow-hidden rounded bg-border-soft">
              <span
                className="flex h-full items-center justify-end rounded bg-sage-700 pr-1.5 text-[9px] font-bold text-on-fill"
                style={{ width: `${Math.max(18, (e.revenue / max) * 100)}%` }}
              >
                {formatCurrencyWhole(e.revenue)}
              </span>
            </span>
            <span className="w-12 shrink-0 text-right text-[10px] text-muted-foreground">
              {e.jobs} {e.jobs === 1 ? 'job' : 'jobs'}
            </span>
          </Button>
        ))}
      </div>
    </WidgetCard>
  );
}

/**
 * Top lead sources.
 *
 * The row navigates with the RAW source key, not the Title-Cased label the
 * server also sends, and not URL-encoded - `/leads?source=${s.source}`. That is
 * what the leads list filter reads, so it is reproduced character for
 * character.
 */
export function LeadSourcesWidget({
  sources,
  navigate,
}: {
  sources: LeadSource[];
  navigate: (to: string) => void;
}) {
  return (
    <WidgetCard
      title="🌐 Top Lead Sources"
      right={<span className="text-[11px] text-muted-foreground">leads · revenue</span>}
    >
      <div className="px-5 py-2">
        {sources.map((s) => (
          <Button
            key={s.source}
            type="button"
            variant="ghost"
            size={null}
            onClick={() => navigate(preferV2Path(`/leads?source=${s.source}`))}
            className="h-auto w-full justify-start gap-2 rounded-none border-b py-1.5 text-[11px] font-normal last:border-0"
          >
            <span className="flex-1 text-left font-semibold text-foreground">{s.label}</span>
            <span className="tabular-nums text-foreground">{s.lead_pct}%</span>
            <span className="w-24 text-right text-[10px] tabular-nums text-muted-foreground">· {formatCurrencyWhole(s.revenue)}</span>
          </Button>
        ))}
      </div>
    </WidgetCard>
  );
}
