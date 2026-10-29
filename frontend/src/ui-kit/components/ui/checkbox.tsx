import * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check, Minus } from "lucide-react";

import { cn } from "@/ui-kit/lib/utils";

/**
 * Radix handles the a11y contract and the indeterminate state, which matters
 * for "select all" in a table: pass checked="indeterminate" when some but not
 * all rows are selected.
 *
 * Hit area (mobile slice 25, rubric TOUCH-01/TOUCH-02). The box you see stays
 * 16 px everywhere; the button around it is the target. It is 24 px with a fine
 * pointer (WCAG 2.5.8's minimum) and 44 px on a coarse one (`touch:`), and its
 * negative margins give back exactly what it adds, so the checkbox still takes
 * 16 px of layout and nothing beside it moves. The box is styled from the
 * button's state through the named group `group/checkbox`.
 */
function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer group/checkbox relative inline-grid shrink-0 place-items-center cursor-pointer rounded-[4px]",
        "size-6 -m-1 touch:size-11 touch:-m-3.5",
        "focus-visible:outline-none disabled:cursor-not-allowed",
        className,
      )}
      {...props}
    >
      <span
        data-slot="checkbox-box"
        aria-hidden="true"
        className={cn(
          "pointer-events-none grid size-4 place-items-center rounded-[4px] border border-input bg-kit-card shadow-xs",
          "transition-[background-color,border-color] duration-150",
          "group-hover/checkbox:border-brand",
          "group-focus-visible/checkbox:ring-[3px] group-focus-visible/checkbox:ring-ring/25",
          "group-data-[state=checked]/checkbox:bg-brand group-data-[state=checked]/checkbox:border-brand group-data-[state=checked]/checkbox:text-on-fill",
          "group-data-[state=indeterminate]/checkbox:bg-brand group-data-[state=indeterminate]/checkbox:border-brand group-data-[state=indeterminate]/checkbox:text-on-fill",
          "group-disabled/checkbox:opacity-50",
          "group-aria-[invalid=true]/checkbox:border-destructive",
        )}
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
      </span>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
