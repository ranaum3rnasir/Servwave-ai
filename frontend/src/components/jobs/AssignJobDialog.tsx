import { useState, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import { extractApiError } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/patterns/FormField';
import { DatePicker } from '@/components/form/DatePicker';
import { MultiAssigneeSelect, type KnownPerson } from '@/components/crm/MultiAssigneeSelect';
import { ScheduleTimeFields } from '@/components/schedule/ScheduleTimeFields';
import { EMPTY_SCHEDULE_TIME, isInvertedRange, type ScheduleTimeValue } from '@/components/schedule/scheduleTimeValue';
import { useScheduleTimezone, dayAndTimeToIso, isoToOrgDay, isoToOrgTime } from '@/lib/schedule-tz';
import { refreshAfterVisitWrite } from '@/lib/refreshAfterVisitWrite';
import { Loader2 } from 'lucide-react';

type AssignJobDialogMode = 'assign' | 'schedule';

interface AssignJobDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobId: string;
  /** 'assign' (crew-focused copy) vs 'schedule' (date/time-focused copy). The dialog body
   *  is identical either way — only the header/submit-button wording changes to match
   *  what the caller actually triggered. Defaults to 'assign'. */
  mode?: AssignJobDialogMode;
  /** Current crew (drives the Assign/Reassign copy and seeds the picker). */
  currentAssigneeIds?: string[] | null;
  /**
   * The same crew as PEOPLE, when the caller's payload carries their names (`job.assignees[].user`).
   *
   * Ids alone are enough to seed the picker but not to LABEL it: the roster the picker fetches is
   * scoped to whoever the viewer may add, so a technician already on the job renders as `Unknown`
   * to a viewer without the `assign User` grant - who is nonetheless entitled to read their own
   * job's crew. Optional because the board's caller opens this dialog on a drop with no crew
   * loaded at all; when it is absent nothing changes.
   */
  currentAssignees?: readonly KnownPerson[];
  /** Whether the job already has a schedule (drives Schedule/Reschedule copy in 'schedule' mode). */
  isScheduled?: boolean;
  defaultStart?: string;    // ISO string — pre-fills scheduled start from calendar drop
  defaultEnd?: string;      // ISO string — pre-fills scheduled end from calendar drop
  defaultTechId?: string;   // pre-selects technician (for grouped-by-tech calendar drop)
  defaultIsAllDay?: boolean;
  /**
   * Whether the defaults above describe where the job ALREADY is, rather than where it is
   * being moved to. The two callers mean opposite things by the same props: the board seeds
   * the slot the user just dropped onto, which is the whole statement even if nothing is then
   * edited, while the job page seeds the job's own window so Reschedule opens on it. Only in
   * the second case is leaving the fields alone a no-op, and saying so is what stops a
   * crew-only assign from re-booking the job. Defaults to false - the board's meaning.
   */
  defaultsAreCurrentSchedule?: boolean;
}

