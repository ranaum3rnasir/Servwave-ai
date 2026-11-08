/* =============================================================================
   Box - Storybook stories, full coverage pass.

   Storybook is scaffolded in this worktree now (.storybook/main.ts,
   .storybook/preview.ts, the @storybook/react-vite devDependency in
   package.json) - unlike the "new primitives" phase's first pass (see this
   file's own git history), this version imports the real `Meta` / `StoryObj`
   types from `@storybook/react` and wires `argTypes` so every pad axis is a
   live control in the Storybook UI.

   WHY THERE IS NO `cva()` BLOCK TO PARSE HERE.
   box.tsx's own header explains this at length: Box's whole surface is the
   seven-prop padding API `design-system/spacing.ts` already owns (`pad` /
   `padX` / `padY` / `padTop` / `padRight` / `padBottom` / `padLeft`), with a
   precedence rule - side beats axis beats uniform - that a cva `variants`
   map cannot express, because each cva key resolves independently and would
   happily emit `p-6 px-3` together. `padClasses()` exists to keep that
   deterministic instead of reinventing the bug card.tsx already hit and
   fixed once. card.stories.tsx documents the identical situation for Card's
   own hand-rolled predecessor of the same fix.

   So this file's completeness target is the real prop surface box.tsx
   exports and branches on through `padClasses()`, not a cva object: every
   one of the thirteen `PadStep` values (design-system/spacing.ts's
   `PAD_STEPS`, imported below so the Controls dropdown can never drift from
   what Box actually renders) gets its own rendered Box for each of the seven
   pad props - `pad`, `padX`, `padY`, `padTop`, `padRight`, `padBottom`,
   `padLeft` - not just the inert default.

   Every demo Box below carries a `className` of its own (a dashed border
   plus the neutral-surface token background) purely so the padding is
   visible in the Storybook canvas. Box itself never adds that paint - see
   `Default` below, and box.test.tsx's own "the bare default is inert" suite
   - a demo className is exactly the kind of call-site styling a real
   consumer supplies, same as card.stories.tsx's `ComposedExample` passing
   `className="max-w-sm"` to a Card.
   ============================================================================= */
import type { Meta, StoryObj } from '@storybook/react'

import { Box } from './box'
import { PAD_STEPS, type PadStep } from '@/design-system/spacing'

/** Shared demo paint - a dashed frame so a Box's own padding is visible. */
const DEMO_FRAME = 'inline-block rounded border border-dashed border-border bg-neutral-surface'

