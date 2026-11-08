/* =============================================================================
   Calendar - Storybook story, phase 8g / Storybook completeness pass.

   Storybook 8 is scaffolded in this worktree (.storybook/main.ts globs every
   .stories.ts(x) file under components/ui, .storybook/preview.ts loads the
   app's own CSS), so this file uses the real `Meta` / `StoryObj` types from
   `@storybook/react` - matching button.stories.tsx, not the loose local
   shape the earlier "first pass" new-primitive stories reached for before
   that package existed in this tree (see chip.stories.tsx / alert.stories.tsx
   headers for that history).

   WHY THERE IS NO cva() BLOCK TO COVER, AND WHY THIS FILE DOES NOT ADD ONE.
   The program plan's demand table (section 1b) lists "Calendar" at 14 sites /
   10 files with a strong `size` signal (13), which is what sent phase 8g
   looking for a `size` prop here. That count is contaminated: grepping the
   14 sites shows every one of them importing lucide-react's `Calendar` ICON
   (WalkthroughTab.tsx, LeadDetailPage.tsx, JobDetailPage.tsx,
   InvoiceDetailPage.tsx, the inventory dialogs, the dashboard widgets,
   CommissionsReport.tsx, etc.) - not this DayPicker wrapper, which happens to
   share the name. Re-measuring on the real signal
   (`grep "from '@/components/ui/calendar'"`) finds exactly ONE call site:
   `frontend/src/components/form/DateTimePicker.tsx`, which renders
   `<Calendar mode="single" selected={...} defaultMonth={...} onSelect={...} />`
   with zero className / size / tone overrides. One site, one signature, no
   repeated non-default shape to generalise into a variant - so per the
   closed-vocabulary rule (no prop without cited evidence), calendar.tsx gets
   no `cva()` block and no `variant` / `tone` / `size` / `gap` / `pad` props.
   Documented here as the evidence trail the W2 plan's exit criteria calls
   for ("primitives without demand are documented as deliberately untouched,
   with the evidence").

   WHAT THIS STORY COVERS INSTEAD. Because there is no cva() block, the
   forthcoming Storybook completeness test ("parse every cva block, fail if
   any variant value has no story") has nothing to check against this file -
   it is vacuously complete. What a designer actually needs from this
   primitive is visibility into the real, already-implemented react-day-picker
   props this wrapper forwards: `mode` (single / multiple / range - the three
   values react-day-picker's own `Mode` type allows), `showOutsideDays` (this
   wrapper's one authored default, `true`), and `numberOfMonths`, plus the
   composed states a designer needs to picture (a pre-selected day, a
   disabled-day matcher, the real Popover-hosted integration the one
   production call site uses). Every one of those is covered below.

   WHY THE `component` FIELD IS CAST, NOT PASSED STRAIGHT. `CalendarProps`
   (calendar.tsx's own export, `React.ComponentProps<typeof DayPicker>`) is a
   mode-discriminated union - react-day-picker's `DayPickerProps` is
   `PropsBase & (PropsSingle | PropsMultiRequired | PropsRange | ... | {mode
   ?: undefined})`. `selected` / `onSelect` are typed differently per branch
   (`Date`, `Date[]`, `DateRange`) and are entirely absent from the
   no-mode branch, which collapses `keyof CalendarProps` down to the fields
   every branch shares. `Meta`'s `args` only sees that collapsed surface, so
   passing `selected` through Controls-panel args does not type-check against
   the full union. `CalendarStoryProps` below is a small flattened type
   carrying only the three fields this file wires to real Storybook controls
   (`mode`, `showOutsideDays`, `numberOfMonths`) - the same flatten-and-cast
   button.stories.tsx uses for its own overloaded `Button` type. The cast is
   type-only; the runtime component is calendar.tsx's real, unchanged
   `Calendar`. Every story below that needs `selected` / `onSelect` uses
   `render` and calls the real `Calendar` directly, so those still get full
   type-checking against the genuine react-day-picker prop types.
   ============================================================================= */
import { useState, type ComponentType } from 'react'
import type { Meta, StoryObj } from '@storybook/react'
import { format } from 'date-fns'
import type { DateRange } from 'react-day-picker'

import { Calendar } from './calendar'
import { Popover, PopoverContent, PopoverTrigger } from './popover'
import { Stack } from './stack'
import { Inline } from './inline'
import { Text } from './text'

/**
 * Flattened Controls-panel surface - see the header note on why the real
 * `CalendarProps` union cannot drive `Meta`'s `args` directly.
 */
type CalendarStoryProps = {
  mode?: 'single' | 'multiple' | 'range'
  showOutsideDays?: boolean
  numberOfMonths?: number
  defaultMonth?: Date
}

/** A stable anchor month so every story renders the same grid regardless of the day this is viewed. */
const ANCHOR_MONTH = new Date(2026, 7, 1) // August 2026

