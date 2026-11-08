"use client"

import * as React from "react"
import * as SelectPrimitive from "@radix-ui/react-select"
import { cva, type VariantProps } from "class-variance-authority"
import { Check, ChevronDown, ChevronUp } from "lucide-react"

import { cn } from "@/lib/utils"

const Select = SelectPrimitive.Root

const SelectGroup = SelectPrimitive.Group

const SelectValue = SelectPrimitive.Value

/* =============================================================================
   SelectTrigger - W2 `size`.
   -----------------------------------------------------------------------------
   46 `<SelectTrigger` call sites across 30 files (grep across frontend/src,
   excluding components/ui/**, pages/prototype/**, pages/design-system/** and
   test files - matches the program plan's SelectTrigger row exactly). Three
   real height rungs showed up in call-site `className` overrides:

     h-9  (36px) x8 sites / 4 files  - TaskFilterBar.tsx, TrainingView.tsx,
                                        TotalsFooter.tsx, LineItemRow.tsx
                                        (non-dense branch) - mostly paired
                                        with text-sm, i.e. the base string's
                                        own font, so no font override needed
     h-11 (44px) x4 sites / 3 files  - StopIfForm.tsx, WaitForm.tsx (x2),
                                        DateModePanel.tsx - height only
     h-8  (32px) x3 sites / 3 files  - TaskDetailDrawer.tsx, JobDetailPage.tsx,
                                        LineItemRow.tsx (dense branch) - two of
                                        the three pair it with text-xs

   `size="md"` is the remaining ~29 of 46 sites' implicit, unstyled default
   and MUST NOT MOVE. `xs`/`sm`/`lg` are additive rungs for the three real
   non-default heights above. Two smaller heights (h-7 x2, h-6 x1) showed up
   too but neither clears the 3+ site bar on its own, so they stay individual
   className overrides rather than a 5th rung.

   `size` is declared in a cva() block, same shape as Input's phase-8a `size`
   (components/ui/input.tsx): for `size="md"` the variant class is an empty
   string, so cva's own `cx` (clsx) call drops it entirely and the emitted
   class list is byte-identical to what this file rendered before this change
   - verified in __tests__/select.test.tsx.
   ============================================================================= */

const selectTriggerVariants = cva(
  "flex h-10 w-full items-center justify-between rounded border border-border bg-surface-light px-3 py-2 text-sm ring-offset-surface-light data-[placeholder]:text-text-secondary focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1",
  {
    variants: {
      size: {
        // Today's default geometry, already carried by the base string
        // above. Empty on purpose - see the header note on why this keeps
        // `md` byte-identical to the pre-size-prop render.
        md: "",
        // 32px rung. The 2-of-3 majority call-site signature pairs h-8 with
        // text-xs (TaskDetailDrawer.tsx, LineItemRow.tsx dense branch), so
        // this rung does the same - text-xs wins over the base string's
        // text-sm via tailwind-merge's conflict resolution.
        xs: "h-8 text-xs",
        // 36px rung. Height only - the h-9 call sites overwhelmingly kept
        // text-sm (the base string's own font), so `sm` leaves it alone.
        sm: "h-9",
        // 44px rung. Height only - none of the h-11 call sites touched font
        // size.
        lg: "h-11",
      },
    },
    defaultVariants: {
      size: "md",
    },
  }
)

/**
 * `tone` values. W2/8's rename schedule (program plan section 2a.11) points
 * this axis at "`sage` -> `business`", the same conversion Input's own
 * `tone` gets (components/ui/input.tsx) - see its doc comment for the full
 * reasoning (no `--business` token in tokens.css yet, so the primitive
 * `border-sage-200 text-sage-700` string is unchanged, only the prop name
 * moves). `sage` stays as a deprecated alias for the exact same class string
 * so the one real call site that already passes it
 * (components/jobs/items/ReceiptCard.tsx:610) keeps rendering byte-for-byte
 * identical output.
 */
export type SelectTriggerTone = "default" | "sage" | "business"

