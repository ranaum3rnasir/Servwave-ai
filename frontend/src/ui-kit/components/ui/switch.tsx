import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";

import { cn } from "@/ui-kit/lib/utils";

function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-5.5 w-9.5 shrink-0 items-center rounded-full border border-transparent shadow-xs cursor-pointer",
        "transition-colors duration-150",
        "bg-input data-[state=checked]:bg-brand",
        "focus-visible:ring-[3px] focus-visible:ring-ring/25 focus-visible:outline-none",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block size-4.5 rounded-full bg-on-fill shadow-sm ring-0",
          "transition-transform duration-150",
          "translate-x-0.5 data-[state=checked]:translate-x-4.5",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
