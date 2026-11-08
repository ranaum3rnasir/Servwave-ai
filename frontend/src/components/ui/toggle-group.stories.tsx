/* =============================================================================
   ToggleGroup - Storybook stories, full-coverage pass (Storybook phase, W2 plan).

   Storybook 8 is scaffolded in this worktree (.storybook/main.ts globs every
   .stories.ts(x) file under components/ui, .storybook/preview.ts loads the
   app's own CSS), so this file imports the real `Meta` / `StoryObj` types
   from `@storybook/react` and wires `argTypes` so every real prop is a live
   control - matching badge.stories.tsx / separator.stories.tsx / select.stories.tsx.

   COVERAGE REQUIREMENT (the completeness pass this phase adds): every variant
   KEY and every VALUE in toggle-group.tsx's cva() blocks needs at least one
   story that actually renders it. toggle-group.tsx ships TWO cva() blocks,
   both with the same single key and the same two values:

     toggleGroupVariants (on <ToggleGroup> / Root):
       variant: segmented (default) | pill
     toggleGroupItemVariants (on <ToggleGroupItem>):
       variant: segmented (default) | pill

   `Default` and `Pill` below set BOTH the group's and every item's `variant`
   explicitly to the same value, so a single story covers one value in both
   cva blocks at once. `VariantMatrix` renders both values of both blocks
   again, side by side, for visual QA. Between them every key and every value
   in both blocks is covered - not just the interactive default.

   WHY NO `tone` / `size` / `gap` / `pad`. The program plan's prop-surface
   audit (section 1h) places toggle-group in the "Nothing" column as of the
   pre-phase-8 measurement, and neither demand table (1b/1c) lists it at all -
   ToggleGroup was built ahead of adoption (phase 4b/4c) with zero real call
   sites converted yet. The dedicated triage worksheet
   (md_files/plans/frontend/2026-07-25-toggle-group-triage-worksheet.md) is
   the actual measured-demand source for this primitive: 101 candidate sites
   split {segmented: 55, pill-single: 35, pill-multi: 11}, which is exactly
   the two-value `variant` axis already implemented - no other axis (colour,
   size, spacing) shows up in that worksheet's classification or rationale
   columns. Per the W2 plan's rule ("a primitive with no measured demand is
   left alone"), this file documents the real, already-implemented two-value
   API instead of inventing a third axis.

   WHY THE `component` FIELD IS CAST. `ToggleGroupProps` (toggle-group.tsx's
   own export) is `ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Root>
   & VariantProps<typeof toggleGroupVariants>` - Radix's `Root` type is itself
   a `type`-discriminated union (`{ type: 'single'; value?: string; ... } |
   { type: 'multiple'; value?: string[]; ... }`), so `value`/`onValueChange`
   are typed differently per branch and `Meta`'s `args` cannot drive the full
   union directly. `ToggleGroupStoryProps` below is a small flattened type
   carrying only what this file wires to live Storybook controls (`variant`,
   `type`, `disabled`, `orientation`) - the same flatten-and-cast
   calendar.stories.tsx uses for react-day-picker's own mode-discriminated
   `CalendarProps`. The cast is type-only; every story still renders the
   real, unchanged `ToggleGroup` / `ToggleGroupItem`, fully typed against
   their genuine (single/multiple) prop shapes inside `ToggleGroupDemo`.

   WHY `orientation` GETS A CONTROL BUT NO cva() ENTRY. `orientation` is
   Radix's own prop on `Root` (drives arrow-key navigation direction and the
   `aria-orientation` attribute) - real and shipped, not part of the closed
   vocabulary, same treatment separator.stories.tsx gives its own
   `orientation` prop. toggle-group.tsx's base string is a fixed
   `inline-flex items-center` with no `data-[orientation=vertical]:flex-col`
   counterpart, so flipping the control alone does not visually stack the
   items - exactly like Separator, the primitive owns how one item looks, not
   layout, so the `Vertical` story below supplies the `flex-col` itself as
   call-site layout, not a primitive concern.
   ============================================================================= */
import { useState, type ComponentType } from 'react'
import type { Meta, StoryObj } from '@storybook/react'

import { ToggleGroup, ToggleGroupItem } from './toggle-group'

const VARIANTS = ['segmented', 'pill'] as const
const TYPES = ['single', 'multiple'] as const
const ORIENTATIONS = ['horizontal', 'vertical'] as const

/**
 * Flattened Controls-panel surface - see the header note on why the real
 * `ToggleGroupProps` union cannot drive `Meta`'s `args` directly.
 */
