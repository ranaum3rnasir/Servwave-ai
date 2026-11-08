/* =============================================================================
   PageHeader - Storybook stories, phase 12 composition-layer pass.

   ZERO APPEARANCE TOKENS IN THIS FILE. `DIR_CEILINGS['components/patterns']
   = 0`, and component-api-guard's `targetFiles()` does not exempt
   `.stories.tsx`. Icons below carry `h-4 w-4`-shaped sizing only, which
   classifies LAYOUT; no colour, radius, border, shadow or padding class is
   authored anywhere here. See .storybook/main.ts's header for the full note.

   NEEDS A ROUTER. `back.to` renders a real react-router `<Link>`, and
   `breadcrumbs` renders through the `Breadcrumb` primitive, which itself
   calls `useNavigate`. Wrapped once via a `decorators` entry on `meta` so
   every story gets it - the same shape breadcrumb.stories.tsx already
   established, rather than a second convention.

   WHAT THESE STORIES DELIBERATELY DO NOT SHOW. PageHeader has no `scale` /
   `weight` / `tone` passthrough, and that absence is the design. Its own
   header records 13 distinct `<h1>` signatures across 36 measured sites and
   states that forwarding Heading's axes would "cover" 9 more of them by
   reproducing the drift in prop form - which is the defect, not the fix. The
   10 entity-hero and public-document sites are a SECOND pattern awaiting its
   own measurement. So there is no `AllSizes` story here on purpose: minting
   a size ladder with no measured demand is what this program exists to
   remove.

   SLOT COVERAGE MIRRORS THE MEASURED DEMAND in PageHeader's own header
   (36 `<h1>` tags): leading icon 12, description 15, actions 15, breadcrumb
   6 pages, hand-rolled back nav 8 pages, none-of-the-three 5. Every one of
   those has a story below, including the bare title.
   ============================================================================= */
import type { Meta, StoryObj } from '@storybook/react';
import { MemoryRouter } from 'react-router-dom';
import { Receipt } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Stack } from '@/components/ui/stack';

import { PageHeader } from './PageHeader';

const meta = {
  title: 'Patterns/PageHeader',
  component: PageHeader,
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
          "The page's single `h1` plus its optional leading icon, description, breadcrumb trail, back navigation and actions row. Authors no appearance class of its own - the description renders through `Text as=\"p\" size=\"sm\" tone=\"secondary\"`, which emits byte-identical output to the hand-rolled paragraph it replaces.",
      },
    },
  },
  argTypes: {
    title: { control: 'text', description: "The page title. Rendered as the page's only `h1` element." },
    icon: {
      control: false,
      description:
        'Leading icon, rendered as a sibling of the `h1` inside the same row. Sized by the call site - PageHeader does not decide how big an icon is.',
    },
    description: { control: 'text', description: 'One line of supporting copy under the title.' },
    breadcrumbs: {
      control: false,
      description:
        'Crumb trail above the header, rendered through `Breadcrumb` with `showBack={false}` so the back affordance lives in exactly one place - the `back` prop.',
    },
    back: {
      control: false,
      description:
        'Back navigation. `to` renders a real link (middle-click and open-in-new-tab keep working); `onClick` renders a button, for the `navigate(-1)` shape.',
    },
    actions: { control: false, description: 'Right-aligned actions. Buttons, a menu, a filter control.' },
    className: { control: false, description: 'LAYOUT only. Where the header sits, never what it looks like.' },
  },
} satisfies Meta<typeof PageHeader>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Title only - the bare shape, and the single most common one: 10 of the 36
 * measured `<h1>` sites are exactly this, byte-identical to `Heading`'s own
 * default.
 */
export const Default: Story = {
  args: { title: 'Invoices' },
};

/**
 * `icon` moves the glyph from inside the `<h1>` to a sibling in the same
 * `flex items-center gap-2` row - identical box model, and an `<svg>` with
 * no accessible name contributed nothing to the heading's name either way.
 * 8 measured sites.
 */
export const WithIcon: Story = {
  args: {
    title: 'Invoice I00042',
    icon: <Receipt className="h-5 w-5 shrink-0" aria-hidden />,
  },
};

/** `description` renders through `Text`, at the signature 14 of the 15 measured descriptions already use. */
export const WithDescription: Story = {
  args: {
    title: 'Invoices',
    description: 'Every invoice raised against a job, and what has been collected against it.',
  },
};

/** `actions` sits right-aligned on the same row. 15 measured sites carry one. */
export const WithActions: Story = {
  args: {
    title: 'Invoices',
    actions: (
      <Stack direction="horizontal" gap={2} align="center">
        <Button variant="outline" size="sm">
          Export
        </Button>
        <Button size="sm">New invoice</Button>
      </Stack>
    ),
  },
};

/**
 * `back.to` renders a real `<Link>`, so right-click, middle-click and
 * open-in-new-tab all keep working. 5 of the 10 measured hand-rolled back
 * affordances link to a fixed parent route.
 */
export const WithBackLink: Story = {
  args: {
    title: 'Invoice I00042',
    back: { to: '/invoices', label: 'Back to Invoices' },
  },
};

/**
 * `back.onClick` renders a button instead - the `navigate(-1)` shape, which
 * 4 of the 10 measured sites use. `label` defaults to "Back".
 */
export const WithBackButton: Story = {
  args: {
    title: 'Invoice I00042',
    back: { onClick: () => {} },
  },
};

/**
 * `breadcrumbs` renders above the header with `showBack={false}`, so the
 * crumb trail and the `back` prop never both offer a back affordance.
 */
export const WithBreadcrumbs: Story = {
  args: {
    title: 'Invoice I00042',
    breadcrumbs: [
      { label: 'Invoices', href: '/invoices' },
      { label: 'I00042' },
    ],
  },
};

/**
 * Description present, so the actions row aligns to `start` rather than
 * `center` - which is what the measured containers do
 * (`DashboardPage` has a description and uses `items-start`;
 * `ServicePlansPage` has none and uses `items-center`).
 */
export const DescriptionAndActionsAlignment: Story = {
  args: {
    title: 'Service plans',
    description: 'Recurring maintenance agreements and the visits they generate.',
    actions: <Button size="sm">New plan</Button>,
  },
};

/** Every slot at once - breadcrumbs, back, icon, description and actions. */
export const AllSlots: Story = {
  args: {
    title: 'Invoice I00042',
    icon: <Receipt className="h-5 w-5 shrink-0" aria-hidden />,
    description: 'Issued 14 Jul 2026 - due 28 Jul 2026.',
    breadcrumbs: [{ label: 'Invoices', href: '/invoices' }, { label: 'I00042' }],
    back: { to: '/invoices', label: 'Back to Invoices' },
    actions: (
      <Stack direction="horizontal" gap={2} align="center">
        <Button variant="outline" size="sm">
          Send
        </Button>
        <Button size="sm">Record payment</Button>
      </Stack>
    ),
  },
};

/**
 * A long title with actions, to show the wrap behaviour. The outer row uses
 * `wrap` rather than a responsive `flex-col sm:flex-row` - `Stack` has no
 * responsive props by design.
 */
export const LongTitle: Story = {
  args: {
    title: 'Quarterly preventative maintenance agreement - Northgate Medical Campus, buildings A through F',
    description: 'Renews 1 Oct 2026.',
    actions: <Button size="sm">Edit plan</Button>,
  },
};
