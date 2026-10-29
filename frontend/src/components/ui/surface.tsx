import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"
import { padClasses, type PadProps } from "@/design-system/spacing"

/* =============================================================================
   Surface - phase 9. The dark-surface CONTEXT that replaces Button's dead
   `onDark` variant.
   -----------------------------------------------------------------------------
   THE PROBLEM THIS CLOSES. button.tsx's own header note records it plainly:
   "`onDark` is NOT a tone. It is a context - 'this button sits on a dark
   surface' ... It gets decomposed when the dark-surface work lands." Every
   other Button cell (solid/brand, outline/neutral, ghost/neutral, ...) is
   tuned for a LIGHT ambient background - text-text-primary, border-border,
   hover:bg-background-light - so every one of them is illegible or invisible
   the moment its parent's background goes dark. `onDark` worked around that
   with a thirteenth flat variant name instead of a real answer to "what is
   the ambient surface", which is why the program plan (section 1i) calls it
   out by name as the one variant name that is not a variant at all, and why
   phase 9's table lists Surface as "replaces the onDark variant with a
   context, replaces a variant with a context".

   WHY THIS IS A REACT CONTEXT PROVIDER, NOT JUST A DIV WITH A DARK BACKGROUND.
   A background alone cannot answer "how should a descendant primitive style
   itself" - that decision needs to reach every Button/Input/Badge nested
   inside without each one grepping its own DOM ancestry. `useSurfaceBackdrop()`
   is the read side of that contract: a descendant primitive can ask
   "what surface am I on" and get `"light"` (the default, everywhere in the
   tree today - Surface renders for the first time in this commit, so there
   is nothing to be byte-identical to) or `"dark"` when nested inside
   `<Surface backdrop="dark">`. Wiring Button (and any other primitive) to
   actually READ the context and switch its cells is deliberately NOT done
   here - it is future work, flagged in button.tsx's own header ("It gets
   decomposed when the dark-surface work lands") and out of this file's scope,
   which is Surface itself plus its story and tests.

   WHY THIS PROP IS `backdrop`, NOT `tone`. VOCAB_V3 (the settled primitive
   vocabulary) reserves `tone` exclusively for semantic colour - the nine-
   value brand/neutral/subtle/danger/success/warning/info/ai/business scale
   Button/Badge/Chip share - and says so by name: "tone must always mean
   semantic colour. If a prop is doing something else (e.g. surface
   light/dark backdrop...), it needs its own prop name, not 'tone'." An
   earlier pass of this file named the light/dark axis `tone` anyway and
   defended that here as a "deliberate, evidenced exception," citing notes in
   tokens.css's DARK-SURFACE CHROME block and tailwind.config.js's
   darkMode-removal note. Neither of those notes actually says the AXIS
   should be named `tone` - they only record that a dark-surface chrome ramp
   and a `Surface`-with-a-dark-mode call shape were anticipated, using `tone`
   as informal shorthand before VOCAB_V3 closed the word's meaning. Treating
   that shorthand as pre-authorization to keep the prop named `tone` was a
   mistake this pass corrects rather than repeats: the prop is renamed to
   `backdrop` - which ambient background this region establishes for its
   children, a different axis from which status it signals. `light`/`dark`
   remain the only two values anything has ever asked Surface for (no third
   ambient surface is on record anywhere in the tree), so the scale is
   exactly as closed as `variant`/`size` are elsewhere - only the prop name
   changed. The old `tone` prop, `SurfaceTone` type, `useSurfaceTone()` hook,
   and `SurfaceToneContext` all stay live as deprecated aliases (see their
   own `@deprecated` notes below) so nothing that already called this file
   breaks; each renders identically to its `backdrop` equivalent and is
   retired in phase 12c along with the rest of the deprecated names.

   WHAT SURFACE RENDERS FOR EACH BACKDROP VALUE.
     light (default)  emits nothing. Surface did not exist before this file,
                       so there is no prior render to stay byte-identical to -
                       "no classes" is chosen anyway, for the same reason
                       every other primitive's inert default is chosen: wrapping
                       existing markup in a light Surface cannot move a pixel,
                       and `useSurfaceBackdrop()` still resolves correctly for
                       any descendant that reads it.
     dark              emits `bg-surface-dark text-on-dark` - the two
                       DARK-SURFACE CHROME roles that describe the SURFACE
                       ITSELF (its own background, and the default text
                       colour legible on it). `--chrome-dark` (border /
                       secondary-hover bg) and `--focus-dark` (focus-ring
                       colour) are roles for CHILDREN sitting on the surface,
                       not the surface's own edge - Card already owns "a
                       bordered panel"; Surface's job is the backdrop those
                       children get judged against, not another bordered box.
                       Left for a descendant primitive to opt into once one
                       is wired to read the context.

   WHAT THIS FIRST PASS DOES NOT ADD, AND WHY.
   - No `variant` (solid/outline/ghost/link). A backdrop has no structural
     shape - nothing measured asked Surface to look like a button or a link.
   - No `size`. No call site anywhere sizes an ambient background; the ones
     that exist today (CopilotSheet, CopilotPanel, SchedulePage's Plan Mode
     banner) size their CONTENT, not the surface, and none of the three is
     converted to Surface by this session (worktree scope is components/ui/
     only, and each of those three panels already renders its own bespoke
     background - the AI-night gradient, the amber Plan Mode gradient - that
     is out of scope to touch here).
   - `gap` is absent for the same reason Box has none: Stack already owns
     flex-with-gap, and Surface declares no display mode of its own, so a
     `gap` prop would be inert until something also gave it one.
   - `pad` (plus the full padX/padY/padTop/padRight/padBottom/padLeft side
     axis) IS included. design-system/spacing.ts names Surface directly as
     one of the three primitives this session gives the shared padding
     vocabulary to ("Tabs, Table, Surface"), so this is measured demand, not
     a speculative add - and reusing the shared module rather than a local
     copy is the module's whole reason for existing.
   ============================================================================= */

