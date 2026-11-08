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
 * `<Checkbox` with no `className` prop at all - zero size-shaped overrides,
 * zero overrides of any kind. No rung minted; `size` is not added.
 */
const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      // data-[state=indeterminate] mirrors the checked treatment exactly: a partial
      // select-all reads as "partly on", not "off".
      "grid place-content-center peer h-4 w-4 shrink-0 rounded border border-border ring-offset-surface-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-on-fill data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-on-fill",
      className
    )}
    {...props}
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
  </CheckboxPrimitive.Root>
))
Checkbox.displayName = CheckboxPrimitive.Root.displayName

export { Checkbox }
