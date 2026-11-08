import { CalendarClock } from 'lucide-react';

import { Badge } from '@/ui-kit/components/ui/badge';
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogIcon, DialogTitle,
} from '@/ui-kit/components/ui/dialog';
import { Button } from '@/ui-kit/components/ui/button';
import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { Skeleton } from '@/ui-kit/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/ui-kit/components/ui/table';

import type { CustomerVisitRow } from '@/lib/customers/customerSchedule';
import { formatInstant } from '@/lib/schedule-tz';

// --- Shapes ------------------------------------------------------------------

/**
 * Exactly what `GET /api/calendar-entries?customer_id=` nests per participant
 * (backend/src/lib/calendar-entries/participants.ts's `EnrichedParticipant`) -
 * `user_id`/`customer_id` are omitted here, this tab never needs them, only
 * the resolved display fields.
 */
export interface CalendarEntryParticipantSummary {
  id: string;
  kind: 'USER' | 'CUSTOMER';
  first_name: string | null;
  last_name: string | null;
  name: string | null;
  email: string | null;
}

/** One row of `GET /api/calendar-entries?customer_id=` (calendar_entry_.SELECT, slice 02/10). */
export interface CalendarEntrySummary {
  id: string;
  title: string;
  description: string;
  start: string;
  end: string;
  is_all_day: boolean;
  participants: CalendarEntryParticipantSummary[];
}

export type ScheduleRowKind = 'job' | 'walkthrough' | 'event';

export interface ScheduleRow {
  key: string;
  kind: ScheduleRowKind;
  /** The job id, the LEAD id (a walkthrough opens its lead) or the Event id - what a click opens. */
  id: string;
  /** J00041 / L00012 - blank for an event, which carries no record number. */
  number: string;
  title: string;
  /** "Visit 2 of 3" on a job or walkthrough visit; null on an Event or a job with no visit yet. */
  visitLabel: string | null;
  cancelled: boolean;
  /** ISO instant, or null for an unscheduled job - sorts last, see buildScheduleRows. */
  start: string | null;
  isAllDay: boolean;
  /** The visit's own crew; null on an Event, which has participants, not a crew. */
  crew: string[] | null;
  /** The Event itself, for the click handler to open without a second fetch. */
  event?: CalendarEntrySummary;
}

const KIND_META: Record<ScheduleRowKind, { label: string; variant: 'softBlue' | 'softAmber' | 'softNeutral' }> = {
  job: { label: 'Job', variant: 'softBlue' },
  walkthrough: { label: 'Walkthrough', variant: 'softAmber' },
  // Muted on purpose (spec §3's "muted card" note carried over to this vocabulary): an Event
  // names nothing about crew availability, so it must never read with the same weight as a Job.
  event: { label: 'Event', variant: 'softNeutral' },
};

/**
 * Merges the customer's visit rows (one per job visit and per walkthrough visit - the customer
 * schedule projection, lib/customers/customerSchedule.ts) and Events into one time-ordered list.
 * Rows with no time (a job with no visit yet) sort LAST, in their existing order.
 */
export function buildScheduleRows(
  visitRows: CustomerVisitRow[],
  calendarEntries: CalendarEntrySummary[],
): ScheduleRow[] {
  const fromVisits: ScheduleRow[] = visitRows.map((r) => ({
    key: r.key,
    kind: r.kind,
    id: r.parentId,
    number: r.number,
    title: r.title,
    visitLabel: r.visitLabel,
    cancelled: r.cancelled,
    start: r.start,
    isAllDay: r.isAllDay,
    crew: r.crew,
  }));

  const eventRows: ScheduleRow[] = calendarEntries.map((e) => ({
    key: `event-${e.id}`,
    kind: 'event',
    id: e.id,
    number: '',
    title: e.title,
    visitLabel: null,
    cancelled: false,
    start: e.start,
    isAllDay: e.is_all_day,
    crew: null,
    event: e,
  }));

  return [...fromVisits, ...eventRows].sort((a, b) => {
    if (a.start === null && b.start === null) return 0;
    if (a.start === null) return 1;
    if (b.start === null) return -1;
    return new Date(a.start).getTime() - new Date(b.start).getTime();
  });
}

/**
 * Dates render on the ORGANIZATION clock through `formatInstant`, the way the job page's visits
 * card renders the same instants - a browser-zone render would put a different day or hour here
 * than the job page and the scheduler show for every viewer outside the org's zone.
 */
const ROW_TIME_FORMAT: Intl.DateTimeFormatOptions = {
  month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
};
const ROW_DAY_FORMAT: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };

/**
 * A visit's date as this tab prints it. Exported so the Leads tab (slice 05) prints a lead's
 * walkthrough in exactly the words its Schedule row uses - one formatter, one clock.
 */
export function formatVisitWhen(visit: { start: string; isAllDay: boolean }, timeZone: string): string {
  return visit.isAllDay
    ? `${formatInstant(visit.start, timeZone, ROW_DAY_FORMAT)} · All day`
    : formatInstant(visit.start, timeZone, ROW_TIME_FORMAT);
}

function RowDate({ row, timeZone }: { row: ScheduleRow; timeZone: string }) {
  if (!row.start) return <span className="text-muted-foreground italic">Unscheduled</span>;
  const text = formatVisitWhen({ start: row.start, isAllDay: row.isAllDay }, timeZone);
  // A cancelled trip keeps its date for the record, struck through so it never reads as upcoming.
  return (
    <span className={row.cancelled ? 'text-muted-foreground whitespace-nowrap line-through' : 'whitespace-nowrap'}>
      {text}
    </span>
  );
}

