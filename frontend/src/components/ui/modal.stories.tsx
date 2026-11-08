/* =============================================================================
   Modal - Storybook stories, full-coverage pass (Storybook phase, W2 plan).

   Storybook 8 is scaffolded in this worktree (.storybook/main.ts globs every
   .stories.ts(x) file under components/ui, .storybook/preview.ts loads the
   app's own CSS), so this file imports the real `Meta` / `StoryObj` types
   from `@storybook/react` and wires `argTypes` so every axis is a live
   control in the Storybook UI, matching dialog.stories.tsx / button.stories.tsx.

   WHY THERE IS NO `cva()` BLOCK TO PARSE HERE.
   modal.tsx does not use class-variance-authority at all - its only closed
   enum is a hand-rolled `width?: 'sm' | 'md' | 'lg' | 'xl'` prop (plus a
   deprecated `size` alias of the same type), looked up in a plain
   `Record<ModalWidth, string>` (`WIDTH`) and spliced into DialogContent's
   className. This mirrors dialog.tsx's own `width`/`pad`/`gap` (plain
   Records, not cva) and confirm-dialog.tsx's hand-rolled `variant` - both of
   those stories document the same way: the completeness target is the real
   prop surface the file exports and branches on, not a cva object.

   Modal has no `variant`, `tone`, `gap` or `pad` axis - no measured demand
   for any of them (program-plan section 1b/1h list Modal's only existing API
   as `width`/`size`; nothing else is in the axis-demand table, so no other
   prop is invented here per the "no demand, no prop" rule).

   COMPLETENESS. Every value modal.tsx's props accept renders in at least one
   story below, not just the default:

     width (ModalProps['width'], `size` is a deprecated alias of the same type)
       'sm' | 'md' | 'lg' | 'xl'
       -> SizeSm / Default (md) / SizeLg / SizeXl, one open modal each, driven
       through the `width` control.
       Real call-site counts (52 <Modal> sites scanned, size prop only, all
       still resolving through the live `size` alias):
       lg x17 (most common explicit value), xl x15, md x12 explicit + 2 by
       omission = 14, sm x6.
     subtitle (React.ReactNode, optional) - present (WithSubtitle) / absent
       (Default and most others).
     lockEscape (boolean, optional) - true (LockEscape) / false (everywhere
       else, including by omission). Blocks Escape-to-close; the visible
       effect (nothing happens on Escape) cannot be screenshotted, so the
       story's own body copy names the real call sites that set it
       (VendorDetailDialog, RestockDialog, PODetailDialog).
     editAction (ModalEditAction, optional) - present (WithEditAction) /
       absent (Default and most others).
     footer (React.ReactNode, optional) - a named preset selector below
       ('none' | 'closeOnly' | 'cancelSave' | 'cancelDelete') stands in for
       the real prop so the Controls panel can drive it, the same trick
       confirm-dialog.stories.tsx uses for its `icon` prop. All four presets
       get their own story: NoFooter ('none', real site: NumbersView's "Get a
       number" modal), Default ('closeOnly'), LockEscape ('cancelSave'),
       WithSubtitle ('cancelDelete', real site: DeleteItemDialog).

   WHY THIS FILE OWNS ITS OPEN STATE THROUGH A DEMO WRAPPER.
   `open`/`onClose` are real controlled props - Modal composes Dialog, which
   renders nothing at all while closed - so a plain `args` object has no way
   to hold the modal open across a re-render. `ModalDemo` below seeds local
   state to `true` (the modal is visible the moment the story mounts) and
   exposes a button to reopen it after Escape/the close (X) button/a footer
   action closes it, the same shape confirm-dialog.stories.tsx uses for
   `ConfirmDialogDemo`. Every real call site already manages `open` the same
   way, just against a piece of page state instead of a Storybook arg.
   ============================================================================= */
import * as React from 'react'
import type { Meta, StoryObj } from '@storybook/react'

import { Modal, type ModalEditAction, type ModalProps } from './modal'
import { Button } from './button'

type ModalWidth = NonNullable<ModalProps['width']>
const WIDTHS: ModalWidth[] = ['xs', 'sm', 'md', 'lg', 'xl']

/** Named options for the footer Controls select - a designer picks a shape, not JSX. */
type FooterPreset = 'none' | 'closeOnly' | 'cancelSave' | 'cancelDelete'

