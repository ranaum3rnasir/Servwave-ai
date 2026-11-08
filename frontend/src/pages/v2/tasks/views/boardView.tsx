import { useCallback, useMemo, useRef, useState } from 'react';
import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor,
  closestCorners, useSensor, useSensors,
  type DragEndEvent, type DragOverEvent, type DragStartEvent,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import { useTasksStore } from '@/stores/tasksStore';
import { TASK_VIEW_FILTER_OPTIONS, useFilteredTasks } from '@/lib/tasks/useFilteredTasks';
import { assessRisk, assigneeOpenCountFor, assigneeOpenCounts } from '@/lib/tasks/tasks-logic';
import { BOARD_TASK_STATUSES, isCompletedTaskStatus, isTerminalTaskStatus, type Task, type TaskStatus } from '@/lib/tasks/types';
import { BOARD_DONE_WINDOW_DAYS, closedBeforeBoardWindow, hasBoardLane } from '@/lib/tasks/taskViewRows';
import { STATUS_REGISTRY } from '@/design-system/status-registry';

import { KanbanColumn } from '@/ui-kit/components/crm/kanbanBoard/kanbanColumn';

import { TaskCard } from '../components/taskCard';
import { WARN } from '../components/glyphs';

/** The At Risk lane is a derived view, not a status - nothing can be dropped into it. */
const AT_RISK = 'AT_RISK';

/**
 * Stops a card from being "revealed" by anything outside the board.
 *
 * dnd-kit ends EVERY drop by revealing the card the drag came from:
 * `useDropAnimation` calls `scrollIntoViewIfNeeded(activeNode)`, which - when
 * that card's rect is fully outside the viewport - calls the NATIVE
 * `scrollIntoView({ block: 'center', inline: 'center' })` on it.
 *
 * That call takes no container and cannot be scoped. It walks EVERY scroll
 * container between the card and the document and centres the card in each one.
 * An `overflow: hidden` box IS a scroll container - it simply has no scrollbar -
 * so the app frame and the page's own scroller are moved along with the lane.
 * What the user sees is the shell scrolled off its own origin: the sidebar
 * clipped past the left edge, the top bar above the top one, and nothing that
 * puts either back.
 *
 * The card's rect really is outside the viewport for the drop this fixes.
 * Dragging out past the last lane auto-scrolls the track - the one thing
 * `canScroll` below permits - and once the track has travelled far enough, the
 * lane the card started in has left the screen on the left. That is dnd-kit's
 * own test for "needs revealing": `right <= 0`.
 *
 * So the node answers the call itself and scrolls nothing. Nothing needs
 * revealing: the card is where the user just left it. The KeyboardSensor reveals
 * a card the same way when it is lifted, and that one is redundant too - the
 * browser has already scrolled the card into view in order to focus it.
 *
 * An OWN property, so it shadows `Element.prototype` for this node alone and
 * every other element on the page keeps the real method.
 */
function absorbReveal(node: HTMLElement | null) {
  if (node) node.scrollIntoView = () => {};
}

/**
 * One draggable card.
 *
 * `useSortable`'s `attributes` bring `role="button"`, `tabIndex={0}` and
 * `aria-roledescription`, which is what makes the KEYBOARD path exist at all:
 * Tab to a card, Space to lift, arrow keys to move, Space to drop. The legacy
 * board's native HTML5 drag had no keyboard path whatsoever, so this is
 * strictly additive.
 */
function SortableTaskCard({ task, risk }: { task: Task; risk: ReturnType<typeof assessRisk> }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { type: 'card' },
  });

  const setCardRef = useCallback(
    (node: HTMLDivElement | null) => {
      absorbReveal(node);
      setNodeRef(node);
    },
    [setNodeRef],
  );

  return (
    <div
      ref={setCardRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      {...attributes}
      {...listeners}
      className={isDragging ? 'touch-none opacity-45' : 'touch-none'}
    >
      <TaskCard task={task} riskResult={risk} />
    </div>
  );
}

/**
 * The board.
 *
 * The behaviour map claims this view has no drag and drop. It does - native
 * HTML5 `dataTransfer`, added after the map was written - so moving to dnd-kit
 * REPLACES an interaction rather than inventing one, and adds the keyboard path
 * HTML5 DnD cannot have.
 *
 * The kit's own `KanbanBoard` is not used, only its `KanbanColumn`: the board
 * component hardcodes `KanbanCard`, whose `KanbanItem` requires a
 * `type: WorkType` a task does not have and has no slot for a due date or a
 * risk badge. Driving it would mean painting every task with a fabricated
 * "Emergency callout" glyph. The column, which is where the board's chrome
 * actually lives, composes cleanly. Both are recorded in the gap ledger.
 *
 * The At Risk lane is an EXCLUSIVE partition: an unfinished task whose
 * `assessRisk(...).atRisk` is true appears there and is absent from its status
 * column. It is also not a drop target - a drop that resolves to it is a no-op,
 * exactly as the legacy lane (which carried no drop handler) behaved.
 *
 * CANCELLED has no lane at all (issue 03) and cancelled tasks are dropped from
 * the board entirely: this board is for work in flight, and abandoned work is
 * read on the History tab. There is therefore no way to cancel a task by
 * dragging - the drawer's status control is where that lives.
 */
