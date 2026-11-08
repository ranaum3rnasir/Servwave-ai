import * as React from "react"
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu"
import { Check, ChevronRight, Circle } from "lucide-react"
import { cva } from "class-variance-authority"

import { cn } from "@/lib/utils"

const DropdownMenu = DropdownMenuPrimitive.Root

const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger

const DropdownMenuGroup = DropdownMenuPrimitive.Group

const DropdownMenuPortal = DropdownMenuPrimitive.Portal

const DropdownMenuSub = DropdownMenuPrimitive.Sub

const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup

const DropdownMenuSubTrigger = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger> & {
    inset?: boolean
  }
>(({ className, inset, children, ...props }, ref) => (
  <DropdownMenuPrimitive.SubTrigger
    ref={ref}
    className={cn(
      "flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-background-light data-[state=open]:bg-background-light [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
      inset && "pl-8",
      className
    )}
    {...props}
  >
    {children}
    <ChevronRight className="ml-auto" />
  </DropdownMenuPrimitive.SubTrigger>
))
DropdownMenuSubTrigger.displayName =
  DropdownMenuPrimitive.SubTrigger.displayName

const DropdownMenuSubContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.SubContent
    ref={ref}
    className={cn(
      // Same height cap the top-level DropdownMenuContent below already
      // carries. A submenu lists whatever the caller has - the estimate tab
      // strip's "Copy from…" enumerates every sibling estimate on the lead, up
      // to fifty - and without a cap the panel grows past the viewport with no
      // way to reach the entries that fall off the bottom. Radix keeps
      // `--radix-dropdown-menu-content-available-height` up to date for
      // submenus exactly as it does for the root menu, so the panel caps at
      // whatever room the trigger leaves and scrolls the remainder.
      "z-50 max-h-[var(--radix-dropdown-menu-content-available-height)] min-w-[8rem] overflow-y-auto overflow-x-hidden rounded-md border border-border bg-surface-light p-1 text-text-primary shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-[--radix-dropdown-menu-content-transform-origin]",
      className
    )}
    {...props}
  />
))
DropdownMenuSubContent.displayName =
  DropdownMenuPrimitive.SubContent.displayName

/* =============================================================================
   DropdownMenuContent - W2 primitive vocabulary: `width`.

   Named `width`, not `size` - program plan section 2a rule 3: `size` is
   reserved for control height (the shared 24-44px ladder Button/Input/
   SelectTrigger use) and never means anything else on a primitive. A
   max-width scale is a different axis and does not get to reuse that word -
   the same rule dialog.tsx / sheet.tsx / popover.tsx apply to their own
   panel widths.

   Re-verified real DropdownMenuContent call sites across frontend/src (the
   program plan's phase-8c row cites "5" for this primitive - the same table
   entry that funded Dialog/Sheet/Popover's own width props; grep
   "DropdownMenuContent" frontend/src, excluding this file and
   dropdown-menu.stories.tsx, each site's className read by hand). 24 real
   call sites total: 11 carry an explicit width class, 13 carry none.

     w-48 x3   layout/Sidebar.tsx:128, communication/InboxPage.tsx:1239,
               reports/ActivityFilterBar.tsx:140
     w-56 x3   EstimateWorkspacePage.tsx:502, communication/InboxPage.tsx:1275,
               reports/ActivityFilterBar.tsx:61
     w-52 x2   layout/Header.tsx:258, LeadDetailPage.tsx:153
     w-60 x2   communication/shared/CommJobMenu.tsx:30,
               communication/phone/SmsInboxView.tsx:1089
     w-64 x1   communication/inbox/AiAssistMenu.tsx:151 (bundled with
               `overflow-hidden rounded-xl py-1` - a bespoke styled menu, not
               a plain width override)
   The other 13 sites (EstimateTabs, StepNode, LeadsPage, EstimatesPage,
   LeadDetailPage:883, InvoicesPage, JobsPage, CustomersPage,
   CustomerDetailPage x2, InvoiceDetailPage, JobDetailPage, WorkflowsHome)
   pass no width class at all and rely on today's content-driven default
   (`min-w-[8rem]`, no `w-*` class) - the single largest cohort.

   WHY `md` EMITS NO CLASS. Unlike DialogContent / SheetContent /
   PopoverContent, DropdownMenuContent never had a fixed width baked into
   its base string - `min-w-[8rem]` is a floor, not a size, so the
   primitive already grows to content. `width="md"` (the default) keeps that
   behaviour: it resolves to an empty string in the variant table, so a
   no-props render is byte-identical to what shipped before this change -
   the same non-negotiable rule dialog.tsx / sheet.tsx / popover.tsx each
   enforce for their own `md`.

   WIDTH (only the two 3+-occurrence repeated signatures get a named rung,
   the same bar section 1c's "signatures with >=3 occurrences" uses
   elsewhere in this plan):
     sm  w-48   the 3 sites listed above
     lg  w-56   the 3 sites listed above
   w-52 / w-60 (2 sites each) and w-64 (1 site, already bundled with other
   bespoke classes) fall short of that bar and keep using a className width
   override indefinitely - the same treatment popover.tsx gives its own
   below-threshold widths.

   `xs` IS DEFERRED, NOT IMPLEMENTED. No measured site sits below `sm` -
   w-48 is already the narrowest repeated signature found. Reserved by the
   closed vocabulary, not implemented here, matching popover.tsx's own
   `xs`.

   No `pad` / `variant` / `tone` / `gap` demand was found on this primitive
   in the same scan.
   ============================================================================= */