const FOOTERS: Record<FooterPreset, React.ReactNode> = {
  none: undefined,
  closeOnly: (
    <Button variant="outline" size="sm">
      Close
    </Button>
  ),
  cancelSave: (
    <>
      <Button variant="outline" size="sm">
        Cancel
      </Button>
      <Button size="sm">Save changes</Button>
    </>
  ),
  cancelDelete: (
    <>
      <Button variant="outline" size="sm">
        Cancel
      </Button>
      <Button size="sm" tone="danger">
        Delete
      </Button>
    </>
  ),
}

/** Named options for the editAction Controls select - same trick as `FooterPreset`. */
type EditActionPreset = 'none' | 'edit'

const EDIT_ACTIONS: Record<EditActionPreset, ModalEditAction | undefined> = {
  none: undefined,
  edit: { label: 'Edit', onClick: () => {} },
}

type ModalDemoProps = {
  title: React.ReactNode
  subtitle?: React.ReactNode
  width?: ModalWidth
  lockEscape?: boolean
  footer?: FooterPreset
  editAction?: EditActionPreset
  children: React.ReactNode
}

function ModalDemo({ footer = 'none', editAction = 'none', ...rest }: ModalDemoProps) {
  const [open, setOpen] = React.useState(true)
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Reopen modal
      </Button>
      <Modal
        {...rest}
        open={open}
        onClose={() => setOpen(false)}
        footer={FOOTERS[footer]}
        editAction={EDIT_ACTIONS[editAction]}
      />
    </>
  )
}

const meta = {
  title: 'UI/Modal',
  component: ModalDemo,
  tags: ['autodocs'],
  args: {
    title: 'Delete item?',
    width: 'md',
    lockEscape: false,
    footer: 'closeOnly',
    editAction: 'none',
    children: (
      <p className="text-sm text-text-secondary">
        This action cannot be undone.
      </p>
    ),
  },
  argTypes: {
    title: { control: 'text' },
    subtitle: { control: 'text' },
    width: {
      control: { type: 'select' },
      options: WIDTHS,
      description:
        'Max width. Defaults to "md" (max-w-lg) - today\'s unstyled geometry, unmoved (12 explicit call sites + 2 by omission = 14). xs=max-w-sm (the confirm-shaped dialogs), sm=max-w-md (6 sites), lg=max-w-2xl (17 sites, the single most common explicit value), xl=max-w-4xl (15 sites). `size` is a deprecated alias of the same type - still live, resolves identically, not surfaced as a separate control here.',
    },
    lockEscape: {
      control: 'boolean',
      description:
        'Blocks Escape-to-close (onEscapeKeyDown is prevented) - the shape a modal reaches for while a nested confirm/email/scan dialog is open on top of it, or while an inline edit is in progress. Real sites: VendorDetailDialog (lockEscape={isEditing}), RestockDialog, PODetailDialog.',
    },
    footer: {
      control: { type: 'select' },
      options: ['none', 'closeOnly', 'cancelSave', 'cancelDelete'] satisfies FooterPreset[],
      description:
        'Named stand-in for the real `footer?: React.ReactNode` prop, so the Controls panel can drive it. "none" renders no DialogFooter at all (real site: NumbersView\'s "Get a number" modal).',
    },
    editAction: {
      control: { type: 'select' },
      options: ['none', 'edit'] satisfies EditActionPreset[],
      description:
        'Named stand-in for the real `editAction?: { label, onClick, icon? }` prop - an outline button rendered beside the title. Real sites: VendorDetailDialog, ApprovalDetailDialog.',
    },
    children: { table: { disable: true } },
  },
} satisfies Meta<typeof ModalDemo>

export default meta

type Story = StoryObj<typeof meta>

/**
 * `width="md"` (max-w-lg), no subtitle, no editAction, a `closeOnly` footer -
 * modal.tsx's own defaults, set explicitly rather than only implied by
 * omission. Flip the controls above the canvas to see any combination live.
 */
export const Default: Story = {}

/**
 * `width="xs"` - max-w-sm, the narrowest rung.
 *
 * Added for the confirm-shaped dialogs that were already rendering at max-w-sm
 * by hand (void payment, void invoice, record payment) and could not move onto
 * Modal without getting wider. It is `DialogWidth`'s own `xs`, so the two
 * scales now name the same four widths the same way.
 */
