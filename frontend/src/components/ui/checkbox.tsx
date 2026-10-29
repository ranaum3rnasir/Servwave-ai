import * as React from "react"
import * as CheckboxPrimitive from "@radix-ui/react-checkbox"
import { Check, Minus } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Checkbox - phase 8g (program plan
 * md_files/plans/frontend/2026-07-27-ui-component-architecture-program.md:973,
 * "Calendar, Separator, Checkbox, Switch, Badge -> size where demand
 * exists") checked this primitive for `size` demand and found none. All 15
 * real importing files (excluding this file's own tests/stories) render
 * the checkbox with no `className` prop at all - zero size-shaped overrides,
 * zero overrides of any kind. No rung minted; `size` is not added.
 *
 * Hit area (mobile slice 25, rubric TOUCH-01/TOUCH-02): the 16 px box you see
 * sits inside a 24 px target with a fine pointer and a 44 px one on a coarse
 * pointer (`touch:`); the negative margins give back what the target adds, so
 * the layout keeps its 16 px footprint. Same shape as the kit Checkbox.
 */
const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      "peer group/checkbox relative inline-grid shrink-0 place-items-center rounded",
      "size-6 -m-1 touch:size-11 touch:-m-3.5",
      "focus-visible:outline-none disabled:cursor-not-allowed",
      className
    )}
    {...props}
  >
    <span
      data-slot="checkbox-box"
      aria-hidden="true"
      className={cn(
        // data-[state=indeterminate] mirrors the checked treatment exactly: a partial
        // select-all reads as "partly on", not "off".
        "pointer-events-none grid size-4 place-content-center rounded border border-border ring-offset-surface-light",
        "group-focus-visible/checkbox:ring-2 group-focus-visible/checkbox:ring-primary group-focus-visible/checkbox:ring-offset-2",
        "group-disabled/checkbox:opacity-50",
        "group-data-[state=checked]/checkbox:bg-primary group-data-[state=checked]/checkbox:text-on-fill",
        "group-data-[state=indeterminate]/checkbox:bg-primary group-data-[state=indeterminate]/checkbox:text-on-fill"
      )}
    >
      <CheckboxPrimitive.Indicator
        className={cn("grid place-content-center text-current")}
      >
        {props.checked === "indeterminate" ? (
          <Minus className="h-4 w-4" />
        ) : (
          <Check className="h-4 w-4" />
        )}
      </CheckboxPrimitive.Indicator>
    </span>
  </CheckboxPrimitive.Root>
))
Checkbox.displayName = CheckboxPrimitive.Root.displayName

export { Checkbox }
