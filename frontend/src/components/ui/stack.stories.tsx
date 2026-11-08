/* =============================================================================
   Stack - Storybook stories, full-coverage pass (Storybook phase, W2 plan).

   Storybook 8 is scaffolded now (.storybook/main.ts, .storybook/preview.ts,
   the @storybook/react-vite devDependency in package.json) - unlike the
   "new primitives" phase's first-pass stories this file replaces (see the
   git history of this file for that first pass's own header), this file
   imports the real `Meta` / `StoryObj` types from `@storybook/react` and
   wires `argTypes` so every axis is a live control in the Storybook UI.

   Coverage requirement (the completeness pass this phase adds): every
   variant KEY and every VALUE in stack.tsx's cva() block needs at least one
   story that actually renders it.

     direction: vertical | horizontal      -> Default renders vertical
       explicitly, Horizontal renders horizontal explicitly.
     wrap: true | false                    -> Default renders false
       explicitly, HorizontalWrap renders true.
     gap: 0 | 0.5 | 1 | 1.5 | 2 | 2.5 | 3 | 4 | 5 | 6 | 8 | 12
                                            -> Default renders 0 explicitly,
       GapScale renders all twelve steps side by side.
     align: start | center | end | stretch | baseline
                                            -> AlignOptions renders all five.
     justify: start | center | end | between | around | evenly
                                            -> JustifyOptions renders all six.

   `Default` sets `direction`, `wrap`, and `gap` explicitly (rather than
   leaning on stack.tsx's own `defaultVariants`) so the literal value text is
   present in this file even for the inert-default cell - not just implied
   by omission. `align` / `justify` have no default in stack.tsx on purpose
   (see stack.tsx's own comment: a Stack that says nothing about alignment
   must emit no alignment class), so `Default` leaves both unset.
   ============================================================================= */
import type { Meta, StoryObj } from '@storybook/react';

import { Stack, type StackGap } from './stack';

const GAPS: StackGap[] = [0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 12];
const ALIGNS = ['start', 'center', 'end', 'stretch', 'baseline'] as const;
const JUSTIFIES = ['start', 'center', 'end', 'between', 'around', 'evenly'] as const;

/* Same token classes Badge's stories use (rounded border border-border
   bg-neutral-surface px-2.5 py-0.5 text-xs) - a plain box, no new appearance
   decision to make. */
const Swatch = ({ label }: { label: string }) => (
  <div className="rounded border border-border bg-neutral-surface px-2.5 py-0.5 text-xs">
    {label}
  </div>
);

const meta = {
  title: 'UI/Stack',
  component: Stack,
  tags: ['autodocs'],
  argTypes: {
    direction: {
      control: { type: 'select' },
      options: ['vertical', 'horizontal'],
      description: 'Which way children flow. `vertical` (the default) is a column, `horizontal` is a row.',
    },
    wrap: {
      control: 'boolean',
      description: 'Let a horizontal stack wrap onto more lines.',
    },
    gap: {
      control: { type: 'select' },
      options: GAPS,
      description:
        'Space between children, in 4px-grid steps - a number, not a size word (see stack.tsx). `gap={6}` is 24px.',
    },
    align: {
      control: { type: 'select' },
      options: [undefined, ...ALIGNS],
      description: 'Cross-axis alignment. Omit to inherit flex\'s own `stretch` and emit no class.',
    },
    justify: {
      control: { type: 'select' },
      options: [undefined, ...JUSTIFIES],
      description: 'Main-axis distribution. Omit to inherit flex\'s own `flex-start` and emit no class.',
    },
    className: { control: false },
  },
} satisfies Meta<typeof Stack>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * `direction="vertical"`, `wrap={false}`, `gap={0}` - stack.tsx's own
 * `defaultVariants`, set explicitly. Renders exactly
 * `<div class="flex flex-col gap-0">`: a plain full-width column with no
 * spacing between children, geometrically inert, so wrapping existing
 * markup in a bare `<Stack>` cannot move a pixel.
 */
export const Default: Story = {
  args: {
    direction: 'vertical',
    wrap: false,
    gap: 0,
  },
  render: (args) => (
    <Stack {...args}>
      <Swatch label="one" />
      <Swatch label="two" />
      <Swatch label="three" />
    </Stack>
  ),
};

