/* =============================================================================
   Select - Storybook stories, full-coverage pass (Storybook phase, W2 plan).

   Storybook 8 is scaffolded (.storybook/main.ts, .storybook/preview.ts) - this
   file imports the real `Meta` / `StoryObj` types from `@storybook/react` and
   wires `argTypes` so every real prop is a live control in the Storybook UI,
   matching input.stories.tsx / badge.stories.tsx / dialog.stories.tsx (the
   other Radix-primitive-wrapping stories in this pass).

   COMPLETENESS REQUIREMENT (the test this phase adds): every variant KEY and
   every VALUE in select.tsx's cva() block needs at least one story that
   actually renders it.

     select.tsx ships exactly one cva() block, `selectTriggerVariants`, with
     one key, `size`, and four values (see select.tsx's own header comment
     for the full call-site evidence behind each rung):

       size: md (default - empty string, today's h-10/40px geometry, ~29 of
                  46 call sites render through it and it MUST NOT MOVE)
             xs (h-8/32px + forced text-xs - TaskDetailDrawer.tsx,
                  LineItemRow.tsx dense branch)
             sm (h-9/36px, height only - TaskFilterBar.tsx, TrainingView.tsx,
                  TotalsFooter.tsx, LineItemRow.tsx non-dense branch)
             lg (h-11/44px, height only - StopIfForm.tsx, WaitForm.tsx,
                  DateModePanel.tsx)

     `Default` renders the propless/`md` baseline explicitly. `ExtraSmall`,
     `Small` and `Large` each render one non-default value on its own. `Sizes`
     renders all four side by side for visual QA. Between them, every key and
     every value in the cva() block is covered - not just the interactive
     default.

   `tone` and `invalid` are real, shipped `SelectTrigger` props but are NOT
   part of the cva() block - select.tsx applies both as plain conditional
   classes via `cn()` after `selectTriggerVariants()` runs (see select.tsx's
   own render function), so neither is in scope for the completeness
   requirement above. They are still wired as live controls below (Tone,
   Invalid) because a designer flipping this primitive's knobs needs to see
   them, matching how input.stories.tsx keeps its own `tone`/`invalid` live
   for the exact same reason (SelectTrigger's `tone`/`invalid` contract is
   copied verbatim from Input's, per select.tsx's own doc comment).

   No `variant` / `gap` / `pad` axis exists on Select - the program plan's
   measured-demand walk (46 call sites across 30 files - see select.tsx's own
   header comment) found no evidence for any of the three, so none is
   invented here.

   `tone="business"` is the closed-vocabulary rename of `tone="sage"` (W2/8's
   rename schedule, program plan section 2a.11: "`sage` -> `business`" - see
   select.tsx's own doc comment on `SelectTriggerTone`, copied verbatim from
   Input's). `sage` stays as a deprecated alias for the identical class
   string, covered by DeprecatedToneSage below.

   WHY THE CONTROLS RENDER A CLOSED SELECT.
   `size`/`tone`/`invalid` all live on `SelectTrigger`, which paints whether
   the popover is open or closed - a designer flipping those controls needs
   to see the trigger button itself, not the (portalled, centred-elsewhere)
   dropdown content. Every args-driven story below spreads `args` onto
   `SelectTrigger` inside a real `<Select>`/`<SelectContent>` tree so the
   dropdown still opens and behaves like the genuine component if clicked,
   but the control changes are visible without opening it - the same
   trade-off dialog.stories.tsx documents for why its own stories default to
   `defaultOpen` instead (Select has no such prop; its trigger is visible by
   construction).

   `WithGroups` covers the remaining sub-components (`SelectGroup`,
   `SelectLabel`, `SelectSeparator`) that are not variant axes at all but are
   real, shipped exports with a real call site (VendorCategoryPicker.tsx) -
   included for completeness of the primitive's
   surface, not because the cva() parser requires it.
   ============================================================================= */
import type { Meta, StoryObj } from '@storybook/react'

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from './select'
import { Inline } from './inline'
import { Stack } from './stack'
import { Text } from './text'

const SIZES = ['md', 'xs', 'sm', 'lg'] as const
const TONES = ['default', 'sage', 'business'] as const

const meta = {
  title: 'UI/Select',
  component: SelectTrigger,
  tags: ['autodocs'],
  parameters: {
    layout: 'centered',
  },
  args: {
    size: 'md',
    tone: 'default',
    invalid: false,
  },
  argTypes: {
    size: {
      control: { type: 'select' },
      options: SIZES,
      description:
        '`md` is the default and today\'s shipped 40px (h-10) geometry - it MUST NOT MOVE, ~29 of 46 call sites render through it. `xs` (32px, forces text-xs), `sm` (36px, height only) and `lg` (44px, height only) are additive rungs measured from real className overrides at call sites - see select.tsx\'s header comment for the full count.',
    },
    tone: {
      control: { type: 'select' },
      options: TONES,
      description:
        '`default` is the ordinary bordered trigger. `business` is the closed-vocabulary deposit-box tint ReceiptCard\'s sibling controls use (same contract as Input\'s own `tone="business"`) - a plain conditional class, not a cva() key. `sage` is a deprecated alias for the exact same class string.',
    },
    invalid: {
      control: 'boolean',
      description:
        'Whether the current value failed validation - renders the danger border. Same contract as Input\'s `invalid`.',
    },
    disabled: {
      control: 'boolean',
      description: 'The native Radix Trigger prop, forwarded straight through.',
    },
    className: { table: { disable: true } },
  },
  render: (args) => (
    <Select>
      <SelectTrigger {...args} className="w-48">
        <SelectValue placeholder="Select a service type" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="hvac">HVAC</SelectItem>
        <SelectItem value="plumbing">Plumbing</SelectItem>
        <SelectItem value="electrical">Electrical</SelectItem>
      </SelectContent>
    </Select>
  ),
} satisfies Meta<typeof SelectTrigger>

