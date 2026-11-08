/* =============================================================================
   Collapse - Storybook stories, full-coverage pass (Storybook phase, W2 plan).

   Storybook 8 is scaffolded in this worktree (.storybook/main.ts,
   .storybook/preview.ts, the @storybook/react-vite devDependency in
   package.json, now resolvable from the workspace-root node_modules), so
   this file imports the real `Meta` / `StoryObj` types from `@storybook/react`
   and wires `argTypes` so every prop is a live control in the Storybook UI -
   the same shape as separator.stories.tsx / label.stories.tsx. This file's
   first pass predates that landing and used a plain default-export object
   instead (see this file's own git history); the shape below is a type-only
   upgrade of the same stories, not a rewrite.

   Collapse has no `cva()` block and none of the closed vocabulary
   (`variant` / `tone` / `size` / `gap` / `pad`) - not an oversight here. The
   program plan's prop-surface audit places `collapse` in the "Nothing"
   column (section 1h), and neither demand table (1b "call sites by axis", 1c
   "what call sites are asking for") lists it at all: zero measured call
   sites ever passed it a size/colour/spacing override to retrofit into a
   variant. Per the W2 plan's rule - a primitive with no measured demand is
   left alone, not given a prop "because it would be nice" - this file
   documents Collapse's real, current API instead of inventing one: `open`
   (the one prop worth a live control), `children`, and the `className`
   passthrough real call sites already lean on. Because the component has no
   cva block, the Storybook completeness pass (which parses cva blocks
   tree-wide and fails on any uncovered variant value) has nothing to require
   here - vacuously satisfied, not skipped.

   REAL CALL SITES. Five in the app today (grepped tree-wide, excluding this
   file and __tests__): Sidebar.tsx (nav group sub-items, on the dark chrome
   panel), UnassignedBuckets.tsx (scheduler bucket rows), AiInsightsCard.tsx
   (the AI insights list, tone="ai" panel), JobNotesPreview.tsx (the note
   composer textarea, revealed by a header "+"), and ArAgingReport.tsx (an
   invoice drill-down row, className="mb-2 ml-9"). All five are transcribed
   below as their own story, each with the real surrounding chrome so the
   height/opacity transition is seen in the context it actually ships in, not
   just against a blank canvas.
   ============================================================================= */
import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { ChevronDown, ChevronRight, ChevronUp, Plus, X } from 'lucide-react';

import { Collapse } from './collapse';
import { Button } from './button';

const meta = {
  title: 'UI/Collapse',
  component: Collapse,
  tags: ['autodocs'],
  argTypes: {
    open: {
      control: { type: 'boolean' },
      description:
        'Mounts and animates children in (height/opacity, 200ms ease-in-out) when true; animates them out and unmounts when false.',
    },
    children: {
      control: { type: 'text' },
    },
    className: {
      control: false,
      description: 'Passthrough onto the animated wrapper - merged with the fixed `overflow-hidden`.',
    },
  },
} satisfies Meta<typeof Collapse>;

export default meta;

type Story = StoryObj<typeof meta>;

/** `open=true` - the expanded state, height animating from 0 to the content's natural height. */
export const Default: Story = {
  args: {
    open: true,
    children: 'Expanded content - visible whenever open is true.',
  },
};

/**
 * `open=false` - the canvas below is intentionally blank. `AnimatePresence`
 * animates height and opacity to 0 and then unmounts the children entirely,
 * so nothing paints once the exit transition finishes. Flip the `open`
 * control above to watch it play in both directions.
 */
export const Closed: Story = {
  args: {
    open: false,
    children: 'You will not see this line - open is false.',
  },
};

/**
 * A live toggle button, not just the `open` control above - proves the
 * actual expand/collapse transition plays in both directions rather than
 * just showing two static endpoints.
 */
function ToggleDemo() {
  const [open, setOpen] = useState(true);
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="w-fit rounded-md border border-border bg-surface-light px-3 py-1.5 text-sm text-text-primary"
      >
        {open ? 'Collapse' : 'Expand'}
      </button>
      <Collapse open={open}>
        <p className="text-sm text-text-primary">
          Toggled by the button above, not by the open control.
        </p>
      </Collapse>
    </div>
  );
}

export const Interactive: Story = {
  // `args` is required by Collapse's own required `open`/`children` props,
  // even though this story's custom `render` below ignores them entirely in
  // favour of ToggleDemo's own internal open state.
  args: { open: true, children: null },
  render: () => <ToggleDemo />,
};

