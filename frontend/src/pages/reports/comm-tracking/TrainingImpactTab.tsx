import { ResizableTable } from '@/components/data/ResizableTable';
import { EmptyState } from '@/components/ui/empty-state';
import { Heading } from '@/components/ui/heading';
import type { TrainingImpactResult, TrainingImpactRow } from '@/lib/reports/communication-tracking-logic';

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
      <div className="rounded-xl border border-border bg-surface-light p-5 shadow-card">
        <Heading level={3}>Average adherence change after training</Heading>
        <div className={`mt-3 text-4xl font-semibold tabular-nums ${training.avgDelta >= 0 ? 'text-success' : 'text-danger'}`}>
          {training.avgDelta >= 0 ? '+' : ''}{training.avgDelta}
        </div>
        <p className="mt-1 text-xs text-text-secondary">
          Mean of (after − before) adherence across trained reps, ±14-day window.
        </p>
      </div>

      <div className="space-y-2">
        <Heading level={3}>Before vs after, by rep</Heading>
        <ResizableTable
          rows={training.rows}
          getRowKey={(r) => `${r.repId}-${r.completedAt}`}
          empty={<EmptyState title="No training completions in range." />}
          columns={[
            { id: 'rep', header: 'Rep', width: 170, min: 150, sortValue: (r) => r.repName, cell: (r) => <span className="font-medium text-text-primary">{r.repName}</span> },
            { id: 'role', header: 'Role', width: 140, min: 120, sortValue: (r) => ROLE_LABEL[r.role] ?? r.role, cell: (r) => <span className="text-text-secondary">{ROLE_LABEL[r.role] ?? r.role}</span> },
            { id: 'scenario', header: 'Scenario', width: 200, min: 160, sortValue: (r) => r.scenarioTitle, cell: (r) => <span className="text-text-secondary">{r.scenarioTitle}</span> },
            {
              id: 'before',
              header: 'Before',
              width: 110,
              min: 100,
              align: 'right',
              sortValue: (r) => (noData(r) ? null : r.before),
              cell: (r) => <span className="tabular-nums text-text-secondary">{noData(r) ? '—' : `${r.before} (${r.beforeN})`}</span>,
            },
            {
              id: 'after',
              header: 'After',
              width: 110,
              min: 100,
              align: 'right',
              sortValue: (r) => (noData(r) ? null : r.after),
              cell: (r) => <span className="tabular-nums text-text-secondary">{noData(r) ? '—' : `${r.after} (${r.afterN})`}</span>,
            },
            {
              id: 'delta',
              header: 'Δ',
              width: 100,
              min: 90,
              align: 'right',
              sortValue: (r) => (noData(r) ? null : r.delta),
              cell: (r) =>
                noData(r) ? (
                  <span className="tabular-nums text-text-secondary">—</span>
                ) : (
                  <span className={`font-semibold tabular-nums ${r.delta >= 0 ? 'text-success' : 'text-danger'}`}>
                    {r.delta >= 0 ? '+' : ''}{r.delta}
                  </span>
                ),
            },
            {
              id: 'result',
              header: 'Result',
              width: 160,
              min: 140,
              sortValue: (r) => (noData(r) ? 'Not enough data' : r.improved ? 'Improved' : 'Needs coaching'),
              cell: (r) =>
                noData(r) ? (
                  <span className="rounded-full bg-background-light px-2 py-0.5 text-xs font-medium text-text-secondary">Not enough data</span>
                ) : r.improved ? (
                  <span className="rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-success">Improved</span>
                ) : (
                  <span className="rounded-full bg-danger/10 px-2 py-0.5 text-xs font-medium text-danger">Needs coaching</span>
                ),
            },
          ]}
        />
      </div>

      <div className="space-y-2">
        <div>
          <Heading level={3}>Low scorers with no matching training</Heading>
          <p className="text-xs text-text-secondary">Send-to-training worklist.</p>
        </div>
        <ResizableTable
          rows={training.needsTraining}
          getRowKey={(r) => r.repId}
          empty={<EmptyState title="No reps flagged." />}
          columns={[
            { id: 'rep', header: 'Rep', width: 180, min: 150, sortValue: (r) => r.repName, cell: (r) => <span className="font-medium text-text-primary">{r.repName}</span> },
            { id: 'role', header: 'Role', width: 150, min: 120, sortValue: (r) => ROLE_LABEL[r.role] ?? r.role, cell: (r) => <span className="text-text-secondary">{ROLE_LABEL[r.role] ?? r.role}</span> },
            { id: 'avgScore', header: 'Avg score', width: 130, min: 110, align: 'right', sortValue: (r) => r.avgScore, cell: (r) => <span className="font-semibold tabular-nums text-danger">{r.avgScore}</span> },
            { id: 'count', header: 'Interactions', width: 140, min: 120, align: 'right', sortValue: (r) => r.count, cell: (r) => <span className="tabular-nums text-text-secondary">{r.count}</span> },
          ]}
        />
      </div>
    </div>
  );
}
