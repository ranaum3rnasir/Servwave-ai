"use client";

import * as React from "react";
import { MoreHorizontal } from "lucide-react";

import { cn } from "@/ui-kit/lib/utils";
import { Avatar, AvatarGroup } from "@/ui-kit/components/ui/avatar";
import { Badge, type BadgeProps } from "@/ui-kit/components/ui/badge";
import { Button } from "@/ui-kit/components/ui/button";

export interface RecordCardProps extends React.ComponentProps<"div"> {
  title: string;
  subtitle?: string;
  status?: { label: string; tone: NonNullable<BadgeProps["variant"]> };
  /** Right-aligned figure - deal value, invoice total. Kept tabular. */
  amount?: string;
  meta?: React.ReactNode;
  assignees?: string[];
  showAvatar?: boolean;
  selected?: boolean;
  onOpenMenu?: (event: React.MouseEvent) => void;
}

/**
 * A record at a glance - the same shape whether it lands in a list, a kanban
 * column or a search result.
 *
 * Four fixed slots on purpose: title, subtitle, status, amount. Once a card
 * takes arbitrary children, every surface renders it slightly differently and
 * the pipeline stops being scannable. Extra detail goes in `meta`, which sits
 * below the divider where it can't disrupt the top line.
 */
function RecordCard({
  className, title, subtitle, status, amount, meta,
  assignees, showAvatar, selected, onOpenMenu, ...props
}: RecordCardProps) {
  return (
    <div
      data-slot="record-card"
      data-selected={selected || undefined}
      className={cn(
        "bg-kit-card group relative rounded-[10px] border p-3 transition-[border-color,box-shadow,transform]",
        props.onClick && "cursor-pointer hover:border-brand hover:shadow-md",
        "data-[selected=true]:border-brand data-[selected=true]:bg-selected",
        className,
      )}
      {...props}
    >
      <div className="flex items-start gap-2.5">
        {showAvatar && <Avatar name={title} size="sm" className="mt-0.5" />}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-semibold">{title}</div>
          {subtitle && (
            <div className="text-subtle-foreground mt-0.5 truncate text-[11.5px]">{subtitle}</div>
          )}
        </div>
        {onOpenMenu && (
          <Button
            variant="ghost"
            size="icon-sm"
            // Hidden until hover or focus - a menu button on every card turns a
            // board into a field of dots.
            className="text-subtle-foreground -me-1 -mt-1 size-7 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            onClick={(e) => { e.stopPropagation(); onOpenMenu(e); }}
          >
            <MoreHorizontal /><span className="sr-only">Open menu</span>
          </Button>
        )}
      </div>

      {(status || amount) && (
        <div className="mt-2.5 flex items-center gap-2">
          {status && <Badge variant={status.tone}>{status.label}</Badge>}
          {amount && <span className="ms-auto text-[13px] font-bold tabular-nums">{amount}</span>}
        </div>
      )}

      {(meta || assignees?.length) && (
        <div className="mt-2.5 flex items-center gap-2 border-t pt-2.5">
          <div className="text-muted-foreground min-w-0 flex-1 truncate text-[11.5px]">{meta}</div>
          {assignees?.length ? <AvatarGroup names={assignees} max={3} size="xs" /> : null}
        </div>
      )}
    </div>
  );
}

export { RecordCard };
