import { X } from 'lucide-react';

import { formatCurrency } from '@/lib/utils';
import { token } from '@/design-system/tokens';
import type { Division, UserActivity } from '@/lib/reports/activity-logic';
import {
  BAND_TEXT, METRIC_META, bandFill, companyRows, fmtDuration, leaderboard, pctDelta, responseBand, slaBand,
  type BreakdownSource, type MetricKey,
} from '@/lib/reports/activity-logic';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { Button } from '@/ui-kit/components/ui/button';
import { Card } from '@/ui-kit/components/ui/card';
import { cn } from '@/ui-kit/lib/utils';

import { ReportHeading } from './heading';

/**
 * The breakdown that opens when a KPI card is pressed.
 *
 * Ranks the current scope by the chosen metric - divisions at company level,
 * people at division level - and draws a compact bar list so you can see who
 * drives, or drags, that number.
 *
 * THE FIVE METRICS EACH HAVE THEIR OWN RULES and all of them are carried over:
 *   revenue / conversions filter to REVENUE-BEARING scopes only, because a
 *   support division has no revenue to rank; response drops scopes with no
 *   measured response (`> 0`) rather than sorting them as instant; response and
 *   sla sort so BETTER IS FIRST in each direction (response ascending, sla
 *   descending); and only revenue shows a period-over-period delta.
 *
 * THE BAR COLOURS ARE A SEVERITY READING, not decoration - `bandFill` for the
 * response and SLA bands, and fixed semantic tokens for the rest - so they stay
 * inline fills rather than kit variants. `METRIC_META` supplies the title and
 * hint, so the panel can never describe a different metric than it ranks.
 */

/** Build the ranking sources for the current level from the filtered users. */
function sourcesFor(
  level: 'company' | 'division',
  users: UserActivity[],
  divisions: Division[],
  divisionId?: string,
): BreakdownSource[] {
  if (level === 'company') {
    return companyRows(divisions, users).map((r) => ({
      id: r.division.id,
      label: `${r.division.icon} ${r.division.name}`,
      sub: `${r.activePeople} active`,
      revenueBearing: r.division.revenueBearing,
      revenueTouched: r.revenueTouched,
      prevRevenueTouched: r.prevRevenueTouched,
      conversions: r.conversions,
      leads: r.leads,
      convRatePct: r.convRatePct,
      avgResponseSec: r.avgResponseSec,
      slaMetPct: r.slaMetPct,
      activePeople: r.activePeople,
    }));
  }
  const division = divisions.find((d) => d.id === divisionId);
  const revenueBearing = division?.revenueBearing ?? true;
  return leaderboard(users, divisionId).map((u) => ({
    id: u.id,
    label: u.name,
    sub: u.role,
    revenueBearing,
    revenueTouched: u.revenueTouched,
    prevRevenueTouched: u.prevRevenueTouched,
    conversions: u.conversions,
    leads: u.leads,
    convRatePct: u.leads ? Math.round((u.conversions / u.leads) * 100) : 0,
    avgResponseSec: u.responseSec,
    slaMetPct: u.slaMetPct,
    activePeople: u.active ? 1 : 0,
  }));
}

interface RankRow {
  id: string;
  label: string;
  sub: string;
  value: string;
  delta?: number | null;
  raw: number; // bar magnitude (>= 0)
  color: string;
}

