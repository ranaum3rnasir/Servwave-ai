import * as React from "react";

import { cn } from "@/ui-kit/lib/utils";

/**
 * Label/value rows for a record summary - the detail panel of a drawer, the
 * body of a card.
 *
 * A real <dl>, so the pairing is in the markup rather than implied by layout.
 * Values are right-aligned and tabular by default: down a column, "$12,400"
 * and "$3,200" line up on the decimal instead of drifting.
 */
function DescriptionList({ className, ...props }: React.ComponentProps<"dl">) {
  return <dl data-slot="description-list" className={cn("m-0", className)} {...props} />;
}

function DescriptionItem({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="description-item"
      className={cn(
        "flex items-baseline justify-between gap-3 border-t py-2 text-[13px] first:border-t-0",
        className,
      )}
      {...props}
    />
  );
}

function DescriptionTerm({ className, ...props }: React.ComponentProps<"dt">) {
  return (
    <dt
      data-slot="description-term"
      className={cn("text-muted-foreground m-0 shrink-0 font-medium", className)}
      {...props}
    />
  );
}

function DescriptionDetails({ className, ...props }: React.ComponentProps<"dd">) {
  return (
    <dd
      data-slot="description-details"
      className={cn("m-0 text-right font-semibold tabular-nums", className)}
      {...props}
    />
  );
}

export { DescriptionList, DescriptionItem, DescriptionTerm, DescriptionDetails };
