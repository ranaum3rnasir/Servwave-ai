/* =============================================================================
   ListPageShell - Storybook stories, phase 12 composition-layer pass.

   ZERO APPEARANCE TOKENS IN THIS FILE. `DIR_CEILINGS['components/patterns']
   = 0`, and component-api-guard's `targetFiles()` does not exempt
   `.stories.tsx`. Content stand-ins below are `Card` / `Skeleton` /
   `EmptyState` primitives invoked with props, never hand-rolled surfaces.
   See .storybook/main.ts's header for the full asymmetry note.

   NEEDS A ROUTER, transitively: `header` renders through `PageHeader`, whose
   `back.to` uses a react-router `<Link>` and whose `breadcrumbs` render
   through `Breadcrumb`'s `useNavigate`. Wrapped once on `meta`, same shape
   breadcrumb.stories.tsx and PageHeader.stories.tsx use.

   THE FOUR STATE PROPS ARE DOCUMENTED HONESTLY, INCLUDING THEIR THIN DEMAND.
   ListPageShell's own header states it plainly: page-level demand for the
   loading/empty router is 1 file in 112, because on the five real list pages
   `DataTable` already owns both states internally. These stories therefore
   do NOT present `loading`/`empty` as the normal path - `Default` and
   `FullListPage` show the shape five of five measured pages actually ship,
   and the state stories exist to pin the PRECEDENCE, which is the part worth
   owning: `loading` beats `empty` beats `children`, always.

   THE FALL-THROUGH IS A STORY, NOT A FOOTNOTE. A flag set with its slot left
   empty renders `children` rather than blanking the region - so a
   half-wired call site degrades to today's list, never to an empty page.
   `LoadingWithoutSlot` pins that, because it is the behaviour most likely to
   be "fixed" by someone who assumes a missing slot should render nothing.

   NO DEFAULT PLACEHOLDER AND NO DEFAULT EMPTY STATE, deliberately: a default
   would have to invent a row height and a row count, and the 109 `Skeleton`
   tags in the tree have no mode worth adopting (the most common className is
   6 of 109). The stories supply their own, exactly as a call site must.
   ============================================================================= */
import type { Meta, StoryObj } from '@storybook/react';
import { MemoryRouter } from 'react-router-dom';
import { FileText } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Stack } from '@/components/ui/stack';
import { Text } from '@/components/ui/text';

import { ListPageShell } from './ListPageShell';

/** A stand-in for the page's real content region (a DataTable at every measured site). */
function ContentStandIn({ rows = 4 }: { rows?: number }) {
  return (
    <Card>
      <Stack gap={3}>
        {Array.from({ length: rows }, (_, i) => (
          <Text key={i} as="p" size="sm" tone="secondary">
            Invoice I{String(42 + i).padStart(5, '0')} - Northgate Medical
          </Text>
        ))}
      </Stack>
    </Card>
  );
}

/** A stand-in for the KpiStrip that occupies the `band` slot on 5 of 5 measured list pages. */
function BandStandIn() {
  return (
    <Stack direction="horizontal" gap={4} wrap>
      {['Outstanding', 'Overdue', 'Collected'].map((label) => (
        <Card key={label}>
          <Stack gap={1}>
            <Text size="xs" tone="secondary">
              {label}
            </Text>
            <Text size="3xl" weight="semibold">
              12
            </Text>
          </Stack>
        </Card>
      ))}
    </Stack>
  );
}

const meta = {
  title: 'Patterns/ListPageShell',
  component: ListPageShell,
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <MemoryRouter>
        <Story />
      </MemoryRouter>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          'The list-page skeleton: header, an optional band between the header and the content, and the content region - the exact three-band shape all five measured list pages (Customers, Estimates, Invoices, Jobs, Leads) already ship. `header` is typed as `PageHeaderProps` rather than a ReactNode slot, so there is no second copy of `title`/`icon`/`description` to drift out of sync, and "a list page has exactly one `h1`" becomes structural rather than conventional.',
      },
    },
  },
  argTypes: {
    header: {
      control: false,
      description:
        "PageHeader's own props. Omit it when a shell above already owns the `h1` - every page under `pages/settings/` and `pages/reports/` is in that position.",
    },
    band: {
      control: false,
      description:
        'The strip between header and content. A `KpiStrip` on all five measured list pages. Stays mounted through loading and empty, because a KpiStrip renders its own placeholders.',
    },
    loading: { control: 'boolean', description: 'Beats `empty`, always.' },
    loadingState: {
      control: false,
      description: 'What the content region shows while loading. No default - falls through to `children` if omitted.',
    },
    empty: { control: 'boolean', description: 'The list loaded and has nothing in it.' },
    emptyState: {
      control: false,
      description: 'What the content region shows when empty. Same fall-through rule as `loadingState`.',
    },
    gap: {
      control: { type: 'select' },
      options: [0, 1, 2, 3, 4, 6, 8],
      description:
        'Vertical rhythm between header, band and content. Defaults to 6 (24px), the `space-y-6` all five list pages use. Detail and form pages measure at 4.',
    },
    className: { control: false, description: 'LAYOUT only.' },
  },
} satisfies Meta<typeof ListPageShell>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Header plus content - the minimum shape. */
export const Default: Story = {
  args: {
    header: { title: 'Invoices' },
    children: <ContentStandIn />,
  },
};

