import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Ban, Calendar, CalendarClock, CalendarPlus, CheckCircle2, ChevronDown } from 'lucide-react';

import api from '@/lib/axios';
import { refreshAfterVisitWrite } from '@/lib/refreshAfterVisitWrite';
import { useSpiderWatcherStore } from '@/stores/spiderWatcherStore';
import { extractApiError } from '@/lib/utils';
import { MultiAssigneeSelect } from '@/components/crm/MultiAssigneeSelect';
import { useAssignUserPermission } from '@/lib/users/useAssignUserPermission';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Label } from '@/ui-kit/components/ui/label';
import { Textarea } from '@/ui-kit/components/ui/textarea';
import {
  EMPTY_SCHEDULE_TIME,
  durationMinutesOf,
  isInvertedRange,
  withDurationMinutes,
  type ScheduleTimeValue,
} from '@/components/schedule/scheduleTimeValue';
import {
  dayAndTimeToIso, isoToOrgDay, isoToOrgTime, useScheduleTimezone,
} from '@/lib/schedule-tz';

import { ScheduleTimeFields } from '../../_shared/scheduleTimeFields';
import { VisitLocationLine } from '../../_shared/visitLocationLine';
import {
  SERVICE_ADDRESS_VALUE, VisitLocationField, isVisitLocationComplete, seedVisitLocation,
  visitLocationPayload, type StoredVisitLocation, type VisitLocationValue,
} from '../../_shared/visitLocationField';
import { formatDateTime, isWalkthroughActive, type UserSummary, type VisitHistoryRow } from './leadShared';
import { otherVisits } from '@/lib/visits';
import type { ScheduleConflictItem as ScheduleConflict } from '@/pages/v2/_shared/scheduleConflict';

/** What a walkthrough lasts when nothing says otherwise - a seed and a post-time fallback. */
const DEFAULT_WALKTHROUGH_MINUTES = 60;

// `ScheduleConflict` (the local alias kept below, so every existing use site in this file is
// unchanged) used to be its own copy of this shape - COPY-PASTED in five places across this file
// and SchedulePage.tsx, which is exactly how BE-routes's additive `crew` / `customer_name` fields
// would land in four of the five and be forgotten in the fifth (Q6, RATIFIED). It is now the one
// shared `ScheduleConflictItem` from `pages/v2/_shared/scheduleConflict.ts` - `_shared/`, not
// `schedule/`, because this file lives in the `leads/` module and the v2 module-isolation guard
// (pages/v2/__tests__/moduleIsolation.test.ts) forbids one module importing another's folder.
// This file's own render of the conflict list does not use the two new fields - that is out of
// this contract's scope - but importing the shared type keeps this copy from drifting out of
// sync again.

/** The stored start + duration, back as the four fields the scheduling form edits. */
function seedWtTime(scheduledAt: string | null, durationMinutes: number | null, tz: string): ScheduleTimeValue {
  const date = isoToOrgDay(scheduledAt, tz);
  const startTime = isoToOrgTime(scheduledAt, tz);
  if (!date || !startTime) return EMPTY_SCHEDULE_TIME;
  return withDurationMinutes(
    { date, startTime, endDate: date, endTime: '' },
    durationMinutes ?? DEFAULT_WALKTHROUGH_MINUTES,
  );
}

/**
 * Who is in the Performers field to begin with.
 *
 * A LIVE visit that already names people keeps exactly those people - a two-performer
 * booking must not quietly gain a third just because the viewer opened it, and a
 * grant holder still starts from what is stored. `stored` is `liveVisitPerformerIds`,
 * never the raw wire key: a cancelled or completed trip's crew is history, and treating
 * it as staffing is what walked a self-only rep into a 403 they could not leave.
 *
 * The seed is for the other case: no live visit, or one with nobody on it, opened by someone who
 * may not name anybody but themselves. Their roster is one row long and it is them,
 * so an empty field offers a choice that does not exist while leaving Schedule
 * Walkthrough dead on `wtPerformers.length === 0`. Pre-filling it states the only
 * outcome the API would accept from them - the one the API refuses anything else with.
 *
 * `actorId` is '' until the session hydrates, and `['']` is a performer the API
 * answers 400 for - so the guard stays, and the caller re-runs this when the
 * session lands.
 */
function seedPerformers(stored: string[], canAssignOthers: boolean, actorId: string): string[] {
  if (stored.length > 0) return stored;
  if (canAssignOthers) return [];
  return actorId ? [actorId] : [];
}

/**
 * Who the SERVER will treat as already on this lead's walkthrough - which is not the same as
 * who `walkthrough_performers` names.
 *
 * `POST /walkthrough/schedule` resolves the visit it is about through `findActiveWalkthrough`:
 * the earliest LIVE visit (SCHEDULED / EN_ROUTE / ON_SITE / IN_PROGRESS). Its assignees become
 * `currentPerformerIds`, and restating that set unchanged is what exempts a viewer without
 * `assign User` from the pool rule. With no live visit the endpoint passes `undefined` and takes
 * the STRICT path, where naming anybody but yourself is a 403.
 *
 * `walkthrough_performers` is the crew of the CURRENT visit (walkthrough.service.ts,
 * projectLeadVisitCrew) - the same visit the flat `walkthrough_*` fields describe, which is the
 * live one when there is one and the last finished one when there is not. So the two notions
 * differ on exactly one case, and it is the case that dead-ended in QA: a lead whose visits are
 * all CANCELLED (or all COMPLETED) reports a crew, `seedPerformers` reads it as "already
 * staffed", and the field arrives holding somebody this viewer may not name, locked, on a save
 * the API answers 403 for - quoting the rule the form itself prints underneath.
 *
 * The flat fields say which case it is: `walkthrough_completed_at` / `walkthrough_cancelled_at`
 * are stamped ONLY when the current visit is that finished visit (projectLegacyWalkthroughFields
 * reads `current?.status`). Either one present therefore means "no live visit", so its crew is
 * history and the form must start from empty - agreeing with `findActiveWalkthrough` exactly.
 * Read in the NEGATIVE deliberately: `isWalkthroughActive` additionally demands a `scheduled_at`,
 * so a live visit with no time yet would read as inactive there and lose a real roster here.
 */
