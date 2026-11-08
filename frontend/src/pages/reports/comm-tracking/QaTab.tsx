import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { ResizableTable } from '@/components/data/ResizableTable';
import { EmptyState } from '@/components/ui/empty-state';
import { Heading } from '@/components/ui/heading';
import { ChartCard } from '@/components/charts';
import { chartPalette, token } from '@/design-system';
import type { QaResult } from '@/lib/reports/communication-tracking-logic';

const ROLE_LABEL: Record<string, string> = {
  csr: 'Office / CSR',
  sales: 'Sales',
  dispatch: 'Dispatch',
  tech: 'Field tech',
};

function scoreColor(s: number): string {
  if (s >= 85) return 'text-success';
  if (s >= 70) return 'text-text-primary';
  return 'text-danger';
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
          <div className={`text-5xl font-semibold tabular-nums ${scoreColor(qa.avgScore)}`}>
            {qa.avgScore}
          </div>
          <p className="mt-1 text-xs text-text-secondary">Manager-overridden scores take precedence over AI scores.</p>
        </ChartCard>
      </div>

      <div className="space-y-2">
        <Heading level={3}>Scorecard by rep</Heading>
        <ResizableTable
          rows={qa.byRep}
          getRowKey={(r) => r.repId}
          empty={<EmptyState title="No interactions in range." />}
          columns={[
            { id: 'rep', header: 'Rep', width: 180, min: 150, sortValue: (r) => r.repName, cell: (r) => <span className="font-medium text-text-primary">{r.repName}</span> },
            { id: 'role', header: 'Role', width: 150, min: 120, sortValue: (r) => ROLE_LABEL[r.role] ?? r.role, cell: (r) => <span className="text-text-secondary">{ROLE_LABEL[r.role] ?? r.role}</span> },
            { id: 'count', header: 'Interactions', width: 140, min: 120, align: 'right', sortValue: (r) => r.count, cell: (r) => <span className="tabular-nums text-text-secondary">{r.count}</span> },
            { id: 'calls', header: 'Calls', width: 100, min: 90, align: 'right', sortValue: (r) => r.callCount, cell: (r) => <span className="tabular-nums text-text-secondary">{r.callCount}</span> },
            { id: 'texts', header: 'Texts', width: 100, min: 90, align: 'right', sortValue: (r) => r.textCount, cell: (r) => <span className="tabular-nums text-text-secondary">{r.textCount}</span> },
            { id: 'avgScore', header: 'Avg score', width: 130, min: 110, align: 'right', sortValue: (r) => r.avgScore, cell: (r) => <span className={`font-semibold tabular-nums ${scoreColor(r.avgScore)}`}>{r.avgScore}</span> },
          ]}
        />
      </div>

      <div className="space-y-2">
        <div>
          <Heading level={3}>Manager review queue</Heading>
          <p className="text-xs text-text-secondary">Below {70} or disputed — needs sign-off or override.</p>
        </div>
        <ResizableTable
          rows={qa.reviewQueue}
          getRowKey={(q) => q.id}
          empty={<EmptyState title="Nothing in the review queue." />}
          columns={[
            { id: 'rep', header: 'Rep', width: 170, min: 150, sortValue: (q) => q.repName, cell: (q) => <span className="font-medium text-text-primary">{q.repName}</span> },
            { id: 'kind', header: 'Kind', width: 110, min: 90, sortValue: (q) => q.kind, cell: (q) => <span className="capitalize text-text-secondary">{q.kind}</span> },
            { id: 'customer', header: 'Customer', width: 180, min: 150, sortValue: (q) => q.customerName, cell: (q) => <span className="text-text-secondary">{q.customerName}</span> },
            { id: 'ai', header: 'AI', width: 90, min: 80, align: 'right', sortValue: (q) => q.aiScore, cell: (q) => <span className="tabular-nums text-text-secondary">{q.aiScore}</span> },
            { id: 'manager', header: 'Manager', width: 120, min: 100, align: 'right', sortValue: (q) => q.managerScore ?? null, cell: (q) => <span className="tabular-nums text-text-secondary">{q.managerScore ?? '—'}{q.disputed ? ' ⚠' : ''}</span> },
            { id: 'flags', header: 'Flags', width: 200, min: 150, sortValue: (q) => q.flags.join(', '), cell: (q) => <span className="text-text-secondary">{q.flags.join(', ') || '—'}</span> },
          ]}
        />
      </div>
    </div>
  );
}
