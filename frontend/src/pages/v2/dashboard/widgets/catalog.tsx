import { Activity, Briefcase, FileText, PieChart as PieIcon, CalendarClock, CalendarX2, ClipboardCheck, Sparkles, Trash2, UserX, Users } from 'lucide-react';

import type { StatusSlice, JobTypeSlice, ComingUpJob, UnscheduledJob, EstimateToSend, ReviewQueueJob, MissingCrewVisit, MissingOwnerLead, ActivityEvent } from '@/lib/api/dashboard';
import { SegmentedDonut } from '@/components/charts';
import { chartPalette } from '@/design-system';
import { formatCurrency, formatCurrencyWhole } from '@/lib/utils';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { EmptyState } from '@/ui-kit/components/data/emptyState';

import { WidgetCard } from '../components/widgetCard';

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

/** `onViewAll` is set only when the server sent an address for the tile; without it there is no "View all". */
export function JobsByStatus({ slices, onViewAll, isLoading }: { slices: StatusSlice[]; onViewAll?: () => void; isLoading?: boolean }) {
  return (
    <WidgetCard
      title="Jobs by Status"
      icon={<Briefcase className="h-4 w-4 text-muted-foreground" />}
      right={onViewAll && <Button type="button" variant="link" size={null} className="text-xs" onClick={onViewAll}>View all</Button>}
      loading={isLoading}
    >
      {slices.every((s) => s.count === 0) ? (
        <EmptyState title="No jobs yet" />
      ) : (
        <Donut data={slices.map((s) => ({ name: s.label, value: s.count }))} />
      )}
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
export function RevenueByJobType({ slices, onReport, isLoading }: { slices: JobTypeSlice[]; onReport?: () => void; isLoading?: boolean }) {
  return (
    <WidgetCard
      title="Revenue by Job Type"
      icon={<PieIcon className="h-4 w-4 text-muted-foreground" />}
      right={onReport && <Button type="button" variant="link" size={null} className="text-xs" onClick={onReport}>Report</Button>}
      loading={isLoading}
    >
      {slices.length === 0 ? (
        <EmptyState title="No revenue by job type yet" />
      ) : (
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
      )}
    </WidgetCard>
  );
}

/**
 * Coming Up.
 *
 * A row opens the job it names, at the address the server sent with it (a job the person can open, because the tile's
 * query goes through the access resolver). "View all" opens the Schedule and is offered only when the server sent the
 * Schedule's address for the tile, which it does for a person who may open that page.
 */
export function ComingUp({ jobs, onViewAll, navigate, isLoading }: { jobs: ComingUpJob[]; onViewAll?: () => void; navigate: (to: string) => void; isLoading?: boolean }) {
  return (
    <WidgetCard
      title="Coming Up"
      icon={<CalendarClock className="h-4 w-4 text-muted-foreground" />}
      right={onViewAll && <Button type="button" variant="link" size={null} className="text-xs" onClick={onViewAll}>View all</Button>}
      loading={isLoading}
    >
      {jobs.length === 0 ? (
        <EmptyState title="No upcoming jobs" />
      ) : (
        <div>
          {jobs.map((j) => (
            <Button
              key={j.id}
              type="button"
              variant="ghost"
              size={null}
              onClick={() => navigate(j.link)}
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
      )}
    </WidgetCard>
  );
}

/** How long a job has waited, in the words a row shows. */
function waitingFor(days: number): string {
  if (days <= 0) return 'Today';
  return days === 1 ? '1 day' : `${days} days`;
}

/** One row of a tile that lists records waiting for something: number, name, a second line and how long it has waited. It opens the address the server sent. */
function WaitingRow({ to, number, title, caption, waited, navigate }: { to: string; number: string; title: string; caption?: string; waited: string; navigate: (to: string) => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size={null}
      onClick={() => navigate(to)}
      className="h-auto w-full justify-start gap-3 whitespace-normal rounded-none border-b px-5 py-2.5 text-left font-normal last:border-0"
    >
      <span className="min-w-16 shrink-0 text-[11px] font-medium text-muted-foreground">{number}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-semibold text-foreground">{title}</span>
        {caption && <span className="block truncate text-[11px] text-muted-foreground">{caption}</span>}
      </span>
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{waited}</span>
    </Button>
  );
}

/** The rows of a tile that lists jobs waiting for something: number, customer, place and how long it has waited. Each opens the job at the address the server sent. */
function WaitingJobRows({ jobs, navigate }: { jobs: Array<UnscheduledJob | ReviewQueueJob>; navigate: (to: string) => void }) {
  return (
    <div>
      {jobs.map((j) => (
        <WaitingRow key={j.id} to={j.link} number={j.job_number} title={j.title} caption={j.address} waited={waitingFor(j.age_days)} navigate={navigate} />
      ))}
    </div>
  );
}

/**
 * Unscheduled jobs: the jobs waiting for a visit. The count is over everything the person can open; the rows are the few
 * that have waited longest, as many as the server sent, so the tile never grows into a list of its own. A row opens the
 * job at the address the server sent with it. "View all" is offered only when the server sent the Jobs list's address
 * for the tile, which it does for a person who may open that page.
 */
export function UnscheduledJobs({ data, onViewAll, navigate, isLoading }: { data?: { count: number; jobs: UnscheduledJob[] }; onViewAll?: () => void; navigate: (to: string) => void; isLoading?: boolean }) {
  const jobs = data?.jobs ?? [];
  return (
    <WidgetCard
      title="Unscheduled jobs"
      icon={<CalendarX2 className="h-4 w-4 text-muted-foreground" />}
      right={
        <span className="flex items-center gap-3">
          {data && data.count > 0 && <Badge variant="softNeutral" size="sm">{data.count}</Badge>}
          {onViewAll && <Button type="button" variant="link" size={null} className="text-xs" onClick={onViewAll}>View all</Button>}
        </span>
      }
      loading={isLoading}
    >
      {jobs.length === 0 ? (
        <EmptyState title="No unscheduled jobs" />
      ) : (
        <WaitingJobRows jobs={jobs} navigate={navigate} />
      )}
    </WidgetCard>
  );
}

/**
 * Office review queue: the jobs waiting for an office review that the person can open. The count is over all of them;
 * the rows are the few that have waited longest, as many as the server sent. A row opens the job at the address the
 * server sent with it, which carries the review panel, so the panel is open on arrival. "View all" is offered only when
 * the server sent the Jobs list's address for the tile, which it does for a person who may open that page.
 */
export function OfficeReviewQueue({ data, onViewAll, navigate, isLoading }: { data?: { count: number; jobs: ReviewQueueJob[] }; onViewAll?: () => void; navigate: (to: string) => void; isLoading?: boolean }) {
  const jobs = data?.jobs ?? [];
  return (
    <WidgetCard
      title="Office review queue"
      icon={<ClipboardCheck className="h-4 w-4 text-muted-foreground" />}
      right={
        <span className="flex items-center gap-3">
          {data && data.count > 0 && <Badge variant="softNeutral" size="sm">{data.count}</Badge>}
          {onViewAll && <Button type="button" variant="link" size={null} className="text-xs" onClick={onViewAll}>View all</Button>}
        </span>
      }
      loading={isLoading}
    >
      {jobs.length === 0 ? (
        <EmptyState title="No jobs waiting for review" />
      ) : (
        <WaitingJobRows jobs={jobs} navigate={navigate} />
      )}
    </WidgetCard>
  );
}

/**
 * Estimates still to send: the draft estimates the person can open, whoever wrote them. The count is over all of them; the
 * rows are the few that have waited longest, as many as the server sent, each with its number, its customer and its own
 * total (the record's price, with no sum across the rows). A row opens the estimate at the address the server sent with it.
 * "View all" is offered only when the server sent the Estimates list's address for the tile (filtered to Draft), which it
 * does for a person who may open that page.
 */
export function EstimatesToSend({ data, onViewAll, navigate, isLoading }: { data?: { count: number; estimates: EstimateToSend[] }; onViewAll?: () => void; navigate: (to: string) => void; isLoading?: boolean }) {
  const estimates = data?.estimates ?? [];
  return (
    <WidgetCard
      title="Estimates still to send"
      icon={<FileText className="h-4 w-4 text-muted-foreground" />}
      right={
        <span className="flex items-center gap-3">
          {data && data.count > 0 && <Badge variant="softNeutral" size="sm">{data.count}</Badge>}
          {onViewAll && <Button type="button" variant="link" size={null} className="text-xs" onClick={onViewAll}>View all</Button>}
        </span>
      }
      loading={isLoading}
    >
      {estimates.length === 0 ? (
        <EmptyState title="No estimates to send" />
      ) : (
        <div>
          {estimates.map((e) => (
            <WaitingRow key={e.id} to={e.link} number={e.estimate_number} title={e.title} waited={formatCurrency(e.total)} navigate={navigate} />
          ))}
        </div>
      )}
    </WidgetCard>
  );
}

/**
 * Missing crew: the booked visits in the next 7 days with nobody on them, job visits and (for a person with View leads)
 * walkthroughs. The count is over all of them; the one row is the visit that starts soonest, opening its job or lead at the
 * address the server sent with it. "View all" is offered only when the server sent the Schedule's "No crew" address for the
 * tile, which it does for a person who may open the Schedule.
 */
export function MissingCrew({ data, onViewAll, navigate, isLoading }: { data?: { count: number; soonest: MissingCrewVisit | null }; onViewAll?: () => void; navigate: (to: string) => void; isLoading?: boolean }) {
  const soonest = data?.soonest ?? null;
  return (
    <WidgetCard
      title="Missing crew"
      icon={<Users className="h-4 w-4 text-muted-foreground" />}
      right={
        <span className="flex items-center gap-3">
          {data && data.count > 0 && <Badge variant="softNeutral" size="sm">{data.count}</Badge>}
          {onViewAll && <Button type="button" variant="link" size={null} className="text-xs" onClick={onViewAll}>View all</Button>}
        </span>
      }
      loading={isLoading}
    >
      {!soonest ? (
        <EmptyState title="Every booked visit has a crew" />
      ) : (
        <WaitingRow
          to={soonest.link}
          number={soonest.number}
          title={soonest.title}
          caption={soonest.kind === 'lead' ? `Walkthrough · ${soonest.starts_label}` : soonest.starts_label}
          waited={`in ${soonest.until}`}
          navigate={navigate}
        />
      )}
    </WidgetCard>
  );
}

/**
 * Missing lead owner: the open leads in the person's scope with no Owner. The count is over all of them; the one row is the
 * lead that has been open longest, opening at the address the server sent with it. "View all" is offered only when the
 * server sent the Leads list's address for the tile (filtered to No owner), which it does for a person who may open that page.
 */
export function MissingLeadOwner({ data, onViewAll, navigate, isLoading }: { data?: { count: number; oldest: MissingOwnerLead | null }; onViewAll?: () => void; navigate: (to: string) => void; isLoading?: boolean }) {
  const oldest = data?.oldest ?? null;
  return (
    <WidgetCard
      title="Missing lead owner"
      icon={<UserX className="h-4 w-4 text-muted-foreground" />}
      right={
        <span className="flex items-center gap-3">
          {data && data.count > 0 && <Badge variant="softNeutral" size="sm">{data.count}</Badge>}
          {onViewAll && <Button type="button" variant="link" size={null} className="text-xs" onClick={onViewAll}>View all</Button>}
        </span>
      }
      loading={isLoading}
    >
      {!oldest ? (
        <EmptyState title="No leads without an owner" />
      ) : (
        <WaitingRow to={oldest.link} number={oldest.lead_number} title={oldest.title} caption="Oldest" waited={waitingFor(oldest.age_days)} navigate={navigate} />
      )}
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
export function RecentActivity({ events, isLoading }: { events: ActivityEvent[]; isLoading?: boolean }) {
  return (
    <WidgetCard
      title="Recent Activity"
      icon={<Activity className="h-4 w-4 text-muted-foreground" />}
      right={<span className="h-[7px] w-[7px] animate-pulse rounded-full bg-status-green" />}
      loading={isLoading}
    >
      <div className="max-h-72 overflow-y-auto overscroll-contain">
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
      <EmptyState title="Coming soon" />
    </WidgetCard>
  );
}