export default function BoardView() {
  // The Board is a personal work surface, so it shows what the signed-in user is on rather
  // than the whole org - which is what an ADMIN's API scope would otherwise hand it. A member
  // filter overrides this; see useFilteredTasks.
  const tasks = useFilteredTasks(TASK_VIEW_FILTER_OPTIONS.board);
  const updateStatus = useTasksStore((s) => s.updateStatus);
  const [activeId, setActiveId] = useState<string | null>(null);
  /** Which lane the card is currently over, so that lane can say so. */
  const [overColumn, setOverColumn] = useState<string | null>(null);

  const sensors = useSensors(
    // 8px so a click on a card still opens the drawer rather than registering
    // as a drag - the kit's own KanbanBoard uses the same constraint.
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  /** The lane track - the one element on this page that may scroll sideways. */
  const trackRef = useRef<HTMLDivElement>(null);

  /**
   * Which containers dnd-kit may auto-scroll while a card is held near an edge.
   *
   * Its ancestor resolution does NOT prefer the nearest scroller, so without
   * this the board has no say in what moves. `getScrollableAncestors` appends
   * `document.scrollingElement` unconditionally - it never asks whether the
   * document is scrollable - and the default `TraversalOrder.TreeOrder` then
   * walks that list OUTERMOST FIRST and stops at the first container reporting
   * a speed. The order it actually tries is
   *
   *     document -> .canvas-body -> this track -> a lane
   *
   * so the track, the only one that should ever move, is tried last.
   *
   * What keeps that from biting today is not this board: the document cannot
   * scroll (`html, body, #root { overflow: hidden }` in index.css) and the
   * canvas cannot scroll horizontally, so dnd-kit's own end-of-range guard
   * skips both. Neither fact belongs to the board, and losing either one -
   * a canvas that stops clipping, a page that lets the document grow - drags
   * the entire app shell sideways instead of the lanes, sidebar and topbar
   * included. Naming the track makes the containment this board's guarantee
   * rather than a coincidence two other files are holding up.
   *
   * `contains`, not an identity check: each lane is its own vertical scroller
   * inside the track, and dragging to the top or bottom of a long lane still
   * has to scroll it.
   */
  const canScroll = useCallback(
    (element: Element) => trackRef.current?.contains(element) ?? false,
    [],
  );

  // Per-ASSIGNEE, so a task held by three people counts against all three.
  // The shared helper rather than a local loop: the board's risk badges and the
  // dashboard's At Risk card have to agree, and they only do that if they count
  // the same way.
  const assigneeOpen = useMemo(() => assigneeOpenCounts(tasks), [tasks]);

  const { atRiskTasks, byStatus, riskByTask, doneHidden } = useMemo(() => {
    const atRisk: Task[] = [];
    const cols: Record<string, Task[]> = {};
    for (const s of BOARD_TASK_STATUSES) cols[s] = [];
    const riskMap = new Map<string, ReturnType<typeof assessRisk>>();
    // eslint-disable-next-line react-hooks/purity -- the Done window is measured from the moment the lanes are rebuilt, and it has to be: pinning it at mount (a ref, or useState(() => Date.now())) freezes the 7-day edge, so a task that closed 7 days ago mid-session keeps its card and the "closed earlier" count below stays wrong until remount. `assessRisk` on the next line reads the same wall clock per rebuild, and "now" here must be ONE clock.
    const now = new Date();
    let hidden = 0;

    // Which tasks get a card at all is `hasBoardLane` / `closedBeforeBoardWindow` (lib/tasks/
    // taskViewRows), the same rule the Filter popover counts with.
    for (const t of tasks) {
      const risk = assessRisk(t, { now, assigneeOpenCount: assigneeOpenCountFor(t, assigneeOpen) });
      riskMap.set(t.id, risk);
      // A cancelled task has no lane and no At Risk claim - `assessRisk` already
      // scores every terminal task 0, so this only stops it reaching `cols`.
      if (!hasBoardLane(t)) continue;
      if (risk.atRisk && !isTerminalTaskStatus(t.status)) { atRisk.push(t); continue; }
      // A task closed outside the Done window drops off the lane, onto History.
      if (closedBeforeBoardWindow(t, now)) { hidden += 1; continue; }
      cols[t.status]!.push(t);
    }
    return { atRiskTasks: atRisk, byStatus: cols, riskByTask: riskMap, doneHidden: hidden };
  }, [tasks, assigneeOpen]);

  const allColumns = [
    { key: AT_RISK, label: `${WARN} At Risk`, tasks: atRiskTasks },
    ...BOARD_TASK_STATUSES.map((s) => ({ key: s as string, label: STATUS_REGISTRY.task[s]?.label ?? s, tasks: byStatus[s] ?? [] })),
  ];

  const activeTask = activeId ? tasks.find((t) => t.id === activeId) ?? null : null;

  /** Which column does this droppable/sortable id belong to? */
  const columnOf = (id: string): string | undefined => {
    if (allColumns.some((c) => c.key === id)) return id;
    const t = tasks.find((x) => x.id === id);
    if (!t) return undefined;
    return riskByTask.get(t.id)?.atRisk && !isTerminalTaskStatus(t.status) ? AT_RISK : t.status;
  };

  // Which lane the pointer is over, recomputed as it moves. Without this the
  // board gave no feedback at all during a drag - no highlight, no drop slot -
  // and a drag that shows nothing is indistinguishable from one that is not
  // working, which is exactly how it was reported.
  const onDragOver = (event: DragOverEvent) => {
    const landed = event.over ? columnOf(String(event.over.id)) : undefined;
    setOverColumn(landed && landed !== AT_RISK ? landed : null);
  };

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    setOverColumn(null);
    if (!over) return;

    const landed = columnOf(String(over.id));
    // AT_RISK is derived, not a status - a drop there changes nothing, which is
    // what the legacy lane did by simply not being a drop target.
    if (!landed || landed === AT_RISK) return;

    const task = tasks.find((t) => t.id === String(active.id));
    if (!task || task.status === landed) return;
    void updateStatus(task.id, landed as TaskStatus);
  };

  const onDragStart = (event: DragStartEvent) => setActiveId(String(event.active.id));

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      autoScroll={{ canScroll }}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={() => { setActiveId(null); setOverColumn(null); }}
    >
      {/* A BOUNDED, self-scrolling board.
          It used to grow with its tallest lane, which put the page's own
          scrollbar in charge: Done ran hundreds of cards long, the board became
          several screens tall, and the two lanes on the right sat off the
          bottom-right of a very large page. Dragging a card to one of them
          meant dragging into empty space and hoping. Capping the height keeps
          all five lanes on screen and gives each its own scroll, which is what
          makes the drag reachable. */}
      {/* The chrome above the board - page header, filter row, tab strip - is a
          fixed height, so the board can claim the rest of the viewport. The
          `min-h` is the floor: on a short window the subtraction alone leaves
          columns barely one card tall, which is worse than letting the page
          scroll, so below that height it stops shrinking and the canvas takes
          over. */}
      <div
        ref={trackRef}
        className="flex h-[calc(100vh-var(--v2-board-chrome))] min-h-[34rem] items-stretch gap-2.5 overflow-x-auto pb-2.5 [--v2-board-chrome:340px]"
      >
        {allColumns.map((col) => (
          <KanbanColumn
            key={col.key}
            className="group/column"
            id={col.key}
            title={col.label}
            count={col.tasks.length}
            itemIds={col.tasks.map((t) => t.id)}
            isOver={overColumn === col.key}
          >
            {col.tasks.map((t) => (
              // The status Select that used to sit under every card is gone.
              // It duplicated the status badge already on the card, it put a
              // full-width control between one card and the next so the lane
              // read as twice as long as it was, and changing a value with it
              // moved the card to another lane while the dropdown stayed put -
              // so the control you had just used was suddenly attached to a
              // different task. Drag, the card menu and the detail drawer all
              // still set status.
              <SortableTaskCard key={t.id} task={t} risk={riskByTask.get(t.id)!} />
            ))}

            {isCompletedTaskStatus(col.key) && doneHidden > 0 && (
              <p className="text-subtle-foreground px-1 pt-1 pb-2 text-center text-[11.5px]">
                {doneHidden} closed earlier than the last {BOARD_DONE_WINDOW_DAYS} days are on the History tab.
              </p>
            )}
          </KanbanColumn>
        ))}
      </div>

      {/* Portal-like layer so the moving card is not clipped by a column's own
          overflow - the kit board's reasoning, and it applies here too. */}
      <DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.18,0.67,0.6,1.22)' }}>
        {activeTask && <TaskCard task={activeTask} riskResult={riskByTask.get(activeTask.id)} />}
      </DragOverlay>
    </DndContext>
  );
}
