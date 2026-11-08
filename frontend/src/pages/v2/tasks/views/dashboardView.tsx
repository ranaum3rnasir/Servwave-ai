import { useMemo } from 'react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts';

import { token } from '@/design-system';
import { computeStats, type TaskDrillDown } from '@/lib/tasks/tasks-logic';
import { taskAI } from '@/lib/tasks/taskAI';
import { TASK_VIEW_FILTER_OPTIONS, useFilteredTasks } from '@/lib/tasks/useFilteredTasks';
import { useTaskFilterStore } from '@/stores/taskFilterStore';
import { useAssignableUsers } from '@/lib/api/users';

import { Progress } from '@/ui-kit/components/ui/progress';
import { StatCard, StatCardGroup } from '@/ui-kit/components/data/statCard';

import { ChartCard } from '../components/chartCard';
import { PENNANT } from '../components/glyphs';

/**
 * The manager-only tab, last in the rail. My Day is what the hub opens on.
 *
 * NOT read-only, whatever the behaviour map says: every KPI card toggles the
 * shared `taskFilterStore` category and drills through to the List tab.
 * `onDrillDown` is the hub's tab setter, passed straight through.
 *
 * The aggregates deliberately ignore the category filter
 * (`applyCategory: false`) so drilling into a category never collapses the
 * numbers the cards are showing - the legacy comment's reasoning, preserved.
 *
 * Charts are a no-touch boundary: the recharts tree and every
 * `token('--...')` accessor below are the legacy view's, unchanged. Only the
 * card around them is kit.
 */
export default function DashboardView({ onDrillDown }: { onDrillDown?: () => void }) {
  const tasks = useFilteredTasks(TASK_VIEW_FILTER_OPTIONS.dashboard);
  const category = useTaskFilterStore((s) => s.category);
  const setCategory = useTaskFilterStore((s) => s.setCategory);
  // `directory`, not `task`: these names populate the dashboard's filter chips, not an
  // assignee field. See taskFilterBar.
  const { data: rawUsers = [] } = useAssignableUsers({ purpose: 'directory', eligibleFor: 'task' });

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
      {/* Four tiles, every one of them a filter. The former "Top Closer" tile
          was the odd one out - a leaderboard reading with no onClick sitting in
          a row of drill-throughs - and it is gone. */}
      <StatCardGroup className="xl:grid-cols-4">
        <StatCard
          label="Open" value={stats.open} tone="brand"
          active={category === 'open'} onClick={() => handleCategoryKpi('open')}
        />
        <StatCard
          label="At Risk" value={stats.atRisk} tone="amber"
          active={category === 'atRisk'} onClick={() => handleCategoryKpi('atRisk')}
        />
        <StatCard
          label="On-Time %" value={`${stats.onTimePct}%`} tone="green"
          active={category === 'onTime'} onClick={() => handleCategoryKpi('onTime')}
        />
        <StatCard
          label="Blocked" value={stats.blocked} tone="red"
          active={category === 'blocked'} onClick={() => handleCategoryKpi('blocked')}
        />
      </StatCardGroup>

      <div
        data-testid="dashboard-insight-panel"
        className="bg-brand-subtle rounded-lg p-4"
      >
        <p className="text-brand mb-1 text-[11.5px] font-bold tracking-[0.06em] uppercase">This week</p>
        <p className="text-[13px] leading-relaxed">{summary}</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <ChartCard title="Open by Assignee">
          <div className="flex flex-col gap-3">
            {stats.byAssignee.map((row) => (
              <div key={row.userId} className="flex flex-col gap-1">
                <div className="flex items-center justify-between text-[12px]">
                  <span className="font-medium">
                    {userNameById.get(row.userId) ?? row.userId}
                    {row.overdue > 0 && (
                      <span className="text-status-amber-emphasis ms-1.5" title={`${row.overdue} overdue`}>
                        {PENNANT}
                      </span>
                    )}
                  </span>
                  <span className="text-muted-foreground tabular-nums">{row.open}</span>
                </div>
                {/* The hand-rolled percentage bar becomes the kit's Progress,
                    which is the same measure with an actual progressbar role. */}
                <Progress
                  value={Math.round((row.open / maxOpen) * 100)}
                  aria-label={`${userNameById.get(row.userId) ?? row.userId}, ${row.open} open`}
                />
              </div>
            ))}
            {stats.byAssignee.length === 0 && (
              <p className="text-muted-foreground text-[12px]">No open tasks.</p>
            )}
          </div>
        </ChartCard>

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
