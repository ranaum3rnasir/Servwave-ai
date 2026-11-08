import React, { useState } from 'react';
import {
  Briefcase,
  Footprints,
  Repeat,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  AlertCircle,
} from 'lucide-react';

import { Collapse } from '@/components/ui/collapse';
import { TagChips } from '@/components/data/TagChips';
import { getInitials } from '@/lib/utils';
import {
  deriveState,
  EVENT_TYPE_META,
  type EventType,
  type SchedulableEvent,
} from '@/components/schedule/scheduleModel';
import { GRID_EVENT_ID } from '@/components/schedule/dragChannels';
import type { AssignableUser } from '@/lib/api/users';

import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { EmptyState } from '@/ui-kit/components/data/emptyState';

import { EM } from '../glyphs';

// The extensibility seam - a new schedulable type is one more row here.
const BUCKETS: ReadonlyArray<{ type: EventType; label: string; stub?: boolean }> = [
  { type: 'job', label: 'Jobs' },
  { type: 'walkthrough', label: 'Walkthroughs' },
  { type: 'service-plan', label: 'Service Plans', stub: true },
] as const;

const BUCKET_ICONS: Record<EventType, typeof Briefcase> = {
  job: Briefcase,
  walkthrough: Footprints,
  'service-plan': Repeat,
  // Slice 03 - calendar entries never reach the bucket (no unscheduled state; start/end are
  // required columns), so this key is never actually rendered - present only to satisfy the
  // Record<EventType, ...> exhaustiveness check.
  'calendar-entry': CalendarDays,
};

export interface UnassignedBucketsProps {
  /** Unscheduled work (states 1 and 3) - pre-filtered by the page (plan-mode hidden ids). */
  events: SchedulableEvent[];
  /** Org-wide roster - resolves state-3 crew avatars (crews can cross dept filters). */
  members: AssignableUser[];
  /** The page writes the drag channels (job-id / walkthrough-id) + drag ref + ghost image. */
  onDragStartCard: (event: SchedulableEvent, e: React.DragEvent) => void;
  /** A BOARD card (grid-event-id) was dropped on the stack, so run the unschedule flow. */
  onUnscheduleDrop: (boardEventId: string) => void;
  onCardClick: (event: SchedulableEvent) => void;
  /** Plan mode - do not light up, do not accept board-card drops (drafts are ghosts). */
  unscheduleDropDisabled?: boolean;
  /** Read-only roles - cards are not drag sources; clicks (view-only editor) still work. */
  dragDisabled?: boolean;
  /** Drag cleanup seam (body class + page drag ref). Card drag visuals are internal. */
  onDragEndCard?: (event: SchedulableEvent, e: React.DragEvent) => void;
  onCardContextMenu?: (event: SchedulableEvent, e: React.MouseEvent) => void;
  /** The unscheduled-jobs query failed - error body in the Jobs bucket. */
  jobsError?: boolean;
  /** Live Service-Plan visit cards (page-owned pv- cards). Absent renders the stub body. */
  planSlot?: React.ReactNode;
  /** Count badge for a live planSlot (the slot's items are not SchedulableEvents). */
  planCount?: number;
  /**
   * Bucket types this org/user cannot reach - the section is not rendered at all.
   * Hide, do not hint. It is also what makes the remaining empty-state copy
   * honest: "Nothing here - all X are scheduled." is a positively FALSE claim
   * when the query behind X was never allowed to run.
   */
  hiddenTypes?: ReadonlyArray<EventType>;
}

/** Overlapping initials chips for a state-3 crew; unknown ids degrade to '?'. */
function CrewAvatars({ ids, members }: { ids: string[]; members: AssignableUser[] }) {
  if (ids.length === 0) return null;
  return (
    <span className="flex -space-x-1.5">
      {ids.map((id) => {
        const m = members.find((x) => x.id === id);
        return (
          <span
            key={id}
            title={m ? `${m.first_name} ${m.last_name}` : undefined}
            className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full
                       bg-brand text-[8px] font-semibold leading-none text-brand-foreground ring-1 ring-kit-card"
          >
            {getInitials(m ? `${m.first_name} ${m.last_name}` : '')}
          </span>
        );
      })}
    </span>
  );
}