const meta = {
  title: 'UI/Box',
  component: Box,
  tags: ['autodocs'],
  argTypes: {
    pad: {
      control: { type: 'select' },
      options: [...PAD_STEPS],
      description: 'Uniform padding on all four sides, as a 4px-grid step. `pad={6}` is 24px.',
    },
    padX: {
      control: { type: 'select' },
      options: [...PAD_STEPS],
      description: 'Horizontal padding. Overrides `pad` on the left and right sides.',
    },
    padY: {
      control: { type: 'select' },
      options: [...PAD_STEPS],
      description: 'Vertical padding. Overrides `pad` on the top and bottom sides.',
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
    className: { control: false },
  },
} satisfies Meta<typeof Box>

export default meta

type Story = StoryObj<typeof meta>

/**
 * `<Box>` with no props - renders exactly `<div class="">`. Args-driven so
 * the Controls panel below can flip every pad prop live; the frame is on the
 * `children` wrapper here, never on the Box itself, so this story stays true
 * to "wrapping existing markup in a bare Box cannot move a pixel."
 */
export const Default: Story = {
  args: {
    children: 'Box content',
  },
}

/**
 * Every step on the `pad` scale - the uniform-padding case. `pad={6}` (24px)
 * is a common call-site value; every other legal step renders here too.
 */
export const PaddingSteps: Story = {
  render: () => (
    <div className="flex flex-wrap gap-4">
      {PAD_STEPS.map((step) => (
        <Box key={step} pad={step} className={DEMO_FRAME}>
          <span className="text-sm text-text-primary">pad={'{' + step + '}'}</span>
        </Box>
      ))}
    </div>
  ),
}

/**
 * Every step on the `padX` scale, overriding the horizontal sides only. A
 * fixed `pad={2}` baseline stays on the vertical sides throughout, so the
 * override is visible rather than the Box just looking uniformly padded -
 * the same technique card.stories.tsx's `HorizontalPaddingOverride` uses.
 */
export const HorizontalPaddingOverride: Story = {
  render: () => (
    <div className="flex flex-wrap gap-4">
      {PAD_STEPS.map((step) => (
        <Box key={step} pad={2} padX={step} className={DEMO_FRAME}>
          <span className="text-sm text-text-primary">padX={'{' + step + '}'}</span>
        </Box>
      ))}
    </div>
  ),
}

/**
 * Every step on the `padY` scale, overriding the vertical sides only. A
 * fixed `pad={2}` baseline stays on the horizontal sides throughout,
 * mirroring `HorizontalPaddingOverride`.
 */
export const VerticalPaddingOverride: Story = {
  render: () => (
    <div className="flex flex-wrap gap-4">
      {PAD_STEPS.map((step) => (
        <Box key={step} pad={2} padY={step} className={DEMO_FRAME}>
          <span className="text-sm text-text-primary">padY={'{' + step + '}'}</span>
        </Box>
      ))}
    </div>
  ),
}

/**
 * Every step on the `padTop` scale - a single side overridden, the other
 * three falling back to a fixed `pad={4}` baseline so the top-only change is
 * visible against the rest.
 */
export const TopPaddingOverride: Story = {
  render: () => (
    <div className="flex flex-wrap gap-4">
      {PAD_STEPS.map((step) => (
        <Box key={step} pad={4} padTop={step} className={DEMO_FRAME}>
          <span className="text-sm text-text-primary">padTop={'{' + step + '}'}</span>
        </Box>
      ))}
    </div>
  ),
}

/** Every step on the `padRight` scale, the other three sides fixed at `pad={4}`. */
export const RightPaddingOverride: Story = {
  render: () => (
    <div className="flex flex-wrap gap-4">
      {PAD_STEPS.map((step) => (
        <Box key={step} pad={4} padRight={step} className={DEMO_FRAME}>
          <span className="text-sm text-text-primary">padRight={'{' + step + '}'}</span>
        </Box>
      ))}
    </div>
  ),
}

/** Every step on the `padBottom` scale, the other three sides fixed at `pad={4}`. */
export const BottomPaddingOverride: Story = {
  render: () => (
    <div className="flex flex-wrap gap-4">
      {PAD_STEPS.map((step) => (
        <Box key={step} pad={4} padBottom={step} className={DEMO_FRAME}>
          <span className="text-sm text-text-primary">padBottom={'{' + step + '}'}</span>
        </Box>
      ))}
    </div>
  ),
}

/** Every step on the `padLeft` scale, the other three sides fixed at `pad={4}`. */
export const LeftPaddingOverride: Story = {
  render: () => (
    <div className="flex flex-wrap gap-4">
      {PAD_STEPS.map((step) => (
        <Box key={step} pad={4} padLeft={step} className={DEMO_FRAME}>
          <span className="text-sm text-text-primary">padLeft={'{' + step + '}'}</span>
        </Box>
      ))}
    </div>
  ),
}

/**
 * All four sides named individually and differently at once - the shape
 * box.test.tsx's "all four sides named individually" case pins
 * (`pt-1 pr-2 pb-3 pl-4`). No `pad` / `padX` / `padY` baseline at all: every
 * side resolves from its own prop alone.
 */
export const AllFourSidesIndividually: Story = {
  render: () => (
    <Box padTop={1} padRight={2} padBottom={3} padLeft={4} className={DEMO_FRAME}>
      <span className="text-sm text-text-primary">
        padTop={'{1}'} padRight={'{2}'} padBottom={'{3}'} padLeft={'{4}'}
      </span>
    </Box>
  ),
}

/**
 * `pad` sets a baseline, `padTop` overrides one side only, the rest fall
 * back to `pad` - box.test.tsx's precedence case (`pt-2 pr-4 pb-4 pl-4`).
 */
export const PerSideOverrideFallback: Story = {
  args: {
    pad: 4,
    padTop: 2,
    children: 'pad={4} padTop={2}',
  },
  render: (args) => (
    <Box {...args} className={DEMO_FRAME}>
      <span className="text-sm text-text-primary">{args.children}</span>
    </Box>
  ),
}

/**
 * `padX` / `padY` set together with no uniform `pad` - box.test.tsx's
 * "names only the axis given" case (`px-4 py-2.5`).
 */
export const AxisPadOnly: Story = {
  args: {
    padX: 4,
    padY: 2.5 as PadStep,
    children: 'padX={4} padY={2.5}',
  },
  render: (args) => (
    <Box {...args} className={DEMO_FRAME}>
      <span className="text-sm text-text-primary">{args.children}</span>
    </Box>
  ),
}

/**
 * A call-site `className` wins over Box's own pad class - box.test.tsx's
 * hygiene case. `pad={2}` would render `p-2`, but the `p-8` supplied through
 * `className` is what tailwind-merge keeps.
 */
export const ClassNameOverride: Story = {
  render: () => (
    <Box pad={2} className="rounded border border-dashed border-border bg-neutral-surface p-8">
      <span className="text-sm text-text-primary">pad={'{2}'} + className=&quot;p-8&quot; -&gt; p-8 wins</span>
    </Box>
  ),
}

/** A realistic composed example - padding a summary block without a raw `p-*` class. */
export const ComposedExample: Story = {
  render: () => (
    <Box pad={4} className="max-w-sm rounded border border-border bg-neutral-surface">
      <p className="text-sm font-medium text-text-primary">Estimate approved</p>
      <p className="mt-1 text-sm text-text-secondary">
        The customer approved E00042. A deposit request has been sent.
      </p>
    </Box>
  ),
}
