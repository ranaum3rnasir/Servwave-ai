import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import { CheckCircle2, X, AlertTriangle, Search } from 'lucide-react';

import api from '@/lib/axios';
import { refreshAfterVisitWrite } from '@/lib/refreshAfterVisitWrite';
import { extractApiError } from '@/lib/utils';
import { toast } from '@/ui-kit/components/ui/sonner';
import { Button } from '@/ui-kit/components/ui/button';
import { Checkbox } from '@/ui-kit/components/ui/checkbox';
import { Textarea } from '@/ui-kit/components/ui/textarea';
import { Popover, PopoverAnchor, PopoverContent } from '@/ui-kit/components/ui/popover';
import { Sheet, SheetContent } from '@/ui-kit/components/ui/sheet';
import { MultiAssigneeSelect } from '@/components/crm/MultiAssigneeSelect';

import {
  asWallClock, nowWallClock, wallClockToIso, addMsToWallClock, type WallClock,
} from '@/lib/schedule-tz';
import {
  allDayRange, durationMinutesOf, isInvertedRange, lastDayOf, scheduleTimeFrom, startDateOf,
  type ScheduleTimeValue,
} from '@/components/schedule/scheduleTimeValue';

import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

import { ScheduleTimeFields } from '../../_shared/scheduleTimeFields';
import { ScheduleConfirmDialog } from '../components/confirmDialog';
import { ParticipantsField, type ParticipantDraft } from '../components/participantsField';
import { invalidateCalendarEntryQueries, participantsPayload } from './calendarEntryWrite';
import { isInsideBoundary, useDismissOnViewportChange } from './dismissBoundary';
import { customerDisplayName, jobAddress, walkthroughAddress } from './entityAddress';
import { EntityRow } from './entityRow';

/**
 * THE creation surface for the scheduler.
 *
 * Replaces the old two-step flow (`QuickScheduleCard` -> `AssignJobDialog` / `EventEntryDialog`)
 * with one popover carrying all three types as tabs. Both entry points - the toolbar's icon
 * button and a click on an empty grid slot - render THIS component; there is no second window
 * behind any tab, which is the whole point of the change.
 *
 * Shaped after Google Calendar's create-event window, with two deliberate departures: the
 * header always reads "Schedule" (the tab already says what KIND of thing is being made, so
 * a title that changed with it would restate the tab and leave the window unnamed), and the
 * job/walkthrough search is a FIELD in the form rather than a hero above it.
 *
 * What is carried over: pill tabs, no separator rules, and a quiet stack of rows rather than
 * a dense form. The first row on every tab is "what is being scheduled", so all three open on
 * the same question. Rows carry a short caption where the control cannot name itself; the
 * icon gutter an earlier pass used was dropped because six glyphs down the left edge read as
 * decoration competing with the controls they were meant to label.
 *
 * Nothing in the body may change the popover's size while the user works - see `EntitySearchField`.
 */

/** One flat hour, matching the old event dialog's floor for a type with no org default. */
const DEFAULT_EVENT_DURATION_MIN = 60;
const POPOVER_WIDTH = 440;
const MOBILE_BREAKPOINT = 640;

export type CreationTab = 'job' | 'walkthrough' | 'event';

/** Where the popover points. Both entry points reduce to a viewport point, so there is one
 *  positioning path rather than a trigger path and a slot path that can drift apart. */
export interface CreationAnchorPoint {
  x: number;
  y: number;
}

export interface ScheduleCreatePopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchor: CreationAnchorPoint | null;
  /** The ORG's scheduling zone - never the browser's (MV-TZ-02). */
  tz: string;
  /** Pre-fills start/end when the user opened this by clicking a slot. */
  seed?: { start: WallClock; end: WallClock; isAllDay?: boolean } | null;
  unassignedJobs: Record<string, unknown>[];
  unscheduledWalkthroughs: Record<string, unknown>[];
  /** False without the `leads` entitlement - the tab is not offered rather than shown empty. */
  showWalkthroughs?: boolean;
  /** Gates the Event tab on the CalendarEntry create grant, as the old toolbar button was. */
  canCreateEvent?: boolean;
  /** Org default walkthrough length, for the walkthrough door's duration. */
  defaultWalkthroughDurationMin?: number;
  onCreated?: () => void;
}

