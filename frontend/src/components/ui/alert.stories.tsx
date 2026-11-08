/* =============================================================================
   Alert - Storybook stories, full-coverage pass (Storybook phase, W2 plan).

   Storybook 8 is scaffolded now (.storybook/main.ts, .storybook/preview.ts,
   the @storybook/react-vite devDependency in package.json) - unlike the
   "new primitives" phase's first-pass stories this file replaces (see the
   git history of this file for that first pass's own header, which explains
   why it fell back to a loose local Meta/StoryObj-shaped object rather than
   race 30-odd parallel agents on an unscaffolded package.json), this file
   imports the real `Meta` / `StoryObj` types from `@storybook/react` and
   wires `argTypes` so every axis is a live control in the Storybook UI.

   Coverage requirement (the completeness pass this phase adds): every
   variant KEY and every VALUE in alert.tsx's cva() block needs at least one
   story that actually renders it.

     variant: outline | solid | ghost                    -> Default renders
       outline explicitly, SolidDanger renders solid, GhostWarning renders
       ghost. VariantToneMatrix renders all three again, side by side.
     tone: neutral | danger | success | warning | ai      -> Default renders
       neutral explicitly, DangerOutline/Success/Warning/Ai render the other
       four. VariantToneMatrix renders all five again, side by side.
     scale: xs | sm | base                                -> Default renders
       sm explicitly, ScaleSteps renders all three side by side. (Repair
       pass, VOCAB_V3 rule 3: this cva key was named `size` and used the
       retired xs/sm/md/lg relative ladder - Alert is a static div, not a
       control, so it has no control height for `size` to mean. Renamed to
       `scale`, values renamed to the literal Tailwind font-size key each
       renders; see alert.tsx's header note for the full rationale and the
       `md` -> `sm` mapping. The deprecated `size` prop still works - see
       DeprecatedSize below.)
     gap: 0 | 0.5 | 1 | 1.5 | 2 | 2.5 | 3 | 4 | 5 | 6 | 8 | 12
                                                            -> Default renders
       0 explicitly, GapScale renders all twelve steps side by side.

   `Default` sets `variant`, `tone`, `size`, and `gap` explicitly (rather
   than leaning on alert.tsx's own `defaultVariants`) so the literal value
   text is present in this file even for the inert-default cell - not just
   implied by omission, matching badge.stories.tsx / stack.stories.tsx's own
   convention.

   `pad` / `padX` / `padY` / `padTop` / `padRight` / `padBottom` / `padLeft`
   are NOT part of alert.tsx's cva() block - they are `design-system/
   spacing.ts`'s own `PadProps`, applied after the cva string (see alert.tsx's
   header note on why they are numbers, not the published word scale, and why
   Alert's default is the measured `px-3 py-2` geometry rather than a blank
   slate). They are outside what the completeness pass checks, but they are
   real, live-controllable props - wired here as full `argTypes` controls
   (same treatment box.stories.tsx / card.stories.tsx give the identical
   axis) plus a `PaddingScale` story, so a designer can flip padding the same
   as variant/tone/size/gap.
   ============================================================================= */
import type { Meta, StoryObj } from '@storybook/react';

import { Alert, type AlertGap, type AlertScale, type AlertSize, type AlertTone, type AlertVariant } from './alert';
import { PAD_STEPS, type PadStep } from '@/design-system/spacing';

const VARIANTS: AlertVariant[] = ['outline', 'solid', 'ghost'];
const TONES: AlertTone[] = ['neutral', 'danger', 'success', 'warning', 'ai'];
const SCALES: AlertScale[] = ['xs', 'sm', 'base'];
const LEGACY_SIZES: AlertSize[] = ['xs', 'sm', 'md', 'lg'];
const GAPS: AlertGap[] = [0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 12];

/** A tiny inline warning glyph, shared by every icon-plus-text story below. */
const WarningIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    aria-hidden="true"
    className="mt-0.5 shrink-0"
  >
    <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
    <path d="M8 4.5v4M8 11v.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

