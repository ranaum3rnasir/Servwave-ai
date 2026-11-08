/* =============================================================================
   Tooltip - Storybook stories, full-coverage pass (Storybook phase, W2 plan).

   Storybook 8 is scaffolded (.storybook/main.ts, .storybook/preview.ts, the
   @storybook/react-vite devDependency in package.json) - this file imports
   the real `Meta` / `StoryObj` types from `@storybook/react` and wires
   `argTypes` so every real prop is a live control in the Storybook UI,
   matching popover.stories.tsx and separator.stories.tsx.

   Coverage requirement (the completeness pass this phase adds): every
   variant KEY and every VALUE in tooltip.tsx's cva() block needs at least
   one story that renders it.

     tooltip.tsx ships NO cva() block - `class-variance-authority` is not
     imported anywhere in the file. It is a bare Radix wrapper: `Tooltip`,
     `TooltipTrigger` and `TooltipProvider` are re-exports of Radix's own
     Root/Trigger/Provider with zero changes, and `TooltipContent` forwards
     every prop straight through `{...props}` with one hardcoded default
     (`sideOffset = 4`) and no `variant`/`tone`/`size`/`gap`/`pad` axis at all.

     This is not an oversight this pass is meant to close. The program plan's
     phase 8 demand table (section "Complete the primitive APIs", steps
     8a-8g) lists `size` work for Input/Textarea/Select/Label/Dialog/Sheet/
     Popover/DropdownMenuContent/Tabs/Avatar/Skeleton/Calendar/Separator/
     Checkbox/Switch/Badge - Tooltip appears in none of those rows. Section
     1h's prop-surface audit puts Tooltip in the "Nothing" column alongside
     Badge/Breadcrumb/Calendar/etc, and sections 1b/1c's measured-demand
     tables (call sites passing >=1 class, and signatures with >=3
     occurrences) have no Tooltip/TooltipContent row at all. The only things
     real call sites reach for are Radix's own already-shipped positioning
     prop (`side`) and one-off `className` width overrides - never a colour,
     a size rung, or a spacing step. Per the W2 plan's rule ("a primitive
     with no measured demand is left alone. Do not add a prop because it
     would be nice - cite the evidence for every prop you add"), tooltip.tsx
     is untouched by this session.

     Because there is no cva() call, the upcoming tree-wide completeness
     pass (which parses cva blocks and fails on any uncovered variant value)
     has zero keys to require in this file - vacuously satisfied, not
     skipped. Matches dropdown-menu.stories.tsx / collapse.stories.tsx /
     checkbox.stories.tsx's own documented reasoning for the same situation,
     and separator.stories.tsx's precedent for wiring a primitive's real,
     non-cva Radix props into live controls instead of inventing a
     vocabulary axis nobody asked for.

   WHAT IS COVERED INSTEAD - every real, shipped prop a designer can
   actually flip, each transcribed from an existing call site rather than
   invented:

     side (Radix's own Popper prop, forwarded via ...props on
     TooltipContent) - top | right | bottom | left:
       "bottom"  SendEstimateDialog.tsx:212, the send-button tooltip.
       "right"   Sidebar.tsx:119,376,410 - three sites, the icon rail.
       "top"     data-table.tsx:146, the truncated-cell tooltip, explicit.
       (default) PublishControl.tsx:90,120 and WorkflowsHome.tsx:314 pass no
                 side at all, taking Radix's own "top" default.
       "left" has zero call sites in this tree today; it is included to
       complete the axis (a real fourth value Radix already ships), the
       same treatment separator.stories.tsx gives orientation="vertical"
       once a `<Header>` site existed for it, generalised here to the one
       Popper axis this component actually forwards.

     sideOffset (a number, tooltip.tsx's own one hardcoded default) - the
       component's destructuring (`{ className, sideOffset = 4, ...props }`)
       is the single real default this file authors itself. No call site
       overrides it (every one above either omits the prop or only sets
       `side`), so SideOffsetOverride below is a live control exercised for
       documentation, not a transcribed call site.

     delayDuration (Radix's own hover-delay prop, real at both the
       TooltipProvider layer and the individual Tooltip Root - functionally
       identical either way) - the real values in this tree:
       0    Sidebar.tsx:113,372,399 - all three set it directly on <Tooltip>.
       150  InternalCostsCard.tsx:200 - on <TooltipProvider>.
       400  data-table.tsx:745 - on <TooltipProvider>.
       700  Radix's own library default, taken implicitly (no override at
            all) by SendEstimateDialog.tsx:195, AddStepButton.tsx:89,
            PublishControl.tsx:78,110 and WorkflowsHome.tsx:307.
       This file wires the control onto <TooltipProvider> in every story's
       render, the more common of the two real shapes.

     className (content-only width override) - data-table.tsx's own
       `max-w-xs` is reproduced verbatim in LongContentMaxWidth: a plain
       Tailwind default utility, not a token and not an arbitrary bracket
       value. InternalCostsCard.tsx's own override (`max-w-[260px]`) IS an
       arbitrary bracket value - this session may add none, so it is
       described in prose in that story's own comment rather than
       reproduced literally.

   NOT covered, and why: align / alignOffset / avoidCollisions / sticky /
   hideWhenDetached / disableHoverableContent are all real Radix props
   TooltipContent or TooltipProvider ship and forward through ...props, but
   zero call sites in this tree ever pass any of them. Wiring a live control
   for a prop nobody has ever set would be exactly the "control because it
   would be nice" this program's rules forbid for a primitive's own
   vocabulary - they are left as Radix's own untouched defaults, reachable
   through the story's `render` spread for anyone who needs them, just not
   surfaced as a control.

   WHY EVERY STORY OPENS ITS OWN <Tooltip defaultOpen>, NOT ONE SHARED
   INSTANCE. TooltipContent renders through a Portal, positioned against its
   own trigger by Radix's floating layer - real call sites open on hover,
   which Storybook's static canvas cannot simulate, so every story below
   uses `defaultOpen` (a real Radix prop on the Tooltip Root) to render the
   content open without requiring a live pointer, the same reasoning
   dialog.stories.tsx and popover.stories.tsx use `defaultOpen` for their
   own overlay primitives.
   ============================================================================= */
