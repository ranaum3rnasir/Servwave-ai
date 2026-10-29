import type { TrainingImpactResult, TrainingImpactRow } from '@/lib/reports/communication-tracking-logic';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Card } from '@/ui-kit/components/ui/card';
import { cn } from '@/ui-kit/lib/utils';

import { ReportHeading } from '../../components/heading';
import { ReportTable } from '../../components/reportTable';

/**
 * Training impact tab - adherence before vs after a training completion.
 *
 * `noData` is the guard that matters and it is unchanged: a rep with no
 * interactions on either side of the training window shows "-" and "Not enough
 * data" rather than a delta computed from nothing, and it sorts as null so
 * those rows never rank as if they were zeros.
 *
 * The improvement direction keeps its colour (up green, down red) - that is the
 * whole reading of the tab.
 */

const ROLE_LABEL: Record<string, string> = {
  csr: 'Office / CSR',
  sales: 'Sales',
  dispatch: 'Dispatch',
  tech: 'Field tech',
};

const noData = (r: TrainingImpactRow) => r.beforeN === 0 || r.afterN === 0;

export function TrainingImpactTab({ training }: { training: TrainingImpactResult }) {
  return (
    <div className="space-y-6">
      <Card>
        <ReportHeading level={3}>Average adherence change after training</ReportHeading>
        <div
          className={cn(
            'mt-3 text-4xl font-semibold tabular-nums',
            training.avgDelta >= 0 ? 'text-status-green-emphasis' : 'text-status-red-emphasis',
          )}
        >
          {training.avgDelta >= 0 ? '+' : ''}{training.avgDelta}
        </div>
        <p className="text-muted-foreground mt-1 text-xs">
          Mean of (after minus before) adherence across trained reps, plus or minus a 14-day window.
        </p>
      </Card>

      <div className="space-y-2">
        <ReportHeading level={3}>Before vs after, by rep</ReportHeading>
        <ReportTable
          rows={training.rows}
          getRowKey={(r) => `${r.repId}-${r.completedAt}`}
          empty={<EmptyState title="No training completions in range." />}
          columns={[
            { id: 'rep', header: 'Rep', width: 170, min: 150, sortValue: (r) => r.repName, cell: (r) => <span className="font-medium">{r.repName}</span> },
            { id: 'role', header: 'Role', width: 140, min: 120, sortValue: (r) => ROLE_LABEL[r.role] ?? r.role, cell: (r) => <span className="text-muted-foreground">{ROLE_LABEL[r.role] ?? r.role}</span> },
            { id: 'scenario', header: 'Scenario', width: 200, min: 160, sortValue: (r) => r.scenarioTitle, cell: (r) => <span className="text-muted-foreground">{r.scenarioTitle}</span> },
            {
              id: 'before', header: 'Before', width: 110, min: 100, align: 'right',
              sortValue: (r) => (noData(r) ? null : r.before),
              cell: (r) => <span className="text-muted-foreground tabular-nums">{noData(r) ? '-' : `${r.before} (${r.beforeN})`}</span>,
            },
            {
              id: 'after', header: 'After', width: 110, min: 100, align: 'right',
              sortValue: (r) => (noData(r) ? null : r.after),
              cell: (r) => <span className="text-muted-foreground tabular-nums">{noData(r) ? '-' : `${r.after} (${r.afterN})`}</span>,
            },
            {
              id: 'delta', header: 'Delta', width: 100, min: 90, align: 'right',
              sortValue: (r) => (noData(r) ? null : r.delta),
              cell: (r) =>
                noData(r) ? (
                  <span className="text-muted-foreground tabular-nums">-</span>
                ) : (
                  <span className={cn('font-semibold tabular-nums', r.delta >= 0 ? 'text-status-green-emphasis' : 'text-status-red-emphasis')}>
                    {r.delta >= 0 ? '+' : ''}{r.delta}
                  </span>
                ),
            },
            {
              id: 'result', header: 'Result', width: 160, min: 140,
              sortValue: (r) => (noData(r) ? 'Not enough data' : r.improved ? 'Improved' : 'Needs coaching'),
              cell: (r) =>
                noData(r) ? (
                  <Badge variant="softNeutral" size="pill">Not enough data</Badge>
                ) : r.improved ? (
                  <Badge variant="softGreen" size="pill">Improved</Badge>
                ) : (
                  <Badge variant="softRed" size="pill">Needs coaching</Badge>
                ),
            },
          ]}
        />
      </div>

      <div className="space-y-2">
        <div>
          <ReportHeading level={3}>Low scorers with no matching training</ReportHeading>
          <p className="text-muted-foreground text-xs">Send-to-training worklist.</p>
        </div>
        <ReportTable
          rows={training.needsTraining}
          getRowKey={(r) => r.repId}
          empty={<EmptyState title="No reps flagged." />}
          columns={[
            { id: 'rep', header: 'Rep', width: 180, min: 150, sortValue: (r) => r.repName, cell: (r) => <span className="font-medium">{r.repName}</span> },
            { id: 'role', header: 'Role', width: 150, min: 120, sortValue: (r) => ROLE_LABEL[r.role] ?? r.role, cell: (r) => <span className="text-muted-foreground">{ROLE_LABEL[r.role] ?? r.role}</span> },
            { id: 'avgScore', header: 'Avg score', width: 130, min: 110, align: 'right', sortValue: (r) => r.avgScore, cell: (r) => <span className="text-status-red-emphasis font-semibold tabular-nums">{r.avgScore}</span> },
            { id: 'count', header: 'Interactions', width: 140, min: 120, align: 'right', sortValue: (r) => r.count, cell: (r) => <span className="text-muted-foreground tabular-nums">{r.count}</span> },
          ]}
        />
      </div>
    </div>
  );
}
