/* =============================================================================
   Inline - Storybook stories, full-coverage pass (Storybook phase, W2 plan).

   Storybook 8 is scaffolded now (.storybook/main.ts, .storybook/preview.ts,
   the @storybook/react-vite devDependency in package.json) - unlike this
   file's own "new primitives" first pass (and Stack's sibling file, still
   pending the same conversion), this version imports the real `Meta` /
   `StoryObj` types from `@storybook/react` and wires `argTypes` so every axis
   is a live control in the Storybook UI, the same shape as badge.stories.tsx
   / separator.stories.tsx.

   Coverage requirement (the completeness pass this phase adds): every
   variant KEY and every VALUE in inline.tsx's cva() block needs at least one
   story that actually renders it.

     wrap: false | true              -> Default (false) / Wrap (true).
     gap: 0 | 0.5 | 1 | 1.5 | 2 | 2.5 | 3 | 4 | 5 | 6 | 8 | 12
                                      -> Default renders 0 explicitly;
                                         GapScale renders the other eleven
                                         steps, each labelled, from the same
                                         `GAPS` array `argTypes.gap.options`
                                         is built from - the two cannot drift.
     align: start | center | end | stretch | baseline
                                      -> Align renders all five, each in a
                                         fixed-height row so the differences
                                         are actually visible; Wrap and
                                         JustifyBetween/JustifyEnd set
                                         "center" again in a realistic shape.
     justify: start | center | end | between | around | evenly
                                      -> Justify renders all six; JustifyBetween
                                         and JustifyEnd repeat two of them
                                         against the real call-site shapes
                                         inline.tsx's header cites
                                         (EstimatesPage.tsx:539 /
                                         JobsPage.tsx:442 / CustomersPage.tsx:549
                                         for the filter-chip row, and
                                         JobDetailPage.tsx:1044 for the action
                                         cluster).

   `align` and `justify` have no `defaultVariants` entry (inline.tsx's own
   header: "a row that says nothing about alignment must emit no alignment
   class"), so their `argTypes` options include `undefined` as the first
   entry, matching badge.stories.tsx's `intent` control - a designer can
   clear either axis back to "inherits flex's own default" from the Storybook
   UI, not just add one.
   ============================================================================= */
import type { Meta, StoryObj } from '@storybook/react';

import { Inline } from './inline';
import type { InlineGap } from './inline';

const GAPS: InlineGap[] = [0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 12];
const ALIGNS = ['start', 'center', 'end', 'stretch', 'baseline'] as const;
const JUSTIFIES = ['start', 'center', 'end', 'between', 'around', 'evenly'] as const;

/* Same token classes Stack's stories use (rounded border border-border
   bg-neutral-surface px-2.5 py-0.5 text-xs) - a plain box, no new appearance
   decision to make. */
const Swatch = ({ label }: { label: string }) => (
  <div className="rounded border border-border bg-neutral-surface px-2.5 py-0.5 text-xs">
    {label}
  </div>
);

/* A shorter and a taller swatch, side by side, so start/center/end/stretch/
   baseline actually read as different positions instead of all landing on
   the same line. */
const ShortSwatch = () => (
  <div className="rounded border border-border bg-neutral-surface px-2.5 py-0.5 text-xs">
    short
  </div>
);
const TallSwatch = () => (
  <div className="rounded border border-border bg-neutral-surface px-2.5 py-3 text-sm">
    tall
  </div>
);

const meta = {
  title: 'UI/Inline',
  component: Inline,
  tags: ['autodocs'],
  argTypes: {
    wrap: {
      control: { type: 'boolean' },
      description:
        'Let the row wrap onto more lines. `false` (the default) is the shipped behaviour - a single line that overflows rather than wraps.',
    },
    gap: {
      control: { type: 'select' },
      options: GAPS,
      description:
        'Space between children, the same 4px-grid steps as `Stack`\'s `gap` (imported as `InlineGap`/`StackGap` so the two scales cannot drift). `0` (the default) renders `gap-0`, a rendered no-op.',
    },
    align: {
      control: { type: 'select' },
      options: [undefined, ...ALIGNS],
      description:
        'Cross-axis alignment. No default - omitted, the row emits no alignment class and inherits flex\'s own `stretch`.',
    },
    justify: {
      control: { type: 'select' },
      options: [undefined, ...JUSTIFIES],
      description:
        'Main-axis distribution. No default - omitted, the row emits no justify class and inherits flex\'s own `flex-start`.',
    },
    className: { control: false },
  },
} satisfies Meta<typeof Inline>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * No props: `wrap={false}`, `gap={0}` set explicitly - a plain row with no
 * spacing between children, geometrically inert so wrapping existing markup
 * in a bare `<Inline>` cannot move a pixel. Flip the controls to see every
 * other axis live.
 */
