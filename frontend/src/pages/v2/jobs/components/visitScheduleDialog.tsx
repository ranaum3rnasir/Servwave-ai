/**
 * Multi-visit S2: book a new visit on a job, or move an existing one.
 *
 * Deliberately NOT AssignJobDialog. That one POSTs /assign, which fires the customer
 * scheduled/rescheduled email, applies milestoneClears and syncs PlanVisit - none of which belongs
 * on a visit write in S2.
 *
 * The four-field ScheduleTimeValue is the state of record and is seeded WHOLE from the visit's ISO
 * start and end. Never derive the fields back out of a narrower combined string: that is the exact
 * bug #1535 was spent undoing, where every half-filled edit collapsed to '' and the state never
 * accumulated. Conversion happens only at the API seam, through the ORG zone.
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import api from '@/lib/axios';
import { extractApiError } from '@/lib/utils';
import { dayAndTimeToIso, isoToOrgDay, isoToOrgTime, useScheduleTimezone } from '@/lib/schedule-tz';
import { refreshAfterVisitWrite } from '@/lib/refreshAfterVisitWrite';
import {
  allDayRange, EMPTY_SCHEDULE_TIME, isInvertedRange, lastDayOf, type ScheduleTimeValue,
} from '@/components/schedule/scheduleTimeValue';
import type { JobVisitRow } from '@/lib/visits';
import { MultiAssigneeSelect } from '@/components/crm/MultiAssigneeSelect';
import {
  VisitLocationField, isVisitLocationComplete, seedVisitLocation, visitLocationPayload,
  type VisitLocationValue,
} from '@/pages/v2/_shared/visitLocationField';

import { Button } from '@/ui-kit/components/ui/button';
import { Checkbox } from '@/ui-kit/components/ui/checkbox';
import { Label } from '@/ui-kit/components/ui/label';
import {
  Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/ui-kit/components/ui/dialog';
import { toast } from '@/ui-kit/components/ui/sonner';

// The v2 chrome. A v2 page may not import the v1 twin (components/schedule/ScheduleTimeFields);
// the two share their brain (scheduleTimeValue) and not their body.
import { ScheduleTimeFields } from '@/pages/v2/_shared/scheduleTimeFields';

export interface VisitScheduleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobId: string;
  /** Present when moving an existing trip; absent when booking a new one. */
  visit?: JobVisitRow | null;
  /**
   * S3: naming crew is an `assign Job` fact, and BOTH visit routes now enforce it per instance on
   * top of the subject-level `reschedule Job` route gate. False hides the picker ONLY - never the
   * dialog and never Save, or plain drag-to-reschedule breaks for exactly the reschedule-only
   * grantees that route gate was written to keep working. Frontend gates on the same ability the
   * API enforces, per CLAUDE.md's Roles rule.
   */
  canAssignCrew?: boolean;
}

/** Whether the four fields still hold exactly what they were last seeded with. */
function sameScheduleTime(a: ScheduleTimeValue, b: ScheduleTimeValue): boolean {
  return a.date === b.date && a.startTime === b.startTime
    && a.endDate === b.endDate && a.endTime === b.endTime;
}

/** Seed the WHOLE four-field value in one go, from the row's own instants. */
function seedFrom(visit: JobVisitRow | null | undefined, tz: string): ScheduleTimeValue {
  if (!visit?.scheduled_at) return EMPTY_SCHEDULE_TIME;
  return {
    date: isoToOrgDay(visit.scheduled_at, tz),
    startTime: isoToOrgTime(visit.scheduled_at, tz),
    endDate: isoToOrgDay(visit.scheduled_end ?? visit.scheduled_at, tz),
    endTime: isoToOrgTime(visit.scheduled_end ?? visit.scheduled_at, tz),
  };
}