import * as React from 'react'
import type { Meta, StoryObj } from '@storybook/react'
import { Plus } from 'lucide-react'

import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from './tooltip'
import { Button } from './button'
import { Inline } from './inline'

type TooltipContentProps = React.ComponentPropsWithoutRef<typeof TooltipContent>
type TooltipSide = NonNullable<TooltipContentProps['side']>

interface TooltipStoryArgs extends TooltipContentProps {
  /** Real prop, but on TooltipProvider/Tooltip Root, not TooltipContent - see the header note. */
  delayDuration: number
}

const SIDES: TooltipSide[] = ['top', 'right', 'bottom', 'left']

const SIDE_DESCRIPTIONS: Record<TooltipSide, string> = {
  top: 'Above the trigger - Radix\'s own default when `side` is omitted (PublishControl.tsx, WorkflowsHome.tsx), and data-table.tsx\'s explicit choice for its truncated-cell tooltip.',
  right: 'Beside the trigger, to the right - Sidebar.tsx\'s icon rail (3 sites): Create new, every nav destination label, AI Agentic Farm.',
  bottom: 'Below the trigger - SendEstimateDialog.tsx\'s send-button tooltip.',
  left: 'Beside the trigger, to the left - a real Radix value with zero call sites in this tree today; included to complete the axis.',
}

