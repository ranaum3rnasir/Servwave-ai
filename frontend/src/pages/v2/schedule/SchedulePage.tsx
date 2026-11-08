import React, { useState, useCallback, useRef, useMemo, useEffect, useLayoutEffect, useContext } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { usePlanMode, type GhostEvent } from '@/hooks/usePlanMode';
import { useResizableWidth } from '@/hooks/useResizableWidth';
import { useAuthStore } from '@/stores/auth.store';
import { useAppAbility } from '@/contexts/AbilityContext';
import { useSchedulerBucket, useScheduleVisit, servicePlanKeys } from '@/lib/api/service-plans';
import { useFeature, useModuleAccess } from '@/lib/entitlements';
import { Calendar, dateFnsLocalizer, Views } from 'react-big-calendar';
import withDnD from 'react-big-calendar/lib/addons/dragAndDrop';
import {
  format,
  parse,
  startOfWeek,
  endOfWeek,
  startOfDay,
  endOfDay,
  startOfMonth,
  endOfMonth,
  getDay,
  addDays,
  addWeeks,
  addMonths,
  subDays,
  subWeeks,
  subMonths,
  isSameDay,
  differenceInCalendarDays,
} from 'date-fns';
import { enUS } from 'date-fns/locale';
import 'react-big-calendar/lib/css/react-big-calendar.css';
import 'react-big-calendar/lib/addons/dragAndDrop/styles.css';
// ONE stylesheet, shared with the legacy schedule page - imported, never forked.
//
// `styles/schedule-dark.css` is not decoration: despite its name it is a light
// theme, and it encodes BEHAVIOUR that lives nowhere else - the expanded-day
// column mechanism keyed off `[data-focus-day="N"]`, the all-day strip
// collapse driven by `.has-allday-events`, the drag-preview geometry read from
// the `--drag-preview-width` / `--drag-preview-left` custom properties this
// page sets on mousedown, the resize-handle hit areas, and the
// `body.is-dragging` grab cursor. Every one of those rules is scoped to
// `.schedule-cal .rbc-*`, i.e. it themes react-big-calendar's own DOM.
//
// react-big-calendar is a KEEP gap for this module: the kit ships no calendar
// VIEW (`ui/calendar` is a react-day-picker date picker), so the engine stays
// and only the chrome around it moves onto the kit. Forking this sheet to
// re-token it would mean re-deriving those structural selectors by hand, which
// is exactly the "port the tokens and drop the structure" failure the module
// brief warns about - and any drift between the two copies would surface as a
// broken drag preview, not as a colour difference. So it is imported as-is and
// recorded in the ledger rather than copied. The sheet moved out of `pages/`
// to `styles/` unchanged so the legacy page can be deleted at cutover.
import '@/styles/schedule-dark.css';
import api from '@/lib/axios';
import { refreshAfterVisitWrite } from '@/lib/refreshAfterVisitWrite';
import { extractApiError } from '@/lib/utils';
import { customerDisplayName } from '@/lib/customer-name';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Input } from '@/ui-kit/components/ui/input';
import { Separator } from '@/ui-kit/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui-kit/components/ui/tooltip';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogIcon,
  DialogTitle,
  DialogDescription,
} from '@/ui-kit/components/ui/dialog';
import { SelectField } from '@/ui-kit/components/form/selectField';
import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { Heading } from '@/ui-kit/components/ui/heading';
import { toast } from '@/ui-kit/components/ui/sonner';
import { useCreateDepartment } from '@/lib/api/departments';
import { AssignJobDialog } from '@/components/jobs/AssignJobDialog';
import { CancelJobDialog } from '@/components/jobs/CancelJobDialog';
import { RescheduleConfirmDialog } from './components/rescheduleConfirmDialog';
import { ConflictModal } from './components/conflictModal';
import type { ScheduleConflictItem } from '@/pages/v2/_shared/scheduleConflict';
import { ContextMenu as ScheduleContextMenu } from './components/contextMenu';
import { SettingsGearDropdown } from './components/settingsGearDropdown';
import { TechnicianGridView } from '@/components/schedule/TechnicianGridView';
import { MemberWeekBoard } from '@/components/schedule/MemberWeekBoard';
import ScheduleSearch from './components/scheduleSearch';
import { ScheduleCreatePopover } from './creation/scheduleCreatePopover';
import { TOOLBAR_CONTROL_H, TOOLBAR_ICON_SIZE, TOOLBAR_TEXT, TOOLBAR_HOVER } from './components/toolbarSizing';
import { UnassignedBuckets } from './components/unassignedBuckets';
import { EventEditor } from './components/eventEditor';
import { EventEntryDialog } from './components/eventEntryDialog';
import { crewNamesOf, eventCrewPeople, fullName } from '@/components/schedule/eventPeople';
import { useScheduleData } from '@/components/schedule/useScheduleData';
import { useScheduleEvents } from '@/components/schedule/useScheduleEvents';
import {
  eventDangerState,
  isCompletedEvent,
  leadKeepsAnotherBookedVisit,
  boardEventStatus,
  isAllDayEvent,
  occupiesAllDayStrip,
  draftFromDrop,
  seedCrewForActor,
  conflictNoteFor,
  hhmmToMin,
  atMinutes,
  swapCrew,
  classifyBoardDrop,
  boardCapabilitiesFor,
  rescheduleGate,
  visitLabel,
  visitLabelCompact,
  IN_FLIGHT_STATUSES,
  type EventType,
  type BoardEvent,
  type ScheduledBoardEvent,
  type SchedulableEvent,
  type ScheduleDraft,
  type DropTarget,
} from '@/components/schedule/scheduleModel';
import {
  ALL_DAY_MAX_ROWS,
  AllDayOverflowPanel,
  AllDayOverflowProvider,
  AllDayShowMore,
  useAllDayOverflow,
} from '@/components/schedule/AllDayOverflow';
import {
  parseBoardDragId,
  JOB_ID,
  WALKTHROUGH_ID,
  PLAN_VISIT_PLAN_ID,
} from '@/components/schedule/dragChannels';
import { UnifiedDropModal } from './components/unifiedDropModal';
import { useAssignableUsers } from '@/lib/api/users';
import { useAssignUserPermission } from '@/lib/users/useAssignUserPermission';
import { useOrganization } from '@/lib/api/organization';
import { useScheduleEventColorVars } from '@/lib/schedule/useScheduleEventColorVars';
import { boardEventPaint } from '@/components/schedule/boardEventPaint';
import { NeedsCrewMark } from '@/components/schedule/NeedsCrewMark';
import {
  DEFAULT_SCHEDULE_TIMEZONE,
  toWallClock,
  nowWallClock,
  wallClockToIso,
  asWallClock,
  addMsToWallClock,
  isoToOrgDay,
  pickerValueToIso,
  formatInstant,
  type WallClock,
} from '@/lib/schedule-tz';
import { type SearchResult } from '@/components/layout/search-shared';
import { highlightedBoardIds, searchHighlightTarget, type SearchHighlightTarget } from './searchHighlight';
import { preferV2Path } from '../uiV2';
import { useRecordVisit } from '../pageBreadcrumbs';
import { EM, EN } from './glyphs';
import { isScheduleOverlayInteraction } from './overlayDismiss';
import { ScheduleConfirmDialog } from './components/confirmDialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui-kit/components/ui/popover';
import { Label } from '@/ui-kit/components/ui/label';
import { TimeCombobox } from '../_shared/timeCombobox';
import { MenuItem, MenuSurface } from './components/menuSurface';
import { EventPeekCard } from './components/eventPeekCard';
import { Segment, SegmentedGroup } from './components/segmented';
import {
  Loader2,
  CheckCircle2,
  Users,
  Calendar as CalIcon,
  CalendarX2,
  CalendarPlus,
  Search,
  ChevronLeft,
  ChevronRight,
  AlertCircle,
  AlertTriangle,
  MapPin,
  ExternalLink,
  Clock,
  PenLine,
  Trash2,
  CheckSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Minus,
  Plus,
} from 'lucide-react';

// ─── Calendar Setup ──────────────────────────────────────

const DnDCalendar = withDnD(Calendar);

const localizer = dateFnsLocalizer({
  format,
  parse,
  startOfWeek: () => startOfWeek(new Date(), { weekStartsOn: 0 }),
  getDay,
  locales: { 'en-US': enUS },
});

// ─── Types ───────────────────────────────────────────────
// The board event is the pure SchedulableEvent (crew: string[] ⟂ start/end) plus optional
// plan-mode ghost flags - see BoardEvent in scheduleModel. Status / all-day are NOT
// event fields anymore; they are read from `raw` via the helpers below.

// ─── Schedule Context (for ScheduleEvent ↔ Page communication) ───────────────

export interface ScheduleContextValue {
  onEventMouseEnter: (event: BoardEvent, x: number, y: number) => void;
  onEventMouseLeave: () => void;
  onEventContextMenu: (event: BoardEvent, x: number, y: number) => void;
  conflictIds: Set<string>;
}

/** Exported because ScheduleEvent reads it, and the card is rendered by react-big-calendar
 *  rather than by this file - the context is how the page reaches its own card renderer. */
export const ScheduleCtx = React.createContext<ScheduleContextValue>({
  onEventMouseEnter: () => {},
  onEventMouseLeave: () => {},
  onEventContextMenu: () => {},
  conflictIds: new Set(),
});

// ─── Business hours ──────────────────────────────────────
// The grid always spans the whole day. A three-preset time-of-day window
// (Full day / Morning / Afternoon) used to narrow `min`/`max` to 07:00-12:00
// or 12:00-18:00 and filter out-of-window events from the board; it was
// removed with its control, so these are constants rather than derived state.
// Module-level so the identities are stable across renders - react-big-calendar
// re-derives its slot metrics whenever `min`/`max` change identity.
const DAY_SCROLL_TO = new Date(1970, 0, 1, 6, 0, 0);

// ─── Helpers ─────────────────────────────────────────────

/** Peek card geometry - kept here so the clamp helpers below can use it. */
const PEEK_W = 290;
const PEEK_H = 210;
const PEEK_HOVER_MS = 320;

/**
 * The visible slice of the day: which hours the grid draws at all.
 *
 * This is the board's zoom. The grid gets a fixed number of pixels either way,
 * so fewer hours on screen means each hour is TALLER - which in turn is what
 * lets a card show its end time and then its address, because ScheduleEvent
 * sizes its content off the real measured box.
 *
 * Stored as minutes from midnight so the arithmetic is plain integers; the
 * seam to react-big-calendar's Date-shaped `min`/`max` is `windowBound` below.
 */
const WINDOW_KEY = 'servwave_schedule_day_window';
const WINDOW_STEP_MIN = 30;
/** A window narrower than this stops being a schedule and becomes a keyhole. */
const WINDOW_MIN_SPAN = 60;
const DEFAULT_WINDOW = { start: 6 * 60, end: 19 * 60 };

/** The windows worth one click. "Full day" is the escape hatch from a narrow one. */
const WINDOW_PRESETS = [
  { label: 'Business', start: 8 * 60, end: 18 * 60 },
  { label: 'Extended', start: 6 * 60, end: 20 * 60 },
  { label: 'Full day', start: 0, end: 24 * 60 },
] as const;

/** The grid always spans the whole day; the focus window never clips it. */
const DAY_MIN = new Date(1970, 0, 1, 0, 0, 0);
const DAY_MAX = new Date(1970, 0, 1, 23, 59, 59);

