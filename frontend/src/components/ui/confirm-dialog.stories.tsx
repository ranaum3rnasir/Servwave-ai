/* =============================================================================
   ConfirmDialog - Storybook stories.

   Storybook 8 is scaffolded in this worktree (.storybook/main.ts globs every
   .stories.ts(x) file under components/ui, .storybook/preview.ts loads the
   app's own CSS), so this file uses the real `Meta` / `StoryObj` types from
   `@storybook/react`, matching button.stories.tsx / card.stories.tsx.

   WHY THERE IS NO `cva()` BLOCK TO PARSE HERE.
   confirm-dialog.tsx does not use class-variance-authority at all - its only
   closed enum is a hand-rolled `variant?: 'default' | 'destructive'` prop,
   branched with a plain ternary inside `cn(...)` (see the icon-badge and
   Confirm-button classes in the component). This mirrors card.tsx's own
   `tone` prop, which card.stories.tsx documents the same way: the
   completeness target is the real prop surface the file exports and
   branches on, not a cva object.

   COMPLETENESS. Every value confirm-dialog.tsx's `tone` prop (and its
   deprecated `variant` alias) accepts renders in its own story below, not
   just the default:

     tone - 'brand' (Default, WithIcon, Loading, RichBody, WiderDialog),
            'danger' (Destructive, CustomLabels, ToneDanger)
     variant (deprecated alias, kept for the 3 real call sites still using
     it - see the file header) - 'destructive' (DeprecatedVariantDestructive)

   The rest of ConfirmDialogProps has no closed value set (title/description/
   confirmLabel/cancelLabel are free text, icon is any LucideIcon, children is
   any ReactNode, className is a layout override) - each still gets at least
   one story so every branch in the component renders at least once:

     icon present / icon absent      - Destructive vs Default
     description present / absent    - Default vs TitleOnly
     isLoading true / false          - Loading vs everything else
     children present / absent       - RichBody vs everything else
     className override / default    - WiderDialog vs everything else
     confirmLabel/cancelLabel custom - CustomLabels

   Every example below is drawn from one of ConfirmDialog's six real call
   sites (JobDetailPage, IconRail, PublicEstimatePage, SchedulePage x2,
   RescheduleConfirmDialog, NumbersView) rather than invented copy.

   WHY EVERY STORY OWNS ITS OWN OPEN STATE.
   `open`/`onOpenChange` are real controlled props (ConfirmDialog composes
   Radix's Dialog, which renders nothing at all while closed) - a plain args
   object has no way to hold that open across a re-render, so `ConfirmDialogDemo`
   below seeds local state to `true` (the dialog is visible the moment the
   story mounts) and exposes a button to reopen it after Cancel/Confirm/Esc
   closes it. Every real call site already manages `open` the same way, just
   against a piece of page state instead of a Storybook arg.
   ============================================================================= */
import * as React from 'react'
import type { Meta, StoryObj } from '@storybook/react'
import { Calendar, CheckSquare, Trash2 } from 'lucide-react'

import { ConfirmDialog, type ConfirmDialogProps } from './confirm-dialog'
import { Button } from './button'

/** Named options for the Controls select - a designer picks a name, not a component reference. */
type DemoIcon = 'none' | 'trash' | 'calendar' | 'checkSquare'

const ICONS: Record<DemoIcon, ConfirmDialogProps['icon']> = {
  none: undefined,
  trash: Trash2,
  calendar: Calendar,
  checkSquare: CheckSquare,
}

type ConfirmDialogDemoProps = Omit<
  ConfirmDialogProps,
  'open' | 'onOpenChange' | 'onConfirm' | 'icon'
> & {
  icon?: DemoIcon
}

function ConfirmDialogDemo({ icon = 'none', ...rest }: ConfirmDialogDemoProps) {
  const [open, setOpen] = React.useState(true)
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Reopen dialog
      </Button>
      <ConfirmDialog
        {...rest}
        icon={ICONS[icon]}
        open={open}
        onOpenChange={setOpen}
        onConfirm={() => setOpen(false)}
      />
    </>
  )
}

const meta = {
  title: 'UI/ConfirmDialog',
  component: ConfirmDialogDemo,
  tags: ['autodocs'],
  argTypes: {
    tone: {
      control: { type: 'select' },
      options: ['brand', 'danger'],
      description:
        "'danger' tints the icon badge and the Confirm button danger (delete/cancel-type actions). Default 'brand'. Supersedes `variant`.",
    },
    variant: {
      control: { type: 'select' },
      options: ['default', 'destructive'],
      description:
        "Deprecated - use `tone` instead. 'destructive' tints the icon badge and the Confirm button danger (delete/cancel-type actions). Default 'default'. Ignored when `tone` is also passed.",
    },
    icon: {
      control: { type: 'select' },
      options: ['none', 'trash', 'calendar', 'checkSquare'],
      description: 'Named stand-in for the real `icon?: LucideIcon` prop, so the Controls panel can drive it.',
    },
    title: { control: 'text' },
    description: { control: 'text' },
    confirmLabel: { control: 'text' },
    cancelLabel: { control: 'text' },
    isLoading: { control: 'boolean' },
    className: {
      control: 'text',
      description: 'Layout-only override, e.g. a wider dialog for a richer body.',
    },
    children: { table: { disable: true } },
    onCancel: { table: { disable: true } },
  },
} satisfies Meta<typeof ConfirmDialogDemo>

export default meta

type Story = StoryObj<typeof meta>

