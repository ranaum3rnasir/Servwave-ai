"use client";

import * as React from "react";

import { cn } from "@/ui-kit/lib/utils";
import { useOverlayPresentation } from "@/ui-kit/hooks/useOverlayPresentation";
import {
  Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle,
} from "@/ui-kit/components/ui/sheet";

/**
 * Searchable pickers on a phone (mobile slice 44, CMP-07).
 *
 * A picker is a trigger, a search field and a list of results. As a popover it hangs off its
 * trigger, which is fine under a mouse and wrong under a thumb: the on-screen keyboard covers
 * the lower half of the screen, so the results shrink to a couple of rows and a popover inside
 * a dialog sits behind that dialog's scroll lock. Below md (and on a phone held sideways) a
 * picker is therefore a full-screen sheet: a titled header with a 44 px close, the search field
 * directly under it (above the keyboard), and the results filling the rest and scrolling by
 * touch.
 *
 * The decision is the overlay presentation (`overlayPresentation`, the one pure function every
 * overlay uses), asked with the "form" intent: a picker holds a text field, so it takes the same
 * full-screen layout a form does. Exactly one variant mounts - a picker renders EITHER its popover
 * OR this sheet, never both - so the DOM never holds two copies of the list:
 *
 *   const fullscreen = usePickerFullscreen();
 *   <Popover open={open} onOpenChange={setOpen}>
 *     <PopoverTrigger asChild>...</PopoverTrigger>
 *     {fullscreen
 *       ? <PickerFullscreen open={open} onOpenChange={setOpen} title="Customer">{body}</PickerFullscreen>
 *       : <PopoverContent>{body}</PopoverContent>}
 *   </Popover>
 *
 * The Popover root stays mounted in both layouts: it owns the trigger's aria state and click.
 * `fullscreen` also tells the body to let its results list fill the screen instead of capping
 * its height for a popover (`pickerListClass`).
 */
export function usePickerFullscreen(): boolean {
  return useOverlayPresentation("form") !== "card";
}

/** The class a results list takes in each layout: a height cap in a popover, the rest of the screen in the sheet. */
export function pickerListClass(fullscreen: boolean, popoverClass: string): string {
  return fullscreen ? "min-h-0 flex-1 max-h-none overflow-y-auto overscroll-contain" : popoverClass;
}

interface PickerFullscreenProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Names the dialog (and is the visible heading): what is being picked, e.g. "Customer". */
  title: string;
  children: React.ReactNode;
  className?: string;
  /** Same as Radix's: lets a picker keep itself open while a dialog it raised is on top of it. */
  onInteractOutside?: React.ComponentProps<typeof SheetContent>["onInteractOutside"];
}

export function PickerFullscreen({ open, onOpenChange, title, children, className, onInteractOutside }: PickerFullscreenProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent intent="form" aria-describedby={undefined} data-picker="fullscreen" className="gap-0" onInteractOutside={onInteractOutside}>
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
        </SheetHeader>
        {/* The only scroller is the results list inside `children`; this column just hands it the
            height left under the header and the search field. */}
        <SheetBody className={cn("flex min-h-0 flex-col overflow-hidden p-0", className)}>
          {children}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
