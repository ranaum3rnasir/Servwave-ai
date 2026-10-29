"use client";

import * as React from "react";
import { Check } from "lucide-react";

import { cn } from "@/ui-kit/lib/utils";
import { useOverlayPresentation } from "@/ui-kit/hooks/useOverlayPresentation";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/ui-kit/components/ui/dropdownMenu";
import {
  Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle, SheetTrigger,
} from "@/ui-kit/components/ui/sheet";

/**
 * A short choice - a status, a stage, a handful of labels - mobile slice 44 (story 51, CMP-05).
 *
 * At md and up it is the dropdown menu it always was, hanging off its trigger. Below md it is a
 * bottom sheet (the overlay presentation of the "choice" intent): a menu under a thumb sits
 * wherever the trigger happens to be, often at the top of the page, so the sheet brings the
 * options to the bottom edge instead, one 44 px row each, with the current one checked.
 *
 * The options are data, not children, because a Radix menu item cannot live in a sheet and the
 * two layouts have to offer exactly the same rows in the same order. Exactly one variant mounts.
 */
export interface ChoiceOption {
  key: string;
  label: React.ReactNode;
  /** Plain-text name for the type-ahead / accessible name when `label` is not a string. */
  textValue?: string;
  /** Leading mark (a status dot). */
  icon?: React.ReactNode;
  /** The value now in effect: checked. */
  current?: boolean;
  /** Trailing text or mark after the label (e.g. a word saying this is the current one). */
  suffix?: React.ReactNode;
  disabled?: boolean;
  /**
   * Shown but not pickable, and still reachable: `aria-disabled="true"` rather than `disabled`, so
   * the row stays focusable (a keyboard user can land on it and its `wrap` tooltip can open) and
   * choosing it neither runs `onSelect` nor closes the menu. Use `disabled` for a row that should
   * drop out of the tab order altogether.
   */
  locked?: boolean;
  destructive?: boolean;
  /** A rule above this row. */
  separatorBefore?: boolean;
  /** Visible under the label, e.g. why a row is off. The sheet shows this and never `title`: a touch screen has no tooltip. */
  note?: React.ReactNode;
  /** Hover text for the desktop menu row only. */
  title?: string;
  /**
   * Wraps the desktop menu row, e.g. in a tooltip. Handed the row element; return it, wrapped.
   * Never applied to the bottom sheet: a touch screen has no hover to open it.
   */
  wrap?: (row: React.ReactElement) => React.ReactElement;
  onSelect: () => void;
}

interface ChoiceMenuProps {
  /** Names the sheet (and its heading) and the menu: what is being chosen, e.g. "Sub-status". */
  title: string;
  /** The control that opens it; one ref-accepting element (it is handed to `asChild`). */
  trigger: React.ReactElement;
  options: readonly ChoiceOption[];
  align?: "start" | "center" | "end";
  /** Desktop menu panel class (a width). */
  contentClassName?: string;
}

export function ChoiceMenu({ title, trigger, options, align = "start", contentClassName }: ChoiceMenuProps) {
  const presentation = useOverlayPresentation("choice");
  const [open, setOpen] = React.useState(false);

  if (presentation === "bottom-sheet") {
    const choose = (option: ChoiceOption) => {
      // A locked row does nothing and leaves the sheet open, so the person can pick another.
      if (option.disabled || option.locked) return;
      setOpen(false);
      option.onSelect();
    };
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>{trigger}</SheetTrigger>
        <SheetContent side="bottom" aria-describedby={undefined} className="rounded-t-xl gap-0">
          <SheetHeader>
            <SheetTitle>{title}</SheetTitle>
          </SheetHeader>
          <SheetBody className="p-2">
            <ul className="flex flex-col">
              {options.map((option) => (
                <li key={option.key} className={cn(option.separatorBefore && "mt-1 border-t pt-1")}>
                  <button
                    type="button"
                    disabled={option.disabled}
                    aria-current={option.current ? "true" : undefined}
                    aria-disabled={option.locked ? "true" : undefined}
                    onClick={() => choose(option)}
                    className={cn(
                      "flex min-h-11 w-full items-center gap-3 rounded-md px-3 py-2 text-left text-[15px] font-medium",
                      "active:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/25 focus-visible:outline-none",
                      "disabled:pointer-events-none disabled:opacity-50",
                      option.locked && "cursor-not-allowed opacity-50 active:bg-transparent",
                      option.destructive && "text-destructive",
                      option.current && "font-semibold",
                    )}
                  >
                    {option.icon}
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span>{option.label}</span>
                      {option.note && <span className="text-muted-foreground text-xs font-normal">{option.note}</span>}
                    </span>
                    {option.suffix}
                    {option.current && <Check className="text-brand size-4 shrink-0" aria-label="current" />}
                  </button>
                </li>
              ))}
            </ul>
          </SheetBody>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} aria-label={title} className={contentClassName}>
        {options.map((option) => {
          const item = (
            <DropdownMenuItem
              disabled={option.disabled}
              // Only a locked row sets its own: passing `undefined` would overwrite the aria-disabled
              // the menu primitive puts on a plain `disabled` row.
              {...(option.locked ? { "aria-disabled": "true" as const } : {})}
              title={option.title}
              textValue={option.textValue}
              variant={option.destructive ? "destructive" : "default"}
              // A locked row swallows its own selection: preventDefault keeps the menu open.
              onSelect={option.locked ? (event) => event.preventDefault() : undefined}
              onClick={option.disabled || option.locked ? undefined : option.onSelect}
              className={cn(
                option.icon && "gap-2.5",
                option.current && "font-semibold",
                option.locked && "cursor-not-allowed opacity-50",
              )}
            >
              {option.icon}
              <span className="flex min-w-0 flex-1 flex-col">
                <span>{option.label}</span>
                {option.note && <span className="text-muted-foreground whitespace-normal text-xs font-normal">{option.note}</span>}
              </span>
              {option.suffix}
              {option.current && <Check className="text-brand size-4 shrink-0" aria-label="current" />}
            </DropdownMenuItem>
          );
          return (
            <React.Fragment key={option.key}>
              {option.separatorBefore && <DropdownMenuSeparator />}
              {option.wrap ? option.wrap(item) : item}
            </React.Fragment>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