const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger> &
    VariantProps<typeof selectTriggerVariants> & {
      /** Same contract as Input's `invalid` - a validation error, not a colour. */
      invalid?: boolean
      /**
       * The sage-tinted deposit box treatment (ReceiptCard), matching
       * Input's own `tone`. `business` is the closed-vocabulary value;
       * `sage` is a deprecated alias for the exact same class string - see
       * the `SelectTriggerTone` doc comment above.
       */
      tone?: SelectTriggerTone
    }
>(({ className, invalid, tone = "default", size, children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(
      selectTriggerVariants({ size }),
      (tone === "sage" || tone === "business") && "border-sage-200 text-sage-700",
      invalid && "border-danger",
      className
    )}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild>
      <ChevronDown className="h-4 w-4 opacity-50" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
))
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName

const SelectScrollUpButton = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.ScrollUpButton>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollUpButton>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollUpButton
    ref={ref}
    className={cn(
      "flex cursor-default items-center justify-center py-1",
      className
    )}
    {...props}
  >
    <ChevronUp className="h-4 w-4" />
  </SelectPrimitive.ScrollUpButton>
))
SelectScrollUpButton.displayName = SelectPrimitive.ScrollUpButton.displayName

const SelectScrollDownButton = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.ScrollDownButton>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollDownButton>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollDownButton
    ref={ref}
    className={cn(
      "flex cursor-default items-center justify-center py-1",
      className
    )}
    {...props}
  >
    <ChevronDown className="h-4 w-4" />
  </SelectPrimitive.ScrollDownButton>
))
SelectScrollDownButton.displayName =
  SelectPrimitive.ScrollDownButton.displayName

const SelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, position = "popper", ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      ref={ref}
      className={cn(
        "relative z-floating max-h-[--radix-select-content-available-height] min-w-[8rem] overflow-y-auto overflow-x-hidden rounded-card border border-border bg-surface-light text-text-primary shadow-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-[--radix-select-content-transform-origin]",
        // Cap to the width available on screen, and why `break-words` stays:
        // see the kit SelectContent (ui-kit/components/ui/select.tsx). Popper is
        // the default here and the only mode any call site uses.
        position === "popper" &&
          "data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1 max-w-[var(--radix-select-content-available-width)] break-words",
        className
      )}
      position={position}
      {...props}
    >
      <SelectScrollUpButton />
      <SelectPrimitive.Viewport
        className={cn(
          "p-1",
          position === "popper" &&
            "h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)]"
        )}
      >
        {children}
      </SelectPrimitive.Viewport>
      <SelectScrollDownButton />
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
))
SelectContent.displayName = SelectPrimitive.Content.displayName

const SelectLabel = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Label>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Label
    ref={ref}
    className={cn("py-1.5 pl-8 pr-2 text-sm font-semibold", className)}
    {...props}
  />
))
SelectLabel.displayName = SelectPrimitive.Label.displayName

const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex w-full cursor-default select-none items-center rounded py-1.5 pl-8 pr-2 text-sm outline-none focus:bg-primary-subtle focus:text-primary data-[state=checked]:bg-primary-subtle data-[state=checked]:text-primary data-[state=checked]:font-medium data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      // An unbroken label wraps inside the list - see the kit SelectItem
      // (ui-kit/components/ui/select.tsx) for why both classes are needed.
      "[&>span]:min-w-0 [&>span]:[overflow-wrap:anywhere]",
      className
    )}
    {...props}
  >
    <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
      <SelectPrimitive.ItemIndicator>
        <Check className="h-4 w-4" />
      </SelectPrimitive.ItemIndicator>
    </span>

    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
))
SelectItem.displayName = SelectPrimitive.Item.displayName

const SelectSeparator = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Separator
    ref={ref}
    className={cn("-mx-1 my-1 h-px bg-background-light", className)}
    {...props}
  />
))
SelectSeparator.displayName = SelectPrimitive.Separator.displayName

export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  selectTriggerVariants,
  SelectContent,
  SelectLabel,
  SelectItem,
  SelectSeparator,
  SelectScrollUpButton,
  SelectScrollDownButton,
}
