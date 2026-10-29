import * as React from "react";

import { cn } from "@/ui-kit/lib/utils";

/**
 * Loading placeholder. Give it the dimensions of the content it stands in for
 * so the layout doesn't jump when real data arrives.
 *
 *   <Skeleton className="h-4 w-32" />
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("bg-muted animate-pulse rounded-md", className)}
      // Placeholders are noise to a screen reader; the live region announces.
      aria-hidden
      {...props}
    />
  );
}

export { Skeleton };
