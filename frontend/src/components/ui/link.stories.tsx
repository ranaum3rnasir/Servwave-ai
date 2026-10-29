/* =============================================================================
   TextLink - Storybook stories, full-coverage pass (Storybook phase, W2 plan).

   Storybook 8 is scaffolded now (.storybook/main.ts, .storybook/preview.ts,
   the @storybook/react-vite devDependency in package.json) - this file
   imports the real `Meta` / `StoryObj` types from `@storybook/react` and
   wires `argTypes` so every axis is a live control in the Storybook UI, the
   same convention alert.stories.tsx / badge.stories.tsx / text.stories.tsx
   already use.

   Coverage requirement (the completeness pass this phase adds): every
   variant KEY and every VALUE in link.tsx's cva() block needs at least one
   story that actually renders it.

     size      xs                        -> Sizes renders it explicitly;
       AllAxesCombined and RealSignatures render it again.
     weight    medium                    -> Weights renders it explicitly;
       AllAxesCombined and RealSignatures render it again.
     tone      brand                     -> IdleColor renders it explicitly;
       AllAxesCombined and RealSignatures render it again.
     hoverTone brand                     -> HoverColor renders it explicitly;
       AllAxesCombined and RealSignatures render it again.
     underline hover | none              -> Default renders `hover`
       explicitly (link.tsx's own `defaultVariants`); UnderlineNone renders
       `none`. AllAxesCombined renders `none` again.

   `asChild` is a real, shipped prop - the Slot polymorphism path that lets
   TextLink wrap a react-router `<Link>` or a bare `<a href="tel:...">` - but
   it is NOT part of the cva() block (link.tsx has no `variants.asChild`
   entry). It is outside what the completeness pass checks, but a designer
   flipping controls needs to see it, so it is wired as a boolean control
   below (same treatment button.stories.tsx gives its own `asChild`) and
   covered by its own AsRouterLink / AsTelAnchor stories plus every site in
   RealSignatures.
   ============================================================================= */
import type { Meta, StoryObj } from '@storybook/react';
import { MemoryRouter, Link } from 'react-router-dom';

import { TextLink } from './link';

const SIZES = ['xs'] as const;
const WEIGHTS = ['medium'] as const;
const TONES = ['brand'] as const;
const HOVER_TONES = ['brand'] as const;
const UNDERLINES = ['hover', 'none'] as const;

const meta = {
  title: 'UI/TextLink',
  component: TextLink,
  tags: ['autodocs'],
  args: {
    children: 'View job',
    href: '#',
  },
  argTypes: {
    size: {
      control: { type: 'select' },
      options: [undefined, ...SIZES],
      description:
        'Font size. No default - omit it and the link inherits from its container, which is what 7 of the 8 measured call sites do. `xs` is the one site that sets its own (the chip on InvoiceDetailPage:1093).',
    },
    weight: {
      control: { type: 'select' },
      options: [undefined, ...WEIGHTS],
      description: 'Font weight. No default. `medium` is the only measured value, x3.',
    },
    tone: {
      control: { type: 'select' },
      options: [undefined, ...TONES],
      description:
        'IDLE colour, no default. Omit it for a link that inherits its colour and only shows a colour on hover - see `hoverTone`.',
    },
    hoverTone: {
      control: { type: 'select' },
      options: [undefined, ...HOVER_TONES],
      description:
        'HOVER colour, independent of `tone`. Two separate props because the measured residue contains both shapes: sites with an idle colour and no hover colour, and sites (the tel:/mailto: anchors) with a hover colour and no idle colour.',
    },
    underline: {
      control: { type: 'select' },
      options: UNDERLINES,
      description:
        '`hover` (the default) underlines only on hover - every running-text site carries it. `none` suppresses underlining outright and REPLACES the default rather than sitting beside it - the chip at InvoiceDetailPage:1093.',
    },
    asChild: {
      control: 'boolean',
      description:
        'Render the child element instead of an <a>, forwarding TextLink\'s classes onto it via Radix Slot. This is how one primitive wraps a react-router <Link to="..."> or a bare <a href="tel:...">/<a href="mailto:...">.',
    },
    href: {
      control: 'text',
      description: 'Native anchor href, forwarded straight through when asChild is not set.',
    },
    className: { control: false },
  },
} satisfies Meta<typeof TextLink>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Propless except `underline="hover"` - link.tsx's own `defaultVariants`, set
 * explicitly. Renders `class="hover:underline"` and nothing else: no idle
 * colour, no size, no weight of its own. Wrapping any existing inline copy
 * in a bare TextLink cannot repaint it, which is the property the whole
 * conversion depends on.
 */
export const Default: Story = {
  args: {
    underline: 'hover',
  },
};

/** `size="xs"` - the only implemented rung, the chip at InvoiceDetailPage:1093. */
export const Sizes: Story = {
  render: () => (
    <div className="flex flex-col gap-1">
      <TextLink href="#" size="xs">
        size=xs
      </TextLink>
    </div>
  ),
};

