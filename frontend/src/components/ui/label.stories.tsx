/* =============================================================================
   Label - Storybook stories, full-coverage pass (Storybook phase, W2 plan).

   Real `Meta` / `StoryObj` types from `@storybook/react` (Storybook 8 is
   scaffolded in this worktree - see .storybook/main.ts) with `argTypes`
   wired so every axis is a live control in the Storybook UI, matching the
   pattern in badge.stories.tsx / chip.stories.tsx.

   Coverage requirement (the completeness pass this phase adds): every
   variant KEY and every VALUE in label.tsx's cva() block needs at least one
   story that actually renders it. label.tsx's cva() block has three variant
   keys:

     tone:   subtle | neutral | default | strong
     size:   sm | xs
     weight: bold | semibold

   `subtle` and `neutral` are the closed-vocabulary `tone` values (`tone` is
   one of the five vocabulary axes: variant/tone/size/gap/pad, with tone the
   settled 9-value list - program plan section 2a.2, rev 3). `subtle` is the
   settled rename of rev 2's `muted`. `default` and `strong` are deprecated
   aliases for the exact same two class strings, kept only so the 12 existing
   call sites passing `tone="strong"` (and everything relying on the implicit
   old default) keep rendering byte-for-byte identical output - see
   label.tsx's own comment and __tests__/label.test.tsx. All four `tone`
   values get their own story below (Subtle / Neutral / LegacyDefault /
   LegacyStrong) so the completeness parser finds every one of them actually
   rendered, not just implied by a shared default.

   `size` and `weight` were added in a repair pass after this file first
   shipped: the per-primitive scope table (program plan section 2a.11, Label
   row) requires both alongside `tone`, and the first pass here shipped only
   the tone half with a header comment saying they were "blocked on a naming
   decision" - see label.tsx's own current header for why that reasoning did
   not hold up (the same "size" tension was already hit and already resolved
   the same way by text.tsx/link.tsx, which are settled precedent in this
   tree). `size` is a font-size scale (`sm` default / `xs`), not the
   control-height ladder Button/Input use for their own `size` prop. `weight`
   is the closed-vocabulary weight axis (`bold` default / `semibold`). Both
   get a story per value below (Size / Weight, plus the combined SizeWeight
   overview) so the completeness parser finds every value actually rendered.

   No `variant`, `gap` or `pad` story: label.tsx's cva() block has no such
   variant keys - a label is one line of text, not a container with padding
   or gap, or a structural-appearance axis.
   ============================================================================= */
import type { Meta, StoryObj } from '@storybook/react';

import { Label } from './label';
import { Input } from './input';
import { Checkbox } from './checkbox';

const TONES = ['subtle', 'neutral', 'default', 'strong'] as const;
const SIZES = ['sm', 'xs'] as const;
const WEIGHTS = ['bold', 'semibold'] as const;

const meta = {
  title: 'UI/Label',
  component: Label,
  tags: ['autodocs'],
  argTypes: {
    tone: {
      control: { type: 'select' },
      options: TONES,
      description:
        '`subtle` (the default) and `neutral` are the closed-vocabulary values. `default` and `strong` are deprecated aliases for the exact same two class strings, kept for the existing call sites that already pass them - see label.tsx\'s own comment.',
    },
    size: {
      control: { type: 'select' },
      options: SIZES,
      description:
        'Font size. `sm` (the default) matches the pre-existing hard-coded `text-sm`; `xs` is measured call-site demand. Named `size` for consistency with the sibling text primitives (Text, TextLink), not the control-height ladder Button/Input use - see label.tsx\'s own comment.',
    },
    weight: {
      control: { type: 'select' },
      options: WEIGHTS,
      description:
        'Font weight. `bold` (the default) matches the pre-existing hard-coded `font-bold`; `semibold` is measured call-site demand.',
    },
    htmlFor: {
      control: { type: 'text' },
      description: 'Native `<label for>` - associates the label with a form control by id.',
    },
    children: {
      control: { type: 'text' },
    },
    className: { control: false },
  },
} satisfies Meta<typeof Label>;