function BucketCard({
  ev,
  members,
  dragging,
  dragDisabled,
  onDragStart,
  onDragEnd,
  onClick,
  onContextMenu,
}: {
  ev: SchedulableEvent;
  members: AssignableUser[];
  dragging: boolean;
  dragDisabled: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: (e: React.DragEvent) => void;
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const meta = EVENT_TYPE_META[ev.type];
  const crewKept = deriveState(ev) === 3;
  return (
    // NOT the kit's Card. Card's call-site appearance ratchet is at its floor and
    // this card's whole visual language is conditional appearance - the type
    // accent bar, plus a drag-in-flight treatment. Every one of those would be a
    // className on Card. The `draggable` + dataTransfer contract is untouched:
    // the page still owns the channel writes through onDragStart.
    <div
      draggable={!dragDisabled}
      onDragStart={dragDisabled ? undefined : onDragStart}
      onDragEnd={dragDisabled ? undefined : onDragEnd}
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={`${dragDisabled ? 'cursor-pointer' : 'cursor-grab'} select-none rounded-lg border bg-kit-card p-2.5 shadow-xs transition-all
        duration-150 border-l-4 ${meta.accent}
        ${dragging ? 'cursor-grabbing scale-[0.97] opacity-40' : 'hover:shadow-md'}`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`text-xs font-bold ${meta.text}`}>{ev.number}</span>
        {crewKept && (
          <Badge variant="softGreen" size="pill" className="ml-auto shrink-0">
            crew kept
          </Badge>
        )}
      </div>
      <p className="mt-0.5 truncate text-xs font-medium">{ev.title}</p>
      <p className="truncate text-[11px] text-muted-foreground">{ev.customer}</p>
      {/* Tag chips. No height gate: this card is content-sized (no height style). */}
      <TagChips tags={ev.tags} max={2} />
      {crewKept && (
        <div className="mt-1 flex items-center gap-1">
          <CrewAvatars ids={ev.crew} members={members} />
          <span className="text-[10px] text-subtle-foreground">re-drop remembers the crew</span>
        </div>
      )}
    </div>
  );
}

/**
 * The extensible Unassigned bucket stack. Three collapsible sections render from
 * one BUCKETS array (a fourth work type slots in additively): Jobs, Walkthroughs
 * and Service Plans. The Service-Plans body is pluggable - the page passes live
 * pv- plan-visit cards via `planSlot`; without a slot it renders the stub.
 *
 * DRAG AND DROP IS UNCHANGED and stays native HTML5. Cards are drag SOURCES (the
 * page supplies the channel writes through onDragStartCard) and the stack ROOT is
 * the D6 drag-to-unschedule drop target: board cards only, gated on
 * `grid-event-id` being present in `dataTransfer.types` and refused outright in
 * plan mode or for a read-only board. dnd-kit emits no `dataTransfer` at all, so
 * migrating this half of the exchange while the calendar and both member boards
 * keep writing dataTransfer would break unschedule outright.
 *
 * `data-testid="unassigned-buckets"` is the drop target's own selector and is
 * carried over verbatim.
 *
 * `Collapse` is imported from the legacy set: the kit ships no collapse
 * primitive (it is on the roll-up's unreached BUILD list) and the section bodies
 * animate open. Recorded as a gap.
 */
export function UnassignedBuckets({
  events,
  members,
  onDragStartCard,
  onUnscheduleDrop,
  onCardClick,
  unscheduleDropDisabled = false,
  dragDisabled = false,
  onDragEndCard,
  onCardContextMenu,
  jobsError = false,
  planSlot,
  planCount = 0,
  hiddenTypes = [],
}: UnassignedBucketsProps) {
  const [open, setOpen] = useState<Record<EventType, boolean>>({
    job: true,
    walkthrough: true,
    'service-plan': true,
    'calendar-entry': true, // never rendered - see BUCKET_ICONS note above
  });
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropHover, setDropHover] = useState(false);

  return (
    <div
      data-testid="unassigned-buckets"
      className={`min-h-0 flex-1 space-y-2 overflow-y-auto p-2 transition-colors
        ${dropHover ? 'bg-brand-subtle ring-2 ring-inset ring-brand' : ''}`}
      onDragOver={(e) => {
        if (unscheduleDropDisabled) return;
        if (!e.dataTransfer.types.includes(GRID_EVENT_ID)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setDropHover(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropHover(false);
      }}
      onDrop={(e) => {
        setDropHover(false);
        if (unscheduleDropDisabled) return;
        if (!e.dataTransfer.types.includes(GRID_EVENT_ID)) return;
        e.preventDefault();
        onUnscheduleDrop(e.dataTransfer.getData(GRID_EVENT_ID));
      }}
    >
      {BUCKETS.filter(({ type }) => !hiddenTypes.includes(type)).map(({ type, label, stub }) => {
        const items = events.filter((e) => e.type === type); // FIFO - array order, no resort
        const meta = EVENT_TYPE_META[type];
        const Icon = BUCKET_ICONS[type];
        const isOpen = open[type];
        const live = type === 'service-plan' && planSlot !== undefined;
        const count = live ? planCount : items.length;
        return (
          <section key={type} className="rounded-lg border bg-kit-card">
            {/* The disclosure row was a raw button element; it is a kit Button
                now, keeping aria-expanded. The raw-tag ratchet is at its floor,
                so a new file may not add one. */}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-expanded={isOpen}
              className="h-auto w-full justify-start gap-2 rounded-b-none px-2.5 py-2 text-left font-normal"
              onClick={() => setOpen((o) => ({ ...o, [type]: !o[type] }))}
            >
              <Icon className={`h-3.5 w-3.5 shrink-0 ${meta.text}`} />
              <span className="text-xs font-semibold">{label}</span>
              {stub && !live && (
                <Badge variant="softPurple" size="pill">soon</Badge>
              )}
              <span className="ml-auto text-[11px] font-medium text-muted-foreground">{count}</span>
              {isOpen ? (
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              )}
            </Button>
            <Collapse open={isOpen}>
              <div className="space-y-1.5 px-2 pb-2">
                {live ? (
                  planSlot
                ) : jobsError && type === 'job' ? (
                  <div className="flex flex-col items-center justify-center py-4 text-center">
                    <AlertCircle className="mb-1.5 h-5 w-5 text-destructive" />
                    <p className="text-[11px] text-muted-foreground">Failed to load jobs</p>
                  </div>
                ) : items.length === 0 ? (
                  <EmptyState
                    title={stub ? 'Recurring visits land here (Step 9E)' : `Nothing here - all ${label} are scheduled.`}
                  />
                ) : (
                  items.map((ev) => (
                    <BucketCard
                      key={ev.boardId}
                      ev={ev}
                      members={members}
                      dragging={draggingId === ev.boardId}
                      dragDisabled={dragDisabled}
                      onDragStart={(e) => {
                        setDraggingId(ev.boardId);
                        onDragStartCard(ev, e);
                      }}
                      onDragEnd={(e) => {
                        setDraggingId(null);
                        onDragEndCard?.(ev, e);
                      }}
                      onClick={() => onCardClick(ev)}
                      onContextMenu={onCardContextMenu ? (e) => onCardContextMenu(ev, e) : undefined}
                    />
                  ))
                )}
              </div>
            </Collapse>
          </section>
        );
      })}
      {/* The hint only renders while the stack actually ACCEPTS board-card drops. */}
      {!dragDisabled && !unscheduleDropDisabled && (
        <p className="px-1 pt-1 text-[10px] leading-snug text-subtle-foreground">
          Drag a board card back here to <strong>unschedule</strong> {EM} the crew is kept.
        </p>
      )}
    </div>
  );
}
