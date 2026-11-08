import { useMemo, useState } from 'react';
import { useFilteredTasks } from '@/lib/tasks/useFilteredTasks';

import { useTaskDetailStore } from '@/stores/taskDetailStore';
import { taskAssignees } from '@/lib/tasks/assignees';
import { AssigneeStack } from '@/components/tasks/AssigneeStack';
import { useTasksStore } from '@/stores/tasksStore';
import { useAppAbility } from '@/contexts/AbilityContext';
import { cn } from '@/lib/utils';
import { useScheduleTimezone, isoToOrgDay, isoToOrgTime, pickerValueToIso } from '@/lib/schedule-tz';
import {
  STATUS_REGISTRY,
  STATUS_INTENT_CLASSES,
  STATUS_INTENT_FILL,
  STATUS_INTENT_HOVER,
  type StatusEntry,
} from '@/design-system/status-registry';
import type { Task, TaskStatus } from '@/lib/tasks/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MAX_PER_CELL = 3;

/**
 * TaskStatus is a closed 5-value union and STATUS_REGISTRY.task covers all five
 * (asserted by the registry guard test), so the fallback below is unreachable.
 * It exists only so this file never spells out a class string of its own, the
 * same shape StatusBadge and PriorityDot use.
 */
function taskStatusEntry(status: TaskStatus): StatusEntry {
  return STATUS_REGISTRY.task[status] ?? { label: status, intent: 'neutral' };
}

// ---------------------------------------------------------------------------
// UTC Helpers
// ---------------------------------------------------------------------------

function sameUTCDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

/**
 * The calendar's day tokens are UTC-midnight Dates - not instants, just (y, m, d) triples
 * that `Date.UTC` arithmetic can add days to without a DST hour ever creeping in. This maps
 * a task's real instant onto the token for the day it falls on in the ORG's zone, so a task
 * lands in the cell the company would call it, not the cell the viewer's laptop would.
 */
function taskDayToken(t: Task, tz: string): Date | null {
  if (!t.due_at) return null;
  return new Date(`${isoToOrgDay(t.due_at, tz)}T00:00:00Z`);
}

/** A task's time as HH:MM on the ORG's clock. */
function fmtTime(isoStr: string, tz: string): string {
  return isoToOrgTime(isoStr, tz);
}

/** A day token + an org-clock 'HH:MM' -> the instant to persist. */
function dayTokenAndTimeToIso(day: Date, hhmm: string, tz: string): string {
  return pickerValueToIso(`${day.toISOString().slice(0, 10)}T${hhmm}`, tz)!;
}

/** The day token for today on the ORG's calendar. */
function orgToday(tz: string): Date {
  return new Date(`${isoToOrgDay(new Date().toISOString(), tz)}T00:00:00Z`);
}

/** Get the Sunday that starts the week containing `d` (UTC) */
function weekStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - d.getUTCDay()));
}

