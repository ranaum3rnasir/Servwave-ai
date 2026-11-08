import { Activity, Briefcase, PieChart as PieIcon, CalendarClock, Sparkles, Trash2 } from 'lucide-react';

import type { StatusSlice, JobTypeSlice, ComingUpJob, ActivityEvent } from '@/lib/api/dashboard';
import { SegmentedDonut } from '@/components/charts';
import { chartPalette } from '@/design-system';
import { formatCurrencyWhole } from '@/lib/utils';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { EmptyState } from '@/ui-kit/components/data/emptyState';

import { WidgetCard } from '../components/widgetCard';
import { preferV2Path } from '../../uiV2';

// Categorical, calm-on-brand series colors - single source of truth (no
// rainbow). Chart colour, so it stays on the design-system accessor: the kit
// ships no chart component and no categorical series ramp.
const PALETTE = chartPalette;

function relativeTime(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return `${Math.floor(hrs / 24)} d ago`;
}

/**
 * Donut + legend. `SegmentedDonut` is first-party ServWave SVG, reused
 * unchanged - see the ledger's KEEP row for `components/charts`.
 */
function Donut({ data }: { data: Array<{ name: string; value: number }> }) {
  return (
    <div className="flex items-center gap-3 px-5 py-4">
      <SegmentedDonut
        size={110}
        thickness={20}
        segments={data.map((d, i) => ({ label: d.name, value: d.value, color: PALETTE[i % PALETTE.length] }))}
        className="shrink-0"
      />
      <div className="min-w-0 flex-1 space-y-1">
        {data.map((d, i) => (
          <div key={d.name} className="flex items-center gap-2 text-[11px]">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: PALETTE[i % PALETTE.length] }} />
            <span className="flex-1 truncate text-muted-foreground">{d.name}</span>
            <span className="font-semibold tabular-nums text-foreground">{d.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function JobsByStatus({ slices, navigate }: { slices: StatusSlice[]; navigate: (to: string) => void }) {
  return (
    <WidgetCard
      title="Jobs by Status"
      icon={<Briefcase className="h-4 w-4 text-muted-foreground" />}
      right={<Button type="button" variant="link" size={null} className="text-xs" onClick={() => navigate(preferV2Path('/jobs'))}>View all</Button>}
    >
      <Donut data={slices.map((s) => ({ name: s.label, value: s.count }))} />
    </WidgetCard>
  );
}

/**
 * Revenue by job type.
 *
 * Not the shared `Donut`: the arc is sized by `pct` while the legend reads
 * `revenue`, so the segment value and the printed figure are two different
 * fields. That asymmetry is deliberate in the legacy widget and is preserved.
 */
export function RevenueByJobType({ slices, navigate }: { slices: JobTypeSlice[]; navigate: (to: string) => void }) {
  return (
    <WidgetCard
      title="Revenue by Job Type"
      icon={<PieIcon className="h-4 w-4 text-muted-foreground" />}
      right={<Button type="button" variant="link" size={null} className="text-xs" onClick={() => navigate(preferV2Path('/reports'))}>Report</Button>}
    >
      <div className="flex items-center gap-3 px-5 py-4">
        <SegmentedDonut
          size={110}
          thickness={20}
          segments={slices.map((s, i) => ({ label: s.label, value: s.pct, color: PALETTE[i % PALETTE.length] }))}
          className="shrink-0"
        />
        <div className="min-w-0 flex-1 space-y-1">
          {slices.map((s, i) => (
            <div key={s.label} className="flex items-center gap-2 text-[11px]">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: PALETTE[i % PALETTE.length] }} />
              <span className="flex-1 truncate text-muted-foreground">{s.label}</span>
              <span className="font-semibold tabular-nums text-foreground">{formatCurrencyWhole(s.revenue)}</span>
            </div>
          ))}
        </div>
      </div>
    </WidgetCard>
  );
}

/**
 * Coming Up.
 *
 * Every row navigates to `/schedule`, NOT to the job it names. That reads like
 * a bug and is logged as one; it is reproduced here because changing where a
 * row goes is a behaviour change.
 */
export function ComingUp({ jobs, navigate }: { jobs: ComingUpJob[]; navigate: (to: string) => void }) {
  return (
    <WidgetCard
      title="Coming Up"
      icon={<CalendarClock className="h-4 w-4 text-muted-foreground" />}
      right={<Button type="button" variant="link" size={null} className="text-xs" onClick={() => navigate(preferV2Path('/schedule'))}>View all</Button>}
    >
      <div>
        {jobs.map((j) => (
          <Button
            key={j.id}
            type="button"
            variant="ghost"
            size={null}
            onClick={() => navigate(preferV2Path('/schedule'))}
            className="h-auto w-full justify-start gap-3 whitespace-normal rounded-none border-b px-5 py-2.5 text-left font-normal last:border-0"
          >
            <span className="w-20 shrink-0 text-[11px] font-medium text-muted-foreground">{j.in_label}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] font-semibold text-foreground">{j.title}</span>
              <span className="block truncate text-[11px] text-muted-foreground">{j.address}</span>
            </span>
          </Button>
        ))}
      </div>
    </WidgetCard>
  );
}

/** Recent activity. Rows are deliberately NOT clickable - the timeline events
 *  carry no link, and inventing one would be a new behaviour. That rule is now
 *  load-bearing rather than merely conservative: the feed is org-wide and
 *  unfiltered, so a row can name an entity that has been deleted, and a link
 *  here would be a link to a 404.
 *
 *  Such a row is marked instead. `entity_label` is the snapshot the backend took
 *  at delete time and is the only identity the entity has left, so it is shown
 *  even though live rows show no subject at all - for a live entity the subject
 *  is still findable, for a deleted one this is the last copy of it. */
export function RecentActivity({ events }: { events: ActivityEvent[] }) {
  return (
    <WidgetCard
      title="Recent Activity"
      icon={<Activity className="h-4 w-4 text-muted-foreground" />}
      right={<span className="h-[7px] w-[7px] animate-pulse rounded-full bg-status-green" />}
    >
      <div className="max-h-72 overflow-y-auto">
        {events.length === 0 ? (
          <EmptyState title="No recent activity" />
        ) : (
          events.map((e, i) => (
            <div key={e.id} className={`flex items-start gap-2.5 px-5 py-2.5 ${i < events.length - 1 ? 'border-b' : ''}`}>
              <div className="mt-0.5 flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                {e.entity_deleted ? <Trash2 aria-hidden className="h-3.5 w-3.5" /> : '·'}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[12.5px] leading-snug text-foreground">{e.description}</p>
                {e.entity_deleted && e.entity_label ? (
                  <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span className="min-w-0 truncate" title={e.entity_label}>{e.entity_label}</span>
                    <Badge variant="softNeutral" size="sm">Deleted</Badge>
                  </p>
                ) : null}
                <p className="mt-0.5 text-[11px] text-muted-foreground">{relativeTime(e.created_at)}{e.creator_name ? ` · ${e.creator_name}` : ''}</p>
              </div>
            </div>
          ))
        )}
      </div>
    </WidgetCard>
  );
}

/** The two dataless stubs, `service_areas` and `recent_calls`. They take no
 *  data and make no API call, so the `phone` entitlement that gates the whole
 *  Communication module has nothing to gate here. If Recent Calls is ever
 *  wired to a comm endpoint it must gain that gate. */
export function ComingSoon({ title }: { title: string }) {
  return (
    <WidgetCard title={title} icon={<Sparkles className="h-4 w-4 text-muted-foreground" />}>
      <EmptyState title="Coming soon" description="Connect data to enable this widget." />
    </WidgetCard>
  );
}
