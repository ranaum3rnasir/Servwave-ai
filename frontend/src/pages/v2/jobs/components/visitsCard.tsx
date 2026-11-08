/**
 * Multi-visit S2: the job's visit list, v2 chrome.
 *
 * The only renderer of the job's visits. It consumes `lib/useJobVisits` and `lib/visits` rather
 * than deriving rows itself, so the lead surfaces that share those modules cannot drift away from
 * it (#1551). A v1 twin at components/jobs/VisitsCard.tsx used to render the same list; it went
 * with the v1 job page.
 *
 * Times render through `formatInstant` on the ORG clock, never `toLocaleString(undefined, ...)`:
 * the hero tile directly above shows the same instants, and a browser-zone render would put two
 * contradictory times on one screen for every non-Eastern viewer.
 */
import { useState } from 'react';

import { Button } from '@/ui-kit/components/ui/button';
import { ConfirmDialog } from '@/ui-kit/components/ui/confirmDialog';
import { Label } from '@/ui-kit/components/ui/label';
import { Textarea } from '@/ui-kit/components/ui/textarea';

import { formatInstant, useScheduleTimezone } from '@/lib/schedule-tz';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/ui-kit/components/ui/dropdownMenu';

import { crewMemberName, isLiveVisit, nextVisitStep, visitMilestoneStamps, type JobVisitRow, type VisitVerb } from '@/lib/visits';
import { useVisitLifecycle } from '@/lib/useVisitLifecycle';
import { STATUS_REGISTRY, STATUS_INTENT_FILL } from '@/design-system/status-registry';

import { VisitLocationLine } from '../../_shared/visitLocationLine';

import { VisitScheduleDialog } from './visitScheduleDialog';

/** With the year: this list sits beside a hero showing the same instants, and a visit list that
 *  spans a year boundary is exactly the case where "Sep 5" alone is ambiguous. */
const VISIT_FORMAT: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
};

/** A milestone stamp sits under the scheduled line above it, which already carries the year. */
const STAMP_FORMAT: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
};

/**
 * S4: the visit's REAL status, read through the shared registry.
 *
 * This card previously collapsed every live status to the word "Scheduled" - so from S4, when a
 * job visit can actually reach EN_ROUTE / ON_SITE / IN_PROGRESS, a crew standing in the customer's
 * driveway read as a booking nobody had left for yet. The registry's `job` block already carries a
 * label and an intent for all six VisitStatus values, so this is a lookup rather than a fourth
 * copy of the mapping.
 */
function statusLabel(v: JobVisitRow): string {
  return STATUS_REGISTRY.job[v.status]?.label ?? v.status;
}

function statusDotClass(status: string): string {
  const intent = STATUS_REGISTRY.job[status]?.intent;
  return intent ? STATUS_INTENT_FILL[intent] : 'bg-muted';
}

export interface VisitsCardProps {
  jobId: string;
  visits: JobVisitRow[];
  isLoading?: boolean;
  /** False for a principal without `reschedule Job` - the same gate the API enforces. */
  canSchedule?: boolean;
  /**
   * S5's rule, finally enforced HERE too: the list being empty says nothing when the fetch
   * failed. useJobVisits has exposed `visitsUnknown` since S5 and the lifecycle rail consumes
   * it, but this card rendered "No visits booked yet." for an errored query - a definitive
   * claim it had no evidence for, with no recovery short of a full reload (the visits query
   * lives at page level, so switching tabs never remounts it, and refetchOnWindowFocus is off).
   */
  visitsUnknown?: boolean;
  /** Refetch for the unknown state's Retry - the page owns the query, so it supplies the verb. */
  onRetry?: () => void;
  /**
   * S3: naming crew needs `assign Job`, which the two visit routes now check PER INSTANCE on top
   * of their subject-level `reschedule Job` gate. Gates the crew picker inside the dialog only -
   * never the dialog, never Save. Defaults true so every other caller is unaffected.
   */
  canAssignCrew?: boolean;
  /**
   * S4 (D7a): which lifecycle verbs may this principal drive? One flag PER VERB, because the four
   * routes are gated on three different abilities - see VISIT_ACTIONS above, and for the limit
   * none of them can express. Absent means no, so a caller that passes nothing offers nothing.
   */
  visitAbilities?: Partial<Record<VisitVerb, boolean>>;
}