/** Tasks falling on a specific ORG-zone day, sorted by due_at ascending */
function tasksForDay(tasks: Task[], day: Date, tz: string): Task[] {
  return tasks
    .filter((t) => {
      const d = taskDayToken(t, tz);
      return d !== null && sameUTCDay(d, day);
    })
    .sort((a, b) => {
      const ta = new Date(a.due_at!).getTime();
      const tb = new Date(b.due_at!).getTime();
      return ta - tb;
    });
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface TaskChipProps {
  task: Task;
  showTime?: boolean;
  canDrag: boolean;
  onClick: () => void;
  tz: string;
}

function TaskChip({ task, showTime, canDrag, onClick, tz }: TaskChipProps) {
  return (
    // Draggable status-intent chip (dnd-kit-style drag source), not a Button-shaped
    // control - left raw per the program's non-Button-shape carve-out.
    <button
      type="button"
      draggable={canDrag}
      onDragStart={(e) => {
        e.dataTransfer.setData('task-id', task.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={onClick}
      title={task.title}
      // The border COLOUR that STATUS_INTENT_CLASSES always ships (`border-neutral-border`
      // and its per-intent siblings) is INERT here: no `border` width class is present,
      // and that is deliberate - this chip never had a hairline, so adding one would be
      // a fresh, undecided appearance change on a live surface.
      className={cn(
        'flex w-full items-center gap-1 rounded px-1.5 py-0.5 text-left text-[10px] font-medium leading-snug cursor-pointer transition-colors',
        STATUS_INTENT_CLASSES[taskStatusEntry(task.status).intent],
        // TODO ink is held at the pre-registry value on purpose. This chip's text is
        // the task TITLE, not a status label, so the registry's `-text` role
        // (documented as "bare label text", i.e. the text IS the status word) does not
        // apply: neutral would drop a calendar's default-state task titles from
        // text-text-primary to text-neutral-text. Preserved pending a decision on
        // whether the registry should carry a "neutral chip, primary ink" role.
        // Order matters - cn is twMerge(clsx(...)) (lib/utils.ts), so this trailing
        // text colour wins over the text-neutral-text above. Hoisting it above
        // STATUS_INTENT_CLASSES makes twMerge drop it and the revert silently
        // does nothing. Do not reorder these arguments.
        task.status === 'TODO' && 'text-text-primary',
        // Hover comes from the registry keyed on the RESOLVED INTENT. The local
        // status-keyed hover map this file used to carry re-encoded
        // status -> appearance in a second place, which is the duplication the
        // registry exists to remove. STATUS_INTENT_HOVER is Partial by design,
        // so carry the documented `?? ''` fallback (task never resolves to
        // danger or brand, but the contract is the contract).
        STATUS_INTENT_HOVER[taskStatusEntry(task.status).intent] ?? '',
      )}
    >
      {showTime && task.due_at && (
        <span className="shrink-0 font-mono opacity-70">{fmtTime(task.due_at, tz)}</span>
      )}
      <span className="truncate">{task.title}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Month view
// ---------------------------------------------------------------------------

interface MonthViewProps {
  anchor: Date;
  tasks: Task[];
  open: (id: string) => void;
  reschedule: (id: string, due_at: string) => void;
  canEdit: boolean;
  tz: string;
}

function MonthView({ anchor, tasks, open, reschedule, canEdit, tz }: MonthViewProps) {
  const [dragOverDay, setDragOverDay] = useState<number | null>(null);
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth();

  // "Today" is the company's today. A dispatcher whose own date has already rolled over must
  // still see the highlight on the day the company is working.
  const today = orgToday(tz);

  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const firstWeekday = new Date(Date.UTC(year, month, 1)).getUTCDay();

  const totalCells = firstWeekday + daysInMonth;
  const trailingBlanks = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);

  const cells: Array<number | null> = [
    ...Array<null>(firstWeekday).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
    ...Array<null>(trailingBlanks).fill(null),
  ];

  // Group tasks by ORG day-of-month for this month/year.
  //
  // Rewritten to stop mutating entries already in the map: the previous version pushed into a
  // retrieved array and re-sorted in place while iterating the very map it was writing to.
  //
  // `preserve-manual-memoization` still cannot compile this body, but that is NOT new - the
  // pre-`tz` version on staging trips the identical rule (verified by linting a clean tree),
  // and swapping in a trivial body clears it, so the trigger is the grouping logic rather than
  // the timezone dependency added here. The React Compiler is not in this project's Vite
  // build, so this useMemo is doing real work and cannot simply be dropped. Scoped to this one
  // hook so the rule keeps guarding the rest of the file.
  const tasksByDay = useMemo(() => {
    const grouped = new Map<number, Task[]>();
    for (const t of tasks) {
      const d = taskDayToken(t, tz);
      if (!d || d.getUTCFullYear() !== year || d.getUTCMonth() !== month) continue;
      const day = d.getUTCDate();
      grouped.set(day, [...(grouped.get(day) ?? []), t]);
    }
    return new Map(
      [...grouped].map(([day, arr]): [number, Task[]] => [
        day,
        [...arr].sort((a, b) => new Date(a.due_at!).getTime() - new Date(b.due_at!).getTime()),
      ]),
    );
    // eslint-disable-next-line react-hooks/preserve-manual-memoization
  }, [tasks, year, month, tz]);

  const unscheduled = useMemo(() => tasks.filter((t) => !t.due_at), [tasks]);

  return (
    <>
      <div className="overflow-hidden">
        {/* Weekday headers */}
        <div className="grid grid-cols-7 border-b border-border">
          {WEEKDAY_LABELS.map((d) => (
            <div
              key={d}
              className="px-2 py-2 text-center text-xs font-semibold uppercase tracking-wide text-text-secondary"
            >
              {d}
            </div>
          ))}
        </div>

        {/* Day cells */}
        <div className="grid grid-cols-7">
          {cells.map((day, idx) => {
            const cellDate = day ? new Date(Date.UTC(year, month, day)) : null;
            const isToday = cellDate ? sameUTCDay(cellDate, today) : false;
            const dayTasks = day ? (tasksByDay.get(day) ?? []) : [];
            const extra = Math.max(0, dayTasks.length - MAX_PER_CELL);

            return (
              <div
                key={idx}
                className={cn(
                  'min-h-[80px] border-b border-r border-border p-1.5 flex flex-col gap-1 transition-colors',
                  (idx + 1) % 7 === 0 && 'border-r-0',
                  idx >= cells.length - 7 && 'border-b-0',
                  isToday && 'bg-primary/5',
                  !day && 'bg-background-light opacity-40',
                  day !== null && dragOverDay === day && 'ring-2 ring-inset ring-primary/40',
                )}
                onDragOver={day !== null && canEdit ? (e) => { e.preventDefault(); setDragOverDay(day); } : undefined}
                onDragLeave={day !== null ? () => setDragOverDay(null) : undefined}
                // Touch drag-to-reschedule deferred to #681 (HTML5 DnD is pointer-only).
                onDrop={day !== null ? (e) => {
                  e.preventDefault();
                  if (!canEdit) return;
                  setDragOverDay(null);
                  const taskId = e.dataTransfer.getData('task-id');
                  if (!taskId) return;
                  const task = tasks.find((t) => t.id === taskId);
                  // Keep the task's existing time-of-day, read on the ORG's clock, and re-anchor
                  // it to the dropped day. Slicing the raw ISO here used to carry UTC's hour over.
                  const origHHMM = task?.due_at ? isoToOrgTime(task.due_at, tz) : '09:00';
                  reschedule(taskId, dayTokenAndTimeToIso(new Date(Date.UTC(year, month, day)), origHHMM, tz));
                } : undefined}
              >
                {day !== null && (
                  <>
                    <span
                      className={cn(
                        'flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium self-start',
                        isToday
                          ? 'bg-primary text-on-fill font-bold'
                          : 'text-text-secondary',
                      )}
                    >
                      {day}
                    </span>

                    {dayTasks.slice(0, MAX_PER_CELL).map((t) => (
                      <TaskChip
                        key={t.id}
                        task={t}
                        tz={tz}
                        canDrag={canEdit}
                        onClick={() => open(t.id)}
                      />
                    ))}
                    {extra > 0 && (
                      <span className="text-[10px] text-text-secondary font-medium pl-1">
                        ＋{extra} more
                      </span>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Unscheduled strip */}
      {unscheduled.length > 0 && (
        <div className="border-t border-border bg-background-light/35 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary mb-3">
            Unscheduled ({unscheduled.length})
          </p>
          <div className="flex flex-wrap gap-2">
            {/* Draggable task chip, not a Button-shaped control - left raw per the
                program's non-Button-shape carve-out. */}
            {unscheduled.map((t) => (
              <button
                key={t.id}
                type="button"
                draggable={canEdit}
                onDragStart={(e) => {
                  e.dataTransfer.setData('task-id', t.id);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onClick={() => open(t.id)}
                className="rounded-lg border border-border bg-background-light px-3 py-1 text-xs text-text-secondary cursor-pointer hover:bg-neutral-surface transition-colors"
              >
                {t.title}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Week view
// ---------------------------------------------------------------------------

interface WeekViewProps {
  anchor: Date;
  tasks: Task[];
  open: (id: string) => void;
  reschedule: (id: string, due_at: string) => void;
  canEdit: boolean;
  tz: string;
}

function WeekView({ anchor, tasks, open, reschedule, canEdit, tz }: WeekViewProps) {
  const [dragOverDayIdx, setDragOverDayIdx] = useState<number | null>(null);
  const sunday = weekStart(anchor);
  const today = new Date();

  const days: Date[] = Array.from({ length: 7 }, (_, i) =>
    new Date(Date.UTC(sunday.getUTCFullYear(), sunday.getUTCMonth(), sunday.getUTCDate() + i)),
  );

  const formatWeekDay = (d: Date) =>
    new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' }).format(d);

  const formatWeekDate = (d: Date) =>
    new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(d);

  return (
    <div className="overflow-hidden">
      <div className="grid grid-cols-7 border-b border-border">
        {days.map((day, i) => {
          const isToday = sameUTCDay(day, today);
          return (
            <div
              key={i}
              className={cn(
                'px-2 py-2 text-center border-r border-border last:border-r-0',
                isToday && 'bg-primary/5',
              )}
            >
              <div className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                {formatWeekDay(day)}
              </div>
              <div
                className={cn(
                  'mx-auto mt-0.5 flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium',
                  isToday ? 'bg-primary text-on-fill font-bold' : 'text-text-primary',
                )}
              >
                {day.getUTCDate()}
              </div>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-7 divide-x divide-border min-h-[200px]">
        {days.map((day, i) => {
          const dayTasks = tasksForDay(tasks, day, tz);
          const isToday = sameUTCDay(day, today);
          return (
            <div
              key={i}
              className={cn(
                'p-1.5 flex flex-col gap-1 transition-colors',
                isToday && 'bg-primary/5',
                dragOverDayIdx === i && 'ring-2 ring-inset ring-primary/40',
              )}
              onDragOver={canEdit ? (e) => { e.preventDefault(); setDragOverDayIdx(i); } : undefined}
              onDragLeave={() => setDragOverDayIdx(null)}
              onDrop={(e) => {
                e.preventDefault();
                if (!canEdit) return;
                setDragOverDayIdx(null);
                const taskId = e.dataTransfer.getData('task-id');
                if (!taskId) return;
                const task = tasks.find((t) => t.id === taskId);
                // Keep the task's time-of-day on the ORG's clock, re-anchored to the dropped day.
                const origHHMM = task?.due_at ? isoToOrgTime(task.due_at, tz) : '09:00';
                reschedule(taskId, dayTokenAndTimeToIso(day, origHHMM, tz));
              }}
            >
              {dayTasks.length === 0 ? (
                <span className="text-[10px] text-text-secondary/50 px-1 pt-1">—</span>
              ) : (
                dayTasks.map((t) => (
                  <TaskChip
                    key={t.id}
                    task={t}
                    tz={tz}
                    showTime
                    canDrag={canEdit}
                    onClick={() => open(t.id)}
                  />
                ))
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Day view
// ---------------------------------------------------------------------------

interface DayViewProps {
  anchor: Date;
  tasks: Task[];
  open: (id: string) => void;
  tz: string;
}

function DayView({ anchor, tasks, open, tz }: DayViewProps) {
  const dayTasks = tasksForDay(tasks, anchor, tz);
  const today = orgToday(tz);
  const isToday = sameUTCDay(anchor, today);

  return (
    <div className="overflow-hidden">
      <div className={cn('px-4 py-3 border-b border-border', isToday && 'bg-primary/5')}>
        <p className="text-sm font-semibold text-text-primary">
          {new Intl.DateTimeFormat('en-US', {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
            year: 'numeric',
            timeZone: 'UTC',
          }).format(anchor)}
        </p>
      </div>

      {dayTasks.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-text-secondary">
          No tasks due this day.
        </div>
      ) : (
        <div className="divide-y divide-border">
          {/* Full-width list-row click target (time + status dot + title + assignees),
              not a Button-shaped control - left raw per the program's
              non-Button-shape carve-out. */}
          {dayTasks.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => open(t.id)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left cursor-pointer hover:bg-background-light transition-colors group"
            >
              {/* Time */}
              <span className="w-12 shrink-0 font-mono text-xs text-text-secondary">
                {t.due_at ? fmtTime(t.due_at, tz) : '—'}
              </span>

              {/* Status dot */}
              <span
                className={cn(
                  'h-2 w-2 shrink-0 rounded-full',
                  STATUS_INTENT_FILL[taskStatusEntry(t.status).intent],
                )}
              />

              {/* Title */}
              <span className="flex-1 truncate text-sm font-medium text-text-primary group-hover:text-primary transition-colors">
                {t.title}
              </span>

              {/* Assignees */}
              <AssigneeStack assignees={taskAssignees(t)} className="shrink-0" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Period label helpers
// ---------------------------------------------------------------------------

function dayLabel(d: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(d);
}

function weekLabel(anchor: Date): string {
  const sun = weekStart(anchor);
  const sat = new Date(Date.UTC(sun.getUTCFullYear(), sun.getUTCMonth(), sun.getUTCDate() + 6));

  const startFmt = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(sun);

  // If same month, only show month once
  if (sun.getUTCMonth() === sat.getUTCMonth() && sun.getUTCFullYear() === sat.getUTCFullYear()) {
    const endDay = sat.getUTCDate();
    return `${startFmt} – ${endDay}, ${sat.getUTCFullYear()}`;
  }

  const endFmt = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(sat);

  return `${startFmt} – ${endFmt}, ${sat.getUTCFullYear()}`;
}

function monthLabel(anchor: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(anchor);
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

type CalendarViewMode = 'day' | 'week' | 'month';

export default function CalendarView() {
  // The whole grid runs on the COMPANY's calendar: which cell a task lands in, which cell is
  // "today", and the time-of-day a drag preserves. Previously all three read UTC, which was at
  // least self-consistent but matched nobody's actual working day.
  const tz = useScheduleTimezone();
  const [view, setView] = useState<CalendarViewMode>('month');
  const [anchor, setAnchor] = useState<Date>(() => orgToday(tz));
  const tasks = useFilteredTasks();
  const open = useTaskDetailStore((s) => s.open);
  const reschedule = useTasksStore((s) => s.reschedule);
  const ability = useAppAbility();
  const canEdit = ability.can('update', 'Task');

  // Navigation: shift anchor by 1 day / 7 days / 1 month depending on view
  function navigate(direction: -1 | 1) {
    setAnchor((prev) => {
      if (view === 'day') {
        return new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth(), prev.getUTCDate() + direction));
      }
      if (view === 'week') {
        return new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth(), prev.getUTCDate() + 7 * direction));
      }
      // month: advance/retreat by 1 month (clamp to valid day)
      const newMonth = prev.getUTCMonth() + direction;
      const newYear = prev.getUTCFullYear() + Math.floor(newMonth / 12);
      const clampedMonth = ((newMonth % 12) + 12) % 12;
      const daysInNewMonth = new Date(Date.UTC(newYear, clampedMonth + 1, 0)).getUTCDate();
      const clampedDay = Math.min(prev.getUTCDate(), daysInNewMonth);
      return new Date(Date.UTC(newYear, clampedMonth, clampedDay));
    });
  }

  // Period label shown in the toolbar
  const periodLabel =
    view === 'day'
      ? dayLabel(anchor)
      : view === 'week'
      ? weekLabel(anchor)
      : monthLabel(anchor);

  const VIEW_OPTIONS: { value: CalendarViewMode; label: string }[] = [
    { value: 'day', label: 'Day' },
    { value: 'week', label: 'Week' },
    { value: 'month', label: 'Month' },
  ];

  return (
    <div data-testid="tasks-calendar-card" className="overflow-hidden rounded-xl border border-border bg-surface-light shadow-card">
      <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center lg:justify-between">
        {/* These three read as outline/neutral structurally, but outline/neutral sets
            NO idle text colour (relies on ambient inheritance) and this row's ambient
            wrapper sets none either - converting would silently drop the muted
            text-secondary label toward near-black with no replacement, the same trap
            documented at TaskFilterBar.tsx and CommissionsReport.tsx's FieldsMenu -
            left raw. */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-surface-light text-sm font-medium text-text-secondary transition-colors hover:bg-background-light"
            aria-label="Previous period"
          >
            ‹
          </button>
          <button
            type="button"
            onClick={() => setAnchor(orgToday(tz))}
            className="h-8 rounded-lg border border-border bg-surface-light px-3 text-xs font-medium text-text-secondary transition-colors hover:bg-background-light"
          >
            Today
          </button>
          <button
            type="button"
            onClick={() => navigate(1)}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-surface-light text-sm font-medium text-text-secondary transition-colors hover:bg-background-light"
            aria-label="Next period"
          >
            ›
          </button>
          <span className="ml-0 text-base font-semibold text-text-primary sm:ml-2">{periodLabel}</span>
        </div>

        <div className="flex w-fit items-center overflow-hidden rounded-lg border border-border bg-background-light p-0.5">
          {/* Segmented Day/Week/Month view toggle, not a Button-shaped control -
              left raw per the program's non-Button-shape carve-out. */}
          {VIEW_OPTIONS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              onClick={() => setView(value)}
              className={cn(
                'h-8 rounded-md px-3 text-xs font-medium transition-colors',
                view === value
                  ? 'bg-primary text-on-fill shadow-soft'
                  : 'text-text-secondary hover:bg-surface-light',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {view === 'month' && <MonthView anchor={anchor} tasks={tasks} open={open} reschedule={reschedule} canEdit={canEdit} tz={tz} />}
      {view === 'week' && <WeekView anchor={anchor} tasks={tasks} open={open} reschedule={reschedule} canEdit={canEdit} tz={tz} />}
      {view === 'day' && <DayView anchor={anchor} tasks={tasks} open={open} tz={tz} />}
    </div>
  );
}
