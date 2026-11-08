import { useId } from 'react';
import { format } from 'date-fns';
import { AlertTriangle } from 'lucide-react';

import { MultiAssigneeSelect } from '@/components/crm/MultiAssigneeSelect';
import type { KnownPerson } from '@/components/crm/knownPeople';
import {
  EVENT_TYPE_META, type ScheduleDraft, type SchedulableEvent,
} from '@/components/schedule/scheduleModel';
import { crewPeopleOf } from '@/components/schedule/eventPeople';
import type { AssignableUser } from '@/lib/api/users';

import { Button } from '@/ui-kit/components/ui/button';
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from '@/ui-kit/components/ui/dialog';
import { Label } from '@/ui-kit/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/ui-kit/components/ui/select';
import { cn } from '@/ui-kit/lib/utils';
import { asWallClock } from '@/lib/schedule-tz';
import {
  durationMinutesOf,
  scheduleTimeFrom,
  startDateOf,
  type ScheduleTimeValue,
} from '@/components/schedule/scheduleTimeValue';

import { ScheduleTimeFields } from '../../_shared/scheduleTimeFields';
import { EM } from '../glyphs';

/**
 * Drop-derived fields glow AI-lavender, and the caption at the bottom of the
 * modal teaches that language. Kept on the `ai` token family rather than moved
 * to the kit's `brand`: in this app `ai` means "a machine filled this in for
 * you", which is exactly the claim the ring is making, and the caption's chip
 * has to match the ring for the sentence to parse.
 */
const AUTO_HIGHLIGHT = 'ring-2 ring-ai';

// NO SUBTITLE UNDER THE LOCKED CREW FIELD, AND THAT IS THE PRODUCT DECISION - not an omission.
// This modal used to print `selfOnlyNote(event.type)` from `scheduleModel.ts` whenever
// `canAssignOthers` was false. The product owner judged the sentence redundant on the lead's
// Walkthrough tab (a field that is locked and has no dropdown already states the rule), and it
// came off all three surfaces that carried it at once rather than leaving the board saying what
// the tab no longer says. `selfOnlyNote` itself is gone with them.
//
// The API is UNCHANGED: `walkthrough.service.ts` PERFORMER_SELF_ONLY and `job.controller.ts`
// ASSIGN_CREW_SELF_ONLY still carry those words on a 403, and a refusal that gets that far is
// still surfaced. What is gone is the promise made BEFORE the post.
// `frontend/src/__tests__/selfOnlyRefusalCopy.test.ts` fails if any of the three surfaces
// restates them.
//
// A `//` block, not `/** */`: a doc comment immediately above a declaration is attached to that
// declaration by every editor and doc tool going, and this is a file note - not documentation of
// `UnifiedDropModalProps`.