export default meta

type Story = StoryObj<typeof meta>

/**
 * The interactive default - no story-level `args` override, so the Controls
 * panel drives this story directly through the meta-level `render`. No props
 * set resolves to `size="md"`, `tone="default"`, `invalid={false}` -
 * selectTriggerVariants' own `defaultVariants` value, and today's shipped
 * geometry (~29 of 46 call sites render through this).
 */
export const Default: Story = {}

/** `size="xs"` explicitly - the 32px rung, forces `text-xs`. */
export const ExtraSmall: Story = {
  args: {
    size: 'xs',
  },
}

/** `size="sm"` explicitly - the 36px rung, height only. */
export const Small: Story = {
  args: {
    size: 'sm',
  },
}

/** `size="lg"` explicitly - the 44px rung, height only. */
export const Large: Story = {
  args: {
    size: 'lg',
  },
}

/**
 * Every `size` rung, largest to smallest, side by side - covers every value
 * in select.tsx's cva() block in one glance for visual QA.
 */
export const Sizes: Story = {
  render: () => (
    <Stack gap={3} align="start">
      <Inline gap={3} align="center">
        <Select>
          <SelectTrigger size="lg" className="w-48">
            <SelectValue placeholder="lg" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="hvac">HVAC</SelectItem>
            <SelectItem value="plumbing">Plumbing</SelectItem>
          </SelectContent>
        </Select>
        <Text size="xs" tone="secondary">
          44px (h-11) - StopIfForm/WaitForm/DateModePanel rung, height only
        </Text>
      </Inline>
      <Inline gap={3} align="center">
        <Select>
          <SelectTrigger size="md" className="w-48">
            <SelectValue placeholder="md" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="hvac">HVAC</SelectItem>
            <SelectItem value="plumbing">Plumbing</SelectItem>
          </SelectContent>
        </Select>
        <Text size="xs" tone="secondary">
          40px (h-10) - the default and shipped geometry, ~29 of 46 call sites render through it
        </Text>
      </Inline>
      <Inline gap={3} align="center">
        <Select>
          <SelectTrigger size="sm" className="w-48">
            <SelectValue placeholder="sm" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="hvac">HVAC</SelectItem>
            <SelectItem value="plumbing">Plumbing</SelectItem>
          </SelectContent>
        </Select>
        <Text size="xs" tone="secondary">
          36px (h-9) - TaskFilterBar/TrainingView/TotalsFooter rung, height only
        </Text>
      </Inline>
      <Inline gap={3} align="center">
        <Select>
          <SelectTrigger size="xs" className="w-48">
            <SelectValue placeholder="xs" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="hvac">HVAC</SelectItem>
            <SelectItem value="plumbing">Plumbing</SelectItem>
          </SelectContent>
        </Select>
        <Text size="xs" tone="secondary">
          32px (h-8) - TaskDetailDrawer/LineItemRow (dense) rung, forces text-xs
        </Text>
      </Inline>
    </Stack>
  ),
}

/** `tone="business"` - the deposit-box tint (ReceiptCard's sibling controls use the same tone), the closed-vocabulary name. */
export const Business: Story = {
  args: {
    tone: 'business',
  },
}

/**
 * The deprecated `tone="sage"` alias - byte-identical to `tone="business"`
 * above. The literal shape the one real SelectTrigger call site still on
 * disk uses (components/jobs/items/ReceiptCard.tsx:610).
 */
export const DeprecatedToneSage: Story = {
  args: {
    tone: 'sage',
  },
}

/** `invalid` - the danger border a failed-validation call site renders. */
export const Invalid: Story = {
  args: {
    invalid: true,
  },
}

/** The native `disabled` attribute, forwarded straight through to the Radix Trigger. */
export const Disabled: Story = {
  args: {
    disabled: true,
  },
}

/**
 * The real grouped-option shape (`SelectGroup` + `SelectLabel` + `SelectItem`,
 * with a `SelectSeparator` between groups) - a department-grouped list, and
 * VendorCategoryPicker.tsx's separator
 * before its "+ Add new" sentinel row. Not a variant axis, but real, shipped
 * sub-components worth a designer seeing.
 */
export const WithGroups: Story = {
  render: () => (
    <Select>
      <SelectTrigger className="w-56">
        <SelectValue placeholder="Assign a technician" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>HVAC team</SelectLabel>
          <SelectItem value="alex">Alex Rivera</SelectItem>
          <SelectItem value="sam">Sam Okafor</SelectItem>
        </SelectGroup>
        <SelectSeparator />
        <SelectGroup>
          <SelectLabel>Plumbing team</SelectLabel>
          <SelectItem value="jordan">Jordan Lee</SelectItem>
          <SelectItem value="casey">Casey Nguyen</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  ),
}