export function liveVisitPerformerIds(lead: Record<string, unknown>): string[] {
  if (lead.walkthrough_completed_at || lead.walkthrough_cancelled_at) return [];
  return ((lead.walkthrough_performers as { user: { id: string } }[] | undefined) ?? [])
    .map((p) => p.user.id);
}

/**
 * The resync signature: the page passes this as the component's `key`, so the
 * editable local state below is re-seeded exactly when the legacy effect would
 * have re-run - when the lead's scheduled-at, duration, performers or notes
 * change.
 *
 * The completed/cancelled stamps are in here because the SEED reads them (see
 * `liveVisitPerformerIds`): cancelling the current visit leaves its scheduled-at, duration and
 * crew all exactly as they were, so without them the one field that flips is invisible to this
 * key and the tab would keep a seed the server no longer agrees with.
 */
export function walkthroughSyncKey(lead: Record<string, unknown>): string {
  const performers = (lead.walkthrough_performers as { user: { id: string } }[] | undefined) ?? [];
  return [
    lead.walkthrough_scheduled_at ?? '',
    lead.walkthrough_duration_minutes ?? '',
    performers.map((p) => p.user.id).join(','),
    lead.walkthrough_notes ?? '',
    lead.walkthrough_completed_at ?? '',
    lead.walkthrough_cancelled_at ?? '',
    // Where the visit is. In the key for the same reason the crew is: the location control is
    // SEEDED from it, so a location changed on the server (or through another surface) has to
    // re-seed this tab, or the next save would post a stale place the person never chose.
    JSON.stringify(lead.walkthrough_location ?? null),
  ].join('|');
}

/**
 * v2 walkthrough tab.
 *
 * Endpoints, payloads, invalidations, the four mutually exclusive states and
 * their precedence are the legacy tab's. `MultiAssigneeSelect` is reused rather
 * than rebuilt - it owns non-trivial behaviour (department-grouped roster) that
 * belongs to shared infrastructure, not to this module.
 *
 * No attachments here by design. This tab used to carry its own uploader writing
 * context=WALKTHROUGH, which split a lead's files across two places and, worse,
 * was the ONLY context that followed the lead into its job. A lead now has one
 * attachment list, on the lead's Attachments tab, and all of it travels.
 */