const meta: Meta<TooltipStoryArgs> = {
  title: 'UI/Tooltip',
  component: TooltipContent,
  tags: ['autodocs'],
  args: {
    side: 'top',
    sideOffset: 4,
    delayDuration: 700,
  },
  argTypes: {
    side: {
      control: { type: 'select' },
      options: SIDES,
      description:
        'Which edge of the trigger the content renders against. Radix\'s own Popper prop, forwarded verbatim through TooltipContent\'s ...props - not part of the closed vocabulary, tooltip.tsx has no variant axis. Defaults to "top" when omitted (PublishControl.tsx, WorkflowsHome.tsx); "bottom" (SendEstimateDialog.tsx) and "right" (Sidebar.tsx, x3) are the two other real values in this tree.',
    },
    sideOffset: {
      control: { type: 'number', min: 0, max: 32, step: 1 },
      description:
        'Pixel gap between the trigger and the content. tooltip.tsx\'s own one hardcoded default (sideOffset = 4 in the component\'s own destructuring) - no call site in this tree overrides it.',
    },
    delayDuration: {
      control: { type: 'number', min: 0, max: 1000, step: 50 },
      description:
        'Hover delay in ms before the tooltip opens. Wired here at the TooltipProvider layer (the more common real shape). Real values: 0 (Sidebar.tsx icon rail, set on <Tooltip> itself, same effect), 150 (InternalCostsCard.tsx), 400 (data-table.tsx), and 700 - Radix\'s own library default - taken implicitly by SendEstimateDialog.tsx, AddStepButton.tsx, PublishControl.tsx and WorkflowsHome.tsx.',
    },
    className: { control: false },
  },
  render: ({ delayDuration, side, sideOffset, className, children, ...rest }) => (
    <TooltipProvider delayDuration={delayDuration}>
      <Tooltip defaultOpen>
        <TooltipTrigger asChild>
          <Button variant="outline" size="sm">
            Hover me
          </Button>
        </TooltipTrigger>
        <TooltipContent side={side} sideOffset={sideOffset} className={className} {...rest}>
          {children ?? 'Helpful context'}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  ),
}

export default meta

type Story = StoryObj<typeof meta>

/**
 * `side="top"`, `sideOffset={4}`, `delayDuration={700}` - tooltip.tsx's own
 * shipped defaults, set explicitly rather than only implied by omission.
 * Flip the controls above the canvas to see any combination live.
 */
export const Default: Story = {
  args: {
    side: 'top',
    sideOffset: 4,
    delayDuration: 700,
    children: 'Helpful context',
  },
}

/** `side="top"` - the real signature at data-table.tsx's truncated-cell tooltip. */
export const SideTop: Story = {
  name: 'side="top" (data-table.tsx)',
  args: { side: 'top', children: 'The full, untruncated value' },
}

/** `side="right"` - Sidebar.tsx's icon rail, the most common real value (3 sites). */
export const SideRight: Story = {
  name: 'side="right" (Sidebar.tsx icon rail, x3)',
  args: { side: 'right', delayDuration: 0, children: 'Create new' },
}

/** `side="bottom"` - SendEstimateDialog.tsx's send-button tooltip. */
export const SideBottom: Story = {
  name: 'side="bottom" (SendEstimateDialog.tsx)',
  args: { side: 'bottom', children: 'Resend to the customer' },
}

/** `side="left"` - completes the axis; no real call site uses this value. */
export const SideLeft: Story = {
  name: 'side="left" (completes the axis - no real call site)',
  args: { side: 'left', children: 'No call site in this tree uses this side' },
}

/**
 * Every `side` value, 4/4, one trigger per value so all four are reachable
 * in a single canvas at once, matching popover.stories.tsx's SizeValues.
 */
export const SideValues: Story = {
  name: 'Every side value, side by side',
  render: () => (
    <TooltipProvider>
      <Inline gap={8} wrap align="center">
        {SIDES.map((side) => (
          <Tooltip key={side} defaultOpen>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm">{`side="${side}"`}</Button>
            </TooltipTrigger>
            <TooltipContent side={side}>{SIDE_DESCRIPTIONS[side]}</TooltipContent>
          </Tooltip>
        ))}
      </Inline>
    </TooltipProvider>
  ),
}

/** `sideOffset={4}` - tooltip.tsx's own hardcoded default, set explicitly. */
export const SideOffsetDefault: Story = {
  name: 'sideOffset={4} (tooltip.tsx\'s own default)',
  args: { sideOffset: 4, children: 'The 4px gap every call site inherits' },
}

/**
 * `sideOffset={16}` - a live control for the file's own default, not a
 * transcribed call site (none overrides it today).
 */
export const SideOffsetOverride: Story = {
  name: 'sideOffset override (no real call site)',
  args: { sideOffset: 16, children: 'A wider gap than the shipped default' },
}