/** Project sources onto one metric -> sorted, formatted rows + a footer summary. */
function rank(metric: MetricKey, sources: BreakdownSource[]): { rows: RankRow[]; summary: string } {
  switch (metric) {
    case 'revenue': {
      const rev = sources.filter((s) => s.revenueBearing);
      const max = Math.max(...rev.map((s) => s.revenueTouched), 1);
      const sum = rev.reduce((a, s) => a + s.revenueTouched, 0);
      return {
        summary: `${formatCurrency(sum)} across ${rev.length} ${rev.length === 1 ? 'scope' : 'scopes'}`,
        rows: rev
          .slice()
          .sort((a, b) => b.revenueTouched - a.revenueTouched)
          .map((s) => ({
            id: s.id,
            label: s.label,
            sub: s.sub,
            value: formatCurrency(s.revenueTouched),
            delta: pctDelta(s.revenueTouched, s.prevRevenueTouched),
            raw: s.revenueTouched / max,
            color: token('--success-strong'),
          })),
      };
    }
    case 'conversions': {
      const rev = sources.filter((s) => s.revenueBearing);
      const max = Math.max(...rev.map((s) => s.conversions), 1);
      const sumC = rev.reduce((a, s) => a + s.conversions, 0);
      const sumL = rev.reduce((a, s) => a + s.leads, 0);
      return {
        summary: `${sumC} of ${sumL} leads · ${sumL ? Math.round((sumC / sumL) * 100) : 0}% conv. rate`,
        rows: rev
          .slice()
          .sort((a, b) => b.conversions - a.conversions)
          .map((s) => ({
            id: s.id,
            label: s.label,
            sub: `${s.convRatePct}% of ${s.leads} leads`,
            value: `${s.conversions}`,
            raw: s.conversions / max,
            color: token('--ai-strong'),
          })),
      };
    }
    case 'response': {
      const live = sources.filter((s) => s.avgResponseSec > 0);
      const max = Math.max(...live.map((s) => s.avgResponseSec), 1);
      return {
        summary: 'Lower is better - green = within SLA',
        rows: live
          .slice()
          .sort((a, b) => a.avgResponseSec - b.avgResponseSec)
          .map((s) => ({
            id: s.id,
            label: s.label,
            sub: s.sub,
            value: fmtDuration(s.avgResponseSec),
            raw: s.avgResponseSec / max,
            color: bandFill(responseBand(s.avgResponseSec)),
          })),
      };
    }
    case 'sla': {
      return {
        summary: 'Share of responses within the SLA target',
        rows: sources
          .slice()
          .sort((a, b) => b.slaMetPct - a.slaMetPct)
          .map((s) => ({
            id: s.id,
            label: s.label,
            sub: s.sub,
            value: `${s.slaMetPct}%`,
            raw: s.slaMetPct / 100,
            color: bandFill(slaBand(s.slaMetPct)),
          })),
      };
    }
    case 'people': {
      const max = Math.max(...sources.map((s) => s.activePeople), 1);
      const sum = sources.reduce((a, s) => a + s.activePeople, 0);
      return {
        summary: `${sum} active across all scopes`,
        rows: sources
          .slice()
          .sort((a, b) => b.activePeople - a.activePeople)
          .map((s) => ({
            id: s.id,
            label: s.label,
            sub: s.sub,
            value: `${s.activePeople}`,
            raw: s.activePeople / max,
            color: token('--neutral-strong'),
          })),
      };
    }
  }
}


interface Props {
  metric: MetricKey;
  level: 'company' | 'division';
  users: UserActivity[];
  divisions: Division[];
  divisionId?: string;
  onClose: () => void;
}

export function MetricDetailPanel({ metric, level, users, divisions, divisionId, onClose }: Props) {
  const meta = METRIC_META[metric];
  const sources = sourcesFor(level, users, divisions, divisionId);
  const { rows, summary } = rank(metric, sources);

  return (
    <Card>
      <div className="mb-1 flex items-start justify-between">
        <div>
          <ReportHeading level={2} scale="lg">{meta.title} - breakdown</ReportHeading>
          <p className="text-muted-foreground text-xs">{meta.hint}</p>
        </div>
        <Button type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close breakdown">
          <X />
        </Button>
      </div>
      <p className="text-muted-foreground mb-3 text-xs font-medium">{summary}</p>

      {rows.length === 0 ? (
        <EmptyState title="No data for this selection." />
      ) : (
        <div className="space-y-2.5">
          {rows.map((r) => (
            <div key={r.id} className="flex items-center gap-3">
              <div className="w-40 shrink-0 truncate">
                <div className="truncate text-sm font-medium">{r.label}</div>
                <div className="text-muted-foreground truncate text-[11px]">{r.sub}</div>
              </div>
              {/* Bar fill is the band reading - inline, never a kit variant. */}
              <div className="bg-muted h-2.5 flex-1 overflow-hidden rounded-full">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${Math.max(r.raw * 100, 2)}%`, backgroundColor: r.color }}
                />
              </div>
              <div className="flex w-28 shrink-0 items-baseline justify-end gap-1.5">
                <span className="text-sm font-semibold tabular-nums">{r.value}</span>
                {r.delta != null && Math.abs(r.delta) >= 0.5 && (
                  <span className={cn('text-[11px] font-medium', r.delta >= 0 ? BAND_TEXT.good : BAND_TEXT.bad)}>
                    {r.delta >= 0 ? '▲' : '▼'}
                    {Math.abs(r.delta).toFixed(0)}%
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
