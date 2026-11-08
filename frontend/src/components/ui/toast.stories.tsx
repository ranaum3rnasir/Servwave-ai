/* =============================================================================
   Toast - Storybook stories, full-coverage pass (Storybook phase, W2 plan).

   Storybook 8 is scaffolded now (.storybook/main.ts, .storybook/preview.ts,
   the @storybook/react-vite devDependency in package.json) - this file
   imports the real `Meta` / `StoryObj` types from `@storybook/react` and
   wires `argTypes` so every axis is a live control in the Storybook UI,
   matching dialog.stories.tsx / sheet.stories.tsx / badge.stories.tsx.

   Coverage requirement (the completeness pass this phase adds): every
   variant key and every value in toast.tsx's cva() block needs at least one
   story that renders it.

     toastVariants = cva(..., { variants: { variant: { default, destructive } } })

       variant: default | destructive -> Default / Destructive each set it
         explicitly. `destructive` is the @deprecated public spelling (see
         toast.tsx's own `variant` prop doc comment and the file header note)
         - the internal cva bucket keeps the literal name for the
         `group-[.destructive]` selector ToastAction/ToastClose depend on,
         but Destructive below exists to prove the deprecated alias still
         renders, not to present it as a co-equal, undeprecated choice.

   That is the entire cva() surface - `tone` (added by the W2/8 rename-
   schedule gap fix, toast.tsx's own header note has the full reasoning) is
   NOT a cva key: it is a plain, non-deprecated prop that resolves to the
   same `variant: "destructive"` cell, so the completeness pass above has
   nothing of its own to require for it, and it is still given a control +
   story below (ToneDanger) for the same reason dropdown-menu.stories.tsx
   documents covering its own non-cva `variant` axis: a designer flipping
   controls needs to see the file's real, shipped surface regardless of
   which shape produced it.

   toast.tsx ships no `size`, `gap` or `pad` - the program plan's 1h
   prop-surface table (
   md_files/plans/frontend/2026-07-27-ui-component-architecture-program.md)
   lists `toast` in the "Nothing" column alongside badge/breadcrumb/etc, and
   phase 8's per-primitive demand pass found no measured call-site cluster
   asking for any of those axes on Toast - every real `toast({ ... })` call
   site (grepped across src/, outside components/ui/) passes only
   `title`/`description`/`action`/`variant`. So `size`/`gap`/`pad` are
   deliberately absent rather than invented "because it would be nice"
   (CLAUDE.md's evidence rule).

   `Default` sets `variant="default"` explicitly rather than leaning on
   toast.tsx's own `defaultVariants` for that cell, the same convention
   badge.stories.tsx / dialog.stories.tsx use.

   WHY EVERY STORY WRAPS ITS OWN `<ToastProvider>` + `<ToastViewport>`.
   Radix's ToastImpl reads `context.viewport` from ToastProviderContext and
   returns `null` if no viewport has mounted yet (verified in
   node_modules/@radix-ui/react-toast/dist/index.js) - a bare `<Toast>` with
   no Provider/Viewport ancestor renders nothing at all. Every story below
   supplies both. Unlike Dialog/Sheet (a full-viewport overlay, where two
   `defaultOpen` instances paint on top of each other), Toast's own
   ToastViewport is a `flex-col-reverse` stack - multiple toasts mounted in
   one viewport is the real, shipped multi-toast layout (see `Toaster.tsx`,
   which renders exactly this: one `<Toast>` per queued item inside a single
   shared `ToastProvider`/`ToastViewport`), so `BothVariantsStacked` renders
   two toasts side by side in one viewport deliberately, not as a
   Dialog/Sheet-style conflict to avoid.

   Copy on every story is lifted from real call sites (grepped, not
   invented): 'Settings saved' (pages/settings/SettingsLayout.tsx),
   'Could not save materials' / 'Please try again.'
   (pages/service-plans/ServicePlansPage.tsx), and the Undo-action shape
   from components/jobs/items/ScopeOfWorkCard.tsx's
   `toast({ title: 'Scope of work removed', ..., action: <ToastAction> })`.
   ============================================================================= */
import type { Meta, StoryObj } from '@storybook/react'