/** `weight="medium"` - the only implemented value, measured x3. */
export const Weights: Story = {
  render: () => (
    <div className="flex flex-col gap-1">
      <TextLink href="#" weight="medium">
        weight=medium
      </TextLink>
    </div>
  ),
};

/**
 * `tone="brand"` - the IDLE colour axis. The only implemented value; every
 * measured site that sets an idle colour at all sets this one.
 */
export const IdleColor: Story = {
  render: () => (
    <TextLink href="#" tone="brand">
      tone=brand (idle colour)
    </TextLink>
  ),
};

/**
 * `hoverTone="brand"` alone, with no `tone` - the tel:/mailto: shape at
 * InvoiceDetailPage:708/717, which inherits its idle colour and paints the
 * brand colour only on hover.
 */
export const HoverColor: Story = {
  render: () => (
    <TextLink href="#" hoverTone="brand">
      hoverTone=brand (paints only on hover, no idle colour)
    </TextLink>
  ),
};

/**
 * `underline="none"` - REPLACES the `hover` default rather than sitting
 * beside it, so the chip at InvoiceDetailPage:1093 never carries a stray
 * hover underline rule.
 */
export const UnderlineNone: Story = {
  args: {
    underline: 'none',
    size: 'xs',
    weight: 'medium',
  },
};

/**
 * `asChild`, wrapping a react-router `<Link>` - the dominant real call
 * shape (InvoicesPage:649, InvoiceDetailPage:698/739/755/1093).
 */
export const AsRouterLink: Story = {
  render: () => (
    <MemoryRouter>
      <TextLink asChild tone="brand" weight="medium">
        <Link to="/jobs/1">J00001</Link>
      </TextLink>
    </MemoryRouter>
  ),
};

/**
 * `asChild`, wrapping a bare `<a href="tel:...">` - the other polymorphism
 * path, no router involved. Idle colour inherits from the surrounding text;
 * only the hover colour is TextLink's.
 */
export const AsTelAnchor: Story = {
  render: () => (
    <TextLink asChild hoverTone="brand">
      <a href="tel:+15125550100">(512) 555-0100</a>
    </TextLink>
  ),
};

/**
 * Every axis set at once, all non-default values together - the same
 * combination link.test.tsx's hygiene sweep exercises, so this story alone
 * touches `size`, `weight`, `tone`, `hoverTone` and `underline="none"` in one
 * render.
 */
export const AllAxesCombined: Story = {
  args: {
    size: 'xs',
    weight: 'medium',
    tone: 'brand',
    hoverTone: 'brand',
    underline: 'none',
    children: 'E00001',
  },
};

/**
 * Every measured call site from the two tracer pages, reproduced byte for
 * byte (see link.tsx's header and link.test.tsx). The one deliberate
 * exception - InvoicesPage:164, hand-rolled today as a `<span onClick>` - is
 * called out inline: converting it to a real anchor adds keyboard
 * reachability and a link role, which is a rendered behaviour change stated
 * here and in the PR body, not hidden in a diff.
 */
export const RealSignatures: Story = {
  render: () => (
    <MemoryRouter>
      <div className="flex flex-col gap-3">
        <p>
          Invoice for job{' '}
          <TextLink asChild tone="brand" weight="medium">
            <Link to="/jobs/1">J00001</Link>
          </TextLink>{' '}
          (InvoicesPage:649, and the InvoicesPage:164 span-turned-anchor - the one
          intended behaviour change, see link.tsx)
        </p>
        <p>
          Customer{' '}
          <TextLink asChild tone="brand" weight="medium">
            <Link to="/customers/1">Acme</Link>
          </TextLink>{' '}
          (InvoiceDetailPage:698)
        </p>
        <p>
          Job{' '}
          <TextLink asChild tone="brand">
            <Link to="/jobs/1">linked record</Link>
          </TextLink>{' '}
          (InvoiceDetailPage:739)
        </p>
        <p>
          Estimate{' '}
          <TextLink asChild tone="brand">
            <Link to="/estimates/1">linked record</Link>
          </TextLink>{' '}
          (InvoiceDetailPage:755)
        </p>
        <p>
          Call{' '}
          <TextLink asChild hoverTone="brand">
            <a href="tel:+15125550100">contact</a>
          </TextLink>{' '}
          (InvoiceDetailPage:708)
        </p>
        <p>
          Email{' '}
          <TextLink asChild hoverTone="brand">
            <a href="mailto:owner@example.test">contact</a>
          </TextLink>{' '}
          (InvoiceDetailPage:717)
        </p>
        <p>
          Chip{' '}
          <TextLink asChild size="xs" weight="medium" underline="none">
            <Link to="/estimates/1">E00001</Link>
          </TextLink>{' '}
          (InvoiceDetailPage:1093)
        </p>
      </div>
    </MemoryRouter>
  ),
};