/**
 * DropdownMenu width. `xs` is reserved by the closed vocabulary but not
 * implemented on this primitive - see the header note above.
 */
export type DropdownMenuContentWidth = "sm" | "md" | "lg"

const dropdownMenuContentVariants = cva(
  "z-50 max-h-[var(--radix-dropdown-menu-content-available-height)] min-w-[8rem] overflow-y-auto overflow-x-hidden rounded-md border border-border bg-surface-light p-1 text-text-primary shadow-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-[--radix-dropdown-menu-content-transform-origin]",
  {
    variants: {
      // Width. `md` is empty on purpose - the base string above carries no
      // width class at all today, only the `min-w-[8rem]` floor, which is
      // what keeps the no-props render unchanged.
      width: {
        sm: "w-48",
        md: "",
        lg: "w-56",
      },
    },
    defaultVariants: {
      width: "md",
    },
  }
)

export interface DropdownMenuContentProps
  extends React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content> {
  /** Width. Defaults to "md" - no width class, today's content-driven default, unmoved. */
  width?: DropdownMenuContentWidth
}

const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Content>,
  DropdownMenuContentProps
>(({ className, sideOffset = 4, width, ...props }, ref) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(dropdownMenuContentVariants({ width }), className)}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
))
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName

/**
 * Colour, closed-vocabulary (program plan section 2a.2, rev 3: brand |
 * neutral | subtle | danger | success | warning | info | ai | business).
 * Only `danger` has measured demand on this primitive - what W2/8's rename
 * schedule (program plan section 2a.11) points `variant="destructive"` at
 * (14 of 82 real call sites - see `variant`'s own doc comment below). A
 * plain string constant carries its class (see `DANGER_CLASSES` below), not
 * a `Record<DropdownMenuItemTone, string>` lookup - a lookup keyed by a
 * single member has nothing left to branch on.
 *
 * VOCAB_V3 rule 1: "tone = colour ... no second word", and its own explicit
 * instruction that a prop doing something other than colour needs its own
 * name, not `tone`. This used to be a single 5-value prop
 * (default/strong/subtle/muted/danger) mixing this colour axis with a
 * non-colour readability axis - see `DropdownMenuItemReadability` below for
 * where that axis now lives, split out for exactly that reason.
 *
 * Not the same shape as badge.tsx's `intent`, which is a different case:
 * `intent` (a `StatusIntent`) is itself colour semantics end to end, so the
 * per-primitive scope table folds it directly into `tone` as a deprecated
 * alias ("Badge | variant=\"destructive\", intent | tone (intent folds into
 * tone)"). `readability` here is not colour at all - inherited/full-contrast/
 * dim text is a distinct axis from hue - so it cannot fold into `tone` the
 * same way; it needs its own name instead, which is what this split does.
 */
export type DropdownMenuItemTone = "danger"

const DANGER_CLASSES = "text-danger focus:bg-danger/10 focus:text-danger"

