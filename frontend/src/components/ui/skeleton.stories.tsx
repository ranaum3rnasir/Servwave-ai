/* =============================================================================
   Skeleton - Storybook stories, full-coverage pass (Storybook phase, W2 plan).

   Storybook 8 is scaffolded in this worktree (.storybook/main.ts globs every
   .stories.ts(x) file under components/ui, .storybook/preview.ts loads the
   app's own CSS), so this file uses the real `Meta` / `StoryObj` types from
   `@storybook/react` and wires `argTypes` so every axis is a live control,
   matching badge.stories.tsx / avatar.stories.tsx.

   Coverage requirement (the completeness pass this phase adds): every
   variant KEY and every VALUE in skeleton.tsx's cva() block needs at least
   one story that actually renders it.

     shape: block | circle          -> ShapeBlock / ShapeCircle, plus
       AllShapes side by side.

   skeleton.tsx does not carry a `size` prop (see skeleton.tsx's own doc
   comment: VOCAB_V3's six-rung absolute-px ladder is 24-44px and Skeleton's
   108 measured call sites hand-roll heights of 12/16/32/64px, three of the
   four completely outside that range, so no compliant size scale exists for
   this primitive). `Unsized` below renders the real, shipped shape - a bare
   `<Skeleton className="h-4 w-full" />`, exactly how every call site uses it
   today.

   `Default` sets `shape="block"` explicitly (rather than leaning on
   skeleton.tsx's own `defaultVariants`) so the literal value text is present
   in this file even for the default cell, not just implied by omission -
   same convention badge.stories.tsx / avatar.stories.tsx use.
   ============================================================================= */
import type { Meta, StoryObj } from '@storybook/react';

import { Skeleton } from './skeleton';

const SHAPES = ['block', 'circle'] as const;

const meta = {
  title: 'UI/Skeleton',
  component: Skeleton,
  tags: ['autodocs'],
  argTypes: {
    shape: {
      control: { type: 'select' },
      options: SHAPES,
      description:
        'Geometry, not colour or spacing - not part of the variant/tone/size/gap/pad vocabulary (own axis, same as Avatar keeps its own `ring`). `block` is the default.',
    },
    className: { control: false },
  },
} satisfies Meta<typeof Skeleton>;

export default meta;

type Story = StoryObj<typeof meta>;

/** `shape="block"`, skeleton.tsx's own `defaultVariants`, set explicitly. Width/height come from `className`, same as every real call site supplies today. */
export const Default: Story = {
  args: {
    shape: 'block',
    className: 'h-4 w-64',
  },
};

/**
 * The real, shipped default path: height/width fully owned by the caller's
 * own `className` - how all 108 measured call sites render today.
 */
export const Unsized: Story = {
  args: {
    className: 'h-4 w-full max-w-sm',
  },
};

/** `shape="block"` - any rectangular placeholder (a text line, a card body). */
export const ShapeBlock: Story = {
  args: {
    shape: 'block',
    className: 'h-4 w-64',
  },
};

/** `shape="circle"` - an avatar or dot placeholder. */
export const ShapeCircle: Story = {
  args: {
    shape: 'circle',
    className: 'h-10 w-10',
  },
};

/** Both `shape` values side by side, `block` labelled as the default. */
export const AllShapes: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-6">
      <div className="flex flex-col items-center gap-2">
        <Skeleton shape="block" className="h-4 w-32" />
        <span className="text-sm text-text-primary">block (default)</span>
      </div>
      <div className="flex flex-col items-center gap-2">
        <Skeleton shape="circle" className="h-10 w-10" />
        <span className="text-sm text-text-primary">circle</span>
      </div>
    </div>
  ),
};

/**
 * A realistic composition - a text block loading state built from three
 * lines of decreasing width, each sized via `className` exactly like the
 * 33 `h-4` call sites hand-roll today.
 */
export const TextLinesExample: Story = {
  render: () => (
    <div className="flex flex-col gap-2">
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  ),
};

/**
 * A realistic composition - an avatar-shaped placeholder next to two text
 * lines, `shape="circle"` paired with an explicit `h-16 w-16` (64px, the
 * same diameter Avatar's own `lg` renders).
 */
export const AvatarWithTextExample: Story = {
  render: () => (
    <div className="flex items-center gap-3">
      <Skeleton shape="circle" className="h-16 w-16 shrink-0" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-3 w-24" />
      </div>
    </div>
  ),
};
