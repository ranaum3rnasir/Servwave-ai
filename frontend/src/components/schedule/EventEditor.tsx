// TG12 — the event editor: the ONLY per-person crew path (drags = whole-lane swaps;
// the D5 modal = initial scheduling). Opens from every board / bucket card click.
// PURE controlled dialog (UnifiedDropModal's purity contract): it stages crew/time
// drafts locally and EMITS onSaveCrew / onSaveTime / onUnschedule / onClose — it never
// POSTs; the PAGE owns mutations, confirms, and toasts. Owner is OFF-BOARD: a read-only
// field here, never an editable lane.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import { CalendarX2, CheckCircle2, ExternalLink, Phone, MessageSquare } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { EmptyState } from '@/components/ui/empty-state';
import { MultiAssigneeSelect } from '@/components/crm/MultiAssigneeSelect';
import { cn } from '@/lib/utils';
import {
  EVENT_TYPE_META,
  STATE_META,
  deriveState,
  type SchedulableEvent,
} from './scheduleModel';
import { crewPeopleById, ownerOf, fullName } from './eventPeople';
import type { AssignableUser } from '@/lib/api/users';
import { ScheduleTimeFields } from './ScheduleTimeFields';
import {
  durationMinutesOf,
  scheduleTimeFrom,
  startDateOf,
  type ScheduleTimeValue,
} from './scheduleTimeValue';
import { asWallClock, type WallClock } from '@/lib/schedule-tz';

/** REPLACE semantics — order-insensitive equality ([] is a valid crew). */
const sameCrew = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((id) => b.includes(id));

/** #370 — detail-page URL for an event: walkthroughs live on the lead, jobs on /jobs/:id. */
export function detailUrlOf(event: SchedulableEvent): string {
  return event.type === 'walkthrough'
    ? `/leads/${event.raw.id as string}?tab=walkthrough`
    : `/jobs/${event.parentId}`;
}

/** #370 — inline tel:/sms: icon links; renders nothing when there is no phone. */
function ContactLinks({ phone, label }: { phone?: string | null; label: string }) {
  if (!phone?.trim()) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      <a href={`tel:${phone}`} aria-label={`Call ${label}`} className="text-text-soft hover:text-primary">
        <Phone className="h-3.5 w-3.5" />
      </a>
      <a href={`sms:${phone}`} aria-label={`Text ${label}`} className="text-text-soft hover:text-primary">
        <MessageSquare className="h-3.5 w-3.5" />
      </a>
    </span>
  );
}

/**
 * SAVED crew (event.crew, not the draft) resolved to name + phone for contact rows.
 *
 * Mirrors `pages/v2/schedule/components/eventEditor.tsx`, which is the ROUTED editor -
 * this v1 file is imported by nothing but its own test. Both read the contact detail off
 * the EVENT payload, never off the roster: the roster answers "who may I ADD" and is gated
 * on `assign User`, and `AssignableUser` no longer carries `phone` at all.
 */
function crewContactRowsOf(event: SchedulableEvent, members: AssignableUser[]) {
  const payloadById = crewPeopleById(event.type, event.raw);
  return event.crew.map((id) => {
    const p = payloadById.get(id);
    const m = members.find((u) => u.id === id);
    return {
      id,
      name: fullName(p) ?? (m ? `${m.first_name} ${m.last_name}` : null) ?? 'Unknown',
      phone: p?.phone ?? null,
    };
  });
}

export interface EventEditorProps {
  open: boolean;
  event: SchedulableEvent | null;
  /** Org-wide assignable roster — names must resolve beyond the dept-scoped columns. */
  members: AssignableUser[];
  /** Role-gating consumes this (TG13): crew as text, no save buttons, no unschedule. */
  readOnly?: boolean;
  /** Page-computed status gate (same logic as the drag-to-unschedule pre-gate). */
  canUnschedule: boolean;
  /** Why, when canUnschedule=false (timed events only). */
  unscheduleDisabledReason?: string;
  /** Job in an active status + caller may manage it — enables the "Mark Complete" action. */
  canComplete?: boolean;
  onSaveCrew: (crew: string[]) => void;
  onSaveTime: (start: WallClock, durationMin: number) => void;
  /** The page owns the confirm dialog + the unschedule POST. */
  onUnschedule: () => void;
  /** The page owns the completion dialog + the /complete POST. */
  onComplete?: () => void;
  onClose: () => void;
}

