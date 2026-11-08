import * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check, Minus } from "lucide-react";

import { cn } from "@/ui-kit/lib/utils";

/**
 * Radix handles the a11y contract and the indeterminate state, which matters
 * for "select all" in a table: pass checked="indeterminate" when some but not
 * all rows are selected.
 */
function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer size-4 shrink-0 rounded-[4px] border border-input bg-kit-card shadow-xs cursor-pointer",
        "transition-[background-color,border-color] duration-150",
        "hover:border-brand",
        "focus-visible:ring-[3px] focus-visible:ring-ring/25 focus-visible:outline-none",
        "data-[state=checked]:bg-brand data-[state=checked]:border-brand data-[state=checked]:text-on-fill",
        "data-[state=indeterminate]:bg-brand data-[state=indeterminate]:border-brand data-[state=indeterminate]:text-on-fill",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "aria-invalid:border-destructive",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center text-current"
      >
        {props.checked === "indeterminate" ? (
          <Minus className="size-3 stroke-[3]" />
        ) : (
          <Check className="size-3 stroke-[3]" />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