/** `direction="horizontal"` - the shape most call sites reach for. */
export const Horizontal: Story = {
  args: {
    direction: 'horizontal',
    align: 'center',
    gap: 2,
  },
  render: (args) => (
    <Stack {...args}>
      <Swatch label="one" />
      <Swatch label="two" />
      <Swatch label="three" />
    </Stack>
  ),
};

/**
 * `wrap` - a wrapping horizontal row, matching a filter-chip row shape.
 * `EstimatesPage.tsx:539`, `JobsPage.tsx:442` and `CustomersPage.tsx:549`
 * (applied-filter chips) are exactly this shape: `flex items-center gap-2
 * flex-wrap`.
 */
export const HorizontalWrap: Story = {
  args: {
    direction: 'horizontal',
    align: 'center',
    gap: 2,
    wrap: true,
  },
  render: (args) => (
    <Stack {...args}>
      {['one', 'two', 'three', 'four', 'five', 'six'].map((label) => (
        <Swatch key={label} label={label} />
      ))}
    </Stack>
  ),
};

/**
 * Every `gap` step from stack.tsx's cva() block, side by side - the
 * 4px-grid ramp `gap` is a number on, not a size word (see stack.tsx's own
 * comment on why).
 */
export const GapScale: Story = {
  render: () => (
    <Stack gap={4}>
      {GAPS.map((gap) => (
        <Stack key={gap} direction="horizontal" align="center" gap={3}>
          <div className="w-16 text-xs text-text-secondary">gap={String(gap)}</div>
          <Stack direction="horizontal" gap={gap}>
            <Swatch label="one" />
            <Swatch label="two" />
            <Swatch label="three" />
          </Stack>
        </Stack>
      ))}
    </Stack>
  ),
};

/**
 * Every `align` value from stack.tsx's cva() block, side by side, on a
 * horizontal stack tall enough to show the cross-axis effect.
 */
export const AlignOptions: Story = {
  render: () => (
    <Stack gap={4}>
      {ALIGNS.map((align) => (
        <Stack key={align} direction="horizontal" align="center" gap={3}>
          <div className="w-20 text-xs text-text-secondary">align={align}</div>
          <Stack
            direction="horizontal"
            align={align}
            gap={2}
            className="h-16 rounded border border-border bg-neutral-surface px-2"
          >
            <Swatch label="one" />
            <Swatch label="two" />
            <Swatch label="three" />
          </Stack>
        </Stack>
      ))}
    </Stack>
  ),
};

/**
 * Every `justify` value from stack.tsx's cva() block, side by side, on a
 * horizontal stack wide enough to show the main-axis distribution.
 */
export const JustifyOptions: Story = {
  render: () => (
    <Stack gap={4}>
      {JUSTIFIES.map((justify) => (
        <Stack key={justify} gap={1}>
          <div className="text-xs text-text-secondary">justify={justify}</div>
          <Stack
            direction="horizontal"
            align="center"
            justify={justify}
            className="w-96 rounded border border-border bg-neutral-surface px-2 py-1"
          >
            <Swatch label="one" />
            <Swatch label="two" />
            <Swatch label="three" />
          </Stack>
        </Stack>
      ))}
    </Stack>
  ),
};

/** `justify="between"`, matching a toolbar shape (title left, actions right). */
export const JustifyBetween: Story = {
  args: {
    direction: 'horizontal',
    align: 'center',
    justify: 'between',
  },
  render: (args) => (
    <Stack {...args}>
      <Swatch label="title" />
      <Swatch label="actions" />
    </Stack>
  ),
};

/**
 * `justify="end"`, matching the action toolbar shape at
 * `JobDetailPage.tsx:1042`: `flex items-center gap-2 shrink-0 flex-wrap
 * justify-end`.
 */
export const JustifyEnd: Story = {
  args: {
    direction: 'horizontal',
    align: 'center',
    justify: 'end',
    gap: 2,
    wrap: true,
  },
  render: (args) => (
    <Stack {...args}>
      <Swatch label="cancel" />
      <Swatch label="save" />
    </Stack>
  ),
};
