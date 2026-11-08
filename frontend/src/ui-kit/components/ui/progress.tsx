import * as React from "react";
import * as ProgressPrimitive from "@radix-ui/react-progress";

import { cn } from "@/ui-kit/lib/utils";

/**
 * Determinate progress. Use past roughly ten seconds - that is the point where
 * "something is happening" stops being enough and people need to know how much
 * is left. Below that, a spinner or skeleton is less noisy.
 */
function Progress({
  className,
  value,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn("bg-muted relative h-1.5 w-full overflow-hidden rounded-full", className)}
      value={value}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="bg-brand h-full w-full flex-1 rounded-full transition-transform duration-150 ease-linear"
        style={{ transform: `translateX(-${100 - (value ?? 0)}%)` }}
      />
    </ProgressPrimitive.Root>
  );
}

export { Progress };
