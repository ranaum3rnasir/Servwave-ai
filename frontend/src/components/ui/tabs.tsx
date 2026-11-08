/* =============================================================================
   Tabs - the spacing axes on TabsContent and TabsList (phase 7).

   Two of the four exports gain the padding vocabulary from
   design-system/spacing.ts. Neither gains a DEFAULT: an export passed no
   padding prop emits no padding class at all, so every call site in the tree
   keeps rendering exactly what it renders today.

   ---------------------------------------------------------------------------
   WHY THIS FILE IS WHERE PER-SIDE PADDING WAS BORN
   ---------------------------------------------------------------------------
   Recording it here so it is not re-litigated. The settled vocabulary
   published `pad` / `padX` / `padY` only. The tab rail at
   pages/InvoiceDetailPage.tsx:905 pads its TOP SIDE ALONE, written today as
   `px-4 pt-2`. The closest expression in the published vocabulary is
   `padY={2}`, which emits `py-2` and therefore also adds 8px of padding at the
   BOTTOM. That is a rendered change, which the hard constraint on this phase
   forbids outright.

   So the vocabulary was amended, by the owner, to planner option (i): add
   `padTop` / `padRight` / `padBottom` / `padLeft`. It is a strict superset of
   pad/padX/padY and it mirrors Tailwind's own four-sided model, so it teaches
   nobody a new concept. Option (ii) - a bespoke `inset` step on TabsList
   meaning "re-inset the rail inside a padless Card" - was REJECTED: it invents
   a second word for one shape, which the vocabulary's own rule 1 forbids.

   The maps and the precedence rule live in design-system/spacing.ts and are
   deliberately NOT copied here. Copying them is the drift this program exists
   to kill.

   ---------------------------------------------------------------------------
   MEASURED DEMAND (re-derived 2026-07-28 with the guard's own exports -
   targetFiles / findComponentTags / classNameTokens / classifyToken /
   stripComments - not a grep)
   ---------------------------------------------------------------------------
     TabsContent   57 tags / 15 files, 50 carrying a className,
                   24 appearance tokens:
                     pt-4 x8   4 settings pages
                     p-6  x7   CustomerDetailPage
                     p-5  x5   JobDetailPage
                     p-4  x4   InvoiceDetailPage
     TabsList      18 tags / 18 files, 11 carrying a className,
                   11 appearance tokens:
                     p-0  x7, p-1 x1, px-4 x1, pt-2 x1, one border reset
   Per-side demand in the Tabs cluster alone is 9 sites (pt-4 x8 + pt-2 x1),
   which is what makes the amendment above earn its keep rather than being a
   one-site convenience.

   THIS SESSION CONVERTS ONLY InvoiceDetailPage - the 4 `p-4` on TabsContent
   and the `px-4 pt-2` on TabsList. The other 31 tokens are W3 conversion work.

   ONE THING A REVIEWER WILL TRIP ON, so it is written down. The rail
   conversion is `padX={4} padTop={2}`, and what it emits is NOT `px-4 pt-2`.
   design-system/spacing.ts resolves per side as soon as any single side is
   named, so the output is `pt-2 pr-4 pl-4`: three sides, no bottom. That is
   the SAME computed padding on all four sides as `px-4 pt-2` - 8px top, 16px
   right, nothing at the bottom, 16px left - because the horizontal shorthand
   is by definition the left and right sides together. The rule and its reason
   (a shorthand merged with an axis class keeps BOTH, so side order would be
   decided by stylesheet order rather than by the component) live at
   spacing.ts:217 and are pinned by spacing.test.ts:423. This module delegates
   rather than re-deriving them, which is the whole point of a shared module.

   ---------------------------------------------------------------------------
   THE TRAP, AND THE GUARD AGAINST IT
   ---------------------------------------------------------------------------
   Emitting ANY padding class when no padding prop is passed would silently
   restyle all 50 TabsContent call sites that carry a className at once, plus
   the 7 that pass a zero step explicitly. `padClasses({})` returning the empty
   string is what prevents that, `cn` drops empty strings, and both facts are
   pinned - in design-system/__tests__/spacing.test.ts and in this file's own
   __tests__/tabs.test.tsx, which asserts the propless class string of all four
   exports byte for byte.

   Tabs is deliberately left alone. It has zero measured appearance demand
   app-wide - every className it is passed is layout (mt-3, mt-4, flex-1,
   space-y-4, etc.), matching this file's own "healthy" entry in the
   component-api-guard.

   ---------------------------------------------------------------------------
   TABSTRIGGER `padX` / `padY` (W2, corrected 2026-07-30)
   ---------------------------------------------------------------------------
   The 66-padding-token signal flagged above as "recorded, not acted on" is
   what this axis resolves. Re-derived with the guard's own
   findComponentTags/classifyToken (not a grep) across the 17 real call-site
   files: 37 source-level TabsTrigger padding signatures across 8 files,
   clustering into five shapes -
     px-5 py-3   x15  JobDetailPage, LeadDetailPage
     px-4        x8   CustomerDetailPage (variant="underline-fill")
     px-4 py-3   x6   TasksHubPage (variant="underline")
     px-3 py-2   x4   PriceBookPage, VendorsPage
     px-3 py-1.5 x3   PriceBookPicker (variant="pill")

   A prior pass on this file shipped this axis as a `size` prop on a closed
   xs/sm/md/lg scale. That was wrong twice over, per the settled vocabulary
   (rule 1: "size = control height... pad/gap = spacing. No second word for
   any of them" and rule 3: "size never appears on a primitive where it would
   not mean control height"). First, this signal is a PADDING shape, not a
   control-height shape - no h-* class and no font-size class was ever in it,
   so calling it `size` mislabels spacing as height. Second, even reframed as
   a real size axis it used the wrong scale shape: the vocabulary's SIZE
   table is six absolute-px rungs (3xs=24 ... lg=44), not a four-rung
   relative xs/sm/md/lg scale of padding pairs.

   The fix reuses the vocabulary's own spacing word instead of inventing one:
   `padX` / `padY` from design-system/spacing.ts, the exact PadProps pattern
   TabsList and TabsContent already use two exports above this one in this
   same file. All three px-N/py-N clusters below are legal steps on the
   existing PadStep grid and reproduce byte for byte:
     padX={3} padY={1.5}  ->  px-3 py-1.5  (PriceBookPicker)
     padX={3} padY={2}    ->  px-3 py-2    (PriceBookPage, VendorsPage)
     padX={5} padY={3}    ->  px-5 py-3    (JobDetailPage, LeadDetailPage)
   Neither prop has a default - a TabsTrigger passed neither emits no padding
   class, the same "never change what an untouched call site renders" rule
   TabsList/TabsContent already follow, and the only choice consistent with
   the base string baking in zero component-level padding across every
   TRIGGER_VARIANT today.

   TabsTrigger does not get the full seven-prop PadProps (no `pad`, no
   per-side props): the measured demand is two independent axes, not a
   uniform or per-side shape, so only padX/padY are wired here. The
   remaining two clusters - px-4 alone (CustomerDetailPage) and px-4 py-3
   (TasksHubPage), 14 sites combined - stay as className overrides even
   after this ships; converting call sites is W3 work, this session only
   adds the prop.
   ============================================================================= */