type ToggleGroupStoryProps = {
  variant?: (typeof VARIANTS)[number]
  type?: (typeof TYPES)[number]
  disabled?: boolean
  orientation?: (typeof ORIENTATIONS)[number]
}

/**
 * Drives the real `ToggleGroup` from the flattened Controls args. Holds its
 * own local state for both the single-select and multiple-select branch so
 * switching the `type` control never leaves the group uncontrolled - each
 * branch keeps its own state so toggling back and forth doesn't lose either.
 */
function ToggleGroupDemo({
  variant = 'segmented',
  type = 'single',
  disabled = false,
  orientation = 'horizontal',
}: ToggleGroupStoryProps) {
  const [single, setSingle] = useState('week')
  const [multiple, setMultiple] = useState<string[]>(['week'])

  if (type === 'multiple') {
    return (
      <ToggleGroup
        type="multiple"
        variant={variant}
        disabled={disabled}
        orientation={orientation}
        value={multiple}
        onValueChange={setMultiple}
        aria-label="Report range"
      >
        <ToggleGroupItem value="day" variant={variant}>
          Day
        </ToggleGroupItem>
        <ToggleGroupItem value="week" variant={variant}>
          Week
        </ToggleGroupItem>
        <ToggleGroupItem value="month" variant={variant}>
          Month
        </ToggleGroupItem>
      </ToggleGroup>
    )
  }

  return (
    <ToggleGroup
      type="single"
      variant={variant}
      disabled={disabled}
      orientation={orientation}
      value={single}
      // Single-select segmented/pill controls in every real triage-worksheet
      // site keep exactly one option pressed - guard against Radix's default
      // deselect-on-reclick so the demo never drops to "no selection".
      onValueChange={(value) => {
        if (value) setSingle(value)
      }}
      aria-label="Report range"
    >
      <ToggleGroupItem value="day" variant={variant}>
        Day
      </ToggleGroupItem>
      <ToggleGroupItem value="week" variant={variant}>
        Week
      </ToggleGroupItem>
      <ToggleGroupItem value="month" variant={variant}>
        Month
      </ToggleGroupItem>
    </ToggleGroup>
  )
}

const meta = {
  title: 'UI/ToggleGroup',
  component: ToggleGroup as unknown as ComponentType<ToggleGroupStoryProps>,
  tags: ['autodocs'],
  args: {
    variant: 'segmented',
    type: 'single',
    disabled: false,
    orientation: 'horizontal',
  },
  argTypes: {
    variant: {
      control: { type: 'select' },
      options: VARIANTS,
      description:
        'Structural appearance, shared by `<ToggleGroup>` and every `<ToggleGroupItem>` inside it. `segmented` (the default) is a bordered, padded track with a raised active pill - 55 of 101 triaged candidate sites. `pill` is free-standing rounded chips with no shared track - 46 of 101 (35 single-select + 11 multi-select).',
    },
    type: {
      control: { type: 'select' },
      options: TYPES,
      description:
        'Radix\'s own required prop, not part of the closed vocabulary. `single` allows exactly one pressed item at a time (the "segmented" and "pill-single" triage classifications). `multiple` allows any number pressed independently (the "pill-multi" classification).',
    },
    disabled: {
      control: 'boolean',
      description: 'Radix\'s own prop on `Root` - disables every item in the group at once.',
    },
    orientation: {
      control: { type: 'select' },
      options: ORIENTATIONS,
      description:
        "Radix's own prop on `Root` - picks the arrow-key navigation axis and sets `aria-orientation`. Purely behavioural: toggle-group.tsx's base class has no `data-[orientation=vertical]:flex-col` counterpart, so visually stacking the items is the call site's own layout job (see the `Vertical` story).",
    },
  },
  render: (args) => <ToggleGroupDemo {...args} />,
} satisfies Meta<ComponentType<ToggleGroupStoryProps>>

export default meta

type Story = StoryObj<typeof meta>

/**
 * `variant="segmented"` on both the group and every item (toggle-group.tsx's
 * own `defaultVariants`), `type="single"` - the bordered/padded track with a
 * raised active pill. The evidenced majority shape: 55 of 101 triaged
 * candidate sites (NumbersView.tsx's Local/Toll-free switch,
 * VendorsPage.tsx's all/active/inactive filter, and 53 more).
 */
export const Default: Story = {}

/**
 * `variant="pill"` on both the group and every item, `type="single"` -
 * free-standing rounded chips with no shared bordered track. 35 of 101
 * triaged sites (SmsInboxView.tsx's THREAD_FILTERS row,
 * ScopePresetPicker.tsx's category chips, and 33 more single-select ones).
 */
export const Pill: Story = {
  args: {
    variant: 'pill',
  },
}