/** Which ambient backdrop this region of the tree sits on. */
export type SurfaceBackdrop = "light" | "dark"

/**
 * @deprecated Use `SurfaceBackdrop`. Same two values ("light" | "dark"),
 * kept as a type alias so an existing `import type { SurfaceTone }` keeps
 * compiling. Retired in phase 12c along with the rest of the deprecated
 * names.
 */
export type SurfaceTone = SurfaceBackdrop

/**
 * `light` is a no-op: Surface renders no chrome of its own on a light
 * ambient background, since every other primitive is already tuned for one.
 * `dark` paints the two DARK-SURFACE CHROME roles that belong to the surface
 * itself - see the header note for why border/focus roles are left for a
 * descendant to opt into instead.
 */
const SURFACE_BACKDROP_CLASSES: Record<SurfaceBackdrop, string> = {
  light: "",
  dark: "bg-surface-dark text-on-dark",
}

const surfaceVariants = cva("", {
  variants: {
    backdrop: SURFACE_BACKDROP_CLASSES,
  },
  defaultVariants: {
    backdrop: "light",
  },
})

/**
 * The context half of the contract. Defaults to `"light"` outside any
 * `<Surface>`, matching the ambient background every existing page renders
 * on today - a descendant that calls `useSurfaceBackdrop()` without ever
 * being wrapped in a dark Surface reads exactly what it would have assumed
 * anyway.
 */
const SurfaceBackdropContext = React.createContext<SurfaceBackdrop>("light")

/**
 * @deprecated Use `SurfaceBackdropContext`. The identical context object
 * under its old name, kept so an existing `import { SurfaceToneContext }`
 * keeps compiling and stays wired to the same provider. Retired in phase
 * 12c along with the rest of the deprecated names.
 */
const SurfaceToneContext = SurfaceBackdropContext

/** What ambient backdrop the calling component is nested inside. */
export function useSurfaceBackdrop(): SurfaceBackdrop {
  return React.useContext(SurfaceBackdropContext)
}

/**
 * @deprecated Use `useSurfaceBackdrop()`. Reads the same context and renders
 * identically. Retired in phase 12c along with the rest of the deprecated
 * names.
 */
export function useSurfaceTone(): SurfaceTone {
  return useSurfaceBackdrop()
}

export interface SurfaceProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof surfaceVariants>,
    PadProps {
  /**
   * @deprecated Use `backdrop`. Same two values ("light" | "dark"), kept as
   * a deprecated alias so an existing `tone`-based call site keeps
   * rendering identically. Ignored when `backdrop` is also passed. Retired
   * in phase 12c along with the rest of the deprecated names.
   */
  tone?: SurfaceTone
}

/**
 * `<Surface>` with no props renders exactly `<div class="">` and provides
 * `"light"` to its subtree - geometrically and contextually inert, so
 * wrapping existing markup in a bare Surface cannot move a pixel or change
 * what any descendant reads from `useSurfaceBackdrop()` today (nothing
 * consumes it yet).
 */
const Surface = React.forwardRef<HTMLDivElement, SurfaceProps>(
  (
    { className, backdrop, tone, pad, padX, padY, padTop, padRight, padBottom, padLeft, ...props },
    ref
  ) => {
    const resolvedBackdrop: SurfaceBackdrop = backdrop ?? tone ?? "light"
    return (
      <SurfaceBackdropContext.Provider value={resolvedBackdrop}>
        <div
          ref={ref}
          className={cn(
            surfaceVariants({ backdrop: resolvedBackdrop }),
            padClasses({ pad, padX, padY, padTop, padRight, padBottom, padLeft }),
            className
          )}
          {...props}
        />
      </SurfaceBackdropContext.Provider>
    )
  }
)
Surface.displayName = "Surface"

export { Surface, surfaceVariants, SurfaceBackdropContext, SurfaceToneContext }