export const Default: Story = {
  args: {
    wrap: false,
    gap: 0,
  },
  render: (args) => (
    <Inline {...args}>
      <Swatch label="one" />
      <Swatch label="two" />
      <Swatch label="three" />
    </Inline>
  ),
};

/**
 * `wrap={true}`, matching the filter-chip row shape at EstimatesPage.tsx:539,
 * JobsPage.tsx:442 and CustomersPage.tsx:549 (each `<AppliedChips>` wrapper).
 */
export const Wrap: Story = {
  args: {
    wrap: true,
    gap: 2,
    align: 'center',
  },
  render: (args) => (
    <div className="w-64">
      <Inline {...args}>
        {['one', 'two', 'three', 'four', 'five', 'six'].map((label) => (
          <Swatch key={label} label={label} />
        ))}
      </Inline>
    </div>
  ),
};

/**
 * Every `gap` step on the 4px grid, `0.5` through `12`, each labelled with
 * its rendered class. `0` is covered by Default; this covers the remaining
 * eleven values `argTypes.gap.options` lists.
 */
export const GapScale: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      {GAPS.map((gap) => (
        <div key={gap} className="flex flex-col gap-1">
          <span className="text-xs text-text-secondary">gap={gap}</span>
          <Inline gap={gap}>
            <Swatch label="one" />
            <Swatch label="two" />
            <Swatch label="three" />
          </Inline>
        </div>
      ))}
    </div>
  ),
};

/**
 * Every `align` value, each in a fixed-height row with a short and a tall
 * swatch so the cross-axis position is actually visible - `stretch` fills
 * the row's full height, the other four pick a fixed position on it.
 */
export const Align: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      {ALIGNS.map((align) => (
        <div key={align} className="flex flex-col gap-1">
          <span className="text-xs text-text-secondary">align=&quot;{align}&quot;</span>
          <div className="h-16 rounded border border-dashed border-border bg-surface-light p-1">
            <Inline align={align} gap={2}>
              <ShortSwatch />
              <TallSwatch />
            </Inline>
          </div>
        </div>
      ))}
    </div>
  ),
};

/**
 * Every `justify` value, each in a fixed-width row so the main-axis
 * distribution is actually visible.
 */
export const Justify: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      {JUSTIFIES.map((justify) => (
        <div key={justify} className="flex flex-col gap-1">
          <span className="text-xs text-text-secondary">justify=&quot;{justify}&quot;</span>
          <div className="w-72 rounded border border-dashed border-border bg-surface-light p-1">
            <Inline justify={justify} align="center" gap={1}>
              <Swatch label="one" />
              <Swatch label="two" />
              <Swatch label="three" />
            </Inline>
          </div>
        </div>
      ))}
    </div>
  ),
};

/** `justify="between"`, matching a toolbar shape (title left, actions right). */
export const JustifyBetween: Story = {
  args: {
    align: 'center',
    justify: 'between',
  },
  render: (args) => (
    <div className="w-72">
      <Inline {...args}>
        <Swatch label="title" />
        <Swatch label="actions" />
      </Inline>
    </div>
  ),
};

/**
 * `justify="end"`, matching the job detail action cluster
 * (JobDetailPage.tsx:1044, "Right: action cluster").
 */
export const JustifyEnd: Story = {
  args: {
    align: 'center',
    justify: 'end',
    gap: 2,
    wrap: true,
  },
  render: (args) => (
    <div className="w-72">
      <Inline {...args}>
        <Swatch label="cancel" />
        <Swatch label="save" />
      </Inline>
    </div>
  ),
};
