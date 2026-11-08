"use client";

import * as React from "react";
import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor,
  closestCorners, useSensor, useSensors,
  type DragEndEvent, type DragOverEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { arrayMove, sortableKeyboardCoordinates } from "@dnd-kit/sortable";

import { cn } from "@/ui-kit/lib/utils";
import { KanbanCard } from "./kanbanCard";
import { KanbanColumn } from "./kanbanColumn";

export type { KanbanItem } from "./kanbanCard";
import type { KanbanItem } from "./kanbanCard";

export interface KanbanColumnDef {
  id: string;
  title: string;
  wipLimit?: number;
}

export interface KanbanBoardProps {
  columns: KanbanColumnDef[];
  items: KanbanItem[];
  onItemsChange: (items: KanbanItem[]) => void;
  /** Called only when a card actually changes column - for the mutation. */
  onItemMoved?: (itemId: string, fromColumn: string, toColumn: string) => void;
  onAdd?: (columnId: string) => void;
  onOpenItem?: (item: KanbanItem) => void;
  className?: string;
}

/**
 * Pipeline board.
 *
 * dnd-kit rather than a mouse-event implementation: it ships a keyboard sensor,
 * so a card can be moved with Space + arrows + Space. HTML5 drag-and-drop and
 * hand-rolled pointer code both leave keyboard users with no path at all, and on
 * a board that is the primary interaction.
 *
 * An 8px activation distance keeps a click on a card from registering as a drag
 * - without it, opening a record becomes unreliable.
 */
function KanbanBoard({
  columns, items, onItemsChange, onItemMoved, onAdd, onOpenItem, className,
}: KanbanBoardProps) {
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [overColumn, setOverColumn] = React.useState<string | null>(null);
  const originColumn = React.useRef<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  /** The column track - the one element here that may scroll sideways. */
  const trackRef = React.useRef<HTMLDivElement>(null);

  /**
   * Confines drag auto-scroll to the track.
   *
   * dnd-kit resolves scroll containers OUTERMOST FIRST (`TraversalOrder.
   * TreeOrder`) and appends `document.scrollingElement` to that list without
   * ever checking whether it scrolls, so a card held near the viewport edge
   * reaches for the document and the page's own scroll container before it
   * reaches for this track. On a shell that clips (ours does) the result is
   * merely that nothing scrolls; on one that does not, the whole layout slides
   * sideways under the drag. Either way the board should be the thing that
   * decides, so it says so here.
   *
   * `contains` keeps each column's own vertical scroll working - the columns
   * live inside the track.
   */
  const canScroll = React.useCallback(
    (element: Element) => trackRef.current?.contains(element) ?? false,
    [],
  );

  const activeItem = items.find((item) => item.id === activeId) ?? null;
  const byColumn = React.useMemo(() => {
    const map = new Map<string, KanbanItem[]>();
    for (const column of columns) map.set(column.id, []);
    for (const item of items) map.get(item.columnId)?.push(item);
    return map;
  }, [columns, items]);

  const columnOf = (id: string) =>
    columns.some((c) => c.id === id) ? id : items.find((i) => i.id === id)?.columnId;

  const onDragStart = (event: DragStartEvent) => {
    const id = String(event.active.id);
    setActiveId(id);
    originColumn.current = items.find((i) => i.id === id)?.columnId ?? null;
  };

  /** Reassign on hover so the card previews in its new column while dragging. */
  const onDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) return;
    const from = columnOf(String(active.id));
    const to = columnOf(String(over.id));
    setOverColumn(to ?? null);
    if (!from || !to || from === to) return;
    onItemsChange(items.map((item) =>
      item.id === active.id ? { ...item, columnId: to } : item));
  };

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    setOverColumn(null);
    if (!over) return;

    const activeIndex = items.findIndex((i) => i.id === active.id);
    const overIndex = items.findIndex((i) => i.id === over.id);
    if (activeIndex !== -1 && overIndex !== -1 && activeIndex !== overIndex) {
      onItemsChange(arrayMove(items, activeIndex, overIndex));
    }

    const landed = columnOf(String(over.id));
    if (originColumn.current && landed && originColumn.current !== landed) {
      onItemMoved?.(String(active.id), originColumn.current, landed);
    }
    originColumn.current = null;
  };

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
      <div
        ref={trackRef}
        data-slot="kanban-board"
        className={cn("flex items-start gap-2.5 overflow-x-auto pb-2.5", className)}
      >
        {columns.map((column) => {
          const columnItems = byColumn.get(column.id) ?? [];
          return (
            <KanbanColumn
              key={column.id}
              className="group/column"
              id={column.id}
              title={column.title}
              wipLimit={column.wipLimit}
              count={columnItems.length}
              isOver={overColumn === column.id && activeId != null}
              itemIds={columnItems.map((item) => item.id)}
              onAdd={onAdd ? () => onAdd(column.id) : undefined}
            >
              {columnItems.map((item) => (
                <KanbanCard key={item.id} item={item} onOpen={onOpenItem} />
              ))}
            </KanbanColumn>
          );
        })}
      </div>

      {/* Rendered in a portal-like layer so the moving card isn't clipped by a
          column's overflow. */}
      <DragOverlay dropAnimation={{ duration: 180, easing: "cubic-bezier(0.18,0.67,0.6,1.22)" }}>
        {activeItem && <KanbanCard isOverlay item={activeItem} />}
      </DragOverlay>
    </DndContext>
  );
}

export { KanbanBoard };