export function WalkthroughTabContent({
  lead, leadId, canPerformWalkthrough, canScheduleWalkthrough, onCancelWalkthrough,
}: {
  lead: Record<string, unknown>;
  leadId: string;
  /** `perform_walkthrough Lead` - notes + completing. A strict TECHNICIAN holds this but NOT `update Lead`. */
  canPerformWalkthrough: boolean;
  /** `schedule_walkthrough Lead` - the scheduling form. */
  canScheduleWalkthrough: boolean;
  /**
   * Scheduling-notifications slice 09: opens the page's cancel-walkthrough dialog from the live
   * row's office group. The PAGE owns that dialog and passes this only when the viewer holds
   * `cancel Lead` - the gate POST /walkthrough/cancel rides - so absent means no Cancel on the
   * row, never a Cancel that 403s.
   */
  onCancelWalkthrough?: () => void;
}) {
  const queryClient = useQueryClient();
  // `assign User` - the grant the walkthroughPerformer roster is scoped by, read off the CASL
  // ability and never off `user.role`; see the hook's note. It decides both what this field is
  // seeded with and whether it may be changed at all.
  // `actorKnownPeople` is the LABEL for the id that seed puts in - the roster cannot supply it
  // while it is loading (or at all, if it fails), and the record cannot supply it because the
  // seed only fires when the record names nobody. See the picker's `knownPeople` note below.
  const { canAssignOthers, actorId, actorKnownPeople } = useAssignUserPermission();
  // The legacy tab kept these in sync with the lead through an effect. Here they
  // are seeded once per mount, and the page re-keys this component whenever the
  // underlying lead fields change - same resync points, no state written from an
  // effect.
  // Scheduling values mean the ORG's clock, never the viewer's browser - the same rule the
  // job form and the scheduler board already follow.
  const timezone = useScheduleTimezone();
  // The four picker fields ARE the state of record, held exactly as ScheduleTimeFields
  // edits them. Storing a combined 'YYYY-MM-DDTHH:mm' string instead loses every partial
  // edit - a date picked before its time collapses the whole value to '', so the fields
  // never accumulate and Schedule Walkthrough stays disabled.
  const [wtTime, setWtTime] = useState<ScheduleTimeValue>(
    () => seedWtTime(
      lead.walkthrough_scheduled_at as string | null,
      lead.walkthrough_duration_minutes as number | null,
      timezone,
    ),
  );
  // The LIVE visit's crew, not the current visit's - see `liveVisitPerformerIds`. This is the
  // set the server will compare a save against, so it is the only set "already staffed" can
  // honestly mean here.
  const storedPerformerIds = liveVisitPerformerIds(lead);
  const [wtPerformers, setWtPerformers] = useState<string[]>(
    () => seedPerformers(storedPerformerIds, canAssignOthers, actorId),
  );
  // Where the walkthrough is. SEEDED from the stored location, and that seed is the whole reason
  // a Reschedule of the time alone does not move the meeting: this form states a location on
  // every save, so a control defaulting to "Service address" would post the customer's own house
  // over a showroom booking they had already been told about. The API's omitted-means-unchanged
  // rule cannot rescue a form that always states one.
  const storedLocation = lead.walkthrough_location as StoredVisitLocation | null | undefined;
  const [wtLocation, setWtLocation] = useState<VisitLocationValue>(() => seedVisitLocation(storedLocation));
  const [wtNotes, setWtNotes] = useState(() => (lead.walkthrough_notes as string) || '');
  const [historyOpen, setHistoryOpen] = useState(false);
  // A reschedule is the SAME visit at a new time, not a second booking: POST /walkthrough/schedule
  // reuses the lead's live visit row (walkthrough.service.ts, scheduleActiveWalkthrough). So this
  // flag only decides whether the booking form is on screen - the request it sends is the request
  // this tab already sends.
  const [isRescheduling, setIsRescheduling] = useState(false);
  // An ADDITIONAL visit is a different act from a reschedule, and a different endpoint:
  // POST /api/leads/:id/visits creates a NEW row and leaves every existing one alone, while
  // POST /walkthrough/schedule reuses the live one. Both drive the same fields below - one form,
  // two doors - so this flag says which door Book/Save is standing in front of.
  const [isAddingVisit, setIsAddingVisit] = useState(false);
  // Held apart from the mutation's own error so the override can re-post the identical payload
  // with `force`, and so editing the fields can drop a verdict that no longer describes them.
  const [conflicts, setConflicts] = useState<ScheduleConflict[] | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const markLeadNotificationsRead = useSpiderWatcherStore((s) => s.markLeadNotificationsRead);

  // The page re-keys this component when the LEAD's values change, but the org-timezone
  // query can land after mount - and the same wall clock read against a different zone is
  // a different instant, so the fields must be re-seeded when it does. Adjusted during
  // render rather than in an effect: React's documented way to reset state on a changed
  // input, and what `react-hooks/set-state-in-effect` (enforced on changed lines in CI)
  // requires.
  const [lastTz, setLastTz] = useState(timezone);
  if (timezone !== lastTz) {
    setLastTz(timezone);
    setWtTime(seedWtTime(
      lead.walkthrough_scheduled_at as string | null,
      lead.walkthrough_duration_minutes as number | null,
      timezone,
    ));
  }

  // The grant and the actor arrive WITH the session, and a tab mounted before it lands reads
  // `{ canAssignOthers: false, actorId: '' }` - which seeds nothing, because '' is not a
  // performer. So the seed is re-run when the pair changes, exactly as the timezone re-seed
  // above is: adjusted during render off a sentinel, not written from an effect
  // (`react-hooks/set-state-in-effect`). A hydration that turns out to grant `assign User`
  // clears the self-seed again, leaving a holder's field the way it is today.
  const grantSeen = `${canAssignOthers}|${actorId}`;
  const [lastGrant, setLastGrant] = useState(grantSeen);
  if (grantSeen !== lastGrant) {
    setLastGrant(grantSeen);
    setWtPerformers(seedPerformers(storedPerformerIds, canAssignOthers, actorId));
  }

  // A walkthrough STORES a start + a duration, so both are derived from the fields at the
  // API seam rather than kept alongside them.
  const wtScheduledIso = dayAndTimeToIso(wtTime.date, wtTime.startTime, timezone);

  // A walkthrough STORES a start + a duration, so the end is that start plus that duration.
  // Derived here instead of shown as a raw minute count: the summary then answers the same
  // question the form asks, and a visit running past midnight names the day it really ends on.
  const scheduledAtIso = lead.walkthrough_scheduled_at as string | null;
  const durationMinutes = (lead.walkthrough_duration_minutes as number | null) ?? DEFAULT_WALKTHROUGH_MINUTES;
  const endsAtIso = scheduledAtIso
    ? new Date(new Date(scheduledAtIso).getTime() + durationMinutes * 60_000).toISOString()
    : null;

  // A conflict verdict describes the fields that produced it. Editing either half retires it,
  // rather than leaving the previous slot's clash sitting under a slot nobody has tested yet.
  const editTime = (next: ScheduleTimeValue) => { setWtTime(next); setConflicts(null); };
  const editPerformers = (next: string[]) => { setWtPerformers(next); setConflicts(null); };
  const editLocation = (next: VisitLocationValue) => { setWtLocation(next); setConflicts(null); };

  const isCompleted = Boolean(lead.walkthrough_completed_at);
  const isCancelled = Boolean(lead.walkthrough_cancelled_at);
  const isScheduled = isWalkthroughActive(
    lead.walkthrough_scheduled_at,
    lead.walkthrough_completed_at,
    lead.walkthrough_cancelled_at,
  );
  const completedAt = lead.walkthrough_completed_at as string | null;
  const cancelledAt = lead.walkthrough_cancelled_at as string | null;
  const cancelledReason = lead.walkthrough_cancelled_reason as string | null;
  const performers = (lead.walkthrough_performers as { user: UserSummary }[] | undefined) ?? [];
  const performerLabel = performers.length > 0
    ? performers.map((p) => `${p.user.first_name} ${p.user.last_name}`).join(', ')
    : null;

  // The tab shows the CURRENT visit with a visit count + history behind it.
  // History excludes whichever row the state-specific content already describes.
  const visitCount = (lead.walkthrough_count as number | undefined) ?? 0;
  const visitHistory = (lead.walkthrough_history as VisitHistoryRow[] | undefined) ?? [];
  // Multi-visit S1: excluded by row IDENTITY via the shared module, not by status class - see
  // lib/visits.ts. It stays in that module rather than being inlined here: the v1 lead page that
  // used to hold the second copy is deleted, but #1551 is what a second copy cost, and the job
  // trees still read the same module.
  const pastVisits = otherVisits(visitHistory);

  const visitHistorySection = visitCount > 1 && (
    <div>
      <Button variant="ghost" size="sm" className="-ms-2" onClick={() => setHistoryOpen((open) => !open)}>
        <ChevronDown className={historyOpen ? '' : '-rotate-90'} />
        {visitCount} Visits Total
      </Button>
      {historyOpen && (
        <div className="mt-2 flex flex-col gap-2">
          {pastVisits.length === 0 ? (
            <p className="text-muted-foreground text-xs">No earlier visits.</p>
          ) : (
            pastVisits.map((w) => (
              <div key={w.id} className="flex items-start gap-2.5 rounded-lg border p-2.5 text-sm">
                <span
                  className={[
                    'mt-1 inline-block size-1.5 shrink-0 rounded-full',
                    w.status === 'COMPLETED' ? 'bg-status-green'
                      : w.status === 'CANCELLED' ? 'bg-status-red' : 'bg-muted',
                  ].join(' ')}
                />
                <div className="min-w-0">
                  {/* D13/D19 - the job surface has always numbered its trips here and the
                      lead surface did not, so a cancelled lead visit was visible but
                      unnamed and could not be matched to the customer's own email. */}
                  {w.visit_seq != null && (
                    <p className="text-muted-foreground text-xs font-medium">Visit {w.visit_seq}</p>
                  )}
                  <p className="font-medium">
                    {w.status === 'COMPLETED' && w.completed_at
                      ? `Completed ${formatDateTime(w.completed_at, timezone)}`
                      : w.status === 'CANCELLED' && w.cancelled_at
                        ? `Cancelled ${formatDateTime(w.cancelled_at, timezone)}`
                        : w.scheduled_at
                          ? `Scheduled ${formatDateTime(w.scheduled_at, timezone)}`
                          : 'Requested'}
                  </p>
                  {/* Slice 6: where this earlier trip was, when it was not at the service
                      address. The office reads this list to answer "what happened before", and a
                      showroom meeting that read as a house call was indistinguishable from one. */}
                  <VisitLocationLine label={w.location_label} />
                  {w.status === 'CANCELLED' && w.cancelled_reason && (
                    <p className="text-muted-foreground mt-0.5 text-xs">{w.cancelled_reason}</p>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );

  // `force` re-posts the identical payload past a 409. The backend, not this component, decides
  // what clashes; booking and rescheduling send the same body, because the endpoint reuses the
  // live visit row either way.
  const scheduleMutation = useMutation({
    mutationFn: async (force: boolean) => {
      await api.post(`/api/leads/${leadId}/walkthrough/schedule`, {
        walkthrough_scheduled_at: wtScheduledIso,
        performer_ids: wtPerformers,
        walkthrough_duration_minutes: durationMinutesOf(wtTime) ?? DEFAULT_WALKTHROUGH_MINUTES,
        // Always stated, never omitted - the control is on screen and the person just looked at
        // it, so "Service address" is a choice that clears a previous one rather than silence.
        // `null` is that clear; a saved location sends its ID ALONE, because the stored value is
        // a pointer and a copied address would stop tracking corrections made in Settings.
        location: visitLocationPayload(wtLocation),
        ...(force ? { force: true } : {}),
      });
    },
    onSuccess: async () => {
      setConflicts(null);
      // The page re-keys this component off the lead's own values, so a moved visit remounts
      // back into its read-only summary. Closed here too for the reschedule that lands on the
      // time already stored, which changes no key.
      setIsRescheduling(false);
      useSpiderWatcherStore.getState().markLeadNotificationsRead(leadId, 'new-contacted');
      useSpiderWatcherStore.getState().markLeadNotificationsRead(leadId, 'contacted-walkthrough-scheduled');
      refreshAfterVisitWrite(queryClient, { leadId });

      const notifId = searchParams.get('notifId');
      if (notifId) {
        try {
          await api.patch(`/api/notifications/${notifId}/read`);
          queryClient.invalidateQueries({ queryKey: ['notifications'] });
        } catch (err) {
          console.warn('Failed to mark notification as read:', err);
        }
      }
      if (searchParams.has('notifId')) {
        const next = new URLSearchParams(searchParams);
        next.delete('notifId');
        setSearchParams(next, { replace: true });
      }
    },
    onError: (err) => {
      const res = (err as { response?: { status?: number; data?: { conflicts?: ScheduleConflict[] } } }).response;
      // An empty list still means "the API refused this slot", so a 409 is captured by STATUS
      // rather than by the list being non-empty - otherwise the override never appears.
      setConflicts(res?.status === 409 ? (res.data?.conflicts ?? []) : null);
    },
  });

  /**
   * Book an ADDITIONAL visit - the door the tab had no button for at all.
   *
   * `POST /api/leads/:id/visits` is gated `canDo('schedule_walkthrough','Lead')` and re-checked
   * per row, the same pair the scheduling form above rides, so this adds no reach: it exposes a
   * door the API already opened to exactly these viewers and that no surface in the app called.
   *
   * DELIBERATELY THE STRICT POOL PATH. `createVisit` calls `validatePerformers(req, assignee_ids)`
   * with NO current-roster argument - a brand-new trip restates nothing, so the "an unchanged
   * restatement is not a crew statement" exemption does not apply here. That is why `openAddVisit`
   * seeds this form from `seedPerformers([], ...)` rather than from the live visit's crew: handing
   * a self-only rep the dispatcher-assigned technician already on visit 1 would arrive locked,
   * unfixable, and 403.
   *
   * Payload keys are this endpoint's own (`scheduled_at` / `duration_minutes` / `assignee_ids`),
   * NOT the walkthrough door's (`walkthrough_scheduled_at` / `walkthrough_duration_minutes` /
   * `performer_ids`). Zod strips unknown keys, so the wrong set would post a 400 for a missing
   * `scheduled_at` rather than anything that reads like a mix-up.
   */
  const addVisitMutation = useMutation({
    mutationFn: async (force: boolean) => {
      await api.post(`/api/leads/${leadId}/visits`, {
        scheduled_at: wtScheduledIso,
        duration_minutes: durationMinutesOf(wtTime) ?? DEFAULT_WALKTHROUGH_MINUTES,
        assignee_ids: wtPerformers,
        // Stated, never omitted, exactly as the schedule door above states it - the control is on
        // screen and the person just looked at it. `null` is "the service address", which on a
        // CREATE the API reads the same way as saying nothing; sending it anyway keeps the two
        // forms' payloads the same shape, so the key that carries a showroom on one is the key
        // that carries it on the other. `location`, not the `location_id`/address fields spread
        // flat: this endpoint's schema is the SAME shared field, and Zod would strip a flat one.
        location: visitLocationPayload(wtLocation),
        ...(force ? { force: true } : {}),
      });
    },
    onSuccess: () => {
      setConflicts(null);
      setIsAddingVisit(false);
      // The new trip need not become the CURRENT one (booking it later than the live visit
      // leaves the current visit exactly as it was), so `walkthroughSyncKey` can be unchanged
      // and this component never remounts. Re-seed by hand rather than trusting the key.
      setWtTime(seedWtTime(
        lead.walkthrough_scheduled_at as string | null,
        lead.walkthrough_duration_minutes as number | null,
        timezone,
      ));
      setWtPerformers(seedPerformers(storedPerformerIds, canAssignOthers, actorId));
      refreshAfterVisitWrite(queryClient, { leadId });
    },
    onError: (err) => {
      const res = (err as { response?: { status?: number; data?: { conflicts?: ScheduleConflict[] } } }).response;
      setConflicts(res?.status === 409 ? (res.data?.conflicts ?? []) : null);
    },
  });

  // Which door the shared conflict / error blocks below are reporting for. Only one of the two
  // forms is ever on screen (opening either closes the other), so this is a choice, not a merge.
  const activeScheduleMutation = isAddingVisit ? addVisitMutation : scheduleMutation;

  const completeMutation = useMutation({
    mutationFn: async () => { await api.post(`/api/leads/${leadId}/walkthrough/complete`); },
    onSuccess: () => { refreshAfterVisitWrite(queryClient, { leadId }); },
  });

  const saveNotesMutation = useMutation({
    mutationFn: async () => {
      await api.post(`/api/leads/${leadId}/walkthrough`, { walkthrough_notes: wtNotes || null });
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['lead', leadId] }); },
  });

  const notesBlock = (showError: boolean) => (
    <div>
      <p className="text-muted-foreground mb-3 text-xs font-semibold uppercase">Notes</p>
      <Textarea
        value={wtNotes}
        onChange={(e) => setWtNotes(e.target.value)}
        rows={4}
        placeholder="Walkthrough notes..."
        disabled={!canPerformWalkthrough}
      />
      {canPerformWalkthrough && wtNotes !== ((lead.walkthrough_notes as string) || '') && (
        <Button
          size="sm"
          className="mt-2"
          onClick={() => saveNotesMutation.mutate()}
          disabled={saveNotesMutation.isPending}
        >
          {saveNotesMutation.isPending ? 'Saving...' : 'Save Notes'}
        </Button>
      )}
      {showError && saveNotesMutation.error && (
        <p className="text-destructive mt-1 text-sm">Failed to save notes</p>
      )}
    </div>
  );

  // The booked visit, read-only. Start and end are both stamped with their DATE: a walkthrough
  // that crosses midnight ends on a different day, and a bare end time would not say so.
  const scheduleSummary = (
    <div className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-3">
      <p>
        <span className="text-muted-foreground">Starts: </span>
        <span className="font-medium">{scheduledAtIso ? formatDateTime(scheduledAtIso, timezone) : '-'}</span>
      </p>
      <p>
        <span className="text-muted-foreground">Ends: </span>
        <span className="font-medium">{endsAtIso ? formatDateTime(endsAtIso, timezone) : '-'}</span>
      </p>
      <p>
        <span className="text-muted-foreground">Performer: </span>
        <span className="font-medium">{performerLabel ?? '-'}</span>
      </p>
      {/* Slice 6: where the booked walkthrough actually is. Spans the row rather than taking a
          fourth column, because it is absent on the great majority of leads and a column that is
          usually empty is a hole in the grid rather than a field. */}
      <VisitLocationLine
        label={lead.walkthrough_location_label as string | null | undefined}
        className="sm:col-span-3"
      />
    </div>
  );

  // ONE form for booking and for rescheduling. Two copies would be two things to keep in step,
  // and the fields are the same fields because the endpoint behind them is the same endpoint.
  const scheduleFieldsBlock = (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      {/* A walkthrough STORES a duration, not an end - so the end here is derived on the way in
          and converted back to minutes on the way out. The person booking it sees exactly the
          fields the scheduler board and the job form show. */}
      <div className="sm:col-span-2">
        <ScheduleTimeFields
          idPrefix="v2-wt"
          value={wtTime}
          onChange={editTime}
          disabled={!canScheduleWalkthrough}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        {/* `htmlFor` + the trigger's `id`: this Label used to name nothing, and the form now holds
            a SECOND combobox (the location picker below), so "the combobox" is no longer an
            unambiguous thing for a screen reader or for a test to mean. */}
        <Label htmlFor="v2-wt-performers">Performers</Label>
        {/* `knownPeople` is the ACTOR followed by the lead's OWN performer rows, and both halves
            are load-bearing for a viewer whose roster is scoped to themselves.

            The lead's rows carry the names of people the roster will never contain - without
            them the chip for a technician a dispatcher put on this walkthrough rendered
            `Unknown` to the very person who owns the lead. Seeing who is on it is not the same
            permission as changing who is on it.

            The ACTOR is there for the SEEDED chip, which neither source can name: the roster
            (`useAssignableUsers`) has no `placeholderData` to fall back to on a cold load, so its
            `data` is `[]` for the whole of the request AND for ever if it fails, and the seed
            fires precisely when this lead's `walkthrough_performers` is empty. Without it a rep
            cold-loading their own lead read `Unknown` in the one chip they are allowed to have
            (PRD story 15) - and with the rule line now gone that chip is ALL they see, so this
            matters more, not less. It adds nobody to the dropdown - see `knownPeople.ts`.

            The actor goes FIRST so the record's own copy of a name wins: `namesById` builds a Map
            in order, so a later entry overwrites an earlier one, and the record is the truth
            about the record. */}
        {/* Locked for a viewer without `assign User`: their chip keeps its name but loses its
            remove control, and the combobox will not open - which is the whole of what "may not
            name others" means on this control, since the seed above has already put the one
            person they MAY name into it. */}
        <MultiAssigneeSelect
          id="v2-wt-performers"
          value={wtPerformers}
          onChange={editPerformers}
          purpose="walkthroughPerformer"
          placeholder="Add performer..."
          disabled={!canScheduleWalkthrough || !canAssignOthers}
          knownPeople={[...actorKnownPeople, ...performers.map((p) => p.user)]}
        />
        {/* NO SUBTITLE UNDER THIS FIELD - removed on the product owner's direct instruction, not
            forgotten. It used to read "You can only put yourself on a walkthrough." whenever the
            viewer held `schedule_walkthrough Lead` but not `assign User`. His ruling: the field
            being locked with no dropdown already communicates the rule, so the sentence was
            redundant. It came off the two board twins (`unifiedDropModal`, `eventEditor`) in the
            same change, so no surface states what this one no longer states.

            THE API IS UNCHANGED. `walkthrough.service.ts` PERFORMER_SELF_ONLY still refuses in
            those words, and a 403 that gets that far still renders through
            `scheduleErrorBlock` / `extractApiError`. What is gone is the promise made before the
            post. `frontend/src/__tests__/selfOnlyRefusalCopy.test.ts` reads this file and the two
            board surfaces and fails if the sentence comes back. */}
      </div>
      {/* WHERE, beside WHEN and WHO, because that is where the office already decides everything
          else that varies per trip. Full width under the row: the one-off reveals four more
          fields, and a third column would leave them squeezed into a sliver.

          ON BOTH FORMS. It was hidden on the additional-visit one while `POST
          /api/leads/:id/visits` did not take a location: Zod strips unknown keys, so offering the
          control there would have let somebody pick the showroom, watch the visit book, and have
          the choice silently dropped. That door takes one now, and the SECOND trip is the trip
          this whole feature was written for - the first meeting at the showroom, the measure at
          the customer's house, a design review back at the showroom. */}
      <div className="sm:col-span-3">
        <VisitLocationField
          idPrefix="v2-wt"
          value={wtLocation}
          onChange={editLocation}
          disabled={!canScheduleWalkthrough}
        />
      </div>
    </div>
  );

  // Nothing to post: no start, nobody to send, or an end the fields already show as before the
  // start. Never a reason a person cannot read off the form itself.
  // ...and a half-typed one-off address, which the API refuses on the same rule (line 1, city and
  // state together). Disabling here rather than posting into a 400 keeps the refusal where the
  // person can see which field is missing.
  const scheduleBlocked =
    !wtScheduledIso || wtPerformers.length === 0 || isInvertedRange(wtTime)
    || !isVisitLocationComplete(wtLocation);

  // Backing out re-seeds from the STORED booking rather than just hiding the form: the fields are
  // this component's state, so abandoned edits would otherwise still be sitting in them the next
  // time Reschedule is opened.
  const cancelReschedule = () => {
    setIsRescheduling(false);
    setConflicts(null);
    setWtTime(seedWtTime(scheduledAtIso, durationMinutes, timezone));
    setWtPerformers(seedPerformers(storedPerformerIds, canAssignOthers, actorId));
    setWtLocation(seedVisitLocation(storedLocation));
  };

  /** Reschedule and Book Another Visit share one set of fields, so opening either closes the
   *  other - otherwise the second form would open holding whatever the first was mid-edit. */
  const openReschedule = () => {
    setIsAddingVisit(false);
    setConflicts(null);
    setWtTime(seedWtTime(scheduledAtIso, durationMinutes, timezone));
    setWtPerformers(seedPerformers(storedPerformerIds, canAssignOthers, actorId));
    // From the STORED location, not from whatever the fields were last left holding: this form
    // is about the visit that exists, and its location is part of that visit.
    setWtLocation(seedVisitLocation(storedLocation));
    setIsRescheduling(true);
  };

  /**
   * Open the additional-visit form EMPTY, and seeded with the actor alone.
   *
   * Empty time: a second trip is a new slot, and pre-filling it with the first trip's time is
   * both wrong and a guaranteed 409 against the visit it was copied from.
   *
   * `seedPerformers([], ...)` rather than the stored crew: `POST /visits` takes the strict pool
   * path (see `addVisitMutation`), so the live visit's crew is not a set this form may restate.
   * A grant holder still starts empty and picks; a self-only rep gets themselves, locked - the
   * only roster the API would accept from them.
   */
  const openAddVisit = () => {
    setIsRescheduling(false);
    setConflicts(null);
    setWtTime(EMPTY_SCHEDULE_TIME);
    setWtPerformers(seedPerformers([], canAssignOthers, actorId));
    // The DEFAULT, not the live visit's location - and the same argument as the empty time above.
    // A second trip is a fresh decision about where, and pre-filling it with the showroom the
    // first meeting is at is the seeded default that becomes an unintended write: the great
    // majority of second visits are the measure at the customer's own house. It also keeps a pick
    // made on this form from being a stale value the shared fields hand back to Reschedule.
    setWtLocation(SERVICE_ADDRESS_VALUE);
    setIsAddingVisit(true);
  };

  const cancelAddVisit = () => {
    setIsAddingVisit(false);
    setConflicts(null);
    setWtTime(seedWtTime(scheduledAtIso, durationMinutes, timezone));
    setWtPerformers(seedPerformers(storedPerformerIds, canAssignOthers, actorId));
    setWtLocation(seedVisitLocation(storedLocation));
  };

  // A clash is the backend's verdict, so it is reported rather than pre-empted - with the way
  // through it, since a reschedule collides far more often than a first booking does.
  const conflictBlock = conflicts !== null && (
    <div className="bg-status-amber-subtle flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex items-start gap-3">
        <AlertTriangle className="text-status-amber size-5 shrink-0" />
        <div>
          <p className="text-sm font-semibold">Scheduling conflict</p>
          <p className="text-muted-foreground mt-0.5 text-xs">
            {conflicts.length > 0
              ? 'A performer is already booked over this slot.'
              : 'The API refused this slot.'}
          </p>
        </div>
      </div>
      {conflicts.length > 0 && (
        <div className="flex flex-col gap-2">
          {conflicts.map((c) => (
            <div key={`${c.type}-${c.id}-${String(c.start)}`} className="flex items-center gap-2 rounded-lg border bg-kit-card px-3 py-2 text-[13px]">
              {/* Both kinds share one accent, so the WT/JOB label carries the distinction. */}
              <Badge variant="softBlue" size="sm">{c.type === 'walkthrough' ? 'WT' : 'JOB'}</Badge>
              <span className="font-semibold">{c.number}</span>
              <span className="text-muted-foreground">
                {formatDateTime(String(c.start), timezone)} - {formatDateTime(String(c.end), timezone)}
              </span>
            </div>
          ))}
        </div>
      )}
      <div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => activeScheduleMutation.mutate(true)}
          disabled={scheduleBlocked || activeScheduleMutation.isPending}
        >
          {activeScheduleMutation.isPending ? 'Scheduling...' : 'Schedule anyway'}
        </Button>
      </div>
    </div>
  );

  // The generic error is for everything a conflict is NOT - a 409 is already spelled out above,
  // and printing both would say the same refusal twice.
  const scheduleErrorBlock = conflicts === null && activeScheduleMutation.error && (
    <p className="text-destructive mt-2 text-sm">
      {extractApiError(
        activeScheduleMutation.error,
        isAddingVisit ? 'Failed to book the visit' : 'Failed to schedule walkthrough',
      )}
    </p>
  );

  /**
   * DEFECT 2: the tab had no way to book a SECOND visit, for any role.
   *
   * `POST /api/leads/:id/visits` has existed and worked since S7 - the walkthrough tab simply
   * never called it, and neither did anything else in `frontend/src` (the only `/visits` POST the
   * app made was the JOB one, from `visitsCard`). So this was missing for a dispatcher exactly as
   * much as for a rep; it is not a permission bug and there was nothing role-shaped to unblock.
   *
   * It is shown only where the tab otherwise offers no booking at all - the COMPLETED and
   * SCHEDULED branches. The default branch (no live visit: fresh, or cancelled with nothing
   * rebooked) already books a new trip, because `scheduleActiveWalkthrough` CREATES a row when
   * `findActiveWalkthrough` returns none. A second button there would be a second way to do the
   * one thing that screen already does.
   *
   * Same rules as the first booking, because it is the same form: the Performers field is the
   * shared `MultiAssigneeSelect`, disabled for a viewer without `assign User`, holding the one
   * chip `openAddVisit` seeded - no dropdown, nothing to remove.
   */
  const addVisitSection = canScheduleWalkthrough && !isRescheduling && (
    isAddingVisit ? (
      <div>
        <p className="text-muted-foreground mb-3 text-xs font-semibold uppercase">Additional Visit</p>
        <div className="flex flex-col gap-4">
          {scheduleFieldsBlock}
          {conflictBlock}
          <div className="flex items-center gap-2">
            <Button
              onClick={() => addVisitMutation.mutate(false)}
              disabled={scheduleBlocked || addVisitMutation.isPending}
            >
              <Calendar />
              {addVisitMutation.isPending ? 'Booking...' : 'Book Visit'}
            </Button>
            <Button variant="ghost" onClick={cancelAddVisit} disabled={addVisitMutation.isPending}>
              Cancel
            </Button>
          </div>
          {scheduleErrorBlock}
        </div>
      </div>
    ) : (
      <div>
        <Button variant="outline" size="sm" onClick={openAddVisit}>
          <CalendarPlus />
          Book Another Visit
        </Button>
      </div>
    )
  );

  if (isCompleted) {
    return (
      <div className="flex flex-col gap-6 p-6">
        <div className="bg-status-green-subtle flex items-center gap-3 rounded-lg border p-4">
          <CheckCircle2 className="text-status-green-emphasis size-5 shrink-0" />
          <div>
            <p className="text-status-green-emphasis text-sm font-semibold">
              Completed on {formatDateTime(completedAt!, timezone)}
            </p>
            {performerLabel && (
              <p className="text-status-green-emphasis mt-0.5 text-xs">by {performerLabel}</p>
            )}
          </div>
        </div>

        <div>
          <p className="text-muted-foreground mb-3 text-xs font-semibold uppercase">Schedule Info</p>
          {scheduleSummary}
        </div>

        {addVisitSection}
        {visitHistorySection}
        {notesBlock(false)}
      </div>
    );
  }

  // Slice 09: the live row's controls, laid out as the job's visit row lays out its own. The
  // crew's ONE next step on the left - a walkthrough has a single milestone verb, so there is no
  // Skip to here - and the office's Reschedule / Cancel in a separate, right-aligned group
  // (story 21). Each control rides its own route's gate: Complete is `perform_walkthrough`,
  // Reschedule is `schedule_walkthrough` (moving a visit and booking one are the one endpoint),
  // Cancel is the page's `cancel Lead`, arriving as a callback.
  const liveRowActions = (canPerformWalkthrough || canScheduleWalkthrough || onCancelWalkthrough) && (
    <div className="flex flex-wrap items-start justify-between gap-2">
      {canPerformWalkthrough && (
        <div role="group" aria-label="Next step" className="flex flex-col gap-2">
          <Button size="sm" onClick={() => completeMutation.mutate()} disabled={completeMutation.isPending}>
            <CheckCircle2 />
            {completeMutation.isPending ? 'Completing...' : 'Complete'}
          </Button>
          {completeMutation.error && (
            <p className="text-destructive text-sm">
              {extractApiError(completeMutation.error, 'Failed to complete walkthrough')}
            </p>
          )}
        </div>
      )}
      {(canScheduleWalkthrough || onCancelWalkthrough) && (
        <div role="group" aria-label="Office actions" className="ms-auto flex items-center gap-1">
          {canScheduleWalkthrough && (
            <Button variant="ghost" size="sm" onClick={openReschedule}>
              <CalendarClock />
              Reschedule
            </Button>
          )}
          {onCancelWalkthrough && (
            <Button variant="ghost" size="sm" onClick={onCancelWalkthrough}>Cancel</Button>
          )}
        </div>
      )}
    </div>
  );

  if (isScheduled) {
    return (
      <div className="flex flex-col gap-6 p-6">
        <div>
          <p className="text-muted-foreground mb-3 text-xs font-semibold uppercase">Schedule Info</p>

          {isRescheduling ? (
            <div className="flex flex-col gap-4">
              {scheduleFieldsBlock}
              {conflictBlock}
              <div className="flex items-center gap-2">
                <Button
                  onClick={() => scheduleMutation.mutate(false)}
                  disabled={scheduleBlocked || scheduleMutation.isPending}
                >
                  <Calendar />
                  {scheduleMutation.isPending ? 'Rescheduling...' : 'Save New Time'}
                </Button>
                <Button variant="ghost" onClick={cancelReschedule} disabled={scheduleMutation.isPending}>
                  Cancel
                </Button>
              </div>
              {scheduleErrorBlock}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {scheduleSummary}
              {liveRowActions}
            </div>
          )}
        </div>

        {addVisitSection}
        {visitHistorySection}
        {notesBlock(true)}
      </div>
    );
  }

  // Default: no active visit - show the scheduling form for the next one. Covers
  // both a fresh REQUESTED-only lead and "cancelled with nothing rebooked".
  return (
    <div className="flex flex-col gap-6 p-6">
      {isCancelled && (
        <div className="bg-status-red-subtle flex items-center gap-3 rounded-lg border p-4">
          <Ban className="text-destructive size-5 shrink-0" />
          <div>
            <p className="text-destructive text-sm font-semibold">
              Last visit cancelled {cancelledAt ? formatDateTime(cancelledAt, timezone) : ''}
            </p>
            {cancelledReason && <p className="text-destructive mt-0.5 text-xs">{cancelledReason}</p>}
          </div>
        </div>
      )}

      {visitHistorySection}

      <div>
        <p className="text-muted-foreground mb-3 text-xs font-semibold uppercase">Schedule Info</p>
        {scheduleFieldsBlock}
      </div>

      <div>
        <p className="text-muted-foreground mb-3 text-xs font-semibold uppercase">Notes</p>
        <Textarea
          value={wtNotes}
          onChange={(e) => setWtNotes(e.target.value)}
          rows={4}
          placeholder="Walkthrough notes..."
          disabled={!canPerformWalkthrough}
        />
      </div>

      {canScheduleWalkthrough && (
        <div className="flex flex-col gap-4">
          {conflictBlock}
          <div>
            <Button
              onClick={() => scheduleMutation.mutate(false)}
              disabled={scheduleBlocked || scheduleMutation.isPending}
            >
              <Calendar />
              {scheduleMutation.isPending ? 'Scheduling...' : 'Schedule Walkthrough'}
            </Button>
            {scheduleErrorBlock}
          </div>
        </div>
      )}
    </div>
  );
}