export function VisitsCard({
  jobId, visits, isLoading, canSchedule = true, canAssignCrew = true, visitAbilities = {},
  visitsUnknown = false, onRetry,
}: VisitsCardProps) {
  const tz = useScheduleTimezone();
  const lifecycle = useVisitLifecycle(jobId);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<JobVisitRow | null>(null);
  // D19: the trip being called off, and the reason the route requires. Held here rather than in a
  // dialog of its own so the card stays the single place a visit's controls live.
  const [cancelling, setCancelling] = useState<JobVisitRow | null>(null);
  const [cancelReason, setCancelReason] = useState('');

  const dialogs = canSchedule && (
    <>
      {/* Keyed so the dialog REMOUNTS each time it opens: its four-field value is seeded once at
          mount, which keeps the seeding out of an effect. */}
      <VisitScheduleDialog
        key={addOpen ? 'add-open' : 'add-closed'}
        open={addOpen} onOpenChange={setAddOpen}
        jobId={jobId} canAssignCrew={canAssignCrew}
      />
      <VisitScheduleDialog
        key={editing ? `edit-${editing.id}` : 'edit-closed'}
        open={editing !== null}
        onOpenChange={(next) => { if (!next) setEditing(null); }}
        jobId={jobId} canAssignCrew={canAssignCrew}
        visit={editing}
      />
      {/* D19: the reason box rides the app's OWN confirm primitive - the same one every other
          destructive flow uses - rather than a fourth hand-rolled modal. Confirm stays disabled
          until a reason exists, because cancelVisitSchema requires one and a blank POST would
          come back 400 with nothing on screen to explain it. */}
      <ConfirmDialog
        open={cancelling !== null}
        onOpenChange={(next) => { if (!next) { setCancelling(null); setCancelReason(''); } }}
        destructive
        title={`Cancel visit ${cancelling?.visit_seq ?? ''}?`}
        description="The visit stays on the list as cancelled and keeps its number. The job itself is not cancelled."
        confirmLabel="Cancel visit"
        cancelLabel="Keep visit"
        isPending={lifecycle.isPending}
        confirmDisabled={cancelReason.trim().length === 0}
        onConfirm={() => {
          if (!cancelling || cancelReason.trim().length === 0) return;
          lifecycle.mutate(
            { visitId: cancelling.id, action: 'cancel', cancelled_reason: cancelReason.trim() },
            { onSuccess: () => { setCancelling(null); setCancelReason(''); } },
          );
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="visit-cancel-reason">Reason</Label>
          <Textarea
            id="visit-cancel-reason"
            rows={3}
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
            placeholder="Why is this visit being called off?"
          />
        </div>
      </ConfirmDialog>
    </>
  );

  const header = canSchedule && (
    <div className="flex justify-end">
      <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>Add visit</Button>
    </div>
  );

  if (isLoading) return <p className="text-muted-foreground text-sm">Loading visits...</p>;

  // Not loading and still unknown = the fetch failed. Say so instead of claiming the job
  // holds no trips, and offer the retry the page otherwise has no way to reach.
  if (visitsUnknown) {
    return (
      <div className="flex items-center gap-3">
        <p className="text-muted-foreground text-sm">Couldn&apos;t load this job&apos;s visits.</p>
        {onRetry && (
          <Button size="sm" variant="outline" onClick={onRetry}>Retry</Button>
        )}
      </div>
    );
  }

  if (visits.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        {header}
        <p className="text-muted-foreground text-sm">No visits booked yet.</p>
        {dialogs}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
    {header}
    <ul className="flex flex-col gap-2">
      {visits.map((v) => (
        <li key={v.id} className="flex flex-wrap items-start gap-2.5 rounded-lg border p-3 text-sm sm:flex-nowrap">
          <span
            className={['mt-1.5 inline-block size-1.5 shrink-0 rounded-full', statusDotClass(v.status)].join(' ')}
          />
          <div className="min-w-0 flex-1">
            {/* Not a heading: the raw-tag ratchet sits at its floor, and this is a list row
                label rather than a document section. */}
            <p className="font-medium">Visit {v.visit_seq}</p>
            <p className={isLiveVisit(v) ? '' : 'text-muted-foreground'}>
              {statusLabel(v)}{' '}
              {v.is_all_day
                ? `${formatInstant(v.scheduled_at, tz, { month: 'short', day: 'numeric', year: 'numeric' })} (all day)`
                : formatInstant(v.scheduled_at, tz, VISIT_FORMAT)}
            </p>
            {/* S3 (D6): who is on THIS trip. Named rather than counted - the dispatcher's
                question is "who is going", and the job-level Team card cannot answer it per
                visit, because from S3 that card shows the derived UNION across every visit. */}
            {/* S4: what actually HAPPENED to this trip, on the ORG clock through formatInstant -
                never toLocaleString, which would render in the viewer's zone two lines from a
                hero rendering the same job on the org's. Slice 09: every reached milestone, in
                order, with a SKIPPED one struck through and said so (story 23) - a skip shares
                its instant with the tap that skipped it, so an unmarked line would read as the
                crew leaving and arriving in the same second. */}
            {visitMilestoneStamps(v).length > 0 && (
              <p className="text-muted-foreground mt-0.5 flex flex-wrap gap-x-2 text-xs">
                {visitMilestoneStamps(v).map((stamp) => (
                  <span key={stamp.milestone} className={stamp.skipped ? 'italic line-through' : ''}>
                    {stamp.label}{stamp.skipped ? ' (skipped)' : ''} {formatInstant(stamp.at, tz, STAMP_FORMAT)}
                  </span>
                ))}
              </p>
            )}
            {/* Slice 6: where THIS trip is, when it is not at the job's service address. Above
                the muted detail lines and unmuted, because it is the one thing on this row a
                technician has to see before leaving - and absent entirely for the majority of
                trips, which are at the service address and read exactly as they always have. */}
            <VisitLocationLine label={v.location_label} />
            {/* No "customer notified" line off `customer_email_sent_at`: that stamp is a dispatch
                guard (an announcement occurrence happened), not evidence the customer received
                anything. The automation ledger is the receipt (scheduling-notifications PRD). */}
            {(v.assignees?.length ?? 0) > 0 && (
              <p className="text-muted-foreground mt-0.5 text-xs">
                {v.assignees!.map(crewMemberName).filter(Boolean).join(', ')}
              </p>
            )}
            {v.status === 'CANCELLED' && v.cancelled_reason && (
              <p className="text-muted-foreground mt-0.5 text-xs">{v.cancelled_reason}</p>
            )}
          </div>
          {/* Slice 09: the crew's step on the left, the OFFICE's actions on the right, as two
              labelled groups rather than one run of equal ghost buttons (story 21: office
              actions and field actions are not confused). Under a narrow viewport the whole
              container drops below the visit text as a full-width line, the step at its start
              and the office group at its end, rather than pushing the text to a character per
              line and the office group past the card edge; from sm it sits beside the text as
              before. */}
          {isLiveVisit(v) && (
            <div className="flex basis-full shrink-0 flex-wrap items-center justify-between gap-2 sm:basis-auto sm:justify-end">
              {/* ONE primary button for the next milestone this viewer may perform, and the
                  later permitted milestones behind "Skip to" (story 19: a forgotten "On the way"
                  tap must never block "Start work"). Each verb still rides its own route's
                  permission through `visitAbilities`, so a verb the role lacks is absent from
                  both the button and the menu. */}
              {(() => {
                const step = nextVisitStep(v.status, visitAbilities);
                if (!step.primary) return null;
                return (
                  <div role="group" aria-label="Next step" className="flex items-center gap-1">
                    <Button
                      size="sm"
                      disabled={lifecycle.isPending}
                      onClick={() => lifecycle.mutate({ visitId: v.id, action: step.primary!.action })}
                    >
                      {step.primary.label}
                    </Button>
                    {step.skipTo.length > 0 && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button size="sm" variant="ghost" disabled={lifecycle.isPending}>Skip to</Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {step.skipTo.map((a) => (
                            <DropdownMenuItem
                              key={a.action}
                              onSelect={() => lifecycle.mutate({ visitId: v.id, action: a.action })}
                            >
                              {a.label}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                );
              })()}
              {/* Only a still-coming trip can be moved or called off. A completed or cancelled
                  row is history (D19) - it is kept and readable, never edited. Both gate on
                  canSchedule - the `reschedule Job` ability - because that is what PATCH and
                  POST .../cancel are gated on (job.routes.ts), NOT on the crew verbs the step
                  to the left rides. */}
              {canSchedule && (
                <div role="group" aria-label="Office actions" className="ms-auto flex items-center gap-1 border-s ps-2">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(v)}>Reschedule</Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => { setCancelReason(''); setCancelling(v); }}
                  >
                    Cancel
                  </Button>
                </div>
              )}
            </div>
          )}
        </li>
      ))}
    </ul>
    {dialogs}
    </div>
  );
}

export default VisitsCard;
