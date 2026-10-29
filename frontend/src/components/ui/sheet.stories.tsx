/* =============================================================================
   Sheet - Storybook stories, full-coverage pass (Storybook phase, W2 plan).

   Storybook 8 is scaffolded now (.storybook/main.ts, .storybook/preview.ts,
   the @storybook/react-vite devDependency in package.json) - this file
   imports the real `Meta` / `StoryObj` types from `@storybook/react` and
   wires `argTypes` so every axis is a live control in the Storybook UI,
   matching dialog.stories.tsx / badge.stories.tsx.

   Coverage requirement (the completeness pass this phase adds): every
   variant key and value sheet.tsx exposes needs at least one story that
   renders it.

     sheet.tsx ships NO cva() block - `side`, `width`, `pad` and `gap` are
     plain `Record<Key, string>` lookups spliced into SheetContent's
     className at the exact byte position the pre-phase-8 base string held
     them (see sheet.tsx's own comment on SheetContent's ordering rule), not
     routed through cva's variants map. So there is no cva() for a
     completeness parser to walk, but the four axes are real, shipped props
     and are covered fully below:

       side (SheetSide)      top | bottom | left | right   -> SideTop /
         SideBottom / SideLeft / Default (right), one open sheet each.
       width (SheetWidth)    md | lg, left/right sheets only -> Default (md) /
         WidthLg, plus WidthIgnoredOnTopBottom documenting that width renders
         nothing on a top/bottom sheet regardless of value, and
         LegacySizeAlias covering the deprecated `size` prop.
       pad (SheetPadStep)    0 | 6   -> Pad0 / Default (6).
       gap (SheetGapStep)    0 | 4   -> Gap0 / Default (4).

   Named `width`, not `size` - vocabulary rev 3 rule 3 reserves `size` for
   control height, and a max-width scale is a different axis (the same
   rename already applied to Dialog's `DialogWidth` and
   DropdownMenuContent's `DropdownMenuContentWidth` in this session).
   `pad`/`gap` take the numeric 4px-grid step (program plan section 2a.8),
   the same scheme Dialog/Stack/Box/Card already use, not a word scale.

   `side`/`width`/`pad`/`gap` default to `right` / `md` / `6` / `4` -
   sheet.tsx's own pre-phase-8 unstyled geometry, unmoved. `Default` sets
   all four explicitly rather than leaning on omission, the same convention
   badge.stories.tsx / dialog.stories.tsx use.

   WHY EVERY STORY OPENS ITS OWN `<Sheet>`, NOT ONE SHARED INSTANCE.
   SheetContent renders through a Portal at document-body level, fixed and
   edge-anchored (`fixed inset-y-0 right-0 ...`) - two simultaneously open
   sheets paint on top of each other, not side by side, so a Badge-style
   "every value in one flex row" grid story is not a real comparison for
   this primitive (same reasoning dialog.stories.tsx documents for Dialog,
   whose SheetContent-shaped sibling has the identical Portal/fixed
   constraint). Every story below is its own canvas with `defaultOpen`, one
   sheet per canvas - a designer flipping the `side`/`width`/`pad`/`gap`
   controls above the canvas sees the change immediately with nothing to
   click.
   ============================================================================= */
import type { Meta, StoryObj } from '@storybook/react'

import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
  SheetClose,
  type SheetSide,
  type SheetWidth,
  type SheetPadStep,
  type SheetGapStep,
} from './sheet'
import { Button } from './button'
import { Text } from './text'

const SIDES: SheetSide[] = ['top', 'bottom', 'left', 'right']
const WIDTHS: SheetWidth[] = ['md', 'lg']
const PAD_STEPS: SheetPadStep[] = [0, 6]
const GAP_STEPS: SheetGapStep[] = [0, 4]

