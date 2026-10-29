import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';
import { padClasses, type PadProps } from '@/design-system/spacing';
import type { StackGap } from '@/components/ui/stack';

/* =============================================================================
   Alert - phase 9. The colour-coded callout box (program plan section 1e /
   phase 9 table: "the `bg-danger/10 border border-danger/20` family - 22x one
   signature", plan line 120: `bg-danger/10 border border-danger/20 px-3 py-2
   rounded-md` -> `Alert tone="danger"`).

   `pad`/`padX`/`padY` renders the exact measured geometry by default
   (`px-3 py-2`) - the one thing this primitive exists to retire - so
   `<Alert tone="danger">...</Alert>` alone reproduces all 22 sites with no
   other prop.

   WHY `gap`/`pad` ARE NUMBERS HERE, NOT THE PUBLISHED `none/xs/sm/md/lg/xl`
   WORD SCALE. The program plan's section 2a table lists a six-word ramp, but
   every spacing-bearing primitive this same session actually shipped
   (Stack, Inline, Box, and `design-system/spacing.ts` itself, which documents
   "VOCABULARY AMENDMENT 1 ... decided by the owner this session") uses the
   4px-grid STEP NUMBER instead - a word ramp collides with Card's own `pad`
   scale and strands real modes (`gap-0.5`, `gap-2.5`, `p-3.5`) that have no
   word. `gap` here is literally `StackGap` (imported, not redeclared, so the
   two scales cannot drift apart) and `pad`/`padX`/`padY`/the four per-side
   props are `design-system/spacing.ts`'s own `PadProps`, the shared module
   Box/Tabs/Table/Surface already consume. Matching that live, owner-approved
   precedent is "the established pattern" more than the plan's un-amended text
   is - flagged here rather than silently resolved, since it is a real
   divergence from this session's literal brief.

   VARIANT. Only `outline` is measured (the tinted-surface-plus-border shape
   all 22 sites hand-rolled). `solid` and `ghost` are ADDITIVE, built from
   tokens.css infrastructure that already exists for exactly this purpose (the
   `-strong` roles are labelled "white X:1" in tokens.css - a solid-fill,
   white-text treatment is their stated reason to exist, not an invented one)
   and mirror cells Button already ships (`solid/danger` is `bg-danger
   text-on-fill`, matched here as `bg-danger-strong text-on-fill`). `link` is
   NOT minted: Alert is a static status region, not a clickable affordance, so
   the fourth structure has no meaning here and no call site asks for it.

   TONE. Five values, matching Badge's own tone axis exactly (`neutral`,
   `danger`, `success`, `warning`, `ai`) - the same five tokens.css ships a
   full surface/border/text/strong quad for. `brand`, `subtle`, `business`
   and `info` from the closed 9-value vocabulary (program plan section 2a.2,
   rev 3 - the settled list is brand/neutral/subtle/danger/success/warning/
   info/ai/business; `subtle` is the rename of rev 2's `muted`) are
   DELIBERATELY absent, for two different reasons. `brand`/`subtle`/
   `business`: tokens.css has no `-strong` quad for any of them (Badge's own
   tone doc comment records the same surface/text/border gap for `subtle`/
   `business`; section 2a.4 records the same gap for `brand`'s solid cell -
   there is no `--primary-strong`). `info`: it DOES have a full quad
   (`--info-surface`/`--info-border`/`--info-text`/`--info-strong`,
   tokens.css:189-192) but no call site among the 22 this primitive is built
   from asks for it, so minting it here would be a prop added on hope, not
   evidence.

   SCALE (formerly named `size` - repair pass, VOCAB_V3 rule 3). Font/icon
   size, NOT control height: Alert is a static status `<div>`, not a control,
   so there is no control-height concept here for `size` to describe. Rule 3
   is explicit - "size never appears on a primitive where it would not mean
   control height" - the same reason Modal/Dialog/Sheet/Popover/
   DropdownMenuContent's old max-width `size` had to become `width`. Renamed
   to `scale`, and the VALUE SET changes too, independent of the rename: the
   old `xs`/`sm`/`md`/`lg` was the pre-rev-3 relative ladder rule 2 retired,
   not a legitimate reuse of the new six-rung absolute-px control-height
   ladder (3xs=24/2xs=28/xs=32/sm=36/md=40/lg=44) - which would not fit here
   either, since none of these rungs measure a height. `scale`'s values are
   instead named after the literal Tailwind font-size key each one emits
   (`xs` -> `text-xs`, `sm` -> `text-sm`, `base` -> `text-base`), the same
   convention Text's own `size` prop already uses. `sm` is the default: `md`
   and `sm` rendered byte-identical classes in the old scale
   (`text-sm [&_svg]:size-4` both), so the old default's geometry is
   preserved exactly by mapping `md` -> `sm` rather than carrying a
   redundant fourth value forward. The old `size` prop and its four old
   values stay live as a deprecated alias (`xs`->`xs`, `sm`->`sm`, `md`->`sm`,
   `lg`->`base`), rendering identically, until phase 12c.

   WHAT THIS PRIMITIVE IS NOT, THIS PASS. No `AlertTitle`/`AlertDescription`
   subcomponents: this codebase already deleted Card's five subcomponents in
   phase 6a in favour of one flat, prop-driven primitive (see
   component-api-guard.test.ts's ratchet comments), and the 22 measured sites
   are plain text, not a title/description pair. A consumer composes an icon
   or a heading as a child; `gap` spaces whatever children are passed, exactly
   the meaning Stack/Inline already give it.
   ============================================================================= */