export function VisitScheduleDialog({
  open, onOpenChange, jobId, visit, canAssignCrew = true,
}: VisitScheduleDialogProps) {
  const tz = useScheduleTimezone();
  const queryClient = useQueryClient();
  // Seeded ONCE, at mount. The caller remounts this component whenever it opens (see the `key`
  // on both call sites), so Reschedule always opens holding the slot it is about to move rather
  // than whatever was last edited - without a setState-inside-an-effect re-seed.
  const [value, setValue] = useState<ScheduleTimeValue>(() => seedFrom(visit, tz));
  // ...with ONE exception, and it is not a remount: `useScheduleTimezone()` answers the Eastern
  // default until GET /api/organization lands, and the org query can land after this dialog has
  // mounted. The same wall clock read against a different zone is a different instant, so a seed
  // taken on the guess is written back through the REAL zone on save - a Denver org silently
  // moving a visit two hours on a save that never touched these fields. Re-seed when the zone
  // itself changes, exactly as `pages/v2/leads/components/walkthroughTab.tsx` already does.
  //
  // Held as the seed rather than as a bare zone string so an edit made INSIDE the loading window
  // survives: a wall clock the dispatcher typed is their intent on the company clock, whatever
  // the app briefly believed that clock to be, and re-deriving it from the row would throw their
  // input away. Only fields still holding the seed are re-derived.
  //
  // Adjusted during render rather than in an effect: React's documented way to reset state on a
  // changed input, and what `react-hooks/set-state-in-effect` (enforced on changed lines in CI)
  // requires. `tz` is compared as a primitive - comparing seeds would loop for ever, since
  // `seedFrom` returns a new object every call.
  const [seed, setSeed] = useState<{ tz: string; value: ScheduleTimeValue }>(() => ({ tz, value }));
  if (tz !== seed.tz) {
    const next = seedFrom(visit, tz);
    setSeed({ tz, value: next });
    if (sameScheduleTime(value, seed.value)) setValue(next);
  }
  // Same seed-once-at-mount rule as the window above, for the same reason: the caller remounts
  // this component whenever it opens, so Reschedule opens holding the crew already on that trip
  // rather than an empty picker the dispatcher has to refill.
  const [crew, setCrew] = useState<string[]>(() => (visit?.assignees ?? []).map((a) => a.user_id));
  // Same seed-once-at-mount rule again: Reschedule on an all-day visit opens with the box already
  // ticked and `value`'s exclusive end already round-trips through ScheduleTimeFields' `allDay`
  // mode (lastDayOf), so no separate inclusive-date state is needed here.
  const [isAllDay, setIsAllDay] = useState<boolean>(() => visit?.is_all_day ?? false);
  // Same seed-once-at-mount rule again, and here it is the one that stops the form being
  // DESTRUCTIVE rather than merely inconvenient. The control defaults to the service address and
  // the body below states a location on every save, so a Reschedule opened on a yard booking with
  // no seed would post `location: null` and send the crew to the customer's house after the
  // customer had been told otherwise. The backend's omitted-means-unchanged rule cannot save a
  // form that always states one; only this can. `visit_location` is the trip's own stored answer,
  // and `seedVisitLocation` reads an absent one as the service address - the same thing a fresh
  // booking means.
  const [location, setLocation] = useState<VisitLocationValue>(() => seedVisitLocation(visit?.visit_location));
  // Complete AND ordered. Every other consumer of these four fields blocks on isInvertedRange
  // too (AssignJobDialog, the lead page, the walkthrough tab) - the field group shows its own
  // inline warning, but only the button can stop the write. A zero-length or negative window is
  // not cosmetic: the backend mirrors it onto the job, and detectCrewConflicts' overlap test
  // (`start < end AND end > start`) can no longer match that job, so double-booking checks on it
  // quietly stop finding anything.
  const complete =
    Boolean(value.date && value.startTime && value.endDate && value.endTime) && !isInvertedRange(value)
    // A half-typed one-off address cannot be stored (the API's schema requires line 1, city and
    // state together), and a one-off missing its city renders "400 Supplier Rd, , NC" in the
    // customer's email. Blocked here so Save is disabled rather than answering 400 into a toast.
    && isVisitLocationComplete(location);

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        scheduled_start: dayAndTimeToIso(value.date, value.startTime, tz),
        scheduled_end: dayAndTimeToIso(value.endDate, value.endTime, tz),
        // Sent explicitly on every save, unlike crew - the checkbox is
        // always rendered and its state is always a decision made in front of the user, so there
        // is no "untouched" case for rescheduleJobVisitSchema's omitted-means-unchanged reading to
        // apply to. Omitting it here would read as "unchanged" on a PATCH but as "false" on the
        // POST default, two different meanings for the one gesture of never touching the box.
        is_all_day: isAllDay,
        // Only when the picker is actually present. A principal who may reschedule but not assign
        // sends NO key at all, so the backend's "omitted means unchanged" contract does the right
        // thing rather than this dialog racing it with an empty array.
        ...(canAssignCrew ? { assignee_ids: crew } : {}),
        // Always stated, never omitted - the control is on screen and the person just looked at
        // it, so "Service address" is a choice that CLEARS a previous one rather than silence.
        // `null` is that clear; a company location sends its ID ALONE, because the stored value is
        // a pointer and a copied address would stop tracking corrections made in Settings (D2).
        // Omitting is the API's "I am not talking about the location" and belongs to callers that
        // genuinely are not - the board's drag-to-reschedule, which sends a window and nothing
        // else through this same PATCH.
        location: visitLocationPayload(location),
        // No notify keys, ever. The customer is told by the org's "Job is scheduled" and "Job is
        // rescheduled" automations, which the visit routes run when the body says nothing about
        // notifying. A hand-composed tick used to send a second email beside them, and an
        // untick suppressed them for the occurrence; neither is reachable from the web now.
      };
      if (visit) {
        await api.patch(`/api/jobs/${jobId}/visits/${visit.id}`, body);
      } else {
        await api.post(`/api/jobs/${jobId}/visits`, body);
      }
    },
    onSuccess: () => {
      refreshAfterVisitWrite(queryClient, { jobId });
      onOpenChange(false);
    },
    onError: (err) => toast.error(extractApiError(err, 'Failed to save visit')),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{visit ? `Reschedule Visit ${visit.visit_seq}` : 'Add Visit'}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          {/* Not paired with Label/htmlFor: aria-label on the control is the v2 pattern for a
              label-beside-control row. */}
          <label className="flex cursor-pointer items-center gap-2 py-1">
            <Checkbox
              checked={isAllDay}
              onCheckedChange={(next) => {
                const checked = next === true;
                setIsAllDay(checked);
                if (checked && value.date) setValue(allDayRange(value.date, lastDayOf(value)));
              }}
              aria-label="All Day"
            />
            <span className="text-text-primary text-sm">All Day</span>
          </label>
          <ScheduleTimeFields value={value} onChange={setValue} idPrefix="job-visit" allDay={isAllDay} />
          {canAssignCrew && (
            <div className="mt-4 space-y-2">
              <Label htmlFor="job-visit-crew">Crew</Label>
              {/* `knownPeople` is THIS visit's own crew rows, which carry the names
                  (`VisitCrewMember.user`). The roster behind the picker answers only "who may I
                  add" and is scoped to the viewer's `assign User` grant, so a crew member the
                  viewer may not have chosen themselves would otherwise render as `Unknown` on a
                  trip they are perfectly entitled to read. */}
              <MultiAssigneeSelect
                id="job-visit-crew"
                value={crew}
                onChange={setCrew}
                purpose="jobCrew"
                enabled={open}
                knownPeople={(visit?.assignees ?? []).map((a) => a.user)}
              />
            </div>
          )}
          {/* Where this trip is happening - the SAME control the lead side's booking form uses,
              from _shared/, not a job-shaped copy. It sits after who is going, matching the
              order the office already decides these in: when, who, where. */}
          <div className="mt-4">
            <VisitLocationField
              value={location}
              onChange={setLocation}
              idPrefix="job-visit-location"
            />
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            isLoading={save.isPending}
            onClick={() => save.mutate()}
            disabled={!complete || save.isPending}
          >
            {/* The save can run seconds server-side (the automation's customer email is awaited)
                - the label has to change too, not just grey out, or a slow save reads as stuck. */}
            {save.isPending ? (visit ? 'Saving...' : 'Booking...') : (visit ? 'Save visit' : 'Book visit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default VisitScheduleDialog;