const meta = {
  title: 'UI/Sheet',
  component: SheetContent,
  tags: ['autodocs'],
  parameters: {
    // Sheet is fixed/edge-anchored over the whole viewport - Storybook's
    // default "padded"/"centered" canvas letterboxes it, so this asks for
    // the full frame instead, matching how it actually renders in the app.
    layout: 'fullscreen',
  },
  args: {
    side: 'right',
    width: 'md',
    pad: 6,
    gap: 4,
  },
  argTypes: {
    side: {
      control: { type: 'select' },
      options: SIDES,
      description:
        'Edge the panel slides in from. Defaults to "right" - today\'s unstyled geometry, unmoved.',
    },
    width: {
      control: { type: 'select' },
      options: WIDTHS,
      description:
        'Max width, "left"/"right" sheets only. Defaults to "md" (sm:max-w-sm), today\'s unstyled default. "lg" is sm:max-w-md, an exact-signature repeat at 8 real call sites (see sheet.tsx\'s own doc comment). Renders nothing on a "top"/"bottom" sheet.',
    },
    pad: {
      control: { type: 'select' },
      options: PAD_STEPS,
      description:
        'Uniform padding, 4px-grid step. Defaults to 6 (p-6), today\'s unstyled default. 0 (p-0) is every real override\'s destination - no measured demand for a smaller-but-nonzero step.',
    },
    gap: {
      control: { type: 'select' },
      options: GAP_STEPS,
      description:
        'Gap between SheetContent\'s direct children, 4px-grid step. Defaults to 4 (gap-4), today\'s unstyled default. 0 (gap-0) is every real override\'s destination, same reasoning as `pad`.',
    },
    className: { control: false },
  },
  render: (args) => (
    <Sheet defaultOpen>
      <SheetTrigger asChild>
        <Button variant="outline">Open sheet</Button>
      </SheetTrigger>
      <SheetContent {...args}>
        <SheetHeader>
          <SheetTitle>Edit customer</SheetTitle>
          <SheetDescription>
            Update the customer&apos;s contact details. Changes save when you close the sheet.
          </SheetDescription>
        </SheetHeader>
        <Text as="p" size="sm" tone="secondary">
          Body content - the middle child the gap applies between.
        </Text>
        <SheetFooter>
          <SheetClose asChild>
            <Button variant="outline">Cancel</Button>
          </SheetClose>
          <Button variant="solid" tone="brand">
            Save
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  ),
} satisfies Meta<typeof SheetContent>

export default meta

type Story = StoryObj<typeof meta>

/**
 * `side="right"`, `width="md"`, `pad={6}`, `gap={4}` - sheet.tsx's own
 * pre-phase-8 unstyled defaults, set explicitly rather than only implied by
 * omission. Flip the controls above the canvas to see any
 * side/width/pad/gap combination live.
 */
export const Default: Story = {
  args: {
    side: 'right',
    width: 'md',
    pad: 6,
    gap: 4,
  },
}

/** `side="top"` - slides down from the top edge, full width, no `width` axis. */
export const SideTop: Story = {
  args: { side: 'top' },
}

/** `side="bottom"` - slides up from the bottom edge, full width, no `width` axis. */
export const SideBottom: Story = {
  args: { side: 'bottom' },
}

/** `side="left"` - slides in from the left edge, `width`-controlled panel. */
export const SideLeft: Story = {
  args: { side: 'left' },
}

/**
 * `width="lg"` - sm:max-w-md, the wider rung (8 real call sites, listed in
 * sheet.tsx's own doc comment on `SheetWidth`).
 */
export const WidthLg: Story = {
  args: { width: 'lg' },
}

/**
 * `width` on a `top`/`bottom` sheet renders nothing - sheet.tsx's own doc
 * comment: those sides carry no width axis today. This story sets
 * `width="lg"` on a `side="top"` sheet to prove it renders identically to
 * the `md` default (compare against `SideTop` above - same panel).
 */
export const WidthIgnoredOnTopBottom: Story = {
  args: { side: 'top', width: 'lg' },
}

/**
 * `size="lg"` - the deprecated pre-rename spelling of `width`, kept live as
 * an alias (sheet.tsx's own doc comment on `SheetContentProps.size`). Same
 * `sm:max-w-md` panel as `WidthLg` above, passed through the old prop name.
 */
export const LegacySizeAlias: Story = {
  args: { width: undefined, size: 'lg' },
}

/**
 * `pad={0}` (p-0) - every real override zeroes padding fully rather than
 * stepping to a smaller-but-nonzero value (sheet.tsx's own doc comment on
 * why `SheetPadStep` only has `0`/`6`).
 */
export const Pad0: Story = {
  args: { pad: 0 },
}

/**
 * `gap={0}` (gap-0) - every real override zeroes the between-children
 * gap fully, same reasoning as `Pad0`.
 */
export const Gap0: Story = {
  args: { gap: 0 },
}

/**
 * `SheetHeader`'s `divider` prop - a hairline separating a fixed header
 * from scrollable body content, the shape a longer-form sheet reaches for.
 * Not part of a `side`/`width`/`pad`/`gap` axis, but a real, shipped prop.
 */
export const WithHeaderDivider: Story = {
  render: () => (
    <Sheet defaultOpen>
      <SheetTrigger asChild>
        <Button variant="outline">Open sheet</Button>
      </SheetTrigger>
      <SheetContent className="max-h-screen overflow-y-auto">
        <SheetHeader divider>
          <SheetTitle>Service plan visits</SheetTitle>
          <SheetDescription>Scroll the body below - the header stays put.</SheetDescription>
        </SheetHeader>
        <Text as="p" size="sm" tone="secondary">
          {'Every visit on this plan, oldest first. '.repeat(30)}
        </Text>
      </SheetContent>
    </Sheet>
  ),
}
