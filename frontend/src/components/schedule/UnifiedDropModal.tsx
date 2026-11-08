// TG9 — D5: the ONE modal every Unassigned-bucket drop opens, pre-filled by WHERE the
// card was dropped (draftFromDrop's four targets). Pure controlled component: renders the
// draft, highlights drop-derived fields (`ring-ai`), shows the ADVISORY conflict note, and
// emits onChange patches / onConfirm / onCancel. It computes nothing and never POSTs —
// the page owns the draft, the conflict scan, and the submit.
import { useId } from 'react';
import { AlertTriangle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { MultiAssigneeSelect } from '@/components/crm/MultiAssigneeSelect';
import { cn } from '@/lib/utils';
import { EVENT_TYPE_META, type ScheduleDraft, type SchedulableEvent } from './scheduleModel';
import type { AssignableUser } from '@/lib/api/users';
import { ScheduleTimeFields } from './ScheduleTimeFields';
import {
  durationMinutesOf,
  scheduleTimeFrom,
  startDateOf,
  type ScheduleTimeValue,
} from './scheduleTimeValue';
import { asWallClock } from '@/lib/schedule-tz';

/** Drop-derived fields glow AI-lavender — the caption below explains the language. */
const AUTO_HIGHLIGHT = 'ring-2 ring-ai';

export interface UnifiedDropModalProps {
  open: boolean;
  event: SchedulableEvent | null;
  draft: ScheduleDraft | null;
  conflictNote: string | null;
  /** Org-wide assignable roster — labels must resolve beyond the dept-scoped columns. */
  members: AssignableUser[];
  onChange: (patch: Partial<ScheduleDraft>) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function UnifiedDropModal({
  open,
  event,
  draft,
  conflictNote,
  members,
  onChange,
  onConfirm,
  onCancel,
}: UnifiedDropModalProps) {
  const uid = useId();
  if (!event || !draft) return null;

  const meta = EVENT_TYPE_META[event.type];

  // The lane member the drop seeded (member-day / member-week targets put them at crew[0]).
  const autoMember = draft.autoMember ? members.find((m) => m.id === draft.crew[0]) : undefined;

  // The draft still stores start + durationMin (the page's own shape); the shared fields
  // speak start/end, so the two are converted at this seam rather than in the page.
  const timeValue = scheduleTimeFrom(draft.start, draft.durationMin);

  const handleTimeChange = (next: ScheduleTimeValue) => {
    const start = startDateOf(next);
    const durationMin = durationMinutesOf(next);
    // Ignore partial typing AND a backwards range — the draft stores start + duration, so
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
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2">
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
            <span className="text-[11px] font-semibold text-text-soft">{event.number}</span>
          </div>
          <DialogTitle>Schedule — {event.title}</DialogTitle>
          <DialogDescription>{event.customer}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* FormField's default gap (1.5) is used deliberately inside ScheduleTimeFields,
              not overridden. Measured in Chromium at 1200px against the compiled project
              CSS, not reasoned: the pre-conversion seam was NOT the 4px `mt-1`, because
              `<label>` is inline in block flow and its line box is governed by the
              container's 24px strut - the real label-bottom-to-control-top gap was 7px. As
              a flex item the label is blockified and its own `leading-none` applies (14px),
              so gap={1} would land a 4px seam and the default lands 6px. */}
          <ScheduleTimeFields
            value={timeValue}
            onChange={handleTimeChange}
            dateClassName={cn(draft.autoDate && AUTO_HIGHLIGHT)}
            startTimeClassName={cn(draft.autoTime && AUTO_HIGHLIGHT)}
          />

          <div>
            {/* MultiAssigneeSelect exposes no input id — associate via aria-labelledby. */}
            <Label id={`${uid}-crew-label`}>
              Crew
              {autoMember && (
                <span className="ml-1 font-normal text-text-secondary">
                  — pre-filled from {autoMember.first_name} {autoMember.last_name}&apos;s lane
                </span>
              )}
            </Label>
            <div
              role="group"
              aria-labelledby={`${uid}-crew-label`}
              className={cn('mt-1 rounded-md', draft.autoMember && AUTO_HIGHLIGHT)}
            >
              <MultiAssigneeSelect
                value={draft.crew}
                onChange={(crew) => onChange({ crew, autoMember: false })}
                purpose="jobCrew"
                placeholder="Add member..."
                enabled={open}
              />
            </div>
          </div>

          {conflictNote && (
            <div className="flex items-center gap-1.5 rounded-lg bg-danger/10 px-3 py-2 text-xs font-semibold text-danger">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>{conflictNote} — you can still proceed</span>
            </div>
          )}

          <p className="text-[11px] text-text-soft">
            <span className="rounded bg-ai/10 px-1 font-semibold text-ai">highlighted</span>{' '}
            = auto-filled from where you dropped · the rest is editable
          </p>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button variant="solid" tone="business" onClick={onConfirm}>
              Schedule
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