import * as React from "react"
import * as TabsPrimitive from "@radix-ui/react-tabs"

import { padClasses, type PadProps, type PadStep } from "@/design-system/spacing"
import { cn } from "@/lib/utils"

/** Whether the whole tab widget sits in its own card, or plain in the page. */
export type TabsSurface = "plain" | "card"

const SURFACE: Record<TabsSurface, string> = {
  plain: "",
  card: "rounded-card border border-border bg-surface-light shadow-card",
}

const Tabs = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Root> & { surface?: TabsSurface }
>(({ className, surface = "plain", ...props }, ref) => (
  <TabsPrimitive.Root ref={ref} className={cn(SURFACE[surface], className)} {...props} />
))
Tabs.displayName = TabsPrimitive.Root.displayName

/** What the tab rail looks like, not which classes paint it. */
export type TabsListVariant = "line" | "pill"

const LIST_VARIANT: Record<TabsListVariant, string> = {
  line: "border-b border-border",
  pill: "bg-background-light",
}

/**
 * The tab rail.
 *
 * PADDING HAS NO DEFAULT. A rail passed no padding prop emits no padding
 * class, which is what keeps all 18 shipped rails - including the 7 that pass
 * a zero step by hand - rendering exactly what they render today.
 */
const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> & { variant?: TabsListVariant } & PadProps
>(
  (
    { className, variant = "line", pad, padX, padY, padTop, padRight, padBottom, padLeft, ...props },
    ref
  ) => (
    <TabsPrimitive.List
      ref={ref}
      className={cn(
        "flex items-center gap-[26px]",
        LIST_VARIANT[variant],
        padClasses({ pad, padX, padY, padTop, padRight, padBottom, padLeft }),
        className
      )}
      {...props}
    />
  )
)
TabsList.displayName = TabsPrimitive.List.displayName