export function AssignJobDialog({ open, onOpenChange, jobId, mode = 'assign', currentAssigneeIds, currentAssignees, isScheduled, defaultStart, defaultEnd, defaultTechId, defaultIsAllDay, defaultsAreCurrentSchedule = false }: AssignJobDialogProps) {
  const queryClient = useQueryClient();
  // The picker values below are zoneless wall clock and mean the ORG's clock. This dialog
  // is reached from BOTH the scheduler board and the job detail page, so before this it was
  // the one place where dragging a card and pressing Assign produced different stored times.
  const timezone = useScheduleTimezone();
  const [techIds, setTechIds] = useState<string[]>([]);
  // The four picker fields ARE the state of record, held exactly as ScheduleTimeFields
  // edits them. Storing a combined 'YYYY-MM-DDTHH:mm' pair instead lost every partial
  // edit — a start date picked before its time collapsed the whole value to '', so the
  // fields never accumulated and Schedule posted crew with no schedule at all.
  const [time, setTime] = useState<ScheduleTimeValue>(EMPTY_SCHEDULE_TIME);
  const [isAllDay, setIsAllDay] = useState(false);
  // What the fields held the moment the dialog opened, so the submit can tell a window the
  // user EDITED from one that was only ever displayed to them. See `scheduleUnchanged`.
  const [seeded, setSeeded] = useState<{ time: ScheduleTimeValue; isAllDay: boolean }>({
    time: EMPTY_SCHEDULE_TIME,
    isAllDay: false,
  });
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);
  const [pendingForce, setPendingForce] = useState<{ techIds: string[]; start: string; end: string } | null>(null);
  const isReassign = Boolean(currentAssigneeIds && currentAssigneeIds.length > 0);

  /** The day after `day` ('YYYY-MM-DD'), as pure calendar arithmetic. Deliberately NOT
   *  `instant + 24h`, which is wrong by an hour on either DST transition. */
  const nextDay = (day: string): string => {
    const [y, m, d] = day.split('-').map(Number);
    return new Date(Date.UTC(y!, m! - 1, d! + 1)).toISOString().slice(0, 10);
  };

  /** The day before `day` ('YYYY-MM-DD'), the inverse of `nextDay`. */
  const prevDay = (day: string): string => {
    const [y, m, d] = day.split('-').map(Number);
    return new Date(Date.UTC(y!, m! - 1, d! - 1)).toISOString().slice(0, 10);
  };

  /**
   * An all-day job spanning `firstDay`..`lastDay` INCLUSIVE, as the user reads the two
   * date fields: picking Aug 17 - Aug 19 means the job runs through the end of Aug 19.
   * Stored the way every other surface stores a window - an EXCLUSIVE end instant - so
   * the API contract is untouched and `isInvertedRange` still guards it: a single-day
   * all-day job is midnight-to-midnight, never a zero-length range.
   */
  const allDayRange = (firstDay: string, lastDay: string): ScheduleTimeValue => ({
    date: firstDay,
    startTime: '00:00',
    endDate: nextDay(lastDay),
    endTime: '00:00',
  });

  /**
   * The last day the current value OCCUPIES, which is what the End date field shows.
   * An end at exactly midnight belongs to the previous day - the same convention rbc
   * itself uses when it decides an event crosses a day boundary (see
   * `occupiesAllDayStrip`), so toggling All Day on a timed job keeps its real span
   * instead of collapsing a four-day job to one.
   */
  const lastDayOf = (v: ScheduleTimeValue): string => {
    if (!v.endDate) return v.date;
    return v.endTime === '00:00' ? prevDay(v.endDate) : v.endDate;
  };

  // The two instants the API speaks, derived from the fields at the seam. `undefined`
  // whenever a half is not fully set, which is what "leave the schedule alone" means to
  // POST /assign.
  const startIso = dayAndTimeToIso(time.date, time.startTime, timezone);
  const endIso = dayAndTimeToIso(time.endDate, time.endTime, timezone);

  // What the All Day "End date" field displays: the inclusive last day, or '' while the
  // form is still empty - never a day derived from an end that was never set.
  const allDayLastDay = time.endDate ? lastDayOf(time) : '';

  /**
   * True when the pickers still hold exactly what they were seeded with. Both instants are
   * then withheld from the POST, because to `assign()` any scheduled_start means "this job
   * is being booked": it forces status to SCHEDULED and runs milestoneClears('scheduled'),
   * nulling en_route_at / on_site_at / started_at / completed_at / cancelled_at. Since this
   * dialog seeds the job's own window so Reschedule can edit it, the crew-focused triggers
   * would otherwise restate that window and quietly un-complete a finished job.
   *
   * Also what keeps a lone seeded start off the wire - assignJobSchema's pairing refine 400s
   * on a start with no end, a state updateJobSchema deliberately allows a PATCH to create.
   */
  const scheduleUnchanged =
    defaultsAreCurrentSchedule &&
    time.date === seeded.time.date &&
    time.startTime === seeded.time.startTime &&
    time.endDate === seeded.time.endDate &&
    time.endTime === seeded.time.endTime &&
    isAllDay === seeded.isAllDay;

  // Reset state when dialog opens, apply defaults. Seed the crew from a calendar
  // drop (defaultTechId) or the job's current crew (currentAssigneeIds).
  useEffect(() => {
    if (open) {
      setTechIds(defaultTechId ? [defaultTechId] : (currentAssigneeIds ?? []));
      const opening: ScheduleTimeValue = {
        date: isoToOrgDay(defaultStart, timezone),
        startTime: isoToOrgTime(defaultStart, timezone),
        endDate: isoToOrgDay(defaultEnd, timezone),
        endTime: isoToOrgTime(defaultEnd, timezone),
      };
      setTime(opening);
      setIsAllDay(defaultIsAllDay ?? false);
      // Snapshot the FIELDS, not the incoming instants: isoToOrgTime formats HH:mm, so a
      // stored start carrying seconds seeds as :00 and would never compare equal to its own
      // ISO. Comparing what the pickers were given to what they now hold is the only test
      // that means "the user did not touch this".
      setSeeded({ time: opening, isAllDay: defaultIsAllDay ?? false });
      setConflictMessage(null);
      setPendingForce(null);
    }
    // currentAssigneeIds intentionally omitted: only seed on open, not on every parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultStart, defaultEnd, defaultTechId, defaultIsAllDay, timezone]);

  const mutation = useMutation({
    mutationFn: async () => {
      const { data } = await api.post(`/api/jobs/${jobId}/assign`, {
        assignee_ids: techIds,
        scheduled_start: scheduleUnchanged ? undefined : startIso,
        scheduled_end: scheduleUnchanged ? undefined : endIso,
        // Sent either way: assign() writes `is_all_day ?? false`, so omitting it on a
        // crew-only assign would clear the flag on an all-day job.
        is_all_day: isAllDay,
      });
      return data;
    },
    onSuccess: () => {
      // /assign writes the VISIT SET through the door (multi-visit S2 - first booking creates
      // Visit 1), so this is a visit write like any other.
      refreshAfterVisitWrite(queryClient, { jobId });
      onOpenChange(false);
    },
    onError: (err: unknown) => {
      const axiosErr = err as { response?: { status?: number; data?: { error?: string } } };
      if (axiosErr.response?.status === 409) {
        const msg = extractApiError(err, 'Scheduling conflict detected.');
        setConflictMessage(msg);
        setPendingForce({ techIds, start: startIso ?? '', end: endIso ?? '' });
      }
    },
  });

  const forceMutation = useMutation({
    mutationFn: async () => {
      if (!pendingForce) return;
      const { data } = await api.post(`/api/jobs/${jobId}/assign`, {
        assignee_ids: pendingForce.techIds,
        scheduled_start: pendingForce.start || undefined,
        scheduled_end: pendingForce.end || undefined,
        force: true,
      });
      return data;
    },
    onSuccess: () => {
      // Same visit-set write as the non-force path above - the force flag only skips the
      // conflict check, not the booking.
      refreshAfterVisitWrite(queryClient, { jobId });
      setConflictMessage(null);
      setPendingForce(null);
      onOpenChange(false);
    },
  });

  const mutationErrorMsg = mutation.error ? extractApiError(mutation.error, 'Failed to assign job') : null;

  const title = mode === 'schedule'
    ? (isScheduled ? 'Reschedule Job' : 'Schedule Job')
    : (isReassign ? 'Reassign Technician' : 'Assign Technician');
  const description = mode === 'schedule'
    ? 'Set the date, time and crew for this job.'
    : (isReassign ? 'Select a different technician for this job.' : 'Select a technician and optionally set schedule.');
  const submitLabel = mode === 'schedule'
    ? (isScheduled ? 'Reschedule' : 'Schedule')
    : (isReassign ? 'Reassign' : 'Assign');
  const submitBusyLabel = mode === 'schedule' ? 'Scheduling...' : 'Assigning...';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <FormField
            label="Crew"
            required={mode !== 'schedule'}
            // A visit can be booked with no crew yet - assignJobSchema accepts
            // assignee_ids: [] (REPLACE semantics), the board's reschedule confirm
            // already renders "Crew (unchanged): No crew", and the notify email falls
            // back to "Our team" (PR #1694). Only 'assign' mode still requires a pick;
            // see the submit gate below for why.
            hint={mode === 'schedule' ? 'Optional - assign later if you like.' : undefined}
          >
            <MultiAssigneeSelect
              value={techIds}
              onChange={setTechIds}
              purpose="jobCrew"
              placeholder="Add member..."
              enabled={open}
              knownPeople={currentAssignees}
            />
          </FormField>

          <div className="flex items-center gap-2 py-1">
            {/* Not converted to FormField: a checkbox row (label sits beside the control, not
                above it) - out of FormField's label-above-a-single-control shape. */}
            <input
              type="checkbox"
              id="all-day-toggle"
              checked={isAllDay}
              onChange={(e) => {
                setIsAllDay(e.target.checked);
                if (e.target.checked && time.date) setTime(allDayRange(time.date, lastDayOf(time)));
              }}
              className="rounded border-border"
            />
            <label htmlFor="all-day-toggle" className="text-sm text-text-primary cursor-pointer">All Day</label>
          </div>

          {isAllDay ? (
            /* Two dates, not one. An all-day job routinely runs several days (a multi-day
               install), and a single Date field made that unsayable - the end silently
               became the next morning however long the work actually was. Both fields read
               INCLUSIVE; `allDayRange` converts to the stored exclusive end. */
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Start date">
                <DatePicker
                  value={time.date}
                  onChange={(dateStr) => {
                    if (!dateStr) return;
                    // Dragging the start past the end takes the end with it, rather than
                    // leaving a backwards range the user has to notice and repair.
                    const last = lastDayOf(time);
                    setTime(allDayRange(dateStr, last && last >= dateStr ? last : dateStr));
                  }}
                />
              </FormField>
              <FormField
                label="End date"
                error={isInvertedRange(time) ? 'Ends before it starts' : undefined}
              >
                <DatePicker
                  value={allDayLastDay}
                  onChange={(dateStr) => { if (dateStr) setTime(allDayRange(time.date || dateStr, dateStr)); }}
                />
              </FormField>
            </div>
          ) : (
            <ScheduleTimeFields value={time} onChange={setTime} />
          )}

          {conflictMessage && (
            <div className="rounded-md border border-warning-border bg-warning-surface p-3 text-sm text-warning-text">
              <p className="font-medium mb-1">⚠ Scheduling Conflict</p>
              <p>{conflictMessage}</p>
              <div className="flex gap-2 mt-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => { setConflictMessage(null); setPendingForce(null); }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={() => forceMutation.mutate()}
                  disabled={forceMutation.isPending}
                >
                  {forceMutation.isPending ? 'Scheduling...' : 'Schedule Anyway'}
                </Button>
              </div>
            </div>
          )}

          {mutationErrorMsg && (
            <p className="text-sm text-danger">{mutationErrorMsg}</p>
          )}

          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => mutation.mutate()}
              disabled={
                // Crew is required only in 'assign' mode - that dialog exists to NAME a
                // crew, and assign()'s REPLACE semantics mean an empty submit there would
                // silently clear whoever is already on the job. 'schedule' mode has no
                // such gate: a visit without a crew yet is a designed state (see the
                // Crew FormField's hint above), so submitting posts assignee_ids: [].
                (mode !== 'schedule' && techIds.length === 0) ||
                mutation.isPending ||
                Boolean(conflictMessage) ||
                // The fields say why; posting a backwards range is never what was meant.
                isInvertedRange(time)
              }
            >
              {mutation.isPending ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> {submitBusyLabel}</>
              ) : (
                submitLabel
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
