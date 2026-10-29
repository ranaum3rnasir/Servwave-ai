/* =============================================================================
   Card - Storybook stories, full coverage pass.

   Storybook is already scaffolded in this worktree (`.storybook/`,
   `@storybook/react-vite` in package.json) - unlike the "new primitives"
   phase stories (Box, Alert, Chip, ...) which predate that scaffold and had
   to fall back to loose local `Meta`/`StoryObj`-shaped interfaces so 30-odd
   parallel agents would not race the same package.json. This file imports
   the real types directly.

   WHY THERE IS NO `cva()` BLOCK TO PARSE HERE.
   Card's padding axis (`pad`/`padX`/`padY`) predates `design-system/spacing.ts`
   and hand-rolled the same fix Box now gets for free (see box.tsx's header):
   a cva `variants` map resolves each key independently, so it would happily
   emit `p-6 px-3` together, and tailwind-merge 3.6 does not treat a later
   `px-*` as overriding an earlier `p-*`. `padClasses()` in card.tsx exists
   to keep that outcome deterministic instead. So this story file's
   completeness target is the real prop surface card.tsx exports and
   branches on, not a cva object:
     - `tone` (CARD_TONE / `StatusIntent`) - 6 values: success, warning,
       danger, info, neutral, brand.
     - `flat` - boolean, toggles `shadow-none` on top of any tone.
     - `pad` - the 12-step 4px-grid scale (`PAD_STEPS`, imported below so the
       Controls dropdown can never drift from what card.tsx actually renders):
       0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 12.
     - `padX` / `padY` - the same 12 steps, each overriding `pad` on one axis.
     - `padding` (deprecated) - the four-word legacy alias: none, sm, md, lg.
   Every value in every one of those five props gets its own rendered Card
   below, not just the default.
   ============================================================================= */
import type { Meta, StoryObj } from '@storybook/react'

import { Card, PAD_STEPS } from './card'

const meta: Meta<typeof Card> = {
  title: 'UI/Card',
  component: Card,
  tags: ['autodocs'],
  argTypes: {
    tone: {
      control: { type: 'select' },
      options: ['success', 'warning', 'danger', 'info', 'neutral', 'brand'],
    },
    flat: {
      control: { type: 'boolean' },
    },
    pad: {
      control: { type: 'select' },
      options: [...PAD_STEPS],
    },
    padX: {
      control: { type: 'select' },
      options: [...PAD_STEPS],
    },
    padY: {
      control: { type: 'select' },
      options: [...PAD_STEPS],
    },
    padding: {
      control: { type: 'select' },
      options: ['none', 'sm', 'md', 'lg'],
      description: 'Deprecated. Use `pad` - none=0, sm=4, md=6, lg=8. Same pixels.',
    },
  },
}

export default meta

type Story = StoryObj<typeof Card>

/**
 * `<Card>` with no props - the 42-site implicit signature: `rounded-card
 * border border-border bg-surface-light text-text-primary shadow-card`,
 * `pad` defaulted to step 6 (24px). Args-driven so the Controls panel below
 * can flip every prop live.
 */
export const Default: Story = {
  args: {
    children: 'Card content',
  },
}

/**
 * Every implemented `tone` value. Only the surface (background + border)
 * changes - unlike Badge's `intent`, the card's own text keeps its normal
 * colour, which is why every example below reuses the same neutral text
 * class regardless of tone.
 */
export const Tones: Story = {
  render: () => (
    <div className="flex flex-wrap gap-4">
      <Card tone="success">
        <p className="text-sm text-text-primary">tone=&quot;success&quot;</p>
      </Card>
      <Card tone="warning">
        <p className="text-sm text-text-primary">tone=&quot;warning&quot;</p>
      </Card>
      <Card tone="danger">
        <p className="text-sm text-text-primary">tone=&quot;danger&quot;</p>
      </Card>
      <Card tone="info">
        <p className="text-sm text-text-primary">tone=&quot;info&quot;</p>
      </Card>
      <Card tone="neutral">
        <p className="text-sm text-text-primary">tone=&quot;neutral&quot;</p>
      </Card>
      <Card tone="brand">
        <p className="text-sm text-text-primary">tone=&quot;brand&quot;</p>
      </Card>
    </div>
  ),
}

