import { Calendar } from 'lucide-react';

import type { TechSchedule } from '@/lib/api/dashboard';
import { IN_FLIGHT_STATUSES } from '@/components/schedule/scheduleModel';
import { getInitials } from '@/lib/utils';
import { Button } from '@/ui-kit/components/ui/button';
import { EmptyState } from '@/ui-kit/components/data/emptyState';

import { WidgetCard } from '../components/widgetCard';
import { preferV2Path } from '../../uiV2';

// On-brand avatar gradients (ocean / sage / lavender family) - decorative
// per-tech identity, kept within the Calm Intelligence palette. Not a status
// signal, so it stays on the app's own ramp rather than the kit's status hues.
const GRADIENTS = [
  'from-ocean-700 to-ocean-900',
  'from-sage-500 to-sage-700',
  'from-ai-500 to-ai-600',
  'from-info to-ocean-800',
  'from-ocean-800 to-sage-700',
];

function gradient(userId: string | null): string {
  if (!userId) return 'from-text-soft to-text-secondary';
  let hash = 0;
  for (const c of userId) hash = (hash * 31 + c.charCodeAt(0)) & 0xffff;
  return GRADIENTS[hash % GRADIENTS.length] ?? GRADIENTS[0]!;
}

function formatTime(iso: string | null): string {
  if (!iso) return '-';
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

// Row treatment for one schedule entry. Returns a COMPOSITE of four roles: a
// row wash, a left accent stripe, an inset tag and the tag's copy.
//
// CARRIED OVER VERBATIM from pages/dashboard/widgets/TodaySchedule.tsx, class
// for class, and deliberately NOT retoned onto the kit's status palette. This
// board paints on two axes - event type first (walkthrough vs job), then job
// status - and the three colour roles are one treatment, not three independent
// lookups. The status registry supplies a chip role but withholds a
// left-accent role on purpose (see the STATUS_INTENT_CLASSES doc block in
// design-system/status-registry.ts, which names this widget), so resolving
// only the inset tag through it would wash the row in one hue and the tag it
// contains in another.
//
// The five-branch ORDER is a behaviour contract, asserted by
// pages/dashboard/widgets/TodaySchedule.test.tsx against the legacy widget:
// walkthrough-completed before walkthrough-pending before in-flight before
// completed before the default. Reordering it changes which pill a row gets.
//
// The LABEL half is held, not migrated, for the same reason it is in the
// legacy file: STATUS_REGISTRY.job carries app-wide copy for every value here,
// and adopting it is a user-facing copy change escalated as SR-E7.
function pillStyle(status: string, entity?: string) {
  if (entity === 'walkthrough' && status === 'WALKTHROUGH_COMPLETED') return { bg: 'bg-sage-50', border: 'border-sage-200 border-l-sage-500', tag: 'bg-sage-200 text-sage-700', label: 'Walkthrough' };
  if (entity === 'walkthrough') return { bg: 'bg-primary-subtle', border: 'border-ocean-700/30 border-l-ocean-700', tag: 'bg-ocean-800/10 text-ocean-800', label: 'Walkthrough' };
  if (IN_FLIGHT_STATUSES.has(status)) return { bg: 'bg-info/10', border: 'border-info/30 border-l-info', tag: 'bg-info/15 text-info', label: 'In Progress' };
  if (status === 'COMPLETED') return { bg: 'bg-sage-50', border: 'border-sage-200 border-l-sage-500', tag: 'bg-sage-200 text-sage-700', label: 'Done' };
  return { bg: 'bg-background-light', border: 'border-border border-l-text-soft', tag: 'bg-border-soft text-text-secondary', label: 'Scheduled' };
}

/**
 * Per-technician lanes for today.
 *
 * The server always emits the Unassigned lane last and it is the only lane
 * with a null `user_id`; that is what selects the flat chip and the `-`
 * initials here. Entry clicks route by ENTITY, not by status - a walkthrough
 * belongs to a lead, everything else to a job.
 */
export default function TodaySchedule({
  data,
  navigate,
}: {
  data: TechSchedule[];
  navigate: (to: string) => void;
}) {
  return (
    <WidgetCard
      title="Today's Schedule"
      icon={<Calendar className="h-4 w-4 text-muted-foreground" />}
      right={
        <Button type="button" variant="link" size={null} className="text-xs" onClick={() => navigate(preferV2Path('/schedule'))}>
          Full calendar
        </Button>
      }
    >
      {/* Fills the card instead of capping at a fixed 18rem.
          The widget grid is `auto-rows-min` with stretched cells, so this card
          is drawn at the height of the TALLEST widget in its row, and WidgetCard
          passes that height down with `h-full`. A hard `max-h-72` on the list
          ignored it: the lanes were clipped at 18rem - mid-entry - and the rest
          of the card below that was blank. `flex-1` takes the height the card
          actually has, and `min-h-0` is what lets a flex child shrink below its
          content so `overflow-y-auto` still scrolls when there IS more. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {data.length === 0 ? (
          <EmptyState title="Nothing scheduled" />
        ) : (
          data.map((tech, idx) => {
            const ini = tech.user_id ? getInitials(`${tech.first_name} ${tech.last_name}`) : '-';
            return (
              <div key={tech.user_id ?? 'unassigned'}>
                {idx > 0 && <div className="border-t" />}
                <div className="flex items-center gap-2 px-5 py-2.5">
                  <div className={`flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-on-fill ${tech.user_id ? `bg-gradient-to-br ${gradient(tech.user_id)}` : 'bg-border'}`}>{ini}</div>
                  <span className="text-[11.5px] font-semibold text-foreground">{tech.first_name} {tech.last_name}</span>
                  <span className="ml-auto text-[11px] text-muted-foreground">{tech.jobs.length} visit{tech.jobs.length !== 1 ? 's' : ''}</span>
                </div>
                <div className="flex flex-col gap-1.5 px-5 pb-3">
                  {tech.jobs.map((job) => {
                    const st = pillStyle(job.status, job.entity);
                    return (
                      // `variant={null}`: the row's fill IS the status signal,
                      // so no kit variant may paint over it. The kit Button
                      // still supplies the element, the focus ring and the
                      // press affordance.
                      <Button
                        key={job.id}
                        type="button"
                        variant={null}
                        size={null}
                        onClick={() => navigate(job.entity === 'walkthrough' ? `/leads/${job.id}` : `/jobs/${job.id}`)}
                        className={`h-auto w-full justify-start gap-2 whitespace-normal rounded-lg border-l-[3px] border px-3 py-2 text-left font-normal hover:brightness-95 ${st.bg} ${st.border}`}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12.5px] font-semibold text-text-primary">{job.customer_name}</span>
                          <span className="block truncate text-[11px] text-text-secondary">{job.job_number}{job.scope_notes ? ` · ${job.scope_notes}` : ''}</span>
                        </span>
                        <span className={`shrink-0 rounded-[4px] px-1.5 py-0.5 text-[10px] font-bold uppercase ${st.tag}`}>{st.label}</span>
                        <span className="shrink-0 whitespace-nowrap text-[11px] font-semibold text-text-secondary">{formatTime(job.scheduled_start)}</span>
                      </Button>
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
