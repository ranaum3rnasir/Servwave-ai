import * as React from "react";

import { cn } from "@/ui-kit/lib/utils";

/**
 * Vertical activity rail. An ordered list, because the sequence is the content.
 *
 * The connecting line is drawn per-item and suppressed on the last one, so the
 * rail ends at the final marker instead of trailing into whitespace - a small
 * thing that reads as unfinished when it's wrong.
 */
function Timeline({ className, ...props }: React.ComponentProps<"ol">) {
  return (
    <ol
      data-slot="timeline"
      className={cn("relative m-0 list-none pl-5", className)}
      {...props}
    />
  );
}

function TimelineItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="timeline-item"
      className={cn(
        "relative pb-4 last:pb-0",
        // marker
        "before:bg-brand before:ring-brand-subtle before:absolute before:top-[5px] before:-left-[14px]",
        "before:size-[7px] before:rounded-full before:ring-[3px] before:content-['']",
        // connector, hidden on the last item
        "after:bg-border after:absolute after:top-3.5 after:bottom-0 after:-left-[11px]",
        "after:w-px after:content-[''] last:after:hidden",
        className,
      )}
      {...props}
    />
  );
}

function TimelineContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="timeline-content"
      className={cn("text-[12.5px] leading-relaxed [&_b]:font-bold", className)}
      {...props}
    />
  );
}

function TimelineTime({ className, ...props }: React.ComponentProps<"time">) {
  return (
    <time
      data-slot="timeline-time"
      className={cn("text-subtle-foreground mt-0.5 block text-[11.5px]", className)}
      {...props}
    />
  );
}

export { Timeline, TimelineItem, TimelineContent, TimelineTime };
