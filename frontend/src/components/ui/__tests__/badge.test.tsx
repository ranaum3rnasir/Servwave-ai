/* =============================================================================
   Badge - `tone` rendered-class contract (W2 primitive vocabulary)
   -----------------------------------------------------------------------------
   This file pins four things:

     1. BYTE-IDENTICAL DEFAULT RENDER, for the subset of props `tone` never
        touches. `OLD_BADGE_VARIANTS` below is a frozen, line-for-line copy of
        the cva() block badge.tsx carried before `tone` was added (source:
        `git show HEAD:frontend/src/components/ui/badge.tsx`, no `tone` key at
        all) built with the SAME `cva`/`cn` the real component uses. Rendering
        both the old and the new component with the real prop shapes `variant`
        alone ever took (no props, `default`, `secondary`, `outline`,
        `className` overrides) and asserting the computed `className` strings
        are equal proves those call sites are unaffected - without
        hand-transcribing tailwind-merge's conflict resolution, which is what
        makes a frozen string easy to get subtly wrong. `destructive` and
        `intent` are deliberately NOT in this list - see (3) and (4).

     2. NEW TONE VALUES. Each token-backed tone (`neutral`, `danger`,
        `success`, `warning`, `info`, `ai`) renders its documented
        surface/text/border triad, and `tone="brand"` (the default) renders
        IDENTICAL to omitting `tone` altogether, on every `variant`.

     3. THE DEPRECATED `variant="destructive"` FOLD. Per the per-primitive
        scope table ("Badge | variant=\"destructive\", intent | tone (intent
        folds into tone)") and the closed-variant rule ("`destructive` is NOT
        a variant value anywhere in the codebase"), `destructive` is retired
        as a live cva bucket - it is no longer a peer of `default`/
        `secondary`/`outline` in badgeVariants' `variant` block at all. The
        BARE deprecated alias (no explicit `tone`/`intent`) still renders its
        original solid `bg-danger text-on-fill` fill byte-identically - the
        same "render identically" contract every sibling primitive touched
        this session honours (Button's `solid/danger` cell, Toast's and
        ConfirmDialog's `tone="danger"`, all byte-identical to their old
        `destructive`). An explicit `tone`/`intent` passed alongside the
        deprecated `variant="destructive"` is a new combination with no old
        baseline to preserve, so it renders that tone's real recipe (e.g.
        `tone="danger"`'s soft surface/text/border/hover triad) instead.

     4. THE DEPRECATED `intent` FOLD. Every `StatusIntent` value (success/
        warning/danger/info/neutral/brand) is also a `tone` value, so `intent`
        now resolves directly to the identically-named `tone` cell instead of
        painting through its own separate `STATUS_INTENT_CLASSES` lookup -
        the "two separate colour-setting props" badge.tsx used to carry are
        one axis now. `tone` wins whenever both are passed.
   ============================================================================= */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { cva } from 'class-variance-authority';

import type { StatusIntent } from '@/design-system/status-registry';
import { Badge, badgeVariants, type BadgeProps } from '../badge';
import { cn } from '@/lib/utils';