export function EventEditor({
  open,
  event,
  members,
  readOnly = false,
  canUnschedule,
  unscheduleDisabledReason,
  canComplete = false,
  onSaveCrew,
  onSaveTime,
  onUnschedule,
  onComplete,
  onClose,
}: EventEditorProps) {
  if (!event) return null;
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        {/* Keyed body: drafts reset whenever the dialog reopens (Radix unmounts closed
            content) or a different event opens — no sync effects needed. */}
        <EditorBody
          key={event.boardId}
          event={event}
          members={members}
          readOnly={readOnly}
          canUnschedule={canUnschedule}
          unscheduleDisabledReason={unscheduleDisabledReason}
          canComplete={canComplete}
          onSaveCrew={onSaveCrew}
          onSaveTime={onSaveTime}
          onUnschedule={onUnschedule}
          onComplete={onComplete}
          onClose={onClose}
        />
      </DialogContent>
    </Dialog>
  );
}

function EditorBody({
  event,
  members,
  readOnly,
  canUnschedule,
  unscheduleDisabledReason,
  canComplete,
  onSaveCrew,
  onSaveTime,
  onUnschedule,
  onComplete,
  onClose,
}: Omit<EventEditorProps, 'open' | 'event' | 'readOnly'> & {
  event: SchedulableEvent;
  readOnly: boolean;
}) {
  const navigate = useNavigate();

  const meta = EVENT_TYPE_META[event.type];
  const state = deriveState(event);
  const stateMeta = STATE_META[state];
  const ownerName = fullName(ownerOf(event.type, event.raw));

  // ── Crew draft (REPLACE semantics; [] allowed — crew ⟂ schedule) ──
  const [draftCrew, setDraftCrew] = useState<string[]>(() => [...event.crew]);
  const crewDirty = !sameCrew(draftCrew, event.crew);

  // ── Time draft (timed events only) ──
  // One value for the whole start/end/duration triple — the same shape every other
  // scheduling surface edits (ScheduleTimeFields). `onSaveTime` still speaks start +
  // duration, so the page's mutation is untouched: the duration is DERIVED here.
  const originalDuration =
    event.start && event.end
      ? Math.round((event.end.getTime() - event.start.getTime()) / 60_000)
      : null;
  const originalTime = event.start ? scheduleTimeFrom(event.start, originalDuration ?? 0) : null;
  const [draftTime, setDraftTime] = useState<ScheduleTimeValue | null>(() => originalTime);
  const draftStart = draftTime ? startDateOf(draftTime) : null;
  const draftDuration = draftTime ? durationMinutesOf(draftTime) : null;
  const timeDirty =
    originalTime !== null &&
    draftTime !== null &&
    draftStart !== null &&
    draftDuration !== null &&
    (draftTime.date !== originalTime.date ||
      draftTime.startTime !== originalTime.startTime ||
      draftTime.endDate !== originalTime.endDate ||
      draftTime.endTime !== originalTime.endTime);

  const detailUrl = detailUrlOf(event);
  const customerPhone = (event.raw.customer as { phone?: string | null } | undefined)?.phone;
  const crewRows = crewContactRowsOf(event, members);

  return (
    <>
      {/* #370 — open-full-page icon beside the built-in close X (ui/dialog.tsx: right-4 top-4). */}
      <Button
        variant="ghost"
        size="icon"
        aria-label="Open full page"
        className="absolute right-12 top-3 h-7 w-7 text-text-soft hover:text-primary"
        onClick={() => {
          onClose();
          navigate(detailUrl);
        }}
      >
        <ExternalLink className="h-4 w-4" />
      </Button>
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
        <DialogTitle>{event.title}</DialogTitle>
        <DialogDescription className="flex items-center gap-2">
          {event.customer}
          <ContactLinks phone={customerPhone} label={event.customer} />
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        {/* §3.8 state chip — where the event lives and why */}
        <div className="flex items-center gap-2 rounded-lg bg-background-light px-2.5 py-1.5 text-[11px]">
          <span className="font-bold text-text-soft">{stateMeta.label}</span>
          <span className="text-text-secondary">{stateMeta.hint}</span>
        </div>

        {/* Owner is OFF-BOARD — a field, never a lane (hidden when there is none) */}
        {ownerName && (
          <div className="flex items-center justify-between rounded-lg border border-border-soft px-2.5 py-1.5">
            <span className="text-[10px] font-bold uppercase tracking-wide text-text-soft">
              Owner (off-board)
            </span>
            <span className="text-xs font-semibold text-text-secondary">{ownerName}</span>
          </div>
        )}

        {/* Crew — THE per-person edit path. Explicit save; drags never do this. */}
        <div>
          <Label>Crew (performers)</Label>
          {readOnly ? (
            crewRows.length === 0 ? (
              <EmptyState density="flush" title="No crew" className="mt-1" />
            ) : (
              <div className="mt-1 space-y-1">
                {crewRows.map((r) => (
                  <p key={r.id} className="flex items-center gap-2 text-sm text-text-secondary">
                    {r.name}
                    <ContactLinks phone={r.phone} label={r.name} />
                  </p>
                ))}
              </div>
            )
          ) : (
            <>
              <div className="mt-1">
                <MultiAssigneeSelect
                  value={draftCrew}
                  onChange={setDraftCrew}
                  purpose="jobCrew"
                  placeholder="Add member..."
                />
              </div>
              {crewDirty && (
                <div className="mt-2 flex justify-end">
                  <Button size="sm" variant="solid" tone="business" onClick={() => onSaveCrew(draftCrew)}>
                    Save crew
                  </Button>
                </div>
              )}
              {/* #370 — contact rows for the SAVED crew members that have a phone. */}
              {crewRows.some((r) => r.phone) && (
                <div className="mt-2 space-y-1">
                  {crewRows.filter((r) => r.phone).map((r) => (
                    <p key={r.id} className="flex items-center gap-2 text-xs text-text-secondary">
                      {r.name}
                      <ContactLinks phone={r.phone} label={r.name} />
                    </p>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* Schedule — time edits for timed events; unscheduled events state it plainly */}
        {event.start && draftTime ? (
          <div>
            <Label>Schedule</Label>
            {readOnly ? (
              <p className="mt-1 text-sm text-text-secondary">
                {format(event.start, 'EEE, MMM d · h:mm a')}
                {event.end ? ` – ${format(event.end, 'h:mm a')}` : ''}
              </p>
            ) : (
              <>
                <ScheduleTimeFields
                  className="mt-1"
                  value={draftTime}
                  onChange={setDraftTime}
                />
                {timeDirty && draftStart && draftDuration !== null && (
                  <div className="mt-2 flex justify-end">
                    <Button
                      size="sm"
                      variant="solid" tone="business"
                      onClick={() => onSaveTime(asWallClock(draftStart), draftDuration)}
                    >
                      Save time
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
          <p className="text-sm italic text-text-secondary">Unscheduled — {stateMeta.hint}</p>
        )}

        {/* Mark Complete — close out an active job directly from the board (jobs only). */}
        {event.type === 'job' && canComplete && !readOnly && onComplete && (
          <div className="border-t border-border pt-3">
            <Button size="sm" variant="solid" tone="business" className="w-full" onClick={onComplete}>
              <CheckCircle2 className="h-3.5 w-3.5" /> Mark Complete
            </Button>
          </div>
        )}

        {/* Footer: unschedule (timed only — clears TIME, keeps crew) + detail nav */}
        <div className="flex items-start justify-between gap-3 border-t border-border pt-3">
          <div className="min-w-0">
            {event.start && !readOnly && (
              <>
                <Button
                  size="sm"
                  variant="ghost" tone="danger"
                  disabled={!canUnschedule}
                  onClick={onUnschedule}
                >
                  <CalendarX2 className="h-3.5 w-3.5" /> Move to Unscheduled
                </Button>
                {!canUnschedule && unscheduleDisabledReason && (
                  <p className="mt-1 text-[11px] text-text-soft">{unscheduleDisabledReason}</p>
                )}
              </>
            )}
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 text-primary hover:text-primary"
            onClick={() => {
              onClose();
              navigate(detailUrl);
            }}
          >
            View details →
          </Button>
        </div>
      </div>
    </>
  );
}