/**
 * The real Sidebar.tsx call site: a nav group's child links, indented with
 * `className="ml-3 mt-0.5"`, collapsing under their parent header row when
 * the group is toggled shut. Rendered on the real chrome background
 * (`bg-gradient-to-b from-ocean-900 to-ocean-800`) so the `on-fill` text
 * tokens read correctly - Sidebar.tsx never renders this on a light surface.
 */
function SidebarNavGroupDemo() {
  const [open, setOpen] = useState(true);
  return (
    <div className="w-64 rounded-lg border border-ocean-900 bg-gradient-to-b from-ocean-900 to-ocean-800 p-3">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 rounded-lg px-4 py-2.5 text-sm font-medium text-on-fill/70 transition-colors hover:bg-on-fill/10 hover:text-on-fill"
      >
        <span className="flex-1 text-left">Estimates</span>
        <ChevronDown className={open ? 'h-3.5 w-3.5 shrink-0 transition' : 'h-3.5 w-3.5 shrink-0 -rotate-90 transition'} />
      </button>
      <Collapse open={open} className="ml-3 mt-0.5">
        <ul className="space-y-0.5 border-l border-on-fill/15 pl-2">
          <li>
            <span className="block truncate rounded-md px-2.5 py-1.5 text-xs text-on-fill/65 hover:bg-on-fill/10 hover:text-on-fill">
              All estimates
            </span>
          </li>
          <li>
            <span className="block truncate rounded-md px-2.5 py-1.5 text-xs text-on-fill/65 hover:bg-on-fill/10 hover:text-on-fill">
              Drafts
            </span>
          </li>
          <li>
            <span className="block truncate rounded-md px-2.5 py-1.5 text-xs text-on-fill/65 hover:bg-on-fill/10 hover:text-on-fill">
              Approved
            </span>
          </li>
        </ul>
      </Collapse>
    </div>
  );
}

export const SidebarNavGroup: Story = {
  name: 'Real call site - Sidebar nav group',
  // See Interactive's own comment on why `args` is required here even though
  // the custom `render` below never reads it.
  args: { open: true, children: null },
  render: () => <SidebarNavGroupDemo />,
};

/**
 * The real UnassignedBuckets.tsx call site: a scheduler bucket's job rows,
 * shown or hidden as one block under the bucket's header button.
 */
function SchedulerBucketDemo() {
  const [open, setOpen] = useState(true);
  return (
    <div className="w-72 overflow-hidden rounded-lg border border-border bg-surface-light">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-background-light"
      >
        <span className="text-xs font-semibold text-text-primary">Unassigned jobs</span>
        <span className="ml-auto text-3xs font-medium text-text-secondary">3</span>
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 text-text-secondary" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-text-secondary" />
        )}
      </button>
      <Collapse open={open}>
        <div className="space-y-1.5 px-2 pb-2">
          <div className="rounded-md border border-border bg-background-light px-2.5 py-2 text-xs text-text-primary">
            J00042 - Water heater replacement
          </div>
          <div className="rounded-md border border-border bg-background-light px-2.5 py-2 text-xs text-text-primary">
            J00043 - Furnace inspection
          </div>
          <div className="rounded-md border border-border bg-background-light px-2.5 py-2 text-xs text-text-primary">
            J00044 - Drain cleaning
          </div>
        </div>
      </Collapse>
    </div>
  );
}

export const SchedulerBucketRows: Story = {
  name: 'Real call site - UnassignedBuckets rows',
  args: { open: true, children: null },
  render: () => <SchedulerBucketDemo />,
};

/**
 * The real AiInsightsCard.tsx call site: an `ai`-tone panel whose insights
 * list collapses under a chevron toggle in the header, leaving an
 * all-caught-up message in its place when there is nothing to show.
 */
