/* =============================================================================
   Popover - Storybook stories, full-coverage pass (Storybook phase, W2 plan).

   Storybook 8 is scaffolded (.storybook/main.ts, .storybook/preview.ts, the
   @storybook/react-vite devDependency in package.json) - this file imports
   the real `Meta` / `StoryObj` types from `@storybook/react` and wires
   `argTypes` so `width` and `pad` are live controls in the Storybook UI,
   matching dialog.stories.tsx / badge.stories.tsx.

   Coverage requirement (the completeness pass this phase adds): every
   variant KEY and every VALUE in popover.tsx's cva() block needs at least
   one story that actually renders it.

     width (PopoverWidth) sm | md | lg   -> WidthSm / Default (md) / WidthLg,
       one open popover each, plus a WidthValues story with all three side by
       side.
     pad (PopoverPad)   0 | 1 | 2 | 4  -> Pad0 / Pad1 / Pad2 /
       Default (4), one open popover each, plus a PadValues story with all
       four side by side.

   popover.tsx's own header note explains why `variant`, `tone` and `gap` are
   NOT on this primitive (zero measured demand across the 25 real call
   sites) and why width's `xs` / pad's values above `4` are reserved-but-not-
   implemented - there is nothing left uncovered by the two axes above.

   Named `width`, not `size` - program plan section 2a rule 3: `size` always
   means control height (the absolute px ladder every sized primitive can
   share) and never means anything else. On this primitive the geometry axis
   is max-width, since PopoverContent has no separate control height to
   scale, so it is `width`. `pad` takes the numeric 4px-grid step (program
   plan section 2a.8), the same scheme Dialog/Stack/Box/Card already use, not
   a word scale.

   `width`/`pad` default to `"md"`/`4`, which popover.tsx documents as
   emitting NO class on either axis - the base string already carries
   `w-72 p-4`, the pre-W2 hardcoded geometry, unmoved. `Default` sets both
   explicitly rather than leaning on omission, the same convention
   badge.stories.tsx uses.

   WHY EVERY STORY OPENS ITS OWN `<Popover>`, NOT ONE SHARED INSTANCE.
   PopoverContent renders through a Portal, positioned against its own
   trigger by Radix's floating layer - two simultaneously-open popovers
   anchored to two different triggers do not stack on top of each other the
   way two centred Dialogs would, but each story below still gets its own
   Popover/Trigger pair, for the same reason dialog.stories.tsx does: a
   designer flipping the width/pad controls above the canvas must see
   exactly one popover, not one left open by a previous render. `Default`
   and the per-value width/pad stories use `defaultOpen`, one popover per
   canvas. `WidthValues`/`PadValues` instead render one trigger button per
   value so every value is reachable in a single canvas without forcing all
   of them open at once.

   `Pad0` renders a menu list with its own row padding rather than the
   Default story's paragraph pair - that is the real 12-site signature the
   header note on popover.tsx describes for `pad={0}` (a custom list
   managing its own inner spacing), not a shape invented for this file.
   ============================================================================= */
import type { Meta, StoryObj } from '@storybook/react'

import { Popover, PopoverTrigger, PopoverContent, type PopoverWidth, type PopoverPad } from './popover'
import { Button } from './button'
import { Inline } from './inline'
import { Text } from './text'

const WIDTHS: PopoverWidth[] = ['sm', 'md', 'lg']
const PADS: PopoverPad[] = [0, 1, 2, 4]

const WIDTH_DESCRIPTIONS: Record<PopoverWidth, string> = {
  sm: 'w-64, 256px wide.',
  md: 'w-72, 288px wide - the default.',
  lg: 'w-80, 320px wide.',
}

const PAD_DESCRIPTIONS: Record<PopoverPad, string> = {
  0: '0px padding (p-0) - a custom list manages its own row spacing.',
  1: '4px padding (p-1).',
  2: '8px padding (p-2).',
  4: '16px padding (p-4) - the default.',
}