export const SizeXs: Story = {
  args: {
    width: 'xs',
    title: 'Void payment?',
    children: (
      <p className="text-sm text-text-secondary">
        One question and two buttons. Anything wider makes a confirmation look
        like a form.
      </p>
    ),
  },
}

/** `width="sm"` - max-w-md, the second rung (6 real call sites). */
export const SizeSm: Story = {
  args: {
    width: 'sm',
    title: 'Add branch',
    children: (
      <p className="text-sm text-text-secondary">
        A short, focused form fits this width - name and address only.
      </p>
    ),
  },
}

/** `width="lg"` - max-w-2xl, the single most common explicit value (17 real call sites). */
export const SizeLg: Story = {
  args: {
    width: 'lg',
    title: 'Get a number',
    footer: 'none',
    children: (
      <p className="text-sm text-text-secondary">
        Real site: NumbersView, no footer at all - the search results list is the
        primary action surface.
      </p>
    ),
  },
}

/** `width="xl"` - max-w-4xl, the widest rung (15 real call sites). */
export const SizeXl: Story = {
  args: {
    width: 'xl',
    title: 'Vendor · Acme Supply Co',
    subtitle: 'Plumbing supplies · acct 48213',
    children: (
      <p className="text-sm text-text-secondary">
        Wide enough for a vendor's contact details, recent purchase orders and
        activity side by side.
      </p>
    ),
  },
}

/**
 * `subtitle` present, under the title. Real site: DeleteItemDialog's
 * archive-or-delete explanation, paired with its destructive footer.
 */
export const WithSubtitle: Story = {
  args: {
    title: 'Delete item?',
    subtitle:
      "The item is permanently deleted if nothing references it, or archived instead if it's still in use elsewhere. Either way, an audit log entry is recorded.",
    footer: 'cancelDelete',
    children: (
      <p className="text-sm text-text-secondary">
        Delete <span className="font-semibold text-text-primary">Copper Pipe 1/2in</span>{' '}
        <code className="rounded bg-background-light px-1.5 py-0.5 font-mono text-xs">
          CU-050
        </code>
        ?
      </p>
    ),
  },
}

/**
 * `editAction` present - an outline button next to the title. Real sites:
 * VendorDetailDialog and ApprovalDetailDialog both show this only while not
 * already editing.
 */
export const WithEditAction: Story = {
  args: {
    title: 'Vendor · Acme Supply Co',
    subtitle: 'Plumbing supplies · acct 48213',
    width: 'xl',
    editAction: 'edit',
    children: (
      <p className="text-sm text-text-secondary">
        Contact details, recent purchase orders and activity - read-only until
        Edit is clicked.
      </p>
    ),
  },
}

/**
 * `lockEscape` - Escape no longer closes the modal (`onEscapeKeyDown` is
 * prevented). The effect itself has nothing to screenshot; this story's
 * value is documenting when to reach for it. Real sites: VendorDetailDialog
 * (locked while `isEditing`), RestockDialog, PODetailDialog (locked while a
 * nested dialog is open on top).
 */
export const LockEscape: Story = {
  args: {
    lockEscape: true,
    title: 'Edit vendor',
    footer: 'cancelSave',
    children: (
      <p className="text-sm text-text-secondary">
        Escape is disabled while editing, so an accidental keypress cannot
        discard unsaved changes - Cancel is the only way out.
      </p>
    ),
  },
}

/**
 * `footer` omitted entirely - no `DialogFooter` renders at all. Real site:
 * NumbersView's "Get a number" modal, where the search results list is the
 * primary action surface, not a footer button row.
 */
export const NoFooter: Story = {
  args: {
    title: 'Get a number',
    width: 'lg',
    footer: 'none',
    children: (
      <p className="text-sm text-text-secondary">
        No footer - the number search results below are where the real actions
        live.
      </p>
    ),
  },
}

/**
 * Every control wired at once - flip `width`, `lockEscape`, `footer` and
 * `editAction` live in the Controls panel below.
 */
export const Playground: Story = {
  args: {
    title: 'Delete this estimate?',
    subtitle: 'This action cannot be undone.',
    width: 'md',
    lockEscape: false,
    footer: 'cancelDelete',
    editAction: 'none',
    children: (
      <p className="text-sm text-text-secondary">
        Everything below the header comes from `children` - a plain paragraph
        here, any real content at a real call site.
      </p>
    ),
  },
}
