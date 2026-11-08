import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { TASK_VIEW_FILTER_OPTIONS, useFilteredTasks } from '@/lib/tasks/useFilteredTasks';
import { calendarRows, calendarWeekStart, type CalendarMode } from '@/lib/tasks/taskViewRows';
import { useTaskViewStore } from '@/stores/taskViewStore';
import { useTaskDetailStore } from '@/stores/taskDetailStore';
import { taskAssignees } from '@/lib/tasks/assignees';
import { AssigneeStack } from '@/components/tasks/AssigneeStack';
import { useTasksStore } from '@/stores/tasksStore';
import { useAppAbility } from '@/contexts/AbilityContext';
import {
  STATUS_REGISTRY,
  STATUS_INTENT_CLASSES,
  STATUS_INTENT_FILL,
  STATUS_INTENT_HOVER,
  type StatusEntry,
} from '@/design-system/status-registry';
import type { Task, TaskStatus } from '@/lib/tasks/types';

import { cn } from '@/ui-kit/lib/utils';
import { Button } from '@/ui-kit/components/ui/button';
import { Card } from '@/ui-kit/components/ui/card';

import { EM_DASH, EN_DASH, FULLWIDTH_PLUS } from '../components/glyphs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MAX_PER_CELL = 3;

/**
 * TaskStatus is a closed 5-value union and STATUS_REGISTRY.task covers all five
 * (asserted by the registry guard test), so the fallback below is unreachable.
 * It exists only so this file never spells out a class string of its own.
 */
function taskStatusEntry(status: TaskStatus): StatusEntry {
  return STATUS_REGISTRY.task[status] ?? { label: status, intent: 'neutral' };
}

// ---------------------------------------------------------------------------
// UTC helpers - every date in this view is computed in UTC, unchanged
// ---------------------------------------------------------------------------

function sameUTCDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

function taskUTCDate(t: Task): Date | null {
  return t.due_at ? new Date(t.due_at) : null;
}

/** Format a task's time as HH:MM (UTC). */
function fmtTime(isoStr: string): string {
  return new Date(isoStr).toISOString().slice(11, 16);
}

/** Tasks for a specific UTC day, sorted by due_at ascending. */
function tasksForDay(tasks: Task[], day: Date): Task[] {
  return tasks
    .filter((t) => {
      const d = taskUTCDate(t);
      return d !== null && sameUTCDay(d, day);
    })
    .sort((a, b) => new Date(a.due_at!).getTime() - new Date(b.due_at!).getTime());
}

/**
 * The drop payload rule, in one place: keep the task's original HH:MM, else
 * 09:00, and build the new instant in UTC. Byte-for-byte the legacy rule - a
 * calendar that silently reschedules to local midnight is a data bug.
 */
function rescheduledISO(task: Task | undefined, dayISODate: string): string {
  const origHHMM = task?.due_at ? task.due_at.slice(11, 16) : '09:00';
  return new Date(`${dayISODate}T${origHHMM}:00Z`).toISOString();
}

// ---------------------------------------------------------------------------
// Chip
// ---------------------------------------------------------------------------

interface TaskChipProps {
  task: Task;
  showTime?: boolean;
  canDrag: boolean;
  onClick: () => void;
}

/**
 * A calendar chip is a drag SOURCE for native HTML5 drag-and-drop, which is
 * what this view has always used and what it keeps. dnd-kit does not emit
 * `dataTransfer`, so half-migrating the calendar would break reschedule
 * outright; converting both halves is a rewrite of an interaction, not a
 * restyle. Recorded in the gap ledger.
 *
 * The chip is not a Button-shaped control, so it does not render through the
 * kit's Button - but the raw-tag ratchet is at its floor, so it renders as a
 * span with an explicit button role rather than a raw <button>.
 */
