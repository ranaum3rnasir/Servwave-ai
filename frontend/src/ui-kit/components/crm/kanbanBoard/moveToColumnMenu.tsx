"use client";

import { ArrowRightLeft } from "lucide-react";

import { cn } from "@/ui-kit/lib/utils";
import { Button } from "@/ui-kit/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger,
} from "@/ui-kit/components/ui/dropdownMenu";

export interface MoveToColumnMenuProps {
  /** The card's own name, for the control's accessible name. */
  itemLabel: string;
  /** Every column a card can be moved to, in board order. */
  columns: Array<{ id: string; label: string }>;
  /** The card's column now; it is not offered. */
  currentColumnId: string;
  onMove: (columnId: string) => void;
  className?: string;
}

/**
 * "Move to column": the tap alternative to dragging a card (WCAG 2.5.7, rubric TOUCH-10).
 *
 * It sits BESIDE the card, never inside it: the card is the drag activator (`role="button"`), and
 * a button inside a button is announced badly and swallowed by the card's own press handling.
 * The menu lists every other column; choosing one moves the card exactly as a drop there would.
 */
function MoveToColumnMenu({ itemLabel, columns, currentColumnId, onMove, className }: MoveToColumnMenuProps) {
  const targets = columns.filter((c) => c.id !== currentColumnId);
  if (targets.length === 0) return null;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Move "${itemLabel}" to another column`}
          className={cn("text-muted-foreground", className)}
        >
          <ArrowRightLeft />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Move to column</DropdownMenuLabel>
        {targets.map((c) => (
          <DropdownMenuItem key={c.id} onSelect={() => onMove(c.id)}>
            {c.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export { MoveToColumnMenu };
