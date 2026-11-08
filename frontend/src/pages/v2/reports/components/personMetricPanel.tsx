import { X } from 'lucide-react';

import type { PersonMetricKey, UserActivity } from '@/lib/reports/activity-logic';
import { bandFill, personDetail } from '@/lib/reports/activity-logic';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { Button } from '@/ui-kit/components/ui/button';
import { Card } from '@/ui-kit/components/ui/card';

import { ReportHeading } from './heading';

/**
 * The record list that opens when an Individual-scorecard KPI card is pressed
 * (e.g. "$ Touched" -> the converted jobs, "Response time" -> the per-day
 * responses).
 *
 * Every row - title, hint, summary and the list itself - comes from
 * `personDetail(user, metric)` in `activity-logic`. This component only draws
 * it, so a new metric key needs no change here. `bandFill` colours the leading
 * dot when a row carries a band, and that dot is the row's severity reading, so
 * it stays an inline fill.
 */

interface Props {
  user: UserActivity;
  metric: PersonMetricKey;
  onClose: () => void;
}

export function PersonMetricPanel({ user, metric, onClose }: Props) {
  const { title, hint, summary, rows } = personDetail(user, metric);

  return (
    <Card>
      <div className="mb-1 flex items-start justify-between">
        <div>
          <ReportHeading level={2} scale="lg">
            {title} - {user.name.split(' ')[0]}
          </ReportHeading>
          <p className="text-muted-foreground text-xs">{hint}</p>
        </div>
        <Button type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close detail">
          <X />
        </Button>
      </div>
      <p className="text-muted-foreground mb-3 text-xs font-medium">{summary}</p>

      {rows.length === 0 ? (
        <EmptyState title="No records for this card." />
      ) : (
        <div className="max-h-80 divide-y overflow-y-auto rounded-lg border">
          {rows.map((r) => (
            <div key={r.id} className="hover:bg-muted flex items-center gap-3 px-3 py-2">
              {r.band && (
                <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: bandFill(r.band) }} />
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{r.label}</div>
                {r.sub && <div className="text-muted-foreground truncate text-[11px]">{r.sub}</div>}
              </div>
              <div className="shrink-0 text-right">
                <div className="text-sm font-semibold tabular-nums">{r.value}</div>
                {r.value2 && <div className="text-muted-foreground text-[11px] tabular-nums">{r.value2}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
