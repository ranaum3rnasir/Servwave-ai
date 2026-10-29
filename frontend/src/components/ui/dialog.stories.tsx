/* =============================================================================
   Dialog - Storybook stories, full-coverage pass (Storybook phase, W2 plan).

   Storybook 8 is scaffolded now (.storybook/main.ts, .storybook/preview.ts,
   the @storybook/react-vite devDependency in package.json) - this file
   imports the real `Meta` / `StoryObj` types from `@storybook/react` and
   wires `argTypes` so every axis is a live control in the Storybook UI,
   matching badge.stories.tsx / checkbox.stories.tsx.

   Coverage requirement (the completeness pass this phase adds): every
   variant key and value dialog.tsx exposes needs at least one story that
   renders it.

     dialog.tsx ships NO cva() block - `width`, `pad` and `gap` are plain
     `Record<Key, string>` lookups spliced into DialogContent's className at
     the exact byte position the pre-phase-8 base string held them (see
     dialog.tsx's own comment on DialogContent's ordering rule), not routed
     through cva's variants map. So there is no cva() for a completeness
     parser to walk, but the three axes are real, shipped props and are
     covered fully below, plus the two remaining real props (`overlayClassName`,
     `DialogHeader`'s `divider`) that are not part of a variant axis at all:

       width (DialogWidth)     xs | sm | md | lg               -> WidthXs /
         WidthSm / Default (md) / WidthLg, one open dialog each.
       pad (DialogSpacingStep) 0 | 0.5 | 1 | 1.5 | 2 | 2.5 | 3 | 4 | 5 | 6 | 8 | 12
         -> PadValues, one trigger per value (12/12).
       gap (DialogSpacingStep) same 12 steps                    -> GapValues,
         one trigger per value (12/12).

   Named `width`, not `size` - program plan section 2a rule 3 reserves
   `size` for control height on every primitive that has it; a max-width
   scale is a different axis and does not get to reuse that word.

   `width`/`pad`/`gap` default to `md` / 6 / 4 - dialog.tsx's own pre-phase-8
   unstyled geometry, unmoved. `Default` sets all three explicitly rather
   than leaning on omission, the same convention badge.stories.tsx /
   alert.stories.tsx use.

   WHY EVERY STORY OPENS ITS OWN `<Dialog>`, NOT ONE SHARED INSTANCE.
   DialogContent renders through a Portal at document-body level, fixed and
   centred (`fixed left-[50%] top-[50%] ... -translate`) - two simultaneously
   `defaultOpen` dialogs paint on top of each other, not side by side, so a
   Badge/Alert-style "every value in one flex row" grid story is not a real
   comparison for this primitive. `Default` and the four `width` stories use
   `defaultOpen` (one dialog per canvas, nothing to click - a designer
   flipping the `width`/`pad`/`gap`/`overlayClassName` controls above the
   canvas sees the change immediately). `PadValues`/`GapValues` instead
   render one trigger button per value, so all twelve are visible and
   reachable in a single canvas without stacking twelve open overlays -
   click a button, its own dialog opens.
   ============================================================================= */
import type { Meta, StoryObj } from '@storybook/react'

import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogClose,
  type DialogWidth,
  type DialogSpacingStep,
} from './dialog'
import { Button } from './button'
import { Inline } from './inline'
import { Text } from './text'

const WIDTHS: DialogWidth[] = ['xs', 'sm', 'md', 'lg']
const SPACING_STEPS: DialogSpacingStep[] = [0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 12]