const meta = {
  title: 'UI/Popover',
  component: PopoverContent,
  tags: ['autodocs'],
  args: {
    width: 'md',
    pad: 4,
  },
  argTypes: {
    width: {
      control: { type: 'select' },
      options: WIDTHS,
      description:
        'Max-width. Defaults to "md" (w-72 / 288px, today\'s hardcoded default, unmoved). sm=w-64/256px (5 real call sites), lg=w-80/320px (3 sites). xs is reserved by the vocabulary but not implemented - no repeated signature below sm in the real call sites.',
    },
    pad: {
      control: { type: 'select' },
      options: PADS,
      description:
        'Uniform padding, 4px-grid step. Defaults to 4 (p-4 / 16px, today\'s hardcoded default, unmoved). 0=p-0/0px (12 sites, the dominant signature - custom lists/menus with their own inner row spacing), 1=p-1/4px (4 sites), 2=p-2/8px (5 sites, absorbing 2 p-3 sites rounded down). Steps above 4 are reserved by the vocabulary but not implemented - no demand above p-4 in the real call sites.',
    },
    className: { control: false },
  },
  render: (args) => (
    <Popover defaultOpen>
      <PopoverTrigger asChild>
        <Button variant="outline">Open popover</Button>
      </PopoverTrigger>
      <PopoverContent {...args}>
        <Text as="p" size="sm" weight="medium" tone="primary">
          Filter by status
        </Text>
        <Text as="p" size="xs" tone="secondary">
          Choose one or more statuses to narrow the list below.
        </Text>
      </PopoverContent>
    </Popover>
  ),
} satisfies Meta<typeof PopoverContent>

export default meta

type Story = StoryObj<typeof meta>

/**
 * `width="md"` (w-72/288px), `pad={4}` (p-4/16px) - popover.tsx's own
 * pre-W2 hardcoded geometry, set explicitly rather than only implied by
 * omission. Flip the controls above the canvas to see any width/pad
 * combination live.
 */
export const Default: Story = {
  args: {
    width: 'md',
    pad: 4,
  },
}

/** `width="sm"` - w-64/256px, the narrower rung (5 real call sites). */
export const WidthSm: Story = {
  args: { width: 'sm' },
}

/** `width="lg"` - w-80/320px, the wider rung (3 real call sites). */
export const WidthLg: Story = {
  args: { width: 'lg' },
}

/**
 * Every `width` value, 3/3, one trigger per value so all three are reachable
 * in a single canvas without forcing them all open at once.
 */
export const WidthValues: Story = {
  render: () => (
    <Inline gap={4} wrap align="center">
      {WIDTHS.map((width) => (
        <Popover key={`width-${width}`}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm">{`width="${width}"`}</Button>
          </PopoverTrigger>
          <PopoverContent width={width}>
            <Text as="p" size="sm" weight="medium" tone="primary">
              {`width="${width}"`}
            </Text>
            <Text as="p" size="xs" tone="secondary">
              {WIDTH_DESCRIPTIONS[width]}
            </Text>
          </PopoverContent>
        </Popover>
      ))}
    </Inline>
  ),
}

/**
 * `pad={0}` - p-0/0px, the dominant real-world signature (12 sites): a
 * custom list or menu that manages its own inner spacing per row rather
 * than relying on PopoverContent's own padding.
 */
export const Pad0: Story = {
  args: { pad: 0 },
  render: (args) => (
    <Popover defaultOpen>
      <PopoverTrigger asChild>
        <Button variant="outline">Open popover</Button>
      </PopoverTrigger>
      <PopoverContent {...args}>
        <ul className="flex flex-col">
          {['New', 'In progress', 'Completed', 'Cancelled'].map((label) => (
            <li key={label} className="px-3 py-2 text-sm text-text-primary hover:bg-background-light">
              {label}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  ),
}

/** `pad={1}` - p-1/4px, a tight single-field picker. */
export const Pad1: Story = {
  args: { pad: 1 },
}

/** `pad={2}` - p-2/8px, a compact single-field picker. */
export const Pad2: Story = {
  args: { pad: 2 },
}

/**
 * Every `pad` value, 4/4, one trigger per value so all four are reachable
 * in a single canvas without forcing them all open at once. `0` gets the
 * same real-world menu-list shape `Pad0` above uses; the other three
 * share the paragraph-pair shape `Default` uses.
 */
export const PadValues: Story = {
  render: () => (
    <Inline gap={4} wrap align="center">
      {PADS.map((pad) => (
        <Popover key={`pad-${pad}`}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm">{`pad={${pad}}`}</Button>
          </PopoverTrigger>
          <PopoverContent pad={pad}>
            {pad === 0 ? (
              <ul className="flex flex-col">
                {['New', 'In progress', 'Completed'].map((label) => (
                  <li key={label} className="px-3 py-2 text-sm text-text-primary hover:bg-background-light">
                    {label}
                  </li>
                ))}
              </ul>
            ) : (
              <>
                <Text as="p" size="sm" weight="medium" tone="primary">
                  {`pad={${pad}}`}
                </Text>
                <Text as="p" size="xs" tone="secondary">
                  {PAD_DESCRIPTIONS[pad]}
                </Text>
              </>
            )}
          </PopoverContent>
        </Popover>
      ))}
    </Inline>
  ),
}