/**
 * Non-colour readability axis - kept as its OWN prop, not folded into
 * `tone`, per the rule cited on `DropdownMenuItemTone` above.
 * `default`/`strong`/`subtle` carry NO colour of their own (idle colour is
 * inherited from context, or a dim text-secondary - never a semantic hue),
 * only how loud the row reads; that is independent of whether `tone` is
 * also painting the row `danger`.
 *
 * Closed-vocabulary values only - VOCAB_V3: "'muted' is RENAMED to 'subtle'
 * everywhere ... muted is retired, do not use it as a value." `readability`
 * is a prop minted fresh this session, not a pre-existing axis carrying
 * forward call sites, so `muted` is not a selectable member of its own
 * type here (unlike `tone` below, which does carry pre-existing call
 * sites). The retired spelling survives only as a deprecated value on the
 * `tone` prop - see `DropdownMenuItemDeprecatedReadability` below - for the
 * two live call sites that already pass `tone="muted"`
 * (components/communication/shared/CommJobMenu.tsx:32, components/
 * communication/phone/SmsInboxView.tsx:1091).
 */
export type DropdownMenuItemReadability = "default" | "strong" | "subtle"

const ITEM_READABILITY: Record<DropdownMenuItemReadability, string> = {
  // Idle colour comes from context (inherited); focus already goes to
  // text-text-primary via the base classes below.
  default: "",
  // Always full-contrast, not just on focus - a handful of "More" menus
  // read as body text at rest rather than fading in only on hover.
  strong: "text-text-primary",
  // A disabled placeholder row ("No open jobs"). The closed-vocabulary name.
  subtle: "text-text-secondary",
}

/**
 * @deprecated Superset of `DropdownMenuItemReadability` that also accepts
 * the retired `"muted"` spelling. Exists ONLY to type the deprecated `tone`
 * prop's accepted values (see `DropdownMenuItemDeprecatedTone` below) so
 * the two live call sites above that pass `tone="muted"` keep resolving
 * without a type error - `muted` maps to the same `subtle` class string at
 * render time (see the resolution in `DropdownMenuItem` below). Never
 * exposed as the `readability` prop's own type - see that type's comment
 * for why.
 */
type DropdownMenuItemDeprecatedReadability = DropdownMenuItemReadability | "muted"

/**
 * @deprecated Before this split, `tone` carried BOTH the colour axis above
 * and this readability axis merged into one 5-value union - the VOCAB_V3
 * violation this type documents rather than repeats. Kept only so the
 * `tone` prop below can keep accepting these values, for its existing
 * readability-shaped call sites (components/communication/inbox/
 * AiAssistMenu.tsx:168 and components/communication/InboxPage.tsx, x4,
 * pass `tone="strong"`; components/communication/shared/CommJobMenu.tsx:32
 * and components/communication/phone/SmsInboxView.tsx:1091 pass
 * `tone="muted"`) without breaking them. New code should use the
 * `readability` prop instead - and even then, only its closed-vocabulary
 * values (`default`/`strong`/`subtle`), never `muted`.
 */
type DropdownMenuItemDeprecatedTone = DropdownMenuItemDeprecatedReadability

const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & {
    inset?: boolean
    /**
     * @deprecated use `tone="danger"` instead. Kept so the 14 real call
     * sites still on disk (StepNode.tsx, LeadDetailPage.tsx x4,
     * EstimateWorkspacePage.tsx x3, CustomerDetailPage.tsx,
     * JobDetailPage.tsx x2, InvoiceDetailPage.tsx and 3 more - program plan
     * section 2a.11: "14 of 82") keep rendering byte-identical output.
     * Ignored whenever `tone` is also passed explicitly.
     */
    variant?: "default" | "destructive"
    /**
     * Colour. `danger` is the current, closed-vocabulary value - the
     * delete / cancel / remove action, byte-identical to the class string
     * `variant === "destructive"` used to produce. The remaining accepted
     * values (`default`/`strong`/`subtle`/`muted`) are @deprecated - they
     * are this component's old, pre-split readability values, kept live
     * only for the existing call sites named on
     * `DropdownMenuItemDeprecatedTone`'s own comment; use the `readability`
     * prop for that axis in new code. Wins over the deprecated `variant`
     * prop whenever passed explicitly, even to one of those legacy
     * non-danger values - the same precedent ConfirmDialog and Toast's own
     * `tone`/`variant` pairs use.
     */
    tone?: DropdownMenuItemTone | DropdownMenuItemDeprecatedTone
    /**
     * Non-colour readability. Closed-vocabulary only
     * (`default`/`strong`/`subtle` - see `DropdownMenuItemReadability`'s
     * own comment for why `muted` is not one of this prop's values, even
     * though it is still reachable through the deprecated `tone` prop).
     * Defaults to "default" (inherits from context). Wins over a legacy
     * readability value riding in on the deprecated `tone` prop whenever
     * both are passed.
     */
    readability?: DropdownMenuItemReadability
  }
