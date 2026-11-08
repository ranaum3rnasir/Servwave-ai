import { useMemo } from 'react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';
import { Circle, TrendingUp, Ban, CheckCircle2 } from 'lucide-react';
import { KpiStrip } from '@/components/data/KpiStrip';
import { ChartCard } from '@/components/charts';
import { tooltipContentStyle, tooltipLabelStyle } from '@/components/charts/chartTheme';
import { token } from '@/design-system';
import { computeHistory } from '@/lib/tasks/tasks-logic';

import { useFilteredTasks } from '@/lib/tasks/useFilteredTasks';
import { TaskCard } from '@/components/tasks/TaskCard';
import type { Task } from '@/lib/tasks/types';

function formatDue(due: string | null): string {
  if (!due) return 'No due date';
  return new Date(due).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

interface UpcomingGroupProps {
  label: string;
  tasks: Task[];
}

function UpcomingGroup({ label, tasks }: UpcomingGroupProps) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <span className="text-sm font-semibold text-text-primary">{label}</span>
        <span className="rounded-full bg-background-light px-2 py-0.5 text-xs font-medium text-text-secondary">
          {tasks.length}
        </span>
      </div>
      {tasks.length === 0 ? (
        <p className="text-xs text-text-secondary italic">—</p>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {tasks.map((t) => (
            <TaskCard key={t.id} task={t} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function HistoryView() {
  // History analytics stay category-agnostic like the Dashboard — the KPI
  // drill-down only scopes the real task-list surfaces (List/Board/Calendar/My Day).
  const tasks = useFilteredTasks({ applyCategory: false });
  const history = useMemo(() => computeHistory(tasks, new Date()), [tasks]);

  const flowData = history.flow.map((pt) => ({
    week: `W${pt.weekIndex + 1}`,
    Created: pt.created,
    Closed: pt.closed,
  }));

  const allUpcomingEmpty =
    history.upcoming.thisWeek.length === 0 &&
    history.upcoming.nextWeek.length === 0 &&
    history.upcoming.later.length === 0;

  return (
    <div className="flex flex-col gap-6">
      {/* Section 1 — Status snapshot */}
      <KpiStrip
        items={[
          { icon: Circle,       label: 'Open',        value: history.snapshot.todo,       tone: 'neutral' },
          { icon: TrendingUp,   label: 'In Progress',  value: history.snapshot.inProgress, tone: 'primary' },
          { icon: Ban,          label: 'Blocked',      value: history.snapshot.blocked,    tone: 'warning' },
          { icon: CheckCircle2, label: 'Closed',       value: history.snapshot.done,       tone: 'success' },
        ]}
      />

      {/* Section 2 — Flow chart */}
      <ChartCard title="Task flow — created vs closed">
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={flowData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={token('--border-color')} />
            <XAxis dataKey="week" tick={{ fontSize: 11, fill: token('--text-secondary') }} />
            <YAxis tick={{ fontSize: 11, fill: token('--text-secondary') }} allowDecimals={false} />
            <Tooltip
              position={{ y: 0 }}
              cursor={{ fill: token('--border-soft'), opacity: 0.5 }}
              contentStyle={tooltipContentStyle()}
              labelStyle={tooltipLabelStyle()}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="Created" fill={token('--primary')} isAnimationActive={false} radius={[4, 4, 0, 0]} />
            <Bar dataKey="Closed"  fill={token('--success')} isAnimationActive={false} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* Section 3 — Upcoming */}
      <div className="bg-surface-light rounded-xl border border-border shadow-card p-6">
        <p className="text-sm font-semibold text-text-primary mb-5">What's coming</p>
        {allUpcomingEmpty ? (
          <p className="text-sm text-text-secondary italic">Nothing scheduled ahead.</p>
        ) : (
          <div className="flex flex-col gap-6">
            <UpcomingGroup label="This week" tasks={history.upcoming.thisWeek} />
            <UpcomingGroup label="Next week" tasks={history.upcoming.nextWeek} />
            <UpcomingGroup label="Later"     tasks={history.upcoming.later} />
          </div>
        )}
      </div>
    </div>
  );
}
