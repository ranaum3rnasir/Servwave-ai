/* =============================================================================
   Button - Storybook stories.

   Storybook 8 is scaffolded in this worktree (.storybook/main.ts globs every
   .stories.ts(x) file under components/ui, .storybook/preview.ts loads the
   app's own CSS), so this file uses the real `Meta` / `StoryObj` types from
   `@storybook/react` rather than the loose local shape earlier "first pass"
   stories reached for before that package existed in this tree (see
   chip.stories.tsx / alert.stories.tsx headers for that history).

   PHASE 12C. Until phase 12c, `Button` was typed as three overloaded call
   signatures (button.tsx's now-deleted `ButtonComponent`) so a call site
   writing one of nine pre-7a deprecated variant names got a real
   `reportsDeprecated` diagnostic. `Meta<typeof Button>` cannot resolve a
   props type from an overloaded call-signature interface - `Meta<T>`'s own
   definition only special-cases `T extends ComponentType<any>` - so this file
   used to cast `Button` through a hand-mirrored `ButtonStoryProps` type to get
   around it. Phase 12c deleted the alias overloads once every real call site
   was converted, so `Button` is an ordinary `forwardRef` component again and
   `Meta<typeof Button>` resolves its props directly - no mirrored type, no
   cast.

   COMPLETENESS. Every key the file's `buttonCell = cva(...)` block accepts
   renders in at least one story below, not just the interactive default:

     cell (13 keys, BUTTON_CELL_CLASSES) - solid/brand, solid/business,
       solid/ai, solid/danger, solid/neutral, outline/neutral, outline/danger,
       ghost/neutral, ghost/subtle, ghost/danger, ghost/danger#reveal,
       link/brand, onDark
     size (6 keys) - default, md, 3xs, sm, lg, icon

   `Solid` / `Outline` / `Ghost` / `Link` cover every cell except `onDark`
   (its own story - it needs a dark host surface, not just a prop) and
   `ghost/danger#reveal` (its own story - `revealOnHover` is a modifier the
   plain `Ghost` grid does not set). `Sizes` covers all six size keys.
   ============================================================================= */
import type { Meta, StoryObj } from '@storybook/react'

import { Button, type ButtonTone, type ButtonSize } from './button'
import { Inline } from './inline'
import { Stack } from './stack'
import { Surface } from './surface'
import { Text } from './text'

const TONES: ButtonTone[] = ['brand', 'neutral', 'subtle', 'danger', 'ai', 'business']
const SIZES: ButtonSize[] = ['default', 'md', '3xs', 'sm', 'lg', 'icon']

const meta = {
  title: 'UI/Button',
  component: Button,
  tags: ['autodocs'],
  parameters: {
    layout: 'centered',
  },
  args: {
    children: 'Button',
  },
  argTypes: {
    variant: {
      control: { type: 'select' },
      options: ['solid', 'outline', 'ghost', 'link', 'onDark'],
      description:
        'Structure axis - the shape of the control. `onDark` is a context (a dark host surface), not a colour - see the OnDark story.',
    },
    tone: {
      control: { type: 'select' },
      options: TONES,
      description: 'Colour axis, independent of structure. No effect when variant is "onDark".',
    },
    revealOnHover: {
      control: 'boolean',
      description:
        'ghost only: idle reads as tone="subtle", the real tone appears on hover. Only ghost + danger has a minted reveal cell today; any other pair drops the prop and warns in dev instead of silently doing nothing.',
    },
    size: {
      control: { type: 'select' },
      options: SIZES,
      description:
        '"default" and "md" are the same 40px rung - "md" is the W1 vocabulary name, "default" is the cva key every propless call site resolves through.',
    },
    asChild: {
      control: 'boolean',
      description: 'Render the Radix Slot and merge Button\'s classes onto the single child instead of a <button>.',
    },
    disabled: {
      control: 'boolean',
    },
    children: {
      control: 'text',
    },
    className: {
      table: { disable: true },
    },
  },
} satisfies Meta<typeof Button>

export default meta

type Story = StoryObj<typeof meta>

/**
 * The interactive default - no `render` override, so the controls panel
 * drives this story directly: flipping `variant` / `tone` / `revealOnHover` /
 * `size` in the Storybook UI re-renders the real `<Button>` with those props.
 * No props set resolves to `solid/brand` at `size="default"` - `buttonCell`'s
 * own `defaultVariants`, and today's shipped geometry.
 */
