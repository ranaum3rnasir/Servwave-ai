/* =============================================================================
   Badge - Storybook stories, full-coverage pass (Storybook phase, W2 plan).

   Storybook 8 is scaffolded now (.storybook/main.ts, .storybook/preview.ts,
   the @storybook/react-vite devDependency in package.json) - unlike the
   "new primitives" phase's first-pass stories elsewhere in this directory,
   this file imports the real `Meta` / `StoryObj` types from `@storybook/react`
   and wires `argTypes` so every axis is a live control in the Storybook UI.

   Coverage requirement (the completeness pass this phase adds): every
   variant KEY and every VALUE in badge.tsx's cva() block needs at least one
   story that actually renders it.

     variant: default | secondary | outline                        -> Default /
       Secondary / Outline each set it explicitly.
     tone: brand | neutral | danger | success | warning | info | ai -> the Tones
       story renders all seven, explicitly, side by side.

   `Default`/`Secondary`/etc set BOTH props explicitly (rather than leaning on
   badge.tsx's own `defaultVariants` for the brand/default cell) so the
   literal value text is present in this file for a value even when it is
   the default - not just implied by omission.

   `variant="destructive"` and `intent` are both retired/deprecated (badge.tsx's
   own doc comments) - neither is part of the cva() block any more and neither
   is exercised by the completeness pass. They still get a dedicated story each
   (LegacyDestructive, IntentExamples) so a designer flipping controls can see
   the deprecated paths keep working. The BARE `variant="destructive"` (no
   `tone`/`intent`) is a special case: it renders its original solid
   `bg-danger` fill byte-identically, not `tone="danger"`'s new soft triad -
   see LegacyDestructive below and badge.tsx's own doc comment. Passing an
   explicit `tone`/`intent` alongside it supersedes that fallback and renders
   the real tone recipe instead.
   ============================================================================= */
import type { Meta, StoryObj } from '@storybook/react';

import { Badge } from './badge';
import type { StatusIntent } from '@/design-system/status-registry';

const VARIANTS = ['default', 'secondary', 'outline'] as const;
const TONES = ['brand', 'neutral', 'danger', 'success', 'warning', 'info', 'ai'] as const;
const INTENTS: StatusIntent[] = ['success', 'warning', 'danger', 'info', 'neutral', 'brand'];

const meta = {
  title: 'UI/Badge',
  component: Badge,
  tags: ['autodocs'],
  argTypes: {
    variant: {
      control: { type: 'select' },
      options: [...VARIANTS, 'destructive'],
      description:
        'Structural appearance. `default` is the evidenced signature. `destructive` is deprecated - use `tone="danger"`.',
    },
    tone: {
      control: { type: 'select' },
      options: TONES,
      description:
        'Semantic colour. `brand` (the default) contributes no classes - every existing call site, none of which pass `tone`, renders byte-identical to before this prop existed.',
    },
    intent: {
      control: { type: 'select' },
      options: [undefined, ...INTENTS],
      description:
        'Deprecated status-registry colour shortcut (see badge.tsx). Folds directly into `tone` - resolves to the identically-named `tone` cell, and `tone` wins if both are set.',
    },
    className: { control: false },
  },
} satisfies Meta<typeof Badge>;

export default meta;

type Story = StoryObj<typeof meta>;

/** `variant="default"`, `tone="brand"` - badge.tsx's own `defaultVariants`, set explicitly. */
export const Default: Story = {
  args: {
    variant: 'default',
    tone: 'brand',
    children: 'Default',
  },
};

/** `variant="secondary"` - the muted background-light pill. */
export const Secondary: Story = {
  args: {
    variant: 'secondary',
    children: 'Secondary',
  },
};

/** `variant="outline"` - border only, no fill. */
export const Outline: Story = {
  args: {
    variant: 'outline',
    children: 'Outline',
  },
};

/**
 * `variant="destructive"` (deprecated) - retired as a live cva bucket. With
 * no `tone`/`intent` passed, it still renders its ORIGINAL solid `bg-danger`
 * fill byte-identically (see badge.tsx's own doc comment on
 * `BadgeProps.variant`) - the same "render identically" contract every
 * sibling primitive touched this session honours. Write `tone="danger"`
 * instead for new call sites (that renders the newer soft triad below).
 */
export const LegacyDestructive: Story = {
  args: {
    variant: 'destructive',
    children: 'Destructive (deprecated - use tone="danger")',
  },
};

/**
 * `variant="destructive"` with an explicit `tone="danger"` alongside it - a
 * new combination with no old pixels to preserve, so it renders `tone`'s
 * real soft surface/text/border recipe instead of the legacy solid fallback.
 */
export const LegacyDestructiveWithExplicitTone: Story = {
  args: {
    variant: 'destructive',
    tone: 'danger',
    children: 'variant=destructive, tone=danger -> soft triad',
  },
};

/** Every implemented `tone` value, side by side, on the `default` variant. */
export const Tones: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      <Badge tone="brand">Brand</Badge>
      <Badge tone="neutral">Neutral</Badge>
      <Badge tone="danger">Danger</Badge>
      <Badge tone="success">Success</Badge>
      <Badge tone="warning">Warning</Badge>
      <Badge tone="info">Info</Badge>
      <Badge tone="ai">AI</Badge>
    </div>
  ),
};

/** The full `variant` x `tone` grid from badge.tsx's cva() block, for visual QA. */
export const VariantToneMatrix: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      {VARIANTS.map((variant) => (
        <div key={variant} className="flex flex-wrap items-center gap-2">
          <span className="w-20 text-xs text-text-secondary">{variant}</span>
          {TONES.map((tone) => (
            <Badge key={tone} variant={variant} tone={tone}>
              {tone}
            </Badge>
          ))}
        </div>
      ))}
    </div>
  ),
};

/**
 * `intent` (deprecated) - the status-registry colour shortcut (StatusBadge's
 * sibling for a badge with no domain enum entry to look up: a boolean flag,
 * a kind, a readiness check). Folds directly into `tone`: each of these
 * renders identically to passing the same-named `tone` value directly.
 */
export const IntentExamples: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      {INTENTS.map((intent) => (
        <Badge key={intent} intent={intent}>
          {intent}
        </Badge>
      ))}
    </div>
  ),
};

/**
 * `intent` and `tone` together - legal but `intent` is a no-op once `tone`
 * is set (badge.tsx's own doc comment: "`tone` always wins"). Proves the
 * precedence directly: this renders identically to `tone="danger"` alone,
 * with `intent="warning"` completely superseded.
 */
export const IntentWithToneOverride: Story = {
  args: {
    intent: 'warning',
    tone: 'danger',
    children: 'intent=warning, tone=danger -> renders danger',
  },
};