/** What kind of tab this is, not which classes paint it. */
export type TabsTriggerVariant = "line" | "underline" | "underline-fill" | "pill"

const TRIGGER_BASE =
  "inline-flex items-center justify-center whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"

const TRIGGER_VARIANT: Record<TabsTriggerVariant, string> = {
  // The shadcn default: thin bottom border, brightens to primary when active.
  line: "-mb-px border-b-2 border-transparent pb-2.5 text-sm font-semibold text-text-secondary data-[state=active]:border-primary data-[state=active]:text-text-primary",
  // The detail-page rail: thicker underline, primary-tinted active label.
  // Was duplicated near-verbatim across 7+ files (LeadDetailPage inline,
  // JobDetailPage/TasksHubPage's own TAB_TRIGGER_CLASS, PriceBookPage,
  // VendorsPage, PurchaseOrdersPage's TabStripTrigger).
  underline:
    "relative border-b-[3px] border-transparent text-sm font-medium text-text-secondary hover:text-text-primary data-[state=active]:border-primary data-[state=active]:text-primary data-[state=active]:font-semibold",
  // CustomerDetailPage's rail: no border on the trigger itself - a
  // text-width underline bar renders in the wrapped content span below.
  "underline-fill":
    "group text-sm text-text-secondary font-medium hover:text-text-primary hover:bg-background-light/50 data-[state=active]:text-primary data-[state=active]:font-semibold",
  // PriceBookPicker's segmented-control look.
  pill: "rounded text-xs font-bold text-text-secondary data-[state=active]:bg-primary-subtle data-[state=active]:text-primary",
}

/** The text-width underline bar `variant="underline-fill"` wraps its children in. */
const UNDERLINE_FILL_BAR =
  "relative inline-flex flex-col items-center py-3 after:absolute after:bottom-0 after:inset-x-0 after:h-0.5 after:rounded-full after:bg-transparent after:transition-colors group-data-[state=active]:after:bg-primary"

/**
 * The tab trigger.
 *
 * PADDING HAS NO DEFAULT. A trigger passed neither `padX` nor `padY` emits no
 * padding class of its own, which is what keeps every existing call site
 * rendering exactly what it renders today - see the header comment.
 */
const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger> & {
    variant?: TabsTriggerVariant
    padX?: PadStep
    padY?: PadStep
  }
>(({ className, variant = "line", padX, padY, children, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      TRIGGER_BASE,
      TRIGGER_VARIANT[variant],
      padClasses({ padX, padY }),
      className
    )}
    {...props}
  >
    {variant === "underline-fill" ? <span className={UNDERLINE_FILL_BAR}>{children}</span> : children}
  </TabsPrimitive.Trigger>
))
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName

/**
 * The panel under the rail.
 *
 * PADDING HAS NO DEFAULT, for the same reason as TabsList: 50 of the 57
 * shipped panels carry a className today and none of them may move.
 */
const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content> & PadProps
>(
  (
    { className, pad, padX, padY, padTop, padRight, padBottom, padLeft, ...props },
    ref
  ) => (
    <TabsPrimitive.Content
      ref={ref}
      className={cn(
        "mt-2 ring-offset-surface-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2",
        padClasses({ pad, padX, padY, padTop, padRight, padBottom, padLeft }),
        className
      )}
      {...props}
    />
  )
)
TabsContent.displayName = TabsPrimitive.Content.displayName

export { Tabs, TabsList, TabsTrigger, TabsContent }
