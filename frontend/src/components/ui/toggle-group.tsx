import * as React from "react"
import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const toggleGroupVariants = cva("inline-flex items-center", {
  variants: {
    variant: {
      segmented:
        "gap-1 rounded-pill border border-border bg-background-light p-1",
      pill: "flex-wrap gap-2",
    },
  },
  defaultVariants: {
    variant: "segmented",
  },
})

const toggleGroupItemVariants = cva(
  "rounded-pill px-3 py-1.5 text-sm font-medium text-text-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
  {
    variants: {
      variant: {
        segmented:
          "data-[state=on]:bg-surface-light data-[state=on]:text-text-primary data-[state=on]:shadow-soft",
        pill: "border border-border data-[state=on]:border-transparent data-[state=on]:bg-primary data-[state=on]:text-on-fill",
      },
    },
    defaultVariants: {
      variant: "segmented",
    },
  }
)

export type ToggleGroupProps = React.ComponentPropsWithoutRef<
  typeof ToggleGroupPrimitive.Root
> &
  VariantProps<typeof toggleGroupVariants>

const ToggleGroup = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Root>,
  ToggleGroupProps
>(({ className, variant, ...props }, ref) => (
  <ToggleGroupPrimitive.Root
    ref={ref}
    className={cn(toggleGroupVariants({ variant }), className)}
    {...props}
  />
))
ToggleGroup.displayName = ToggleGroupPrimitive.Root.displayName

export interface ToggleGroupItemProps
  extends React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Item>,
    VariantProps<typeof toggleGroupItemVariants> {}

const ToggleGroupItem = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Item>,
  ToggleGroupItemProps
>(({ className, variant, ...props }, ref) => (
  <ToggleGroupPrimitive.Item
    ref={ref}
    className={cn(toggleGroupItemVariants({ variant }), className)}
    {...props}
  />
))
ToggleGroupItem.displayName = ToggleGroupPrimitive.Item.displayName

export { ToggleGroup, ToggleGroupItem }
