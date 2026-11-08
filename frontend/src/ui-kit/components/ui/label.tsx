import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";

import { cn } from "@/ui-kit/lib/utils";

function Label({
  className,
  ...props
}: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        "text-[13px] font-semibold leading-none select-none",
        // Dim alongside a disabled control, in both nesting shapes.
        "peer-disabled:cursor-not-allowed peer-disabled:opacity-60",
        "group-data-[disabled=true]:opacity-60",
        className,
      )}
      {...props}
    />
  );
}

export { Label };
