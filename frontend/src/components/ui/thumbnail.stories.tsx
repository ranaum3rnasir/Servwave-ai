/* =============================================================================
   Thumbnail - Storybook stories, full-coverage pass (Storybook phase, W2 plan).

   Storybook 8 is scaffolded now (.storybook/main.ts, .storybook/preview.ts, the
   @storybook/react-vite devDependency in package.json) - this file replaces the
   "new primitives" phase's first-pass, package-free stories with the real
   `Meta` / `StoryObj` types from `@storybook/react`, matching
   badge.stories.tsx / avatar.stories.tsx, and wires `argTypes` so both axes
   are live controls in the Storybook UI.

   Coverage requirement (the completeness pass this phase adds): every variant
   KEY and every VALUE in thumbnail.tsx's cva() block needs at least one story
   that actually renders it.

     size    : 3xs | xs | md  -> Size3xs / SizeXs / Default (md),
       plus AllSizes side by side.
     variant : outline        -> Outline, plus SizeVariantMatrix showing it
       against every size.

   `size` is the closed vocabulary's absolute six-rung ladder (3xs=24,
   2xs=28, xs=32, sm=36, md=40, lg=44px); thumbnail.tsx only mints the three
   rungs it has measured demand for (see its header). 56px - the old,
   non-vocabulary `lg` value this file previously exercised - has no matching
   rung on the ladder and is no longer a `size` value at all (thumbnail.tsx's
   header explains why it cannot be kept as a deprecated alias). The story
   that used to demonstrate it, `SizeLg`, is replaced below by
   `SingletonDiameterOverride`, which documents the real supported mechanism
   for out-of-ladder diameters (28px/36px/48px/56px): a plain `className`
   override, which `cn`'s tailwind-merge lets win over `size`'s h-w classes.

   `Default` sets `size="md"` explicitly (rather than leaning on thumbnail.tsx's
   own `defaultVariants`) so the literal default value is present in this file,
   not just implied by omission. `variant` has no default value to set the same
   way - a bare Thumbnail renders no border class at all (see thumbnail.tsx's
   own header) - so Default leaves it unset, and Outline is the only story
   that sets it, which is the whole of `variant`'s value space.

   The `src` used throughout is a tiny inline SVG data URI rather than a real
   photo URL, so every story renders with no network request and no fixture
   asset to keep in sync. Named CSS colours only, no raw hex - this file's own
   original convention (see avatar.stories.tsx's header, which points back at
   it).
   ============================================================================= */
import type { Meta, StoryObj } from '@storybook/react';

import { Thumbnail } from './thumbnail';

const SIZES = ['3xs', 'xs', 'md'] as const;

const SWATCH =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">' +
      '<rect width="100" height="100" fill="slategray"/>' +
      '</svg>'
  );

const meta = {
  title: 'UI/Thumbnail',
  component: Thumbnail,
  tags: ['autodocs'],
  args: {
    src: SWATCH,
    alt: 'Item photo',
  },
  argTypes: {
    size: {
      control: { type: 'select' },
      options: SIZES,
      description:
        'Rendered diameter (square), on the closed vocabulary\'s absolute six-rung ladder. md is the default - the dominant real signature.',
    },
    variant: {
      control: { type: 'select' },
      options: [undefined, 'outline'],
      description:
        'Structural appearance. Only "outline" is minted - a ring border. No default: a bare Thumbnail renders no border class at all.',
    },
    src: { control: 'text' },
    alt: { control: 'text' },
    className: { control: false },
  },
} satisfies Meta<typeof Thumbnail>;

export default meta;

type Story = StoryObj<typeof meta>;

/** `size="md"`, no `variant` - the dominant real shape-1 signature, 40px, no border. */
export const Default: Story = {
  args: {
    size: 'md',
  },
};

/** `size="3xs"` - 24px, the smallest measured rung (a referenced-item row). */
export const Size3xs: Story = {
  args: {
    size: '3xs',
  },
};

/** `size="xs"` - 32px. */
export const SizeXs: Story = {
  args: {
    size: 'xs',
  },
};

/**
 * 56px was the second-most-common measured signature (4 real call sites) but
 * has no matching rung on the closed vocabulary's absolute ladder, which
 * tops out at `lg`=44px - so it is not a `size` value at all (see
 * thumbnail.tsx's header). Those 4 sites migrate to a bespoke className
 * override instead, the same mechanism the 28px/36px/48px singletons already
 * use; `cn`'s tailwind-merge lets it win over `size`'s own h-w classes.
 */
export const SingletonDiameterOverride: Story = {
  args: {
    size: 'md',
    className: 'h-14 w-14',
  },
};

/** `variant="outline"` - a tile bordered by a ring, the more common of the two real border styles. */
export const Outline: Story = {
  args: {
    size: 'md',
    variant: 'outline',
  },
};

/** All three minted `size` rungs side by side, smallest to largest, `md` labelled as the default. */
export const AllSizes: Story = {
  render: () => (
    <div className="flex flex-wrap items-end gap-4">
      {SIZES.map((size) => (
        <div key={size} className="flex flex-col items-center gap-2">
          <Thumbnail src={SWATCH} alt={`${size} thumbnail`} size={size} />
          <span className="text-sm text-text-primary">
            {size === 'md' ? `${size} (default)` : size}
          </span>
        </div>
      ))}
    </div>
  ),
};

/**
 * Every `size` rung, plain and with `variant="outline"` layered on top - the
 * full `size` x `variant` grid from thumbnail.tsx's cva() block, for visual
 * QA against every rendered diameter.
 */
export const SizeVariantMatrix: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-4">
        <span className="w-24 text-xs text-text-secondary">no variant</span>
        {SIZES.map((size) => (
          <Thumbnail key={size} src={SWATCH} alt={`${size} thumbnail`} size={size} />
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-4">
        <span className="w-24 text-xs text-text-secondary">outline</span>
        {SIZES.map((size) => (
          <Thumbnail
            key={size}
            src={SWATCH}
            alt={`${size} thumbnail, outline`}
            size={size}
            variant="outline"
          />
        ))}
      </div>
    </div>
  ),
};
