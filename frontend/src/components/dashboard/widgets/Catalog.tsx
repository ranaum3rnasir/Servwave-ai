import { Activity, Briefcase, FileText, PieChart as PieIcon, CalendarClock, CalendarX2, ClipboardCheck, Sparkles, UserX, Users } from 'lucide-react';
import type { StatusSlice, JobTypeSlice, ComingUpJob, UnscheduledJob, EstimateToSend, ReviewQueueJob, MissingCrewVisit, MissingOwnerLead, ActivityEvent } from '@/lib/api/dashboard';
import { SegmentedDonut } from '@/components/charts';
import { chartPalette } from '@/design-system';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { formatCurrency } from '@/lib/utils';
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

/** The "View all" link of a card header: offered only when the server sent an address for the tile. */
function ViewAll({ link, navigate }: { link?: string | null; navigate: (to: string) => void }) {
  if (!link) return null;
  return <Button type="button" onClick={() => navigate(link)} variant="link" tone="brand" size={null} className="text-xs">View all</Button>;
}

export function JobsByStatus({ slices, link, navigate }: { slices: StatusSlice[]; link?: string | null; navigate: (to: string) => void }) {
  return (
    <WidgetCard title="Jobs by Status" icon={<Briefcase className="h-4 w-4 text-text-secondary" />} right={<ViewAll link={link} navigate={navigate} />}>
      <Donut data={slices.map((s) => ({ name: s.label, value: s.count }))} />
    </WidgetCard>
  );
}