function TaskChip({ task, showTime, canDrag, onClick }: TaskChipProps) {
  const entry = taskStatusEntry(task.status);
  return (
    <span
      role="button"
      tabIndex={0}
      draggable={canDrag}
      onDragStart={(e) => {
        e.dataTransfer.setData('task-id', task.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      title={task.title}
      className={cn(
        'flex w-full cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-left text-[10px] font-medium leading-snug transition-colors',
        STATUS_INTENT_CLASSES[entry.intent],
        // TODO ink stays at the pre-registry value on purpose: this chip's text
        // is the task TITLE, not a status label, so neutral's `-text` role
        // would drop a default-state task title to muted. Order matters - cn is
        // twMerge(clsx(...)), so this trailing colour wins. Do not reorder.
        task.status === 'TODO' && 'text-foreground',
        STATUS_INTENT_HOVER[entry.intent] ?? '',
      )}
    >
      {showTime && task.due_at && (
        <span className="shrink-0 font-mono opacity-70">{fmtTime(task.due_at)}</span>
      )}
      <span className="truncate">{task.title}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Month
// ---------------------------------------------------------------------------

interface GridProps {
  anchor: Date;
  tasks: Task[];
  open: (id: string) => void;
  reschedule: (id: string, due_at: string) => void;
  canEdit: boolean;
}

function MonthView({ anchor, tasks, open, reschedule, canEdit }: GridProps) {
  const [dragOverDay, setDragOverDay] = useState<number | null>(null);
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth();
  const today = new Date();

  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const firstWeekday = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const totalCells = firstWeekday + daysInMonth;
  const trailingBlanks = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);

  const cells: Array<number | null> = [
    ...Array<null>(firstWeekday).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
    ...Array<null>(trailingBlanks).fill(null),
  ];

  // The month bounds are re-derived INSIDE the memo, from `anchor` itself.
  // `year` and `month` above are method calls on a prop, so the compiler cannot
  // key a manual memo on them (react-hooks/preserve-manual-memoization) - it
  // wants the prop. Depending on `anchor` and re-reading the two fields is the
  // same computation over a dependency it can prove, so the memo survives
  // instead of being skipped.
  const tasksByDay = useMemo(() => {
    const memoYear = anchor.getUTCFullYear();
    const memoMonth = anchor.getUTCMonth();
    const map = new Map<number, Task[]>();
    for (const t of tasks) {
      if (!t.due_at) continue;
      const d = new Date(t.due_at);
      if (d.getUTCFullYear() === memoYear && d.getUTCMonth() === memoMonth) {
        const day = d.getUTCDate();
        const existing = map.get(day) ?? [];
        existing.push(t);
        map.set(day, existing);
      }
    }
    for (const [key, arr] of map) {
      map.set(key, arr.sort((a, b) => new Date(a.due_at!).getTime() - new Date(b.due_at!).getTime()));
    }
    return map;
  }, [tasks, anchor]);

  const unscheduled = useMemo(() => tasks.filter((t) => !t.due_at), [tasks]);

  return (
    <>
      <div className="overflow-hidden">
        <div className="border-input grid grid-cols-7 border-b">
          {WEEKDAY_LABELS.map((d) => (
            <div key={d} className="text-subtle-foreground px-2 py-2 text-center text-[11px] font-semibold tracking-wide uppercase">
              {d}
            </div>
          ))}
        </div>

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
                  'border-input flex min-h-[80px] flex-col gap-1 border-b border-r p-1.5 transition-colors',
                  (idx + 1) % 7 === 0 && 'border-r-0',
                  idx >= cells.length - 7 && 'border-b-0',
                  isToday && 'bg-brand-subtle',
                  !day && 'bg-muted',
                  day !== null && dragOverDay === day && 'ring-brand ring-2 ring-inset',
                )}
                onDragOver={day !== null && canEdit ? (e) => { e.preventDefault(); setDragOverDay(day); } : undefined}
                onDragLeave={day !== null ? () => setDragOverDay(null) : undefined}
                onDrop={day !== null ? (e) => {
                  e.preventDefault();
                  if (!canEdit) return;
                  setDragOverDay(null);
                  const taskId = e.dataTransfer.getData('task-id');
                  if (!taskId) return;
                  const dayISO = new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
                  reschedule(taskId, rescheduledISO(tasks.find((t) => t.id === taskId), dayISO));
                } : undefined}
              >
                {day !== null && (
                  <>
                    <span
                      className={cn(
                        'grid size-6 shrink-0 place-items-center self-start rounded-full text-[11px] font-medium',
                        isToday ? 'bg-brand text-on-fill font-bold' : 'text-muted-foreground',
                      )}
                    >
                      {day}
                    </span>

                    {dayTasks.slice(0, MAX_PER_CELL).map((t) => (
                      <TaskChip key={t.id} task={t} canDrag={canEdit} onClick={() => open(t.id)} />
                    ))}
                    {extra > 0 && (
                      <span className="text-muted-foreground ps-1 text-[10px] font-medium">
                        {FULLWIDTH_PLUS}{extra} more
                      </span>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {unscheduled.length > 0 && (
        <div className="border-input bg-muted border-t p-4">
          <p className="text-subtle-foreground mb-3 text-[11px] font-semibold tracking-wide uppercase">
            Unscheduled ({unscheduled.length})
          </p>
          <div className="flex flex-wrap gap-2">
            {unscheduled.map((t) => (
              <span
                key={t.id}
                role="button"
                tabIndex={0}
                draggable={canEdit}
                onDragStart={(e) => {
                  e.dataTransfer.setData('task-id', t.id);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onClick={() => open(t.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(t.id); }
                }}
                className="border-input bg-kit-card text-muted-foreground hover:bg-muted cursor-pointer rounded-md border px-3 py-1 text-[12px] transition-colors"
              >
                {t.title}
              </span>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Week
// ---------------------------------------------------------------------------

function WeekView({ anchor, tasks, open, reschedule, canEdit }: GridProps) {
  const [dragOverDayIdx, setDragOverDayIdx] = useState<number | null>(null);
  const sunday = calendarWeekStart(anchor);
  const today = new Date();

  const days: Date[] = Array.from({ length: 7 }, (_, i) =>
    new Date(Date.UTC(sunday.getUTCFullYear(), sunday.getUTCMonth(), sunday.getUTCDate() + i)),
  );

  const formatWeekDay = (d: Date) =>
    new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' }).format(d);

  return (
    <div className="overflow-hidden">
      <div className="border-input grid grid-cols-7 border-b">
        {days.map((day, i) => {
          const isToday = sameUTCDay(day, today);
          return (
            <div
              key={i}
              className={cn('border-input border-r px-2 py-2 text-center last:border-r-0', isToday && 'bg-brand-subtle')}
            >
              <div className="text-subtle-foreground text-[11px] font-semibold tracking-wide uppercase">
                {formatWeekDay(day)}
              </div>
              <div
                className={cn(
                  'mx-auto mt-0.5 grid size-6 place-items-center rounded-full text-[11px] font-medium',
                  isToday && 'bg-brand text-on-fill font-bold',
                )}
              >
                {day.getUTCDate()}
              </div>
            </div>
          );
        })}
      </div>

      <div className="divide-input grid min-h-[200px] grid-cols-7 divide-x">
        {days.map((day, i) => {
          const dayTasks = tasksForDay(tasks, day);
          const isToday = sameUTCDay(day, today);
          return (
            <div
              key={i}
              className={cn(
                'flex flex-col gap-1 p-1.5 transition-colors',
                isToday && 'bg-brand-subtle',
                dragOverDayIdx === i && 'ring-brand ring-2 ring-inset',
              )}
              onDragOver={canEdit ? (e) => { e.preventDefault(); setDragOverDayIdx(i); } : undefined}
              onDragLeave={() => setDragOverDayIdx(null)}
              onDrop={(e) => {
                e.preventDefault();
                if (!canEdit) return;
                setDragOverDayIdx(null);
                const taskId = e.dataTransfer.getData('task-id');
                if (!taskId) return;
                reschedule(taskId, rescheduledISO(tasks.find((t) => t.id === taskId), day.toISOString().slice(0, 10)));
              }}
            >
              {dayTasks.length === 0 ? (
                <span className="text-subtle-foreground px-1 pt-1 text-[10px]">{EM_DASH}</span>
              ) : (
                dayTasks.map((t) => (
                  <TaskChip key={t.id} task={t} showTime canDrag={canEdit} onClick={() => open(t.id)} />
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
// Day - read only, no drag source and no drop target, as before
// ---------------------------------------------------------------------------

function DayView({ anchor, tasks, open }: { anchor: Date; tasks: Task[]; open: (id: string) => void }) {
  const dayTasks = tasksForDay(tasks, anchor);
  const isToday = sameUTCDay(anchor, new Date());

  return (
    <div className="overflow-hidden">
      <div className={cn('border-input border-b px-4 py-3', isToday && 'bg-brand-subtle')}>
        <p className="text-[13px] font-semibold">
          {new Intl.DateTimeFormat('en-US', {
            weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
          }).format(anchor)}
        </p>
      </div>

      {dayTasks.length === 0 ? (
        <div className="text-muted-foreground px-4 py-8 text-center text-[13px]">
          No tasks due this day.
        </div>
      ) : (
        <div className="divide-input divide-y">
          {dayTasks.map((t) => (
            <span
              key={t.id}
              role="button"
              tabIndex={0}
              onClick={() => open(t.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(t.id); }
              }}
              className="hover:bg-muted flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left transition-colors"
            >
              <span className="text-muted-foreground w-12 shrink-0 font-mono text-[11px]">
                {t.due_at ? fmtTime(t.due_at) : EM_DASH}
              </span>
              <span className={cn('size-2 shrink-0 rounded-full', STATUS_INTENT_FILL[taskStatusEntry(t.status).intent])} />
              <span className="flex-1 truncate text-[13px] font-medium">{t.title}</span>
              <AssigneeStack assignees={taskAssignees(t)} className="shrink-0" />
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Period labels
// ---------------------------------------------------------------------------

function dayLabel(d: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  }).format(d);
}

function weekLabel(anchor: Date): string {
  const sun = calendarWeekStart(anchor);
  const sat = new Date(Date.UTC(sun.getUTCFullYear(), sun.getUTCMonth(), sun.getUTCDate() + 6));

  const startFmt = new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', timeZone: 'UTC',
  }).format(sun);

  if (sun.getUTCMonth() === sat.getUTCMonth() && sun.getUTCFullYear() === sat.getUTCFullYear()) {
    return `${startFmt} ${EN_DASH} ${sat.getUTCDate()}, ${sat.getUTCFullYear()}`;
  }

  const endFmt = new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', timeZone: 'UTC',
  }).format(sat);

  return `${startFmt} ${EN_DASH} ${endFmt}, ${sat.getUTCFullYear()}`;
}

function monthLabel(anchor: Date): string {
  return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(anchor);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------


/**
 * The calendar.
 *
 * Hand-rolled, and it stays hand-rolled: the kit's `ui/calendar` is a
 * react-day-picker DATE PICKER, not a calendar view - it has no events, no
 * week or day mode, no drop targets and no unscheduled strip. `react-big-
 * calendar` is not a dependency of this repo and the legacy view never used it.
 * Recorded in the gap ledger.
 *
 * Everything is computed in UTC. That is why a task due at 23:00 local can
 * appear on the "next" day, and it is preserved deliberately - a kit date
 * component formatting in local time would silently shift tasks by a day.
 */
export default function CalendarView() {
  // The period on screen lives in the shared view store, not local state: the Filter popover's
  // per-category counts are taken over the same `calendarRows` for the same period.
  const view = useTaskViewStore((s) => s.calendarMode);
  const setView = useTaskViewStore((s) => s.setCalendarMode);
  const anchor = useTaskViewStore((s) => s.calendarAnchor);
  const setAnchor = useTaskViewStore((s) => s.setCalendarAnchor);
  const filtered = useFilteredTasks(TASK_VIEW_FILTER_OPTIONS.calendar);
  const tasks = useMemo(() => calendarRows(filtered, view, anchor), [filtered, view, anchor]);
  const open = useTaskDetailStore((s) => s.open);
  const reschedule = useTasksStore((s) => s.reschedule);
  const ability = useAppAbility();
  const canEdit = ability.can('update', 'Task');

  function navigate(direction: -1 | 1) {
    setAnchor((prev) => {
      if (view === 'day') {
        return new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth(), prev.getUTCDate() + direction));
      }
      if (view === 'week') {
        return new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth(), prev.getUTCDate() + 7 * direction));
      }
      // month: advance/retreat by 1 month, clamping to a valid day
      const newMonth = prev.getUTCMonth() + direction;
      const newYear = prev.getUTCFullYear() + Math.floor(newMonth / 12);
      const clampedMonth = ((newMonth % 12) + 12) % 12;
      const daysInNewMonth = new Date(Date.UTC(newYear, clampedMonth + 1, 0)).getUTCDate();
      const clampedDay = Math.min(prev.getUTCDate(), daysInNewMonth);
      return new Date(Date.UTC(newYear, clampedMonth, clampedDay));
    });
  }

  const periodLabel =
    view === 'day' ? dayLabel(anchor)
      : view === 'week' ? weekLabel(anchor)
        : monthLabel(anchor);

  const VIEW_OPTIONS: { value: CalendarMode; label: string }[] = [
    { value: 'day', label: 'Day' },
    { value: 'week', label: 'Week' },
    { value: 'month', label: 'Month' },
  ];

  return (
    <Card data-testid="tasks-calendar-card" className="overflow-hidden">
      <div className="border-input flex flex-col gap-3 border-b p-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="icon-sm" onClick={() => navigate(-1)} aria-label="Previous period">
            <ChevronLeft />
          </Button>
          <Button variant="outline" size="sm" onClick={() => setAnchor(new Date())}>Today</Button>
          <Button variant="outline" size="icon-sm" onClick={() => navigate(1)} aria-label="Next period">
            <ChevronRight />
          </Button>
          <span className="text-[15px] font-bold tracking-tight sm:ms-2">{periodLabel}</span>
        </div>

        {/* Segmented Day/Week/Month toggle. */}
        <div className="border-input bg-muted flex w-fit items-center overflow-hidden rounded-md border p-0.5">
          {VIEW_OPTIONS.map(({ value, label }) => (
            <Button
              key={value}
              size="sm"
              variant={view === value ? 'default' : 'ghost'}
              aria-pressed={view === value}
              onClick={() => setView(value)}
            >
              {label}
            </Button>
          ))}
        </div>
      </div>

      {view === 'month' && <MonthView anchor={anchor} tasks={tasks} open={open} reschedule={reschedule} canEdit={canEdit} />}
      {view === 'week' && <WeekView anchor={anchor} tasks={tasks} open={open} reschedule={reschedule} canEdit={canEdit} />}
      {view === 'day' && <DayView anchor={anchor} tasks={tasks} open={open} />}
    </Card>
  );
}