export type AlertVariant = 'outline' | 'solid' | 'ghost';
export type AlertTone = 'neutral' | 'danger' | 'success' | 'warning' | 'ai';
/**
 * Font/icon size, named after the Tailwind font-size key each rung emits.
 * See the header note (SCALE) for why this is not the six-rung
 * control-height ladder.
 */
export type AlertScale = 'xs' | 'sm' | 'base';
/**
 * @deprecated Renamed to `scale` - `size` implied control height, which
 * Alert (a static div, not a control) does not have. Old values render
 * identically: `xs` -> `xs`, `sm` -> `sm`, `md` -> `sm`, `lg` -> `base`.
 * Ignored when `scale` is also passed. Retired in phase 12c.
 */
export type AlertSize = 'xs' | 'sm' | 'md' | 'lg';

/**
 * Maps the deprecated `size` values to their identical-rendering `scale`
 * replacement. `md` and `sm` collapse to the same `scale` value because they
 * rendered byte-identical classes under the old scale.
 */
const LEGACY_ALERT_SCALE: Record<AlertSize, AlertScale> = {
  xs: 'xs',
  sm: 'sm',
  md: 'sm',
  lg: 'base',
};

const alertVariants = cva('flex w-full items-start rounded-md border border-border', {
  variants: {
    /** Structural appearance. See the header note for what is minted and why. */
    variant: {
      outline: '',
      solid: 'border-transparent',
      ghost: 'border-transparent bg-transparent',
    },
    /**
     * Semantic colour. Every branch below is empty on its own - the real
     * surface/border/text classes live in `compoundVariants`, keyed by
     * `variant x tone`, since the same tone paints a different set of
     * properties depending on the structure (a tinted surface for `outline`,
     * a solid fill for `solid`, text only for `ghost`).
     */
    tone: {
      neutral: '',
      danger: '',
      success: '',
      warning: '',
      ai: '',
    },
    /**
     * Font/icon size - NOT control height (see the header note, SCALE, for
     * why this is named `scale` rather than `size`). `sm` is `text-sm`, the
     * app's ambient body-copy size and the safe default for a brand-new
     * primitive with no prior pixel value to preserve - it is also what the
     * deprecated `size="md"` rendered, so the default geometry is unchanged.
     */
    scale: {
      xs: 'text-xs [&_svg]:size-3.5',
      sm: 'text-sm [&_svg]:size-4',
      base: 'text-base [&_svg]:size-5',
    },
    /**
     * Space between direct children (an icon, a text column, whatever is
     * passed), in the same 4px-grid steps as `Stack`/`Inline`'s own `gap` -
     * literally the same type (`StackGap`), so the three scales cannot drift
     * apart. No default demand cited for any one step, so it defaults to 0
     * (no gap), matching Stack/Inline's own inert-by-default rule: an Alert
     * with a single text child renders identically whether or not `gap` is
     * named.
     */
    gap: {
      0: 'gap-0',
      0.5: 'gap-0.5',
      1: 'gap-1',
      1.5: 'gap-1.5',
      2: 'gap-2',
      2.5: 'gap-2.5',
      3: 'gap-3',
      4: 'gap-4',
      5: 'gap-5',
      6: 'gap-6',
      8: 'gap-8',
      12: 'gap-12',
    },
  },
  compoundVariants: [
    // outline x tone - the measured 22x shape (tone="danger") and its four
    // token-backed siblings. Reuses the exact surface/border/text triad
    // Badge and Card already rely on for the identical "colour-coded
    // callout" purpose.
    { variant: 'outline', tone: 'neutral', class: 'bg-neutral-surface border-neutral-border text-neutral-text' },
    { variant: 'outline', tone: 'danger', class: 'bg-danger-surface border-danger-border text-danger-text' },
    { variant: 'outline', tone: 'success', class: 'bg-success-surface border-success-border text-success-text' },
    { variant: 'outline', tone: 'warning', class: 'bg-warning-surface border-warning-border text-warning-text' },
    { variant: 'outline', tone: 'ai', class: 'bg-ai-surface border-ai-border text-ai-text' },
    // solid x tone - a strong filled banner. `-strong` is tokens.css's own
    // white-text-safe role for each tone (see the header note).
    { variant: 'solid', tone: 'neutral', class: 'bg-neutral-strong text-on-fill' },
    { variant: 'solid', tone: 'danger', class: 'bg-danger-strong text-on-fill' },
    { variant: 'solid', tone: 'success', class: 'bg-success-strong text-on-fill' },
    { variant: 'solid', tone: 'warning', class: 'bg-warning-strong text-on-fill' },
    { variant: 'solid', tone: 'ai', class: 'bg-ai-strong text-on-fill' },
    // ghost x tone - tinted text only, no fill or border.
    { variant: 'ghost', tone: 'neutral', class: 'text-neutral-text' },
    { variant: 'ghost', tone: 'danger', class: 'text-danger-text' },
    { variant: 'ghost', tone: 'success', class: 'text-success-text' },
    { variant: 'ghost', tone: 'warning', class: 'text-warning-text' },
    { variant: 'ghost', tone: 'ai', class: 'text-ai-text' },
  ],
  defaultVariants: {
    variant: 'outline',
    tone: 'neutral',
    scale: 'sm',
    gap: 0,
  },
});