/**
 * `flat` - both boolean values. `flat={false}` (the default) keeps
 * `shadow-card`; `flat={true}` drops it to `shadow-none` for a card nested
 * inside another card or panel that already carries its own elevation.
 */
export const Flat: Story = {
  render: () => (
    <div className="flex flex-wrap gap-4">
      <Card flat={false}>
        <p className="text-sm text-text-primary">flat={'{false}'} (default, shadow-card)</p>
      </Card>
      <Card flat={true}>
        <p className="text-sm text-text-primary">flat={'{true}'} (shadow-none)</p>
      </Card>
    </div>
  ),
}

/**
 * Every step on the `pad` scale - the uniform-padding case. `pad={6}` is the
 * default (identical bytes to a propless Card).
 */
export const PaddingSteps: Story = {
  render: () => (
    <div className="flex flex-wrap gap-4">
      <Card pad={0}>
        <p className="text-sm text-text-primary">pad={'{0}'}</p>
      </Card>
      <Card pad={0.5}>
        <p className="text-sm text-text-primary">pad={'{0.5}'}</p>
      </Card>
      <Card pad={1}>
        <p className="text-sm text-text-primary">pad={'{1}'}</p>
      </Card>
      <Card pad={1.5}>
        <p className="text-sm text-text-primary">pad={'{1.5}'}</p>
      </Card>
      <Card pad={2}>
        <p className="text-sm text-text-primary">pad={'{2}'}</p>
      </Card>
      <Card pad={2.5}>
        <p className="text-sm text-text-primary">pad={'{2.5}'}</p>
      </Card>
      <Card pad={3}>
        <p className="text-sm text-text-primary">pad={'{3}'}</p>
      </Card>
      <Card pad={4}>
        <p className="text-sm text-text-primary">pad={'{4}'}</p>
      </Card>
      <Card pad={5}>
        <p className="text-sm text-text-primary">pad={'{5}'}</p>
      </Card>
      <Card pad={6}>
        <p className="text-sm text-text-primary">pad={'{6}'} (default)</p>
      </Card>
      <Card pad={8}>
        <p className="text-sm text-text-primary">pad={'{8}'}</p>
      </Card>
      <Card pad={12}>
        <p className="text-sm text-text-primary">pad={'{12}'}</p>
      </Card>
    </div>
  ),
}

/**
 * Every step on the `padX` scale, overriding the horizontal side only. A
 * fixed `pad={2}` baseline stays on the vertical side throughout, so the
 * override is visible rather than the card just looking uniformly padded.
 */
export const HorizontalPaddingOverride: Story = {
  render: () => (
    <div className="flex flex-wrap gap-4">
      <Card pad={2} padX={0}>
        <p className="text-sm text-text-primary">padX={'{0}'}</p>
      </Card>
      <Card pad={2} padX={0.5}>
        <p className="text-sm text-text-primary">padX={'{0.5}'}</p>
      </Card>
      <Card pad={2} padX={1}>
        <p className="text-sm text-text-primary">padX={'{1}'}</p>
      </Card>
      <Card pad={2} padX={1.5}>
        <p className="text-sm text-text-primary">padX={'{1.5}'}</p>
      </Card>
      <Card pad={2} padX={2}>
        <p className="text-sm text-text-primary">padX={'{2}'}</p>
      </Card>
      <Card pad={2} padX={2.5}>
        <p className="text-sm text-text-primary">padX={'{2.5}'}</p>
      </Card>
      <Card pad={2} padX={3}>
        <p className="text-sm text-text-primary">padX={'{3}'}</p>
      </Card>
      <Card pad={2} padX={4}>
        <p className="text-sm text-text-primary">padX={'{4}'}</p>
      </Card>
      <Card pad={2} padX={5}>
        <p className="text-sm text-text-primary">padX={'{5}'}</p>
      </Card>
      <Card pad={2} padX={6}>
        <p className="text-sm text-text-primary">padX={'{6}'}</p>
      </Card>
      <Card pad={2} padX={8}>
        <p className="text-sm text-text-primary">padX={'{8}'}</p>
      </Card>
      <Card pad={2} padX={12}>
        <p className="text-sm text-text-primary">padX={'{12}'}</p>
      </Card>
    </div>
  ),
}

