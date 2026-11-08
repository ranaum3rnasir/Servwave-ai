/* =============================================================================
   Textarea - Storybook stories, full-coverage pass (Storybook phase, W2 plan).

   Storybook 8 is scaffolded (.storybook/main.ts, .storybook/preview.ts) - this
   file imports the real `Meta` / `StoryObj` types from `@storybook/react` and
   wires `argTypes` so every real prop is a live control in the Storybook UI,
   matching input.stories.tsx (Textarea's own sibling in phase 8a: both ship a
   single `size` axis with the same md/no-op-empty-string shape).

   COMPLETENESS REQUIREMENT (the test this phase adds): every variant KEY and
   every VALUE in textarea.tsx's cva() block needs at least one story that
   actually renders it.

     textarea.tsx ships exactly one cva() key, `size`, with three values:

       size: md (default - empty string, today's min-h-[80px]/text-base/
                  md:text-sm geometry, 43 call sites render through it and it
                  MUST NOT MOVE)
             sm (min-h-16/64px + forced text-sm - matches the 5 compact
                 inline-note/description call sites, e.g. AddLineDialog.tsx)
             lg (min-h-28/112px, height only - matches the 3 workflow-composer
                 message-body call sites, e.g. SendTextForm.tsx)

     `Default` renders the propless/`md` baseline explicitly. `Small` and
     `Large` each render one non-default value on its own. `Sizes` renders all
     three side by side for visual QA. Between them, every key and every value
     in the cva() block is covered - not just the interactive default.

   No `tone` / `variant` / `gap` / `pad` axis exists on Textarea - textarea.tsx's
   own header comment records zero colour-shaped overrides across the 43
   measured call sites, so none of those is invented here. The only props this
   file wires as controls beyond `size` are plain native `<textarea>`
   attributes (`placeholder`, `rows`, `disabled`), forwarded straight through
   via `...props` in textarea.tsx.

   FLAGGED: these three values (64 / 80 / 112px) are NOT VOCAB_V3's shared
   six-rung 24-44px ladder - the ladder's own max (lg=44px) is smaller than
   Textarea's frozen 80px default, so literal ladder reuse is impossible
   without either moving that default or shipping an `lg` smaller than the
   default. See textarea.tsx's header comment for the full explanation. This
   is an open item pending the vocabulary owner's call, not a silent
   deviation.
   ============================================================================= */
import type { Meta, StoryObj } from '@storybook/react';

import { Textarea } from './textarea';
import { Inline } from './inline';
import { Stack } from './stack';
import { Text } from './text';

const SIZES = ['md', 'sm', 'lg'] as const;

const meta = {
  title: 'UI/Textarea',
  component: Textarea,
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
        '`md` is the default and today\'s shipped min-h-[80px] (80px) geometry - it MUST NOT MOVE, 43 call sites render through it. `sm` (64px, forces text-sm at every breakpoint) and `lg` (112px, height only) are additive rungs measured from real className overrides at call sites - see textarea.tsx\'s header comment for the full count. Note: these px values are Textarea\'s own min-height sub-scale, not VOCAB_V3\'s shared 24-44px ladder - flagged as an open item in textarea.tsx, not a silent deviation.',
    },
    rows: { control: { type: 'number' } },
    disabled: { control: 'boolean' },
    placeholder: { control: 'text' },
    className: { table: { disable: true } },
  },
} satisfies Meta<typeof Textarea>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The interactive default - no `render` override, so the Controls panel
 * drives this story directly. No props set resolves to `size="md"` -
 * textareaVariants' own `defaultVariants` value, and today's shipped
 * geometry (43 call sites render through this).
 */
export const Default: Story = {};

/** `size="sm"` explicitly - the 64px rung, forces `text-sm` at every breakpoint. */
export const Small: Story = {
  args: {
    size: 'sm',
    placeholder: 'sm - 64px',
  },
};

/** `size="lg"` explicitly - the 112px rung, a height-only change from `md`. */
export const Large: Story = {
  args: {
    size: 'lg',
    placeholder: 'lg - 112px',
  },
};

/**
 * Every `size` rung, largest to smallest, side by side - covers every value
 * in textarea.tsx's cva() block in one glance for visual QA.
 */
export const Sizes: Story = {
  render: () => (
    <Stack gap={3} align="start">
      <Inline gap={3} align="start">
        <Textarea size="lg" placeholder="lg" />
        <Text size="xs" tone="secondary">
          112px (min-h-28) - height only, 3 workflow-composer message-body sites measured this rung
        </Text>
      </Inline>
      <Inline gap={3} align="start">
        <Textarea size="md" placeholder="md" />
        <Text size="xs" tone="secondary">
          80px (min-h-[80px]) - the default and shipped geometry, 43 call sites render through it
        </Text>
      </Inline>
      <Inline gap={3} align="start">
        <Textarea size="sm" placeholder="sm" />
        <Text size="xs" tone="secondary">
          64px (min-h-16) - height + forced text-sm, 5 compact inline-note sites measured this rung
        </Text>
      </Inline>
    </Stack>
  ),
};

/** The native `disabled` attribute, forwarded straight through to the `<textarea>`. */
export const Disabled: Story = {
  args: {
    disabled: true,
    placeholder: 'Disabled',
  },
};

/** The native `rows` attribute, forwarded straight through - independent of the `size` geometry. */
export const Rows: Story = {
  args: {
    rows: 6,
    placeholder: '6 rows',
  },
};