const meta = {
  title: 'UI/Alert',
  component: Alert,
  tags: ['autodocs'],
  argTypes: {
    variant: {
      control: { type: 'select' },
      options: VARIANTS,
      description:
        'Structural appearance. `outline` (the default) is the measured 22x tinted-surface-plus-border shape; `solid` and `ghost` are additive, built from tokens.css infrastructure that already exists for exactly this purpose.',
    },
    tone: {
      control: { type: 'select' },
      options: TONES,
      description:
        'Semantic colour, matching Badge\'s own tone axis exactly. `neutral` is the default.',
    },
    scale: {
      control: { type: 'select' },
      options: SCALES,
      description:
        'Font/icon size, named after the Tailwind font-size key it renders. Not control height - Alert is a static div, not a control. `sm` (the default) is `text-sm`, the app\'s ambient body-copy size.',
    },
    size: {
      control: { type: 'select' },
      options: LEGACY_SIZES,
      description:
        '@deprecated Use `scale`. Old values render identically: xs -> xs, sm -> sm, md -> sm, lg -> base. Ignored when `scale` is also passed.',
    },
    gap: {
      control: { type: 'select' },
      options: GAPS,
      description:
        'Space between direct children, in the same 4px-grid steps as Stack/Inline\'s own `gap` (literally the same type, `StackGap`, aliased as `AlertGap`). `0` by default.',
    },
    pad: {
      control: { type: 'select' },
      options: [...PAD_STEPS],
      description:
        'Uniform padding on all four sides, as a 4px-grid step. Overrides the default measured geometry (`px-3 py-2`) wholesale when set.',
    },
    padX: {
      control: { type: 'select' },
      options: [...PAD_STEPS],
      description: 'Horizontal padding. Overrides the default on the left and right sides.',
    },
    padY: {
      control: { type: 'select' },
      options: [...PAD_STEPS],
      description: 'Vertical padding. Overrides the default on the top and bottom sides.',
    },
    padTop: {
      control: { type: 'select' },
      options: [...PAD_STEPS],
      description: 'Top padding. Overrides `padY` and `pad` on this side only.',
    },
    padRight: {
      control: { type: 'select' },
      options: [...PAD_STEPS],
      description: 'Right padding. Overrides `padX` and `pad` on this side only.',
    },
    padBottom: {
      control: { type: 'select' },
      options: [...PAD_STEPS],
      description: 'Bottom padding. Overrides `padY` and `pad` on this side only.',
    },
    padLeft: {
      control: { type: 'select' },
      options: [...PAD_STEPS],
      description: 'Left padding. Overrides `padX` and `pad` on this side only.',
    },
    role: {
      control: { type: 'select' },
      options: ['alert', 'status'],
      description:
        '`alert` (the default) is an assertive live region; `status` is a quieter, non-interrupting announcement.',
    },
    className: { control: false },
  },
} satisfies Meta<typeof Alert>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * `variant="outline"`, `tone="neutral"`, `scale="sm"`, `gap={0}` -
 * alert.tsx's own `defaultVariants`, set explicitly. No padding prop set
 * either, so this also renders the measured default geometry (`px-3 py-2`).
 */
export const Default: Story = {
  args: {
    variant: 'outline',
    tone: 'neutral',
    scale: 'sm',
    gap: 0,
    children: 'This is an informational alert.',
  },
};

/**
 * `tone="danger"` alone reproduces the measured 22x signature
 * (`bg-danger/10 border border-danger/20 px-3 py-2 rounded-md`) that this
 * primitive exists to retire.
 */
export const DangerOutline: Story = {
  args: {
    tone: 'danger',
    children: 'Something went wrong. Please try again.',
  },
};

/** `tone="success"` - the outline/tinted-surface shape, success colour. */
export const Success: Story = {
  args: {
    tone: 'success',
    children: 'Changes saved successfully.',
  },
};

/** `tone="warning"` - the outline/tinted-surface shape, warning colour. */
export const Warning: Story = {
  args: {
    tone: 'warning',
    children: 'This action cannot be undone.',
  },
};

/** `tone="ai"` - the outline/tinted-surface shape, AI colour. */
export const Ai: Story = {
  args: {
    tone: 'ai',
    children: 'Servy suggests reviewing this estimate before sending.',
  },
};

/**
 * `variant="solid"` - a strong filled banner, built from tokens.css's
 * `-strong` roles (the same white-text-safe role Button's own `solid`
 * variant already uses).
 */
