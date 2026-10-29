/* =============================================================================
   Input - Storybook stories, full-coverage pass (Storybook phase, W2 plan).

   Storybook 8 is scaffolded (.storybook/main.ts, .storybook/preview.ts) - this
   file imports the real `Meta` / `StoryObj` types from `@storybook/react` and
   wires `argTypes` so every real prop is a live control in the Storybook UI,
   matching badge.stories.tsx and checkbox.stories.tsx (Input's own siblings in
   this pass).

   COMPLETENESS REQUIREMENT (the test this phase adds): every variant KEY and
   every VALUE in input.tsx's cva() block needs at least one story that
   actually renders it.

     input.tsx ships exactly one cva() key, `size`, with three values. Per
     the vocabulary's absolute px ladder (xs=32, sm=36, md=40, lg=44), a
     primitive's default is pinned to the rung matching its own current
     geometry - Input's is 44px, so its default rung is named `lg`, not `md`
     (no call site asked for the 40px `md` rung, so it is left unminted):

       size: lg (default - empty string, today's h-11/44px geometry, 236 call
                  sites render through it and it MUST NOT MOVE)
             sm (h-9/36px - height only, matches the 14 call sites that
                  override to h-9 with no font-size change)
             xs (h-8/32px + forced text-sm - matches the 27 call sites that
                  pair h-8 with a text-sm override)

     `Default` renders the propless/`lg` baseline explicitly. `Small` and
     `ExtraSmall` each render one non-default value on its own. `Sizes` renders
     all three side by side for visual QA. Between them, every key and every
     value in the cva() block is covered - not just the interactive default.

   `tone` and `invalid` are real, shipped Input props but are NOT part of the
   cva() block - input.tsx applies both as plain conditional classes via `cn()`
   after `inputVariants()` runs (see input.tsx's own render function), so
   neither is in scope for the completeness requirement above. They are still
   wired as live controls below (Tone, Invalid) because a designer flipping
   this primitive's knobs needs to see them, matching how badge.stories.tsx
   keeps its own `intent` prop live even though it sits outside Badge's cva()
   block too.

   `tone="business"` is the closed-vocabulary rename of `tone="sage"` (W2/8's
   rename schedule, program plan section 2a.11: "`sage` -> `business`" - see
   input.tsx's own doc comment on `InputTone`). `sage` stays as a deprecated
   alias for the identical class string, covered by DeprecatedToneSage below
   for the same reason ConfirmDialog / Toast / DropdownMenuItem's own stories
   in this pass cover their deprecated `variant` aliases.

   No `variant` / `gap` / `pad` axis exists on Input - the program plan's
   measured-demand walk (236 call sites across 63 files - see input.tsx's own
   header comment) found no evidence for any of the three, so none is invented
   here.
   ============================================================================= */
import type { Meta, StoryObj } from '@storybook/react';

import { Input } from './input';
import { Inline } from './inline';
import { Stack } from './stack';
import { Text } from './text';

const SIZES = ['lg', 'sm', 'xs'] as const;
const TONES = ['default', 'sage', 'business'] as const;

const meta = {
  title: 'UI/Input',
  component: Input,
  tags: ['autodocs'],
  parameters: {
    layout: 'centered',
  },
  args: {
    placeholder: 'Enter a value',
  },
  argTypes: {
    size: {
      control: { type: 'select' },
      options: SIZES,
      description:
        '`lg` is the default and today\'s shipped 44px (h-11) geometry - it MUST NOT MOVE, 236 call sites render through it. Per the vocabulary\'s absolute px ladder, 44px is the `lg` rung (not `md`, which is 40px and has no measured demand on Input). `sm` (36px) and `xs` (32px, forces text-sm at every breakpoint) are additive rungs measured from real className overrides at call sites - see input.tsx\'s header comment for the full count.',
    },
    tone: {
      control: { type: 'select' },
      options: TONES,
      description:
        '`default` is the ordinary hover/focus border treatment. `business` is the closed-vocabulary deposit-box tint ReceiptCard\'s sibling controls use - a plain conditional class, not a cva() key. `sage` is a deprecated alias for the exact same class string.',
    },
    invalid: {
      control: 'boolean',
      description:
        'Whether the current value failed validation - renders the danger border. The call site says WHAT is wrong (its own error message); Input only says HOW it looks because of it.',
    },
    type: {
      control: { type: 'select' },
      options: ['text', 'email', 'password', 'number', 'tel', 'search'],
    },
    disabled: { control: 'boolean' },
    placeholder: { control: 'text' },
    className: { table: { disable: true } },
  },
} satisfies Meta<typeof Input>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The interactive default - no `render` override, so the Controls panel
 * drives this story directly. No props set resolves to `size="lg"`,
 * `tone="default"`, `invalid={false}` - inputVariants' own `defaultVariants`
 * value, and today's shipped geometry (236 call sites render through this).
 */
export const Default: Story = {};

/** `size="sm"` explicitly - the 36px rung, a height-only change from `lg`. */
export const Small: Story = {
  args: {
    size: 'sm',
    placeholder: 'sm - 36px',
  },
};

/** `size="xs"` explicitly - the 32px rung, forces `text-sm` at every breakpoint. */
export const ExtraSmall: Story = {
  args: {
    size: 'xs',
    placeholder: 'xs - 32px',
  },
};

/**
 * Every `size` rung, largest to smallest, side by side - covers every value
 * in input.tsx's cva() block in one glance for visual QA.
 */
export const Sizes: Story = {
  render: () => (
    <Stack gap={3} align="start">
      <Inline gap={3} align="center">
        <Input size="lg" placeholder="lg" />
        <Text size="xs" tone="secondary">
          44px (h-11) - the default and shipped geometry, 236 call sites render through it
        </Text>
      </Inline>
      <Inline gap={3} align="center">
        <Input size="sm" placeholder="sm" />
        <Text size="xs" tone="secondary">
          36px (h-9) - height only, 14 call sites measured this rung
        </Text>
      </Inline>
      <Inline gap={3} align="center">
        <Input size="xs" placeholder="xs" />
        <Text size="xs" tone="secondary">
          32px (h-8) - height + forced text-sm, 27 call sites measured this rung
        </Text>
      </Inline>
    </Stack>
  ),
};

/** `tone="business"` - the deposit-box tint (ReceiptCard's sibling controls use the same tone), the closed-vocabulary name. */
export const Tone: Story = {
  args: {
    tone: 'business',
    placeholder: 'Deposit amount',
  },
};

/**
 * The deprecated `tone="sage"` alias - byte-identical to `tone="business"`
 * above. The literal shape the 2 real Input call sites still on disk use
 * (components/jobs/items/ReceiptCard.tsx:386,594).
 */
export const DeprecatedToneSage: Story = {
  args: {
    tone: 'sage',
    placeholder: 'Deposit amount',
  },
};

/** `invalid` - the danger border a failed-validation call site renders. */
export const Invalid: Story = {
  args: {
    invalid: true,
    defaultValue: 'not-a-valid-value',
  },
};

/** The native `disabled` attribute, forwarded straight through to the `<input>`. */
export const Disabled: Story = {
  args: {
    disabled: true,
    placeholder: 'Disabled',
  },
};
