/**
 * MetricDetailPanel — the breakdown that opens when a KPI card is pressed.
 *
 * Given the currently-filtered person set, it ranks the scope (divisions at
 * company level, people at division level) by the chosen metric and renders a
 * compact bar list so you can see who drives — or drags — that number.
 */
import { X } from 'lucide-react';
import { EmptyState } from '@/components/ui/empty-state';
import { Heading } from '@/components/ui/heading';
import { formatCurrency } from '@/lib/utils';
import { token } from '@/design-system/tokens';
import type { Division, UserActivity } from '@/lib/reports/activity-logic';
import {
  type MetricKey,
  type BreakdownSource,
  METRIC_META,
  bandFill,
  BAND_TEXT,
  fmtDuration,
  slaBand,
  responseBand,
  pctDelta,
  companyRows,
  leaderboard,
} from '@/lib/reports/activity-logic';

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

/** Project sources onto one metric → sorted, formatted rows + a footer summary. */
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
        summary: 'Lower is better — green = within SLA',
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
    <div className="rounded-xl border border-primary/30 bg-surface-light p-5 shadow-card ring-1 ring-primary/10">
      <div className="mb-1 flex items-start justify-between">
        <div>
          <Heading level={2}>{meta.title} — breakdown</Heading>
          <p className="text-xs text-text-secondary">{meta.hint}</p>
        </div>
        {/* Small close-X affordance, not Button-shaped - left raw. */}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close breakdown"
          className="rounded-lg p-1 text-text-secondary hover:bg-background-light hover:text-text-primary"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <p className="mb-3 text-xs font-medium text-text-secondary">{summary}</p>

      {rows.length === 0 ? (
        <EmptyState density="compact" title="No data for this selection." />
      ) : (
        <div className="space-y-2.5">
          {rows.map((r) => (
            <div key={r.id} className="flex items-center gap-3">
              <div className="w-40 shrink-0 truncate">
                <div className="truncate text-sm font-medium text-text-primary">{r.label}</div>
                <div className="truncate text-[11px] text-text-secondary">{r.sub}</div>
              </div>
              <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-background-light">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${Math.max(r.raw * 100, 2)}%`, backgroundColor: r.color }}
                />
              </div>
              <div className="flex w-28 shrink-0 items-baseline justify-end gap-1.5">
                <span className="text-sm font-semibold tabular-nums text-text-primary">{r.value}</span>
                {r.delta != null && Math.abs(r.delta) >= 0.5 && (
                  <span className={`text-[11px] font-medium ${r.delta >= 0 ? BAND_TEXT.good : BAND_TEXT.bad}`}>
                    {r.delta >= 0 ? '▲' : '▼'}
                    {Math.abs(r.delta).toFixed(0)}%
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