export interface UnifiedDropModalProps {
  open: boolean;
  event: SchedulableEvent | null;
  draft: ScheduleDraft | null;
  conflictNote: string | null;
  /** Org-wide assignable roster - labels must resolve beyond the dept-scoped columns. */
  members: AssignableUser[];
  /**
   * `assign User` - whether this viewer may put somebody OTHER than themselves on the card.
   *
   * Passed in rather than read off the ability here: this component still computes nothing, and
   * the page already holds the verdict because the SAME verdict seeded `draft.crew`
   * (`seedCrewForActor` at `openDropModal`). One source, so the field cannot be locked on a
   * different answer from the one it was filled with.
   */
  canAssignOthers: boolean;
  /**
   * The signed-in user as a LABEL, from the same `useAssignUserPermission()` call that produced
   * `canAssignOthers` and seeded `draft.crew`.
   *
   * Load-bearing for exactly the chip this slice adds. A seeded crew is the ACTOR's own id, and
   * neither of `MultiAssigneeSelect`'s two label sources can name them: the roster is `[]` for
   * the whole of a cold load and for ever on a failed request, and the card's own crew rows are
   * empty precisely in the case that made the seed necessary. The chip read `Unknown` where the
   * self-only rule was being stated (PRD story 15) - and now that the sentence is gone, an
   * unnamed chip is the ONLY thing left on screen, so this matters more, not less. Adds nobody
   * to the dropdown - see `components/crm/knownPeople.ts`.
   */
  actorKnownPeople?: readonly KnownPerson[];
  onChange: (patch: Partial<ScheduleDraft>) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * D5: the ONE modal every Unassigned-bucket drop opens, pre-filled by WHERE the
 * card was dropped (draftFromDrop's four targets).
 *
 * Still a pure controlled component. It renders the draft, highlights the
 * drop-derived fields, shows the ADVISORY conflict note, and emits onChange
 * patches / onConfirm / onCancel. It computes nothing and NEVER POSTs - the page
 * owns the draft, the conflict scan and the submit. None of that changed.
 *
 * `MultiAssigneeSelect` is imported unchanged. It is the crew picker the rest of
 * the app uses, it owns its own assignable-users query and eligibility filter,
 * and the kit's `form/combobox` is a static-options Command picker with neither.
 *
 * The kit's `form/formField` is a react-hook-form Controller and this modal has
 * no form library, so each field is a kit Label plus its control - the same
 * shape every prior v2 module landed on.
 */
export function UnifiedDropModal({
  open,
  event,
  draft,
  conflictNote,
  members,
  canAssignOthers,
  actorKnownPeople = [],
  onChange,
  onConfirm,
  onCancel,
}: UnifiedDropModalProps) {
  const uid = useId();
  if (!event || !draft) return null;

  const meta = EVENT_TYPE_META[event.type];

  // The lane member the drop seeded (member-day / member-week put them at crew[0]).
  const autoMember = draft.autoMember ? members.find((m) => m.id === draft.crew[0]) : undefined;

  // The draft still stores start + durationMin (the page's own shape); the shared fields
  // speak start/end, so the two are converted at this seam rather than in the page.
  const timeValue = scheduleTimeFrom(draft.start, draft.durationMin);

  const handleTimeChange = (next: ScheduleTimeValue) => {
    const start = startDateOf(next);
    const durationMin = durationMinutesOf(next);
    // Ignore partial typing AND a backwards range - the draft stores start + duration, so
    // it has no way to HOLD an end before its start; the field snaps back to the last
    // valid value rather than the page storing something it cannot render.
    if (!start || durationMin === null) return;
    const patch: Partial<ScheduleDraft> = {
      // asWallClock re-asserts the brand: `start` is already wall-clock space, so this
      // labels it rather than converting anything.
      start: asWallClock(start),
      durationMin,
    };
    // A field the user touched stops claiming it was auto-filled from the drop.
    if (next.date !== timeValue.date) patch.autoDate = false;
    if (next.startTime !== timeValue.startTime) patch.autoTime = false;
    onChange(patch);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent>
        <DialogHeader>
          {/* The kit's DialogHeader is a flex ROW, so everything textual is one child. */}
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {/* The type chip carries the same accent the calendar paints and the
                  legend advertises for this event type - shared, not restyled. */}
              <span
                className={cn(
                  'rounded-full border-l-[3px] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                  meta.accent,
                  meta.soft,
                  meta.text,
                )}
              >
                {meta.label}
              </span>
              <span className="text-[11px] font-semibold text-subtle-foreground">{event.number}</span>
            </div>
            <DialogTitle>Schedule {EM} {event.title}</DialogTitle>
            <DialogDescription>{event.customer}</DialogDescription>
          </div>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {/* The auto-fill ring lands on each control's own wrapper, which is what a
              picker's `className` addresses (input plus its icon button). */}
          <ScheduleTimeFields
            idPrefix={uid}
            value={timeValue}
            onChange={handleTimeChange}
            dateClassName={cn(draft.autoDate && AUTO_HIGHLIGHT)}
            startTimeClassName={cn(draft.autoTime && AUTO_HIGHLIGHT)}
            allDay={draft.allDay}
            onAllDayChange={(next) => onChange({ allDay: next })}
          />

          <div className="flex flex-col gap-1.5">
            {/* MultiAssigneeSelect exposes no input id - associate via aria-labelledby. */}
            <Label id={`${uid}-crew-label`}>
              Crew
              {autoMember && (
                <span className="ml-1 font-normal text-muted-foreground">
                  {EM} pre-filled from {autoMember.first_name} {autoMember.last_name}&apos;s lane
                </span>
              )}
            </Label>
            <div
              role="group"
              aria-labelledby={`${uid}-crew-label`}
              className={cn('rounded-md', draft.autoMember && AUTO_HIGHLIGHT)}
            >
              <MultiAssigneeSelect
                value={draft.crew}
                onChange={(crew) => onChange({ crew, autoMember: false })}
                purpose="jobCrew"
                placeholder="Add member..."
                enabled={open}
                // Locked for a viewer without `assign User`. Their chip keeps its name but loses
                // its remove control and the combobox will not open - which is the whole of what
                // "may not name others" means on this control, because the page has already put
                // the one person they MAY name into `draft.crew`. Taking themselves off would
                // leave a field they cannot refill.
                disabled={!canAssignOthers}
                // The actor, then whatever crew the dropped card already carried - so BOTH a
                // seeded chip and a pre-filled one stay labelled for a viewer whose roster is
                // scoped to themselves (or has not arrived yet). The actor goes first because
                // `namesById` lets a later entry win, and the card is the truth about the card.
                knownPeople={[
                  ...actorKnownPeople,
                  ...crewPeopleOf(event.type, event.raw).flatMap((p) =>
                    p.id ? [{ id: p.id, first_name: p.first_name, last_name: p.last_name }] : []
                  ),
                ]}
              />
            </div>
          </div>

          {/* ADVISORY only. The backend 409 is the real guard, and this never
              blocks Schedule - hence "you can still proceed". */}
          {conflictNote && (
            <div className="flex items-center gap-1.5 rounded-lg bg-status-red-subtle px-3 py-2 text-xs font-semibold text-destructive">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>{conflictNote} {EM} you can still proceed</span>
            </div>
          )}

          <p className="text-[11px] text-subtle-foreground">
            <span className="rounded bg-ai/10 px-1 font-semibold text-ai">highlighted</span>{' '}
            = auto-filled from where you dropped · the rest is editable
          </p>
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={onConfirm}>
            Schedule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
