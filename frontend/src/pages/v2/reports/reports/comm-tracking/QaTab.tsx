import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { ChartCard } from '@/components/charts';
import { chartPalette, token } from '@/design-system';
import type { QaResult } from '@/lib/reports/communication-tracking-logic';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { cn } from '@/ui-kit/lib/utils';

import { ReportHeading } from '../../components/heading';
import { ReportTable } from '../../components/reportTable';

/**
 * QA tab - script-adherence scoring by role, by rep, and the review queue.
 *
 * THE SCORE BANDS ARE A DATA SIGNAL: 85+ green, 70-84 neutral, below 70 red.
 * Same three thresholds as before, on the kit's status tokens. The adherence
 * chart is untouched - a single categorical series in `chartPalette[1]`.
 *
 * "Manager-overridden scores take precedence over AI scores" is decided in
 * `communication-tracking-logic`, not here; this tab only renders the result.
 */

const ROLE_LABEL: Record<string, string> = {
  csr: 'Office / CSR',
  sales: 'Sales',
  dispatch: 'Dispatch',
  tech: 'Field tech',
};

function scoreColor(s: number): string {
  if (s >= 85) return 'text-status-green-emphasis';
  if (s >= 70) return 'text-foreground';
  return 'text-status-red-emphasis';
}

export function QaTab({ qa }: { qa: QaResult }) {
  const chartData = qa.byRole.map((r) => ({ name: ROLE_LABEL[r.role] ?? r.role, score: r.avgScore }));

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="Adherence by role">
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} layout="vertical" margin={{ left: 24 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke={token('--border-color')} />
                <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 11, fill: token('--text-secondary') }} axisLine={false} tickLine={false} />
                <YAxis type="category" dataKey="name" width={90} tick={{ fontSize: 11, fill: token('--text-secondary') }} axisLine={false} tickLine={false} />
                <Tooltip cursor={{ fill: token('--border-soft'), opacity: 0.5 }} />
                <Bar dataKey="score" radius={[0, 6, 6, 0]} barSize={18} fill={chartPalette[1]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>

        <ChartCard title="Company average">
          <div className={cn('text-5xl font-semibold tabular-nums', scoreColor(qa.avgScore))}>
            {qa.avgScore}
          </div>
          <p className="text-muted-foreground mt-1 text-xs">
            Manager-overridden scores take precedence over AI scores.
          </p>
        </ChartCard>
      </div>

      <div className="space-y-2">
        <ReportHeading level={3}>Scorecard by rep</ReportHeading>
        <ReportTable
          rows={qa.byRep}
          getRowKey={(r) => r.repId}
          empty={<EmptyState title="No interactions in range." />}
          columns={[
            { id: 'rep', header: 'Rep', width: 180, min: 150, sortValue: (r) => r.repName, cell: (r) => <span className="font-medium">{r.repName}</span> },
            { id: 'role', header: 'Role', width: 150, min: 120, sortValue: (r) => ROLE_LABEL[r.role] ?? r.role, cell: (r) => <span className="text-muted-foreground">{ROLE_LABEL[r.role] ?? r.role}</span> },
            { id: 'count', header: 'Interactions', width: 140, min: 120, align: 'right', sortValue: (r) => r.count, cell: (r) => <span className="text-muted-foreground tabular-nums">{r.count}</span> },
            { id: 'calls', header: 'Calls', width: 100, min: 90, align: 'right', sortValue: (r) => r.callCount, cell: (r) => <span className="text-muted-foreground tabular-nums">{r.callCount}</span> },
            { id: 'texts', header: 'Texts', width: 100, min: 90, align: 'right', sortValue: (r) => r.textCount, cell: (r) => <span className="text-muted-foreground tabular-nums">{r.textCount}</span> },
            { id: 'avgScore', header: 'Avg score', width: 130, min: 110, align: 'right', sortValue: (r) => r.avgScore, cell: (r) => <span className={cn('font-semibold tabular-nums', scoreColor(r.avgScore))}>{r.avgScore}</span> },
          ]}
        />
      </div>

      <div className="space-y-2">
        <div>
          <ReportHeading level={3}>Manager review queue</ReportHeading>
          <p className="text-muted-foreground text-xs">Below {70} or disputed - needs sign-off or override.</p>
        </div>
        <ReportTable
          rows={qa.reviewQueue}
          getRowKey={(q) => q.id}
          empty={<EmptyState title="Nothing in the review queue." />}
          columns={[
            { id: 'rep', header: 'Rep', width: 170, min: 150, sortValue: (q) => q.repName, cell: (q) => <span className="font-medium">{q.repName}</span> },
            { id: 'kind', header: 'Kind', width: 110, min: 90, sortValue: (q) => q.kind, cell: (q) => <span className="text-muted-foreground capitalize">{q.kind}</span> },
            { id: 'customer', header: 'Customer', width: 180, min: 150, sortValue: (q) => q.customerName, cell: (q) => <span className="text-muted-foreground">{q.customerName}</span> },
            { id: 'ai', header: 'AI', width: 90, min: 80, align: 'right', sortValue: (q) => q.aiScore, cell: (q) => <span className="text-muted-foreground tabular-nums">{q.aiScore}</span> },
            { id: 'manager', header: 'Manager', width: 120, min: 100, align: 'right', sortValue: (q) => q.managerScore ?? null, cell: (q) => <span className="text-muted-foreground tabular-nums">{q.managerScore ?? '-'}{q.disputed ? ' ⚠' : ''}</span> },
            { id: 'flags', header: 'Flags', width: 200, min: 150, sortValue: (q) => q.flags.join(', '), cell: (q) => <span className="text-muted-foreground">{q.flags.join(', ') || '-'}</span> },
          ]}
        />
      </div>
    </div>
  );
}
