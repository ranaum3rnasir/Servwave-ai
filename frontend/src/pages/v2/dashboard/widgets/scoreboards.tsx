import type { ScoreboardEntry, LeadSource } from '@/lib/api/dashboard';
import { formatCurrencyWhole } from '@/lib/utils';
import { EmptyState } from '@/ui-kit/components/data/emptyState';

import { WidgetCard } from '../components/widgetCard';
import { ClickRow } from '../components/clickRow';
import { opener } from '@/lib/dashboard/opener';

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
  isLoading,
}: {
  title: string;
  icon: string;
  entries: ScoreboardEntry[];
  /** Set only when the server sent an address for the tile; without it the rows are drawn but not clickable. */
  onRowClick?: () => void;
  isLoading?: boolean;
}) {
  // A person without See company figures gets no revenue: the board is ranked by, and the bars drawn from, job count.
  const showsRevenue = entries.every((e) => e.revenue !== undefined);
  const measure = (e: ScoreboardEntry) => (showsRevenue ? (e.revenue ?? 0) : e.jobs);
  const max = Math.max(1, ...entries.map(measure));
  return (
    <WidgetCard
      title={`${icon} ${title}`}
      right={<span className="text-[11px] text-muted-foreground">14 days</span>}
      loading={isLoading}
    >
      {entries.length === 0 ? (
        <EmptyState title="No jobs to rank yet" />
      ) : (
        <div className="space-y-1.5 p-3">
          {entries.map((e, i) => (
            <ClickRow
              key={`${e.user_id}-${i}`}
              onClick={onRowClick}
              className="h-auto w-full justify-start gap-2.5 rounded-md px-1 py-1 font-normal"
            >
              <span className="w-[74px] shrink-0 truncate text-left text-[11px] font-semibold text-foreground">{e.name}</span>
              <span className="h-4 flex-1 overflow-hidden rounded bg-border-soft">
                <span
                  className="flex h-full items-center justify-end rounded bg-sage-700 pr-1.5 text-[9px] font-bold text-on-fill"
                  style={{ width: `${Math.max(18, (measure(e) / max) * 100)}%` }}
                >
                  {showsRevenue ? formatCurrencyWhole(e.revenue ?? 0) : null}
                </span>
              </span>
              <span className="w-12 shrink-0 text-right text-[10px] text-muted-foreground">
                {e.jobs} {e.jobs === 1 ? 'job' : 'jobs'}
              </span>
            </ClickRow>
          ))}
        </div>
      )}
    </WidgetCard>
  );
}

/**
 * Top lead sources.
 *
 * A row opens the address the server built for it: the Leads list filtered by the RAW source key (not the Title-Cased
 * label the server also sends), which is what that list's filter reads. The server sends none to a person who may not
 * open the Leads list, and the row is then drawn without a click.
 */
export function LeadSourcesWidget({
  sources,
  navigate,
  isLoading,
}: {
  sources: LeadSource[];
  navigate: (to: string) => void;
  isLoading?: boolean;
}) {
  return (
    <WidgetCard
      title="🌐 Top Lead Sources"
      right={<span className="text-[11px] text-muted-foreground">{sources.some((s) => s.revenue !== undefined) ? 'leads · revenue' : 'leads'}</span>}
      loading={isLoading}
    >
      {sources.length === 0 ? (
        <EmptyState title="No leads yet" />
      ) : (
        <div className="px-5 py-2">
          {sources.map((s) => (
            <ClickRow
              key={s.source}
              onClick={opener(s.link, navigate)}
              className="h-auto w-full justify-start gap-2 rounded-none border-b py-1.5 text-[11px] font-normal last:border-0"
            >
              <span className="flex-1 text-left font-semibold text-foreground">{s.label}</span>
              <span className="tabular-nums text-foreground">{s.lead_pct}%</span>
              {s.revenue !== undefined && (
                <span className="w-24 text-right text-[10px] tabular-nums text-muted-foreground">· {formatCurrencyWhole(s.revenue)}</span>
              )}
            </ClickRow>
          ))}
        </div>
      )}
    </WidgetCard>
  );
}