// Frozen replica of badge.tsx's cva() block as it existed before `tone` was
// added (git show HEAD:frontend/src/components/ui/badge.tsx). Do NOT update
// this to match any future edit of badgeVariants - it exists specifically to
// diverge from the live component so a real regression shows up as a diff.
const OLD_BADGE_VARIANTS = cva(
  'inline-flex items-center rounded border border-border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-on-fill hover:bg-primary/80',
        secondary:
          'border-transparent bg-background-light text-text-secondary hover:bg-background-light/80',
        destructive: 'border-transparent bg-danger text-on-fill hover:bg-danger/80',
        outline: 'text-text-primary',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

interface OldBadgeProps {
  className?: string;
  variant?: 'default' | 'secondary' | 'outline' | 'destructive' | null;
}

/** Frozen replica of the pre-tone Badge render function, scoped to the props
 *  `destructive`/`intent` never touched - see the file header's (1) vs (3)/(4). */
function oldBadgeClassName({ className, variant }: OldBadgeProps): string {
  return cn(OLD_BADGE_VARIANTS({ variant }), className);
}

function renderBadgeClassName(props: BadgeProps = {}): string {
  const { container } = render(<Badge {...props} />);
  return (container.firstElementChild as HTMLElement).className;
}

describe('Badge - byte-identical default render', () => {
  const cases: Array<{ name: string; props: OldBadgeProps }> = [
    { name: 'no props', props: {} },
    { name: 'variant=default (explicit)', props: { variant: 'default' } },
    { name: 'variant=secondary', props: { variant: 'secondary' } },
    { name: 'variant=outline', props: { variant: 'outline' } },
    { name: 'className override', props: { variant: 'secondary', className: 'ml-2' } },
    { name: 'bare deprecated variant=destructive (no tone/intent)', props: { variant: 'destructive' } },
  ];

  it.each(cases)('$name renders identical to the pre-tone component', ({ props }) => {
    const before = oldBadgeClassName(props);
    const after = renderBadgeClassName(props as BadgeProps);
    expect(after).toBe(before);
  });

  it('tone="brand" (the default) renders identical to omitting tone, for every variant', () => {
    (['default', 'secondary', 'outline'] as const).forEach((variant) => {
      const withoutTone = renderBadgeClassName({ variant });
      const withBrandTone = renderBadgeClassName({ variant, tone: 'brand' });
      expect(withBrandTone).toBe(withoutTone);
    });
  });

  it('badgeVariants({}) (no args) still resolves to the frozen default/brand baseline', () => {
    expect(badgeVariants({})).toBe(OLD_BADGE_VARIANTS({}));
  });
});

describe('Badge - tone token-backed values', () => {
  const TONE_CLASSES: Record<'neutral' | 'danger' | 'success' | 'warning' | 'info' | 'ai', string[]> = {
    neutral: ['bg-neutral-surface', 'text-neutral-text', 'border-neutral-border'],
    danger: ['bg-danger-surface', 'text-danger-text', 'border-danger-border'],
    success: ['bg-success-surface', 'text-success-text', 'border-success-border'],
    warning: ['bg-warning-surface', 'text-warning-text', 'border-warning-border'],
    info: ['bg-info-surface', 'text-info-text', 'border-info-border'],
    ai: ['bg-ai-surface', 'text-ai-text', 'border-ai-border'],
  };

  it.each(Object.entries(TONE_CLASSES))('tone="%s" renders its surface/text/border triad', (tone, expected) => {
    const className = renderBadgeClassName({ tone: tone as BadgeProps['tone'] });
    expected.forEach((token) => expect(className.split(' ')).toContain(token));
  });

  it('a non-brand tone overrides variant="default"\'s solid fill (bg/text/border), not just add to it', () => {
    const className = renderBadgeClassName({ variant: 'default', tone: 'success' }).split(' ');
    expect(className).not.toContain('bg-primary');
    expect(className).not.toContain('text-on-fill');
    expect(className).toContain('bg-success-surface');
    expect(className).toContain('text-success-text');
  });

  it('a non-brand tone applies cleanly over variant="outline" (the real call-site pattern)', () => {
    const className = renderBadgeClassName({ variant: 'outline', tone: 'danger' }).split(' ');
    expect(className).not.toContain('text-text-primary');
    expect(className).toContain('bg-danger-surface');
    expect(className).toContain('text-danger-text');
    expect(className).toContain('border-danger-border');
  });

  it('a caller className still wins over tone (className is applied last)', () => {
    const className = renderBadgeClassName({ tone: 'success', className: 'bg-surface-light' }).split(
      ' '
    );
    expect(className).toContain('bg-surface-light');
    expect(className).not.toContain('bg-success-surface');
  });

  it('a non-brand tone neutralizes the base variant hover fill instead of leaving it to flash a mismatched colour', () => {
    // default/secondary each carry their own hover fill in badgeVariants'
    // `variant` axis (hover:bg-primary/80, hover:bg-background-light/80).
    // tailwind-merge cannot resolve those against tone's un-prefixed surface
    // fill (different merge group), so tone must repeat its surface colour
    // under hover: itself. The deprecated `variant="destructive"` legacy
    // fallback (mapped to `variant="default"` under the hood - see the
    // "deprecated destructive fold" describe block below) is covered by the
    // same mechanism: an explicit tone always overrides it too.
    const solid = renderBadgeClassName({ variant: 'default', tone: 'success' }).split(' ');
    expect(solid).not.toContain('hover:bg-primary/80');
    expect(solid).toContain('hover:bg-success-surface');

    const legacyDestructiveWithTone = renderBadgeClassName({ variant: 'destructive', tone: 'ai' }).split(' ');
    expect(legacyDestructiveWithTone).not.toContain('hover:bg-danger/80');
    expect(legacyDestructiveWithTone).toContain('hover:bg-ai-surface');

    const secondary = renderBadgeClassName({ variant: 'secondary', tone: 'warning' }).split(' ');
    expect(secondary).not.toContain('hover:bg-background-light/80');
    expect(secondary).toContain('hover:bg-warning-surface');
  });
});

describe('Badge - deprecated variant="destructive" fold', () => {
  it('bare (no tone/intent) renders byte-identical to the pre-tone destructive bucket - solid bg-danger fill', () => {
    const legacy = renderBadgeClassName({ variant: 'destructive' });
    const frozen = oldBadgeClassName({ variant: 'destructive' });
    expect(legacy).toBe(frozen);
  });

  it('bare (no tone/intent) keeps the old solid bg-danger + text-on-fill fill, not tone="danger"\'s soft triad', () => {
    const className = renderBadgeClassName({ variant: 'destructive' }).split(' ');
    expect(className).toContain('bg-danger');
    expect(className).toContain('text-on-fill');
    expect(className).toContain('hover:bg-danger/80');
    expect(className).not.toContain('bg-danger-surface');
    expect(className).not.toContain('text-danger-text');
  });

  it('an explicit tone overrides the legacy fallback entirely, rendering that tone\'s real recipe', () => {
    const className = renderBadgeClassName({ variant: 'destructive', tone: 'ai' }).split(' ');
    expect(className).toContain('bg-ai-surface');
    expect(className).not.toContain('bg-danger-surface');
    expect(className).not.toContain('bg-danger');
  });

  it('an explicit tone="danger" alongside the deprecated variant renders the new soft triad (a new combination, not a preserved one)', () => {
    const className = renderBadgeClassName({ variant: 'destructive', tone: 'danger' }).split(' ');
    expect(className).toContain('bg-danger-surface');
    expect(className).toContain('text-danger-text');
    expect(className).not.toContain('text-on-fill');
  });

  it('an explicit intent overrides the legacy fallback too', () => {
    const className = renderBadgeClassName({ variant: 'destructive', intent: 'success' }).split(' ');
    expect(className).toContain('bg-success-surface');
    expect(className).not.toContain('bg-danger-surface');
    expect(className).not.toContain('bg-danger');
  });
});

describe('Badge - deprecated intent fold', () => {
  const INTENTS: StatusIntent[] = ['success', 'warning', 'danger', 'info', 'neutral', 'brand'];

  it.each(INTENTS)('intent="%s" renders identical to tone="%s" - the axes are one now', (value) => {
    const viaIntent = renderBadgeClassName({ intent: value });
    const viaTone = renderBadgeClassName({ tone: value as BadgeProps['tone'] });
    expect(viaIntent).toBe(viaTone);
  });

  it('an explicit tone wins over intent when both are passed', () => {
    const className = renderBadgeClassName({ intent: 'warning', tone: 'danger' }).split(' ');
    expect(className).toContain('bg-danger-surface');
    expect(className).not.toContain('bg-warning-surface');
  });
});
