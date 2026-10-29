import * as React from "react"
import * as AvatarPrimitive from "@radix-ui/react-avatar"

import { cn } from "@/lib/utils"

/** What the ring around the avatar means, not which classes paint it. */
export type AvatarRing = "none" | "stack" | "ai"

const RING: Record<AvatarRing, string> = {
  none: "",
  // A tile sitting on its own card, so it needs a border to read as a shape.
  stack: "shadow-sm ring-2 ring-surface-light",
  // The AI-agent halo used across the Copilot surfaces.
  ai: "ring-2 ring-ai-200",
}

/**
 * Rendered diameter. W2 vocabulary axis - closed scale xs/sm/md/lg, `md` is
 * always the default and always today's rendered geometry.
 *
 * Every one of the 9 real call sites overrides the bare h-10 w-10 default
 * with an explicit h and w className today (program plan section 1h, phase-8
 * row "8e | Avatar | size (9 of 9 sites)"). Rungs are pinned to the
 * vocabulary's shared, absolute six-rung px ladder (rule 2: "size is an
 * ABSOLUTE ladder ... not a per-primitive relative scale" - size="lg" is
 * always 44px, on every primitive that has the prop, Avatar included):
 *   xs  32px  h-8 w-8    (pages/CustomersPage.tsx, components/crm/AssignTeamPopover.tsx)
 *   sm  36px  h-9 w-9    (components/layout/Header.tsx, components/jobs/AiJobAssistantBar.tsx)
 *   md  40px  h-10 w-10  (components/ai-center/BookingModal.tsx - UNCHANGED, today's bare default)
 *   lg  44px  h-11 w-11  (the ladder's top rung - coincides with TeamCard.tsx's existing 44px)
 * Avatar is inherently square (a circular tile), so the ladder's one shared
 * height value sets both dimensions at once - there is no separate width
 * axis the way a non-square control would need one; this is the same
 * height-equals-width mechanism the vocabulary already uses for `iconOnly`
 * ("square at the chosen size's px value (height = width)").
 *
 * components/ai-center/AgentDetailModal.tsx and pages/CustomerDetailPage.tsx
 * render at 64px today, which is off the ladder entirely - the ladder has no
 * rung above lg=44. Those two sites, plus AgentCard.tsx's 48px, are not
 * folded into a rung; they keep a bespoke className override, which `cn`'s
 * tailwind-merge still lets win over the size rung's h-w classes. Migrating
 * those call sites to a different diameter is a call-site change, out of
 * scope for this file.
 */
export type AvatarSize = "xs" | "sm" | "md" | "lg"

const SIZE: Record<AvatarSize, string> = {
  xs: "h-8 w-8",
  sm: "h-9 w-9",
  // Unchanged default - byte-identical to the pre-size-prop base string.
  md: "h-10 w-10",
  // 44px - the shared ladder's top rung (rule 2), not an Avatar-specific value.
  lg: "h-11 w-11",
}

const Avatar = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Root> & {
    ring?: AvatarRing
    size?: AvatarSize
  }
>(({ className, ring = "none", size = "md", ...props }, ref) => (
  <AvatarPrimitive.Root
    ref={ref}
    className={cn(
      // `size` is spliced in at the exact spot the old literal h-10 w-10 sat,
      // not appended after - appending would make tailwind-merge dedupe the
      // md rung's h-10 w-10 against a second literal occurrence and reorder
      // it to the end, changing the default render's byte string even though
      // the class SET would be unchanged. Splicing keeps position and string
      // untouched for the default case (verified: no duplicate to resolve).
      "relative flex",
      SIZE[size],
      "shrink-0 overflow-hidden rounded-full",
      RING[ring],
      className
    )}
    {...props}
  />
))
Avatar.displayName = AvatarPrimitive.Root.displayName

const AvatarImage = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Image>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Image>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Image
    ref={ref}
    className={cn("aspect-square h-full w-full", className)}
    {...props}
  />
))
AvatarImage.displayName = AvatarPrimitive.Image.displayName

/** What the fallback tile means, not which classes paint it. */
export type AvatarTone = "default" | "solid" | "subtle" | "custom"

const TONE: Record<AvatarTone, string> = {
  default: "bg-background-light",
  solid: "bg-primary text-on-fill",
  subtle: "bg-primary-subtle text-primary",
  // Background comes from a per-record `style` (e.g. an AI agent's own
  // brand colour) - the component still owns the one appearance decision
  // it can: white text reads on any of them.
  custom: "text-on-fill",
}

const AvatarFallback = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Fallback>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Fallback> & { tone?: AvatarTone }
>(({ className, tone = "default", ...props }, ref) => (
  <AvatarPrimitive.Fallback
    ref={ref}
    className={cn(
      "flex h-full w-full items-center justify-center rounded-full",
      TONE[tone],
      className
    )}
    {...props}
  />
))
AvatarFallback.displayName = AvatarPrimitive.Fallback.displayName

export { Avatar, AvatarImage, AvatarFallback }
