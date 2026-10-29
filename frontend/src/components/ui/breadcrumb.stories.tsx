/* =============================================================================
   Breadcrumb - Storybook stories, full coverage pass.

   Storybook is already scaffolded in this worktree (`.storybook/`,
   `@storybook/react-vite` in package.json) - unlike the "new primitives"
   phase stories (Box, Alert, Chip, ...) which predate that scaffold and had
   to fall back to loose local `Meta`/`StoryObj`-shaped interfaces so 30-odd
   parallel agents would not race the same package.json. This file imports
   the real types directly, matching badge.stories.tsx / card.stories.tsx.

   WHY THERE IS NO `cva()` BLOCK TO PARSE HERE, AND NO variant/tone/size/
   gap/pad PROP ADDED.
   Breadcrumb is one of the 15 primitives the program plan's measured-state
   audit found with zero options at all (section 1h: "badge, breadcrumb,
   calendar, ..."). It stays that way after phase 8: the per-primitive add
   list (8a Input/Textarea/Select, 8b Label, 8c the overlay cluster, 8d the
   Tabs cluster, 8e Avatar, 8f Skeleton, 8g Calendar/Separator/Checkbox/
   Switch/Badge) never names Breadcrumb, and phase 9's new-primitive list
   doesn't either - it already exists and nobody measured new demand on it.
   The real call sites confirm the audit: all 7 (PageHeader.tsx,
   LeadDetailPage.tsx, StatementPage.tsx x2, CustomerDetailPage.tsx,
   StandaloneInvoiceFormPage.tsx, InvoiceDetailPage.tsx, JobDetailPage.tsx)
   pass only `items` and, sometimes, `showBack` - never an extra className,
   never a size/tone/variant-shaped signature. Per this session's rule (a
   primitive with no measured demand gets left alone, no prop invented
   because it "would be nice"), breadcrumb.tsx is untouched. This file's
   completeness target is instead Breadcrumb's actual, current prop surface
   - `items` (BreadcrumbItem[]) and `showBack` (boolean) - covered below in
   every shape the component branches on, not just the default.

   Needs a Router context: Breadcrumb renders a real react-router `<Link>`
   for every non-last, `href`-bearing crumb and calls `useNavigate()` for
   the back button. Wrapped once via a `decorators` entry on `meta` so every
   story - including the args-driven `Default`, which the Controls panel
   re-renders live - gets it for free.
   ============================================================================= */
import type { Meta, StoryObj } from '@storybook/react';
import { MemoryRouter } from 'react-router-dom';

import { Breadcrumb, type BreadcrumbItem } from './breadcrumb';

const meta: Meta<typeof Breadcrumb> = {
  title: 'UI/Breadcrumb',
  component: Breadcrumb,
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <MemoryRouter>
        <Story />
      </MemoryRouter>
    ),
  ],
  argTypes: {
    items: {
      control: 'object',
      description:
        'Ordered crumb list. The last entry always renders as the current page (bold, plain text, never a link) even if it carries an href; every earlier entry renders as a link only if it carries an href.',
    },
    showBack: {
      control: 'boolean',
      description:
        'Shows the leading back-arrow button that calls navigate(-1). Defaults to true - every real call site except PageHeader\'s (which passes showBack={false} to avoid a second back affordance next to its own) relies on that default.',
    },
  },
};

export default meta;

type Story = StoryObj<typeof Breadcrumb>;

/**
 * The dominant real shape (CustomerDetailPage, StatementPage, InvoiceDetailPage):
 * one linked ancestor, one unlinked current page, back button shown via the
 * component's own default. Args-driven so the Controls panel below can flip
 * `items` and `showBack` live.
 */
export const Default: Story = {
  args: {
    items: [
      { label: 'Customers', href: '/customers' },
      { label: 'Acme Plumbing' },
    ],
  },
};

/**
 * `showBack={false}` - the PageHeader.tsx call shape, used when a breadcrumb
 * sits inside a header that already renders its own back nav.
 */
export const WithoutBackButton: Story = {
  args: {
    items: [
      { label: 'Invoices', href: '/invoices' },
      { label: 'INV-1024' },
    ],
    showBack: false,
  },
};

/**
 * A single crumb - just the current page, no ancestors. No chevron renders
 * (the `i > 0` check has nothing before it to separate from), and the back
 * button still shows via the default.
 */
export const SingleCrumb: Story = {
  args: {
    items: [{ label: 'Dashboard' }],
  },
};

/**
 * Three levels (the JobDetailPage/LeadDetailPage shape: incoming breadcrumbs
 * plus one appended detail crumb) - proves the chevron separator repeats
 * correctly past the first pair.
 */
export const DeepPath: Story = {
  args: {
    items: [
      { label: 'Jobs', href: '/jobs' },
      { label: 'Acme Plumbing', href: '/customers/1' },
      { label: 'J00042' },
    ],
  },
};

/**
 * A middle crumb with no `href` - renders as plain muted text, not a link,
 * even though it is not the last item. Exercises the `!item.href` half of
 * the `isLast || !item.href` branch on its own, separately from `isLast`.
 */
export const MiddleCrumbWithoutHref: Story = {
  render: () => (
    <Breadcrumb
      items={[
        { label: 'Leads', href: '/leads' },
        { label: 'Unassigned' },
        { label: 'Lead #482' },
      ]}
    />
  ),
};

/**
 * The last crumb carries an `href` too - and still renders as plain bold
 * text, never a link. `isLast` short-circuits `isLast || !item.href`
 * regardless of whether `href` is present, which this story makes visible:
 * `href: '/jobs/482'` is passed on "J00482" and never becomes a link.
 */
export const LastItemHrefIsIgnored: Story = {
  render: () => (
    <Breadcrumb
      items={
        [
          { label: 'Jobs', href: '/jobs' },
          { label: 'J00482', href: '/jobs/482' },
        ] satisfies BreadcrumbItem[]
      }
    />
  ),
};