/**
 * `type="multiple"` on the `pill` variant - any number of items can be
 * pressed independently. 11 of 101 triaged sites are this shape
 * (CallsView.tsx's facet-filter row, FiltersPopover.tsx's multi-select
 * facets, ApprovalEmailDialog.tsx's recipient suggestion chips).
 */
export const Multiple: Story = {
  args: {
    variant: 'pill',
    type: 'multiple',
  },
}

/**
 * The full `variant` x `type` grid (both cva blocks, both values, both
 * Radix select modes) in one glance for visual QA - covers every key and
 * every value in toggle-group.tsx's two cva() blocks a second time,
 * independent of the Controls-driven stories above.
 */
export const VariantMatrix: Story = {
  render: () => (
    <div className="flex flex-col gap-6">
      {VARIANTS.map((variant) => (
        <div key={variant} className="flex flex-col gap-2">
          <span className="text-xs font-medium text-text-secondary">variant=&quot;{variant}&quot;</span>
          <div className="flex flex-wrap items-center gap-4">
            {TYPES.map((type) => (
              <div key={type} className="flex flex-col items-start gap-1">
                <span className="text-xs text-text-secondary">type=&quot;{type}&quot;</span>
                <ToggleGroupDemo variant={variant} type={type} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  ),
}

/**
 * `disabled` on the group - every item stops responding to pointer and
 * keyboard input at once. Radix's own prop, forwarded straight through.
 */
export const Disabled: Story = {
  args: {
    disabled: true,
  },
}

/**
 * A single `<ToggleGroupItem disabled>` rather than the whole group - the
 * item-level Radix prop (`ToggleGroupItemImplProps` extends `Toggle`'s own
 * `disabled`), independent of the group-level `Disabled` story above.
 */
export const DisabledItem: Story = {
  render: () => (
    <ToggleGroup type="single" variant="segmented" defaultValue="day" aria-label="Report range">
      <ToggleGroupItem value="day" variant="segmented">
        Day
      </ToggleGroupItem>
      <ToggleGroupItem value="week" variant="segmented" disabled>
        Week
      </ToggleGroupItem>
      <ToggleGroupItem value="month" variant="segmented">
        Month
      </ToggleGroupItem>
    </ToggleGroup>
  ),
}

/**
 * `orientation="vertical"` - Radix switches arrow-key navigation to up/down
 * and sets `aria-orientation="vertical"`, but per the header note the
 * primitive itself has no vertical layout class. The call site supplies
 * `flex-col` on top, exactly the layering rule Separator's own stories
 * document for the same reason.
 */
export const Vertical: Story = {
  render: () => (
    <ToggleGroup
      type="single"
      variant="segmented"
      orientation="vertical"
      defaultValue="week"
      className="flex-col"
      aria-label="Report range"
    >
      <ToggleGroupItem value="day" variant="segmented">
        Day
      </ToggleGroupItem>
      <ToggleGroupItem value="week" variant="segmented">
        Week
      </ToggleGroupItem>
      <ToggleGroupItem value="month" variant="segmented">
        Month
      </ToggleGroupItem>
    </ToggleGroup>
  ),
}

/**
 * The triage worksheet's cleanest `segmented`/single-select real-shape
 * match: VendorsPage.tsx's all/active/inactive status filter, sitting inside
 * an explicit bordered track - one of the 55 segmented candidates.
 */
export const StatusFilter: Story = {
  name: 'Real call-site shape - VendorsPage status filter',
  render: () => (
    <ToggleGroup type="single" variant="segmented" defaultValue="all" aria-label="Vendor status">
      <ToggleGroupItem value="all" variant="segmented">
        All
      </ToggleGroupItem>
      <ToggleGroupItem value="active" variant="segmented">
        Active
      </ToggleGroupItem>
      <ToggleGroupItem value="inactive" variant="segmented">
        Inactive
      </ToggleGroupItem>
    </ToggleGroup>
  ),
}

/**
 * The triage worksheet's cleanest `pill`/multi-select real-shape match:
 * RecurrenceBuilder.tsx's weekday chips (S M T W T F S), each toggling
 * independently - one of the 11 pill-multi candidates.
 */
export const WeekdayPicker: Story = {
  name: 'Real call-site shape - RecurrenceBuilder weekday chips',
  render: () => (
    <ToggleGroup
      type="multiple"
      variant="pill"
      defaultValue={['tue', 'thu']}
      aria-label="Repeats on"
    >
      {['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((day) => (
        <ToggleGroupItem key={day} value={day} variant="pill" className="w-9 justify-center">
          {day.charAt(0).toUpperCase()}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  ),
}
