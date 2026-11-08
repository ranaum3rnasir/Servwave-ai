// TG11 (Q8) — the extensible Unassigned bucket stack. Three collapsible sections render
// from one BUCKETS array (a 4th work type slots in additively): Jobs, Walkthroughs, and
// Service Plans. The Service-Plans body is pluggable — the page passes live pv- plan-visit
// cards via `planSlot` (Service Plans PR A); without a slot it renders the Step 9E stub.
// Cards are drag SOURCES (the page supplies the channel writes via onDragStartCard) and the
// stack root is the D6 drag-to-UNSCHEDULE drop target: board cards only (grid-event-id),
// gated off in plan mode. A bucket type the viewer cannot reach at all is dropped from the
// array via `hiddenTypes` rather than rendered empty. ServWave tokens only.
import React, { useEffect, useRef, useState } from 'react';
import {
  Briefcase,
  Footprints,
  Repeat,
  ChevronDown,
  ChevronRight,
  AlertCircle,
} from 'lucide-react';
import { Collapse } from '@/components/ui/collapse';
import { EmptyState } from '@/components/ui/empty-state';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { getInitials } from '@/lib/utils';
import {
  deriveState,
  EVENT_TYPE_META,
  type EventType,
  type SchedulableEvent,
} from './scheduleModel';
import { GRID_EVENT_ID } from './dragChannels';
import type { AssignableUser } from '@/lib/api/users';
import { TagChips } from '@/components/data/TagChips';

// The extensibility seam — a new schedulable type is one more row here.
const BUCKETS: ReadonlyArray<{ type: EventType; label: string; stub?: boolean }> = [
  { type: 'job', label: 'Jobs' },
  { type: 'walkthrough', label: 'Walkthroughs' },
  { type: 'service-plan', label: 'Service Plans', stub: true },
] as const;

const BUCKET_ICONS: Record<EventType, typeof Briefcase> = {
  job: Briefcase,
  walkthrough: Footprints,
  'service-plan': Repeat,
  // Dead v1 fork (no importer outside its own test) - added only to satisfy
  // Record<EventType, ...> after slice 03 widened EventType. Not wired into any live surface.
  'calendar-entry': Repeat,
};

export interface UnassignedBucketsProps {
  /** Unscheduled work (states 1 & 3) — pre-filtered by the page (plan-mode hidden ids). */
  events: SchedulableEvent[];
  /** Org-wide roster — resolves state-3 crew avatars (crews can cross dept filters). */
  members: AssignableUser[];
  /** The page writes the drag channels (job-id / walkthrough-id) + drag ref + ghost image. */
  onDragStartCard: (event: SchedulableEvent, e: React.DragEvent) => void;
  /** A BOARD card (grid-event-id) was dropped on the stack → unschedule flow. */
  onUnscheduleDrop: (boardEventId: string) => void;
  onCardClick: (event: SchedulableEvent) => void;
  /** Plan mode — don't light up, don't accept board-card drops (drafts are ghosts, not writes). */
  unscheduleDropDisabled?: boolean;
  /** D9 read-only roles (TG13) — cards aren't drag sources; clicks (view-only editor) still work. */
  dragDisabled?: boolean;
  /** Drag cleanup seam (body class + page drag ref). Card drag visuals are internal. */
  onDragEndCard?: (event: SchedulableEvent, e: React.DragEvent) => void;
  onCardContextMenu?: (event: SchedulableEvent, e: React.MouseEvent) => void;
  /** The unscheduled-jobs query failed — error body in the Jobs bucket. */
  jobsError?: boolean;
  /** Live Service-Plan visit cards (page-owned pv- cards). Absent → the Step 9E stub body. */
  planSlot?: React.ReactNode;
  /** Count badge for a live planSlot (the slot's items aren't SchedulableEvents). */
  planCount?: number;
  /**
   * Bucket types this org/user cannot reach - the section is not rendered at all.
   * Hide, don't hint: useModuleAccess.ts:18-21 is the shipped policy (a host surface hides a
   * higher-plan widget; the nav lock and <RequireFeature> are the only upgrade prompts). It is
   * also what makes the remaining empty-state copy honest - "Nothing here - all X are
   * scheduled." is a positively FALSE claim when the query behind X was never allowed to run.
   */
  hiddenTypes?: ReadonlyArray<EventType>;
  /**
   * Card id the schedule search just selected. Unscheduled work has no calendar block to
   * jump to, so the board's search highlight has to land HERE instead - the bucket holding
   * it is forced open and the card is ringed and scrolled into view.
   */
  highlightedCardId?: string | null;
}

