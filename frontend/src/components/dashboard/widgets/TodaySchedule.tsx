import { Calendar } from 'lucide-react';
import type { TechSchedule } from '@/lib/api/dashboard';
import { IN_FLIGHT_STATUSES } from '@/components/schedule/scheduleModel';
import { getInitials } from '@/lib/utils';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { useOrganization } from '@/lib/api/organization';
import { DEFAULT_SCHEDULE_TIMEZONE } from '@/lib/schedule-tz';
import { WidgetCard } from './_shared';

function formatTime(iso: string | null, tz: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz });
}

// Row treatment for one schedule entry. Returns a COMPOSITE of four roles: a row
// wash, a left accent stripe, an inset tag and the tag's copy.
//
// THE COLOUR HALF DELIBERATELY STAYS LOCAL. This board paints on two axes - event
// type first (walkthrough vs job), then job status - and the three colour roles are
// one treatment, not three independent lookups. The status registry supplies a chip
// role but withholds a left-accent role on purpose (see the STATUS_INTENT_CLASSES
// doc block in design-system/status-registry.ts, which names this widget), so
// resolving only the inset tag through it would wash the row in one hue and the tag
// it contains in another. Same call, same reason, as the schedule boards.
//
// THE LABEL HALF IS HELD, NOT MIGRATED. STATUS_REGISTRY.job already carries the
// app-wide copy for every value this widget can render, and the three job branches
// below are the lone outliers ('Done', one collapsed 'In Progress', a 'Scheduled'
// that is wrong for an unassigned job). Adopting it is a user-facing copy change on
// a pill that renders uppercase, so it is escalated as SR-E7 and stays literal here
// until that is ruled on. See
// md_files/plans/frontend/workflows/2026-07-27-wp-status-registry.md.
function pillStyle(status: string, entity?: string) {
  // Walkthroughs: sage done-state mirrors the COMPLETED-job 'Done' pill; pending = ocean.
  if (entity === 'walkthrough' && status === 'WALKTHROUGH_COMPLETED') return { bg: 'bg-sage-50', border: 'border-sage-200 border-l-sage-500', tag: 'bg-sage-200 text-sage-700', label: 'Walkthrough' };
  if (entity === 'walkthrough') return { bg: 'bg-primary-subtle', border: 'border-ocean-700/30 border-l-ocean-700', tag: 'bg-ocean-800/10 text-ocean-800', label: 'Walkthrough' };
  if (IN_FLIGHT_STATUSES.has(status)) return { bg: 'bg-info/10', border: 'border-info/30 border-l-info', tag: 'bg-info/15 text-info', label: 'In Progress' };
  if (status === 'COMPLETED') return { bg: 'bg-sage-50', border: 'border-sage-200 border-l-sage-500', tag: 'bg-sage-200 text-sage-700', label: 'Done' };
  return { bg: 'bg-background-light', border: 'border-border border-l-text-soft', tag: 'bg-border-soft text-text-secondary', label: 'Scheduled' };
}

export default function TodaySchedule({
  data,
  navigate,
}: {
  data: TechSchedule[];
  navigate: (to: string) => void;
}) {
  // Not fed through the scheduler's eventAdapters pipeline (own dashboard-summary endpoint),
  // so it needs its own read of the org timezone — see frontend/src/lib/schedule-tz.ts.
  const { data: org } = useOrganization();
  const tz = org?.timezone || DEFAULT_SCHEDULE_TIMEZONE;
  return (
    <WidgetCard
      title="Today's Schedule"
      icon={<Calendar className="h-4 w-4 text-text-secondary" />}
      right={<Button type="button" onClick={() => navigate('/schedule')} variant="link" tone="brand" size={null} className="text-xs font-medium">Full calendar</Button>}
    >
      <div className="max-h-72 overflow-y-auto">
        {data.length === 0 ? (
          <EmptyState title="Nothing scheduled" className="text-xs" />
        ) : (
          data.map((tech, idx) => {
            const ini = tech.user_id ? getInitials(`${tech.first_name} ${tech.last_name}`) : '—';
            return (
              <div key={tech.user_id ?? 'unassigned'}>
                {idx > 0 && <div className="border-t border-border" />}
                <div className="flex items-center gap-2 px-5 py-2.5">
                  <Avatar className="h-[26px] w-[26px]">
                    {tech.avatar_url && (
                      <AvatarImage src={tech.avatar_url} alt={`${tech.first_name} ${tech.last_name}`} className="object-cover" />
                    )}
                    <AvatarFallback tone={tech.user_id ? 'solid' : 'default'} className="text-[10px] font-bold">
                      {ini}
                    </AvatarFallback>
                  </Avatar>
                  <span className="text-[11.5px] font-semibold text-text-primary">{tech.first_name} {tech.last_name}</span>
                  <span className="text-[11px] text-text-secondary ml-auto">{tech.jobs.length} visit{tech.jobs.length !== 1 ? 's' : ''}</span>
                </div>
                <div className="px-5 pb-3 flex flex-col gap-1.5">
                  {tech.jobs.map((job) => {
                    const st = pillStyle(job.status, job.entity);
                    return (
                      // Full-width list-row click target (customer/job stack + status tag +
                      // time), not a Button-shaped control - left raw per the program's
                      // non-Button-shape carve-out.
                      <button
                        key={job.id}
                        type="button"
                        onClick={() => navigate(job.entity === 'walkthrough' ? `/leads/${job.id}` : `/jobs/${job.id}`)}
                        className={`flex items-center gap-2 px-3 py-2 rounded-lg border-l-[3px] border text-left hover:brightness-95 transition-all ${st.bg} ${st.border}`}
                      >
                        <div className="flex-1 min-w-0">
                          <p className="text-[12.5px] font-semibold text-text-primary truncate">{job.customer_name}</p>
                          <p className="text-[11px] text-text-secondary truncate">{job.job_number}{job.scope_notes ? ` · ${job.scope_notes}` : ''}</p>
                        </div>
                        <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded-[4px] shrink-0 ${st.tag}`}>{st.label}</span>
                        <span className="text-[11px] font-semibold text-text-secondary shrink-0 whitespace-nowrap">{formatTime(job.scheduled_start, tz)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })
        )}
      </div>
    </WidgetCard>
  );
}
