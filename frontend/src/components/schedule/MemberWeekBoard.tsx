import React, { useMemo, useState } from 'react';
import { format, isSameDay, addDays, startOfWeek } from 'date-fns';
import { Loader2 } from 'lucide-react';
import { cn, getInitials } from '@/lib/utils';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { EmptyState } from '@/components/ui/empty-state';
import {
  isOnBoardFor, eventDangerState,
  type BoardEvent, type ScheduledBoardEvent, type EventDangerState,
} from './scheduleModel';
import {
  ScheduleCardBody, scheduleCardVisual, scheduleCardPaintClass, scheduleCardOpacityStyle,
} from './ScheduleCardBody';
import {
  GRID_EVENT_ID, GRID_EVENT_TYPE, FROM_MEMBER,
  hasBoardDragPayload, resolveBoardDropId,
} from './dragChannels';
import { nowWallClock, asWallClock, type WallClock } from '@/lib/schedule-tz';

// ─── Types ───────────────────────────────────────────────

export interface StaffUser {
  id: string;
  first_name: string;
  last_name: string;
  is_active: boolean;
  role?: string;
  avatar_url?: string | null;
}

interface MemberWeekBoardProps {
  weekStart: WallClock;
  staff: StaffUser[];
  events: BoardEvent[];
  conflictIds: Set<string>;
  isLoading: boolean;
  /** The org's scheduling timezone — "today" has to be the org's today, not the browser's. */
  tz: string;
  onSelectEvent: (event: BoardEvent) => void;
  /** Member×day cell drop — DAY granularity only (no time; the caller applies the default start).
   *  `fromMember` = the lane a BOARD card was dragged from (null for bucket cards) — TG10 swap. */
  onDropJob?: (jobId: string, techId: string, date: WallClock, fromMember: string | null) => void;
  /** Same sidebar-drag fallback the grid view uses when dataTransfer reads come back empty. */
  draggingJobIdRef?: React.MutableRefObject<string | null>;
  onGhostContextMenu?: (ghostId: string, x: number, y: number) => void;
  onEventClick?: (event: BoardEvent, x: number, y: number) => void;
  onEventContextMenu?: (event: BoardEvent, x: number, y: number) => void;
}

// ─── Helpers ─────────────────────────────────────────────

function formatDuration(ms: number): string {
  const hrs = ms / 3_600_000;
  if (hrs === Math.floor(hrs)) return `${hrs} hrs`;
  return `${hrs.toFixed(1)} hrs`;
}

// ─── BoardCard ───────────────────────────────────────────