/** 'HH:MM' <-> minutes, the contract TimeCombobox speaks. */
function minutesToHHMM(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
function hhmmToMinutes(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 08:00 -> "8 AM", 08:30 -> "8:30 AM". For the accessible name and the picker. */
function minutesToLabel(minutes: number): string {
  const h24 = Math.floor(minutes / 60);
  const mm = minutes % 60;
  const suffix = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return mm === 0 ? `${h12} ${suffix}` : `${h12}:${String(mm).padStart(2, '0')} ${suffix}`;
}

/**
 * 08:00 -> "8a", 08:30 -> "8:30a". The toolbar reads this one.
 *
 * The long form pushed the view switcher out of the row: this control sits in a
 * line that already carries Standard/Member, Day/Week/Month and the department
 * filter, and a range is two timestamps wide. Short enough to fit, and the full
 * form is one hover (or one screen reader) away on the button's label.
 */
function minutesToShortLabel(minutes: number): string {
  const h24 = Math.floor(minutes / 60);
  const mm = minutes % 60;
  const suffix = h24 < 12 ? 'a' : 'p';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return mm === 0 ? `${h12}${suffix}` : `${h12}:${String(mm).padStart(2, '0')}${suffix}`;
}
const PEEK_HIDE_MS = 120;

const safeX = (x: number, w: number) => Math.min(x, window.innerWidth - w - 8);
const safeY = (y: number, h: number) => Math.min(y, window.innerHeight - h - 8);

// Status / all-day helpers (isCompletedEvent / isAllDayEvent) moved to
// scheduleModel.ts (M2) - one source for the page + both member views.

// ─── Plan Mode: where a draft says to go (visit-location slice 6) ──────────

/**
 * WHERE a Plan Mode draft sends the crew, given the card it was dragged from and the parent's own
 * service address.
 *
 * Plan Mode is the FIFTH address renderer on this page and the only one that was still painting
 * the customer's street under the word "Location:" for a trip booked at the yard - on the board
 * Admin and Dispatcher plan routes from, which is verbatim the reader user story 15 names. The
 * precedence is the board's own, stated once here rather than four times inline: the TRIP'S OWN
 * location when it has one, the parent's address when it does not.
 *
 * TWO fields out of one rule, because the ghost is read twice and the two readers need different
 * shapes. `locationLabel` rides onto the ghost's board card, which renders through
 * `cardAddressText` and applies this same precedence itself. `address` is the flattened answer the
 * "Schedule Job?" confirm dialog prints. Deriving them separately is how the card and the dialog
 * would come to name two different places for one draft.
 *
 * `parentAddress` is passed in, never re-derived: a job's comes off `service_location` and a
 * walkthrough's off the lead's denormalized columns, and each caller already holds its own.
 */
export function planDraftLocation(
  event: Pick<SchedulableEvent, 'locationLabel'>,
  parentAddress: string,
): { locationLabel: string | null; address: string } {
  const locationLabel = event.locationLabel ?? null;
  return { locationLabel, address: locationLabel || parentAddress };
}

/**
 * A Plan Mode draft of a card already on the board, moved to [start, end) - the one builder the
 * drag and the resize gestures share. The draft keeps the card's current crew.
 */
export function boardCardDraft(
  event: BoardEvent,
  start: WallClock,
  end: WallClock,
  tz: string,
): Omit<GhostEvent, 'id'> {
  const customer = event.raw.customer as { first_name: string; last_name: string } | null;
  const location = event.raw.service_location as { address_line1?: string; city?: string; state?: string } | null;
  // Slice 6: the dragged card IS a trip, so it knows where it is - and it is the drag/resize
  // path, the one a yard-booked visit actually travels. `location` is only the fallback.
  const { locationLabel, address } = planDraftLocation(
    event,
    location ? [location.address_line1, location.city, location.state].filter(Boolean).join(', ') : '',
  );
  return {
    sourceId: event.parentId,
    sourceType: event.type === 'walkthrough' ? 'walkthrough' : 'job',
    // A trip card - a job's visit, or a lead's walkthrough visit (slice 03) - names its trip, so
    // confirming the draft moves THAT visit and no other.
    ...(event.visitId ? { visitId: event.visitId } : {}),
    isFromSidebar: false,
    isMovedConfirmed: false,
    start: wallClockToIso(start, tz),
    end: wallClockToIso(end, tz),
    crew: [...event.crew],
    title: event.title,
    customerName: customer ? customerDisplayName(customer, 'Unknown') : 'Unknown',
    address,
    locationLabel,
    raw: event.raw,
  };
}

/**
 * One plan-mode ghost as the calendar's own event - the ghost read boundary, exactly like
 * eventAdapters.ts is the API's.
 *
 * `g.start`/`g.end` are real instants (see usePlanMode.ts), so this is where they cross into the
 * org wall clock for the grid, once.
 *
 * Module scope rather than inline in the useMemo, so the mapping is reachable by a test. A ghost
 * that silently stopped carrying `locationLabel` would leave its card falling back to the parent's
 * service address - the customer's street on a draft for a yard-booked trip - with no rendered
 * surface complaining.
 */
export function ghostToEvent(g: GhostEvent, tz: string): ScheduledBoardEvent {
  return {
    boardId: `ghost-${g.id}`,
    parentId: g.sourceId,
    type: g.sourceType,
    number: ((g.raw.job_number ?? g.raw.lead_number) as string | undefined) ?? '',
    title: g.title,
    customer: g.customerName,
    crew: g.crew,
    ownerId: null,
    // Visit-location slice 6. Without this a ghost carried NO locationLabel at all, so its card
    // fell through `cardAddressText` to the parent's service address. Carried, not re-derived:
    // the string is the API's, the same one the customer's confirmation email renders.
    locationLabel: g.locationLabel ?? null,
    start: toWallClock(new Date(g.start), tz),
    end: toWallClock(new Date(g.end), tz),
    isGhost: true,
    ghostId: g.id,
    raw: g.raw,
  };
}

// ─── Custom Event Component ──────────────────────────────


/**
 * The card's REAL rendered box, not a guess from its duration.
 *
 * Height used to be estimated as `(minutes / 60) * 48`, which only holds if the
 * grid really is 48px/hour, and width was never considered at all - so a card
 * squeezed to 40px by five overlapping neighbours still rendered a time row and
 * a crew row it had no room for, and truncation ate the customer's name.
 *
 * Returns null until the first measurement, and stays null wherever
 * ResizeObserver does not exist (jsdom). Callers must fall back to the duration
 * estimate in that case, which is what keeps the existing card tests honest -
 * they assert on the height bands and never see a measurement.
 */
function useCardBox<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setBox({ w: rect.width, h: rect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return { ref, box };
}

/**
 * The double-booked state's accessible name - and nothing visible.
 *
 * A "double-booked" badge used to sit on its own line under the title; it became a bare
 * triangle icon because on a narrow card the words cost a line the job number needed. On
 * 2026-09-15 the icon went too (owner): the card's 2px outline announces the state from
 * across the room, and a second mark on the title row was noise beside the trip label and the
 * needs-crew words. What stays is the NAME - a screen reader still hears "Double-booked", the
 * board tests still find the state, and the conflict modal still spells the overlap out in
 * full. Visually, the outline is the whole signal.
 */
function DoubleBookedLabel() {
  return <span className="sr-only">Double-booked</span>;
}

export function ScheduleEvent({ event }: { event: unknown }) {
  const e = event as BoardEvent;
  const { onEventMouseEnter, onEventMouseLeave, onEventContextMenu, conflictIds } = useContext(ScheduleCtx);
  // Called before every early return below - hooks cannot sit behind a branch.
  // Only the timed-card branch reads it; the ghost/all-day branches are already
  // single-line and have nothing to shed.
  const { ref: cardRef, box } = useCardBox<HTMLDivElement>();
  // The two reds (D7 + §3.8 state 4) - precedence resolved once in eventDangerState.
  const dangerState = e.raw ? eventDangerState(e, conflictIds) : null;
  const needsCrew = dangerState === 'needs-crew';
  const doubleBooked = dangerState === 'double-booked';

  const handleMouseEnter = (ev: React.MouseEvent) => {
    if (e.raw) onEventMouseEnter(e, ev.clientX, ev.clientY);
  };
  const handleMouseLeave = () => onEventMouseLeave();
  const handleContextMenu = (ev: React.MouseEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (e.raw) onEventContextMenu(e, ev.clientX, ev.clientY);
  };

  // Ghost preview during external drag-in (no raw)
  if (!e.raw) {
    return (
      <div className="leading-tight overflow-hidden h-full">
        <div className="font-semibold truncate text-[11px]">{e.title}</div>
      </div>
    );
  }

  // Ghost event in plan mode - checked before all-day so a draft of an all-day
  // job still renders with the "draft" badge.
  if (e.isGhost) {
    const ghostCustomer = e.raw.customer as { first_name: string; last_name: string } | null;
    return (
      <div
        className="leading-tight overflow-hidden h-full relative"
        onContextMenu={handleContextMenu}
      >
        {/* Title FIRST: Month view keeps only the first child row (schedule-dark.css, the ONE
            LINE rule), and with the badge mounted first a draft rendered as an empty pill. The
            badge is absolutely positioned, so its DOM slot does not move where it paints; the
            month rule lets it through by its data attribute, as it does the needs-crew notch. */}
        <div className="font-semibold truncate text-[11px]">{e.title}</div>
        <span
          data-draft-badge=""
          className="absolute top-0 right-0 text-[7px] font-bold uppercase tracking-wider
                     text-info-text bg-info-surface px-1 py-0.5 rounded-bl leading-none z-10"
        >
          draft
        </span>
        {ghostCustomer && (
          <div className="truncate text-[10px]">
            {ghostCustomer.first_name} {ghostCustomer.last_name}
          </div>
        )}
      </div>
    );
  }

  // Calendar entry (slice 03, ADR 0002 — "Event"): the card renders the title alone (spec §2 —
  // no record number). Checked before the all-day-strip branch below so a multi-day entry (out
  // of scope until slice 05) never falls into the job/walkthrough label logic there, which reads
  // `e.raw.job_number` / `e.raw.lead_number` — fields a CalendarEntry does not have.
  if (e.type === 'calendar-entry') {
    return (
      <div
        data-board-id={e.boardId}
        // leading-[1.3] as a CLASS, not style={{ lineHeight }}: tokens-guard.test.ts ratchets
        // literal appearance values in style={{}} at 0, and lineHeight is on its
        // APPEARANCE_STYLE_PROPS list. The job/walkthrough branch below reaches the same value
        // through a spread object, which the guard's `style={{` scan does not see.
        className="overflow-hidden h-full flex items-center leading-[1.3]"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onContextMenu={handleContextMenu}
      >
        <span className="font-medium truncate text-[12px]">{e.title}</span>
      </div>
    );
  }

  // All-day STRIP: single-line pill. Gated on the same predicate that opens the strip,
  // not on the is_all_day flag - rbc routes every cross-midnight event here too, and the
  // strip clamps each pill to 22px, so the full card below would spill over the day
  // headers and its neighbours. Whatever lands in the strip gets one line.
  if (occupiesAllDayStrip(e)) {
    // The NUMBER alone - no customer name. Measured on deployed staging at 1280px: this row is
    // 96.3px and the full "number EM customer" string is 254px, so the name never actually
    // rendered here; it only pushed the number out. With `Visit 1 of 5` alongside it, flexbox
    // left the label FOUR characters - `J003` - which is what the next job along renders too.
    // The name is one hover away (the preview card) and spelled out in the overflow panel, which
    // has 288px to spend. Every other all-day surface still carries it.
    const label = e.type === 'job'
      ? (e.raw.job_number as string)
      : ((e.raw.lead_number as string) ?? 'Walkthrough');
    return (
      <div
        data-board-id={e.boardId}
        className="overflow-hidden h-full flex items-center leading-[1.2]"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onContextMenu={handleContextMenu}
      >
        <div className="font-semibold truncate text-[11px] flex items-center gap-1">
          {doubleBooked && <DoubleBookedLabel />}
          <span className="truncate">{label}</span>
          {/* D13 - which trip this pill is. ABBREVIATED here and nowhere else: `Visit 1 of 5`
              is 49.7px of a 96.3px row, and the job number needs 54.6px, so the sentence and
              the identity cannot both fit. `1/5` is ~20px and both do. See visitLabelCompact
              for the measurements. shrink-0 and AFTER the label, so the trip number is not
              what truncation eats. */}
          {visitLabelCompact(e) && (
            <span className="text-[10px] font-medium shrink-0">{visitLabelCompact(e)}</span>
          )}
          {/* No `needs crew` words here, on ANY strip pill. The badge is 62.5px of a ~90px
              row and shrink-0, so whatever else the pill holds, it is the badge that decides
              how much of the job number survives. Measured on deployed staging at 1280px:
              with the badge, J00315 rendered `J0` plus an ellipsis - a pill naming its job in
              TWO characters; without it, the number renders whole (40.5px against a 40px
              scrollWidth). The earlier "yield only when a trip number is present" rule left
              exactly that pill unhelped, and made the pill show either the badge or the trip
              chip, never both, for no reason a reader could see.
              The warning is not lost. The corner notch below carries the state at 10px and takes
              no room from the number (it is absolutely positioned against the rbc-event), the
              hover preview spells it out, and the overflow panel carries the words
              (AllDayOverflow.tsx) - the surface that has 288px to spend on them. */}
        </div>
        {needsCrew && <NeedsCrewMark size="sm" />}
      </div>
    );
  }

  // Only scheduled events reach the calendar; the guard narrows start/end for TS.
  if (!e.start || !e.end) return null;

  // ─── Common data extraction ───────────────────────────
  const customer = e.raw.customer as { first_name: string; last_name: string } | null;
  const customerName = customer ? customerDisplayName(customer, '') : '';

  /* ── Content by size, in one fixed order of importance ──────────────────
   *
   * Ran's hierarchy, and the order rows are given up in as a card shrinks:
   *
   *   1. title            always - a card that says nothing is not a card
   *   2. start time       "8:00 AM"
   *   3. end time         promotes row 2 to "8:00 AM - 10:00 AM"
   *   4. address
   *   5. "needs crew"     the words; the red fill already carries the meaning
   *
   * Both axes gate, because a row needs room in two directions and a
   * half-rendered one is worse than an omitted one - a clipped address is
   * noise on top of a clipped name. Height comes from the real measured box
   * wherever there is one, so the slot-height control in the toolbar changes
   * what a card shows: buy height, get detail.
   *
   * Technician names are deliberately NOT on this list - they were on the old
   * card, they are not in the hierarchy above, and they are the first thing the
   * hover card shows. Say the word and they go back in after the address. */
  const durationMin = (e.end.getTime() - e.start.getTime()) / (1000 * 60);
  // 48px/hour is react-big-calendar's default row height, and the only number
  // available before the first measurement (and under jsdom, which has no
  // ResizeObserver - that fallback is what keeps the card tests honest).
  const cardHeight = box?.h ?? (durationMin / 60) * 48;
  // An unmeasured width must not shed anything, so it reads as unbounded.
  const cardWidth = box?.w ?? Number.POSITIVE_INFINITY;

  const showStart = cardHeight >= 28 && cardWidth >= 56;
  const showEnd = showStart && cardWidth >= 118;
  const showAddress = cardHeight >= 44 && cardWidth >= 124;
  const showNeedsCrewText = cardHeight >= 58 && cardWidth >= 84;

  const timeStr = showEnd
    ? `${format(e.start, 'h:mm a')} ${EN} ${format(e.end, 'h:mm a')}`
    : format(e.start, 'h:mm a');

  // Under ~108px there is no room for a sentence. The number is short, fixed
  // width and unique, so it survives where "J00412 - Halvorsen Reside..." would
  // have become a vertical stripe of clipped letters; the full card is one hover
  // or one click away.
  const compact = cardWidth < 108;

  const wrapperProps = {
    // The card's identity on the board (multi-visit S6): one per VISIT, never per job.
    'data-board-id': e.boardId,
    ref: cardRef,
    className: 'overflow-hidden h-full flex flex-col',
    style: { lineHeight: '1.3' } as React.CSSProperties,
    onMouseEnter: handleMouseEnter,
    onMouseLeave: handleMouseLeave,
    onContextMenu: handleContextMenu,
  };

  if (e.type === 'walkthrough') {
    const leadNumber = e.raw.lead_number as string | undefined;
    // Slice 6: where the TRIP is, falling back to the lead's service address. A walkthrough held
    // at the showroom used to paint the customer's own street here, which is the one kind of wrong
    // a dispatcher cannot catch by reading harder.
    const wtAddress = e.locationLabel
      || [e.raw.service_address_line1, e.raw.service_city, e.raw.service_state]
        .filter(Boolean).join(', ');

    // Row 1 (title): always shown - "L00041 - Customer Name", or the bare number
    // when the box is too narrow to carry the name without clipping it.
    const title = compact
      ? (leadNumber ?? '')
      : `${leadNumber ?? ''}${customerName ? ` ${EN} ${customerName}` : ''}`;

    return (
      <div {...wrapperProps}>
        <div className="font-bold truncate text-[13px] flex items-center gap-1">
          {doubleBooked && <DoubleBookedLabel />}
          <span className="truncate">{title}</span>
          {/* D13 - which walkthrough this is (visits slice 03): a lead booked twice in a week
              paints two cards here, and the same visitLabel as the job branch below tells them
              apart. Silent for a lead with one trip. */}
          {visitLabel(e) && (
            <span className="text-[10px] font-medium shrink-0">{visitLabel(e)}</span>
          )}
        </div>
        {/* After the title, never before it - see the job branch below. */}
        {needsCrew && <NeedsCrewMark />}
        {showStart && <div className="truncate text-xs">{timeStr}</div>}
        {showAddress && wtAddress && (
          <div className="truncate text-[11px] flex items-center gap-1 mt-auto">
            <MapPin className="h-3 w-3 shrink-0" />
            {wtAddress}
          </div>
        )}
        {needsCrew && showNeedsCrewText && (
          <div className="text-[9px] font-bold uppercase tracking-wider">needs crew</div>
        )}
      </div>
    );
  }

  // ─── Job event ─────────────────────────────────────────
  const location = e.raw.service_location as { address_line1?: string; city?: string; state?: string } | null;
  // Slice 6: this TRIP's own location first - the job's service address is only where the trip is
  // when the trip does not say otherwise. See the walkthrough branch above.
  const jobType = typeof e.raw.job_type === 'string' ? e.raw.job_type : '';
  const address = e.locationLabel
    || (location ? [location.address_line1, location.city, location.state].filter(Boolean).join(', ') : '');

  // Row 1 (title): always shown - "JOB-2026-0050 - Customer Name", or the bare
  // number when the box is too narrow to carry the name without clipping it.
  const jobTitle = compact
    ? (e.raw.job_number as string)
    : `${e.raw.job_number as string}${customerName ? ` ${EN} ${customerName}` : ''}`;

  return (
    <div {...wrapperProps}>
      <div className="font-bold truncate text-[13px] flex items-center gap-1">
        {doubleBooked && <DoubleBookedLabel />}
        <span className="truncate">{jobTitle}</span>
        {/* D13 - which trip this card is. Three visits of one job paint three cards here, and
            without this they are byte-identical. The words and the silent-when-single condition
            are visitLabel's, shared with ScheduleCardBody (the other two boards) so a dispatcher
            reads the SAME sentence whichever board is open; only this size is local.
            It sits on the always-shown title row rather than behind a height threshold: a card
            you cannot tell apart is worse than a card missing its address. Deliberately below
            the no-raw and ghost early returns above - a drag-in preview and a plan-mode draft
            are not a trip yet, so neither is numbered. */}
        {visitLabel(e) && (
          <span className="text-[10px] font-medium shrink-0">{visitLabel(e)}</span>
        )}
      </div>
      {/* The needs-crew signal - absolutely positioned against the rbc-event, so it takes no room
          from any row below. See NeedsCrewMark for why that is the whole point. It must NOT be
          the wrapper's first child: Month view keeps only the `:first-child` row of this card and
          hides the rest (schedule-dark.css, the ONE LINE rule), so a notch mounted first became
          the one row kept and hid the title - every crewless pill collapsed to a bare red sliver.
          Its DOM slot does not move where it paints; the month rule lets it through by its
          data attribute. */}
      {needsCrew && <NeedsCrewMark />}
      {showStart && <div className="truncate text-xs">{timeStr}</div>}
      {/* Job type, above the address (owner, 2026-09-14): the org's own label off the job row.
          Gated with the START TIME, not the address (owner, 2026-09-15): the address needs
          124px of width, which on a dense day almost no card has, and gating the type with it
          made the type invisible on exactly the board it was asked for. The type is one short
          word, so it fits where the time fits. It does not steal the last line from the address:
          a card tall enough for the address (44px) already has room for both. */}
      {showStart && jobType && (
        <div className="truncate text-[11px]">{jobType}</div>
      )}
      {showAddress && address && (
        <div className="truncate text-[11px] flex items-center gap-1 mt-auto">
          <MapPin className="h-3 w-3 shrink-0" />
          {address}
        </div>
      )}
      {needsCrew && showNeedsCrewText && (
        <div className="text-[9px] font-bold uppercase tracking-wider">needs crew</div>
      )}
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────

/** The exclusive end of an all-day block: the next CALENDAR day in `tz`, as an instant.
 *  Deliberately not `instant + 24h`, which is an hour out on either DST transition. */
function allDayEndIso(startIso: string, tz: string): string {
  const [y, m, d] = isoToOrgDay(startIso, tz).split('-').map(Number);
  const nextDay = new Date(Date.UTC(y!, m! - 1, d! + 1)).toISOString().slice(0, 10);
  return pickerValueToIso(nextDay, tz)!;
}

/**
 * Post-QA fix (drag/resize "notify participants" toast; PO-reported 2026-08-25, corrected
 * 2026-08-25) — words the notify-moved follow-up toast off the real per-customer outcome instead
 * of a flat claim. `notifyMoved` (calendar-entry.controller.ts) returns `notify.customers`
 * (CustomerNotifyRecord[]), one record per CUSTOMER participant it attempted, each carrying the
 * ONLY statuses that route can produce: 'sent', 'failed', 'skipped' (blocked - a suppressed
 * address or a disabled/misconfigured sender, see EmailDispatchResult in lib/email.ts), or
 * 'no_recipient' (no email on file). An EMPTY array with a customer participant on the entry
 * means the idempotency guard (that route's own doc comment) dropped every eligible customer
 * because each was already told about this exact move - not a failure, nothing new to send.
 */
function describeCalendarEntryNotifyOutcome(customers: { status: string }[]): string {
  if (customers.length === 0) {
    return `Already notified ${EM} nothing new to send.`;
  }
  const sent = customers.filter((c) => c.status === 'sent').length;
  if (sent === customers.length) {
    return `${sent} participant${sent === 1 ? '' : 's'} notified`;
  }
  if (sent > 0) {
    return `${sent} of ${customers.length} participants notified ${EM} the rest could not be reached.`;
  }
  if (customers.every((c) => c.status === 'no_recipient')) {
    return `No email on file ${EM} nothing was sent.`;
  }
  if (customers.some((c) => c.status === 'failed')) {
    return 'The notification could not be sent. Please try again.';
  }
  // The only status left the backend can return for this batch: 'skipped' - blocked by policy.
  return 'The notification was blocked and not sent.';
}

export default function SchedulePage() {
  // Records the visit; renders nothing. The board gave up its PageHeader on
  // purpose (see the note in the render below) and a crumb strip would take
  // that height straight back. But a page that records nothing is a HOLE in
  // everyone else's trail: walk Leads -> Schedule -> Invoices and the crumb on
  // Invoices skips Schedule entirely, which is what makes the trail look like
  // it restarted itself.
  useRecordVisit('schedule');

  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const authUser = useAuthStore((s) => s.user);
  const canPlanMode = authUser?.role === 'ADMIN' || authUser?.role === 'DISPATCHER';

  // Declared early (not just before use) because `tz` has to exist before
  // `currentDate`'s initial state below - the scheduler renders and writes in
  // the ORG's wall clock, not the viewer's browser zone (see
  // frontend/src/lib/schedule-tz.ts for why).
  const { data: org } = useOrganization();
  const tz = org?.timezone || DEFAULT_SCHEDULE_TIMEZONE;

  // The org's per-type board colours, as custom properties: the accent aliases for customised
  // types (an UNSET type falls through to the token default in tokens.css), and the card colours
  // DERIVED from every type's accent so each card's text clears WCAG AA whatever the org picked
  // (lib/schedule/useScheduleEventColorVars, design-system/eventCardColors.ts).
  //
  // Written on documentElement, NOT on this page's root div, and the distinction is load-bearing:
  // custom properties inherit through the DOM, and three schedule surfaces do not live in this
  // page's DOM subtree. The legend popover, the event editor and the unified drop modal are Radix
  // portals, which mount into document.body (@radix-ui/react-portal) - a sibling of #root, not a
  // descendant of anything this page renders. Scoped to the page div they would keep painting the
  // default colours on a recoloured board, which makes the legend wrong about the board it exists
  // to explain. The same reach is what lets the drag chip work: it is a detached node appended to
  // document.body.
  // Safe to hoist this high because the ev-* utilities are used ONLY by the scheduler - nothing
  // else in the app resolves them - and the hook removes them on unmount so the properties do
  // not outlive the page.
  useScheduleEventColorVars(org?.schedule_event_colors, { writeToRoot: true });

  // D9 (TG13) - role-gated UI CONTROLS (data scoping is server-side, PR A scopeWhereFor).
  // Destructured to primitives so they're stable useCallback/useEffect deps.
  const { memberView: canMemberView, readOnly: boardReadOnly } = boardCapabilitiesFor(
    authUser?.role,
  );

  // View / navigation state
  // "Today" is the org's today, not the browser's - a Manila viewer and a New
  // York viewer must land on the same calendar day.
  const [currentDate, setCurrentDate] = useState<WallClock>(() => nowWallClock(tz));
  const [calendarView, setCalendarView] = useState<string>(Views.WEEK);
  const [isGroupedView, setIsGroupedView] = useState(false);
  // D9 render-time fallback: without the member-view capability the board is ALWAYS
  // standard, even if isGroupedView somehow flips (keyboard shortcut, future persistence).
  const effectiveGroupedView = canMemberView && isGroupedView;
  // Left sidebar (search + walkthroughs + unassigned jobs) collapse toggle.
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Drag-to-resize sidebar width (#193) - persisted per device, clamped 180-420.
  const { width: sidebarWidth, startResize: startSidebarResize } = useResizableWidth({
    storageKey: 'schedule-sidebar-width',
    defaultWidth: 240,
    min: 180,
    max: 420,
  });
  // Week view: index (0-6) of the day column expanded via double-click; null = all equal width.
  const [focusedDayIndex, setFocusedDayIndex] = useState<number | null>(null);
  const [roleFilter, setRoleFilter] = useState<string>('all');
  const [departmentFilter, setDepartmentFilter] = useState<string>('all');

  // Create-department affordance ("+ Add department" in the filter dropdown).
  const createDept = useCreateDepartment();
  const [addDeptOpen, setAddDeptOpen] = useState(false);
  const [newDeptName, setNewDeptName] = useState('');

  const submitCreateDepartment = async () => {
    const name = newDeptName.trim();
    if (!name) return;
    const res = await createDept.mutateAsync(name);
    const newId = (res as { department?: { id: string } } | undefined)?.department?.id;
    if (newId) setDepartmentFilter(newId);
    setAddDeptOpen(false);
    setNewDeptName('');
  };

  // Departments for filter dropdown
  const { data: departments } = useQuery({
    queryKey: ['departments'],
    queryFn: async () => {
      const { data } = await api.get('/api/departments');
      return data.departments as Array<{ id: string; name: string }>;
    },
    staleTime: 5 * 60_000,
  });
  const dateRange = useMemo<{ start: WallClock; end: WallClock }>(() => {
    if (calendarView === Views.DAY) {
      return { start: asWallClock(startOfDay(currentDate)), end: asWallClock(endOfDay(currentDate)) };
    } else if (calendarView === Views.MONTH) {
      const ms = startOfMonth(currentDate);
      const me = endOfMonth(currentDate);
      return {
        start: asWallClock(startOfWeek(ms, { weekStartsOn: 0 })),
        end: asWallClock(endOfWeek(me, { weekStartsOn: 0 })),
      };
    }
    return {
      start: asWallClock(startOfWeek(currentDate, { weekStartsOn: 0 })),
      end: asWallClock(endOfWeek(currentDate, { weekStartsOn: 0 })),
    };
  }, [currentDate, calendarView]);

  // Search highlight: what the last search result pointed at, for three seconds (searchHighlight.ts).
  const [highlightTarget, setHighlightTarget] = useState<SearchHighlightTarget | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // TG12 event editor - opened by every live board/bucket card click. Stores only the
  // ID; the live event re-derives from the query collections so saves refresh in place.
  const [editorEventId, setEditorEventId] = useState<string | null>(null);

  // Slice 04 - the Event dialog. A calendar entry never reaches EventEditor (its `open`
  // gate rejects `type === 'calendar-entry'` below), so it gets its own id + create flag,
  // same "store the id, re-derive the live event" rule as editorEventId above.
  const [eventEntryId, setEventEntryId] = useState<string | null>(null);
  const [eventEntryCreateOpen, setEventEntryCreateOpen] = useState(false);
  // QA finding 3 (slice 05, calendar-entries spec §3 "What to build") - lets the all-day slot
  // popover's "New Event" seed the dialog from where the user clicked, same "store the seed,
  // dialog owns its own draft state" shape as eventEntryId above. null (the plain toolbar "New
  // Event" button never sets this) falls back to the dialog's own "now, one hour, timed" default.
  const [eventEntryCreateSeed, setEventEntryCreateSeed] = useState<{
    start: WallClock; end: WallClock; isAllDay?: boolean;
  } | null>(null);

  // Hover tooltip
  // Tooltip removed - left-click popup provides all event info

  // Context menu
  const [contextMenu, setContextMenu] = useState<{ event: BoardEvent; x: number; y: number } | null>(null);

  /**
   * THE creation surface's anchor + seed. Both entry points - the toolbar's Create button and
   * a click on an empty grid slot - write here, and ScheduleCreatePopover is the only thing
   * that reads it. The old two-window flow (QuickScheduleCard -> AssignJobDialog /
   * EventEntryDialog) is no longer reachable from this page; those components remain in the
   * tree, unwired, pending review.
   */
  /**
   * Whether the creation popover is on screen, readable synchronously.
   *
   * A click on an empty slot while it is already open is an OUTSIDE click first and a slot
   * click second. Radix dismisses on pointerdown, before rbc's select handler runs, so
   * without this guard the same click both dismissed the popover and immediately re-seeded
   * it at the new slot - and on a dirty form that meant the "Discard this draft?" prompt
   * appeared over a popover that had already moved and re-seeded itself. One click closes,
   * the next opens at the new slot. `useState` alone cannot answer this: its update is
   * still queued when the select handler reads it.
   */
  const createPopoverOpenRef = useRef(false);
  const [createPopover, setCreatePopover] = useState<{
    x: number; y: number; seed: { start: WallClock; end: WallClock; isAllDay?: boolean } | null;
  } | null>(null);
  // Mirrored in an effect, not during render: writing a ref while rendering is the hazard
  // `react-hooks/refs` exists for. The effect has flushed long before the next pointer
  // event, which is the only place this is read.
  useEffect(() => {
    createPopoverOpenRef.current = Boolean(createPopover);
  }, [createPopover]);

  // Slot-click popover
  const [slotPopover, setSlotPopover] = useState<{ x: number; y: number; start: string; end: string } | null>(null);

  /** The hours on screen. Remembered per browser - it is a viewing habit. */
  const [dayWindow, setDayWindow] = useState<{ start: number; end: number }>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(WINDOW_KEY) ?? 'null') as
        | { start: number; end: number }
        | null;
      if (stored && Number.isFinite(stored.start) && Number.isFinite(stored.end) && stored.end - stored.start >= WINDOW_MIN_SPAN) {
        return stored;
      }
    } catch {
      // A corrupt preference is not worth a broken board.
    }
    return DEFAULT_WINDOW;
  });

  const commitWindow = useCallback((next: { start: number; end: number }) => {
    const start = Math.max(0, Math.min(24 * 60 - WINDOW_MIN_SPAN, next.start));
    const end = Math.min(24 * 60, Math.max(start + WINDOW_MIN_SPAN, next.end));
    const value = { start, end };
    setDayWindow(value);
    localStorage.setItem(WINDOW_KEY, JSON.stringify(value));
  }, []);

  /** Widen (+1) or narrow (-1) by half an hour at BOTH ends, as Ran asked:
   *  6:00 AM - 5:00 PM widens to 5:30 AM - 5:30 PM. Each end clamps on its own,
   *  so a window already touching midnight still grows at the other end. */
  const nudgeWindow = useCallback(
    (direction: 1 | -1) => {
      commitWindow({
        start: dayWindow.start - direction * WINDOW_STEP_MIN,
        end: dayWindow.end + direction * WINDOW_STEP_MIN,
      });
    },
    [commitWindow, dayWindow],
  );

  const [windowPickerOpen, setWindowPickerOpen] = useState(false);

  /**
   * The focus window as pixels, not as a clip.
   *
   * An earlier cut of this narrowed the grid's own min/max, which meant
   * react-big-calendar clamped every out-of-window job to the top or bottom
   * edge as a sliver - so those jobs had to be filtered out, and narrowing the
   * window HID work. Wrong tool: the window is about where a dispatcher is
   * looking, not about which jobs exist.
   *
   * So the grid keeps all 24 hours and stays scrollable end to end, and the
   * window only decides how tall an hour is: enough that the chosen hours fill
   * the visible grid exactly. Fewer hours in focus, taller hours, more room on
   * every card - and everything outside is one scroll away, as before.
   */
  const calendarWrapRef = useRef<HTMLDivElement>(null);
  const [gridViewportPx, setGridViewportPx] = useState(0);

  useLayoutEffect(() => {
    const wrap = calendarWrapRef.current;
    if (!wrap || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const content = wrap.querySelector('.rbc-time-content');
      setGridViewportPx(content ? content.clientHeight : 0);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [calendarView, effectiveGroupedView]);

  const hourHeight = useMemo(() => {
    const hoursInFocus = (dayWindow.end - dayWindow.start) / 60;
    if (!gridViewportPx || hoursInFocus <= 0) return null;
    // Never below the stylesheet's own floor: a 24-hour focus on a short
    // viewport would otherwise squeeze rows until the labels collide.
    return Math.max(28, gridViewportPx / hoursInFocus);
  }, [gridViewportPx, dayWindow]);

  // Put the window's first hour at the top when the window changes - and only
  // then, so a dispatcher who has scrolled somewhere is not yanked back.
  useEffect(() => {
    if (!hourHeight) return;
    const content = calendarWrapRef.current?.querySelector('.rbc-time-content');
    if (content) content.scrollTop = (dayWindow.start / 60) * hourHeight;
  }, [dayWindow, hourHeight]);

  const canWiden = dayWindow.start > 0 || dayWindow.end < 24 * 60;
  const canNarrow = dayWindow.end - dayWindow.start > WINDOW_MIN_SPAN;

  /** Hover preview / pinned detail card for one event. */
  const [peek, setPeek] = useState<{ event: BoardEvent; x: number; y: number; pinned: boolean } | null>(null);


  // All-day slot popover (from day header click)
  const [allDaySlotPopover, setAllDaySlotPopover] = useState<{
    x: number; y: number; date: string;
  } | null>(null);
  const lastMousePos = useRef({ x: 0, y: 0 });
  /** Anchors the unified creation popover to the toolbar Create button. */
  const createButtonRef = useRef<HTMLButtonElement>(null);

  // Drag state
  const draggingJobIdRef = useRef<string | null>(null);

  // ─── All-day strip overflow ──────────────────────────
  // Spec: md_files/plans/scheduler/2026-08-24-allday-strip-overflow-spec.md
  // A drag in flight suppresses the hover-open and closes an open panel; rbc's
  // dnd addon marks the calendar root while one of its own drags is running.
  const isBoardDragging = useCallback(
    () => Boolean(draggingJobIdRef.current)
      || Boolean(document.querySelector('.rbc-addons-dnd-is-dragging')),
    [],
  );
  const {
    state: allDayOverflow,
    api: allDayOverflowApi,
    close: closeAllDayOverflow,
  } = useAllDayOverflow(isBoardDragging);

  // Sidebar drag visual state - pv- plan-visit cards only (UnassignedBuckets owns its own).
  const [draggingSidebarId, setDraggingSidebarId] = useState<string | null>(null);

  // Service Plans bucket - every ACTIVE plan with remaining visits (admin/dispatcher only).
  const ability = useAppAbility();
  // useModuleAccess, not ability.can: /api/service-plans sits behind
  // requireFeature('service_plans') (Pro) while Scheduling is Starter core, and an
  // admin passes every CASL check regardless of what the org pays for. This drives
  // both the scheduler-bucket fetch and the plan rail below, so the rail disappears
  // instead of sitting empty behind a 402.
  const canSeePlans = useModuleAccess('service_plans', 'read', 'ServicePlan');
  const leadsEnabled = useFeature('leads');
  // ADMIN-only backend gate (POST /api/departments) mirrored in the UI.
  const canCreateDepartment = ability.can('create', 'Department');
  // Slice 04 - "New Event" affordance, gated on the CalendarEntry grant (spec §4).
  const canCreateCalendarEntry = ability.can('create', 'CalendarEntry');
  const { data: planBucket } = useSchedulerBucket(canSeePlans);
  const scheduleVisitMutation = useScheduleVisit();

  // Sidebar card context menu
  const [sidebarContextMenu, setSidebarContextMenu] = useState<{
    x: number;
    y: number;
    type: 'walkthrough' | 'job';
    id: string;
  } | null>(null);

  // Dialog / modal state. (defaultTechId is gone - TG10 removed the dialog's only
  // member-seeded path; board-card drops now swap/reschedule directly, never open it.)
  const [assignDialog, setAssignDialog] = useState<{
    open: boolean;
    jobId: string;
    defaultStart?: string;
    defaultEnd?: string;
    defaultIsAllDay?: boolean;
  }>({ open: false, jobId: '' });

  const [cancelDialog, setCancelDialog] = useState<{ open: boolean; jobId: string }>({
    open: false,
    jobId: '',
  });

  // Reschedule confirmation dialog state (Task 11). A standard-view drag moves TIME only;
  // the crew rides along unchanged (crew ⟂ schedule), so there is no "new tech" anymore.
  const [rescheduleConfirm, setRescheduleConfirm] = useState<{
    event: BoardEvent;
    oldStart: WallClock;
    oldEnd: WallClock;
    newStart: WallClock;
    newEnd: WallClock;
  } | null>(null);

  // No composer state on this page any more: customer notifications for a moved or removed trip
  // come only from the org's automations (scheduling-notifications slice 01 and follow-up f3),
  // so none of the reschedule or unschedule mutations below take or send notify keys.

  // Temporary position override for event during confirmation dialog - carries the crew.
  const [pendingMove, setPendingMove] = useState<{
    eventId: string;
    newStart: WallClock;
    newEnd: WallClock;
    crew: string[];
  } | null>(null);

  // Toast state. The pending payload is discriminated so "Schedule Anyway" can re-POST
  // force:true through the right mutation (jobs AND walkthroughs - TG9 fold-in).
  const [conflictToast, setConflictToast] = useState<{
    message: string;
    conflicts?: ScheduleConflictItem[];
    pendingPayload:
      | { kind: 'job'; jobId: string; crew: string[]; start: string; end: string }
      // Multi-visit S6 (D21): the board's main gesture moves ONE trip, so the force retry has to
      // name that trip - re-POSTing /assign would push the job's earliest upcoming visit instead.
      | { kind: 'visit'; jobId: string; visitId: string; start: string; end: string }
      | { kind: 'walkthrough'; leadId: string; visitId?: string; newStart: string; crew: string[]; durationMinutes: number };
  } | null>(null);

  // ── D6 drag-to-unschedule (TG10) ───────────────────────
  // Dragging a BOARD card onto the Unscheduled sidebar clears its TIME but KEEPS the
  // crew (state 2 → 3). Distinct from Cancel - no reason, no customer email.
  const [unscheduleConfirm, setUnscheduleConfirm] = useState<SchedulableEvent | null>(null);

  // ── D5 unified drop modal (TG9) ────────────────────────
  // Every drop FROM an Unassigned bucket onto the board opens this one modal, pre-filled
  // by where it landed (draftFromDrop). The page owns the draft; the modal is controlled.
  const [dropModal, setDropModal] = useState<{ event: SchedulableEvent; draft: ScheduleDraft } | null>(null);
  // Empty-crew confirm (§3.8 state 4 is valid but deliberate): the drop modal hides while
  // this warning overlay is up - stacking a plain overlay over a Radix dialog would fight
  // its focus lock / outside-click close.
  const [needsCrewConfirm, setNeedsCrewConfirm] = useState(false);

  // ─── Global search → jump to event ─────────────────
  const handleSearchSelect = useCallback((result: SearchResult) => {
    if (result.date) {
      // Jump calendar to that date
      setCurrentDate(toWallClock(new Date(result.date), tz));
      // A job or lead result names the parent and the trip it found; the board lights that trip's
      // card (PRD story 9). An Event (Slice 09, `ce-${id}` - eventAdapters.ts' calendarEntryToEvent
      // mints the same prefix) or a plan names its card. See searchHighlight.ts.
      setHighlightTarget(searchHighlightTarget(result, tz));
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = setTimeout(() => setHighlightTarget(null), 3000);
    }
  }, [tz]);
  const [errorToast, setErrorToast] = useState<string | null>(null);

  // ─── Plan Mode ─────────────────────────────────────────

  const planMode = usePlanMode();

  // D9 hardening - plan mode restores isActive from localStorage, so a session whose
  // role can't plan (read-only / role-less) could otherwise see the banner + ghosts and
  // Confirm-All would fire raw POSTs. forceDeactivate clears the drafts without posting.
  useEffect(() => {
    if (!canPlanMode && planMode.isActive) planMode.forceDeactivate();
  }, [canPlanMode, planMode]);

  const [showExitDialog, setShowExitDialog] = useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = useState<{
    ghostId: string;
    ghost: GhostEvent;
  } | null>(null);
  const [showConfirmAllDialog, setShowConfirmAllDialog] = useState(false);
  const [confirmingGhostIds, setConfirmingGhostIds] = useState<Set<string>>(new Set());

  // Ghost context menu state
  const [ghostContextMenu, setGhostContextMenu] = useState<{
    ghostId: string;
    x: number;
    y: number;
  } | null>(null);

  // Close ghost context menu on outside click
  useEffect(() => {
    if (!ghostContextMenu) return;
    const handler = () => setGhostContextMenu(null);
    const timer = setTimeout(() => document.addEventListener('click', handler), 50);
    return () => { clearTimeout(timer); document.removeEventListener('click', handler); };
  }, [ghostContextMenu]);

  // Plan mode toggle handler
  const handlePlanModeToggle = useCallback(() => {
    if (planMode.isActive) {
      const exited = planMode.deactivate();
      if (!exited) setShowExitDialog(true);
    } else {
      planMode.activate();
    }
  }, [planMode]);

  // beforeunload warning when ghosts exist
  useEffect(() => {
    if (!planMode.isActive || planMode.ghostCount === 0) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [planMode.isActive, planMode.ghostCount]);

  // Browser-level navigation warning (beforeunload) when plan mode has ghosts
  useEffect(() => {
    if (!planMode.isActive || planMode.ghostCount === 0) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [planMode.isActive, planMode.ghostCount]);

  // Confirm ghost - calls API then removes ghost
  const handleConfirmGhost = useCallback(async (ghostId: string) => {
    const ghost = planMode.getGhostById(ghostId);
    if (!ghost) return;

    setConfirmingGhostIds((prev) => new Set(prev).add(ghostId));
    try {
      // REPLACE semantics: the ghost's full crew array ([] = schedule with no crew -
      // valid, surfaces as state 4). Any 4xx is caught below, surfaced as a toast,
      // and the ghost is left in place.
      if (ghost.sourceType === 'job' && ghost.visitId) {
        // A draft of a TRIP (slice 02): the per-visit reschedule request the board's own visit
        // drag sends (visitRescheduleMutation) - time only, crew omitted, so it moves exactly this
        // visit and re-crews nobody. `/assign` below moves the job's NEXT visit and states crew
        // job-wide, which moved visit 1 and emptied its crew when visit 2 was drafted.
        await api.patch(`/api/jobs/${ghost.sourceId}/visits/${ghost.visitId}`, {
          scheduled_start: ghost.start,
          scheduled_end: ghost.end,
        });
      } else if (ghost.sourceType === 'job') {
        await api.post(`/api/jobs/${ghost.sourceId}/assign`, {
          assignee_ids: ghost.crew,
          scheduled_start: ghost.start,
          scheduled_end: ghost.end,
        });
      } else {
        // A draft of a walkthrough TRIP (slice 03) moves that trip through its own door; a draft
        // from the Unscheduled bucket names none and books through the lead-level door. Same body
        // either way - the performers are the card's own, restated.
        const body = {
          walkthrough_scheduled_at: ghost.start,
          performer_ids: ghost.crew,
          walkthrough_duration_minutes: Math.round(
            (new Date(ghost.end).getTime() - new Date(ghost.start).getTime()) / 60000,
          ),
        };
        if (ghost.visitId) {
          await api.patch(`/api/leads/${ghost.sourceId}/visits/${ghost.visitId}`, body);
        } else {
          await api.post(`/api/leads/${ghost.sourceId}/walkthrough/schedule`, body);
        }
      }
      planMode.removeGhost(ghostId);
      refreshAfterVisitWrite(
        queryClient,
        ghost.sourceType === 'job' ? { jobId: ghost.sourceId } : { leadId: ghost.sourceId },
      );
    } catch (err) {
      setErrorToast(extractApiError(err, 'Failed to confirm schedule change.'));
    } finally {
      setConfirmingGhostIds((prev) => {
        const next = new Set(prev);
        next.delete(ghostId);
        return next;
      });
    }
  }, [planMode, queryClient]);

  // Confirm all visible ghosts
  const handleConfirmAllGhosts = useCallback(async () => {
    const visible = planMode.getGhostsForView(dateRange.start, dateRange.end);
    let succeeded = 0;
    let failed = 0;
    for (const ghost of visible) {
      try {
        await handleConfirmGhost(ghost.id);
        succeeded++;
      } catch {
        failed++;
      }
    }
    setShowConfirmAllDialog(false);
    if (failed > 0) {
      setErrorToast(`${succeeded} of ${succeeded + failed} scheduled. ${failed} failed ${EM} resolve manually.`);
    }
  }, [planMode, dateRange, handleConfirmGhost]);

  // Ghost context menu handler for all views
  const handleGhostContextMenu = useCallback((ghostId: string, x: number, y: number) => {
    setGhostContextMenu({ ghostId, x, y });
  }, []);

  // ─── Mouse position tracking (for slot popover) ──────

  useEffect(() => {
    const track = (e: MouseEvent) => { lastMousePos.current = { x: e.clientX, y: e.clientY }; };
    window.addEventListener('mousemove', track);
    return () => window.removeEventListener('mousemove', track);
  }, []);

  // ─── Drag width capture (GCal: preview matches original event width) ────

  useEffect(() => {
    const calendarEl = document.querySelector('.schedule-cal') as HTMLElement | null;
    if (!calendarEl) return;

    const handleMouseDown = (e: MouseEvent) => {
      const eventEl = (e.target as HTMLElement).closest('.rbc-event') as HTMLElement | null;
      if (eventEl) {
        const eventRect = eventEl.getBoundingClientRect();
        // Find the day column container to calculate relative left offset
        const columnEl = eventEl.closest('.rbc-day-slot') || eventEl.closest('.rbc-time-column');
        const columnRect = columnEl?.getBoundingClientRect();
        const leftOffset = columnRect ? eventRect.left - columnRect.left : 0;

        calendarEl.style.setProperty('--drag-preview-width', `${eventRect.width}px`);
        calendarEl.style.setProperty('--drag-preview-left', `${leftOffset}px`);
      }
    };

    const handleMouseUp = () => {
      calendarEl.style.removeProperty('--drag-preview-width');
      calendarEl.style.removeProperty('--drag-preview-left');
    };

    calendarEl.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      calendarEl.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  // ─── Keyboard shortcuts ──────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (e.key === 't' || e.key === 'T') setCurrentDate(nowWallClock(tz));
      if (e.key === '1') setCalendarView(Views.DAY);
      if (e.key === '2') setCalendarView(Views.WEEK);
      if (e.key === '3') setCalendarView(Views.MONTH);
      if (e.key === 's' || e.key === 'S') setIsGroupedView(false);
      // D9 - member view is an admin/dispatcher capability; the shortcut respects it too.
      if ((e.key === 'g' || e.key === 'G') && canMemberView) setIsGroupedView(true);
      if (e.key === 'Escape') {
        setConflictToast(null);
        setErrorToast(null);
        setContextMenu(null);
        setSlotPopover(null);
        setAllDaySlotPopover(null);
        setCreatePopover(null);
        setSidebarContextMenu(null);
        setPeek(null);
        setGhostContextMenu(null);
        setUnscheduleConfirm(null);
        setNeedsCrewConfirm(false); // back to the (still-open) drop modal
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [canMemberView]);

  // ─── Close context menu / slot popover on outside click ──

  useEffect(() => {
    if (!contextMenu && !slotPopover && !allDaySlotPopover && !sidebarContextMenu
        && !peek && !allDayOverflow) return;
    const handler = (e: MouseEvent) => {
      // Don't close if the press landed inside one of the page's own overlays:
      // the surfaces themselves, anything they portal to <body>, or the document
      // root a press is retargeted to while an open Radix list holds <body> on
      // `pointer-events: none`. Every one of those cases is a press ON an
      // overlay, and each has already broken this dismissal once - the reasoning
      // lives in overlayDismiss.ts.
      if (isScheduleOverlayInteraction(e.target)) return;
      setContextMenu(null);
      setSlotPopover(null);
      setAllDaySlotPopover(null);
      setCreatePopover(null);
      setSidebarContextMenu(null);
      setPeek(null);
      // The "+N more" chip re-pins the panel on the CLICK that follows this
      // mousedown, so a press on the chip must not close it in between - that
      // would close and immediately reopen on every pin.
      const el = e.target instanceof Element ? e.target : null;
      if (!el?.closest('.schedule-allday-more')) closeAllDayOverflow();
    };
    // Use mousedown instead of click to fire before react-big-calendar's selection handlers
    // Delay slightly so the triggering interaction doesn't immediately close
    const timer = setTimeout(() => document.addEventListener('mousedown', handler, true), 100);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handler, true);
    };
  }, [contextMenu, slotPopover, allDaySlotPopover, sidebarContextMenu, peek,
      allDayOverflow, closeAllDayOverflow]);

  // ─── Peek: hover to look, click to keep ──────────────
  //
  // The fanned overlap shows only the leftmost slot of a covered card, so the
  // board needs somewhere for the rest of it to live. Hover opens a passive
  // preview after a beat - short enough to feel immediate, long enough that
  // dragging the pointer across a dense morning does not strobe. Click pins the
  // same card: it gains its actions and stays until something dismisses it.
  //
  // A pinned peek deliberately survives hovering elsewhere. One that a passing
  // pointer could replace would be pinned in name only.

  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Whether an UNPINNED preview is currently up. Tracked in an effect rather
  // than read from state in the handler, so moving between cards can switch the
  // preview instantly instead of re-paying the open delay on every card.
  const previewOpen = useRef(false);
  useEffect(() => {
    previewOpen.current = !!peek && !peek.pinned;
  }, [peek]);

  const cancelHoverTimer = useCallback(() => {
    if (showTimer.current) clearTimeout(showTimer.current);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    showTimer.current = null;
    hideTimer.current = null;
  }, []);

  const handleEventMouseEnter = useCallback(
    (event: BoardEvent, x: number, y: number) => {
      // Entering cancels a pending hide: crossing the 1px seam between two
      // fanned cards must not blink the preview off and on again.
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (showTimer.current) clearTimeout(showTimer.current);
      hideTimer.current = null;
      showTimer.current = null;

      const show = () =>
        setPeek((current) =>
          // A pinned card outranks a preview - it was asked for explicitly.
          current?.pinned
            ? current
            : { event, x: safeX(x + 14, PEEK_W), y: safeY(y + 14, PEEK_H), pinned: false },
        );

      // Already previewing? Follow the pointer immediately. Otherwise wait, so
      // sweeping across the board does not open a card at every step.
      if (previewOpen.current) show();
      else showTimer.current = setTimeout(show, PEEK_HOVER_MS);
    },
    [],
  );

  const handleEventMouseLeave = useCallback(() => {
    if (showTimer.current) clearTimeout(showTimer.current);
    showTimer.current = null;
    // Leave on a short fuse rather than at once: the pointer crossing from one
    // card to the next passes over neither for an instant, and hiding there
    // would strobe. Landing on empty grid, nothing re-enters and it closes.
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      setPeek((current) => (current && !current.pinned ? null : current));
    }, PEEK_HIDE_MS);
  }, []);

  const handleEventContextMenu = useCallback((event: BoardEvent, x: number, y: number) => {
    // Ghost events get their own context menu
    if (event.isGhost && event.ghostId) {
      setGhostContextMenu({ ghostId: event.ghostId, x, y });
      return;
    }
    // Slice 03 - the context menu's own items ("Open Job Details"/"Cancel Job" etc.) assume
    // job/walkthrough and would misfire against a `ce-` boardId. No menu for an entry yet.
    if (event.type === 'calendar-entry') return;
    setContextMenu({ event, x, y });
  }, []);

  // ─── Date label ──────────────────────────────────────

  // Compact on purpose: the label sits between the chevrons in a single-line
  // control row, so every pixel it reserves is one the rest of the row cannot
  // spend. Two rules keep it short without making it ambiguous: the weekday is
  // abbreviated, and the year is printed ONLY when the date is not in the year
  // we are currently in. The two boundary cases the long form handled are
  // preserved - a week that crosses a month still spells the second month, and
  // a week that crosses a year still spells both years.
  const dateRangeLabel = useMemo(() => {
    const thisYear = new Date().getFullYear();
    if (calendarView === Views.DAY) {
      const inThisYear = currentDate.getFullYear() === thisYear;
      return format(currentDate, inThisYear ? 'EEE, MMM d' : 'EEE, MMM d, yyyy');
    } else if (calendarView === Views.MONTH) {
      return format(currentDate, 'MMM yyyy');
    } else {
      const wStart = startOfWeek(currentDate, { weekStartsOn: 0 });
      const wEnd = endOfWeek(currentDate, { weekStartsOn: 0 });
      if (wStart.getFullYear() !== wEnd.getFullYear()) {
        return `${format(wStart, 'MMM d, yyyy')} ${EN} ${format(wEnd, 'MMM d, yyyy')}`;
      }
      const year = wEnd.getFullYear() === thisYear ? '' : `, ${format(wEnd, 'yyyy')}`;
      if (wStart.getMonth() !== wEnd.getMonth()) {
        return `${format(wStart, 'MMM d')} ${EN} ${format(wEnd, 'MMM d')}${year}`;
      }
      return `${format(wStart, 'MMM d')} ${EN} ${format(wEnd, 'd')}${year}`;
    }
  }, [calendarView, currentDate]);

  // ─── Day focus (week view: double-click a day to expand its column) ──
  const toggleDayFocus = useCallback((idx: number) => {
    setFocusedDayIndex((cur) => (cur === idx ? null : idx));
  }, []);

  // Distinguish a single click (navigate / open the Schedule popover) from a
  // double click (expand the day column). A pending single-click action is
  // cancelled by the second click, so double-clicking a day header only
  // expands the column instead of also firing the single-click popover.
  const dayHeaderClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (dayHeaderClickTimer.current) clearTimeout(dayHeaderClickTimer.current);
  }, []);

  // Double-clicking a day column or its header toggles that column wider.
  // Only meaningful in week view (day view = one column, month = no time grid).
  const handleCalendarDoubleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (calendarView !== Views.WEEK) return;
    const wrapper = e.currentTarget;
    const target = e.target as HTMLElement;

    // An event owns its own double-click (it opens the editor). Without this the
    // gesture would ALSO match the day column underneath and expand it.
    if (target.closest('.rbc-event')) return;

    // 1) Double-click inside a day column body
    const slot = target.closest('.rbc-day-slot');
    if (slot) {
      const cols = Array.from(wrapper.querySelectorAll('.rbc-time-content > .rbc-day-slot'));
      const idx = cols.indexOf(slot);
      if (idx >= 0) { e.preventDefault(); toggleDayFocus(idx); return; }
    }
    // 2) Double-click on a day header cell
    const header = target.closest('.rbc-header');
    if (header) {
      const heads = Array.from(wrapper.querySelectorAll('.rbc-time-header-content .rbc-header'));
      const idx = heads.indexOf(header);
      if (idx >= 0) { e.preventDefault(); toggleDayFocus(idx); return; }
    }
  }, [calendarView, toggleDayFocus]);

  // Reset the expanded day whenever the week, view, or board mode changes.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate reset idiom: a day index means nothing once the week or view changes
    setFocusedDayIndex(null);
  }, [currentDate, calendarView, isGroupedView]);

  // ─── Navigation ──────────────────────────────────────

  const handleNavigateToday = useCallback(() => setCurrentDate(nowWallClock(tz)), [tz]);

  const handleNavigatePrev = useCallback(() => {
    setCurrentDate((d) =>
      calendarView === Views.DAY ? subDays(d, 1)
      : calendarView === Views.MONTH ? subMonths(d, 1)
      : subWeeks(d, 1),
    );
  }, [calendarView]);

  const handleNavigateNext = useCallback(() => {
    setCurrentDate((d) =>
      calendarView === Views.DAY ? addDays(d, 1)
      : calendarView === Views.MONTH ? addMonths(d, 1)
      : addWeeks(d, 1),
    );
  }, [calendarView]);

  // ─── Edge-scroll: auto-navigate when dragging near calendar edges ──────
  const edgeScrollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const EDGE_ZONE = 60;
    const NAV_DELAY = 600;

    const handleDragOver = (e: DragEvent) => {
      const calendarEl = document.querySelector('.schedule-cal');
      if (!calendarEl) return;
      const rect = calendarEl.getBoundingClientRect();
      const mouseX = e.clientX;

      const nearLeftEdge = mouseX < rect.left + EDGE_ZONE;
      const nearRightEdge = mouseX > rect.right - EDGE_ZONE;

      if ((nearLeftEdge || nearRightEdge) && !edgeScrollTimerRef.current) {
        edgeScrollTimerRef.current = setInterval(() => {
          if (nearRightEdge) handleNavigateNext();
          else if (nearLeftEdge) handleNavigatePrev();
        }, NAV_DELAY);
      } else if (!nearLeftEdge && !nearRightEdge && edgeScrollTimerRef.current) {
        clearInterval(edgeScrollTimerRef.current);
        edgeScrollTimerRef.current = null;
      }
    };

    const handleDragEnd = () => {
      if (edgeScrollTimerRef.current) {
        clearInterval(edgeScrollTimerRef.current);
        edgeScrollTimerRef.current = null;
      }
    };

    document.addEventListener('dragover', handleDragOver);
    document.addEventListener('dragend', handleDragEnd);
    document.addEventListener('drop', handleDragEnd);
    return () => {
      document.removeEventListener('dragover', handleDragOver);
      document.removeEventListener('dragend', handleDragEnd);
      document.removeEventListener('drop', handleDragEnd);
      if (edgeScrollTimerRef.current) clearInterval(edgeScrollTimerRef.current);
    };
  }, [handleNavigateNext, handleNavigatePrev]);

  // Custom day/week header - GCal style: abbreviation + large date number
  const DayHeader = useCallback(({ date }: { date: Date; label: string }) => {
    const dayAbbr = format(date, 'EEE').toUpperCase();
    const dayNum = format(date, 'd');
    const isToday = format(date, 'yyyy-MM-dd') === format(nowWallClock(tz), 'yyyy-MM-dd');
    return (
      <div
        className="flex flex-col items-center cursor-pointer"
        onClick={(e) => {
          e.stopPropagation();
          const { clientX, clientY } = e;
          // A double-click should only expand the day column (handled by the
          // calendar wrapper's onDoubleClick → toggleDayFocus). Defer the
          // single-click action so the second click of a double-click cancels
          // it, rather than also navigating / opening the Schedule popover.
          if (dayHeaderClickTimer.current) {
            clearTimeout(dayHeaderClickTimer.current);
            dayHeaderClickTimer.current = null;
            return;
          }
          dayHeaderClickTimer.current = setTimeout(() => {
            dayHeaderClickTimer.current = null;
            // Week view: clicking a day header opens that day's schedule (Day view).
            // Other views keep the click for creating an all-day job.
            if (calendarView === Views.WEEK) {
              setCurrentDate(asWallClock(startOfDay(date)));
              setCalendarView(Views.DAY);
              return;
            }
            // D9 - the all-day popover only offers scheduling actions; skip for read-only.
            if (boardReadOnly) return;
            if (createPopoverOpenRef.current) return;
            {
              const dayStart = asWallClock(startOfDay(date));
              setCreatePopover({
                x: clientX,
                y: clientY,
                seed: { start: dayStart, end: dayStart, isAllDay: true },
              });
            }
          }, 250);
        }}
      >
        <span className={`text-[11px] font-medium tracking-wide ${isToday ? 'text-primary' : 'text-text-secondary'}`}>
          {dayAbbr}
        </span>
        <span className={`schedule-day-num font-normal leading-none flex items-center justify-center
          w-8 h-8 rounded-full hover:bg-primary/10 transition-colors
          ${isToday
            ? 'schedule-day-today bg-primary text-on-fill hover:bg-primary/90'
            : 'text-text-primary'
          }`}
        >
          {dayNum}
        </span>
      </div>
    );
  }, [calendarView, boardReadOnly, tz]);

  const calendarComponents = useMemo(() => ({
    toolbar: () => null,
    event: ScheduleEvent as unknown as React.ComponentType<{ event: object }>,
    header: DayHeader as unknown as React.ComponentType<{ date: Date; label: string }>,
    // Week/Day only - Month view keeps react-big-calendar's own `popup` overlay,
    // which is already styled (.rbc-overlay + .rbc-month-view .rbc-show-more).
    ...(calendarView === Views.MONTH ? {} : { showMore: AllDayShowMore }),
  }), [DayHeader, calendarView]);

  // ─── Data Queries ────────────────────────────────────

  const {
    scheduledJobs,
    walkthroughLeads,
    unassignedJobs,
    unscheduledWalkthroughs,
    calendarEntries,
    jobsLoading,
    walkthroughsLoading,
    unassignedError,
  } = useScheduleData({ dateRange, departmentFilter, tz });

  // Bucket types this viewer cannot reach at all. Hide, don't hint (useModuleAccess.ts:18-21) -
  // and killing the section is what stops the empty state from making a positively FALSE claim
  // ("Nothing here - all Walkthroughs are scheduled.") about rows that were never fetched.
  //
  // `leadsEnabled` is the SAME useFeature('leads') result that disabled the two lead queries in
  // useScheduleData, so the hide fails open identically: an unhydrated auth cache keeps the bucket.
  //
  // `canSeePlans` is useFeature('service_plans') && ability.can('read','ServicePlan'), so the
  // Service Plans bucket ALSO disappears for any user without that grant - per defaultGrants.ts
  // that is SALES and TECHNICIAN, on a fully-paid SCALE org. Deliberate, and not a widening:
  // canSeePlans is the identical boolean that already decides `planSlot` below, so the exact set
  // of viewers who see the misleading "soon / Step 9E" stub today is the set that now sees
  // nothing. Keying on useFeature('service_plans') alone would leave planSlot undefined for them
  // and the stub lie fully intact - the opposite of the fix.
  const hiddenBucketTypes: EventType[] = [];
  if (!leadsEnabled) hiddenBucketTypes.push('walkthrough');
  if (!canSeePlans) hiddenBucketTypes.push('service-plan');

  // Roster - the assignable pool, department-scoped SERVER-side (D3). One query replaces
  // the old per-role pair; 'all' = org-wide. Since the scoped-roster split this is also
  // GRANT-scoped: a caller without `assign User` gets themselves alone, which is the
  // product rule (seeing the team and assigning it are one switch), not an empty state
  // to work around.
  const { data: roster = [] } = useAssignableUsers({
    purpose: 'jobCrew',
    departmentId: departmentFilter !== 'all' ? departmentFilter : undefined,
  });

  // Org-wide roster for LABELS (TG9 fold-in): crews can include members outside the active
  // department filter, so name lookups (drop modal, ghost dialogs) must never be dept-scoped.
  // Cached separately from `roster`; columns keep the scoped list.
  const { data: orgRoster = [] } = useAssignableUsers({ purpose: 'jobCrew' });

  // The grant BEHIND that scoping, read off the CASL ability and never off `user.role` (see the
  // hook's note). The roster endpoint and the board's lanes are already narrowed by it; this is
  // the same question asked locally, so the drop modal's Crew field can be seeded and locked to
  // match instead of offering a choice that does not exist.
  // `actorKnownPeople` rides along with the verdict: a crew field seeded (or already crewed)
  // with the viewer's OWN id has no other label source on a cold load - `orgRoster` is `[]` until
  // `/api/users/assignable` answers, and for ever if it fails - so the chip read `Unknown` under
  // a sentence naming them. Threaded as a prop to both surfaces for the same reason
  // `canAssignOthers` is: one read, so they cannot disagree.
  const { canAssignOthers, actorId, actorKnownPeople } = useAssignUserPermission();

  // `org` (which also carries the scheduling defaults driving day-granularity
  // drop anchors and the drop modal's durations) and `tz` are declared at the
  // top of the component - `currentDate`'s initial state needs the zone.

  // ─── Event transformation (adapters → SchedulableEvent) ────────────────────

  const { scheduledEvents, bucketEvents, visibleBucketEvents, conflictIds } = useScheduleEvents({
    scheduledJobs,
    walkthroughLeads,
    unassignedJobs,
    unscheduledWalkthroughs,
    calendarEntries,
    hiddenSidebarIds: planMode.hiddenSidebarIds,
    tz,
  });

  // Apply the pendingMove override so the event visually stays at the new position
  // during the confirmation dialog. The override carries the (unchanged) crew.
  const allEventsWithPending = useMemo<ScheduledBoardEvent[]>(() => {
    if (!pendingMove) return scheduledEvents;
    return scheduledEvents.map((e) =>
      e.boardId === pendingMove.eventId
        ? { ...e, start: pendingMove.newStart, end: pendingMove.newEnd, crew: pendingMove.crew }
        : e,
    );
  }, [scheduledEvents, pendingMove]);

  // Merge ghost events when plan mode is active (ghosts always carry real Dates).
  const ghostCalendarEvents = useMemo<ScheduledBoardEvent[]>(() => {
    if (!planMode.isActive) return [];
    return planMode.ghosts.map((g) => ghostToEvent(g, tz));
  }, [planMode.isActive, planMode.ghosts, tz]);

  const allEvents = useMemo<ScheduledBoardEvent[]>(
    () => [...allEventsWithPending, ...ghostCalendarEvents],
    [allEventsWithPending, ghostCalendarEvents],
  );

  // The cards the current search highlight lights (none when there is no search).
  const highlightedIds = useMemo(
    () => highlightedBoardIds(allEvents, highlightTarget),
    [allEvents, highlightTarget],
  );




  const hasAllDayEvents = useMemo(
    () => allEvents.some((e) => occupiesAllDayStrip(e)),
    [allEvents],
  );

  // ─── Resources (grouped view) ─────────────────────────

  /**
   * Display names for a ghost's crew, from the ghost's OWN payload first.
   *
   * The roster (`GET /api/users/assignable`) is the fallback, not the source. It answers
   * "who may I ADD" and is gated on the `assign User` grant, so a rep who owns the lead but
   * may not change its crew gets a self-only roster - and resolving through it alone printed
   * "No crew" over a crew that plainly exists. The names of people ALREADY ON the record
   * ride along with the record, which its viewer owns.
   *
   * The roster half is still org-wide, so a department filter can never blank out a name of
   * someone outside the active dept (TG9 fold-in) on the older payloads that predate the
   * `assignees` projection.
   */
  const ghostCrewNames = (ghost: Pick<GhostEvent, 'crew' | 'sourceType' | 'raw'>): string =>
    crewNamesOf(ghost.sourceType, ghost.raw, ghost.crew, orgRoster);

  // Member columns for BOTH member views. Department scoping happens server-side (the
  // assignable endpoint); the gear's Staff Filter stays a client-side role narrow.
  //
  // `is_active: true` is restated rather than carried: the roster endpoint's narrowed
  // payload has no activity flag because it only ever returns active users (it is the
  // roster of who may be ADDED). MemberWeekBoard/TechnicianGridView still re-filter on
  // the field, so the columns would come back empty without it. That re-filter is now
  // dead weight in both boards and should be dropped there rather than fed from here.
  const boardMembers = roster
    .filter((u) => roleFilter === 'all' || u.role === roleFilter)
    .map((u) => ({ ...u, is_active: true }));

  // ─── Event styles ────────────────────────────────────

  const eventStyleGetter = useCallback((event: BoardEvent) => {
    // The search highlight, on every card state: a card is found whatever it is painted as.
    const highlight: React.CSSProperties = highlightedIds.has(event.boardId)
      ? {
          boxShadow: '0 0 0 3px rgb(var(--primary) / 0.5)',
          animation: 'search-highlight 1.5s ease-in-out infinite',
          zIndex: 10,
        }
      : {};

    // The paint itself lives in components/schedule/boardEventPaint.ts (testable without mounting
    // the page, and shared with the settings preview); see there for every state. Two things are
    // resolved here because only the page has them:
    //  - The exception state (D7 + §3.8 state 4). Guarded on raw (mirrors ScheduleEvent): the
    //    outside-drag preview stub ({id,title,start,end}) has no crew/raw - eventDangerState would
    //    throw, and a drag preview must never paint a warning. Needs-crew has NO paint of its own:
    //    it is the corner notch ScheduleEvent mounts (NeedsCrewMark), over the card's type paint.
    //  - Whether this viewer may drag a calendar entry: the cursor mirrors draggableAccessor's own
    //    gate (slice 08, spec §4) rather than a second, possibly-drifting check.
    // This three-axis board treatment deliberately does not resolve through STATUS_REGISTRY, for
    // the reason recorded on `boardCardScheme` in scheduleModel.ts, and it is listed in the
    // `## Known survivors` section of the status-registry work package doc.
    return boardEventPaint({
      type: event.type,
      isGhost: !!event.isGhost,
      completed: isCompletedEvent(event),
      inFlight: IN_FLIGHT_STATUSES.has(boardEventStatus(event) ?? ''),
      dangerState: event.raw ? eventDangerState(event, conflictIds) : null,
      highlight,
      canDragCalendarEntry: ability.can('update', 'CalendarEntry'),
    });
  }, [conflictIds, highlightedIds, ability]);

  // ─── Slot styles (off-hours dimming) ─────────────────

  const slotPropGetter = useCallback((date: Date) => {
    const hour = date.getHours();
    if (hour < 7 || hour >= 19) {
      return { style: { backgroundColor: 'rgb(var(--background-light))' } };
    }
    return {};
  }, []);

  // ─── Mutations ───────────────────────────────────────

  const assignMutation = useMutation<
    unknown,
    unknown,
    { jobId: string; crew: string[]; start: string; end: string; force?: boolean; allDay?: boolean },
    { previous?: [readonly unknown[], unknown][] }
  >({
    mutationFn: async (payload) => {
      // REPLACE semantics: always the full crew array. [] is valid - crew ⟂ schedule,
      // a crew-less job can still be (re)scheduled (state 4).
      // No notify keys: the route runs the "Job is scheduled" / "Job is rescheduled" automation
      // when the body says nothing about notifying, and that automation is the only sender.
      const { data } = await api.post(`/api/jobs/${payload.jobId}/assign`, {
        assignee_ids: payload.crew,
        scheduled_start: payload.start,
        scheduled_end: payload.end,
        // Omitted means unchanged, which is why this is spread rather than sent
        // as `is_all_day: undefined` - the route treats a present key as an
        // intent to set the flag either way.
        ...(payload.allDay === undefined ? {} : { is_all_day: payload.allDay }),
        ...(payload.force ? { force: true } : {}),
      });
      return data;
    },
    onMutate: async (payload) => {
      // Prefix-match (the TG10 crew-swap pattern) - the live key is
      // ['schedule-jobs', dateRange, departmentFilter]; an exact-key write would miss it.
      await queryClient.cancelQueries({ queryKey: ['schedule-jobs'] });
      const previous = queryClient.getQueriesData({ queryKey: ['schedule-jobs'] });
      // Optimistically move the event to its new time/crew immediately. Only the ids are
      // known here; names rehydrate on the invalidate-refetch a moment later.
      queryClient.setQueriesData<Record<string, unknown>[]>({ queryKey: ['schedule-jobs'] }, (old) =>
        (old ?? []).map((job) => {
          if (job.id !== payload.jobId) return job;
          return {
            ...job,
            scheduled_start: payload.start,
            scheduled_end: payload.end,
            assignees: payload.crew.map((id) => ({ user: { id } })),
          };
        }),
      );
      return { previous };
    },
    onSuccess: (_data, payload) => {
      refreshAfterVisitWrite(queryClient, { jobId: payload.jobId });
      setConflictToast(null);
    },
    onError: (err, payload, context) => {
      // Revert the optimistic update before showing conflict/error
      for (const [key, data] of context?.previous ?? []) queryClient.setQueryData(key, data);
      // Clear any lingering hover tooltip so it doesn't show under the conflict modal
        const axiosErr = err as { response?: { status?: number; data?: { error?: string; conflicts?: ScheduleConflictItem[] } } };
      if (axiosErr.response?.status === 409) {
        setConflictToast({
          message: extractApiError(err, 'Scheduling conflict detected.'),
          conflicts: axiosErr.response.data?.conflicts,
          pendingPayload: { kind: 'job', jobId: payload.jobId, crew: payload.crew, start: payload.start, end: payload.end },
        });
      } else {
        setErrorToast(extractApiError(err, 'Failed to schedule job. Please try again.'));
      }
    },
  });

  /**
   * Multi-visit S6 (F3, D34): move ONE trip.
   *
   * `/assign` cannot do this. It routes through `syncJobWindowOntoVisits`, whose own docstring
   * says it moves the NEXT UPCOMING live visit - so dragging visit 3 silently rescheduled visit
   * 1, which is the #1550 class (the card that moved is not the row that changed). The per-visit
   * route already exists and is already gated `canDo('reschedule','Job')`.
   *
   * No `assignee_ids`: `rescheduleJobVisitSchema` treats an omitted array as "crew unchanged",
   * and sending one turns a plain move into an `assign` fact, which 403s a reschedule-only
   * grantee. No `is_all_day` either - omitted means unchanged.
   */
  const visitRescheduleMutation = useMutation<
    unknown,
    unknown,
    { jobId: string; visitId: string; start: string; end: string; force?: boolean },
    { previous?: [readonly unknown[], unknown][] }
  >({
    mutationFn: async (payload) => {
      // No notify keys, from any caller: the route runs the "Job is rescheduled" automation when
      // the body says nothing about notifying, and that automation is the only sender.
      const { data } = await api.patch(`/api/jobs/${payload.jobId}/visits/${payload.visitId}`, {
        scheduled_start: payload.start,
        scheduled_end: payload.end,
        ...(payload.force ? { force: true } : {}),
      });
      return data;
    },
    onMutate: async (payload) => {
      // Prefix-match, the same shape /assign uses: the live key is
      // ['schedule-jobs', dateRange, departmentFilter], so an exact-key write would miss it.
      await queryClient.cancelQueries({ queryKey: ['schedule-jobs'] });
      const previous = queryClient.getQueriesData({ queryKey: ['schedule-jobs'] });
      // The board reads the VISIT set now, so patching the job's mirror columns would leave the
      // card snapped back at the old time until the refetch. Find the job by id, then move the
      // ONE visit that was dragged and leave its siblings byte-identical.
      queryClient.setQueriesData<Record<string, unknown>[]>({ queryKey: ['schedule-jobs'] }, (old) =>
        (old ?? []).map((job) => {
          if (job.id !== payload.jobId) return job;
          const visits = (job.visits as Record<string, unknown>[] | undefined) ?? [];
          return {
            ...job,
            visits: visits.map((v) =>
              v.id === payload.visitId
                ? { ...v, scheduled_at: payload.start, scheduled_end: payload.end }
                : v,
            ),
          };
        }),
      );
      return { previous };
    },
    onSuccess: (_data, payload) => {
      refreshAfterVisitWrite(queryClient, { jobId: payload.jobId });
      setConflictToast(null);
    },
    onError: (err, payload, context) => {
      for (const [key, data] of context?.previous ?? []) queryClient.setQueryData(key, data);
      // The SAME 409 -> "Schedule Anyway" path /assign has had since TG9. Without this branch the
      // route that carries every board drag since S6 answered a double-booking with a generic
      // error toast and no way through, which is neither the warning D21 asks for nor a block.
      const axiosErr = err as { response?: { status?: number; data?: { error?: string; conflicts?: ScheduleConflictItem[] } } };
      if (axiosErr.response?.status === 409) {
        setConflictToast({
          message: extractApiError(err, 'Scheduling conflict detected.'),
          conflicts: axiosErr.response.data?.conflicts,
          pendingPayload: {
            kind: 'visit',
            jobId: payload.jobId,
            visitId: payload.visitId,
            start: payload.start,
            end: payload.end,
          },
        });
        return;
      }
      setErrorToast(extractApiError(err, 'Failed to move that visit. Please try again.'));
    },
  });

  /**
   * Move a walkthrough. Visits slice 03: a board card is ONE trip (`visitId`), and moves through
   * that trip's own door - PATCH /api/leads/:id/visits/:visitId. The lead-level door moves the
   * lead's CURRENT trip, so dragging the second walkthrough of a week used to move the first. A card
   * that is not a trip (the Unscheduled bucket's lead card) still books through the lead-level door.
   */
  const walkthroughRescheduleMutation = useMutation<
    unknown,
    unknown,
    { leadId: string; visitId?: string; newStart: string; crew: string[]; durationMinutes: number; force?: boolean },
    { previous?: [readonly unknown[], unknown][] }
  >({
    mutationFn: async (payload) => {
      // REPLACE semantics: always the full performer array. [] is valid (crew ⟂ schedule) -
      // and a reschedule/resize passes the CURRENT crew so it can never drop performers.
      // No notify keys: the lead's own automation is the only sender for a moved walkthrough.
      const body = {
        walkthrough_scheduled_at: payload.newStart,
        performer_ids: payload.crew,
        walkthrough_duration_minutes: payload.durationMinutes,
        force: payload.force ?? false,
      };
      const { data } = payload.visitId
        ? await api.patch(`/api/leads/${payload.leadId}/visits/${payload.visitId}`, body)
        : await api.post(`/api/leads/${payload.leadId}/walkthrough/schedule`, body);
      return data;
    },
    onMutate: async (payload) => {
      // Prefix-match, like the job lanes: every cached window holding this lead moves together.
      await queryClient.cancelQueries({ queryKey: ['schedule-walkthroughs'] });
      const previous = queryClient.getQueriesData({ queryKey: ['schedule-walkthroughs'] });
      const newEnd = new Date(new Date(payload.newStart).getTime() + payload.durationMinutes * 60_000).toISOString();
      queryClient.setQueriesData<Record<string, unknown>[]>({ queryKey: ['schedule-walkthroughs'] }, (old) =>
        (old ?? []).map((lead) => {
          if (lead.id !== payload.leadId) return lead;
          if (!payload.visitId) return { ...lead, walkthrough_scheduled_at: payload.newStart };
          // The dragged trip moves; its sibling trips stay byte-identical.
          const visits = (lead.walkthrough_visits as Record<string, unknown>[] | undefined) ?? [];
          return {
            ...lead,
            walkthrough_visits: visits.map((v) =>
              v.id === payload.visitId ? { ...v, scheduled_at: payload.newStart, scheduled_end: newEnd } : v,
            ),
          };
        }),
      );
      return { previous };
    },
    onSuccess: (_data, payload) => {
      refreshAfterVisitWrite(queryClient, { leadId: payload.leadId });
      setConflictToast(null);
    },
    onError: (err, payload, context) => {
      for (const [key, data] of context?.previous ?? []) queryClient.setQueryData(key, data);
      // 409 → the same "Schedule Anyway" conflict modal jobs get (TG9 fold-in - was a
      // generic error toast, leaving walkthroughs with no force path).
      const axiosErr = err as { response?: { status?: number; data?: { error?: string; conflicts?: ScheduleConflictItem[] } } };
      if (axiosErr.response?.status === 409 && axiosErr.response.data?.conflicts) {
        setConflictToast({
          message: extractApiError(err, 'Scheduling conflict detected.'),
          conflicts: axiosErr.response.data?.conflicts,
          pendingPayload: {
            kind: 'walkthrough',
            leadId: payload.leadId,
            visitId: payload.visitId,
            newStart: payload.newStart,
            crew: payload.crew,
            durationMinutes: payload.durationMinutes,
          },
        });
      } else {
        setErrorToast(extractApiError(err, 'Failed to reschedule walkthrough.'));
      }
    },
  });

  /** The one router for "move this walkthrough card", so every gesture names the card's trip. */
  const moveWalkthroughEvent = useCallback(
    (
      event: Pick<SchedulableEvent, 'parentId' | 'visitId' | 'crew'>,
      move: { newStart: string; durationMinutes: number; crew?: string[] },
      opts?: { onSuccess?: () => void; onError?: (err: unknown) => void },
    ) => {
      walkthroughRescheduleMutation.mutate(
        {
          leadId: event.parentId,
          visitId: event.visitId,
          newStart: move.newStart,
          crew: move.crew ?? event.crew,
          durationMinutes: move.durationMinutes,
        },
        opts,
      );
    },
    [walkthroughRescheduleMutation],
  );

  // ─── TG10 - direct-drag crew swap (D2) + drag-to-unschedule (D6) ──────────
  // Cross-lane drag = crew-only REPLACE (no schedule write - the drop slot's time is
  // deliberately ignored; drag changes where/when + whole lanes, the editor changes who).
  // Optimistic: rewriting the M2M wrap rows with bare ids flips column membership
  // instantly (isOnBoardFor keys off ids); names rehydrate on the invalidate-refetch.
  // setQueriesData/getQueriesData prefix-match so the dept-filtered jobs key is covered.
  //
  // Slice 02: a trip card's crew is THAT trip's crew, so the swap writes that trip - through
  // /visits/:visitId/assignees, the per-visit twin of /assignees (same `assign Job` gate, same crew
  // notices). The job-level door lands its statement on the job's CURRENT visit, so dragging visit
  // 2 between lanes re-crewed visit 1. Only a card that is not a trip (a job with no visit row yet)
  // still speaks job-level crew.

  const jobCrewSwapMutation = useMutation<
    unknown,
    unknown,
    { jobId: string; visitId?: string; crew: string[] },
    { previous?: [readonly unknown[], unknown][] }
  >({
    mutationFn: async ({ jobId, visitId, crew }) => {
      const url = visitId ? `/api/jobs/${jobId}/visits/${visitId}/assignees` : `/api/jobs/${jobId}/assignees`;
      const { data } = await api.post(url, { assignee_ids: crew });
      return data;
    },
    onMutate: async ({ jobId, visitId, crew }) => {
      await queryClient.cancelQueries({ queryKey: ['schedule-jobs'] });
      const previous = queryClient.getQueriesData({ queryKey: ['schedule-jobs'] });
      queryClient.setQueriesData<Record<string, unknown>[]>({ queryKey: ['schedule-jobs'] }, (old) =>
        (old ?? []).map((job) => {
          if (job.id !== jobId) return job;
          if (!visitId) return { ...job, assignees: crew.map((id) => ({ user: { id } })) };
          // The dragged trip's own crew rows; its sibling trips stay byte-identical.
          const visits = (job.visits as Record<string, unknown>[] | undefined) ?? [];
          return {
            ...job,
            visits: visits.map((v) =>
              v.id === visitId ? { ...v, assignees: crew.map((id) => ({ user_id: id, user: { id } })) } : v,
            ),
          };
        }),
      );
      return { previous };
    },
    onSuccess: (_, { jobId }) => refreshAfterVisitWrite(queryClient, { jobId }),
    onError: (err, _payload, context) => {
      for (const [key, data] of context?.previous ?? []) queryClient.setQueryData(key, data);
      setErrorToast(extractApiError(err, 'Failed to swap the crew. Please try again.'));
    },
  });

  // Visits slice 03: a walkthrough card is ONE trip, so its crew swap writes that trip through
  // /visits/:visitId/performers - the lead-level door re-crews the lead's CURRENT trip. Same
  // `schedule_walkthrough` gate either way; only a card that is not a trip speaks lead-level crew.
  const walkthroughCrewSwapMutation = useMutation<
    unknown,
    unknown,
    { leadId: string; visitId?: string; crew: string[] },
    { previous?: [readonly unknown[], unknown][] }
  >({
    mutationFn: async ({ leadId, visitId, crew }) => {
      const url = visitId
        ? `/api/leads/${leadId}/visits/${visitId}/performers`
        : `/api/leads/${leadId}/walkthrough/performers`;
      const { data } = await api.post(url, { performer_ids: crew });
      return data;
    },
    onMutate: async ({ leadId, visitId, crew }) => {
      await queryClient.cancelQueries({ queryKey: ['schedule-walkthroughs'] });
      const previous = queryClient.getQueriesData({ queryKey: ['schedule-walkthroughs'] });
      queryClient.setQueriesData<Record<string, unknown>[]>({ queryKey: ['schedule-walkthroughs'] }, (old) =>
        (old ?? []).map((lead) => {
          if (lead.id !== leadId) return lead;
          if (!visitId) return { ...lead, walkthrough_performers: crew.map((id) => ({ user: { id } })) };
          // The dragged trip's own crew rows; its sibling trips stay byte-identical.
          const visits = (lead.walkthrough_visits as Record<string, unknown>[] | undefined) ?? [];
          return {
            ...lead,
            walkthrough_visits: visits.map((v) =>
              v.id === visitId ? { ...v, assignees: crew.map((id) => ({ user_id: id, user: { id } })) } : v,
            ),
          };
        }),
      );
      return { previous };
    },
    onSuccess: (_, { leadId }) => refreshAfterVisitWrite(queryClient, { leadId }),
    onError: (err, _payload, context) => {
      for (const [key, data] of context?.previous ?? []) queryClient.setQueryData(key, data);
      setErrorToast(extractApiError(err, 'Failed to swap the performers. Please try again.'));
    },
  });

  // ─── Calendar-entry drag/resize save + notify toast (slice 08, spec §3/§5) ──
  //
  // An entry has no crew (ADR 0002), so its move is a direct save - no RescheduleConfirmDialog,
  // no UnifiedDropModal, no crew prompt. Followed by a NON-BLOCKING toast, not a second gate: the
  // move has already landed by the time the toast even renders (spec: "the move persists before
  // the toast is answered - dismissing the toast does not roll back"). Choosing "Notify" fires a
  // SEPARATE request (POST .../notify-moved) - by the time any answer to the toast is possible,
  // calendarEntryMoveMutation below has already persisted the new start/end, so re-diffing "did
  // the time change" against the stored row would trivially read false. See that route's own doc
  // comment in calendar-entry.controller.ts for why `timeChanged: true` there is asserted from
  // the route's structural position (its one caller), not re-derived - and why it is scoped to
  // Post-QA fix (PO-reported 2026-08-25): "QA — all day" had zero participants, yet the toast
  // still offered "Notify" and then claimed "Participants notified" - misleading, since nobody
  // could possibly have been notified. `hasParticipants` (eventAdapters.ts) gates the action on
  // there actually being a recipient, and `describeCalendarEntryNotifyOutcome` above turns the
  // real per-recipient statuses notify-moved returns into the confirmation, instead of a flat
  // "Participants notified".
  //
  // BOTH kinds since the product-owner change of 2026-08-25 - notify-moved emails teammates as
  // well as customers now (with the in-app channel suppressed, so the teammate's board notice
  // still fires exactly once, on the PATCH below). The two result arrays are concatenated
  // because the toast counts PEOPLE, not kinds.
  const calendarEntryNotifyMovedMutation = useMutation<
    { notify?: { customers?: { status: string }[]; users?: { status: string }[] } },
    unknown,
    string
  >({
    mutationFn: async (id) => (await api.post(`/api/calendar-entries/${id}/notify-moved`)).data,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['schedule-calendar-entries'] });
      queryClient.invalidateQueries({ queryKey: ['customer-calendar-entries'] });
      toast(describeCalendarEntryNotifyOutcome([
        ...(data.notify?.customers ?? []),
        ...(data.notify?.users ?? []),
      ]));
    },
    onError: (err) => setErrorToast(extractApiError(err, 'Could not notify participants. Please try again.')),
  });

  const calendarEntryMoveMutation = useMutation<
    unknown,
    unknown,
    { id: string; startIso: string; endIso: string; hasParticipants: boolean }
  >({
    mutationFn: async ({ id, startIso, endIso }) =>
      (await api.patch(`/api/calendar-entries/${id}`, { start: startIso, end: endIso })).data,
    onSuccess: (_data, { id, hasParticipants }) => {
      queryClient.invalidateQueries({ queryKey: ['schedule-calendar-entries'] });
      queryClient.invalidateQueries({ queryKey: ['customer-calendar-entries'] });
      // Non-blocking: a sonner toast with an action button, never a Dialog - it must not gate
      // anything the way RescheduleConfirmDialog's crew confirm does for a job.
      //
      // Offered only when the entry actually has participants (see the mutation doc above).
      // An entry with nobody on it gets the bare "Event moved" toast - there is no one for
      // "Notify" to reach, and offering it there was the reported bug.
      if (hasParticipants) {
        toast('Event moved', {
          description: 'Notify participants of the new time?',
          action: { label: 'Notify', onClick: () => calendarEntryNotifyMovedMutation.mutate(id) },
        });
      } else {
        toast('Event moved');
      }
    },
    onError: (err) => setErrorToast(extractApiError(err, 'Failed to move the event. Please try again.')),
  });

  /** Shared by the standard view (handleEventDrop/handleEventResize below) and the member/
   *  technician grid (handleMemberBoardDrop) - one place answers "how does an entry get moved",
   *  not two copies that could drift. Also the one place that decides whether the post-move
   *  toast can honestly offer to notify anyone (see calendarEntryMoveMutation above). */
  const saveCalendarEntryMove = useCallback(
    (event: Pick<SchedulableEvent, 'parentId' | 'hasParticipants'>, start: WallClock, end: WallClock) => {
      calendarEntryMoveMutation.mutate({
        id: event.parentId,
        startIso: wallClockToIso(start, tz),
        endIso: wallClockToIso(end, tz),
        hasParticipants: event.hasParticipants ?? false,
      });
    },
    [calendarEntryMoveMutation, tz],
  );

  // D6 - clear the TIME, keep the crew (state 2 → 3). The card leaves the board and
  // reappears in its Unscheduled bucket with the crew remembered. No notify keys on any door:
  // the web app makes no per-gesture decision about the customer's email, so the routes read
  // the body as "let the automation handle it" (scheduling-notifications follow-up f3).
  const unscheduleMutation = useMutation<unknown, unknown, SchedulableEvent>({
    mutationFn: async (ev) => {
      if (ev.type === 'walkthrough') {
        // Visits slice 03: a board card is ONE trip - take THAT trip off the board. The lead-level
        // door unschedules the lead's current trip, whichever card was dragged.
        return ev.visitId
          ? (await api.post(`/api/leads/${ev.parentId}/visits/${ev.visitId}/unschedule`)).data
          : (await api.post(`/api/leads/${ev.parentId}/walkthrough/unschedule`)).data;
      } else if (ev.visitId && (ev.visitCount ?? 1) > 1) {
        // Multi-visit S6 (F6, D16/D19): "remove this card from the board" means remove THIS trip.
        // /unassign now cancels every live visit on the job (B4), so sending it for one card of a
        // three-card job would wipe all three and drop the job to UNSCHEDULED. The per-visit
        // cancel route already exists, is already gated `canDo('reschedule','Job')`, and
        // re-derives the job's status through syncJobFromVisits. The row is kept as CANCELLED.
        return (await api.post(`/api/jobs/${ev.parentId}/visits/${ev.visitId}/cancel`, {
          cancelled_reason: 'Removed from schedule',
        })).data;
      } else {
        // The single-trip and no-visit cases: unscheduling the job IS unscheduling its one trip,
        // which is the gesture's original meaning and the one B4 now makes coherent. /unassign
        // cancels those live visits; it still accepts a nested notify object from other clients,
        // and an empty body here is what it reads as "no decision made".
        return (await api.post(`/api/jobs/${ev.parentId}/unassign`, {})).data;
      }
    },
    onSuccess: (_, ev) => {
      if (ev.type === 'walkthrough') {
        refreshAfterVisitWrite(queryClient, { leadId: ev.parentId });
      } else {
        refreshAfterVisitWrite(queryClient, { jobId: ev.parentId });
        // A plan job whose trip is removed goes back to its plan's bucket.
        queryClient.invalidateQueries({ queryKey: servicePlanKeys.bucket });
      }
      if (leadKeepsAnotherBookedVisit(ev)) {
        toast('Visit unscheduled', { description: `${ev.number} keeps its other booked visit.` });
      } else {
        toast(`Unscheduled ${EM} crew kept`, { description: `${ev.number} is back in its bucket.` });
      }
    },
    onError: (err) => setErrorToast(extractApiError(err, 'Failed to unschedule. Please try again.')),
  });

  // Board "Mark Complete" - one-click close-out, no completion-note modal.
  const completeMutation = useMutation<unknown, unknown, { jobId: string; number: string }>({
    mutationFn: async ({ jobId }) => api.post(`/api/jobs/${jobId}/complete`),
    onSuccess: (_, { jobId, number }) => {
      refreshAfterVisitWrite(queryClient, { jobId });
      toast('Job completed', { description: `${number} marked complete.` });
    },
    onError: (err) => setErrorToast(extractApiError(err, 'Failed to complete. Please try again.')),
  });

  // ─── TG11 - Unassigned bucket stack seams ──────────────────────────────────
  // The component renders the buckets; the page owns the drag channels, the drag ref,
  // click routing, context menus, and the unschedule write.

  /** Bucket card drag-out: SAME channels the drop zones expect (job-id / bare-lead walkthrough-id). */
  const handleBucketCardDragStart = useCallback((ev: SchedulableEvent, e: React.DragEvent) => {
    document.body.classList.add('is-dragging');
    draggingJobIdRef.current = ev.boardId;
    if (ev.type === 'walkthrough') {
      e.dataTransfer.setData(WALKTHROUGH_ID, ev.raw.id as string); // bare lead id (codec restores wt-)
    } else {
      e.dataTransfer.setData(JOB_ID, ev.boardId);
    }
    e.dataTransfer.effectAllowed = 'move';
    // Compact number-chip drag image, filled with the type's colour.
    // The derived SOLID pair (tokens.css / useScheduleEventColorVars): the org's colour, or the
    // default, with the text that clears 4.5:1 on it - white where white reads, the fill darkened
    // just enough for white on a mid tone, black on a light seed. It used to be the raw pick with
    // white text whatever it was, which on a light pick such as Light sage was 2.8:1.
    // The ghost is appended to document.body, which inherits the properties because they are
    // written on documentElement rather than scoped to the page div - see the hook above.
    const ghost = document.createElement('div');
    ghost.textContent = ev.number;
    const [ghostFill, ghostText] = ev.type === 'walkthrough'
      ? ['rgb(var(--ev-walkthrough-solid))', 'rgb(var(--ev-walkthrough-on-solid))']
      : ['rgb(var(--ev-job-solid))', 'rgb(var(--ev-job-on-solid))'];
    ghost.style.cssText =
      `position:fixed;top:-100px;background:${ghostFill};color:${ghostText};` +
      'padding:4px 10px;border-radius:4px;font-size:12px;font-weight:600;white-space:nowrap;';
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, ghost.offsetWidth / 2, 12);
    requestAnimationFrame(() => {
      if (document.body.contains(ghost)) document.body.removeChild(ghost);
    });
  }, []);

  const handleBucketCardDragEnd = useCallback(() => {
    document.body.classList.remove('is-dragging');
    draggingJobIdRef.current = null;
  }, []);

  /** TG12 - bucket cards open the same event editor as board cards (replaces the old
   *  per-type split: walkthrough → lead page, job → AssignJobDialog). */
  const handleBucketCardClick = useCallback(
    (ev: SchedulableEvent) => setEditorEventId(ev.boardId),
    [],
  );

  const handleBucketCardContextMenu = useCallback((ev: SchedulableEvent, e: React.MouseEvent) => {
    // The sidebar menu only knows jobs + walkthroughs. Calendar entries (slice 03) never reach
    // the bucket at all (no unscheduled state), so this branch is defensive/unreachable today -
    // kept for the same reason the service-plan exclusion is: it also narrows `ev.type` for the
    // `type` field below, which only accepts 'walkthrough' | 'job'.
    if (ev.type === 'service-plan' || ev.type === 'calendar-entry') return;
    e.preventDefault();
    setSidebarContextMenu({
      x: e.clientX,
      y: e.clientY,
      type: ev.type,
      id: ev.type === 'walkthrough' ? (ev.raw.id as string) : ev.parentId,
    });
  }, []);

  /**
   * The unschedule gate, shared by the D6 drag path and the editor's "Move to
   * Unscheduled" button. Jobs unschedule from any status since Spec B1 - the
   * backend no longer 400s. The walkthrough branch is a Lead, out of scope.
   *
   * The gate reads the trip's own state, NOT the lead's status. The lead's status (Walkthrough
   * Scheduled / Walkthrough Completed) is derived from ALL of its visits together, so it cannot
   * say whether THIS card's trip is still open, and an Estimate Sent lead is never moved by a
   * visit at all - a gate keyed on `ev.raw.status` would wrongly refuse (or allow) the drag.
   * Reads the same current-visit-projected fields the detail page uses instead.
   * `useScheduleData`'s /api/leads query is list-mode, which does not carry
   * walkthrough_cancelled_at (detail-only), so a CANCELLED visit whose scheduled_at still falls
   * in the viewed date range (kept as D15 history) is indistinguishable here from a live
   * SCHEDULED one - same known limitation as LeadsPage.tsx's getWalkthroughDisplay.
   */
  const unscheduleGate = useCallback(
    (ev: SchedulableEvent): { ok: true } | { ok: false; reason: string } => {
      if (ev.type === 'walkthrough') {
        // Visits slice 03: a trip card answers for its OWN trip - isCompletedEvent reads its
        // visitStatus, where the lead's flat fields describe only the lead's current trip.
        return ev.start && !isCompletedEvent(ev)
          ? { ok: true }
          : { ok: false, reason: 'This walkthrough already happened.' };
      }
      return { ok: true };
    },
    [],
  );

  /**
   * D6 drop seam - the component gates the channel (grid-event-id) + plan mode; the page
   * keeps the stale guard and pre-gates via unscheduleGate with a reason toast instead
   * of the confirm dialog.
   */
  const handleUnscheduleDrop = useCallback(
    (boardEventId: string) => {
      if (planMode.isActive) return; // defense in depth - the component already refuses the drop
      if (boardReadOnly) return; // D9 defense in depth - board cards aren't draggable for read-only
      const ev = scheduledEvents.find((s) => s.boardId === boardEventId);
      if (!ev) return; // ghost/stale drag - nothing live to unschedule
      const gate = unscheduleGate(ev);
      if (!gate.ok) {
        toast("Can't unschedule", { description: `${ev.number} ${EM} ${gate.reason}` });
        return;
      }
      setUnscheduleConfirm(ev);
    },
    [planMode.isActive, scheduledEvents, unscheduleGate, boardReadOnly],
  );

  // ─── TG12 - event editor (the ONLY per-person crew path) ──────────────────
  // Clicking ANY live card (board or bucket, all three views) opens this editor.
  // Drags stay whole-lane swaps/reschedules; the D5 modal stays initial scheduling.

  /** The live editor event - re-derived from the query collections each render, so a
   *  save (crew/time/unschedule) refreshes the open editor in place. */
  const editorEvent = useMemo<SchedulableEvent | null>(
    () =>
      editorEventId
        ? ([...scheduledEvents, ...bucketEvents].find((e) => e.boardId === editorEventId) ?? null)
        : null,
    [editorEventId, scheduledEvents, bucketEvents],
  );

  // TG13 fold-in (TG12 review) - clear a STALE editor id: if the event vanished from the
  // live collections (cancelled/completed elsewhere, refetch dropped it) the dialog shows
  // nothing now, but a lingering id would pop the editor open the moment the event ever
  // re-enters a collection. Skip while an overlay (conflict / unschedule confirm) hides
  // the editor on purpose - it must reopen for the same event after the overlay closes.
  useEffect(() => {
    if (editorEventId && !editorEvent && !conflictToast && !unscheduleConfirm) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate stale-id clear (TG13); guarded so it settles in one pass
      setEditorEventId(null);
    }
  }, [editorEventId, editorEvent, conflictToast, unscheduleConfirm]);

  /** Slice 04 - the live Event dialog's entry, re-derived the same way editorEvent is above
   *  so a save updates the still-open dialog in place. Calendar entries never populate
   *  bucketEvents (no unscheduled state - start/end are required columns, spec §2). */
  const eventEntryEvent = useMemo<SchedulableEvent | null>(
    () => (eventEntryId ? (scheduledEvents.find((e) => e.boardId === eventEntryId) ?? null) : null),
    [eventEntryId, scheduledEvents],
  );

  // Same TG13 stale-id rule as editorEventId above - a delete elsewhere must not leave a
  // lingering id that pops the dialog back open the moment the id ever re-enters the collection.
  useEffect(() => {
    if (eventEntryId && !eventEntryEvent) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate stale-id clear (TG13 rule), guarded so it settles in one pass
      setEventEntryId(null);
    }
  }, [eventEntryId, eventEntryEvent]);

  const openEditorFor = useCallback((event: BoardEvent) => {
    if (event.isGhost) return; // ghosts keep their own context menu
    // Slice 04 - a calendar entry opens its own dialog (EventEntryDialog), never
    // EventEditor: that component is built around crew/MultiAssigneeSelect/deriveState and
    // a detailUrlOf that only knows jobs and leads.
    if (event.type === 'calendar-entry') {
      setEventEntryId(event.boardId);
      return;
    }
    setEditorEventId(event.boardId);
  }, []);

  /**
   * The STANDARD calendar's click, which pins the peek instead of opening the
   * editor outright.
   *
   * Only this board. On the fanned overlap a covered card shows a few pixels of
   * itself, so a click there is far more often "which one is this?" than "let
   * me edit it", and going straight to a full editor made every mis-click
   * expensive. The peek answers in place and carries an Open button for the
   * other case.
   *
   * The member boards keep `openEditorFor`: their cards are full width, never
   * overlap, and a click there is unambiguous.
   */
  /** Double-click is the shortcut past the peek - straight to the editor. */
  const handleCalendarDoubleClickEvent = useCallback(
    (event: BoardEvent) => {
      cancelHoverTimer();
      setPeek(null);
      openEditorFor(event);
    },
    [cancelHoverTimer, openEditorFor],
  );

  const handleCalendarSelectEvent = useCallback(
    (event: BoardEvent) => {
      if (event.isGhost) return;
      cancelHoverTimer();
      setPeek({
        event,
        x: safeX(lastMousePos.current.x + 12, PEEK_W),
        y: safeY(lastMousePos.current.y + 12, PEEK_H),
        pinned: true,
      });
    },
    [cancelHoverTimer],
  );

  /** Status gate for the editor's "Move to Unscheduled" (timed events only). */
  const editorUnscheduleGate = editorEvent?.start ? unscheduleGate(editorEvent) : null;

  /** "Mark Complete" gate - a manager (not read-only) closing out a job from the board.
   *  Self-exclusion only (not ordering): re-completing an already-complete job is a no-op. */
  const editorCanComplete =
    !boardReadOnly &&
    editorEvent?.type === 'job' &&
    (editorEvent?.raw?.status as string | undefined) !== 'COMPLETED';

  /** Crew save → TG10's crew-only REPLACE mutations, by type. */
  const handleEditorSaveCrew = useCallback(
    (crew: string[]) => {
      if (boardReadOnly) return; // D9 defense in depth - the editor is view-only for read-only roles
      if (!editorEvent) return;
      const onUpdated = () => {
        toast('Crew updated', { description: `${editorEvent.number} ${EM} crew replaced.` });
      };
      if (editorEvent.type === 'walkthrough') {
        walkthroughCrewSwapMutation.mutate(
          { leadId: editorEvent.parentId, visitId: editorEvent.visitId, crew },
          { onSuccess: onUpdated },
        );
      } else {
        jobCrewSwapMutation.mutate(
          { jobId: editorEvent.parentId, visitId: editorEvent.visitId, crew },
          { onSuccess: onUpdated },
        );
      }
    },
    [editorEvent, jobCrewSwapMutation, walkthroughCrewSwapMutation, boardReadOnly],
  );

  /**
   * Multi-visit S6 (F3, D34): the ONE router for "move this job card to this window".
   *
   * Four gestures move a job card - drag-and-confirm, resize, the drop modal, and Save time in
   * the event editor - and each used to answer "which write?" for itself. Two of them were left
   * on `/assign` when the cards became per-visit, and the symptom is silent: `/assign` routes
   * through `syncJobWindowOntoVisits`, which rewrites the job's EARLIEST upcoming trip, so
   * resizing Friday's card moved Monday's visit (same `visit_seq`, so the customer's "Visit 1"
   * email now names the wrong day) while the card the user touched never moved. One router, so a
   * fifth gesture cannot repeat it.
   *
   * A card that IS a visit moves that visit; `/assign` stays the FIRST-BOOKING path, for a job
   * that holds no visit row yet. `crew` is only read on that branch - the per-visit route takes
   * crew by omission (unchanged), which is what keeps a reschedule-only grantee out of a 403.
   */
  const moveJobEvent = useCallback(
    (
      event: Pick<SchedulableEvent, 'parentId' | 'visitId'>,
      move: { startIso: string; endIso: string; crew: string[]; allDay?: boolean },
      opts?: { onSuccess?: () => void; onError?: (err: unknown) => void },
    ) => {
      if (event.visitId) {
        visitRescheduleMutation.mutate(
          { jobId: event.parentId, visitId: event.visitId, start: move.startIso, end: move.endIso },
          opts,
        );
        return;
      }
      assignMutation.mutate(
        { jobId: event.parentId, crew: move.crew, start: move.startIso, end: move.endIso, allDay: move.allDay },
        opts,
      );
    },
    [assignMutation, visitRescheduleMutation],
  );

  /** Time save → the existing schedule mutations with the CURRENT crew (crew ⟂ schedule);
   *  a 409 flows into the page-level conflict modal's force path. */
  const handleEditorSaveTime = useCallback(
    (start: WallClock, durationMin: number, allDay: boolean) => {
      if (boardReadOnly) return; // D9 defense in depth - the editor is view-only for read-only roles
      if (!editorEvent) return;
      if (editorEvent.type === 'walkthrough') {
        moveWalkthroughEvent(editorEvent, { newStart: wallClockToIso(start, tz), durationMinutes: durationMin });
      } else {
        moveJobEvent(editorEvent, {
          startIso: wallClockToIso(start, tz),
          endIso: wallClockToIso(addMsToWallClock(start, durationMin * 60_000), tz),
          crew: editorEvent.crew,
          allDay,
        });
      }
    },
    [editorEvent, moveJobEvent, moveWalkthroughEvent, boardReadOnly],
  );

  // ─── D5 unified drop modal - open / change / confirm ──

  /** Org default anchor for day-granularity drops (member-week, standard-day). */
  const defaultStartMin = hhmmToMin(org?.default_schedule_start_time ?? '08:00');

  /** Open the modal for a bucket event, pre-filled by WHERE it was dropped. */
  const openDropModal = useCallback(
    (ev: SchedulableEvent, target: DropTarget) => {
      const draft = draftFromDrop(ev, target, {
        defaultStartMin: hhmmToMin(org?.default_schedule_start_time ?? '08:00'),
        defaultDurationMin:
          ev.type === 'walkthrough'
            ? (org?.default_walkthrough_duration_min ?? 60)
            : (org?.default_job_duration_min ?? 120),
      });
      // WHERE the seeding lives, and why it is here rather than inside `draftFromDrop`: the draft
      // is BUILT by a pure geometry function that takes no actor, and it is OPENED here, where the
      // session-reading hooks already are. `seedCrewForActor` keeps the rule pure and testable
      // next to `draftFromDrop` without making its four branches answer a permission question.
      setDropModal({
        event: ev,
        draft: { ...draft, crew: seedCrewForActor(draft.crew, canAssignOthers, actorId) },
      });
    },
    [org, canAssignOthers, actorId],
  );

  // Advisory conflict note - re-scanned as the draft changes; never blocks Confirm.
  const firstNameById = useMemo(
    () => new Map(orgRoster.map((u) => [u.id, u.first_name])),
    [orgRoster],
  );
  // Advisory only - scans the loaded date range; the backend 409 is the real guard.
  const dropConflictNote = useMemo(
    () => (dropModal ? conflictNoteFor(dropModal.draft, scheduledEvents, firstNameById) : null),
    [dropModal, scheduledEvents, firstNameById],
  );

  /** POST the draft through the existing mutations (the modal itself never posts). */
  const submitDropDraft = useCallback(
    (event: SchedulableEvent, draft: ScheduleDraft) => {
      const startIso = wallClockToIso(draft.start, tz);
      const endIso = wallClockToIso(addMsToWallClock(draft.start, draft.durationMin * 60_000), tz);
      const onScheduled = () => {
        toast('Scheduled', {
          description: `${event.number} ${EM} ${format(draft.start, 'EEE, MMM d · h:mm a')}`,
        });
      };
      // Draft-loss fix (TG10 fold-in): the modal closes optimistically below, so a
      // non-409 failure (500, network) must restore it - the user keeps their draft.
      // A 409 stays closed: it flows into the page-level conflict modal's force path.
      const restoreDraftOnNon409 = (err: unknown) => {
        if ((err as { response?: { status?: number } })?.response?.status !== 409) {
          setDropModal({ event, draft });
        }
      };
      if (event.type === 'walkthrough') {
        moveWalkthroughEvent(
          event,
          { newStart: startIso, crew: draft.crew, durationMinutes: draft.durationMin },
          { onSuccess: onScheduled, onError: restoreDraftOnNon409 },
        );
      } else {
        moveJobEvent(
          event,
          { startIso, endIso, crew: draft.crew },
          { onSuccess: onScheduled, onError: restoreDraftOnNon409 },
        );
      }
      // Close optimistically - a 409 surfaces through the page-level conflict modal.
      setDropModal(null);
      setNeedsCrewConfirm(false);
    },
    [moveJobEvent, moveWalkthroughEvent],
  );

  const handleDropModalConfirm = useCallback(() => {
    if (!dropModal) return;
    if (dropModal.draft.crew.length === 0) {
      // §3.8 state 4 is valid but deliberate - warn before saving a crew-less schedule.
      setNeedsCrewConfirm(true);
      return;
    }
    submitDropDraft(dropModal.event, dropModal.draft);
  }, [dropModal, submitDropDraft]);

  // ─── DnD Handlers ────────────────────────────────────

  const handleEventDrop = useCallback(
    ({
      event,
      start,
      end,
      isAllDay,
    }: {
      event: BoardEvent;
      start: Date | string;
      end: Date | string;
      isAllDay?: boolean;
    }) => {
      if (boardReadOnly) return; // D9 defense in depth - drags are disabled at the source too

      // RBC only ever hands back wall-clock-space values (it has no timezone concept -
      // see schedule-tz.ts) - these are WallClock, not a fresh browser-local instant.
      let startDate: WallClock = asWallClock(start instanceof Date ? start : new Date(start));
      let endDate: WallClock = asWallClock(end instanceof Date ? end : new Date(end));

      // All-day drop: normalize to midnight-to-midnight
      if (isAllDayEvent(event) || isAllDay) {
        startDate = asWallClock(startOfDay(startDate));
        endDate = addMsToWallClock(startDate, 24 * 60 * 60_000);
      }

      // Slice 08 (spec §3/§4) - a calendar entry has no crew and no invoice (ADR 0002), so
      // neither rescheduleGate's money check nor the RescheduleConfirmDialog crew-confirm flow
      // below applies to it: direct save, own gate. Handled entirely here, AHEAD of the Plan Mode
      // ghost check just below - that ordering is what keeps entries excluded from Plan Mode
      // (§3) now that draggableAccessor no longer refuses the drag itself (isDragInert's one call
      // site, slice 03, is gone - see draggableAccessor's own comment below).
      if (event.type === 'calendar-entry') {
        if (!ability.can('update', 'CalendarEntry')) return; // belt & braces - draggableAccessor already refused this drag
        saveCalendarEntryMove(event, startDate, endDate);
        return;
      }

      // Money, not status, freezes a job for rescheduling (Spec B1, B-2).
      if (!event.isGhost) {
        const gate = rescheduleGate(event);
        if (!gate.ok) {
          toast("Can't reschedule", { description: `${event.number} ${EM} ${gate.reason}` });
          return;
        }
      }

      // If dragging a ghost event, update its position (crew rides along unchanged)
      if (event.isGhost && event.ghostId) {
        planMode.updateGhostPosition(event.ghostId, wallClockToIso(startDate, tz), wallClockToIso(endDate, tz));
        return;
      }

      // Plan Mode: create ghost instead of live mutation - the draft keeps the current crew
      if (planMode.isActive && !event.isGhost) {
        planMode.addGhost(boardCardDraft(event, startDate, endDate, tz));
        return;
      }

      // Crew ⟂ schedule: a standard-view drag moves TIME only. The confirm dialog then
      // POSTs the event's CURRENT crew (possibly [] - a timed, crew-less event is valid
      // and surfaces as state 4) with the new times, so a move can never drop crew.
      const oldStart = event.start;
      const oldEnd = event.end;
      if (!oldStart || !oldEnd) return; // unscheduled events can't be dragged on the calendar
      setPendingMove({ eventId: event.boardId, newStart: startDate, newEnd: endDate, crew: event.crew });
      setRescheduleConfirm({ event, oldStart, oldEnd, newStart: startDate, newEnd: endDate });
    },
    [planMode, boardReadOnly, ability, saveCalendarEntryMove],
  );

  const handleEventResize = useCallback(
    ({
      event,
      start,
      end,
    }: {
      event: BoardEvent;
      start: Date | string;
      end: Date | string;
    }) => {
      if (boardReadOnly) return; // D9 defense in depth - resizable is off for read-only roles

      const startDate: WallClock = asWallClock(start instanceof Date ? start : new Date(start));
      const endDate: WallClock = asWallClock(end instanceof Date ? end : new Date(end));

      // Slice 08 (spec §3/§4) - same reasoning as handleEventDrop above: direct save, own gate,
      // ahead of the Plan Mode ghost check (all-day entries can't reach here at all -
      // resizableAccessor already refuses a resize on one, same as it does for a job/walkthrough).
      if (event.type === 'calendar-entry') {
        if (!ability.can('update', 'CalendarEntry')) return; // belt & braces - resizableAccessor already refused this
        saveCalendarEntryMove(event, startDate, endDate);
        return;
      }

      // Money, not status, freezes a job for rescheduling (Spec B1, B-2).
      if (!event.isGhost) {
        const gate = rescheduleGate(event);
        if (!gate.ok) {
          toast("Can't reschedule", { description: `${event.number} ${EM} ${gate.reason}` });
          return;
        }
      }

      // Plan Mode: create ghost instead of live mutation - the draft keeps the current crew
      if (planMode.isActive && !event.isGhost) {
        planMode.addGhost(boardCardDraft(event, startDate, endDate, tz));
        return;
      }

      // Crew ⟂ schedule: resizing needs no crew - POST the CURRENT crew (possibly [])
      // with the new times so a resize can never drop assignees/performers.
      if (event.type === 'job') {
        moveJobEvent(event, {
          startIso: wallClockToIso(startDate, tz),
          endIso: wallClockToIso(endDate, tz),
          crew: event.crew,
        });
      } else if (event.type === 'walkthrough') {
        moveWalkthroughEvent(event, {
          newStart: wallClockToIso(startDate, tz),
          durationMinutes: Math.round((endDate.getTime() - startDate.getTime()) / 60_000),
        });
      }
    },
    [moveJobEvent, moveWalkthroughEvent, planMode, boardReadOnly, ability, saveCalendarEntryMove],
  );

  // Drops from the sidebar onto the STANDARD calendar (the grouped views handle their own
  // drops via onDropJob). Plan-visit drops materialize directly and plan mode still ghosts;
  // every other bucket drop opens the D5 unified modal pre-filled by where it landed
  // (exact slot → standard-time; month cell / all-day strip → standard-day).
  const handleDropFromOutside = useCallback(
    ({ start, end, allDay }: { start: Date | string; end: Date | string; allDay?: boolean }) => {
      if (boardReadOnly) return; // D9 defense in depth - bucket cards aren't drag sources either
      const rawId = draggingJobIdRef.current;
      if (!rawId) return;
      draggingJobIdRef.current = null;

      const startDate: WallClock = asWallClock(start instanceof Date ? start : new Date(start));
      const endDate: WallClock = asWallClock(end instanceof Date ? end : new Date(end));

      const parsed = parseBoardDragId(rawId);

      // ── Service-plan visit drop from sidebar (pv- prefix) ──
      // Lazily materialize the next visit: schedule-visit spawns a real visit-Job at
      // status SCHEDULED with the drop times but no crew (state 4 - needs crew).
      // The hook refreshes the board (and every other visit surface) so the card appears immediately.
      if (parsed.kind === 'plan-visit') {
        scheduleVisitMutation.mutate(
          { id: parsed.entityId, scheduled_start: wallClockToIso(startDate, tz), scheduled_end: wallClockToIso(endDate, tz), assigned_to: null },
          {
            onError: (err) => setErrorToast(extractApiError(err, 'Failed to schedule the plan visit.')),
          },
        );
        return;
      }

      const ev = bucketEvents.find((e) => e.boardId === rawId);
      if (!ev) {
        // Stale drag - the card left the bucket mid-drag (e.g. scheduled elsewhere).
        setErrorToast('That card is no longer in the Unscheduled bucket.');
        return;
      }

      // ── Plan mode: bucket drops become ghosts (flow unchanged) ──
      if (planMode.isActive) {
        if (parsed.kind === 'walkthrough') {
          planMode.addGhost({
            sourceId: parsed.entityId,
            sourceType: 'walkthrough',
            isFromSidebar: true,
            isMovedConfirmed: false,
            start: wallClockToIso(startDate, tz),
            end: wallClockToIso(endDate, tz),
            crew: [...ev.crew],
            title: ev.title,
            customerName: ev.customer,
            // Slice 6: a bucket walkthrough card is still the lead's CURRENT visit, so it carries
            // that visit's location; the lead's denormalized service address is the fallback.
            ...planDraftLocation(
              ev,
              [ev.raw.service_address_line1, ev.raw.service_city, ev.raw.service_state]
                .filter(Boolean).join(', '),
            ),
            raw: ev.raw,
          });
        } else {
          const location = ev.raw.service_location as { address_line1?: string; city?: string; state?: string } | null;
          planMode.addGhost({
            sourceId: parsed.entityId,
            sourceType: 'job',
            isFromSidebar: true,
            isMovedConfirmed: false,
            start: wallClockToIso(startDate, tz),
            end: wallClockToIso(endDate, tz),
            crew: [...ev.crew],
            title: `${ev.number} ${EM} ${ev.customer}`,
            customerName: ev.customer,
            // Slice 6: a card in the UNSCHEDULED bucket addresses the JOB, never a trip
            // (jobToBucketEvent), so there is no visit whose location it could carry and
            // `ev.locationLabel` is legitimately absent - the job's service address is the only
            // answer there is. Routed through the same helper anyway, so a bucket card that gains
            // a trip identity later does not need this site remembered.
            ...planDraftLocation(
              ev,
              location ? [location.address_line1, location.city, location.state].filter(Boolean).join(', ') : '',
            ),
            raw: ev.raw,
          });
        }
        return;
      }

      // ── D5: the unified drop modal (replaces walkthrough direct-schedule + job AssignJobDialog) ──
      // rbc 1.19.4 never sets allDay:true from its DnD wrappers (both hardcode false).
      // All-day-strip drops arrive MIDNIGHT-anchored spanning a full day (WeekWrapper:
      // getDateForSlot → start + 1 'day'); timed-slot drops keep the 2h preview duration.
      // Calendar-day math, not raw ms (TG10 fold-in): the 23h spring-forward day broke the
      // old `spanMs >= 24h` check. The midnight anchor keeps late-evening timed drops
      // (22:00 + 2h touches/crosses midnight → calendar-day diff 1) classified as timed.
      const isAllDayStripDrop =
        Boolean(allDay) || // documented field kept as fallback for future rbc versions
        (differenceInCalendarDays(endDate, startDate) >= 1 &&
          startDate.getHours() === 0 &&
          startDate.getMinutes() === 0);
      const dayGranularity = calendarView === Views.MONTH || isAllDayStripDrop;
      openDropModal(
        ev,
        dayGranularity
          ? { kind: 'standard-day', date: asWallClock(startOfDay(startDate)) }
          : { kind: 'standard-time', start: startDate },
      );
    },
    [planMode, bucketEvents, scheduleVisitMutation, calendarView, openDropModal, boardReadOnly],
  );

  // ─── Slot select (click on empty slot) ───────────────

  const handleSelectSlot = useCallback(
    ({ start, end }: { start: Date | string; end: Date | string }) => {
      if (draggingJobIdRef.current) return;
      const startDate: WallClock = asWallClock(start instanceof Date ? start : new Date(start));
      const endDate: WallClock = asWallClock(end instanceof Date ? end : new Date(end));
      // Month view: clicking a day opens that day's schedule (Day view) instead
      // of the create-job slot popover - easier to drill into a specific date.
      if (calendarView === Views.MONTH) {
        setCurrentDate(asWallClock(startDate));
        setCalendarView(Views.DAY);
        return;
      }
      // D9 - the slot popover only offers scheduling actions; read-only roles don't get it.
      if (boardReadOnly) return;
      // Already open? This click was a dismissal (Radix handled it on pointerdown) and
      // must not also re-anchor. See createPopoverOpenRef.
      if (createPopoverOpenRef.current) return;
      // Google-Calendar behaviour: the clicked window seeds start/end and the popover
      // anchors to the slot the pointer is on.
      setCreatePopover({
        x: lastMousePos.current.x,
        y: lastMousePos.current.y,
        seed: { start: startDate, end: endDate, isAllDay: false },
      });
    },
    [calendarView, boardReadOnly],
  );

  // ─── Event select (click on event) ───────────────────
  // TG12 - all three views open the event editor (openEditorFor); the dead popup is gone.

  // Member-view drop, shared by Member·Day ({kind:'time'} - exact drop slot) and
  // Member·Week ({kind:'day'} - day granularity, no time). The views normalize every
  // payload channel to a BOARD id (dragChannels.resolveBoardDropId), so a bucket
  // walkthrough arrives as `wt-…` and can no longer misroute into AssignJobDialog.
  //   bucket event → D5 unified modal (member-day / member-week pre-fill)
  //   board event  → TG10 direct gestures: cross-lane = swap (slot time IGNORED),
  //                  same-lane = reschedule via the confirm flow (crew unchanged)
  //   plan mode    → bucket JOB cards ghost; everything else keeps its no-op
  const handleMemberBoardDrop = (
    droppedId: string,
    memberId: string,
    drop:
      | { kind: 'time'; start: WallClock; end: WallClock; fromMember: string | null }
      | { kind: 'day'; date: WallClock; fromMember: string | null },
  ) => {
    if (boardReadOnly) return; // D9 defense in depth - read-only roles never see member views
    const parsed = parseBoardDragId(droppedId);
    if (parsed.kind === 'plan-visit') return; // pv- cards only target the standard calendar

    // Day-granularity drops anchor at the org default start time (replaces the 08:00 stopgap).
    const anchoredStart = drop.kind === 'time' ? drop.start : atMinutes(drop.date, defaultStartMin);

    if (planMode.isActive) {
      // Only sidebar JOB cards materialize ghosts here (walkthrough/grid
      // drops keep their pre-existing no-op in plan mode).
      const ev = bucketEvents.find((e) => e.boardId === droppedId && e.type === 'job');
      if (!ev) return;
      const ghostEnd =
        drop.kind === 'time'
          ? drop.end
          : new Date(anchoredStart.getTime() + (org?.default_job_duration_min ?? 120) * 60_000);
      const location = ev.raw.service_location as { address_line1?: string; city?: string; state?: string } | null;
      planMode.addGhost({
        sourceId: droppedId,
        sourceType: 'job',
        isFromSidebar: true,
        isMovedConfirmed: false,
        start: wallClockToIso(anchoredStart, tz),
        end: wallClockToIso(ghostEnd, tz),
        crew: [memberId],
        title: `${ev.number} ${EM} ${ev.customer}`,
        customerName: ev.customer,
        // Slice 6: same as the calendar's bucket drop above - a bucket card is the JOB, not a
        // trip, so the job's service address is the only location there is to draft.
        ...planDraftLocation(
          ev,
          location ? [location.address_line1, location.city, location.state].filter(Boolean).join(', ') : '',
        ),
        raw: ev.raw,
      });
      return;
    }

    const bucketEv = bucketEvents.find((e) => e.boardId === droppedId);
    if (bucketEv) {
      openDropModal(
        bucketEv,
        drop.kind === 'time'
          ? { kind: 'member-day', memberId, start: drop.start }
          : { kind: 'member-week', memberId, date: drop.date },
      );
      return;
    }

    // ── Calendar entry (slice 08, spec §4/out-of-scope note) ──
    // An entry has no crew, so TG10's swap/reschedule split above (cross-lane = crew swap,
    // same-lane = reschedule) does not apply to it - every drop here is a plain reschedule,
    // cross-lane included ("a drop on another member's lane reschedules; it does not reassign the
    // participant" - reassigning WHO is a dialog concern, not a drag gesture, same TG10 rule the
    // board already encodes for crew). Placed AFTER the Plan Mode block above, not alongside the
    // `pv-` early return at the top of this function, so Plan Mode's exclusion (§3) still holds
    // here too: with Plan Mode active, `ev` above is never found for a non-bucket-job drop, and
    // this function already returned before reaching this branch.
    if (parsed.kind === 'calendar-entry') {
      if (!ability.can('update', 'CalendarEntry')) return; // spec §4 - not boardCapabilitiesFor (SALES reads readOnly:false there)
      const entryEv = scheduledEvents.find((e) => e.boardId === droppedId);
      if (!entryEv || !entryEv.start || !entryEv.end) return; // stale drag - card left the board mid-drag
      const durationMs = entryEv.end.getTime() - entryEv.start.getTime();
      const newStart = drop.kind === 'time'
        ? drop.start
        : atMinutes(drop.date, entryEv.start.getHours() * 60 + entryEv.start.getMinutes());
      if (newStart.getTime() === entryEv.start.getTime()) return; // dropped back on its own slot - silent no-op
      const newEnd = addMsToWallClock(newStart, durationMs);
      saveCalendarEntryMove(entryEv, newStart, newEnd);
      return;
    }

    // ── Already-scheduled BOARD card - TG10 direct gestures, no modal ──
    // (Replaces TG6's AssignJobDialog stopgap, which shed multi-crew and misrouted
    // walkthroughs.) The governing rule, encoded in classifyBoardDrop: cross-lane =
    // swap (crew change, time UNCHANGED); same-lane = reschedule (time change, crew
    // unchanged); same-lane same-day week cell / no source lane = no-op.
    const boardEv = scheduledEvents.find((e) => e.boardId === droppedId);
    if (!boardEv || !boardEv.start || !boardEv.end) return; // stale drag - card left the board mid-drag
    const boardGate = rescheduleGate(boardEv); // money, not status, freezes a job (Spec B1, B-2)
    if (!boardGate.ok) {
      toast("Can't reschedule", { description: `${boardEv.number} ${EM} ${boardGate.reason}` });
      return;
    }
    const oldStart = boardEv.start;
    const oldEnd = boardEv.end;

    const decision = classifyBoardDrop({
      fromMember: drop.fromMember,
      toMember: memberId,
      sameDay: isSameDay(oldStart, drop.kind === 'time' ? drop.start : drop.date),
      hasTime: drop.kind === 'time',
    });
    if (decision === 'noop') return;

    if (decision === 'swap') {
      // D2 - the drop-target member replaces the source-lane member, 1:1. Crew-only
      // REPLACE; the schedule is not touched (the slot's time/date is ignored).
      const res = swapCrew(boardEv.crew, drop.fromMember as string, memberId);
      if (res.kind === 'noop-not-on') return; // defensive - lane member left the crew mid-drag
      if (res.kind === 'noop-already-on') {
        toast(
          `${firstNameById.get(memberId) ?? 'That member'} is already on this ${
            boardEv.type === 'walkthrough' ? 'walkthrough' : 'job'
          }`,
        );
        return;
      }
      const fromFirst = firstNameById.get(drop.fromMember as string) ?? 'the previous member';
      const toFirst = firstNameById.get(memberId) ?? 'The new member';
      const onSwapped = () =>
        toast(`${toFirst} replaces ${fromFirst}`, {
          description: `${boardEv.number} ${EM} crew updated, schedule unchanged.`,
        });
      if (boardEv.type === 'walkthrough') {
        walkthroughCrewSwapMutation.mutate(
          { leadId: boardEv.parentId, visitId: boardEv.visitId, crew: res.crew },
          { onSuccess: onSwapped },
        );
      } else {
        jobCrewSwapMutation.mutate(
          { jobId: boardEv.parentId, visitId: boardEv.visitId, crew: res.crew },
          { onSuccess: onSwapped },
        );
      }
      return;
    }

    // Reschedule within the lane → the existing confirm flow (pendingMove +
    // RescheduleConfirmDialog), crew unchanged. Hour slots carry the new time; week
    // cells carry only the date - keep the event's time-of-day. Duration is kept.
    const durationMs = oldEnd.getTime() - oldStart.getTime();
    const newStart =
      drop.kind === 'time'
        ? drop.start
        : atMinutes(drop.date, oldStart.getHours() * 60 + oldStart.getMinutes());
    if (newStart.getTime() === oldStart.getTime()) return; // dropped back on its own slot - silent no-op
    const newEnd = addMsToWallClock(newStart, durationMs);
    setPendingMove({ eventId: boardEv.boardId, newStart, newEnd, crew: boardEv.crew });
    setRescheduleConfirm({ event: boardEv, oldStart, oldEnd, newStart, newEnd });
  };

  const isLoading = jobsLoading || walkthroughsLoading;

  // ─── Context value ────────────────────────────────────

  const scheduleCtxValue = useMemo<ScheduleContextValue>(() => ({
    onEventMouseEnter: handleEventMouseEnter,
    onEventMouseLeave: handleEventMouseLeave,
    onEventContextMenu: handleEventContextMenu,
    conflictIds,
  }), [handleEventMouseEnter, handleEventMouseLeave, handleEventContextMenu, conflictIds]);

  // ─── Render ──────────────────────────────────────────

  return (
    <ScheduleCtx.Provider value={scheduleCtxValue}>
      <AllDayOverflowProvider value={allDayOverflowApi}>
      {/* The board is a fixed-height surface, not a scrolling document: the
          calendar owns its own scroll and both member boards own theirs. So the
          page is a flex COLUMN - the board takes all of it - rather than the
          kit's usual stacked sections. */}
      <div className="flex h-full min-h-0 flex-col">
        {/* No PageHeader at all: the board IS the page. The title block carried
            a breadcrumb and the word "Schedule", both of which the sidebar's
            active row already says, and every pixel it took came out of the
            board's height. Nothing else depended on it - no `actions`, no
            `description`, and the surrounding column supplies its own spacing.
            The canvas still opens with 20px of padding above the page
            (`.canvas-body` in ui-kit/components/layout/shell.css), so the board
            has air above it rather than butting against the top bar.

            The page <h1> went with it, so one is kept for the document outline
            and the screen-reader heading list only - the kit's Heading, since
            the raw-tag ratchet forbids an <h1> outside src/ui-kit. `sr-only` is
            absolutely positioned, so it costs the flex column no height. */}
        <Heading level={1} scale="inherit" className="sr-only">Schedule</Heading>

        <div className="flex min-h-0 flex-1 overflow-hidden rounded-xl border bg-kit-card shadow-xs">

        {/* ── Collapsed rail: a thin strip with an "open panel" button ── */}
        {!sidebarOpen && (
          <div className="w-11 shrink-0 hidden lg:flex flex-col items-center border-r pt-2.5">
            {/* The legacy trigger was a raw button element, held back by a
                corner-radius mismatch with the OLD Button (rounded-button, 14px,
                no radius-only prop). The kit's Button is rounded-md at every size,
                so the reason is gone and this is a real Button - which also keeps
                the raw-tag ratchet at its floor instead of carrying a new raw tag
                into a new file. */}
            <Button
              variant="ghost"
              size="icon-sm"
              title="Open panel"
              aria-label="Open panel"
              onClick={() => setSidebarOpen(true)}
            >
              <PanelLeftOpen />
            </Button>
          </div>
        )}

        {/* ── Left Sidebar: search + the Unassigned bucket stack (TG11/Q8) ── */}
        {/* The stack component is the D6 drag-to-UNSCHEDULE drop target (grid-event-id only,
            refused in plan mode); the page keeps the stale + status guards in handleUnscheduleDrop. */}
        <div
          className={`shrink-0 ${sidebarOpen ? 'hidden lg:flex' : 'hidden'} flex-col border-r overflow-hidden`}
          style={{ width: sidebarWidth }}
        >

          {/* ── Schedule search + collapse button ── */}
          <div className="p-2.5 border-b shrink-0 flex items-center gap-2">
            <ScheduleSearch
              onSelect={handleSearchSelect}
              dateRange={dateRange}
              placeholder="Search schedule..."
              className="flex-1 min-w-0"
            />
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
              title="Collapse panel"
              aria-label="Collapse panel"
              onClick={() => setSidebarOpen(false)}
            >
              <PanelLeftClose />
            </Button>
          </div>

          <UnassignedBuckets
            events={visibleBucketEvents}
            members={orgRoster}
            onDragStartCard={handleBucketCardDragStart}
            onDragEndCard={handleBucketCardDragEnd}
            onUnscheduleDrop={handleUnscheduleDrop}
            onCardClick={handleBucketCardClick}
            onCardContextMenu={handleBucketCardContextMenu}
            unscheduleDropDisabled={planMode.isActive || boardReadOnly}
            dragDisabled={boardReadOnly}
            jobsError={unassignedError}
            hiddenTypes={hiddenBucketTypes}
            planCount={planBucket?.length ?? 0}
            planSlot={
              // Live pv- plan-visit cards (Service Plans PR A) - rendering + drags unchanged.
              canSeePlans ? (
                <>
                  {(planBucket?.length ?? 0) === 0 ? (
                    <div className="flex flex-col items-center justify-center py-6 text-center">
                      <CheckCircle2 className="h-5 w-5 text-status-green mb-1.5" />
                      <p className="text-[11px] text-muted-foreground">No plan visits due</p>
                    </div>
                  ) : (
                    (planBucket ?? []).map((plan) => (
                      <div
                        key={plan.id}
                        draggable={!boardReadOnly}
                        onDragStart={(e) => {
                          document.body.classList.add('is-dragging');
                          draggingJobIdRef.current = `pv-${plan.id}`;
                          setDraggingSidebarId(`pv-${plan.id}`);
                          e.dataTransfer.setData(PLAN_VISIT_PLAN_ID, plan.id);
                          e.dataTransfer.effectAllowed = 'move';
                          const ghost = document.createElement('div');
                          ghost.textContent = plan.service_plan_number;
                          ghost.style.cssText =
                            'position:fixed;top:-100px;background:rgb(var(--success));' +
                            'color:rgb(var(--text-on-fill));' +
                            'padding:4px 10px;border-radius:4px;font-size:12px;font-weight:600;white-space:nowrap;';
                          document.body.appendChild(ghost);
                          e.dataTransfer.setDragImage(ghost, ghost.offsetWidth / 2, 12);
                          requestAnimationFrame(() => {
                            if (document.body.contains(ghost)) document.body.removeChild(ghost);
                          });
                        }}
                        onDragEnd={() => {
                          document.body.classList.remove('is-dragging');
                          draggingJobIdRef.current = null;
                          setDraggingSidebarId(null);
                        }}
                        onClick={() => navigate(preferV2Path('/service-plans'))}
                        // NOT the kit's Card. Card's call-site appearance ratchet is
                        // at its floor, and this card's whole visual language is
                        // conditional appearance - a drag-in-flight state plus an
                        // overdue/due-soon border. Every one of those would be a
                        // className on Card and would turn the ratchet red. A plain
                        // div carrying kit tokens is the honest expression.
                        className={`bg-kit-card border rounded-lg p-2.5 cursor-grab select-none transition-all duration-150
                          ${draggingSidebarId === `pv-${plan.id}`
                            ? 'opacity-40 scale-[0.97] shadow-popover cursor-grabbing'
                            : plan.overdue
                              ? 'border-destructive hover:shadow-xs'
                              : plan.due_soon
                                ? 'border-status-amber hover:shadow-xs'
                                : 'hover:shadow-xs'
                          }`}
                      >
                        <div className="flex items-center justify-between gap-1.5">
                          <span className="font-bold text-xs text-brand">{plan.service_plan_number}</span>
                          <Badge
                            size="pill"
                            variant={plan.overdue ? 'softRed' : plan.due_soon ? 'softAmber' : 'softNeutral'}
                          >
                            {plan.visits_remaining === null ? 'Ongoing' : `${plan.visits_remaining} left`}
                          </Badge>
                        </div>
                        <p className="text-xs font-medium mt-0.5 truncate">{plan.customer}</p>
                        <p className="text-[11px] text-muted-foreground flex items-center gap-1 mt-0.5 min-w-0">
                          <MapPin className="h-3 w-3 shrink-0 text-subtle-foreground" />
                          <span className="truncate">{[plan.service_location.city, plan.service_location.state].filter(Boolean).join(', ')}</span>
                        </p>
                        <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{plan.recurrence}</p>
                        <p className={`text-[11px] mt-0.5 flex items-center gap-1 ${plan.overdue ? 'text-destructive font-medium' : 'text-muted-foreground'}`}>
                          <Clock className="h-3 w-3 shrink-0" />
                          Next due {formatInstant(plan.next_due, tz, { year: 'numeric', month: 'numeric', day: 'numeric' })}
                        </p>
                      </div>
                    ))
                  )}
                </>
              ) : undefined
            }
          />
        </div>

        {/* ── Sidebar resize handle (#193) - 6px hit-area straddling the sidebar's
            border-r via -3px margins on both sides, so it adds net-ZERO width to
            the flex row and layout at rest is pixel-identical. ── */}
        <div
          onMouseDown={startSidebarResize}
          aria-hidden="true"
          className={`${sidebarOpen ? 'hidden lg:block' : 'hidden'} relative z-10 -ml-[3px] -mr-[3px] w-[6px] shrink-0 cursor-col-resize transition-colors hover:bg-brand-subtle active:bg-muted`}
        />

        {/* ── Main Canvas ── */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">

          {/* Header bar - ONE row. It was two, with the view toggle and the
              department filter absolutely centred on the page and a layout
              effect measuring the gap between them to keep the lower one even.
              The board is the page, so the second row went back to the grid:
              every control now shares the date's line, with no measuring. Date
              navigation holds the left edge and everything else is pushed to
              the right by `ml-auto`, which is what keeps the line unbroken at
              ordinary widths. `flex-wrap` is the narrow-viewport relief valve
              - the row folds rather than overflowing, and only then costs the
              height back. */}
          {/* Groups are spaced by PURPOSE: gap-x-6 between them, gap-1 inside each, so the
              grouping is legible without separators. `justify-between` spreads them across
              the width instead of bunching them at the two edges, and every group is a normal
              flex child - the Standard/Member switch used to be absolutely positioned at the
              row's midpoint, which is why it could overlap its neighbours below ~700px. */}
          {/* THREE clusters, not six evenly-spaced groups: creation+navigation hold the
              left edge (the Create button sits immediately before Today, one step of space
              between them), the three view controls sit together in the middle, and the
              zoom + actions controls hold the right. `justify-between` spaces the three
              clusters; `gap-1` inside each keeps its own controls tight. */}
          <div className="relative flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2 border-b shrink-0">

            {/* ═══ LEFT: creation + navigation ═══ */}
            <div className="flex items-center gap-2">

            {/* ── Date nav (left) · view toggle, department, plan mode, gear (right) ── */}
            {/* Date navigation. The label sits BETWEEN the arrows, so prev/next
                read as stepping the thing they bracket. */}
            <div className="flex items-center gap-1">
              {/* The ONE creation trigger. Icon-only, so it carries both a tooltip and an
                  aria-label - there is no visible text to name it. Opens the unified popover
                  immediately: no dropdown, no intermediate step, no type chosen up front. */}
              {!boardReadOnly && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      ref={createButtonRef}
                      size="icon-sm"
                      variant="outline"
                      className={TOOLBAR_ICON_SIZE}
                      aria-label="Create"
                      onClick={() => {
                        const r = createButtonRef.current?.getBoundingClientRect();
                        setCreatePopover({ x: r?.left ?? 0, y: r?.bottom ?? 0, seed: null });
                      }}
                    >
                      <CalendarPlus />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Create</TooltipContent>
                </Tooltip>
              )}
            </div>

            {/* ── Group: navigation ── */}
            <div className="flex items-center gap-1">
              <Button size="sm" variant="outline" className={`${TOOLBAR_CONTROL_H} px-3 ${TOOLBAR_TEXT}`} onClick={handleNavigateToday}>
                Today
              </Button>
              {/* The prev/next triggers are located BY THEIR ICON CLASS in the
                  e2e suite (`.lucide-chevron-left` / `.lucide-chevron-right`),
                  so the icons stay exactly these two. The accessible names are
                  new: the legacy buttons had none at all. */}
              <Button size="sm" variant="ghost" className={`${TOOLBAR_ICON_SIZE} p-0`} aria-label="Previous period" onClick={handleNavigatePrev}>
                <ChevronLeft />
              </Button>
              {/* `key` is the label itself so the node REMOUNTS on change and
                  replays `schedule-popup-enter`. Keep the `font-semibold` +
                  `min-w-` pair: a page object locates this span by exactly
                  `span[class*="font-semibold"][class*="min-w"]`. `text-center`
                  is new - sitting between the arrows the label has to hold its
                  own centre, or the chevrons shuffle as its width changes. The
                  reserve is only as wide as the shortened labels actually need;
                  it used to be 170px, sized for "Saturday, August 8, 2026". */}
              <span key={dateRangeLabel} className="text-sm font-semibold text-center min-w-[104px] schedule-popup-enter">
                {dateRangeLabel}
              </span>
              <Button size="sm" variant="ghost" className={`${TOOLBAR_ICON_SIZE} p-0`} aria-label="Next period" onClick={handleNavigateNext}>
                <ChevronRight />
              </Button>
            </div>

            {/* Standard / Member toggle - D9: admin & dispatcher only (sales/tech
                see no toggle and are pinned to Standard via effectiveGroupedView).

                Absolutely positioned against the row (which carries `relative`),
                so the header is ONE line. Nudged 3.5rem LEFT of the true midpoint
                on purpose: dead centre crowds the trailing cluster, which is the
                denser side (view switcher + department select + two icon
                buttons). Optically centred, not arithmetically. Being out of
                flow is the point: it is what lets the
                left cluster and the trailing cluster keep their natural widths
                while the switch ignores both. Flow-based attempts do not hold -
                growing spacers either side only centre it when the two clusters
                happen to be equal width, and a `basis-full` line centres it
                perfectly but costs a second row. Both were measured.

                The tradeoff, accepted deliberately: out of flow means it cannot
                wrap away from its neighbours, so below roughly a 700px canvas it
                will overlap them rather than reflow. A role without the toggle
                renders nothing here, so its row is untouched either way and
                `ml-auto` still right-aligns the trailing cluster. */}
            {/* Everything that is not date navigation lives on the trailing
                edge: the view switcher, the department filter, plan mode and
                the settings gear. Splitting the row into two clusters - dates
                left, controls right - is what lets it hold one line, since the
                widest thing on it (the date label) no longer has to share the
                left edge with three other controls. */}
            </div>

            {/* ═══ MIDDLE: how the board is shown ═══ */}
            <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">

              {/* Day / Week / Month switcher. Month is hidden in grouped view. */}
              {/* Day / Week / Month as ONE dropdown (was three segmented cells). Month is
                  still withheld in grouped view - the option is absent, not disabled.
                  The option labels stay the lowercase `Views` constants with `capitalize`
                  doing the casing, so the rendered text is unchanged; only the control
                  shape is. NOTE: an e2e spec that clicked a visible "month" segment now has
                  to open this trigger first. */}
              <SelectField
                aria-label="Calendar view"
                value={calendarView}
                onValueChange={(v) => setCalendarView(v)}
                size="sm"
                className={`${TOOLBAR_CONTROL_H} w-fit gap-1.5 capitalize ${TOOLBAR_TEXT} ${TOOLBAR_HOVER}`}
                options={(effectiveGroupedView
                  ? [Views.DAY, Views.WEEK] as string[]
                  : [Views.DAY, Views.WEEK, Views.MONTH] as string[]
                ).map((v) => ({ value: v, label: v }))}
              />

            {/* Icon-only, matching the Create button and Plan Mode. The labels move to
                tooltips and aria-labels, so the accessible names are unchanged - dropping
                to an icon must not cost a screen-reader user the control's name. */}
            {canMemberView && (
                <SegmentedGroup aria-label="Board mode">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Segment
                        active={!isGroupedView}
                        aria-label="Standard"
                        className={`${TOOLBAR_ICON_SIZE} px-0 transition-all duration-300 ease-out`}
                        onClick={() => setIsGroupedView(false)}
                      >
                        <CalIcon />
                      </Segment>
                    </TooltipTrigger>
                    <TooltipContent>Standard</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Segment
                        active={isGroupedView}
                        aria-label="Member"
                        className={`${TOOLBAR_ICON_SIZE} px-0 transition-all duration-300 ease-out`}
                        onClick={() => {
                          setIsGroupedView(true);
                          if (calendarView === Views.MONTH) setCalendarView(Views.WEEK);
                        }}
                      >
                        <Users />
                      </Segment>
                    </TooltipTrigger>
                    <TooltipContent>Member</TooltipContent>
                  </Tooltip>
                </SegmentedGroup>
            )}
            </div>

            {/* ── Group: filters ── */}
            <div className="flex items-center gap-1">

              {/* Department filter */}
              <div className="w-fit" title="Filter schedule by department">
                {/* Back through the kit's one dropdown entry point, which counts
                    the list itself (DESIGN_SYSTEM.md §4.2). Same Radix trigger,
                    same `role="combobox"`, same accessible name, same `__add__`
                    sentinel - but an org with ten or more departments now gets a
                    searchable picker without this call site declaring anything. */}
                <SelectField
                  value={departmentFilter}
                  onValueChange={(v) => {
                    if (v === '__add__') {
                      setAddDeptOpen(true);
                      return; // sentinel: open the modal, leave the active filter untouched
                    }
                    setDepartmentFilter(v);
                  }}
                  size="sm"
                  aria-label="Filter schedule by department"
                  className={`${TOOLBAR_CONTROL_H} w-fit gap-1.5 ${TOOLBAR_TEXT} ${TOOLBAR_HOVER}`}
                  searchPlaceholder="Search departments…"
                  emptyMessage="No departments found."
                  options={[
                    { value: 'all', label: 'All departments' },
                    ...(departments ?? []).map((d) => ({ value: d.id, label: d.name })),
                    ...(canCreateDepartment
                      ? [{ value: '__add__', label: '+ Add department' }]
                      : []),
                  ]}
                />
              </div>

            </div>

            </div>

            {/* ═══ RIGHT: zoom + actions ═══ */}
            <div className="flex items-center gap-2">
            {/* ── Group: zoom ── minus, magnifier, plus as one bordered segment. The
                magnifier both states the current window (tooltip) and opens the pickers
                for setting it outright, because stepping from 6 AM to 11 AM one click at
                a time is not a control. */}
            <div className="flex items-center gap-1">
              <div className={`flex items-center gap-0.5 rounded-md border px-0.5 ${TOOLBAR_CONTROL_H}`}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="size-6"
                      aria-label="Show fewer hours"
                      disabled={!canNarrow}
                      onClick={() => nudgeWindow(-1)}
                    >
                      <Minus />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Show fewer hours</TooltipContent>
                </Tooltip>

                {/* The visible-hours VALUE used to render here as text, between the two
                    nudges. It was the widest thing in the zoom group and its width changed
                    with the window ("6a-8p" vs "12:30p-11:30p"), so the group breathed in
                    and out and shoved its neighbours along the row. A magnifier reads as
                    zoom directly, costs a fixed 24px, and the value stays one hover away -
                    in the tooltip, and in the accessible name, which is unchanged. */}
                <Popover open={windowPickerOpen} onOpenChange={setWindowPickerOpen}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <PopoverTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="size-6"
                          aria-label={`Visible hours, ${minutesToLabel(dayWindow.start)} to ${minutesToLabel(dayWindow.end)}. Click to edit.`}
                        >
                          <Search />
                        </Button>
                      </PopoverTrigger>
                    </TooltipTrigger>
                    {/* The FULL labels here ("6 AM", not "6a"). The short form exists to fit
                        a value into the toolbar's own width; a tooltip has room to spell it,
                        and this is the one place the window is read rather than glanced at. */}
                    <TooltipContent>
                      {minutesToLabel(dayWindow.start)}{EN}{minutesToLabel(dayWindow.end)}
                    </TooltipContent>
                  </Tooltip>
                  <PopoverContent align="end" className="w-[268px] p-3">
                    <div className="flex flex-col gap-3">
                      <div className="grid grid-cols-2 gap-2">
                        <div className="flex flex-col gap-1">
                          <Label htmlFor="window-from" className="text-[11px]">From</Label>
                          <TimeCombobox
                            id="window-from"
                            value={minutesToHHMM(dayWindow.start)}
                            stepMinutes={30}
                            onChange={(v) => {
                              const mins = hhmmToMinutes(v);
                              if (mins !== null) commitWindow({ start: mins, end: dayWindow.end });
                            }}
                          />
                        </div>
                        <div className="flex flex-col gap-1">
                          <Label htmlFor="window-to" className="text-[11px]">To</Label>
                          <TimeCombobox
                            id="window-to"
                            value={minutesToHHMM(Math.min(dayWindow.end, 24 * 60 - 1))}
                            stepMinutes={30}
                            onChange={(v) => {
                              const mins = hhmmToMinutes(v);
                              if (mins !== null) commitWindow({ start: dayWindow.start, end: mins });
                            }}
                          />
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-1.5">
                        {WINDOW_PRESETS.map((preset) => (
                          <Button
                            key={preset.label}
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-[11px]"
                            onClick={() => commitWindow({ start: preset.start, end: preset.end })}
                          >
                            {preset.label}
                          </Button>
                        ))}
                      </div>

                      <p className="text-muted-foreground text-[11px]">
                        Sets which hours fill the screen. The whole day is still
                        there - scroll to reach it.
                      </p>
                    </div>
                  </PopoverContent>
                </Popover>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="size-6"
                      aria-label="Show more hours"
                      disabled={!canWiden}
                      onClick={() => nudgeWindow(1)}
                    >
                      <Plus />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Show more hours</TooltipContent>
                </Tooltip>
              </div>
            </div>

            {/* ── Group: actions ── */}
            <div className="flex items-center gap-1">

              {/* Plan Mode toggle - Admin & Dispatcher only.
                  Icon-only, with the label in a tooltip: same icon-plus-Tooltip
                  pattern the kit sidebar uses for its rail rows
                  (ui-kit/components/layout/nav/sidebar.tsx). Active carries the
                  amber status fill because amber is what the banner, the ghost
                  overlay and this pill all mean by "draft, not yet committed";
                  idle is the plain outline cell. The pinging dot is kept - it is
                  the only affordance that says the mode is LIVE rather than
                  merely selected, and it is the whole content when active.

                  The label ALSO stays as `aria-label`, so the accessible name is
                  unchanged: dropping to an icon must not cost a screen-reader
                  user the control's name, and the e2e page object still finds it
                  by `getByRole('button', { name: /Plan Mode|Planning/i })`. */}
              {canPlanMode && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon-sm"
                      variant={planMode.isActive ? 'ghost' : 'outline'}
                      aria-pressed={planMode.isActive}
                      aria-label={planMode.isActive ? 'Planning' : 'Plan Mode'}
                      className={
                        planMode.isActive
                          ? `${TOOLBAR_ICON_SIZE} bg-status-amber text-on-fill hover:bg-status-amber hover:text-on-fill`
                          : TOOLBAR_ICON_SIZE
                      }
                      onClick={handlePlanModeToggle}
                    >
                      {planMode.isActive ? (
                        <span className="relative flex h-2 w-2">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-on-fill opacity-75" />
                          <span className="relative inline-flex rounded-full h-2 w-2 bg-on-fill" />
                        </span>
                      ) : (
                        <PenLine />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{planMode.isActive ? 'Planning' : 'Plan Mode'}</TooltipContent>
                </Tooltip>
              )}

              <SettingsGearDropdown
                roleFilter={roleFilter}
                onRoleFilterChange={setRoleFilter}
                isGroupedView={effectiveGroupedView}
              />
            </div>
            </div>

          </div>

          {/* Plan Mode Banner. The legacy band was a hand-rolled amber GRADIENT
              built from two legacy ramp stops; on the kit it is the flat
              `status-amber` fill, which is the one token the whole app already
              uses to mean "pending / not yet committed". Same copy, same two
              actions, same disabled rule. */}
          {planMode.isActive && (
            <div className="flex items-center justify-between gap-3 px-4 py-2.5 shrink-0 bg-status-amber text-on-fill">
              <div className="flex items-center gap-2.5 text-sm font-medium">
                <span className="relative flex h-2.5 w-2.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-on-fill opacity-75" />
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-on-fill" />
                </span>
                Plan Mode
                <span className="font-normal">{EM} {planMode.ghostCount} draft{planMode.ghostCount !== 1 ? 's' : ''}</span>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-7 px-2.5 text-[12px]"
                  onClick={() => {
                    planMode.discardAll();
                    queryClient.invalidateQueries({ queryKey: ['schedule-unassigned'] });
                    queryClient.invalidateQueries({ queryKey: ['schedule-unscheduled-walkthroughs'] });
                  }}
                  disabled={planMode.ghostCount === 0}
                >
                  <Trash2 />
                  Discard All
                </Button>
                <Button
                  size="sm"
                  className="h-7 px-2.5 text-[12px]"
                  onClick={() => {
                    const visible = planMode.getGhostsForView(dateRange.start, dateRange.end);
                    if (visible.length === 0) return;
                    setShowConfirmAllDialog(true);
                  }}
                  disabled={planMode.ghostCount === 0}
                >
                  <CheckSquare />
                  Confirm All
                </Button>
              </div>
            </div>
          )}

          {/* Calendar or TechnicianGridView or MemberWeekBoard */}
          {effectiveGroupedView ? (
            <div className={`flex-1 min-h-0 overflow-hidden ${planMode.isActive ? 'plan-mode-active' : ''}`}>
              {calendarView === Views.WEEK ? (
                <MemberWeekBoard
                  weekStart={asWallClock(startOfWeek(currentDate, { weekStartsOn: 0 }))}
                  staff={boardMembers}
                  events={allEvents}
                  conflictIds={conflictIds}
                  isLoading={isLoading}
                  tz={tz}
                  draggingJobIdRef={draggingJobIdRef}
                  onSelectEvent={openEditorFor}
                  onDropJob={(droppedId, memberId, date, fromMember) =>
                    // Day-granularity drop - the unified modal pre-fills the date and
                    // anchors the time at the org default (autoTime stays off).
                    handleMemberBoardDrop(droppedId, memberId, { kind: 'day', date, fromMember })
                  }
                  onGhostContextMenu={planMode.isActive ? handleGhostContextMenu : undefined}
                />
              ) : (
                <TechnicianGridView
                  date={currentDate}
                  members={boardMembers}
                  events={allEvents}
                  conflictIds={conflictIds}
                  isLoading={isLoading}
                  draggingJobIdRef={draggingJobIdRef}
                  onDropJob={(droppedId, memberId, start, end, fromMember) =>
                    handleMemberBoardDrop(droppedId, memberId, { kind: 'time', start, end, fromMember })
                  }
                  // TG12 - onEventClick covers ALL card types (walkthroughs included);
                  // onSelectJob stays as the component's job-only fallback path.
                  onEventClick={openEditorFor}
                  onSelectJob={(jobId) => setEditorEventId(jobId)}
                  onGhostContextMenu={planMode.isActive ? handleGhostContextMenu : undefined}
                />
              )}
            </div>
          ) : (
            <div
              ref={calendarWrapRef}
              style={hourHeight ? ({ '--hour-height': `${hourHeight}px` } as React.CSSProperties) : undefined}
              className={`flex-1 relative min-h-0 schedule-cal overflow-hidden ${planMode.isActive ? 'plan-mode-active' : ''} ${hasAllDayEvents ? 'has-allday-events' : ''}`}
              data-focus-day={focusedDayIndex === null ? undefined : focusedDayIndex}
              onDoubleClick={handleCalendarDoubleClick}
            >
              {/* `.animate-spin` is the e2e loading locator on this page - keep it. */}
              {isLoading && (
                <div className="absolute inset-0 bg-kit-card/70 z-10 flex items-center justify-center">
                  <Loader2 className="h-8 w-8 animate-spin text-brand" />
                </div>
              )}
              {/* Copy is verbatim, "this week" included: it says the same thing in
                  Day and Month view, which reads wrong, but a presentation swap
                  does not get to fix copy. Logged in the ledger instead.
                  The kit's EmptyState takes an ELEMENT where the old one took a
                  component reference. */}
              {allEvents.length === 0 && !isLoading && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center z-10">
                  <EmptyState
                    icon={<CalendarX2 />}
                    title="No jobs scheduled this week"
                    description="Drag a job from the panel on the left to assign it"
                  />
                </div>
              )}
              {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
              <DnDCalendar
                localizer={localizer}
                events={allEvents as unknown as object[]}
                view={calendarView as 'day' | 'week' | 'month' | 'agenda' | 'work_week'}
                onView={(v) => setCalendarView(v as string)}
                date={currentDate}
                getNow={() => nowWallClock(tz)}
                onNavigate={(date: Date) => setCurrentDate(asWallClock(date))}
                onDrillDown={((date: Date) => {
                  // Month view: clicking a day's number jumps straight to that day's schedule
                  setCurrentDate(asWallClock(date));
                  setCalendarView(Views.DAY);
                }) as unknown as (date: object) => void}

                // allEvents is ScheduledBoardEvent[] (start/end narrowed to real Dates
                // by the scheduledEvents type predicate) - only the library-interface cast
                // remains. allDay derives from raw.
                startAccessor={((e: ScheduledBoardEvent) => e.start) as unknown as (event: object) => Date}
                endAccessor={((e: ScheduledBoardEvent) => e.end) as unknown as (event: object) => Date}
                allDayAccessor={((e: ScheduledBoardEvent) => isAllDayEvent(e)) as unknown as (event: object) => boolean}
                onSelectEvent={handleCalendarSelectEvent as unknown as (event: object) => void}
                onDoubleClickEvent={handleCalendarDoubleClickEvent as unknown as (event: object) => void}
                // Kills react-big-calendar's native `title` attribute. Without
                // this the browser's own tooltip opens on top of the peek card,
                // so hovering a job showed the same name twice, in two styles.
                // Empty string, not null: the prop is typed to return a string,
                // and RBC only sets the attribute when the value is truthy.
                tooltipAccessor={() => ''}
                onEventDrop={handleEventDrop as unknown as (args: object) => void}
                onEventResize={handleEventResize as unknown as (args: object) => void}
                onDropFromOutside={handleDropFromOutside as unknown as (args: object) => void}
                dragFromOutsideItem={() => {
                  // P0 fix: return null when not dragging, include start/end for drop preview
                  // Use a 2-hour duration anchored at midnight - the library uses the duration
                  // to size the preview, and the drop slot determines the actual position
                  const id = draggingJobIdRef.current;
                  if (!id) return null as unknown as object;
                  const base = new Date();
                  base.setHours(0, 0, 0, 0);
                  return { id, title: 'Drop to schedule', start: base, end: new Date(base.getTime() + 2 * 60 * 60 * 1000) } as unknown as object;
                }}
                eventPropGetter={eventStyleGetter as unknown as (event: object) => { className?: string; style?: React.CSSProperties }}
                slotPropGetter={slotPropGetter as unknown as (date: object) => { style?: React.CSSProperties }}
                draggableAccessor={(event: object) => {
                  if (boardReadOnly) return false; // D9 - technician board is view-only
                  const e = event as BoardEvent;
                  // Slice 08 (spec §4) - a calendar entry's drag is gated on the CalendarEntry
                  // grant directly, NOT on boardCapabilitiesFor (which reads readOnly:false for
                  // SALES - a SALES user who cannot create/update an Event must not be able to
                  // drag one). isDragInert's one call site (slice 03) is gone: dragChannels.ts now
                  // has the `ce-` case, and handleEventDrop/handleEventResize each have their own
                  // calendar-entry branch ahead of the job-fallback logic, so the misroute
                  // isDragInert existed to prevent (PATCH /api/jobs/<entry-uuid>/assign) can no
                  // longer happen even with the drag turned on here.
                  if (e.type === 'calendar-entry') return ability.can('update', 'CalendarEntry');
                  // Money, not status, freezes a job for rescheduling (Spec B1, B-2).
                  if (!e.isGhost && !rescheduleGate(e).ok) return false;
                  return true;
                }}
                resizable={!boardReadOnly}
                resizableAccessor={(event: object) => {
                  if (boardReadOnly) return false; // D9 - belt & braces with resizable above
                  const e = event as BoardEvent;
                  // Money, not status, freezes a job for rescheduling (Spec B1, B-2).
                  if (isAllDayEvent(e)) return false;
                  if (e.type === 'calendar-entry') return ability.can('update', 'CalendarEntry'); // slice 08, spec §4 - see draggableAccessor above
                  if (!e.isGhost && !rescheduleGate(e).ok) return false;
                  return true;
                }}
                selectable
                onSelectSlot={handleSelectSlot as unknown as (slotInfo: object) => void}
                components={calendarComponents as unknown as object}
                scrollToTime={DAY_SCROLL_TO}
                min={DAY_MIN}
                max={DAY_MAX}
                // Caps the all-day strip so it can never crush the date header.
                // rbc reads this as maxRows = allDayMaxRows + 1 (the +1 carries the
                // "+N more" chip), so 2 = a three-row strip. See ALL_DAY_MAX_ROWS.
                allDayMaxRows={ALL_DAY_MAX_ROWS}
                // Side by side, never stacked: overlapping events each get
                // their own slice of the column and nothing is drawn over
                // anything else. The fanned Google-style cascade that was here
                // (cascadeLayout.ts, commit c9fdc07ef) is one line away if the
                // occlusion is ever wanted back - Ran chose side-by-side after
                // seeing both, and this is the whole of that choice.
                //
                // It puts the weight on the CARD instead: a narrow slice has to
                // choose its content, which is what the size tiers in
                // ScheduleEvent do, and on the slot-height control in the
                // toolbar, which buys height when the day is busy.
                dayLayoutAlgorithm="no-overlap"
                style={{ height: '100%' }}
                popup
              />
            </div>
          )}
        </div>

        {/* Hover tooltip + click popup removed - the TG12 event editor opens on click */}

        {/* ── Right-Click Context Menu ── */}
        {contextMenu && (
          <ScheduleContextMenu
            event={contextMenu.event}
            x={contextMenu.x}
            y={contextMenu.y}
            readOnly={boardReadOnly}
            onClose={() => setContextMenu(null)}
            onOpenDetails={(e) => {
              setContextMenu(null);
              // `preferV2Path` is a no-op shim now (see `uiV2.ts`), so these
              // resolve to `/jobs/:id` and `/leads/:id`. It earned its place when
              // the two designs sat at different URLs and a bare path here
              // dropped the user into the old job page with no way back.
              if (e.type === 'job') navigate(preferV2Path(`/jobs/${e.parentId}`));
              else navigate(preferV2Path(`/leads/${e.raw.id as string}`));
            }}
            onEdit={(e) => {
              setContextMenu(null);
              openEditorFor(e);
            }}
            onCancel={(e) => {
              setContextMenu(null);
              if (e.type === 'job') setCancelDialog({ open: true, jobId: e.parentId });
            }}
          />
        )}

        {/* ── Sidebar Card Context Menu ── */}
        {sidebarContextMenu && (
          <MenuSurface
            className="w-48"
            style={{ left: sidebarContextMenu.x, top: sidebarContextMenu.y }}
            onClick={(ev) => ev.stopPropagation()}
          >
            <MenuItem
              onClick={() => {
                const path = sidebarContextMenu.type === 'walkthrough' ? 'leads' : 'jobs';
                navigate(preferV2Path(`/${path}/${sidebarContextMenu.id}`));
                setSidebarContextMenu(null);
              }}
            >
              <ExternalLink />
              {sidebarContextMenu.type === 'walkthrough' ? 'View Lead' : 'View Job'}
            </MenuItem>
          </MenuSurface>
        )}

        {/* ── Event peek. Hover and click show the SAME card; pinning only changes how
               long it survives. Because the card now carries actions, the pointer has to
               be able to travel from the event onto it: entering cancels the pending hide,
               leaving restarts it, exactly as moving between two cards already does. ── */}
        {peek && (
          <EventPeekCard
            event={peek.event}
            x={peek.x}
            y={peek.y}
            pinned={peek.pinned}
            onMouseEnter={() => {
              if (hideTimer.current) clearTimeout(hideTimer.current);
              hideTimer.current = null;
            }}
            onMouseLeave={handleEventMouseLeave}
            onClose={() => setPeek(null)}
            onOpen={() => {
              setPeek(null);
              setEditorEventId(peek.event.boardId);
            }}
          />
        )}

        {/* ── Slot-Click Quick-Schedule Popover ── */}

        {/* ── THE creation surface. Two entry points, one component. ── */}
        <ScheduleCreatePopover
          open={Boolean(createPopover)}
          onOpenChange={(o) => { if (!o) setCreatePopover(null); }}
          anchor={createPopover ? { x: createPopover.x, y: createPopover.y } : null}
          tz={tz}
          seed={createPopover?.seed ?? null}
          unassignedJobs={unassignedJobs ?? []}
          unscheduledWalkthroughs={unscheduledWalkthroughs ?? []}
          showWalkthroughs={leadsEnabled}
          canCreateEvent={canCreateCalendarEntry}
          defaultWalkthroughDurationMin={org?.default_walkthrough_duration_min ?? 60}
        />

        {/* ── All-day overflow panel (Layer 1) ── */}
        <AllDayOverflowPanel
          state={allDayOverflow}
          api={allDayOverflowApi}
          onSelect={openEditorFor}
          styleFor={eventStyleGetter}
          // Handed down rather than derived inside the panel: `eventDangerState` resolves the
          // precedence between the two reds and needs `conflictIds`, which lives in this page's
          // context. One derivation, two surfaces - the alternative is a second opinion about
          // what "needs crew" means, on the one screen where they sit inches apart.
          dangerFor={(ev) => eventDangerState(ev, conflictIds)}
        />


        {/* ── Ghost Context Menu ── */}
        {ghostContextMenu && (() => {
          const ghost = planMode.getGhostById(ghostContextMenu.ghostId);
          if (!ghost) return null;
          const mx = safeX(ghostContextMenu.x, 180);
          const my = safeY(ghostContextMenu.y, 100);
          return (
            <MenuSurface
              className="w-44"
              style={{ left: mx, top: my }}
              onClick={(ev) => ev.stopPropagation()}
            >
              <MenuItem
                onClick={() => {
                  setGhostContextMenu(null);
                  setShowConfirmDialog({ ghostId: ghost.id, ghost });
                }}
              >
                <CheckSquare className="text-status-green" />
                Confirm
              </MenuItem>
              <Separator className="my-0.5" />
              <MenuItem
                danger
                onClick={() => {
                  setGhostContextMenu(null);
                  planMode.removeGhost(ghost.id);
                  if (ghost.isFromSidebar) {
                    queryClient.invalidateQueries({ queryKey: ['schedule-unassigned'] });
                    queryClient.invalidateQueries({ queryKey: ['schedule-unscheduled-walkthroughs'] });
                  }
                }}
              >
                <Trash2 />
                Remove
              </MenuItem>
              {/* TODO: Reassign option (skip for MVP) */}
            </MenuSurface>
          );
        })()}

        {/* ── Ghost Confirm Dialog ── */}
        {showConfirmDialog && (() => {
          const { ghostId, ghost } = showConfirmDialog;
          const isConfirming = confirmingGhostIds.has(ghostId);
          // Crew-axis fallback - "Unassigned" retired from the schedule UI; an empty
          // crew here is the §3.8 "needs crew" condition, not the unscheduled state.
          const techName = ghostCrewNames(ghost) || 'No crew';
          const customer = ghost.raw.customer as { first_name: string; last_name: string; email?: string } | null;
          const ghostStart = toWallClock(new Date(ghost.start), tz);

          return (
            <ScheduleConfirmDialog
              open
              onOpenChange={(o) => { if (!o) setShowConfirmDialog(null); }}
              icon={<CheckSquare />}
              title={`Schedule ${ghost.sourceType === 'job' ? 'Job' : 'Walkthrough'}?`}
              description={`${format(ghostStart, 'EEEE, MMMM d')} at ${format(ghostStart, 'h:mm a')}`}
              confirmLabel="Confirm & Schedule"
              isLoading={isConfirming}
              onConfirm={async () => {
                await handleConfirmGhost(ghostId);
                setShowConfirmDialog(null);
              }}
            >
              <div className="bg-muted rounded-lg p-3 space-y-1.5">
                <p className="text-[12px] text-muted-foreground">
                  <span className="font-semibold text-foreground">Assign to:</span> {techName}
                </p>
                {customer && (
                  <p className="text-[12px] text-muted-foreground">
                    <span className="font-semibold text-foreground">Customer:</span>{' '}
                    {customer.first_name} {customer.last_name}
                  </p>
                )}
                {ghost.address && (
                  <p className="text-[12px] text-muted-foreground">
                    <span className="font-semibold text-foreground">Location:</span> {ghost.address}
                  </p>
                )}
              </div>
            </ScheduleConfirmDialog>
          );
        })()}

        {/* ── Confirm All Dialog ── */}
        {showConfirmAllDialog && (() => {
          const visible = planMode.getGhostsForView(dateRange.start, dateRange.end);
          return (
            <ScheduleConfirmDialog
              open
              onOpenChange={(o) => { if (!o) setShowConfirmAllDialog(false); }}
              icon={<CheckSquare />}
              title={`Confirm ${visible.length} Change${visible.length !== 1 ? 's' : ''}?`}
              description="This will schedule all draft events visible in the current view."
              confirmLabel={`Confirm ${visible.length} Change${visible.length !== 1 ? 's' : ''}`}
              isLoading={confirmingGhostIds.size > 0}
              onConfirm={handleConfirmAllGhosts}
            >
              <div className="bg-muted rounded-lg p-3 max-h-40 overflow-y-auto space-y-1">
                {visible.map((g) => (
                  <p key={g.id} className="text-[12px] text-muted-foreground">
                    {g.title} {EM} {ghostCrewNames(g) || 'No crew'}
                  </p>
                ))}
              </div>
            </ScheduleConfirmDialog>
          );
        })()}

        {/* ── Plan Mode Exit Dialog ── */}
        {/* THREE footer actions (Cancel / Discard & Exit / Confirm All & Exit), so
            neither the kit's `ui/confirmDialog` nor this module's own
            ScheduleConfirmDialog fits - both hold a fixed Cancel+Confirm pair. The
            legacy page reached for `ui/modal` for the same reason; the kit ships no
            Modal, so this is the kit's Dialog parts assembled directly. It has no
            body, only a header and a footer. */}
        <Dialog open={showExitDialog} onOpenChange={(o) => { if (!o) setShowExitDialog(false); }}>
          <DialogContent>
            <DialogHeader>
              <DialogIcon tone="warning"><PenLine /></DialogIcon>
              <div>
                <DialogTitle>
                  {`You have ${planMode.ghostCount} unconfirmed change${planMode.ghostCount !== 1 ? 's' : ''}`}
                </DialogTitle>
                <DialogDescription>
                  Would you like to confirm or discard your draft changes before exiting plan mode?
                </DialogDescription>
              </div>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setShowExitDialog(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  planMode.forceDeactivate();
                  queryClient.invalidateQueries({ queryKey: ['schedule-unassigned'] });
                  queryClient.invalidateQueries({ queryKey: ['schedule-unscheduled-walkthroughs'] });
                  setShowExitDialog(false);
                }}
              >
                Discard &amp; Exit
              </Button>
              <Button
                isLoading={confirmingGhostIds.size > 0}
                onClick={async () => {
                  await handleConfirmAllGhosts();
                  planMode.forceDeactivate();
                  setShowExitDialog(false);
                }}
              >
                {confirmingGhostIds.size > 0 ? 'Scheduling...' : 'Confirm All & Exit'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Navigation warning handled via beforeunload (browser-level) */}

        {/* ── Conflict Modal ── */}
        {/* RESIDUAL - not a Radix ConfirmDialog, by the overlay-consolidation pass, STILL true
            after Q6/a11y (extracted to components/conflictModal.tsx for testability, but the
            markup itself is still hand-rolled). `conflictToast` is one of the states EventEditor's
            own `open` prop is gated against (`!conflictToast && !unscheduleConfirm`, see the
            comment at EventEditor below) specifically so a Radix dialog is never left stacked
            under this overlay. It can be set from INSIDE an already-open EventEditor
            (handleEditorSaveTime's mutation onError, on a live 409), so converting this to a
            Radix-based ConfirmDialog would make EventEditor's Dialog run its ~200ms exit animation
            (Presence keeps it mounted for the `animate-out`/`fade-out` classes in ui/dialog.tsx)
            at the same moment this dialog's Radix Dialog opens - a real overlap window, not just
            a stacked-forever case. That overlap is exactly the "stacking...fights its focus lock"
            failure this file's own gating was written to avoid (see the D5 `needsCrewConfirm`
            precedent below). No test coverage exists for THIS PAGE to catch a live focus-lock
            regression, so this block - together with the Empty-crew warning and D6 unschedule
            confirm below, which share the identical EventEditor/UnifiedDropModal
            swap-on-the-same-tick risk - is intentionally left on its original hand-rolled markup
            rather than risk breaking scheduling. ConflictModal itself DOES carry unit coverage
            (conflictModal.test.tsx) for its a11y semantics and focus behaviour, in isolation from
            this page. Escape still closes it via the page-global handler above; ConflictModal adds
            no second Escape handler of its own. No focus TRAP - Tab is not contained inside the
            panel. */}
        {conflictToast && (
          <ConflictModal
            message={conflictToast.message}
            conflicts={conflictToast.conflicts}
            tz={tz}
            isLoading={assignMutation.isPending || visitRescheduleMutation.isPending || walkthroughRescheduleMutation.isPending}
            onCancel={() => setConflictToast(null)}
            onConfirm={() => {
              const p = conflictToast.pendingPayload;
              if (p.kind === 'visit') {
                visitRescheduleMutation.mutate({
                  jobId: p.jobId,
                  visitId: p.visitId,
                  start: p.start,
                  end: p.end,
                  force: true,
                });
              } else if (p.kind === 'walkthrough') {
                walkthroughRescheduleMutation.mutate({
                  leadId: p.leadId,
                  visitId: p.visitId,
                  newStart: p.newStart,
                  crew: p.crew,
                  durationMinutes: p.durationMinutes,
                  force: true,
                });
              } else {
                assignMutation.mutate({ jobId: p.jobId, crew: p.crew, start: p.start, end: p.end, force: true });
              }
            }}
          />
        )}

        {/* ── Error Toast ── */}
        {/* Deliberately NOT sonner. This is a page-owned, MANUALLY dismissed
            surface: `errorToast` is cleared by its own Dismiss button and by the
            page's global Escape handler, and it stays on screen until one of
            those happens. sonner auto-dismisses after 4s and owns its own
            lifecycle, so routing this through `toast.error` would silently drop a
            failed schedule write off the screen while the user was still looking
            at the board. The one-way toasts (crew updated, scheduled, completed,
            can't reschedule) DO go through sonner - they are advisory and
            transient. Only the paint moved onto kit tokens here. */}
        {errorToast && (
          <div className="fixed bottom-6 right-6 z-surface max-w-sm rounded-xl border bg-status-red-subtle p-4 shadow-popover schedule-toast-enter">
            <div className="flex items-start gap-2">
              <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
              <div className="flex-1">
                <p className="text-[13px] font-bold text-destructive">Error</p>
                <p className="mt-0.5 text-[13px] text-destructive">{errorToast}</p>
              </div>
            </div>
            <div className="mt-3">
              <Button size="sm" variant="outline" onClick={() => setErrorToast(null)}>
                Dismiss
              </Button>
            </div>
          </div>
        )}

        {/* ── Reschedule Confirm Dialog ── */}
        {rescheduleConfirm && (() => {
          const rc = rescheduleConfirm;
          // A drag-reschedule changes TIME only - the crew rides along unchanged
          // (crew ⟂ schedule), so the dialog lists the card's whole crew once. The CARD's
          // crew (slice 02): for a job's trip, the people on that trip, not the job's union.
          const crewNames = eventCrewPeople(rc.event)
            .map(fullName)
            .filter((n): n is string => Boolean(n));
          return (
            <RescheduleConfirmDialog
              open={true}
              eventType={rc.event.type === 'walkthrough' ? 'walkthrough' : 'job'}
              eventNumber={rc.event.number}
              oldStart={rc.oldStart}
              oldEnd={rc.oldEnd}
              newStart={rc.newStart}
              newEnd={rc.newEnd}
              crewNames={crewNames}
              onConfirm={() => {
                // Rule: a reschedule POSTs the event's CURRENT crew with the new times -
                // never an empty array unless the crew really is empty (crew ⟂ schedule).
                if (rc.event.type === 'job') {
                  // The dragged CARD is a trip, so the write names that trip. Crew rides along
                  // untouched by omission, which is what crew unchanged means on that route.
                  moveJobEvent(rc.event, {
                    startIso: wallClockToIso(rc.newStart, tz),
                    endIso: wallClockToIso(rc.newEnd, tz),
                    crew: rc.event.crew,
                  });
                } else {
                  // The dragged CARD is a walkthrough trip (slice 03): the write names that trip.
                  moveWalkthroughEvent(rc.event, {
                    newStart: wallClockToIso(rc.newStart, tz),
                    durationMinutes: Math.round(
                      (rc.newEnd.getTime() - rc.newStart.getTime()) / 60_000,
                    ),
                  });
                }
                setRescheduleConfirm(null);
                setPendingMove(null);
              }}
              onCancel={() => {
                setRescheduleConfirm(null);
                setPendingMove(null);
              }}
              isLoading={assignMutation.isPending || walkthroughRescheduleMutation.isPending}
            />
          );
        })()}

        {/* ── Assign Dialog ── */}
        <AssignJobDialog
          open={assignDialog.open}
          onOpenChange={(o) => setAssignDialog((prev) => ({ ...prev, open: o }))}
          jobId={assignDialog.jobId}
          defaultStart={assignDialog.defaultStart}
          defaultEnd={assignDialog.defaultEnd}
          defaultIsAllDay={assignDialog.defaultIsAllDay}
        />

        {/* ── Cancel Dialog ── */}
        <CancelJobDialog
          open={cancelDialog.open}
          onOpenChange={(o) => setCancelDialog((prev) => ({ ...prev, open: o }))}
          jobId={cancelDialog.jobId}
        />

        {/* ── Add-Department Dialog (from the "+ Add department" dropdown option) ── */}
        <Dialog
          open={addDeptOpen}
          onOpenChange={(o) => {
            if (!o) {
              setAddDeptOpen(false);
              setNewDeptName('');
            }
          }}
        >
          <DialogContent>
            <DialogHeader>
              {/* The kit's DialogHeader is a flex ROW (icon then text block), so the
                  title and description are wrapped together - without the wrapper
                  the description sits beside the title instead of under it. */}
              <div>
                <DialogTitle>Create a new department</DialogTitle>
                <DialogDescription>
                  The schedule will switch to filtering by the new department.
                </DialogDescription>
              </div>
            </DialogHeader>
            <DialogBody>
              <Input
                autoFocus
                aria-label="Department name"
                placeholder="Department name"
                value={newDeptName}
                onChange={(e) => setNewDeptName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitCreateDepartment();
                }}
              />
            </DialogBody>
            <DialogFooter>
              <Button
                variant="ghost"
                onClick={() => {
                  setAddDeptOpen(false);
                  setNewDeptName('');
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={() => void submitCreateDepartment()}
                disabled={!newDeptName.trim()}
                isLoading={createDept.isPending}
              >
                Create
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* ── TG12 Event Editor - every live card click (board + bucket) ── */}
        {/* Hidden (id kept) while a plain overlay is up - the conflict modal or the
            unschedule confirm - stacking one over a Radix dialog fights its focus lock
            (the UnifiedDropModal/needsCrewConfirm precedent). It reopens after. */}
        <EventEditor
          open={Boolean(editorEvent) && !conflictToast && !unscheduleConfirm}
          event={editorEvent}
          members={orgRoster}
          readOnly={boardReadOnly}
          // The SAME verdict `orgRoster` is scoped by and `openDropModal` seeds with, never a
          // second read - one source, so the editor's Crew field cannot be locked on a different
          // answer from the one the rest of this page acted on.
          canAssignOthers={canAssignOthers}
          actorKnownPeople={actorKnownPeople}
          canUnschedule={editorUnscheduleGate?.ok ?? false}
          unscheduleDisabledReason={
            editorUnscheduleGate && !editorUnscheduleGate.ok ? editorUnscheduleGate.reason : undefined
          }
          canComplete={editorCanComplete}
          onSaveCrew={handleEditorSaveCrew}
          onSaveTime={handleEditorSaveTime}
          onUnschedule={() => {
            if (editorEvent) {
              setUnscheduleConfirm(editorEvent); // page owns confirm + POST
            }
          }}
          onComplete={() => {
            if (editorEvent) {
              // Page owns the POST - one-click close-out, no completion-note modal.
              completeMutation.mutate({ jobId: editorEvent.parentId, number: editorEvent.number });
              setEditorEventId(null);
            }
          }}
          onClose={() => setEditorEventId(null)}
        />

        {/* ── Slice 04 - the Event dialog (create + edit, calendar-entries spec §4/§7) ── */}
        {/* Two instances, not one dual-purpose `open`: "New Event" and clicking a live
            entry card are independent triggers that must not fight over the same id state
            (opening one must not implicitly close the other mid-click). */}
        {/* The create-mode Event dialog is unwired: Events are now created in the
            unified ScheduleCreatePopover. The component itself is untouched and still
            renders correctly if mounted; edit mode below is unchanged. */}
        <EventEntryDialog
          mode="edit"
          open={Boolean(eventEntryEvent)}
          event={eventEntryEvent}
          tz={tz}
          onClose={() => setEventEntryId(null)}
        />

        {/* ── D5 Unified Drop Modal (every bucket → board drop) ── */}
        {/* Closed (draft state kept) while the needs-crew warning is up - "Back" reopens it. */}
        <UnifiedDropModal
          open={Boolean(dropModal) && !needsCrewConfirm}
          event={dropModal?.event ?? null}
          draft={dropModal?.draft ?? null}
          conflictNote={dropConflictNote}
          members={orgRoster}
          canAssignOthers={canAssignOthers}
          actorKnownPeople={actorKnownPeople}
          onChange={(patch) =>
            setDropModal((cur) => (cur ? { ...cur, draft: { ...cur.draft, ...patch } } : cur))
          }
          onConfirm={handleDropModalConfirm}
          onCancel={() => {
            setDropModal(null);
            setNeedsCrewConfirm(false);
          }}
        />

        {/* ── Empty-crew warning (D5 confirm gate - §3.8 state 4 is valid but deliberate) ── */}
        {/* RESIDUAL - kept as a plain overlay by the overlay-consolidation pass, for the same
            reason as the Conflict Modal above. This is in fact the ORIGINAL precedent the
            EventEditor comment references: UnifiedDropModal's `open` is gated `!needsCrewConfirm`
            expressly so its Radix dialog never sits open under this warning, and "Back" flips
            `needsCrewConfirm` false and reopens UnifiedDropModal on the very next render - a
            same-tick Radix-dialog swap in both directions. Converting this overlay to
            ConfirmDialog would put a second Radix Dialog's mount/open in the same tick as
            UnifiedDropModal's exit animation, risking the exact focus-lock fight this gating
            exists to avoid. Left on its original markup; see the Conflict Modal comment above
            for the full rationale (shared by this block and D6 unschedule confirm below). */}
        {needsCrewConfirm && dropModal && (
          <div className="fixed inset-0 z-surface-raised bg-scrim/50 backdrop-blur-[3px] flex items-center justify-center p-4">
            <div
              role="alertdialog"
              aria-modal="true"
              aria-label="Schedule with no crew?"
              className="w-full max-w-md bg-kit-card rounded-xl border p-6 shadow-modal"
            >
              <div className="flex items-start gap-3.5 mb-5">
                <span className="grid size-10 shrink-0 place-items-center rounded-[11px] bg-status-red-subtle text-destructive [&_svg]:size-5">
                  <AlertTriangle />
                </span>
                <div>
                  <p className="text-[16.5px] font-bold tracking-tight">Nobody is assigned</p>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
                    <strong>{dropModal.event.number}</strong> will be scheduled with no crew {EM} it saves
                    as <strong>"needs crew"</strong> (red flag, Standard view only). Confirm?
                  </p>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setNeedsCrewConfirm(false)}>
                  Back
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => submitDropDraft(dropModal.event, dropModal.draft)}
                >
                  Schedule anyway
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* ── D6 unschedule confirm (TG10 - board card dragged to the bucket) ── */}
        {/* Distinct from Cancel: no reason, no customer email; the crew is KEPT (state 3). */}
        {/* RESIDUAL - kept as a plain overlay by the overlay-consolidation pass; same rationale
            as the Conflict Modal comment above. `unscheduleConfirm` is set directly from
            EventEditor's `onUnschedule` (an action taken INSIDE the still-open editor) and gates
            EventEditor's own `open` prop (`!unscheduleConfirm`) - Cancel here flips it back to
            null and reopens EventEditor on the next render, a same-tick Radix-dialog swap in both
            directions. Converting to ConfirmDialog risks the same focus-lock fight. Left on its
            original markup. */}
        {unscheduleConfirm && (
          <div className="fixed inset-0 z-surface-raised bg-scrim/50 backdrop-blur-[3px] flex items-center justify-center p-4">
            <div className="w-full max-w-md bg-kit-card rounded-xl border p-6 shadow-modal">
              <div className="flex items-start gap-3.5 mb-5">
                <span className="grid size-10 shrink-0 place-items-center rounded-[11px] bg-brand-subtle text-brand [&_svg]:size-5">
                  <CalendarX2 />
                </span>
                <div>
                  <p className="text-[16.5px] font-bold tracking-tight">Move to Unscheduled?</p>
                  {/* Slice 03: a walkthrough visit whose lead still has another booked visit does
                      not go back to the bucket - only this visit leaves the schedule. */}
                  {leadKeepsAnotherBookedVisit(unscheduleConfirm) ? (
                    <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
                      This visit of <strong>{unscheduleConfirm.number}</strong> is removed from the
                      schedule. The lead keeps its other booked visit.
                    </p>
                  ) : (
                    <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
                      <strong>{unscheduleConfirm.number}</strong> goes back to its bucket. The crew is{' '}
                      <strong>kept</strong>. This is not a cancellation of the job.
                    </p>
                  )}
                </div>
              </div>
              {/* No notify composer here (scheduling-notifications follow-up f3): customer
                  notifications come only from the org's automations, so this confirm asks
                  nothing about the customer and the request carries no notify key. */}
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setUnscheduleConfirm(null)}>
                  Cancel
                </Button>
                <Button
                  onClick={() => {
                    if (boardReadOnly) return; // D9 defense in depth - confirm can't write for read-only roles
                    unscheduleMutation.mutate(unscheduleConfirm);
                    setUnscheduleConfirm(null);
                    setEditorEventId(null); // editor-initiated unschedule is done - don't reopen
                  }}
                >
                  Unschedule
                </Button>
              </div>
            </div>
          </div>
        )}
        </div>
      </div>
      </AllDayOverflowProvider>
    </ScheduleCtx.Provider>
  );
}