/**
 * Every step on the `padY` scale, overriding the vertical side only. A fixed
 * `pad={2}` baseline stays on the horizontal side throughout, mirroring
 * `HorizontalPaddingOverride`.
 */
export const VerticalPaddingOverride: Story = {
  render: () => (
    <div className="flex flex-wrap gap-4">
      <Card pad={2} padY={0}>
        <p className="text-sm text-text-primary">padY={'{0}'}</p>
      </Card>
      <Card pad={2} padY={0.5}>
        <p className="text-sm text-text-primary">padY={'{0.5}'}</p>
      </Card>
      <Card pad={2} padY={1}>
        <p className="text-sm text-text-primary">padY={'{1}'}</p>
      </Card>
      <Card pad={2} padY={1.5}>
        <p className="text-sm text-text-primary">padY={'{1.5}'}</p>
      </Card>
      <Card pad={2} padY={2}>
        <p className="text-sm text-text-primary">padY={'{2}'}</p>
      </Card>
      <Card pad={2} padY={2.5}>
        <p className="text-sm text-text-primary">padY={'{2.5}'}</p>
      </Card>
      <Card pad={2} padY={3}>
        <p className="text-sm text-text-primary">padY={'{3}'}</p>
      </Card>
      <Card pad={2} padY={4}>
        <p className="text-sm text-text-primary">padY={'{4}'}</p>
      </Card>
      <Card pad={2} padY={5}>
        <p className="text-sm text-text-primary">padY={'{5}'}</p>
      </Card>
      <Card pad={2} padY={6}>
        <p className="text-sm text-text-primary">padY={'{6}'}</p>
      </Card>
      <Card pad={2} padY={8}>
        <p className="text-sm text-text-primary">padY={'{8}'}</p>
      </Card>
      <Card pad={2} padY={12}>
        <p className="text-sm text-text-primary">padY={'{12}'}</p>
      </Card>
    </div>
  ),
}

/**
 * The deprecated `padding` word scale - kept only so the 55 pre-existing
 * explicit call sites (`none` x9, `sm` x39, `lg` x7, `md` implicit elsewhere)
 * do not have to move this session. Each renders the identical pixels its
 * `pad` step equivalent does above.
 */
export const LegacyPadding: Story = {
  render: () => (
    <div className="flex flex-wrap gap-4">
      <Card padding="none">
        <p className="text-sm text-text-primary">padding=&quot;none&quot; (pad=0)</p>
      </Card>
      <Card padding="sm">
        <p className="text-sm text-text-primary">padding=&quot;sm&quot; (pad=4)</p>
      </Card>
      <Card padding="md">
        <p className="text-sm text-text-primary">padding=&quot;md&quot; (pad=6, default)</p>
      </Card>
      <Card padding="lg">
        <p className="text-sm text-text-primary">padding=&quot;lg&quot; (pad=8)</p>
      </Card>
    </div>
  ),
}

/** A realistic composed card - a summary panel, tone and pad working together. */
export const ComposedExample: Story = {
  render: () => (
    <Card tone="success" pad={4} className="max-w-sm">
      <p className="text-sm font-medium text-text-primary">Estimate approved</p>
      <p className="mt-1 text-sm text-text-secondary">
        The customer approved E00042. A deposit request has been sent.
      </p>
    </Card>
  ),
}