interface BoardCardProps {
  event: ScheduledBoardEvent;
  /** The lane this card is rendered in — emitted as the `from-member` drag marker (TG10 swap). */
  fromMemberId: string;
  dangerState: EventDangerState;
  onClick: (e: React.MouseEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}

function BoardCard({ event, fromMemberId, dangerState, onClick, onContextMenu }: BoardCardProps) {
  // Danger/status/scheme resolution and the whole inner column live in ScheduleCardBody, shared
  // with TechnicianGridView's JobCard (multi-visit S0b). Only the wrapper is local: this card is
  // content-sized, where the grid view's is absolutely positioned at a caller-supplied height.
  const visual = scheduleCardVisual(event, dangerState);

  return (
    <div
      className={cn(
        'rounded-lg overflow-hidden cursor-pointer transition-all duration-100',
        'hover:shadow-md hover:brightness-[0.97] active:scale-[0.99]',
        scheduleCardPaintClass(visual),
      )}
      style={scheduleCardOpacityStyle(visual)}
      // The card's identity on the board (multi-visit S6): one per VISIT, never per job.
      data-board-id={event.boardId}
      draggable
      onDragStart={(e) => {
        // Same payload keys as the grid view's JobCard, plus the from-member lane marker.
        // Day granularity — moving a card never exposes a resize affordance here (B-8).
        e.dataTransfer.setData(GRID_EVENT_ID, event.boardId);
        e.dataTransfer.setData(GRID_EVENT_TYPE, event.type);
        e.dataTransfer.setData(FROM_MEMBER, fromMemberId);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={(e) => { e.stopPropagation(); onClick(e); }}
      onContextMenu={onContextMenu}
    >
      <div className="px-2.5 py-2 flex flex-col gap-1 relative">
        {/* showTags unconditional: this card is content-sized (its style carries only opacity -
            no height, no absolute positioning), so chips can never clip the address above them. */}
        <ScheduleCardBody event={event} visual={visual} />
      </div>
    </div>
  );
}

// ─── DaySection ──────────────────────────────────────────

interface DaySectionProps {
  date: WallClock;
  /** The member whose lane this cell belongs to — the drop target + drag from-member. */
  laneMemberId: string;
  /** Right-hand rule is drawn per cell (the board is one grid, not per-member columns). */
  isLastColumn: boolean;
  events: ScheduledBoardEvent[];
  conflictIds: Set<string>;
  tz: string;
  onSelectEvent: (event: BoardEvent) => void;
  onDropJob?: (jobId: string, techId: string, date: WallClock, fromMember: string | null) => void;
  draggingJobIdRef?: React.MutableRefObject<string | null>;
  onGhostContextMenu?: (ghostId: string, x: number, y: number) => void;
  onEventClick?: (event: BoardEvent, x: number, y: number) => void;
  onEventContextMenu?: (event: BoardEvent, x: number, y: number) => void;
}

function DaySection({ date, laneMemberId, isLastColumn, events, conflictIds, tz, onSelectEvent, onDropJob, draggingJobIdRef, onGhostContextMenu, onEventClick, onEventContextMenu }: DaySectionProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const sorted = [...events].sort((a, b) => a.start.getTime() - b.start.getTime());
  const totalMs = events.reduce((sum, e) => sum + (e.end.getTime() - e.start.getTime()), 0);
  const jobCount = events.length;
  const isToday = isSameDay(date, nowWallClock(tz));

  return (
    <div
      className={cn(
        // Grid cell: stretches to the tallest lane in this day's row, so the same
        // calendar day sits at the same y across every member column.
        'flex flex-col bg-surface-light border-b border-border transition-colors',
        !isLastColumn && 'border-r border-border',
        isDragOver && 'bg-primary-subtle/50 ring-1 ring-inset ring-primary/30',
      )}
      data-testid={`week-cell-${laneMemberId}-${format(date, 'yyyy-MM-dd')}`}
      // Member×day drop target — same payload keys as TechnicianGridView's hour slots.
      // Day granularity only: no time, no resize (B-8); the page applies the default start.
      onDragOver={(e) => {
        if (hasBoardDragPayload(e.dataTransfer.types)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          setIsDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setIsDragOver(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragOver(false);
        // Codec-normalized BOARD id — the walkthrough channel's bare lead id gets
        // its wt- prefix restored so the page can't mistake it for a job id.
        const resolvedId = resolveBoardDropId(e.dataTransfer, draggingJobIdRef?.current ?? null);
        if (!resolvedId) return;
        // BOARD cards carry the lane they came from — the page classifies the drop
        // (cross-lane = swap / same-lane = reschedule). Bucket cards carry none → null.
        const fromMember = e.dataTransfer.getData(FROM_MEMBER) || null;
        onDropJob?.(resolvedId, laneMemberId, date, fromMember);
      }}
    >
      {/* Day header — opaque on purpose: this header sticks while its own cards scroll
          beneath it, so any translucency lets card text bleed through and read as garbled. */}
      <div className={cn(
        'px-3 py-2 flex items-center justify-between sticky top-[72px] z-20 border-b border-border',
        isToday ? 'bg-info-surface' : 'bg-background-light',
      )}>
        <span className={cn(
          'text-xs font-semibold',
          isToday ? 'text-info-text' : 'text-text-secondary',
        )}>
          {format(date, 'EEEE, MMM d')}
        </span>
        <span className="text-[10px] text-text-soft font-medium">
          {jobCount > 0
            ? `${jobCount} job${jobCount !== 1 ? 's' : ''} \u00B7 ${formatDuration(totalMs)}`
            : 'No events'}
        </span>
      </div>

      {/* Cards */}
      <div className="flex-1 px-2 py-1.5 flex flex-col gap-1.5 min-h-[36px]">
        {sorted.length === 0 && (
          <div className="text-[10px] text-text-soft text-center py-1 italic">Available</div>
        )}
        {sorted.map((ev) => (
          <BoardCard
            key={ev.boardId}
            event={ev}
            fromMemberId={laneMemberId}
            dangerState={eventDangerState(ev, conflictIds)}
            onClick={(e) => {
              if (ev.isGhost) return;
              if (onEventClick) {
                onEventClick(ev, e.clientX, e.clientY);
              } else {
                onSelectEvent(ev);
              }
            }}
            onContextMenu={ev.isGhost && ev.ghostId && onGhostContextMenu ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              onGhostContextMenu(ev.ghostId!, e.clientX, e.clientY);
            } : !ev.isGhost && onEventContextMenu ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              onEventContextMenu(ev, e.clientX, e.clientY);
            } : undefined}
          />
        ))}
      </div>
    </div>
  );
}

// ─── StaffHeaderCell ─────────────────────────────────────

/** Row 1 of the board grid — one per member, sticky above every day row. */
function StaffHeaderCell({ staff, isLastColumn }: { staff: StaffUser; isLastColumn: boolean }) {
  return (
    <div
      className={cn(
        'sticky top-0 z-30 bg-surface-light border-b border-border shadow-sm px-3 py-3 flex items-center gap-3',
        !isLastColumn && 'border-r border-border',
      )}
      style={{ height: 72 }}
    >
      <Avatar ring="stack" size="sm">
        {staff.avatar_url && (
          <AvatarImage src={staff.avatar_url} alt={`${staff.first_name} ${staff.last_name}`} className="object-cover" />
        )}
        <AvatarFallback tone="solid" className="text-xs font-bold">
          {getInitials(`${staff.first_name} ${staff.last_name}`)}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-text-primary truncate leading-tight">
          {staff.first_name} {staff.last_name}
        </p>
        <p className="text-xs text-text-secondary truncate mt-0.5">
          {staff.role ?? 'Technician'}
        </p>
      </div>
    </div>
  );
}

/** D1 — crew membership, not single ownership: a 2-crew event renders in BOTH lanes. */
function laneEventsFor(events: BoardEvent[], memberId: string, day: WallClock): ScheduledBoardEvent[] {
  return events.filter(
    (e): e is ScheduledBoardEvent =>
      e.start !== null && e.end !== null && isOnBoardFor(e, memberId) && isSameDay(e.start, day),
  );
}

// ─── MemberWeekBoard (main export) ───────────────────────

export function MemberWeekBoard({
  weekStart,
  staff,
  events,
  conflictIds,
  isLoading,
  tz,
  onSelectEvent,
  onDropJob,
  draggingJobIdRef,
  onGhostContextMenu,
  onEventClick,
  onEventContextMenu,
}: MemberWeekBoardProps) {
  const weekDays = useMemo(() => {
    // startOfWeek/addDays always return a plain Date, even given a WallClock input —
    // re-assert the brand on values that were already wall-clock space (weekStart is).
    const ws = asWallClock(startOfWeek(weekStart, { weekStartsOn: 0 }));
    return Array.from({ length: 7 }, (_, i) => asWallClock(addDays(ws, i)));
  }, [weekStart]);

  const activeStaff = staff.filter((s) => s.is_active);

  return (
    <div className="h-full overflow-x-auto overflow-y-auto relative bg-background-light">
      {/* Loading overlay */}
      {isLoading && (
        <div className="absolute inset-0 z-50 bg-surface-light/70 flex items-center justify-center pointer-events-none">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      )}

      {/* Board — ONE grid, not per-member scroll columns. Members are the columns and the
          seven days are the rows, so every cell in a day row shares that row's height and
          the same date lines up across the whole team. Per-column scrolling is what let the
          lanes drift out of step; the whole board scrolls together instead. */}
      {activeStaff.length > 0 ? (
        <div
          className="grid min-h-full bg-surface-light"
          style={{ gridTemplateColumns: `repeat(${activeStaff.length}, minmax(240px, 1fr))` }}
        >
          {activeStaff.map((s, i) => (
            <StaffHeaderCell key={s.id} staff={s} isLastColumn={i === activeStaff.length - 1} />
          ))}
          {weekDays.map((day) =>
            activeStaff.map((s, i) => (
              <DaySection
                key={`${s.id}-${format(day, 'yyyy-MM-dd')}`}
                date={day}
                laneMemberId={s.id}
                isLastColumn={i === activeStaff.length - 1}
                events={laneEventsFor(events, s.id, day)}
                conflictIds={conflictIds}
                tz={tz}
                onSelectEvent={onSelectEvent}
                onDropJob={onDropJob}
                draggingJobIdRef={draggingJobIdRef}
                onGhostContextMenu={onGhostContextMenu}
                onEventClick={onEventClick}
                onEventContextMenu={onEventContextMenu}
              />
            )),
          )}
        </div>
      ) : (
        <div className="flex min-h-full">
          <EmptyState density="roomy" title="No active staff members found." className="flex-1" />
        </div>
      )}
    </div>
  );
}
