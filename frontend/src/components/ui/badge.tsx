import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"
import type { StatusIntent } from "@/design-system/status-registry"

const badgeVariants = cva(
  "inline-flex items-center rounded border border-border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-on-fill hover:bg-primary/80",
        secondary:
          "border-transparent bg-background-light text-text-secondary hover:bg-background-light/80",
        outline: "text-text-primary",
      },
      /**
       * Semantic colour axis (program plan section 2a vocabulary; Badge's
       * intent -> tone move is scoped to W2/8 in section 2a.11's rename
       * table, md_files/plans/frontend/2026-07-27-ui-component-architecture-program.md:641).
       * Evidence: 4 real call sites hand-roll this exact surface/text/border
       * triad today - StripePaymentsStatusCard's SUCCESS_TINT/WARNING_TINT/
       * DANGER_TINT constants (payments/StripePaymentsStatusCard.tsx:37-39),
       * and the getAdSourceStyle() helper duplicated in
       * CustomerDetailPage.tsx:210/CustomersPage.tsx:93 (success/danger/ai/
       * warning/neutral), measured directly against those call sites.
       *
       * `subtle` and `business` from the closed 9-value vocabulary (program
       * plan section 2a.2, rev 3 - the settled list is brand/neutral/subtle/
       * danger/success/warning/info/ai/business; `subtle` is the rename of
       * rev 2's `muted`, since `--muted` is a Tier-1 primitive token
       * tokens.css:12 forbids a component from referencing directly) are
       * DELIBERATELY absent here: tokens.css has no surface/text/border
       * triad for either. Add them once tokens.css grows the tokens.
       *
       * `info` IS minted, unlike `subtle`/`business`: tokens.css already has
       * the triad (`--info-surface`/`--info-border`/`--info-text`,
       * tokens.css:189-191) and, since `intent` folds into this axis (see
       * `BadgeProps.intent`'s doc comment), `intent="info"`'s one real call
       * site (pages/InvoiceDetailPage.tsx:689) is now measured demand for
       * `tone="info"` too.
       *
       * `brand` (the default) intentionally contributes NO classes: it is
       * the "no override" case, so every existing call site - none of which
       * pass `tone` - renders byte-identical to before this prop existed,
       * regardless of which `variant` it uses.
       *
       * SIZE - phase 8g (program plan
       * md_files/plans/frontend/2026-07-27-ui-component-architecture-program.md:973,
       * "Calendar, Separator, Checkbox, Switch, Badge -> size where demand
       * exists") was checked for Badge and no demand was found. Of the 10
       * real `<Badge` call sites (excluding this file's own tests/stories
       * and the DesignSystemPage swatch page), only one
       * (components/data/filter-chip.tsx:8) overrides padding at all, and
       * that override is asymmetric horizontal padding
       * (`pl-2 pr-1` against the base `px-2.5`) to make room for a trailing
       * remove icon, not a second geometry value repeated anywhere else -
       * an interaction-shape tweak, not size demand. No `text-xs`/`text-sm`
       * pair or repeated height value exists at any site. No rung minted.
       *
       * Each non-brand tone also repeats its own surface fill class under a
       * `hover:` prefix. This is not a new colour - it neutralizes the base
       * `variant`'s own hover fill (`hover:bg-primary/80` on `default`,
       * `hover:bg-background-light/80` on `secondary`), which tailwind-merge
       * cannot resolve against tone's un-prefixed surface fill class since
       * `hover:` classes are a distinct merge group. Without this, tone's
       * own resting fill wins at rest but the untouched variant hover class
       * wins on hover, so hovering a `tone="success"` badge would flash
       * brand coloured instead of staying success coloured. No token beyond
       * the surface fill already used above is introduced.
       */
      tone: {
        brand: "",
        neutral:
          "bg-neutral-surface text-neutral-text border-neutral-border hover:bg-neutral-surface",
        danger:
          "bg-danger-surface text-danger-text border-danger-border hover:bg-danger-surface",
        success:
          "bg-success-surface text-success-text border-success-border hover:bg-success-surface",
        warning:
          "bg-warning-surface text-warning-text border-warning-border hover:bg-warning-surface",
        info: "bg-info-surface text-info-text border-info-border hover:bg-info-surface",
        ai: "bg-ai-surface text-ai-text border-ai-border hover:bg-ai-surface",
      },
    },
    defaultVariants: {
      variant: "default",
      tone: "brand",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    Omit<VariantProps<typeof badgeVariants>, "variant"> {
  /**
   * Structure. `default` | `secondary` | `outline`, plus one retired name.
   *
   * @deprecated `destructive` is retired as a live cva bucket - the closed-
   * variant rule ("`destructive` is NOT a variant value anywhere in the
   * codebase", program plan section 2a) decomposes it into `variant=
   * "default"` (the solid structure it already used) + `tone="danger"`
   * (see `intent`'s doc comment below for the same fold applied to the
   * status-registry path). When passed bare (no explicit `tone`/`intent`),
   * it still renders its ORIGINAL solid `bg-danger text-on-fill` fill
   * byte-identically (see `LEGACY_DESTRUCTIVE_FILL` below) - the same
   * "render identically" contract every sibling primitive touched this
   * session honours (Button's `solid/danger` cell, Toast's and
   * ConfirmDialog's `tone="danger"`). An explicit `tone`/`intent` passed
   * alongside it supersedes that fallback and renders the real tone recipe
   * instead. Write `tone="danger"` instead for new call sites.
   */
  variant?: VariantProps<typeof badgeVariants>["variant"] | "destructive"
  /**
   * What this badge means, resolved through the same status registry
   * StatusBadge uses - not which colour. Set this instead of hand-rolling
   * `bg-amber-50 text-amber-700 border-amber-200`: every call site that did
   * was re-deciding a colour the registry had already decided, which is
   * exactly the leak phase 1 existed to close. `StatusBadge` (a domain +
   * status enum -> label + intent) is still the right choice whenever a
   * status has a registry entry; `intent` was for badges with no domain
   * entry to look up (a boolean flag, a kind, a readiness check) - `tone`
   * is that prop now.
   *
   * @deprecated every `StatusIntent` value (success/warning/danger/info/
   * neutral/brand) is also a `tone` value - per the per-primitive scope
   * table ("Badge | variant=\"destructive\", intent | tone (intent folds
   * into tone)") `intent` folds directly into `tone`: passing `intent`
   * resolves to the identically-named `tone` cell, using `tone`'s own
   * surface/text/border recipe (so, unlike before this fold, it also picks
   * up `tone`'s hover neutralization - a cosmetic gain, not a behaviour
   * change, since Badge renders a `<div>`). Ignored when `tone` is also
   * passed - `tone` always wins. Write `tone` instead.
   */
  intent?: StatusIntent
}

/**
 * Frozen replica of the retired `destructive` cva bucket's colour classes
 * (byte-for-byte the same string the pre-tone `badgeVariants` variant map
 * carried under `destructive`). The closed-variant rule retires `destructive`
 * as a live cva bucket - it must not be a selectable peer of `default`/
 * `secondary`/`outline` - but the "render identically" requirement for
 * deprecated prop values (every sibling primitive touched this session -
 * Button's `solid/danger` cell, Toast's and ConfirmDialog's `tone="danger"` -
 * reproduces its pre-existing pixels for the bare deprecated name) means the
 * bare `variant="destructive"` case, with no explicit `tone`/`intent`
 * override, still needs to render its ORIGINAL solid fill, not `tone`
 * "danger"'s new soft/tinted recipe. Only used by that one fallback branch
 * below; any explicit `tone`/`intent` always supersedes it.
 */
const LEGACY_DESTRUCTIVE_FILL =
  "border-transparent bg-danger text-on-fill hover:bg-danger/80"

function Badge({ className, variant, tone, intent, ...props }: BadgeProps) {
  const isLegacyDestructive = variant === "destructive"
  const resolvedTone = tone ?? intent
  const isBareLegacyDestructive = isLegacyDestructive && !resolvedTone
  return (
    <div
      className={cn(
        badgeVariants({
          variant: isLegacyDestructive ? "default" : variant,
          tone: isBareLegacyDestructive ? undefined : resolvedTone,
        }),
        isBareLegacyDestructive && LEGACY_DESTRUCTIVE_FILL,
        className
      )}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
