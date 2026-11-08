"use client";

import * as React from "react";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { MoreHorizontal, Plus } from "lucide-react";

import { cn } from "@/ui-kit/lib/utils";
import { Button } from "@/ui-kit/components/ui/button";

export interface KanbanColumnProps extends React.ComponentProps<"section"> {
  id: string;
  title: string;
  count: number;
  /** Soft cap. Exceeding it warns rather than blocks - a stage that refuses
      work just pushes it somewhere less visible. */
  wipLimit?: number;
  itemIds: string[];
  /** True while a card hovers this column; renders the drop slot. */
  isOver?: boolean;
  onAdd?: () => void;
}

/**
 * One board stage.
 *
 * Fixed width with its own scroll - columns that grow with their contents make
 * the board jump horizontally every time a card moves.
 *
 * The drop affordance is a dashed slot rather than a highlighted column,
 * because it answers a different question: *where the card lands*, not merely
 * that the column will accept it.
 */
function KanbanColumn({
  className, id, title, count, wipLimit, itemIds, isOver, onAdd, children, ...props
}: KanbanColumnProps) {
  const { setNodeRef } = useDroppable({ id, data: { type: "column" } });
  const overLimit = wipLimit != null && count > wipLimit;

  return (
    <section
      data-slot="kanban-column"
      aria-label={`${title}, ${count} items`}
      className={cn(
        "bg-column flex max-h-full w-72 shrink-0 flex-col rounded-[10px] transition-colors",
        isOver && "bg-column-active",
        className,
      )}
      {...props}
    >
      <header className="flex shrink-0 items-center gap-2 px-3 pt-3 pb-2">
        <h3 className="text-muted-foreground truncate text-[11.5px] font-bold tracking-[0.06em] uppercase">
          {title}
        </h3>
        <span className={cn(
          "text-subtle-foreground shrink-0 text-[11.5px] font-semibold",
          overLimit && "text-destructive font-bold",
        )}>
          {count}{wipLimit != null && ` / ${wipLimit}`}
        </span>
        <Button
          variant="ghost" size="icon-sm"
          className="text-subtle-foreground hover:bg-kit-card ms-auto size-6 opacity-0 transition-opacity group-hover/column:opacity-100 focus-visible:opacity-100"
        >
          <MoreHorizontal /><span className="sr-only">{title} column actions</span>
        </Button>
      </header>

      {overLimit && (
        <p className="bg-status-red-subtle text-status-red-emphasis mx-3 mb-2 rounded-md px-2 py-1.5 text-[11.5px] leading-snug font-semibold">
          Over the {wipLimit}-item limit for this stage.
        </p>
      )}

      <div ref={setNodeRef} className="flex min-h-15 flex-1 flex-col gap-1.5 overflow-y-auto px-2 pb-1.5">
        <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
          {children}
        </SortableContext>

        {isOver && (
          <div aria-hidden className="border-brand bg-brand-subtle h-16 shrink-0 rounded-md border-2 border-dashed opacity-65" />
        )}

        {count === 0 && !isOver && (
          <p className="text-subtle-foreground px-1 py-5 text-center text-[12px]">No items in this stage</p>
        )}
      </div>

      {onAdd && (
        <Button
          variant="ghost" size="sm" onClick={onAdd}
          className="text-muted-foreground hover:bg-kit-card mx-2 mb-2 shrink-0 justify-start"
        >
          <Plus />Create
        </Button>
      )}
    </section>
  );
}

export { KanbanColumn };
