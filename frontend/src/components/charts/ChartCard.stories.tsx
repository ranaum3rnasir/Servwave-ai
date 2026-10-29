/* =============================================================================
   ChartCard - Storybook stories, phase 12a chart-primitive pass.

   ChartCard is the shared shell every chart primitive under components/charts
   sits inside: the white surface, small rounded corners, a border and a soft
   card shadow, with an optional header row above the body. It owns exactly
   one decision about that header: `hasHeader` is `title != null || subtitle
   != null || action != null || select != null`, so a caller that sets none of
   those four props gets no header row at all, not an empty one. `NoHeader`
   below pins that as its own story rather than folding it into `Default`,
   because it is a distinct render branch, not "Default minus a prop".

   `action` OVERRIDES `select` WHEN BOTH ARE SET. The component itself reads
   `action ?? (select ? <ChartCardSelect ... /> : null)`, so `select` is only
   ever consulted when `action` is nullish. `WithSelect` and `WithAction` are
   two separate stories rather than one story toggling between them, because
   that branch only shows up when each prop is exercised alone.

   `WithSelect` NEEDS REAL STATE. The select's `onChange` is a plain
   controlled callback with no value tracking of its own, so a story with a
   dropdown that actually responds to a click - not just a static snapshot of
   one open value - needs a paired value/onChange backed by a hook. A hook
   cannot live inside an anonymous arrow passed to a story's `render` key
   (Storybook renders that arrow as a component, but the linter does not see
   it as one), so it lives in the small named `ChartCardSelectDemo` component
   below instead.

   `flush` IS QUOTED VERBATIM FROM ITS OWN PROP DOC: "Remove the inner
   padding, for a chart that should bleed to the card edge." Structurally, it
   also drops the automatic top gap the header and body otherwise get between
   them, since that gap is only ever added when a header is present AND the
   card is not flush. `Flush` demonstrates it against a header plus a wide
   filler block - the shape `flush` exists for, a chart that needs to run out
   toward the card's own border underneath its title/select row.

   BODY CONTENT IS A PLACEHOLDER ON PURPOSE. This file documents ChartCard's
   OWN contract - the shell, the header branch, the padding behaviour - not
   the ten chart primitives that sit inside it, so every story below fills
   `children` with `Skeleton` rather than a real chart.
   ============================================================================= */
import * as React from 'react';
import type { Meta, StoryObj } from '@storybook/react';

import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Stack } from '@/components/ui/stack';
import { Text } from '@/components/ui/text';

import { ChartCard, type ChartCardSelectOption } from './ChartCard';

const RANGE_OPTIONS: ChartCardSelectOption[] = [
  { label: 'This month', value: 'month' },
  { label: 'This quarter', value: 'quarter' },
  { label: 'This year', value: 'year' },
];

/**
 * Backs the `select` story with a real, working value/onChange pair - a hook
 * cannot live inside an anonymous `render` arrow, see the header note.
 */
function ChartCardSelectDemo() {
  const [range, setRange] = React.useState('month');
  return (
    <ChartCard
      title="Revenue"
      select={{
        value: range,
        options: RANGE_OPTIONS,
        onChange: setRange,
        'aria-label': 'Revenue range',
      }}
    >
      <Skeleton className="h-48 w-full" />
    </ChartCard>
  );
}

const meta = {
  title: 'Charts/ChartCard',
  component: ChartCard,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'The shared surface every chart primitive sits inside. Renders a header row only when at least one of `title`, `subtitle`, `select`, or `action` is set; `action` overrides `select` when both are given.',
      },
    },
  },
  argTypes: {
    title: {
      control: 'text',
      description:
        'Card heading. Omit it, along with `subtitle`, `select`, and `action`, for a chrome-less container - no header row renders at all.',
    },
    subtitle: {
      control: 'text',
      description: 'Secondary muted line under the title.',
    },
    select: {
      control: false,
      description:
        'Optional right-aligned select control: `{ value, options, onChange, "aria-label"? }`. Ignored whenever `action` is also set.',
    },
    action: {
      control: false,
      description: 'Arbitrary right-aligned header content. Overrides `select` when both are given.',
    },
    flush: {
      control: 'boolean',
      description: 'Remove the inner padding, for a chart that should bleed to the card edge. Defaults to false.',
    },
    className: {
      control: false,
      description: 'Extra classes merged onto the outer card.',
    },
    children: {
      control: false,
      description: 'Body content - typically a chart primitive. Required.',
    },
  },
} satisfies Meta<typeof ChartCard>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Title only, with no subtitle, select, or action - the minimum header. */
export const Default: Story = {
  args: {
    title: 'Revenue by month',
    children: <Skeleton className="h-48 w-full" />,
  },
};

/** `subtitle` renders as a muted line directly under the title. */
export const WithSubtitle: Story = {
  args: {
    title: 'Revenue by month',
    subtitle: 'Last 12 months, paid invoices only',
    children: <Skeleton className="h-48 w-full" />,
  },
};

/** `select` renders a working dropdown, wired to real component state. */
export const WithSelect: Story = {
  args: { children: <Skeleton className="h-48 w-full" /> },
  render: () => <ChartCardSelectDemo />,
};

/** `action` is an arbitrary node in the same slot, and overrides `select` when both are set. */
export const WithAction: Story = {
  args: {
    title: 'Job status mix',
    action: (
      <Stack direction="horizontal" gap={2} align="center">
        <Text size="xs" tone="secondary">
          Live
        </Text>
        <Badge tone="success">Synced</Badge>
      </Stack>
    ),
    children: <Skeleton className="h-48 w-full" />,
  },
};

/**
 * `flush` swaps the card's own outer padding for none and drops the
 * automatic gap between the header and body, so the filler block can run
 * out toward the card's own edges underneath the title.
 */
export const Flush: Story = {
  args: {
    title: 'Jobs completed',
    subtitle: 'Daily, last 30 days',
    flush: true,
    children: <Skeleton className="h-40 w-full" />,
  },
};

/**
 * No `title`, `subtitle`, `select`, or `action` - `hasHeader` is false and no
 * header row renders at all, a distinct code path rather than an empty one.
 */
export const NoHeader: Story = {
  args: {
    children: <Skeleton className="h-48 w-full" />,
  },
};