export function RevenueByJobType({ slices, link, navigate }: { slices: JobTypeSlice[]; link?: string | null; navigate: (to: string) => void }) {
  return (
    <WidgetCard title="Revenue by Job Type" icon={<PieIcon className="h-4 w-4 text-text-secondary" />} right={link ? <Button type="button" onClick={() => navigate(link)} variant="link" tone="brand" size={null} className="text-xs">Report</Button> : undefined}>
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

export function ComingUp({ jobs, link, navigate }: { jobs: ComingUpJob[]; link?: string | null; navigate: (to: string) => void }) {
  return (
    <WidgetCard title="Coming Up" icon={<CalendarClock className="h-4 w-4 text-text-secondary" />} right={<ViewAll link={link} navigate={navigate} />}>
      <div>
        {jobs.map((j) => (
          // Full-width list-row click target (time label + title/address stack), not a
          // Button-shaped control - left raw per the program's non-Button-shape carve-out.
          <button key={j.id} type="button" onClick={() => navigate(j.link)} className="flex items-center gap-3 px-5 py-2.5 w-full text-left border-b border-border last:border-0 hover:bg-background-light transition-colors">
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

/** One row of a card of records waiting for something: number, name, a second line and how long it has waited. It opens the address the server sent. */
function WaitingRow({ to, number, title, caption, waited, navigate }: { to: string; number: string; title: string; caption: string; waited?: string; navigate: (to: string) => void }) {
  return (
    <Button type="button" onClick={() => navigate(to)} variant="ghost" size={null} className="h-auto w-full justify-start gap-3 whitespace-normal px-5 py-2.5 text-left font-normal">
      <span className="text-[11px] font-medium text-text-secondary w-16 shrink-0">{number}</span>
      <span className="flex-1 min-w-0">
        <span className="block text-[12.5px] font-semibold text-text-primary truncate">{title}</span>
        <span className="block text-[11px] text-text-secondary truncate">{caption}</span>
      </span>
      {waited && <span className="text-[11px] text-text-secondary shrink-0">{waited}</span>}
    </Button>
  );
}

/** A card of jobs waiting for something: the few that have waited longest, each opening its job at the address the server sent. */
function WaitingJobs({ title, icon, empty, data, link, navigate }: {
  title: string; icon: React.ReactNode; empty: string;
  data?: { count: number; jobs: Array<UnscheduledJob | ReviewQueueJob> }; link?: string | null; navigate: (to: string) => void;
}) {
  const jobs = data?.jobs ?? [];
  return (
    <WidgetCard title={title} icon={icon} right={<ViewAll link={link} navigate={navigate} />}>
      {jobs.length === 0 ? (
        <EmptyState title={empty} />
      ) : (
        <div>
          {jobs.map((j) => (
            <WaitingRow key={j.id} to={j.link} number={j.job_number} title={j.title} caption={j.address} navigate={navigate} />
          ))}
        </div>
      )}
    </WidgetCard>
  );
}

export function UnscheduledJobs({ data, link, navigate }: { data?: { count: number; jobs: UnscheduledJob[] }; link?: string | null; navigate: (to: string) => void }) {
  return <WaitingJobs title="Unscheduled jobs" icon={<CalendarX2 className="h-4 w-4 text-text-secondary" />} empty="No unscheduled jobs" data={data} link={link} navigate={navigate} />;
}

export function OfficeReviewQueue({ data, link, navigate }: { data?: { count: number; jobs: ReviewQueueJob[] }; link?: string | null; navigate: (to: string) => void }) {
  return <WaitingJobs title="Office review queue" icon={<ClipboardCheck className="h-4 w-4 text-text-secondary" />} empty="No jobs waiting for review" data={data} link={link} navigate={navigate} />;
}

/** The draft estimates still to send: the few that have waited longest, each opening its estimate at the address the server sent. */
export function EstimatesToSend({ data, link, navigate }: { data?: { count: number; estimates: EstimateToSend[] }; link?: string | null; navigate: (to: string) => void }) {
  const estimates = data?.estimates ?? [];
  return (
    <WidgetCard title="Estimates still to send" icon={<FileText className="h-4 w-4 text-text-secondary" />} right={<ViewAll link={link} navigate={navigate} />}>
      {estimates.length === 0 ? (
        <EmptyState title="No estimates to send" />
      ) : (
        <div>
          {estimates.map((e) => (
            <WaitingRow key={e.id} to={e.link} number={e.estimate_number} title={e.title} caption="" waited={formatCurrency(e.total)} navigate={navigate} />
          ))}
        </div>
      )}
    </WidgetCard>
  );
}

/** The booked visit that starts soonest with nobody on it, opening its job or lead at the address the server sent. */
export function MissingCrew({ data, link, navigate }: { data?: { count: number; soonest: MissingCrewVisit | null }; link?: string | null; navigate: (to: string) => void }) {
  const soonest = data?.soonest ?? null;
  return (
    <WidgetCard title="Missing crew" icon={<Users className="h-4 w-4 text-text-secondary" />} right={<ViewAll link={link} navigate={navigate} />}>
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

/** The open lead that has had no Owner longest, opening at the address the server sent. */
export function MissingLeadOwner({ data, link, navigate }: { data?: { count: number; oldest: MissingOwnerLead | null }; link?: string | null; navigate: (to: string) => void }) {
  const oldest = data?.oldest ?? null;
  return (
    <WidgetCard title="Missing lead owner" icon={<UserX className="h-4 w-4 text-text-secondary" />} right={<ViewAll link={link} navigate={navigate} />}>
      {!oldest ? (
        <EmptyState title="No leads without an owner" />
      ) : (
        <WaitingRow to={oldest.link} number={oldest.lead_number} title={oldest.title} caption="Oldest" waited={oldest.age_days <= 0 ? 'Today' : oldest.age_days === 1 ? '1 day' : `${oldest.age_days} days`} navigate={navigate} />
      )}
    </WidgetCard>
  );
}

export function RecentActivity({ events }: { events: ActivityEvent[] }) {
  return (
    <WidgetCard title="Recent Activity" icon={<Activity className="h-4 w-4 text-text-secondary" />} right={<span className="h-[7px] w-[7px] rounded-full bg-sage-500 animate-pulse" />}>
      <div className="max-h-72 overflow-y-auto overscroll-contain">
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