import {
  Toast,
  ToastAction,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from './toast'

const VARIANTS = ['default', 'destructive'] as const

const meta = {
  title: 'UI/Toast',
  component: Toast,
  tags: ['autodocs'],
  parameters: {
    // ToastViewport is fixed-positioned over the whole viewport (top on
    // mobile, bottom-right at sm:) - Storybook's default "padded"/"centered"
    // canvas letterboxes it, so this asks for the full frame instead,
    // matching how it actually renders in the app (same reasoning
    // dialog.stories.tsx / sheet.stories.tsx document for their own
    // Portal-rendered, fixed-position content).
    layout: 'fullscreen',
  },
  args: {
    variant: 'default',
  },
  argTypes: {
    variant: {
      control: { type: 'select' },
      options: VARIANTS,
      description:
        'Defaults to "default" (border, bg-surface-light) - toast.tsx\'s own `defaultVariants`, unmoved. "destructive" is @deprecated: the closed-variant rule retires it as a public value, decomposed into `tone="danger"` (see below). Kept working, byte-identical, since ~100 real call sites across src/ call the `toast()` function with `variant: "destructive"` and never see this component directly (see toast.tsx\'s header note) - write `tone="danger"` instead for new call sites.',
    },
    tone: {
      control: { type: 'select' },
      options: ['danger'],
      description:
        'Semantic colour, the vocabulary\'s preferred, non-deprecated entry point for this axis (W2/8 rename schedule). Resolves to the exact same cell the deprecated `variant="destructive"` does - `tone` wins whenever both are passed.',
    },
    className: { control: false },
  },
  render: (args) => (
    <ToastProvider>
      <Toast {...args}>
        <div className="grid gap-1">
          <ToastTitle>Settings saved</ToastTitle>
          <ToastDescription>Your changes are live for the whole team.</ToastDescription>
        </div>
        <ToastClose />
      </Toast>
      <ToastViewport />
    </ToastProvider>
  ),
} satisfies Meta<typeof Toast>

export default meta

type Story = StoryObj<typeof meta>

/**
 * `variant="default"` - toast.tsx's own `defaultVariants`, set explicitly.
 * Copy matches the real `toast({ title: 'Settings saved' })` call in
 * pages/settings/SettingsLayout.tsx: a title with no description is the
 * most common real shape.
 */
export const Default: Story = {
  args: {
    variant: 'default',
  },
  render: (args) => (
    <ToastProvider>
      <Toast {...args}>
        <div className="grid gap-1">
          <ToastTitle>Settings saved</ToastTitle>
        </div>
        <ToastClose />
      </Toast>
      <ToastViewport />
    </ToastProvider>
  ),
}

/**
 * The @deprecated `variant="destructive"` alias - the solid danger fill,
 * `group` + `border-danger bg-danger text-on-fill`. Byte-identical to
 * `tone="danger"` below (see ToneDanger); kept working because ~100 real
 * `toast({ ..., variant: 'destructive' })` call sites across src/ never see
 * this component directly (see toast.tsx's header note) and are not part of
 * this components/ui/-only session. Title/description match the real
 * `toast({ title: 'Could not save materials', description: 'Please try
 * again.', variant: 'destructive' })` call in
 * pages/service-plans/ServicePlansPage.tsx.
 */
export const Destructive: Story = {
  args: {
    variant: 'destructive',
  },
  render: (args) => (
    <ToastProvider>
      <Toast {...args}>
        <div className="grid gap-1">
          <ToastTitle>Could not save materials</ToastTitle>
          <ToastDescription>Please try again.</ToastDescription>
        </div>
        <ToastClose />
      </Toast>
      <ToastViewport />
    </ToastProvider>
  ),
}

/**
 * `tone="danger"` - the new, preferred, non-deprecated entry point for the
 * same cell the @deprecated `variant="destructive"` above renders.
 * Byte-identical output (same `toastVariants({ variant: "destructive" })`
 * call under the hood, see toast.tsx's Toast implementation), including the
 * `group-[.destructive]` hook ToastAction / ToastClose key their own danger
 * styling off - proving `tone` did not fork a second, parallel colour
 * system.
 */
export const ToneDanger: Story = {
  args: {
    tone: 'danger',
  },
  render: (args) => (
    <ToastProvider>
      <Toast {...args}>
        <div className="grid gap-1">
          <ToastTitle>Could not save materials</ToastTitle>
          <ToastDescription>Please try again.</ToastDescription>
        </div>
        <ToastClose />
      </Toast>
      <ToastViewport />
    </ToastProvider>
  ),
}

/**
 * Both `variant` values stacked in one shared `ToastViewport` - the real
 * multi-toast layout `Toaster.tsx` renders (one `<Toast>` per queued item,
 * `flex-col-reverse`, newest closest to the screen edge it slides in from).
 * Not a "values side by side for comparison" convenience grid like
 * badge.stories.tsx's `Tones` - this is the literal shipped shape.
 */
export const BothVariantsStacked: Story = {
  render: () => (
    <ToastProvider>
      <Toast variant="default">
        <div className="grid gap-1">
          <ToastTitle>Settings saved</ToastTitle>
        </div>
        <ToastClose />
      </Toast>
      <Toast variant="destructive">
        <div className="grid gap-1">
          <ToastTitle>Could not save materials</ToastTitle>
          <ToastDescription>Please try again.</ToastDescription>
        </div>
        <ToastClose />
      </Toast>
      <ToastViewport />
    </ToastProvider>
  ),
}

/**
 * `ToastAction` - a real, shipped sibling export, not part of the `variant`
 * cva axis. Reproduces the Undo shape from
 * components/jobs/items/ScopeOfWorkCard.tsx's real
 * `toast({ title: 'Scope of work removed', ..., action: <ToastAction
 * altText="Undo remove">Undo</ToastAction> })`.
 */
export const WithAction: Story = {
  render: () => (
    <ToastProvider>
      <Toast variant="default">
        <div className="grid gap-1">
          <ToastTitle>Scope of work removed</ToastTitle>
          <ToastDescription>Untitled scope</ToastDescription>
        </div>
        <ToastAction altText="Undo remove">Undo</ToastAction>
        <ToastClose />
      </Toast>
      <ToastViewport />
    </ToastProvider>
  ),
}

/**
 * `ToastAction` on a `variant="destructive"` toast - the @deprecated
 * spelling, chosen here (rather than `tone="danger"`) because it is the
 * literal shape real error-toast call sites like ServicePlansPage.tsx's
 * still use on disk. `group-[.destructive]` modifiers in ToastAction's own
 * class list (border/hover/focus ring all repainted to the `on-fill` role)
 * only ever exercise on this pairing, so a story needs both together at
 * least once to render that branch.
 */
export const DestructiveWithAction: Story = {
  render: () => (
    <ToastProvider>
      <Toast variant="destructive">
        <div className="grid gap-1">
          <ToastTitle>Could not convert the reservation</ToastTitle>
          <ToastDescription>Please try again.</ToastDescription>
        </div>
        <ToastAction altText="Retry conversion">Retry</ToastAction>
        <ToastClose />
      </Toast>
      <ToastViewport />
    </ToastProvider>
  ),
}
