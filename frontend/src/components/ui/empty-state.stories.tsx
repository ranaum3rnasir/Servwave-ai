/* =============================================================================
   EmptyState - Storybook stories, full coverage pass (Storybook phase, W2 plan).

   Storybook is already scaffolded in this worktree (`.storybook/`,
   `@storybook/react-vite` in package.json), so this file imports the real
   `Meta` / `StoryObj` types from `@storybook/react` and wires `argTypes` so
   every axis is a live control in the Storybook UI - matching badge.stories.tsx
   / card.stories.tsx, the two other Storybook-phase full-coverage passes.

   WHY THERE IS NO `cva()` BLOCK TO PARSE HERE.
   empty-state.tsx does not use `cva()` - its spacing axis is a plain object
   map (`EMPTY_STATE_PAD`; the deprecated `density` prop is only a string
   union type, resolved into a `padY` step via `DENSITY_TO_PAD`), because
   `variant="card"` and `padY` have to stay strictly orthogonal (card owns
   border/radius/surface/px-6 only, never vertical padding - see empty-state.tsx's
   own `padY` doc comment), which a single cva `variants` map cannot express as
   cleanly as two named constants resolved by hand. So this file's completeness
   target is the real prop surface empty-state.tsx exports and branches on, not
   a cva object:
     - `variant` - 2 values: `bare` (no chrome, the 104-site implicit default),
       `card` (bordered chrome for a standalone page state).
     - `padY` - the 4-step numeric scale (`0`/`6`/`12`/`24`, a 4px-grid step
       number per the settled vocabulary - not a size word), `12` the default
       and byte-identical to every pre-existing call site that passes
       nothing.
     - `density` (deprecated) - the 4-word legacy alias this session's `padY`
       retires: `flush`/`compact`/`default`/`roomy`, mapping onto
       `0`/`6`/`12`/`24`. Kept working so the ~28 existing call sites do not
       have to move (empty-state.tsx's own doc comment).
   Every value in every one of those three props gets its own rendered
   EmptyState below, not just the default. `icon`, `title`, `description` and
   `action` are also real, shipped props - not part of the variant surface, but
   a designer flipping controls needs to see them, so they are wired into
   `argTypes` and exercised across the stories below the same way Badge's
   `intent` is (see badge.stories.tsx's own header note on that same shape).
   ============================================================================= */
import type { Meta, StoryObj } from '@storybook/react';
import { Inbox, Truck } from 'lucide-react';

import { EmptyState } from './empty-state';
import { Button } from './button';

const VARIANTS = ['bare', 'card'] as const;
const PAD_YS = [0, 6, 12, 24] as const;
const DENSITIES = ['flush', 'compact', 'default', 'roomy'] as const;

const meta = {
  title: 'UI/EmptyState',
  component: EmptyState,
  tags: ['autodocs'],
  // `title` is EmptyState's one required prop. Setting a meta-level default
  // satisfies it for every story below, including the `render`-only ones
  // (PadSteps, LegacyDensity) that render several EmptyStates at once and so
  // have no single `title` of their own to bind a control to.
  args: {
    title: 'No items yet',
  },
  argTypes: {
    variant: {
      control: { type: 'select' },
      options: VARIANTS,
      description:
        '`bare` (default) has no chrome of its own - drop it inside any container. `card` adds bordered chrome for a standalone empty page state.',
    },
    padY: {
      control: { type: 'select' },
      options: PAD_YS,
      description:
        'Vertical padding, a 4px-grid numeric step from the shared spacing scale - not a size word. Orthogonal to `variant` - `variant="card"` never owns vertical padding. Default `12` (py-12), byte-identical to the implicit default before this prop existed.',
    },
    density: {
      control: { type: 'select' },
      options: DENSITIES,
      description:
        'Deprecated - use `padY`: flush -> 0, compact -> 6, default -> 12, roomy -> 24. Same pixels. Ignored when `padY` is also passed.',
    },
    icon: { control: false, description: 'Optional leading icon, a lucide-react component.' },
    title: { control: 'text' },
    description: { control: 'text' },
    action: { control: false, description: 'Optional call-to-action rendered below the copy.' },
    className: { control: false, description: 'Layout-only pass-through (width/margin).' },
  },
} satisfies Meta<typeof EmptyState>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * `variant="bare"`, `padY={12}` - empty-state.tsx's own defaults, set
 * explicitly so the literal values are present in this file even though they
 * are what an EmptyState with no props renders. Args-driven so the Controls
 * panel can flip `variant` / `padY` / `density` live.
 */
export const Default: Story = {
  args: {
    variant: 'bare',
    padY: 12,
    title: 'No leads yet',
  },
};

/** `description` - the secondary copy line under the title. */
export const WithDescription: Story = {
  args: {
    title: 'No leads yet',
    description: 'New leads will appear here once a customer submits a request.',
  },
};

/** `icon` - a leading lucide-react icon above the title. */
export const WithIcon: Story = {
  args: {
    icon: Inbox,
    title: 'No leads yet',
    description: 'New leads will appear here once a customer submits a request.',
  },
};

/** `action` - a call-to-action rendered below the copy. */
export const WithAction: Story = {
  args: {
    icon: Inbox,
    title: 'No leads yet',
    description: 'New leads will appear here once a customer submits a request.',
    action: <Button size="sm">Create lead</Button>,
  },
};

/**
 * `variant="card"` - bordered chrome for a standalone empty page state, the
 * shape the v1 `VendorsPage` shipped (`icon={Truck}`; page since deleted, PRD-1).
 */
export const CardVariant: Story = {
  args: {
    variant: 'card',
    icon: Truck,
    title: 'No vendors match your filters.',
    action: <Button size="sm">Clear filters</Button>,
  },
};

/**
 * Every step on the `padY` scale, on `variant="card"` so the bordered chrome
 * makes each step's vertical space visible. `12` is the default (identical
 * pixels to a propless, bare EmptyState).
 */
export const PadSteps: Story = {
  render: () => (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {PAD_YS.map((padY) => (
        <EmptyState key={padY} variant="card" padY={padY} title={`padY={${padY}}`} />
      ))}
    </div>
  ),
};

/**
 * The deprecated `density` word scale - kept only so the ~28 pre-existing
 * call sites (`flush` x12, `compact` x14, `roomy` x2) do not have to move
 * this session. Each renders the identical pixels its `padY` step equivalent
 * does above.
 */
export const LegacyDensity: Story = {
  render: () => (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <EmptyState variant="card" density="flush" title='density="flush" (padY={0})' />
      <EmptyState variant="card" density="compact" title='density="compact" (padY={6})' />
      <EmptyState variant="card" density="default" title='density="default" (padY={12})' />
      <EmptyState variant="card" density="roomy" title='density="roomy" (padY={24})' />
    </div>
  ),
};

/** `padY` overrides `density` when both are passed - empty-state.tsx's own resolution order. */
export const PadOverridesDensity: Story = {
  args: {
    variant: 'card',
    density: 'roomy',
    padY: 0,
    title: 'density="roomy" padY={0} -> renders padY={0}',
  },
};
