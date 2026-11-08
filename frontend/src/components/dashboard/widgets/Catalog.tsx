import { Activity, Briefcase, PieChart as PieIcon, CalendarClock, Sparkles } from 'lucide-react';
import type { StatusSlice, JobTypeSlice, ComingUpJob, ActivityEvent } from '@/lib/api/dashboard';
import { SegmentedDonut } from '@/components/charts';
import { chartPalette } from '@/design-system';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { WidgetCard, money0 } from './_shared';

// Categorical, calm-on-brand series colors — single source of truth (no rainbow).
const PALETTE = chartPalette;

function relativeTime(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return `${Math.floor(hrs / 24)} d ago`;
}

function Donut({ data }: { data: Array<{ name: string; value: number }> }) {
  return (
    <div className="flex items-center gap-3 px-5 py-4">
      <SegmentedDonut
        size={110}
        thickness={20}
        segments={data.map((d, i) => ({ label: d.name, value: d.value, color: PALETTE[i % PALETTE.length] }))}
        className="shrink-0"
      />
      <div className="flex-1 min-w-0 space-y-1">
        {data.map((d, i) => (
          <div key={d.name} className="flex items-center gap-2 text-[11px]">
            <span className="h-2 w-2 rounded-full shrink-0" style={{ background: PALETTE[i % PALETTE.length] }} />
            <span className="flex-1 truncate text-text-secondary">{d.name}</span>
            <span className="font-semibold text-text-primary tabular-nums">{d.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function JobsByStatus({ slices, navigate }: { slices: StatusSlice[]; navigate: (to: string) => void }) {
  return (
    <WidgetCard title="Jobs by Status" icon={<Briefcase className="h-4 w-4 text-text-secondary" />} right={<Button type="button" onClick={() => navigate('/jobs')} variant="link" tone="brand" size={null} className="text-xs">View all</Button>}>
      <Donut data={slices.map((s) => ({ name: s.label, value: s.count }))} />
    </WidgetCard>
  );
}

export function RevenueByJobType({ slices, navigate }: { slices: JobTypeSlice[]; navigate: (to: string) => void }) {
  return (
    <WidgetCard title="Revenue by Job Type" icon={<PieIcon className="h-4 w-4 text-text-secondary" />} right={<Button type="button" onClick={() => navigate('/reports')} variant="link" tone="brand" size={null} className="text-xs">Report</Button>}>
      <div className="flex items-center gap-3 px-5 py-4">
        <SegmentedDonut
          size={110}
          thickness={20}
          segments={slices.map((s, i) => ({ label: s.label, value: s.pct, color: PALETTE[i % PALETTE.length] }))}
          className="shrink-0"
        />
        <div className="flex-1 min-w-0 space-y-1">
          {slices.map((s, i) => (
            <div key={s.label} className="flex items-center gap-2 text-[11px]">
              <span className="h-2 w-2 rounded-full shrink-0" style={{ background: PALETTE[i % PALETTE.length] }} />
              <span className="flex-1 truncate text-text-secondary">{s.label}</span>
              <span className="font-semibold text-text-primary tabular-nums">{money0(s.revenue)}</span>
            </div>
          ))}
        </div>
      </div>
    </WidgetCard>
  );
}

export function ComingUp({ jobs, navigate }: { jobs: ComingUpJob[]; navigate: (to: string) => void }) {
  return (
    <WidgetCard title="Coming Up" icon={<CalendarClock className="h-4 w-4 text-text-secondary" />} right={<Button type="button" onClick={() => navigate('/schedule')} variant="link" tone="brand" size={null} className="text-xs">View all</Button>}>
      <div>
        {jobs.map((j) => (
          // Full-width list-row click target (time label + title/address stack), not a
          // Button-shaped control - left raw per the program's non-Button-shape carve-out.
          <button key={j.id} type="button" onClick={() => navigate('/schedule')} className="flex items-center gap-3 px-5 py-2.5 w-full text-left border-b border-border last:border-0 hover:bg-background-light transition-colors">
            <span className="text-[11px] font-medium text-text-secondary w-20 shrink-0">{j.in_label}</span>
            <span className="flex-1 min-w-0">
              <p className="text-[12.5px] font-semibold text-text-primary truncate">{j.title}</p>
              <p className="text-[11px] text-text-secondary truncate">{j.address}</p>
            </span>
          </button>
        ))}
      </div>
    </WidgetCard>
  );
}

export function RecentActivity({ events }: { events: ActivityEvent[] }) {
  return (
    <WidgetCard title="Recent Activity" icon={<Activity className="h-4 w-4 text-text-secondary" />} right={<span className="h-[7px] w-[7px] rounded-full bg-sage-500 animate-pulse" />}>
      <div className="max-h-72 overflow-y-auto">
        {events.length === 0 ? (
          <EmptyState title="No recent activity" className="text-xs" />
        ) : (
          events.map((e, i) => (
            <div key={e.id} className={`flex items-start gap-2.5 px-5 py-2.5 ${i < events.length - 1 ? 'border-b border-border' : ''}`}>
              <div className="h-[30px] w-[30px] rounded-lg bg-border-soft flex items-center justify-center shrink-0 mt-0.5 text-text-secondary">•</div>
              <div className="flex-1 min-w-0">
                <p className="text-[12.5px] text-text-primary leading-snug">{e.description}</p>
                <p className="text-[11px] text-text-secondary mt-0.5">{relativeTime(e.created_at)}{e.creator_name ? ` · ${e.creator_name}` : ''}</p>
              </div>
            </div>
          ))
        )}
      </div>
    </WidgetCard>
  );
}

export function ComingSoon({ title }: { title: string }) {
  return (
    <WidgetCard title={title} icon={<Sparkles className="h-4 w-4 text-text-secondary" />}>
      <div className="flex flex-col items-center justify-center py-10 text-center px-6">
        <p className="text-sm font-semibold text-text-primary">Coming soon</p>
        <p className="text-xs text-text-secondary mt-1">Connect data to enable this widget.</p>
      </div>
    </WidgetCard>
  );
}