const meta = {
  title: 'UI/Dialog',
  component: DialogContent,
  tags: ['autodocs'],
  parameters: {
    // Dialog is fixed/centred over the whole viewport - Storybook's default
    // "padded"/"centered" canvas letterboxes it, so this asks for the full
    // frame instead, matching how it actually renders in the app.
    layout: 'fullscreen',
  },
  args: {
    width: 'md',
    pad: 6,
    gap: 4,
  },
  argTypes: {
    width: {
      control: { type: 'select' },
      options: WIDTHS,
      description:
        'Max width. Defaults to "md" (max-w-lg) - today\'s unstyled geometry, unmoved. xs=max-w-sm (15 sites), sm=max-w-md (21), lg=max-w-2xl (6).',
    },
    pad: {
      control: { type: 'select' },
      options: SPACING_STEPS,
      description: 'Uniform padding, 4px-grid step. Defaults to 6 (24px) - today\'s unstyled p-6.',
    },
    gap: {
      control: { type: 'select' },
      options: SPACING_STEPS,
      description:
        'Gap between DialogContent\'s direct children, 4px-grid step. Defaults to 4 (16px) - today\'s unstyled gap-4.',
    },
    overlayClassName: {
      control: { type: 'text' },
      description:
        'Override the overlay scrim class - e.g. a lighter overlay for a dialog stacked on top of another one.',
    },
    className: { control: false },
  },
  render: (args) => (
    <Dialog defaultOpen>
      <DialogTrigger asChild>
        <Button variant="outline">Open dialog</Button>
      </DialogTrigger>
      <DialogContent {...args}>
        <DialogHeader>
          <DialogTitle>Delete customer?</DialogTitle>
          <DialogDescription>
            This removes the customer record and every linked estimate, job and invoice. This
            action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button variant="solid" tone="danger">
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
} satisfies Meta<typeof DialogContent>

export default meta

type Story = StoryObj<typeof meta>

/**
 * `width="md"` (max-w-lg), `pad={6}`, `gap={4}` - dialog.tsx's own
 * pre-phase-8 unstyled defaults, set explicitly rather than only implied by
 * omission. Flip the controls above the canvas to see any
 * width/pad/gap/overlayClassName combination live.
 */
export const Default: Story = {
  args: {
    width: 'md',
    pad: 6,
    gap: 4,
  },
}

/** `width="xs"` - max-w-sm, the narrowest rung (15 real call sites). */
export const WidthXs: Story = {
  args: { width: 'xs' },
}

/** `width="sm"` - max-w-md (21 real call sites, the single most common explicit width). */
export const WidthSm: Story = {
  args: { width: 'sm' },
}

/** `width="lg"` - max-w-2xl, the widest rung (6 real call sites). */
export const WidthLg: Story = {
  args: { width: 'lg' },
}

/**
 * Every `pad` step, 0 through 12 (12/12 values) - one trigger per value so
 * all twelve are reachable in a single canvas without stacking overlapping
 * overlays. Each dialog's own title names the value it was opened with.
 */
export const PadValues: Story = {
  render: () => (
    <Inline gap={2} wrap align="center">
      {SPACING_STEPS.map((step) => (
        <Dialog key={`pad-${step}`}>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm">{`pad={${step}}`}</Button>
          </DialogTrigger>
          <DialogContent pad={step}>
            <DialogHeader>
              <DialogTitle>{`pad={${step}}`}</DialogTitle>
              <DialogDescription>{`${step * 4}px of uniform padding on every side.`}</DialogDescription>
            </DialogHeader>
          </DialogContent>
        </Dialog>
      ))}
    </Inline>
  ),
}

/**
 * Every `gap` step, 0 through 12 (12/12 values), same shape as `PadValues`.
 * Each dialog has a header, a body paragraph and a footer so the gap between
 * those three direct children is visible.
 */
export const GapValues: Story = {
  render: () => (
    <Inline gap={2} wrap align="center">
      {SPACING_STEPS.map((step) => (
        <Dialog key={`gap-${step}`}>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm">{`gap={${step}}`}</Button>
          </DialogTrigger>
          <DialogContent gap={step}>
            <DialogHeader>
              <DialogTitle>{`gap={${step}}`}</DialogTitle>
              <DialogDescription>{`${step * 4}px between each direct child.`}</DialogDescription>
            </DialogHeader>
            <Text as="p" size="sm" tone="secondary">
              Body content - the middle child the gap applies between.
            </Text>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">Close</Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ))}
    </Inline>
  ),
}

/**
 * `DialogHeader`'s `divider` prop - a hairline separating a fixed header
 * from scrollable body content, the shape a longer-form dialog reaches for.
 * Not part of a `width`/`pad`/`gap` axis, but a real, shipped prop.
 *
 * A real call site pairing this with a capped dialog height would add
 * something like `max-h-[80vh]` alongside `overflow-y-auto` - an arbitrary
 * bracket value, since no token in tokens.css names a viewport-relative
 * height. This session may not introduce a new arbitrary bracket value (same
 * rule tooltip.stories.tsx's `LongContentMaxWidth` story follows for
 * InternalCostsCard.tsx's `max-w-[260px]`), so only the non-arbitrary
 * `overflow-y-auto` utility is reproduced here; the height cap is described
 * rather than literally applied.
 */
export const WithHeaderDivider: Story = {
  render: () => (
    <Dialog defaultOpen>
      <DialogTrigger asChild>
        <Button variant="outline">Open dialog</Button>
      </DialogTrigger>
      <DialogContent className="overflow-y-auto">
        <DialogHeader divider>
          <DialogTitle>Service plan visits</DialogTitle>
          <DialogDescription>Scroll the body below - the header stays put.</DialogDescription>
        </DialogHeader>
        <Text as="p" size="sm" tone="secondary">
          {'Every visit on this plan, oldest first. '.repeat(30)}
        </Text>
      </DialogContent>
    </Dialog>
  ),
}

/**
 * `overlayClassName` - a lighter scrim, the shape a dialog stacked on top of
 * another dialog reaches for so the first dialog stays legible behind it.
 * `bg-scrim/40` is the same `scrim` token DialogOverlay's own default
 * (`bg-scrim/80`) already uses, at a lower opacity - not a new colour.
 */
export const LighterOverlay: Story = {
  render: () => (
    <Dialog defaultOpen>
      <DialogTrigger asChild>
        <Button variant="outline">Open dialog</Button>
      </DialogTrigger>
      <DialogContent overlayClassName="bg-scrim/40">
        <DialogHeader>
          <DialogTitle>Stacked dialog</DialogTitle>
          <DialogDescription>
            overlayClassName=&quot;bg-scrim/40&quot; - a lighter scrim than the default bg-scrim/80.
          </DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  ),
}