const meta = {
  title: 'UI/Calendar',
  component: Calendar as unknown as ComponentType<CalendarStoryProps>,
  tags: ['autodocs'],
  parameters: {
    layout: 'centered',
  },
  args: {
    mode: 'single',
    showOutsideDays: true,
    numberOfMonths: 1,
    defaultMonth: ANCHOR_MONTH,
  },
  argTypes: {
    mode: {
      control: { type: 'select' },
      options: ['single', 'multiple', 'range'],
      description:
        'react-day-picker selection mode. The one real call site (DateTimePicker.tsx) uses "single"; "multiple" and "range" are real, supported values with no call site yet.',
    },
    showOutsideDays: {
      control: 'boolean',
      description:
        "This wrapper's one authored default - renders the leading/trailing days from the adjacent month, dimmed, to fill the grid.",
    },
    numberOfMonths: {
      control: { type: 'number', min: 1, max: 3 },
      description: 'How many months to render side by side. react-day-picker default is 1.',
    },
  },
} satisfies Meta<ComponentType<CalendarStoryProps>>

export default meta

type Story = StoryObj<typeof meta>

/**
 * The interactive default - no `render` override, so the Controls panel
 * drives this story directly: flipping `mode` / `showOutsideDays` /
 * `numberOfMonths` in the Storybook UI re-renders the real `<Calendar>` with
 * those props. No day is selected yet, matching the real call site's initial
 * (empty-value) state.
 */
export const Default: Story = {}

/**
 * `mode="single"` with a day already selected - the steady state
 * DateTimePicker.tsx reaches once a technician picks a date. Hoisted to a
 * module-level component (not defined inline inside `render`) so Storybook
 * re-invoking `render` on a Controls change does not remount it and drop the
 * local selection state.
 */
function SingleSelectedDemo() {
  const [selected, setSelected] = useState<Date | undefined>(new Date(2026, 7, 12))
  return <Calendar mode="single" selected={selected} onSelect={setSelected} defaultMonth={ANCHOR_MONTH} />
}

export const SingleSelected: Story = {
  render: () => <SingleSelectedDemo />,
}

/**
 * `mode="multiple"` - every value `Mode` allows, even without a measured
 * call site yet (per the header note, this is a supported value being made
 * visible, not a speculative prop).
 */
function MultipleSelectedDemo() {
  const [selected, setSelected] = useState<Date[] | undefined>([
    new Date(2026, 7, 3),
    new Date(2026, 7, 10),
    new Date(2026, 7, 24),
  ])
  return <Calendar mode="multiple" selected={selected} onSelect={setSelected} defaultMonth={ANCHOR_MONTH} />
}

export const MultipleSelected: Story = {
  render: () => <MultipleSelectedDemo />,
}

/** `mode="range"` - the third `Mode` value, a start/end span. */
function RangeSelectedDemo() {
  const [range, setRange] = useState<DateRange | undefined>({
    from: new Date(2026, 7, 10),
    to: new Date(2026, 7, 14),
  })
  return <Calendar mode="range" selected={range} onSelect={setRange} defaultMonth={ANCHOR_MONTH} />
}

export const RangeSelected: Story = {
  render: () => <RangeSelectedDemo />,
}

/**
 * `showOutsideDays={false}` next to the wrapper's own default (`true`), the
 * one prop this component authors on top of a bare `DayPicker` render.
 */
export const OutsideDays: Story = {
  render: () => (
    <Inline gap={6} align="start">
      <Stack gap={2} align="center">
        <Calendar mode="single" showOutsideDays defaultMonth={ANCHOR_MONTH} />
        <Text size="xs" tone="secondary">
          showOutsideDays (default)
        </Text>
      </Stack>
      <Stack gap={2} align="center">
        <Calendar mode="single" showOutsideDays={false} defaultMonth={ANCHOR_MONTH} />
        <Text size="xs" tone="secondary">
          showOutsideDays: false
        </Text>
      </Stack>
    </Inline>
  ),
}

/** `numberOfMonths={2}` - two months rendered side by side. */
export const MultipleMonths: Story = {
  render: () => <Calendar mode="single" numberOfMonths={2} defaultMonth={ANCHOR_MONTH} />,
}

/**
 * `disabled` - a real react-day-picker `Matcher`, here a `{ dayOfWeek }`
 * matcher disabling every Saturday and Sunday. Not a control (a `Matcher` is
 * a function-or-object union with no sane Storybook control type), so this
 * is a dedicated story rather than an argType.
 */
export const DisabledDates: Story = {
  render: () => <Calendar mode="single" disabled={{ dayOfWeek: [0, 6] }} defaultMonth={ANCHOR_MONTH} />,
}

/**
 * The real production shape: `Calendar` inside a `Popover`, exactly how the
 * one live call site (`DateTimePicker.tsx`) hosts it - a button trigger
 * showing the current value, the calendar itself in the popover content.
 */
function PopoverIntegrationDemo() {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<Date | undefined>(undefined)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex w-56 items-center rounded-lg border border-border px-3 py-2 text-left text-sm text-text-secondary outline-none focus:ring-2 focus:ring-primary/40"
        >
          {selected ? format(selected, 'MMM d, yyyy') : 'Set date...'}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" width="sm" pad={2}>
        <Calendar
          mode="single"
          selected={selected}
          defaultMonth={ANCHOR_MONTH}
          onSelect={(day) => {
            setSelected(day)
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

export const PopoverIntegration: Story = {
  render: () => <PopoverIntegrationDemo />,
}
