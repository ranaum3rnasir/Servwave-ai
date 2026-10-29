/**
 * Settings > Schedule Colors - the live preview.
 *
 * Sample cards painted by the board's OWN paint function (boardEventPaint, the Standard board's
 * eventStyleGetter body), inside a wrapper that carries the DRAFT colour vars from
 * useScheduleEventColorVars. Every `ev-*` class the paint returns resolves against the wrapper, so
 * the samples repaint as the admin clicks a swatch, before anything is saved, and nothing outside
 * the wrapper changes. The hook is called WITHOUT writeToRoot on purpose: this page must not
 * repaint the rest of the app with an unsaved choice.
 *
 * What is shared with the board and what is not:
 *  - The COLOUR (surface, text, left bar, amber frame, solid fill, grey done card) is not copied:
 *    it is whatever boardEventPaint returns for the same inputs the board passes, so the preview
 *    cannot show a colour the board does not paint.
 *  - The card ROWS are a thin replica of ScheduleEvent's job / walkthrough / calendar-entry
 *    branches (pages/v2/schedule/SchedulePage.tsx). The real component reads the board's context
 *    (hover, context menu, conflict set) and lives in the schedule page module, which would pull
 *    the whole calendar into this settings chunk. The rows carry no colour of their own there
 *    either - every row inherits the card's text colour - so only type size and weight are copied.
 *
 * Service plans are not board cards: their colour shows on the Unassigned list, as the icon on the
 * Service Plans bucket row. That row is sampled here as it renders there.
 */
import { Repeat } from 'lucide-react';

import { cn } from '@/ui-kit/lib/utils';
import { EVENT_TYPE_META, type EventType, type EventDangerState } from '@/components/schedule/scheduleModel';
import type { ScheduleEventColors } from '@/lib/schedule/eventColors';
import { useScheduleEventColorVars } from '@/lib/schedule/useScheduleEventColorVars';
import { boardEventPaint } from '@/components/schedule/boardEventPaint';
import { EN_DASH } from '@/pages/v2/_shared/glyphs';

import { Section } from './section';

const CUSTOMER = 'Sample Customer';
const TIME = `8:00 AM ${EN_DASH} 10:00 AM`;

type PreviewState = 'job' | 'walkthrough' | 'calendar-entry' | 'double-booked' | 'in-progress' | 'completed';

interface PreviewSample {
  state: PreviewState;
  caption: string;
  type: EventType;
  completed?: boolean;
  inFlight?: boolean;
  dangerState?: EventDangerState;
  /** Record number; absent for a calendar entry, which the board titles by name alone. */
  number?: string;
  title?: string;
  jobType?: string;
}

/** One card per state the board paints differently, in the order a dispatcher meets them. */
const PREVIEW_SAMPLES: readonly PreviewSample[] = [
  { state: 'job', caption: 'Job', type: 'job', number: 'J00052', jobType: 'Installation' },
  { state: 'walkthrough', caption: 'Walkthrough', type: 'walkthrough', number: 'L00031' },
  { state: 'calendar-entry', caption: 'Event', type: 'calendar-entry', title: 'Team meeting' },
  {
    state: 'double-booked', caption: 'Double-booked', type: 'job', dangerState: 'double-booked',
    number: 'J00053', jobType: 'Repair',
  },
  { state: 'in-progress', caption: 'In progress', type: 'job', inFlight: true, number: 'J00054', jobType: 'Repair' },
  { state: 'completed', caption: 'Completed', type: 'job', completed: true, number: 'J00055', jobType: 'Service' },
];

/** The board's paint for a sample - exactly the call the page's eventStyleGetter makes. */
function previewPaint(s: PreviewSample) {
  const paint = boardEventPaint({
    type: s.type,
    isGhost: false,
    completed: s.completed ?? false,
    inFlight: s.inFlight ?? false,
    dangerState: s.dangerState ?? null,
    highlight: {},
    canDragCalendarEntry: false,
  });
  // A sample is not draggable; everything else in the style (radius, padding, shadow) is kept.
  return { className: paint.className, style: { ...paint.style, cursor: 'default' } };
}

function CardRows({ sample }: { sample: PreviewSample }) {
  // Calendar entry: the title alone, as the board renders it.
  if (sample.type === 'calendar-entry') {
    return (
      <div className="flex items-center overflow-hidden leading-[1.3]">
        <span className="truncate text-[12px] font-medium">{sample.title}</span>
      </div>
    );
  }
  return (
    <div className="flex flex-col overflow-hidden leading-[1.3]">
      <div className="flex items-center gap-1 truncate text-[13px] font-bold">
        {sample.dangerState === 'double-booked' && <span className="sr-only">Double-booked</span>}
        <span className="truncate">{`${sample.number} ${EN_DASH} ${CUSTOMER}`}</span>
      </div>
      <div className="truncate text-xs">{TIME}</div>
      {sample.jobType && <div className="truncate text-[11px]">{sample.jobType}</div>}
    </div>
  );
}

function PreviewCard({ sample }: { sample: PreviewSample }) {
  const { className, style } = previewPaint(sample);
  return (
    <figure className="m-0 flex flex-col gap-1">
      <figcaption className="text-muted-foreground text-[11px]">{sample.caption}</figcaption>
      <div data-preview-state={sample.state} className={className} style={style}>
        <CardRows sample={sample} />
      </div>
    </figure>
  );
}

/** The Service Plans bucket row from the Unassigned list: the one place that colour is painted. */
function ServicePlanSample() {
  const meta = EVENT_TYPE_META['service-plan'];
  return (
    <figure className="m-0 flex flex-col gap-1">
      <figcaption className="text-muted-foreground text-[11px]">Service plans, in the unassigned list</figcaption>
      <div data-preview-state="service-plan" className="bg-kit-card flex items-center gap-2 rounded-lg border px-2.5 py-2">
        <Repeat aria-hidden="true" className={cn('h-3.5 w-3.5 shrink-0', meta.text)} />
        <span className="text-xs font-semibold">Service Plans</span>
        <span className="text-muted-foreground ml-auto text-[11px] font-medium">2</span>
      </div>
    </figure>
  );
}

export function ScheduleColorsPreview({
  colors,
  className,
}: {
  /** The DRAFT map - the form's current value, saved or not. */
  colors: ScheduleEventColors;
  className?: string;
}) {
  const vars = useScheduleEventColorVars(colors);
  return (
    <Section title="Preview" description="How cards will look on the schedule." className={className}>
      <div data-testid="schedule-colors-preview" style={vars} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
        {PREVIEW_SAMPLES.map((s) => (
          <PreviewCard key={s.state} sample={s} />
        ))}
        <ServicePlanSample />
      </div>
    </Section>
  );
}
