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
  // Hit area (mobile slice 25, rubric TOUCH-02): the 44x24 track is drawn inside
  // the switch button, which is 44 px tall on a coarse pointer (`touch:`); the
  // negative margins give the height back, so the layout does not move.
  <SwitchPrimitives.Root
    className={cn(
      "peer group/switch relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center justify-center rounded-pill touch:h-11 touch:-my-2.5 focus-visible:outline-none disabled:cursor-not-allowed",
      className
    )}
    {...props}
    ref={ref}
  >
    <span
      data-slot="switch-track"
      aria-hidden="true"
      className="pointer-events-none inline-flex h-6 w-11 shrink-0 items-center rounded-pill border transition-colors duration-[400ms] ring-offset-surface-light group-focus-visible/switch:ring-2 group-focus-visible/switch:ring-primary group-focus-visible/switch:ring-offset-2 group-disabled/switch:opacity-50 group-data-[state=checked]/switch:border-transparent group-data-[state=checked]/switch:bg-primary group-data-[state=unchecked]/switch:border-border group-data-[state=unchecked]/switch:bg-surface-light"
    >
      <SwitchPrimitives.Thumb
        className={cn(
          "pointer-events-none block h-5 w-5 rounded-pill bg-on-fill shadow-soft ring-0 transition-transform duration-[400ms] data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-px"
        )}
      />
    </span>
  </SwitchPrimitives.Root>
))
Switch.displayName = SwitchPrimitives.Root.displayName

export { Switch }
