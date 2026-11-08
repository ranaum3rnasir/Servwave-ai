import { useMemo } from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';
import { ListChecks, AlertTriangle, CheckCircle, Ban, Star } from 'lucide-react';
import { KpiStrip } from '@/components/data/KpiStrip';
import { ChartCard } from '@/components/charts';
import { token } from '@/design-system';
import { computeStats } from '@/lib/tasks/tasks-logic';
import type { TaskDrillDown } from '@/lib/tasks/tasks-logic';
import { taskAI } from '@/lib/tasks/taskAI';
import { useFilteredTasks } from '@/lib/tasks/useFilteredTasks';
import { useTaskFilterStore } from '@/stores/taskFilterStore';
import { useAssignableUsers } from '@/lib/api/users';

export default function DashboardView({ onDrillDown }: { onDrillDown?: () => void }) {
  // The dashboard never filters its own aggregate cards — KPI stats/charts
  // reflect member/dept/tag only, so drilling into a category never collapses
  // the numbers the cards are showing.
  const tasks = useFilteredTasks({ applyCategory: false });
  const category = useTaskFilterStore((s) => s.category);
  const setCategory = useTaskFilterStore((s) => s.setCategory);
  // DEAD v1 twin - kept in step with pages/v2/tasks/views/dashboardView. Not invested in.
  const { data: rawUsers = [] } = useAssignableUsers({ purpose: 'directory', eligibleFor: 'task' });

  // Clicking a KPI card toggles the shared task-list category filter and drills
  // into the list tab (mirrors JobsPage.handleStatusKpi).
  const handleCategoryKpi = (next: TaskDrillDown) => {
    const activating = category !== next;
    setCategory(activating ? next : 'all');
    if (activating) onDrillDown?.();
  };

  const userNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of rawUsers) m.set(u.id, `${u.first_name} ${u.last_name}`);
    return m;
  }, [rawUsers]);

  const now = useMemo(() => new Date(), []);
  const stats = useMemo(() => computeStats(tasks, now), [tasks, now]);
  const summary = useMemo(() => taskAI.rollup(tasks, now), [tasks, now]);

  const maxOpen = Math.max(...stats.byAssignee.map((a) => a.open), 1);

  const trendData = stats.trend.map((pt) => ({
    week: `W${pt.weekIndex + 1}`,
    done: pt.done,
  }));

  return (
    <div className="flex flex-col gap-6">
      {/* KPI strip */}
      <KpiStrip
        items={[
          { icon: ListChecks, label: 'Open', value: stats.open, tone: 'primary', active: category === 'open', onClick: () => handleCategoryKpi('open') },
          { icon: AlertTriangle, label: 'At Risk', value: stats.atRisk, tone: 'warning', active: category === 'atRisk', onClick: () => handleCategoryKpi('atRisk') },
          { icon: CheckCircle, label: 'On-Time %', value: `${stats.onTimePct}%`, tone: 'success', active: category === 'onTime', onClick: () => handleCategoryKpi('onTime') },
          { icon: Ban, label: 'Blocked', value: stats.blocked, tone: 'danger', active: category === 'blocked', onClick: () => handleCategoryKpi('blocked') },
          {
            icon: Star,
            label: 'Top Closer',
            value: stats.topCloserId ? (userNameById.get(stats.topCloserId) ?? stats.topCloserId) : '—',
            tone: 'neutral',
          },
        ]}
      />

      {/* AI summary */}
      <div
        data-testid="dashboard-insight-panel"
        className="rounded-xl border border-primary/10 bg-primary-subtle/70 p-4 text-text-primary"
      >
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-primary">
          This week
        </p>
        <p className="text-sm leading-relaxed text-text-primary">{summary}</p>
      </div>

      {/* Two-column charts row */}
      <div className="grid md:grid-cols-2 gap-4">
        {/* Open by assignee */}
        <ChartCard title="Open by Assignee">
          <div className="flex flex-col gap-3">
            {stats.byAssignee.map((row) => {
              const pct = Math.round((row.open / maxOpen) * 100);
              return (
                <div key={row.userId} className="flex flex-col gap-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-text-primary">
                      {userNameById.get(row.userId) ?? row.userId}
                      {row.overdue > 0 && (
                        <span className="ml-1.5 text-warning" title={`${row.overdue} overdue`}>
                          ⚑
                        </span>
                      )}
                    </span>
                    <span className="text-text-secondary tabular-nums">{row.open}</span>
                  </div>
                  <div className="h-2 w-full rounded-full bg-border-soft">
                    <div
                      className="h-2 rounded-full bg-primary"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
            {stats.byAssignee.length === 0 && (
              <p className="text-xs text-text-secondary">No open tasks.</p>
            )}
          </div>
        </ChartCard>

        {/* Completion trend */}
        <ChartCard title="Completion Trend (8 weeks)">
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={trendData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={token('--border-color')} />
              <XAxis dataKey="week" tick={{ fontSize: 11, fill: token('--text-secondary') }} />
              <YAxis tick={{ fontSize: 11, fill: token('--text-secondary') }} allowDecimals={false} />
              <Tooltip />
              <Line
                type="monotone"
                dataKey="done"
                stroke={token('--primary')}
                strokeWidth={2}
                dot={{ r: 3, stroke: token('--primary'), fill: token('--surface-light') }}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </div>
  );
}