/** `delayDuration={0}` - Sidebar.tsx's icon rail (3 sites), opens instantly. */
export const DelayInstant: Story = {
  name: 'delayDuration={0} (Sidebar.tsx icon rail, x3)',
  args: { delayDuration: 0, side: 'right', children: 'Opens immediately on hover' },
}

/** `delayDuration={150}` - InternalCostsCard.tsx's own TooltipProvider. */
export const Delay150: Story = {
  name: 'delayDuration={150} (InternalCostsCard.tsx)',
  args: { delayDuration: 150, children: 'A brief pause before opening' },
}

/** `delayDuration={400}` - data-table.tsx's own TooltipProvider. */
export const Delay400: Story = {
  name: 'delayDuration={400} (data-table.tsx)',
  args: { delayDuration: 400, children: "The table's own truncated-cell delay" },
}

/**
 * `delayDuration` omitted entirely - Radix's own 700ms library default, the
 * real shape at SendEstimateDialog.tsx, AddStepButton.tsx, PublishControl.tsx
 * and WorkflowsHome.tsx (none of the four passes an override).
 */
export const DelayDefault700: Story = {
  name: 'delayDuration omitted -> Radix\'s own 700ms default',
  args: { delayDuration: 700, children: 'No override passed at any of these four call sites' },
}

/**
 * `className="max-w-xs"` - data-table.tsx's real truncated-cell tooltip,
 * reproduced verbatim. A plain Tailwind default width utility, not an
 * arbitrary bracket value - unlike InternalCostsCard.tsx's own
 * `className="max-w-[260px]"` override, which is a real second call site
 * for the same idea but is not reproduced literally here because this
 * session may not introduce a new arbitrary bracket value.
 */
export const LongContentMaxWidth: Story = {
  name: 'className="max-w-xs" (data-table.tsx truncated cell)',
  args: {
    side: 'top',
    className: 'max-w-xs',
    children:
      'A long value that would otherwise force the tooltip to stretch as wide as its content, wrapped instead by max-w-xs.',
  },
}

/**
 * The real disabled-button idiom PublishControl.tsx and AddStepButton.tsx
 * both use: a disabled Button swallows pointer and focus events, so the
 * Tooltip listens on a focusable wrapper (`<span tabIndex={0}>`) around it
 * instead of the button itself. `delayDuration={0}` matches both real sites.
 */
export const DisabledTriggerPattern: Story = {
  name: 'Real call site pattern - tooltip on a disabled button (PublishControl.tsx)',
  render: () => (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="inline-flex" aria-label="Publish is blocked">
            <Button variant="solid" tone="business" disabled aria-disabled>
              Publish
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>Fix the workflow's validation errors before publishing.</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  ),
}

/**
 * The real Sidebar.tsx icon rail shape: a square icon-only button,
 * `side="right"`, `delayDuration={0}` set directly on the Tooltip Root
 * (not the Provider) - functionally identical to the Provider-level control
 * every other story above uses.
 */
export const SidebarIconRailPattern: Story = {
  name: 'Real call site pattern - Sidebar.tsx icon rail',
  render: () => (
    <TooltipProvider>
      <Tooltip delayDuration={0}>
        <TooltipTrigger asChild>
          <button className="flex h-9 w-9 items-center justify-center rounded-button border-2 border-on-fill bg-on-fill text-primary transition-colors duration-200 hover:bg-primary-subtle">
            <Plus className="h-5 w-5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">Create new</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  ),
}

/**
 * The real data-table.tsx truncated-cell shape: the trigger IS the cell
 * content (no button, no icon), `side="top"`, `className="max-w-xs"`,
 * `delayDuration={400}` on the Provider - the exact combination
 * TruncatedCell renders when a column value overflows its column width.
 */
export const DataTableTruncatedCellPattern: Story = {
  name: 'Real call site pattern - data-table.tsx truncated cell',
  render: () => (
    <TooltipProvider delayDuration={400}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="w-40 overflow-hidden text-ellipsis whitespace-nowrap rounded-md border border-border bg-surface-light px-3 py-2 text-sm text-text-primary">
            Acme Plumbing & Heating Emergency Service Contract
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs">
          Acme Plumbing &amp; Heating Emergency Service Contract
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  ),
}