function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < MOBILE_BREAKPOINT,
  );
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return isMobile;
}

export function ScheduleCreatePopover(props: ScheduleCreatePopoverProps) {
  const { open, onOpenChange, anchor } = props;
  const isMobile = useIsMobile();
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [dirty, setDirty] = useState(false);
  const location = useLocation();

  /**
   * The last real anchor point, held through the exit animation. See the anchor below.
   *
   * State adjusted during render rather than a ref: the value is READ while rendering, so a
   * ref would be exactly the render-time access `react-hooks/refs` warns about. Copying it in
   * an effect instead would be worse - the first frame after opening would paint at the
   * previous anchor and then jump. This is the documented "adjust state when props change"
   * pattern (https://react.dev/learn/you-might-not-need-an-effect), the same one
   * `_shared/datePicker.tsx` uses to track its own previous value.
   */
  const [lastAnchor, setLastAnchor] = useState<CreationAnchorPoint>(anchor ?? { x: 0, y: 0 });
  if (anchor && (anchor.x !== lastAnchor.x || anchor.y !== lastAnchor.y)) {
    setLastAnchor(anchor);
  }

  /** Every USER dismissal funnels through here, so the dirty guard cannot be bypassed by
   *  whichever one they happened to use. */
  const requestClose = useCallback(() => {
    if (dirty) { setConfirmDiscard(true); return; }
    onOpenChange(false);
  }, [dirty, onOpenChange]);

  /**
   * Closing because the work is DONE, which is not a dismissal and must never prompt.
   *
   * Separate from `requestClose` rather than "clear dirty, then request close": clearing is
   * a state update, so the `requestClose` the body is holding still closes over `dirty ===
   * true` in that same tick. A successful save went down the discard branch and asked whether
   * to throw away the thing it had just created.
   */
  const closeAfterSave = useCallback(() => {
    setDirty(false);
    setConfirmDiscard(false);
    onOpenChange(false);
  }, [onOpenChange]);

  // Scroll and resize (Radix covers click-outside and Esc).
  useDismissOnViewportChange(open, requestClose);

  // Route navigation. A discard prompt would be pointless here - the page it belongs to is
  // already gone - so this closes outright rather than going through `requestClose`.
  const firstLocation = useRef(location.key);
  useEffect(() => {
    if (location.key === firstLocation.current) return;
    setDirty(false);
    onOpenChange(false);
  }, [location.key, onOpenChange]);

  // Remounted per open (`key`), which is what forces the Job tab back as the default and
  // clears every draft - the spec asks for no last-used-tab memory.
  const body = (
    <CreationBody
      key={open ? 'open' : 'closed'}
      {...props}
      onDirtyChange={setDirty}
      onRequestClose={requestClose}
      onCloseAfterSave={closeAfterSave}
    />
  );

  return (
    <>
      {isMobile ? (
        <Sheet open={open} onOpenChange={(o) => { if (!o) requestClose(); }}>
          {/* Same recede as the desktop popover - see the note on PopoverContent below. */}
          <SheetContent
            side="bottom"
            className={`flex max-h-[85vh] flex-col p-0 transition-opacity duration-200 ${
              confirmDiscard ? 'pointer-events-none opacity-40' : ''
            }`}
          >
            {body}
          </SheetContent>
        </Sheet>
      ) : (
        <Popover open={open} onOpenChange={(o) => { if (!o) requestClose(); }}>
          {/* A zero-size anchor pinned to the viewport point. Both entry points supply one,
              so the toolbar button and a grid slot position through identical code. */}
          <PopoverAnchor asChild>
            <span
              aria-hidden="true"
              style={{
                position: 'fixed',
                // `lastAnchor`, not `anchor`. The parent clears the anchor in the same
                // commit that closes the popover, so reading `anchor` directly sent the
                // still-animating panel to 0,0 - it flew to the top-left corner on its way
                // out. Holding the last real point keeps the exit where the entrance was.
                left: lastAnchor.x,
                top: lastAnchor.y,
                width: 0,
                height: 0,
              }}
            />
          </PopoverAnchor>
          <PopoverContent
            align="start"
            side="bottom"
            sideOffset={6}
            collisionPadding={12}
            avoidCollisions
            /**
             * `overflow-hidden` overrides the kit default, which scrolls the WHOLE panel.
             * Here the header and tabs stay pinned and only the field area scrolls, so the
             * tabs remain reachable in a short viewport. The height cap is Radix's own
             * measurement of the space left on the chosen side, which is what makes the
             * flip-and-shift land fully on screen instead of merely flipping.
             */
            /**
             * While the discard prompt is up the form recedes: dimmed and inert, so the
             * question is the only live thing on screen.
             *
             * Done here rather than by letting the dialog's scrim cover it. Radix copies the
             * popper content's computed z-index onto its wrapper once at MOUNT, so the
             * popover cannot be lowered under the scrim after the fact - and it must stay
             * MOUNTED, because Radix unmounts closed content and that would destroy the very
             * draft the prompt is asking about.
             */
            className={`flex flex-col p-0 overflow-hidden transition-opacity duration-200 ${
              confirmDiscard ? 'pointer-events-none opacity-40' : ''
            }`}
            style={{
              width: POPOVER_WIDTH,
              maxWidth: 'calc(100vw - 24px)',
              maxHeight: 'var(--radix-popover-content-available-height)',
            }}
            onInteractOutside={(e) => { if (isInsideBoundary(e.target)) e.preventDefault(); }}
            onFocusOutside={(e) => { if (isInsideBoundary(e.target)) e.preventDefault(); }}
          >
            {body}
          </PopoverContent>
        </Popover>
      )}

      <ScheduleConfirmDialog
        open={confirmDiscard}
        icon={<AlertTriangle />}
        onOpenChange={setConfirmDiscard}
        title="Discard this draft?"
        description="You have unsaved changes. Closing will lose them."
        confirmLabel="Discard"
        /**
         * Above the popover, not below it. The popover must stay MOUNTED while this asks -
         * Radix unmounts closed content, so closing it would destroy the very draft the
         * prompt exists to protect and "Cancel" would return the user to nothing. Lowering
         * the popover instead does not work: Radix copies the content's computed z-index
         * onto its popper wrapper once at MOUNT, so a later class change never reaches the
         * wrapper that actually stacks it.
         */
        contentClassName="z-[130]"
        onConfirm={() => { setConfirmDiscard(false); setDirty(false); onOpenChange(false); }}
      />
    </>
  );
}