function AiInsightsDemo() {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className="w-80 rounded-lg border border-ai-600/20 bg-ai-600/5 p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="inline-flex items-center gap-2 text-sm font-semibold text-text-primary">
          AI Operations Insights
          <span className="rounded-full bg-ai-600/10 px-2 py-0.5 text-3xs font-semibold uppercase tracking-widest text-ai-600">
            BETA
          </span>
        </span>
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          aria-label={collapsed ? 'Expand insights' : 'Collapse insights'}
          aria-expanded={!collapsed}
          className="text-ai-600/70 transition-colors hover:text-ai-600"
        >
          <ChevronUp className={collapsed ? 'h-4 w-4 rotate-180 transition-transform' : 'h-4 w-4 transition-transform'} />
        </button>
      </div>
      <Collapse open={!collapsed}>
        <ul className="divide-y divide-ai-600/10">
          <li className="flex items-start gap-3 py-3 first:pt-0">
            <p className="text-sm font-semibold leading-snug text-text-primary">
              Estimate approved 2 days ago - schedule the job
            </p>
          </li>
          <li className="flex items-start gap-3 py-3 last:pb-0">
            <p className="text-sm font-semibold leading-snug text-text-primary">
              No before photos uploaded yet
            </p>
          </li>
        </ul>
      </Collapse>
    </div>
  );
}

export const AiInsightsPanel: Story = {
  name: 'Real call site - AiInsightsCard insights list',
  args: { open: true, children: null },
  render: () => <AiInsightsDemo />,
};

/**
 * The real JobNotesPreview.tsx call site: a note composer hidden by default
 * and revealed by the header "+" button - saves space when no one is
 * mid-note.
 */
function JobNotesComposerDemo() {
  const [composerOpen, setComposerOpen] = useState(false);
  return (
    <div className="w-80 rounded-lg border border-border bg-surface-light p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-semibold text-text-primary">Job Notes</span>
        <button
          type="button"
          onClick={() => setComposerOpen((value) => !value)}
          aria-label={composerOpen ? 'Close note composer' : 'Add note'}
          aria-expanded={composerOpen}
          className="flex h-6 w-6 items-center justify-center rounded-md text-text-secondary hover:bg-primary-subtle hover:text-primary"
        >
          {composerOpen ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
        </button>
      </div>
      <Collapse open={composerOpen}>
        <div className="space-y-2">
          <textarea
            rows={2}
            placeholder="Type internal note..."
            className="w-full resize-none rounded-md border border-border bg-background-light p-2 text-sm text-text-primary"
          />
          <div className="flex items-center justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setComposerOpen(false)}>
              Cancel
            </Button>
            <Button variant="solid" tone="business" size="sm">
              Add Note
            </Button>
          </div>
        </div>
      </Collapse>
    </div>
  );
}

export const JobNotesComposer: Story = {
  name: 'Real call site - JobNotesPreview composer',
  args: { open: true, children: null },
  render: () => <JobNotesComposerDemo />,
};

/**
 * The real ArAgingReport.tsx call site: `className="mb-2 ml-9"` indents a
 * customer's invoice drill-down under its summary row, toggled by a chevron
 * button.
 */
function ArAgingDrilldownDemo() {
  const [open, setOpen] = useState(true);
  return (
    <div className="w-96 rounded-xl border border-border bg-surface-light p-3">
      <div className="flex items-center gap-3 py-1">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-background-light"
        >
          <ChevronRight className={open ? 'h-4 w-4 rotate-90 text-text-secondary transition-transform' : 'h-4 w-4 text-text-secondary transition-transform'} />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-primary">Acme Plumbing Co</p>
          <p className="truncate text-xs text-text-secondary">Commercial - 2 invoices</p>
        </div>
        <span className="w-24 text-right text-sm font-medium tabular-nums">$1,240</span>
      </div>
      <Collapse open={open} className="mb-2 ml-9">
        <div className="rounded-lg border border-border bg-background-light/40">
          <div className="flex items-center gap-3 px-3 py-2 text-sm">
            <span className="w-20 font-mono text-xs text-text-secondary">I00042</span>
            <span className="min-w-0 flex-1 truncate text-text-secondary">42 Main St</span>
            <span className="w-24 text-right tabular-nums">$740</span>
          </div>
          <div className="flex items-center gap-3 px-3 py-2 text-sm">
            <span className="w-20 font-mono text-xs text-text-secondary">I00051</span>
            <span className="min-w-0 flex-1 truncate text-text-secondary">17 Ocean Ave</span>
            <span className="w-24 text-right tabular-nums">$500</span>
          </div>
        </div>
      </Collapse>
    </div>
  );
}

export const ArAgingDrilldown: Story = {
  name: 'Real call site - ArAgingReport invoice drilldown',
  args: { open: true, children: null },
  render: () => <ArAgingDrilldownDemo />,
};
