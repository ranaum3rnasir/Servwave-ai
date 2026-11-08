"use client";

import * as React from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { MessageSquare, Paperclip } from "lucide-react";

import { cn } from "@/ui-kit/lib/utils";
import { Avatar } from "@/ui-kit/components/ui/avatar";
import {
  CardLabel, PriorityIcon, WorkTypeIcon, type Priority, type WorkType,
} from "./kanbanCardMeta";

export interface KanbanItem {
  id: string;
  columnId: string;
  /** The work itself - the largest text on the card. */
  summary: string;
  /** Stable human reference, e.g. "JOB-223". */
  key: string;
  customer?: string;
  type: WorkType;
  priority: Priority;
  labels?: string[];
  /** Estimate in hours; renders as the points pill. */
  estimate?: number;
  assignee?: string | null;
  comments?: number;
  attachments?: number;
}

export interface KanbanCardProps {
  item: KanbanItem;
  isOverlay?: boolean;
  onOpen?: (item: KanbanItem) => void;
}

/**
 * A board card with a fixed anatomy: labels, summary, customer, then one
 * meta row.
 *
 * The meta row is always the same order, right-aligned - type, key … activity,
 * priority, estimate, assignee. That consistency is the entire point: scanning
 * down a column compares like with like, so nobody has to read a card to
 * triage it.
 */
function KanbanCard({ item, isOverlay, onOpen }: KanbanCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    data: { type: "card", columnId: item.columnId },
    disabled: isOverlay,
  });

  return (
    <article
      ref={isOverlay ? undefined : setNodeRef}
      style={isOverlay ? undefined : { transform: CSS.Translate.toString(transform), transition }}
      {...(isOverlay ? {} : attributes)}
      {...(isOverlay ? {} : listeners)}
      onClick={onOpen ? () => onOpen(item) : undefined}
      aria-label={`${item.key}: ${item.summary}`}
      className={cn(
        "bg-kit-card touch-none rounded-md px-2.5 pt-2.5 pb-2 shadow-card transition-[box-shadow,transform]",
        "hover:shadow-card-hover focus-visible:ring-[3px] focus-visible:ring-ring/25 focus-visible:outline-none",
        !isOverlay && "cursor-grab active:cursor-grabbing",
        isDragging && "opacity-45",
        isOverlay && "rotate-[1.5deg] cursor-grabbing shadow-modal",
      )}
    >
      {item.labels?.length ? (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {item.labels.map((id) => <CardLabel key={id} id={id} />)}
        </div>
      ) : null}

      <p className="text-[13.5px] leading-snug font-medium">{item.summary}</p>

      {item.customer && (
        <p className="text-subtle-foreground mt-1 truncate text-[11.5px]">{item.customer}</p>
      )}

      <div className="mt-2.5 flex items-center gap-2">
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <WorkTypeIcon type={item.type} />
          <span className="text-subtle-foreground text-[11.5px] font-bold tracking-wide">{item.key}</span>
        </span>

        <span className="ms-auto inline-flex items-center gap-1.5">
          {item.comments ? (
            <span className="text-subtle-foreground inline-flex items-center gap-0.5 text-[11px] font-semibold"
              title={`${item.comments} comments`}>
              <MessageSquare className="size-3.5" />{item.comments}
            </span>
          ) : null}
          {item.attachments ? (
            <span className="text-subtle-foreground inline-flex items-center gap-0.5 text-[11px] font-semibold"
              title={`${item.attachments} attachments`}>
              <Paperclip className="size-3.5" />{item.attachments}
            </span>
          ) : null}
          <PriorityIcon level={item.priority} />
          {item.estimate != null && (
            <span
              title={`${item.estimate} hour estimate`}
              className="bg-muted text-muted-foreground grid h-4.5 min-w-5 place-items-center rounded-full px-1.5 text-[10.5px] font-bold"
            >
              {item.estimate}
            </span>
          )}
          {item.assignee
            ? <Avatar name={item.assignee} size="xs" />
            : <span title="Unassigned" className="border-input block size-6 shrink-0 rounded-full border-[1.5px] border-dashed" />}
        </span>
      </div>
    </article>
  );
}

export { KanbanCard };