function CreationBody({
  tz, seed, unassignedJobs, unscheduledWalkthroughs, showWalkthroughs = true,
  canCreateEvent = true, defaultWalkthroughDurationMin = 60, onCreated, onDirtyChange,
  onRequestClose, onCloseAfterSave,
}: ScheduleCreatePopoverProps & {
  onDirtyChange: (dirty: boolean) => void;
  /** A USER dismissal: honours the dirty guard, so it may prompt instead of closing. */
  onRequestClose: () => void;
  /** The work is done: closes outright. Never prompts - there is nothing left to discard. */
  onCloseAfterSave: () => void;
}) {
  const queryClient = useQueryClient();

  // `Job` every time - never the last-used tab.
  const [tab, setTab] = useState<CreationTab>('job');

  // ── Shared across tabs (spec: date/time/address persist when switching) ──
  const [time, setTime] = useState<ScheduleTimeValue>(() => (
    seed?.start
      ? scheduleTimeFrom(seed.start, Math.max(
          1,
          Math.round(((seed.end?.getTime() ?? 0) - seed.start.getTime()) / 60_000),
        ) || DEFAULT_EVENT_DURATION_MIN)
      : scheduleTimeFrom(nowWallClock(tz), DEFAULT_EVENT_DURATION_MIN)
  ));
  const [isAllDay, setIsAllDay] = useState(seed?.isAllDay ?? false);
  const [preToggleTime, setPreToggleTime] = useState<ScheduleTimeValue | null>(null);

  // ── Per-tab state (kept separate, so switching tabs does not leak type-specific fields) ──
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobCrew, setJobCrew] = useState<string[]>([]);
  const [leadId, setLeadId] = useState<string | null>(null);
  const [walkthroughCrew, setWalkthroughCrew] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [participants, setParticipants] = useState<ParticipantDraft[]>([]);
  const [query, setQuery] = useState('');

  const markDirty = () => onDirtyChange(true);

  function handleAllDayToggle(checked: boolean) {
    markDirty();
    setIsAllDay(checked);
    if (checked) {
      setPreToggleTime(time);
      if (time.date) setTime(allDayRange(time.date, lastDayOf(time)));
    } else if (preToggleTime) {
      setTime(preToggleTime);
      setPreToggleTime(null);
    }
  }

  const draftStart = startDateOf(time);
  const draftDuration = durationMinutesOf(time);
  const inverted = isInvertedRange(time);
  const timeReady = draftStart !== null && draftDuration !== null && !inverted;

  const q = query.trim().toLowerCase();
  const matches = (entity: Record<string, unknown>, numberKey: string) => {
    if (!q) return true;
    const num = ((entity[numberKey] as string | undefined) ?? '').toLowerCase();
    return num.includes(q) || customerDisplayName(entity).toLowerCase().includes(q);
  };
  const filteredJobs = useMemo(
    () => unassignedJobs.filter((j) => matches(j, 'job_number')),
    [unassignedJobs, q],
  );
  const filteredWalkthroughs = useMemo(
    () => unscheduledWalkthroughs.filter((w) => matches(w, 'lead_number')),
    [unscheduledWalkthroughs, q],
  );

  const selectedJob = unassignedJobs.find((j) => j.id === jobId) ?? null;
  const selectedLead = unscheduledWalkthroughs.find((w) => w.id === leadId) ?? null;

  const finish = (message: string) => {
    toast(message);
    onCreated?.();
    // NOT `onRequestClose` - a save is not a dismissal. Going through the dirty guard here
    // both created the thing and then asked whether to discard it.
    onCloseAfterSave();
  };

  // ── The three doors. Same endpoints and payload shapes the old windows used. ──
  const jobMutation = useMutation({
    mutationFn: async () => {
      const start = draftStart as Date;
      const end = addMsToWallClock(asWallClock(start), (draftDuration as number) * 60_000);
      const { data } = await api.post(`/api/jobs/${jobId}/assign`, {
        assignee_ids: jobCrew,
        scheduled_start: wallClockToIso(start, tz),
        scheduled_end: wallClockToIso(end, tz),
        is_all_day: isAllDay,
      });
      return data;
    },
    onSuccess: () => {
      if (jobId) refreshAfterVisitWrite(queryClient, { jobId });
      finish('Job scheduled');
    },
    onError: (err) => toast.error('Could not schedule job', {
      description: extractApiError(err, 'Please try again.'),
    }),
  });

  const walkthroughMutation = useMutation({
    mutationFn: async () => {
      const start = draftStart as Date;
      const { data } = await api.post(`/api/leads/${leadId}/walkthrough/schedule`, {
        walkthrough_scheduled_at: wallClockToIso(start, tz),
        performer_ids: walkthroughCrew,
        walkthrough_duration_minutes: draftDuration ?? defaultWalkthroughDurationMin,
        force: false,
      });
      return data;
    },
    onSuccess: () => {
      if (leadId) refreshAfterVisitWrite(queryClient, { leadId });
      finish('Walkthrough scheduled');
    },
    onError: (err) => toast.error('Could not schedule walkthrough', {
      description: extractApiError(err, 'Please try again.'),
    }),
  });

  const eventMutation = useMutation({
    mutationFn: async () => {
      const start = draftStart as Date;
      const end = addMsToWallClock(asWallClock(start), (draftDuration as number) * 60_000);
      const { data } = await api.post('/api/calendar-entries', {
        title: title.trim(),
        description: description.trim() || undefined,
        start: wallClockToIso(start, tz),
        end: wallClockToIso(end, tz),
        is_all_day: isAllDay,
        participants: participantsPayload(participants),
      });
      return data;
    },
    onSuccess: () => {
      invalidateCalendarEntryQueries(queryClient);
      finish('Event created');
    },
    onError: (err) => toast.error('Could not create event', {
      description: extractApiError(err, 'Please try again.'),
    }),
  });

  const isSaving = jobMutation.isPending || walkthroughMutation.isPending || eventMutation.isPending;
  const canSave =
    tab === 'job' ? Boolean(jobId) && timeReady
      : tab === 'walkthrough' ? Boolean(leadId) && timeReady
        : title.trim() !== '' && timeReady;

  const submit = () => {
    if (!canSave || isSaving) return;
    if (tab === 'job') jobMutation.mutate();
    else if (tab === 'walkthrough') walkthroughMutation.mutate();
    else eventMutation.mutate();
  };

  const tabs: { key: CreationTab; label: string; shown: boolean }[] = [
    { key: 'job', label: 'Job', shown: true },
    { key: 'walkthrough', label: 'Walkthrough', shown: showWalkthroughs },
    { key: 'event', label: 'Event', shown: canCreateEvent },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-schedule-create-popover="">
      {/* ── Header. The window is always "Schedule", whichever tab is showing: the tab
             says what KIND of thing is being scheduled, so letting the title change with
             it would restate the tab and leave the window itself unnamed. ── */}
      <div className="flex shrink-0 items-center justify-between gap-2 px-4 pt-3 pb-1">
        <h2 className="text-[15px] font-semibold leading-none text-text-primary">Schedule</h2>
        <Button variant="ghost" size="icon-sm" className="size-7 -mr-1" aria-label="Close" onClick={onRequestClose}>
          <X />
        </Button>
      </div>

      {/* ── Tabs, under the header, as pills rather than a full-width underlined rail.
             Still the kit's own Tabs - `pill` is the variant PriceBookPicker already
             uses - so this stays inside the system while matching the reference. ── */}
      <Tabs
        value={tab}
        onValueChange={(v) => { setTab(v as CreationTab); setQuery(''); }}
        className="shrink-0"
      >
        <TabsList variant="pill" className="gap-1 bg-transparent px-4 py-1">
          {tabs.filter((t) => t.shown).map((t) => (
            <TabsTrigger
              key={t.key}
              value={t.key}
              variant="pill"
              className="rounded-full px-3 py-1.5 text-[13px] transition-all duration-500 ease-out"
            >
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {/* ── Fields.
             `key={tab}` remounts this whole stack on every switch, which is what replays
             the enter animation - without it React reconciles the rows in place and the
             change is instant. 500ms and a small slide, deliberately slower than the kit's
             usual 150ms: the point is that the switch is legible, not that it is quick. ── */}
      <div
        key={tab}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-2 pt-2
                   animate-in fade-in-0 slide-in-from-right-3 duration-500 ease-out"
      >
        {/* Title and description are ONE block: they are both "what is this event", and
            splitting them around the time and participant rows put two halves of the same
            thought at opposite ends of the form. */}
        {tab === 'event' && (
          <FormRow>
            <input
              value={title}
              onChange={(e) => { markDirty(); setTitle(e.target.value); }}
              placeholder="Add title"
              aria-label="Title"
              className="w-full rounded-md border border-input bg-transparent px-2.5 py-1.5
                         text-[14px] font-medium leading-tight text-text-primary outline-none
                         transition-colors placeholder:font-normal placeholder:text-subtle-foreground
                         focus:border-primary"
            />
            <Textarea
              rows={2}
              value={description}
              placeholder="Add description"
              aria-label="Description"
              onChange={(e) => { markDirty(); setDescription(e.target.value); }}
              className="mt-1.5 min-h-0 resize-none text-[13px]"
            />
          </FormRow>
        )}

        {tab !== 'event' && (
          <FormRow>
            <EntitySearchField
              query={query}
              onQueryChange={setQuery}
              placeholder={tab === 'job' ? 'Search jobs...' : 'Search walkthroughs...'}
              emptyLabel={tab === 'job' ? 'No unscheduled jobs' : 'No walkthroughs to schedule'}
              selectedLabel={tab === 'job'
                ? (selectedJob
                  ? `${(selectedJob.job_number as string | undefined) ?? ''} ${customerDisplayName(selectedJob)}`.trim()
                  : null)
                : (selectedLead
                  ? `${(selectedLead.lead_number as string | undefined) ?? ''} ${customerDisplayName(selectedLead)}`.trim()
                  : null)}
              onClearSelection={() => (tab === 'job' ? setJobId(null) : setLeadId(null))}
              items={tab === 'job' ? filteredJobs : filteredWalkthroughs}
              renderRow={(item, pick) => (tab === 'job'
                ? (
                  <EntityRow
                    key={item.id as string}
                    id={item.job_number as string | undefined}
                    name={customerDisplayName(item)}
                    address={jobAddress(item)}
                    tone="job"
                    onSelect={() => { markDirty(); setJobId(item.id as string); pick(); }}
                  />
                ) : (
                  <EntityRow
                    key={item.id as string}
                    id={item.lead_number as string | undefined}
                    name={customerDisplayName(item)}
                    address={walkthroughAddress(item)}
                    tone="walkthrough"
                    onSelect={() => { markDirty(); setLeadId(item.id as string); pick(); }}
                  />
                ))}
            />
          </FormRow>
        )}

        <FormRow label="When">
          <div className="space-y-2">
            <ScheduleTimeFields
              value={time}
              onChange={(v) => { markDirty(); setTime(v); }}
              idPrefix="schedule-create"
              allDay={isAllDay}
              // One "When" caption over the block instead of four captions inside it. The
              // labels stay in the a11y tree, visually hidden, so each field keeps its own
              // accessible name and its htmlFor pairing.
              hideLabels
            />
            {/* Only the box toggles - wrapping the row in a <label> made the whole
                width a hit target, so a click aimed at the empty space beside the text
                silently flipped the event to all-day. */}
            <div className="flex items-center gap-2">
              <Checkbox
                id="schedule-create-all-day"
                checked={isAllDay}
                onCheckedChange={(next) => handleAllDayToggle(next === true)}
                aria-label="All Day"
              />
              <span className="select-none text-[13px] text-muted-foreground">All day</span>
            </div>
          </div>
        </FormRow>

        {tab === 'job' && (
          <FormRow label="Crew">
            <MultiAssigneeSelect
              id="schedule-create-job-crew"
              value={jobCrew}
              onChange={(v) => { markDirty(); setJobCrew(v); }}
              purpose="jobCrew"
              enabled
            />
          </FormRow>
        )}
        {tab === 'walkthrough' && (
          <FormRow label="Crew">
            <MultiAssigneeSelect
              id="schedule-create-wt-crew"
              value={walkthroughCrew}
              onChange={(v) => { markDirty(); setWalkthroughCrew(v); }}
              purpose="walkthroughPerformer"
              enabled
            />
          </FormRow>
        )}
        {tab === 'event' && (
          <FormRow label="Participants">
            <ParticipantsField
              value={participants}
              onChange={(v) => { markDirty(); setParticipants(v); }}
            />
          </FormRow>
        )}
      </div>

      {/* ── Footer: a text action beside a filled one, right-aligned, no rule above. ── */}
      <div className="flex shrink-0 items-center justify-end gap-1 px-4 pb-3 pt-1">
        <Button variant="ghost" size="sm" className="h-8 rounded-full px-4" onClick={onRequestClose}>
          Cancel
        </Button>
        <Button size="sm" className="h-8 rounded-full px-5" disabled={!canSave} isLoading={isSaving} onClick={submit}>
          Create
        </Button>
      </div>
    </div>
  );
}

/**
 * One row of the form: an optional quiet caption over its control.
 *
 * The icon gutter this replaced looked decorative rather than informative - six different
 * glyphs down the left edge competing with the controls they were labelling. A short caption
 * says the same thing in the reader's own language and costs no visual weight. Rows whose
 * control already names itself (a search field with a placeholder) pass no label at all.
 */
function FormRow({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <div>
      {label && <p className="mb-1 text-[12px] font-medium text-muted-foreground">{label}</p>}
      {children}
    </div>
  );
}

/**
 * The Job / Walkthrough search field.
 *
 * Results are a FLOATING layer, not an inline block. Inline, the list was permanently in the
 * layout: it made the popover tall before the user had asked for anything, and every keystroke
 * resized the panel as the match count changed, so the fields below it walked up and down the
 * screen while being read.
 *
 * It is a Radix popover rather than an absolutely-positioned div because the field area
 * scrolls (`overflow-y-auto`), and an absolute child of a scroll container is clipped by it -
 * the last rows would be cut off exactly when the form is at its longest. Radix portals the
 * list out and clamps it to the viewport, and `dismissBoundary` already counts a Radix popper
 * as inside, so clicking a result cannot dismiss the form.
 */
function EntitySearchField({
  query, onQueryChange, placeholder, emptyLabel, items, renderRow, selectedLabel, onClearSelection,
}: {
  query: string;
  onQueryChange: (v: string) => void;
  placeholder: string;
  emptyLabel: string;
  items: Record<string, unknown>[];
  /** `pick` closes the results layer once a row is chosen. */
  renderRow: (item: Record<string, unknown>, pick: () => void) => React.ReactNode;
  selectedLabel: string | null;
  onClearSelection: () => void;
}) {
  // Open only while there is something typed AND the field has focus. Clearing the text,
  // blurring, or picking a row all close it - the three ways the spec says it must go away.
  const [focused, setFocused] = useState(false);
  const showResults = focused && query.trim() !== '';

  // Chosen: the field becomes a filled row stating the pick, with one way back. Boxed like
  // the search it replaces, so the control does not appear to change shape underfoot.
  if (selectedLabel !== null) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border border-input bg-muted/50 py-1.5 pl-2.5 pr-1">
        <span className="truncate text-[13px] font-medium text-text-primary">{selectedLabel}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-6 shrink-0"
          aria-label="Change selection"
          onClick={onClearSelection}
        >
          <X />
        </Button>
      </div>
    );
  }

  return (
    <Popover open={showResults}>
      <PopoverAnchor asChild>
        {/* Reads as a search box, not as a title field: a bordered input with a magnifier
            and a "Search ..." placeholder. Before this it was a borderless line that looked
            like somewhere to TYPE a new job's name rather than to find an existing one. */}
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle-foreground"
          />
          <input
            type="search"
            value={query}
            aria-label={placeholder}
            placeholder={placeholder}
            className="w-full rounded-md border border-input bg-transparent py-1.5 pl-8 pr-2.5
                       text-[13px] leading-tight text-text-primary outline-none transition-colors
                       placeholder:text-subtle-foreground focus:border-primary
                       [&::-webkit-search-cancel-button]:appearance-none"
            onChange={(e) => onQueryChange(e.target.value)}
            onFocus={() => setFocused(true)}
            // Deferred: a mousedown on a result blurs the input before the click lands, so
            // closing synchronously would unmount the row out from under the pointer.
            onBlur={() => window.setTimeout(() => setFocused(false), 120)}
          />
        </div>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        sideOffset={4}
        // Focus stays in the field: this is a live filter, not a menu to arrow into.
        onOpenAutoFocus={(e) => e.preventDefault()}
        className="max-h-[220px] w-[var(--radix-popover-trigger-width)] overflow-y-auto p-1"
      >
        {items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-1 py-4 text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 text-status-green" />
            <p className="text-[12px]">{emptyLabel}</p>
          </div>
        ) : (
          <ul className="space-y-0.5">{items.map((item) => renderRow(item, () => setFocused(false)))}</ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