>(({ className, inset, variant = "default", tone: toneProp, readability: readabilityProp, ...props }, ref) => {
  // `tone` wins over the deprecated `variant` whenever passed explicitly,
  // even to a non-danger (legacy readability) value - the same precedent
  // ConfirmDialog and Toast's own tone/variant pairs use.
  const isDanger = toneProp !== undefined ? toneProp === "danger" : variant === "destructive"
  // Named `readability`, not `resolvedReadability` - the
  // storybook-completeness guard (design-system/__tests__/
  // storybook-completeness.test.ts) reads the identifier immediately
  // inside `ITEM_READABILITY[...]` as this axis's public prop name, and
  // every story below writes literal `readability=` values, not
  // `resolvedReadability=`. The explicit `readability` prop wins over a
  // legacy readability value riding in on the deprecated `tone` prop;
  // falls back to "default" when neither is passed, or when `tone="danger"`
  // is the only tone-shaped value present - `danger` owns the pixel
  // outright via `isDanger` below, so readability is never consulted then.
  // A legacy `tone="muted"` is folded to `"subtle"` here, at the one
  // resolution point - `muted` never becomes a `DropdownMenuItemReadability`
  // value, closed-vocabulary or otherwise, past this line.
  const legacyReadability = toneProp !== undefined && toneProp !== "danger" ? toneProp : undefined
  const readability: DropdownMenuItemReadability =
    readabilityProp ?? (legacyReadability === "muted" ? "subtle" : legacyReadability) ?? "default"
  return (
    <DropdownMenuPrimitive.Item
      ref={ref}
      className={cn(
        "relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors focus:bg-background-light focus:text-text-primary data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
        isDanger ? DANGER_CLASSES : ITEM_READABILITY[readability],
        inset && "pl-8",
        className
      )}
      {...props}
    />
  )
})
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName

const DropdownMenuCheckboxItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>
>(({ className, children, checked, ...props }, ref) => (
  <DropdownMenuPrimitive.CheckboxItem
    ref={ref}
    className={cn(
      "relative flex cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none transition-colors focus:bg-background-light focus:text-text-primary data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      className
    )}
    checked={checked}
    {...props}
  >
    <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
      <DropdownMenuPrimitive.ItemIndicator>
        <Check className="h-4 w-4" />
      </DropdownMenuPrimitive.ItemIndicator>
    </span>
    {children}
  </DropdownMenuPrimitive.CheckboxItem>
))
DropdownMenuCheckboxItem.displayName =
  DropdownMenuPrimitive.CheckboxItem.displayName

const DropdownMenuRadioItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.RadioItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioItem>
>(({ className, children, ...props }, ref) => (
  <DropdownMenuPrimitive.RadioItem
    ref={ref}
    className={cn(
      "relative flex cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none transition-colors focus:bg-background-light focus:text-text-primary data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      className
    )}
    {...props}
  >
    <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
      <DropdownMenuPrimitive.ItemIndicator>
        <Circle className="h-2 w-2 fill-current" />
      </DropdownMenuPrimitive.ItemIndicator>
    </span>
    {children}
  </DropdownMenuPrimitive.RadioItem>
))
DropdownMenuRadioItem.displayName = DropdownMenuPrimitive.RadioItem.displayName

const DropdownMenuLabel = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label> & {
    inset?: boolean
  }
>(({ className, inset, ...props }, ref) => (
  <DropdownMenuPrimitive.Label
    ref={ref}
    className={cn(
      "px-2 py-1.5 text-sm font-semibold",
      inset && "pl-8",
      className
    )}
    {...props}
  />
))
DropdownMenuLabel.displayName = DropdownMenuPrimitive.Label.displayName

const DropdownMenuSeparator = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Separator
    ref={ref}
    className={cn("-mx-1 my-1 h-px bg-background-light", className)}
    {...props}
  />
))
DropdownMenuSeparator.displayName = DropdownMenuPrimitive.Separator.displayName

const DropdownMenuShortcut = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) => {
  return (
    <span
      className={cn("ml-auto text-xs tracking-widest opacity-60", className)}
      {...props}
    />
  )
}
DropdownMenuShortcut.displayName = "DropdownMenuShortcut"

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuGroup,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuRadioGroup,
  dropdownMenuContentVariants,
}
