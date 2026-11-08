import { HelpCircle, Check } from 'lucide-react';

import { Button } from '@/ui-kit/components/ui/button';
import { Popover, PopoverTrigger, PopoverContent } from '@/ui-kit/components/ui/popover';
import { Separator } from '@/ui-kit/components/ui/separator';

import { EVENT_TYPE_META, type EventType } from '@/components/schedule/scheduleModel';
import { NeedsCrewMark } from '@/components/schedule/NeedsCrewMark';
import { TOOLBAR_ICON_SIZE } from './toolbarSizing';

interface SettingsGearDropdownProps {
  roleFilter: string;
  onRoleFilterChange: (value: string) => void;
  isGroupedView: boolean;
}

/**
 * THE LEGEND SWATCHES ARE NOT CHROME. Read this before re-tokening them.
 *
 * Each swatch is a KEY to a colour react-big-calendar is actually painting, and
 * those colours come from `boardEventPaint` (the page's eventStyleGetter). The page
 * paints each type as its derived surface with the derived left bar (the job's is
 * `border-l-ev-job-border`),
 * needs-crew = the NeedsCrewMark notch on a type-painted card, double-booked = the
 * type-painted card inside a 2px `outline-warning` frame, completed = the solid `ev-completed`
 * grey card. So the swatches below stay on those exact tokens - and because the ev-* family
 * resolves through the org's own --ev-* overrides, the legend follows a
 * recoloured board automatically. Swapping them for the kit's
 * `status-*` family would leave the legend describing colours that are not on
 * the board - a legend that lies is worse than no legend.
 *
 * Everything else in this file IS chrome and did move: the trigger is a kit
 * Button, the panel is the kit Popover, the section rule is a kit Separator, and
 * the staff-filter rows are kit Buttons instead of raw button elements.
 */

// Literal class names, not template fragments - Tailwind's JIT cannot expand a
// dynamic class. Labels come from the shared META so the legend and the board
// can never disagree about what a type is called.
// The ev-* utilities resolve through the same --ev-* custom properties the board paints with,
// so an org that recolours its events recolours this legend in the same assignment - the legend
// cannot go stale against the board it is explaining.
// The bar colour a card actually carries: the DERIVED border, which is the org's pick unless the
// pick is too light to see on white, in which case it is the pick darkened just enough to be.
const TYPE_SWATCH: Record<EventType, string> = {
  job: 'bg-ev-job-border',
  walkthrough: 'bg-ev-walkthrough-border',
  'service-plan': 'bg-ev-service-plan-border',
  'calendar-entry': 'bg-ev-calendar-entry-border', // Slice 03 - "Event"; the muted accent the board paints
};
const EVENT_TYPES: EventType[] = ['job', 'walkthrough', 'service-plan', 'calendar-entry'];

const STAFF_FILTERS = [
  { label: 'All Staff', value: 'all' },
  { label: 'Technicians', value: 'TECHNICIAN' },
  { label: 'Sales', value: 'SALES' },
] as const;

const sectionHeaderClass =
  'text-[10px] font-semibold text-muted-foreground tracking-wider uppercase mb-2';

export function SettingsGearDropdown({
  roleFilter,
  onRoleFilterChange,
  isGroupedView,
}: SettingsGearDropdownProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        {/* A question mark, not a gear. What opens below is a KEY to the
            board's colours - it explains, it does not configure - and a gear
            promised settings this panel never held.

            The legacy trigger was raw because the OLD outline cell carried an
            idle surface fill this control did not want. The kit's outline does
            the same thing, so this uses `ghost` with a hairline instead - idle
            border, fill only on hover, which is the treatment the original was
            reaching for. */}
        <Button variant="ghost" size="icon-sm" className={`border ${TOOLBAR_ICON_SIZE}`} aria-label="Schedule legend">
          <HelpCircle />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="end">
        {/* Legend */}
        <div className="px-4 py-3">
          <p className={sectionHeaderClass}>Legend</p>
          <div className="space-y-1.5">
            {/* Event-type accents (the left bar on a calendar event) */}
            {EVENT_TYPES.map((t) => (
              <div key={t} className="flex items-center gap-2">
                <span className={`h-4 w-1.5 rounded-sm flex-shrink-0 ${TYPE_SWATCH[t]}`} />
                <span className="text-xs">{EVENT_TYPE_META[t].label}</span>
              </div>
            ))}
            {/* The exception states. Needs-crew is the corner NOTCH the board mounts (NeedsCrewMark,
                the real element, so the legend cannot drift from the card); double-booked is an
                amber OUTLINE. One red on the board, and this is what it means. */}
            <div className="flex items-center gap-2">
              <span className="relative h-4 w-4 rounded-sm flex-shrink-0 bg-ev-job-surface border-l-2 border-l-ev-job-border overflow-hidden">
                <NeedsCrewMark size="sm" />
              </span>
              <span className="text-xs">Needs crew (unstaffed)</span>
            </div>
            {/* A job card under the amber frame - the board keeps the type colour and adds the
                frame, so the sample does too (it used to be a white square). */}
            <div className="flex items-center gap-2">
              <span className="h-4 w-4 rounded-sm flex-shrink-0 bg-ev-job-surface border-l-4 border-l-ev-job-border [outline-style:solid] outline-2 outline-warning -outline-offset-2" />
              <span className="text-xs">Double-booked</span>
            </div>
            {/* Terminal */}
            <div className="flex items-center gap-2">
              <span className="h-4 w-4 rounded-sm flex-shrink-0 bg-ev-completed-solid" />
              <span className="text-xs">Completed</span>
            </div>
          </div>
        </div>

        {/* Staff Filter - grouped (member) view only */}
        {isGroupedView && (
          <>
            <Separator />
            <div className="px-4 py-3">
              <p className={sectionHeaderClass}>Staff Filter</p>
              <div className="space-y-0.5" role="group" aria-label="Staff filter">
                {STAFF_FILTERS.map(({ label, value }) => {
                  const isActive = roleFilter === value;
                  return (
                    <Button
                      key={value}
                      variant={isActive ? 'secondary' : 'ghost'}
                      size="sm"
                      aria-pressed={isActive}
                      className="h-auto w-full justify-between px-2 py-1.5 text-xs"
                      onClick={() => onRoleFilterChange(value)}
                    >
                      <span>{label}</span>
                      {isActive && <Check />}
                    </Button>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
