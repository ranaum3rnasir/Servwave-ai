"use client"

import * as React from "react"
import * as SwitchPrimitives from "@radix-ui/react-switch"

import { cn } from "@/lib/utils"

/**
 * Switch - phase 8g (program plan
 * md_files/plans/frontend/2026-07-27-ui-component-architecture-program.md:973,
 * "Calendar, Separator, Checkbox, Switch, Badge -> size where demand
 * exists") checked this primitive for `size` demand and found none. 19
 * files import Switch (18 excluding the design-system mockup page, which
 * is not a real call site); every real `<Switch` usage passes only
 * `checked`/`disabled`/`onCheckedChange`/`aria-label`/`id` - zero
 * `className` overrides on any of them, so there is no size-shaped
 * signature to point at. No rung minted; `size` is not added.
 */
const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    className={cn(
      "peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-pill border transition-colors duration-[400ms] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface-light disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-transparent data-[state=checked]:bg-primary data-[state=unchecked]:border-border data-[state=unchecked]:bg-surface-light",
      className
    )}
    {...props}
    ref={ref}
  >
    <SwitchPrimitives.Thumb
      className={cn(
        "pointer-events-none block h-5 w-5 rounded-pill bg-on-fill shadow-soft ring-0 transition-transform duration-[400ms] data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-px"
      )}
    />
  </SwitchPrimitives.Root>
))
Switch.displayName = SwitchPrimitives.Root.displayName

export { Switch }