export const Default: Story = {}

/** Every minted `solid/*` cell - a filled control, five tones. */
export const Solid: Story = {
  render: () => (
    <Inline gap={3} wrap align="center">
      <Button variant="solid" tone="brand">
        Brand
      </Button>
      <Button variant="solid" tone="business">
        Business
      </Button>
      <Button variant="solid" tone="ai">
        AI
      </Button>
      <Button variant="solid" tone="danger">
        Danger
      </Button>
      <Button variant="solid" tone="neutral">
        Neutral
      </Button>
    </Inline>
  ),
}

/** Both minted `outline/*` cells - a bordered control. */
export const Outline: Story = {
  render: () => (
    <Inline gap={3} wrap align="center">
      <Button variant="outline" tone="neutral">
        Neutral
      </Button>
      <Button variant="outline" tone="danger">
        Danger
      </Button>
    </Inline>
  ),
}

/** All three plain `ghost/*` cells - no fill, no border. */
export const Ghost: Story = {
  render: () => (
    <Inline gap={3} wrap align="center">
      <Button variant="ghost" tone="neutral">
        Neutral
      </Button>
      <Button variant="ghost" tone="subtle">
        Subtle
      </Button>
      <Button variant="ghost" tone="danger">
        Danger
      </Button>
    </Inline>
  ),
}

/**
 * `ghost/danger#reveal` - the `revealOnHover` modifier. Idle reads as
 * `subtle`; hover the button in the Storybook canvas and it turns danger red,
 * the exact shape purchase orders use for a row-level delete/cancel action.
 */
export const GhostRevealOnHover: Story = {
  args: {
    variant: 'ghost',
    tone: 'danger',
    revealOnHover: true,
    children: 'Delete',
  },
}

/** `link/brand` - text that behaves like a control. */
export const Link: Story = {
  args: {
    variant: 'link',
    children: 'View details',
  },
}

/**
 * `onDark` - not a tone, a context: "this button sits on a dark surface".
 * Hosted on `<Surface tone="dark">`, the primitive built to be that ambient
 * backdrop (see surface.tsx), matching the copilot panels and SchedulePage
 * call sites that use this variant today.
 */
export const OnDark: Story = {
  parameters: { layout: 'padded' },
  render: () => (
    <Surface tone="dark" pad={6}>
      <Button variant="onDark">On dark</Button>
    </Surface>
  ),
}

/** Every `size` rung, smallest to largest. */
export const Sizes: Story = {
  render: () => (
    <Stack gap={3} align="start">
      <Inline gap={3} align="center">
        <Button size="3xs">3xs</Button>
        <Text size="xs" tone="secondary">
          24px - the compact rung (5 call sites spell this out via className today)
        </Text>
      </Inline>
      <Inline gap={3} align="center">
        <Button size="sm">sm</Button>
        <Text size="xs" tone="secondary">
          36px
        </Text>
      </Inline>
      <Inline gap={3} align="center">
        <Button size="default">default</Button>
        <Text size="xs" tone="secondary">
          40px - the shipped geometry, and the cva defaultVariants value
        </Text>
      </Inline>
      <Inline gap={3} align="center">
        <Button size="md">md</Button>
        <Text size="xs" tone="secondary">
          40px - same rung as &quot;default&quot;, the W1 vocabulary&apos;s name for it
        </Text>
      </Inline>
      <Inline gap={3} align="center">
        <Button size="lg">lg</Button>
        <Text size="xs" tone="secondary">
          44px
        </Text>
      </Inline>
      <Inline gap={3} align="center">
        <Button size="icon" aria-label="Icon-only action">
          <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" />
          </svg>
        </Button>
        <Text size="xs" tone="secondary">
          40px square, no text - needs an aria-label since it has no accessible name otherwise
        </Text>
      </Inline>
    </Stack>
  ),
}

/** `asChild`, wrapping a bare anchor - the Slot polymorphism path. */
export const AsChild: Story = {
  render: () => (
    <Button asChild variant="outline" tone="neutral">
      <a href="#storybook-aschild-demo">Renders as a real anchor</a>
    </Button>
  ),
}

/** The native `disabled` attribute, forwarded straight through to the `<button>`. */
export const Disabled: Story = {
  args: {
    disabled: true,
    children: 'Disabled',
  },
}