export default meta;

type Story = StoryObj<typeof meta>;

/** No props - the propless render, byte-identical to `tone="subtle"`. */
export const Default: Story = {
  args: {
    children: 'Full name',
  },
};

/** `tone="subtle"` - the closed-vocabulary default (`text-text-secondary`). */
export const Subtle: Story = {
  args: {
    tone: 'subtle',
    children: 'Subtle',
  },
};

/** `tone="neutral"` - the closed-vocabulary strong value (`text-text-primary`). */
export const Neutral: Story = {
  args: {
    tone: 'neutral',
    children: 'Neutral',
  },
};

/**
 * `tone="default"` - deprecated alias, resolves to the exact same class
 * string as `tone="subtle"`. Kept legal, not part of the closed vocabulary
 * going forward.
 */
export const LegacyDefault: Story = {
  args: {
    tone: 'default',
    children: 'Legacy "default" (= subtle)',
  },
};

/**
 * `tone="strong"` - deprecated alias, resolves to the exact same class
 * string as `tone="neutral"`. The 12 pre-existing call sites passing this
 * value keep rendering unchanged.
 */
export const LegacyStrong: Story = {
  args: {
    tone: 'strong',
    children: 'Legacy "strong" (= neutral)',
  },
};

/** Every implemented `tone` value, side by side. */
export const Tones: Story = {
  render: () => (
    <div className="flex flex-col gap-2">
      {TONES.map((tone) => (
        <Label key={tone} tone={tone}>
          tone={tone}
        </Label>
      ))}
    </div>
  ),
};

/** `size="sm"` - the closed-vocabulary default, matches the pre-existing hard-coded `text-sm`. */
export const SizeSm: Story = {
  args: {
    size: 'sm',
    children: 'Size sm (default)',
  },
};

/** `size="xs"` - measured demand (20 call sites wanting to override the default). */
export const SizeXs: Story = {
  args: {
    size: 'xs',
    children: 'Size xs',
  },
};

/** `weight="bold"` - the closed-vocabulary default, matches the pre-existing hard-coded `font-bold`. */
export const WeightBold: Story = {
  args: {
    weight: 'bold',
    children: 'Weight bold (default)',
  },
};

/** `weight="semibold"` - measured demand (13 call sites wanting to override the default). */
export const WeightSemibold: Story = {
  args: {
    weight: 'semibold',
    children: 'Weight semibold',
  },
};

/** Every implemented `size` value, side by side. */
export const Sizes: Story = {
  render: () => (
    <div className="flex flex-col gap-2">
      {SIZES.map((size) => (
        <Label key={size} size={size}>
          size={size}
        </Label>
      ))}
    </div>
  ),
};

/** Every implemented `weight` value, side by side. */
export const Weights: Story = {
  render: () => (
    <div className="flex flex-col gap-2">
      {WEIGHTS.map((weight) => (
        <Label key={weight} weight={weight}>
          weight={weight}
        </Label>
      ))}
    </div>
  ),
};

/**
 * Real usage: a Label paired with an Input via `htmlFor`/`id`. Exercises
 * the base string's `has-[+input:is(:hover,:focus)]:text-text-primary` -
 * hovering or focusing the input also colours the label, regardless of
 * `tone`.
 */
export const WithFormField: Story = {
  render: () => (
    <div className="flex w-64 flex-col gap-1.5">
      <Label htmlFor="story-label-name">Full name</Label>
      <Input id="story-label-name" placeholder="Jane Contractor" />
    </div>
  ),
};

/**
 * A disabled sibling control dims its Label via `peer-disabled:opacity-70`
 * (and `cursor-not-allowed`) - real composition shape from
 * AcceptInvitePage.tsx / CreateJobInvoiceDialog.tsx: `Checkbox` carries its
 * own `peer` class, `Label` follows it in the DOM and reacts to its
 * disabled state.
 */
export const WithDisabledField: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <Checkbox id="story-label-disabled" disabled />
      <Label htmlFor="story-label-disabled">Taxable (disabled)</Label>
    </div>
  ),
};
