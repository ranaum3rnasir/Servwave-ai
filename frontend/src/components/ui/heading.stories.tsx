/* =============================================================================
   Heading - Storybook stories, full-coverage pass (Storybook phase, W2 plan).

   Storybook 8 is scaffolded now (.storybook/main.ts, .storybook/preview.ts,
   the @storybook/react-vite devDependency in package.json) - unlike the
   "new primitives" phase's first-pass story this file replaces, it imports
   the real `Meta` / `StoryObj` types from `@storybook/react` and wires
   `argTypes` so every axis is a live control in the Storybook UI.

   Coverage requirement (the completeness pass this phase adds): every
   variant KEY and every VALUE in heading.tsx's cva() block needs at least
   one story that actually renders it.

     scale: 2xl | xl | lg | base | sm | xs -> the Scales story renders all
       six, explicitly, side by side; Default and LevelScaleMismatch each
       also pin an explicit value.
     weight: semibold | bold -> the Weights story renders both.
     tone: neutral | subtle | brand -> the Tones story renders all three.

   `level` is a real, shipped prop (document outline / which `<hN>` element
   renders) but it is NOT part of the cva() block - heading.tsx has no
   `variants.level` entry, `level` only picks the tag and looks up
   `DEFAULT_SCALE`. It is outside what the completeness pass checks, but a
   designer flipping controls needs to see it, so it is wired as a select
   control below and covered by its own Levels story plus the Default and
   LevelScaleMismatch stories.
   ============================================================================= */
import type { Meta, StoryObj } from '@storybook/react';

import { Heading, type HeadingLevel } from './heading';

const LEVELS: HeadingLevel[] = [1, 2, 3, 4, 5, 6];
const SCALES = ['2xl', 'xl', 'lg', 'base', 'sm', 'xs'] as const;
const WEIGHTS = ['semibold', 'bold'] as const;
const TONES = ['neutral', 'subtle', 'brand'] as const;

const meta = {
  title: 'UI/Heading',
  component: Heading,
  tags: ['autodocs'],
  args: {
    children: 'The quick brown fox',
  },
  argTypes: {
    level: {
      control: { type: 'select' },
      options: LEVELS,
      description:
        'Document outline position - which <hN> element renders and what a screen reader announces. Never changes how the heading looks on its own; picks the default `scale` via DEFAULT_SCALE when `scale` is omitted.',
    },
    scale: {
      control: { type: 'select' },
      options: [undefined, ...SCALES],
      description:
        'Visual size, independent of `level`. Omit it to take the level\'s measured default from DEFAULT_SCALE.',
    },
    weight: {
      control: { type: 'select' },
      options: WEIGHTS,
      description: 'Font weight. `semibold` (the default) is the measured mode - 184 of 210 sites.',
    },
    tone: {
      control: { type: 'select' },
      options: TONES,
      description:
        'Semantic colour. `neutral` (the default) is the chrome text role (--text-primary), not the neutral status role.',
    },
    className: { control: false },
  },
} satisfies Meta<typeof Heading>;

export default meta;

type Story = StoryObj<typeof meta>;

/** No props: renders `<h1 class="text-xl font-semibold text-text-primary">`. */
export const Default: Story = {
  args: {
    level: 1,
    scale: 'xl',
    weight: 'semibold',
    tone: 'neutral',
  },
};

/**
 * `level` picks the rendered `<hN>` element (document outline / a11y). Each
 * level falls back to its measured default `scale` when `scale` is omitted -
 * levels 2-6 default to `sm` because that is what most of those sites render
 * today, not a descending display ramp.
 */
export const Levels: Story = {
  render: () => (
    <div className="flex flex-col gap-2">
      {LEVELS.map((level) => (
        <Heading key={level} level={level}>
          Level {level} - {level === 1 ? 'page title' : level === 2 ? 'section heading' : level === 3 ? 'subsection heading' : 'body heading'}
        </Heading>
      ))}
    </div>
  ),
};

/** Every implemented `scale` value, side by side, independent of `level`. */
export const Scales: Story = {
  render: () => (
    <div className="flex flex-col gap-2">
      {SCALES.map((scale) => (
        <Heading key={scale} scale={scale}>
          scale={scale}
        </Heading>
      ))}
    </div>
  ),
};

/** Every implemented `tone` value. `neutral` is the chrome text role, not the neutral status role. */
export const Tones: Story = {
  render: () => (
    <div className="flex flex-col gap-2">
      {TONES.map((tone) => (
        <Heading key={tone} tone={tone}>
          tone={tone}
        </Heading>
      ))}
    </div>
  ),
};

/** Every implemented `weight` value - semibold is the measured mode, bold is the second signature. */
export const Weights: Story = {
  render: () => (
    <div className="flex flex-col gap-2">
      {WEIGHTS.map((weight) => (
        <Heading key={weight} weight={weight}>
          weight={weight}
        </Heading>
      ))}
    </div>
  ),
};

/** The full `scale` x `tone` grid, at `weight="semibold"`, for visual QA. */
export const ScaleToneMatrix: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      {SCALES.map((scale) => (
        <div key={scale} className="flex flex-wrap items-center gap-4">
          <span className="w-12 text-xs text-text-secondary">{scale}</span>
          {TONES.map((tone) => (
            <Heading key={tone} scale={scale} tone={tone}>
              {tone}
            </Heading>
          ))}
        </div>
      ))}
    </div>
  ),
};

/** `level` and `scale` set independently - the outline position and the visual weight can disagree. */
export const LevelScaleMismatch: Story = {
  args: {
    level: 3,
    scale: 'xl',
    children: 'Looks like a page title, sits at heading level 3',
  },
};

/** Real measured signature: `InvoiceDetailPage.tsx:666` / `InvoicesPage.tsx:481`, reproduced byte for byte. */
export const RealSignature: Story = {
  render: () => <Heading level={1}>Invoices</Heading>,
};