function RowCrew({ crew }: { crew: string[] | null }) {
  if (crew === null) return <span className="text-muted-foreground">-</span>;
  if (crew.length === 0) return <span className="text-muted-foreground italic">Unassigned</span>;
  return <span className="text-muted-foreground block max-w-[200px] truncate">{crew.join(', ')}</span>;
}

export interface ScheduleTabProps {
  /** One row per job visit and per walkthrough visit - `projectCustomerSchedule`'s output. */
  visitRows: CustomerVisitRow[];
  /** Already resolved to [] by the caller when the viewer lacks `read CalendarEntry`. */
  calendarEntries: CalendarEntrySummary[];
  onNavigateJob: (id: string) => void;
  onNavigateWalkthrough: (leadId: string) => void;
  onOpenEvent: (entry: CalendarEntrySummary) => void;
  /**
   * The per-visit feed's state. 'loading' and 'error' never fall through to the empty state:
   * "Nothing scheduled yet." is a claim about the customer, and neither state can make it.
   */
  status: 'loading' | 'error' | 'ready';
  onRetry: () => void;
  /** The organization's time zone (useScheduleTimezone) - every date on the tab renders on it. */
  timeZone: string;
}

/**
 * The customer's combined Schedule tab: every visit of every job, every walkthrough visit and the
 * Events, one time-ordered list. Each job or walkthrough visit is its own row ("Visit 2 of 3"),
 * with its own date, time and crew; a cancelled visit stays listed and is marked Cancelled.
 * Read-only aggregation - a row links out to the record it represents.
 */
export function ScheduleTab({
  visitRows, calendarEntries, onNavigateJob, onNavigateWalkthrough, onOpenEvent, status, onRetry, timeZone,
}: ScheduleTabProps) {
  if (status === 'loading') {
    return (
      <div data-testid="schedule-loading" className="flex flex-col gap-2 p-4">
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
      </div>
    );
  }

  // Same shape as the job page's visits card when its visits fail to load: say so, offer Retry.
  if (status === 'error') {
    return (
      <div className="flex items-center gap-3 p-5">
        <p className="text-muted-foreground text-sm">Couldn&apos;t load this customer&apos;s schedule.</p>
        <Button size="sm" variant="outline" onClick={onRetry}>Retry</Button>
      </div>
    );
  }

  const rows = buildScheduleRows(visitRows, calendarEntries);

  if (rows.length === 0) {
    return <EmptyState icon={<CalendarClock />} title="Nothing scheduled yet." />;
  }

  function handleClick(row: ScheduleRow) {
    if (row.kind === 'job') onNavigateJob(row.id);
    else if (row.kind === 'walkthrough') onNavigateWalkthrough(row.id);
    else if (row.event) onOpenEvent(row.event);
  }

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Type</TableHead>
          <TableHead>Reference</TableHead>
          <TableHead>Title</TableHead>
          <TableHead>Visit</TableHead>
          <TableHead>Date</TableHead>
          <TableHead>Crew</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const meta = KIND_META[row.kind];
          return (
            <TableRow key={row.key} className="cursor-pointer" onClick={() => handleClick(row)}>
              <TableCell><Badge variant={meta.variant} size="pill">{meta.label}</Badge></TableCell>
              <TableCell>
                <span className="text-muted-foreground font-mono text-xs">{row.number || '-'}</span>
              </TableCell>
              <TableCell><span className="block max-w-[220px] truncate">{row.title}</span></TableCell>
              <TableCell>
                <span className="flex items-center gap-1.5 whitespace-nowrap">
                  {/* A cancelled trip reads "Visit 3 · Cancelled": no "of m", it is not a live trip. */}
                  <span className="text-muted-foreground whitespace-pre text-xs">
                    {row.visitLabel ?? '-'}{row.cancelled ? ' · ' : ''}
                  </span>
                  {row.cancelled && <Badge variant="softRed" size="sm">Cancelled</Badge>}
                </span>
              </TableCell>
              <TableCell><RowDate row={row} timeZone={timeZone} /></TableCell>
              <TableCell><RowCrew crew={row.crew} /></TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

// --- Event detail (read-only) -------------------------------------------------

/**
 * A minimal, ALWAYS-read-only view of one Event - no edit, no delete, no participants field.
 * This stands in for slice 04's create/edit Event dialog, which this slice does not build (out
 * of scope - see the slice doc's scope discipline note). Once slice 04 ships its dialog, an
 * update-capable viewer should open THAT instead of this one; until then every viewer, update
 * grant or not, sees this same read-only view.
 */
export function EventDetailDialog({
  entry, open, onOpenChange, timeZone,
}: {
  entry: CalendarEntrySummary | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  timeZone: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogIcon><CalendarClock /></DialogIcon>
          <div>
            <DialogTitle>{entry?.title ?? 'Event'}</DialogTitle>
            <DialogDescription>
              {entry
                ? `${formatInstant(entry.start, timeZone, ROW_TIME_FORMAT)} - ${formatInstant(entry.end, timeZone, ROW_TIME_FORMAT)}`
                : ''}
            </DialogDescription>
          </div>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          {entry?.description && (
            <p className="text-sm whitespace-pre-wrap">{entry.description}</p>
          )}
          {entry && entry.participants.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <p className="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
                Participants
              </p>
              <div className="flex flex-wrap gap-1.5">
                {entry.participants.map((p) => (
                  <Badge key={p.id} variant="softNeutral" size="sm">
                    {p.kind === 'USER' ? `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim() : p.name}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
