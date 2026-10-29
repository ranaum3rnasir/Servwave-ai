/* =============================================================================
   ActionLink - Storybook stories, full-coverage pass (Storybook phase, W2 plan).

   ActionLink's first pass (this file, before this edit) predates Storybook
   being scaffolded in this worktree - see badge.stories.tsx's header note
   for why that first pass used a loose local `StoryDef` shape instead of the
   real `@storybook/react` types. Storybook is now wired (.storybook/main.ts,
   .storybook/preview.ts, the @storybook/react-vite devDependency), so this
   file imports the real `Meta` / `StoryObj` types and wires `argTypes` so
   `variant` is a live control in the Storybook UI, matching
   chip.stories.tsx / thumbnail.stories.tsx.

   Coverage requirement (the completeness pass this phase adds): every
   variant KEY and every VALUE in action-link.tsx's cva() block needs at
   least one story that actually renders it.

     variant: link | outline -> Link and Outline each set it explicitly, and
       the Variants story renders both side by side.

   ActionLink has no `tone`, `size`, `gap`, or `pad` axis - action-link.tsx's
   own header explains why each was left unminted (every measured site
   resolves to the same brand colour, no clean per-variant sizing signal
   exists, and the one minted multi-token cell bakes its spacing into one
   atomic geometry). There is no cva() entry for any of them, so nothing
   here invents a control for them.

   `asChild` is a real, shipped prop (the Slot polymorphism path that lets
   ActionLink wrap a react-router `<Link>` or a bare `<button>`) but it is
   NOT part of the cva() block (action-link.tsx has no `variants.asChild`
   entry). It is outside what the completeness pass checks, but a designer
   flipping controls needs to see it, so it is wired as a boolean control
   below (same treatment link.stories.tsx gives TextLink's own `asChild`)
   and covered by its own AsRouterLink / AsButton stories.
   ============================================================================= */
import type { Meta, StoryObj } from '@storybook/react';
import { MemoryRouter, Link } from 'react-router-dom';

import { ActionLink } from './action-link';

const VARIANTS = ['link', 'outline'] as const;

const meta = {
  title: 'UI/ActionLink',
  component: ActionLink,
  tags: ['autodocs'],
  args: {
    children: 'View vendor',
    href: '/vendors/1',
  },
  argTypes: {
    variant: {
      control: { type: 'select' },
      options: VARIANTS,
      description:
        '`link` (the default) is Button\'s own frozen `link/brand` cell on a real anchor. `outline` is a bordered CTA pill, minted from VendorDetailDialog.tsx\'s "Email Vendor" mailto: link.',
    },
    asChild: {
      control: 'boolean',
      description:
        'Render the child element instead of an <a>, forwarding ActionLink\'s classes and ref onto it via Radix Slot. This is how one primitive wraps a react-router <Link to="...">, a bare <a href="mailto:...">, or a <button> for a JS-driven action with no real destination.',
    },
    href: {
      control: 'text',
      description: 'Native anchor href, forwarded straight through when asChild is not set.',
    },
    className: { control: false },
  },
} satisfies Meta<typeof ActionLink>;

export default meta;

type Story = StoryObj<typeof meta>;

/** `variant="link"` - action-link.tsx's own `defaultVariants`, set explicitly. Byte-identical to Button's `link/brand` cell on a real `<a>`. */
export const Default: Story = {
  args: {
    variant: 'link',
  },
};

/** `variant="link"` alone, named to match the axis value directly. */
export const Link_: Story = {
  name: 'Link',
  args: {
    variant: 'link',
    children: 'View vendor',
  },
};

/** `variant="outline"` - the bordered CTA pill, reproducing VendorDetailDialog.tsx:302-308. */
export const Outline: Story = {
  args: {
    variant: 'outline',
    href: 'mailto:vendor@example.test',
    children: 'Email Vendor',
  },
};

/** Every implemented `variant` value, side by side. */
export const Variants: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-4">
      <ActionLink variant="link" href="/vendors/1">
        View vendor
      </ActionLink>
      <ActionLink variant="outline" href="mailto:vendor@example.test">
        Email vendor
      </ActionLink>
    </div>
  ),
};

/** `asChild`, wrapping a react-router `<Link>` - the dominant real call shape. */
export const AsRouterLink: Story = {
  render: () => (
    <MemoryRouter>
      <ActionLink asChild variant="outline">
        <Link to="/vendors/1">Email vendor</Link>
      </ActionLink>
    </MemoryRouter>
  ),
};

/**
 * `asChild`, wrapping a bare `<button>` - the third render target the
 * phase-9 evidence names, for a "link" with no real destination that
 * performs a JS action instead.
 */
export const AsButton: Story = {
  render: () => (
    <ActionLink asChild variant="link">
      <button type="button" onClick={() => {}}>
        Load more
      </button>
    </ActionLink>
  ),
};