export const SolidDanger: Story = {
  args: {
    variant: 'solid',
    tone: 'danger',
    children: 'This job cannot be invoiced until it is completed.',
  },
};

/** `variant="ghost"` - tinted text only, no fill or border. */
export const GhostWarning: Story = {
  args: {
    variant: 'ghost',
    tone: 'warning',
    children: 'Draft not yet sent to the customer.',
  },
};

/**
 * The full `variant` x `tone` grid from alert.tsx's cva() block, for visual
 * QA - every cell alert.tsx's `compoundVariants` paints, side by side.
 */
export const VariantToneMatrix: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      {VARIANTS.map((variant) => (
        <div key={variant} className="flex flex-col gap-2">
          <span className="text-xs text-text-secondary">variant=&quot;{variant}&quot;</span>
          <div className="flex flex-wrap gap-2">
            {TONES.map((tone) => (
              <Alert key={tone} variant={variant} tone={tone} className="w-48">
                {tone}
              </Alert>
            ))}
          </div>
        </div>
      ))}
    </div>
  ),
};

/** Every `scale` rung from alert.tsx's cva() block, smallest to largest. */
export const ScaleSteps: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      {SCALES.map((scale) => (
        <Alert key={scale} tone="danger" scale={scale}>
          scale=&quot;{scale}&quot;{scale === 'sm' ? ' (default)' : ''}
        </Alert>
      ))}
    </div>
  ),
};

/**
 * The deprecated `size` prop, still live as an alias. Each row renders
 * `size="..."` next to the `scale` value it maps to via
 * `LEGACY_ALERT_SCALE` in alert.tsx - `md` collapses onto `sm` since both
 * rendered byte-identical classes under the old scale.
 */
export const DeprecatedSize: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      {LEGACY_SIZES.map((size) => (
        <Alert key={size} tone="danger" size={size}>
          size=&quot;{size}&quot;{size === 'md' ? ' (deprecated default, maps to scale="sm")' : ''}
        </Alert>
      ))}
    </div>
  ),
};

/**
 * Every `gap` step from alert.tsx's cva() block, side by side - the same
 * 4px-grid ramp Stack/Inline's own `gap` uses (see alert.tsx's header note
 * on why `AlertGap` is literally `StackGap`, not a redeclared scale). Each
 * row is an icon-plus-text pair so the space between the two children is
 * visible.
 */
export const GapScale: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      {GAPS.map((gap) => (
        <div key={gap} className="flex items-center gap-3">
          <span className="w-16 text-xs text-text-secondary">gap={String(gap)}</span>
          <Alert tone="danger" gap={gap} className="flex-1">
            <WarningIcon />
            <span>Payment failed.</span>
          </Alert>
        </div>
      ))}
    </div>
  ),
};

/**
 * An icon-plus-text row, using `gap` to space the two children - the
 * realistic composed shape a call site reaches for.
 */
export const WithIcon: Story = {
  args: {
    tone: 'danger',
    gap: 2,
  },
  render: (args) => (
    <Alert {...args}>
      <WarningIcon />
      <span>Payment failed. Update the card on file to retry.</span>
    </Alert>
  ),
};

/**
 * Every step on the `pad` scale (`design-system/spacing.ts`'s `PAD_STEPS`,
 * imported below so the Controls dropdown can never drift from what
 * alert.tsx actually renders), overriding the default measured geometry
 * (`px-3 py-2`) wholesale. Not part of the cva() completeness requirement -
 * `pad` lives outside alert.tsx's cva() block - but wired here as a full
 * control, same as box.stories.tsx / card.stories.tsx give the identical
 * axis.
 */
export const PaddingScale: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      {PAD_STEPS.map((step: PadStep) => (
        <div key={step} className="flex items-center gap-3">
          <span className="w-16 text-xs text-text-secondary">pad={String(step)}</span>
          <Alert tone="neutral" pad={step} className="flex-1">
            pad={'{' + step + '}'}
          </Alert>
        </div>
      ))}
    </div>
  ),
};

/**
 * `role="status"` - a quieter, non-interrupting announcement, overriding
 * the sane `role="alert"` default (see alert.tsx's own JSDoc).
 */
export const QuietStatus: Story = {
  args: {
    tone: 'success',
    role: 'status',
    children: 'Autosaved a moment ago.',
  },
};