/**
 * `variant` omitted - resolves to the component's own default, 'default'.
 * No icon, a plain description. Matches the shape of most confirmation
 * prompts that are not destructive (e.g. NumbersView's "Confirm number").
 */
export const Default: Story = {
  args: {
    title: 'Delete this contact?',
    description: 'This action cannot be undone.',
    confirmLabel: 'Confirm',
    cancelLabel: 'Cancel',
  },
}

/**
 * `description` omitted entirely - JobDetailPage passes `description={undefined}`
 * on this exact dialog whenever the job has no synced inventory lines to warn
 * about, so `DialogDescription` never renders at all.
 */
export const TitleOnly: Story = {
  args: {
    title: 'Delete this job?',
  },
}

/**
 * `tone="danger"` - the second (and only other) value the prop accepts.
 * Icon badge and Confirm button both tint danger. Real site: JobDetailPage's
 * job-delete dialog (which still passes the deprecated `variant="destructive"`
 * alias on disk - see DeprecatedVariantDestructive below for proof the two
 * render identically).
 */
export const Destructive: Story = {
  args: {
    tone: 'danger',
    icon: 'trash',
    title: 'Delete this job?',
    description: 'Synced inventory items on this job will be returned to stock.',
    confirmLabel: 'Delete',
  },
}

/**
 * The deprecated `variant="destructive"` alias, with no `tone` passed -
 * byte-identical to `tone="danger"` above. This is the literal shape all 3
 * real call sites still on disk use (IconRail.tsx:146,
 * PublicEstimatePage.tsx:779, JobDetailPage.tsx:1776), kept working rather
 * than migrated - migrating them is phase 11 work, out of bounds for a
 * components/ui/-only session.
 */
export const DeprecatedVariantDestructive: Story = {
  args: {
    variant: 'destructive',
    icon: 'trash',
    title: 'Delete this job?',
    description: 'Synced inventory items on this job will be returned to stock.',
    confirmLabel: 'Delete',
  },
}

/**
 * `icon` present on the 'default' variant - the icon badge renders in the
 * brand tint (`bg-primary-subtle` / `text-primary`) rather than danger. Real
 * site: RescheduleConfirmDialog's Calendar badge.
 */
export const WithIcon: Story = {
  args: {
    icon: 'calendar',
    title: 'Schedule Job?',
    description: 'Monday, July 27 at 9:00 AM',
    confirmLabel: 'Confirm & Schedule',
  },
}

/**
 * `isLoading` - the Confirm button shows the spinner and both Cancel and
 * Confirm are disabled. Real site: any of the three call sites that gate
 * this on a mutation's pending state (JobDetailPage, PublicEstimatePage,
 * NumbersView).
 */
export const Loading: Story = {
  args: {
    tone: 'danger',
    icon: 'trash',
    title: 'Delete this job?',
    confirmLabel: 'Delete',
    isLoading: true,
  },
}

/**
 * Custom `confirmLabel` / `cancelLabel` - both overridden away from the
 * 'Confirm' / 'Cancel' defaults. Real site: IconRail's discard-note prompt.
 */
export const CustomLabels: Story = {
  args: {
    tone: 'danger',
    title: 'Discard unsaved note?',
    description: "Your note hasn't been added yet and will be lost if you leave.",
    confirmLabel: 'Discard note',
    cancelLabel: 'Keep editing',
  },
}

/**
 * `children` - a rich body rendered between the description and the footer.
 * Real site: SchedulePage's "confirm all changes" dialog, which lists every
 * draft event about to be scheduled.
 */
export const RichBody: Story = {
  args: {
    icon: 'checkSquare',
    title: 'Confirm 3 Changes?',
    description: 'This will schedule all draft events visible in the current view.',
    confirmLabel: 'Confirm 3 Changes',
    children: (
      <div className="mb-4 max-h-40 space-y-1 overflow-y-auto rounded-lg bg-background-light p-3">
        <p className="text-xs text-text-secondary">Roof inspection - Jordan Blake</p>
        <p className="text-xs text-text-secondary">Water heater install - Casey Nguyen</p>
        <p className="text-xs text-text-secondary">Panel upgrade walkthrough - Priya Shah</p>
      </div>
    ),
  },
}

/**
 * `className` - a layout-only override for a wider dialog with a richer
 * body. Real site: RescheduleConfirmDialog passes `className="max-w-md"`
 * around its from/to comparison panel.
 */
export const WiderDialog: Story = {
  args: {
    icon: 'calendar',
    title: 'Reschedule Job J00042?',
    description: 'J00042',
    confirmLabel: 'Confirm reschedule',
    className: 'max-w-md',
    children: (
      <div className="rounded-lg bg-background-light p-4">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-text-secondary">From</p>
            <p className="text-sm font-medium text-text-primary">Mon, Jul 27, 9:00 AM</p>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs text-text-secondary">To</p>
            <p className="text-sm font-medium text-text-primary">Tue, Jul 28, 1:00 PM</p>
          </div>
        </div>
      </div>
    ),
  },
}

/**
 * Every control wired at once - flip `tone`, `icon`, `isLoading` and every
 * text prop live in the Controls panel below. `variant` is still wired too
 * (deprecated alias, ignored whenever `tone` is set) so a designer can see
 * both entry points. ConfirmDialog has no `size`, `gap` or `pad` axis (no
 * measured demand for any of them - see the header note).
 */
export const Playground: Story = {
  args: {
    tone: 'brand',
    icon: 'trash',
    title: 'Delete this estimate?',
    description: 'This action cannot be undone.',
    confirmLabel: 'Confirm',
    cancelLabel: 'Cancel',
    isLoading: false,
  },
}