/** With the `band` slot filled, which is what 5 of 5 measured list pages do. */
export const WithBand: Story = {
  args: {
    header: { title: 'Invoices', description: 'Every invoice raised against a job.' },
    band: <BandStandIn />,
    children: <ContentStandIn />,
  },
};

/**
 * `header` omitted - the position 12 of 13 `pages/settings/` files and 32 of
 * 34 `pages/reports/` files are in, where a shell above already owns the
 * page's only `<h1>`. Requiring a header would push all 44 into emitting a
 * second one.
 */
export const WithoutHeader: Story = {
  args: {
    band: <BandStandIn />,
    children: <ContentStandIn />,
  },
};

/** `loading` with a filled `loadingState` - the content region swaps, the band stays mounted. */
export const Loading: Story = {
  args: {
    header: { title: 'Invoices' },
    band: <BandStandIn />,
    loading: true,
    loadingState: (
      <Card>
        <Stack gap={3}>
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-2/3" />
        </Stack>
      </Card>
    ),
    children: <ContentStandIn />,
  },
};

/** `empty` with a filled `emptyState`. */
export const Empty: Story = {
  args: {
    header: { title: 'Invoices' },
    band: <BandStandIn />,
    empty: true,
    emptyState: (
      <EmptyState
        icon={FileText}
        title="No invoices yet"
        description="Invoices appear here once a job is completed and billed."
        action={<Button size="sm">New invoice</Button>}
        variant="card"
      />
    ),
    children: <ContentStandIn />,
  },
};

/**
 * Both flags set at once. `loading` wins - the inverse order is the classic
 * flash of "No invoices yet" over a list that is still arriving, and 51 of
 * the 60 files that render an EmptyState behind a length check have no
 * loading gate at all, so the tree is genuinely exposed to it.
 */
export const LoadingBeatsEmpty: Story = {
  args: {
    header: { title: 'Invoices' },
    loading: true,
    empty: true,
    loadingState: (
      <Card>
        <Stack gap={3}>
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
        </Stack>
      </Card>
    ),
    emptyState: <EmptyState icon={FileText} title="No invoices yet" variant="card" />,
    children: <ContentStandIn />,
  },
};

/**
 * `loading` set but `loadingState` omitted. The content region falls through
 * to `children` rather than blanking - a half-wired call site degrades to
 * today's list, never to an empty page. This is deliberate; do not "fix" it
 * into rendering nothing.
 */
export const LoadingWithoutSlot: Story = {
  args: {
    header: { title: 'Invoices' },
    loading: true,
    children: <ContentStandIn />,
  },
};

/**
 * `gap` at 4 rather than the default 6 - the rhythm the seven measured
 * detail and form pages use, so they can adopt the same shell without a
 * second component.
 */
export const DenserGap: Story = {
  args: {
    header: { title: 'Edit invoice' },
    band: <BandStandIn />,
    gap: 4,
    children: <ContentStandIn rows={3} />,
  },
};

/**
 * A realistic full list page - header with description and actions, a KPI
 * band, and the content region. This is the shape the five tracer list pages
 * converge on.
 */
export const FullListPage: Story = {
  args: {
    header: {
      title: 'Invoices',
      description: 'Every invoice raised against a job, and what has been collected against it.',
      actions: (
        <Stack direction="horizontal" gap={2} align="center">
          <Button variant="outline" size="sm">
            Export
          </Button>
          <Button size="sm">New invoice</Button>
        </Stack>
      ),
    },
    band: <BandStandIn />,
    children: <ContentStandIn rows={6} />,
  },
};