export interface AlertProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'color'>,
    VariantProps<typeof alertVariants>,
    PadProps {
  /**
   * @deprecated Use `scale`. `size` implied control height, which Alert (a
   * static div, not a control) does not have. Old values render identically:
   * `xs` -> `xs`, `sm` -> `sm`, `md` -> `sm`, `lg` -> `base`. Ignored when
   * `scale` is also passed. Retired in phase 12c.
   */
  size?: AlertSize;
}

/**
 * `<Alert tone="danger">...</Alert>` renders
 * `bg-danger-surface border-danger-border text-danger-text px-3 py-2
 * rounded-md border` - the token-based equivalent of the raw
 * `bg-danger/10 border border-danger/20 px-3 py-2 rounded-md` signature 22
 * call sites hand-roll today, which is this primitive's whole reason to
 * exist. `role="alert"` is the sane a11y default (an assertive live region);
 * pass `role="status"` for a quieter, non-interrupting announcement.
 */
const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
  (
    {
      className,
      role = 'alert',
      variant,
      tone,
      scale,
      size,
      gap,
      pad,
      padX,
      padY,
      padTop,
      padRight,
      padBottom,
      padLeft,
      ...props
    },
    ref
  ) => {
    // `scale` wins when both are passed; a bare `size` falls back through
    // LEGACY_ALERT_SCALE to the identical-rendering `scale` value. Neither
    // set means "fall through to cva's own `sm` default".
    const resolvedScale: AlertScale | undefined =
      scale ?? (size !== undefined ? LEGACY_ALERT_SCALE[size] : undefined);
    const hasCustomPad =
      pad !== undefined ||
      padX !== undefined ||
      padY !== undefined ||
      padTop !== undefined ||
      padRight !== undefined ||
      padBottom !== undefined ||
      padLeft !== undefined;
    // The default IS the measured geometry (px-3 py-2), not a blank slate -
    // unlike Box, Alert's whole reason to exist is retiring that exact
    // hand-rolled padding, so a call site naming no padding prop still gets
    // it. Any of the seven padClasses props overrides it wholesale.
    const padding = hasCustomPad
      ? padClasses({ pad, padX, padY, padTop, padRight, padBottom, padLeft })
      : padClasses({ padX: 3, padY: 2 });
    return (
      <div
        ref={ref}
        role={role}
        className={cn(alertVariants({ variant, tone, scale: resolvedScale, gap }), padding, className)}
        {...props}
      />
    );
  }
);
Alert.displayName = 'Alert';

export { Alert, alertVariants };
export type { StackGap as AlertGap };