/** Overlapping initials chips for a state-3 crew; unknown ids degrade to '?'. */
function CrewAvatars({ ids, members }: { ids: string[]; members: AssignableUser[] }) {
  if (ids.length === 0) return null;
  return (
    <span className="flex -space-x-1.5">
      {ids.map((id) => {
        const m = members.find((x) => x.id === id);
        return (
          <Avatar
            key={id}
            ring="stack"
            title={m ? `${m.first_name} ${m.last_name}` : undefined}
            className="h-[18px] w-[18px]"
          >
            {m?.avatar_url && (
              <AvatarImage src={m.avatar_url} alt={`${m.first_name} ${m.last_name}`} className="object-cover" />
            )}
            <AvatarFallback tone="solid" className="text-[8px] font-semibold">
              {getInitials(m ? `${m.first_name} ${m.last_name}` : '')}
            </AvatarFallback>
          </Avatar>
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
  highlighted,
  onDragStart,
  onDragEnd,
  onClick,
  onContextMenu,
}: {
  ev: SchedulableEvent;
  members: AssignableUser[];
  dragging: boolean;
  dragDisabled: boolean;
  highlighted: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: (e: React.DragEvent) => void;
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const meta = EVENT_TYPE_META[ev.type];
  const crewKept = deriveState(ev) === 3;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [highlighted]);

  return (
    <div
      ref={ref}
      data-highlighted={highlighted || undefined}
      draggable={!dragDisabled}
      onDragStart={dragDisabled ? undefined : onDragStart}
      onDragEnd={dragDisabled ? undefined : onDragEnd}
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={`${dragDisabled ? 'cursor-pointer' : 'cursor-grab'} select-none rounded-lg border bg-surface-light p-2.5 shadow-sm transition-all
        duration-150 border-l-4 ${meta.accent}
        ${dragging ? 'cursor-grabbing scale-[0.97] opacity-40' : 'border-border hover:shadow-md'}
        ${highlighted ? 'ring-2 ring-primary ring-offset-1 ring-offset-surface-light' : ''}`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`text-xs font-bold ${meta.text}`}>{ev.number}</span>
        {crewKept && (
          <span className="ml-auto shrink-0 rounded-full bg-sage-50 px-1.5 py-0.5 text-[9px] font-bold text-sage-700">
            crew kept
          </span>
        )}
      </div>
      <p className="mt-0.5 truncate text-xs font-medium text-text-primary">{ev.title}</p>
      <p className="truncate text-[11px] text-text-secondary">{ev.customer}</p>
      {/* SRVW-58 tag chips. No height gate: this card is content-sized (no height style). */}
      <TagChips tags={ev.tags} max={2} />
      {crewKept && (
        <div className="mt-1 flex items-center gap-1">
          <CrewAvatars ids={ev.crew} members={members} />
          <span className="text-[10px] text-text-soft">re-drop remembers the crew</span>
        </div>
      )}
    </div>
  );
}

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
  highlightedCardId = null,
}: UnassignedBucketsProps) {
  const [open, setOpen] = useState<Record<EventType, boolean>>({
    job: true,
    walkthrough: true,
    'service-plan': true,
    'calendar-entry': true,
  });
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropHover, setDropHover] = useState(false);

  // A collapsed bucket has to reveal a search hit, or selecting the result highlights
  // something nobody can see. Derived at render rather than pushed into `open` from an
  // effect - an effect here is a cascading render (react-hooks/set-state-in-effect).
  const highlightedType = events.find((e) => e.boardId === highlightedCardId)?.type;

  return (
    <div
      data-testid="unassigned-buckets"
      className={`min-h-0 flex-1 space-y-2 overflow-y-auto p-2 transition-colors
        ${dropHover ? 'bg-primary-subtle/40 ring-2 ring-inset ring-primary/30' : ''}`}
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
        const items = events.filter((e) => e.type === type); // FIFO — array order, no resort
        const meta = EVENT_TYPE_META[type];
        const Icon = BUCKET_ICONS[type];
        const isOpen = open[type] || type === highlightedType;
        const live = type === 'service-plan' && planSlot !== undefined;
        const count = live ? planCount : items.length;
        return (
          <section key={type} className="rounded-lg border border-border-soft bg-surface-light">
            {/* Raw by design: an accordion/section-header row (icon + label + count
                + chevron) toggling bucket collapse - a disclosure control, not a
                discrete Button. */}
            <button
              type="button"
              aria-expanded={isOpen}
              // Toggles against what is ON SCREEN (isOpen), not the stored flag. While a
              // search highlight forces this bucket open the two disagree, and toggling the
              // stored flag would then expand the bucket once the highlight lifts - the
              // opposite of what the user just asked for.
              onClick={() => setOpen((o) => ({ ...o, [type]: !isOpen }))}
              className="flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-background-light"
            >
              <Icon className={`h-3.5 w-3.5 shrink-0 ${meta.text}`} />
              <span className="text-xs font-semibold text-text-primary">{label}</span>
              {stub && !live && (
                <span className="rounded-full bg-ai/10 px-1.5 py-0.5 text-[9px] font-bold uppercase text-ai">
                  soon
                </span>
              )}
              <span className="ml-auto text-[11px] font-medium text-text-secondary">{count}</span>
              {isOpen ? (
                <ChevronDown className="h-3.5 w-3.5 text-text-secondary" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 text-text-secondary" />
              )}
            </button>
            <Collapse open={isOpen}>
              <div className="space-y-1.5 px-2 pb-2">
                {live ? (
                  planSlot
                ) : jobsError && type === 'job' ? (
                  <div className="flex flex-col items-center justify-center py-4 text-center">
                    <AlertCircle className="mb-1.5 h-5 w-5 text-danger" />
                    <p className="text-[11px] text-text-secondary">Failed to load jobs</p>
                  </div>
                ) : items.length === 0 ? (
                  <EmptyState
                    variant="card"
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
                      highlighted={ev.boardId === highlightedCardId}
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
        <p className="px-1 pt-1 text-[10px] leading-snug text-text-soft">
          Drag a board card back here to <strong>unschedule</strong> — the crew is kept.
        </p>
      )}
    </div>
  );
}
