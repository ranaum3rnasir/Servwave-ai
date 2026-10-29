/* =============================================================================
   Text - Storybook stories, full-coverage pass (Storybook phase, W2 plan).

   Storybook 8 is scaffolded now (.storybook/main.ts, .storybook/preview.ts,
   the @storybook/react-vite devDependency in package.json) - unlike the
   "new primitives" phase's first-pass story this file replaces, it imports
   the real `Meta` / `StoryObj` types from `@storybook/react` and wires
   `argTypes` so every axis is a live control in the Storybook UI.

   Coverage requirement (the completeness pass this phase adds): every
   variant KEY and every VALUE in text.tsx's cva() block needs at least one
   story that actually renders it.

     size      3xl | base | sm | xs | 3xs -> the Sizes story renders all
       five, explicitly, side by side. `base` emits no font-size class at
       all - see text.tsx's header - so its story cell is annotated rather
       than left silently blank.
     tone      primary | secondary | brand | danger | success | neutral ->
       the Tones story renders all six.
     weight    medium | semibold | bold -> the Weights story renders all
       three (`semibold` has no measured demand on the tracer pages but is
       still a real cva key - see text.tsx's header - so it still needs a
       story).
     align     left | center | right -> the Alignment story renders all
       three inside a bordered column so the shift is visible.
     transform uppercase -> the EyebrowCasing story (its only value).
     tracking  wide -> the same EyebrowCasing story (its only value).

   `as` (span | p | div) is a real, shipped prop - which element renders -
   but it is NOT part of the cva() block (text.tsx has no `variants.as`
   entry; it only picks the tag). It is outside what the completeness pass
   checks, but a designer flipping controls needs to see it, so it is wired
   as a select control below and covered by its own Elements story.
   ============================================================================= */
import type { Meta, StoryObj } from '@storybook/react';

import { Text, type TextElement } from './text';

const ELEMENTS: TextElement[] = ['span', 'p', 'div'];
const SIZES = ['3xl', 'base', 'sm', 'xs', '3xs'] as const;
const TONES = ['primary', 'secondary', 'brand', 'danger', 'success', 'neutral'] as const;
const WEIGHTS = ['medium', 'semibold', 'bold'] as const;
const ALIGNS = ['left', 'center', 'right'] as const;

const meta = {
  title: 'UI/Text',
  component: Text,
  tags: ['autodocs'],
  args: {
    children: 'The quick brown fox jumps over the lazy dog.',
  },
  argTypes: {
    as: {
      control: { type: 'select' },
      options: ELEMENTS,
      description:
        'Rendered element. Defaults to `span`; never changes how the text looks - purely which tag is emitted.',
    },
    size: {
      control: { type: 'select' },
      options: [undefined, ...SIZES],
      description:
        '`base` is an EMPTY STRING on purpose - it means "inherit", not the stock 16px key. Omit `size` (or pick `base`) for copy that must keep inheriting an ancestor\'s font size.',
    },
    tone: {
      control: { type: 'select' },
      options: [undefined, ...TONES],
      description:
        'Semantic colour, NO default - copy that inherits its colour must keep inheriting it. `primary` is the chrome text role, `neutral` is the muted status role; they are different values.',
    },
    weight: {
      control: { type: 'select' },
      options: [undefined, ...WEIGHTS],
      description:
        'Font weight, no default. `medium` is the measured mode; `semibold` has no demand on the tracer pages but is carried for the app-wide population.',
    },
    align: {
      control: { type: 'select' },
      options: [undefined, ...ALIGNS],
      description:
        'Horizontal alignment - appearance, not layout, everywhere except Card. No default: an unaligned Text inherits its ancestor\'s alignment.',
    },
    transform: {
      control: { type: 'select' },
      options: [undefined, 'uppercase'],
      description: 'Letter casing. `uppercase` is the only measured value, both eyebrow labels.',
    },
    tracking: {
      control: { type: 'select' },
      options: [undefined, 'wide'],
      description: 'Letter spacing. `wide` is the only measured value, the same two eyebrow labels.',
    },
    className: { control: false },
  },
} satisfies Meta<typeof Text>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Propless Text. Renders `<span class="">` - zero classes, zero painted
 * properties. Wrapping any existing inline copy in a bare Text cannot move a
 * pixel, which is the property the whole conversion depends on.
 */
export const Default: Story = {};

/**
 * Every implemented `size` value, side by side. `base` is called out
 * explicitly: it emits no font-size class, so text at that rung keeps
 * whatever size its ancestor set.
 */
export const Sizes: Story = {
  render: () => (
    <div className="flex flex-col gap-1">
      <Text size="3xl">size=3xl</Text>
      <Text size="base">size=base (inherits - emits no font-size class)</Text>
      <Text size="sm">size=sm</Text>
      <Text size="xs">size=xs</Text>
      <Text size="3xs">size=3xs</Text>
    </div>
  ),
};

/**
 * Every implemented `tone` value. `primary` is the chrome body role,
 * `neutral` is the muted status role - different values, both real keys.
 */
export const Tones: Story = {
  render: () => (
    <div className="flex flex-col gap-1">
      <Text tone="primary">tone=primary (chrome body text)</Text>
      <Text tone="secondary">tone=secondary</Text>
      <Text tone="brand">tone=brand</Text>
      <Text tone="danger">tone=danger</Text>
      <Text tone="success">tone=success</Text>
      <Text tone="neutral">tone=neutral (muted status role)</Text>
    </div>
  ),
};

/**
 * Every implemented `weight` value. `medium` is the measured mode (12
 * sites), `bold` has one site (the invoice balance figure), `semibold` has
 * no demand on the tracer pages but is a real cva key carried for the
 * app-wide population.
 */
export const Weights: Story = {
  render: () => (
    <div className="flex flex-col gap-1">
      <Text weight="medium">weight=medium</Text>
      <Text weight="semibold">weight=semibold</Text>
      <Text weight="bold">weight=bold</Text>
    </div>
  ),
};

/** Every implemented `align` value, inside a bordered column so the shift is visible. */
export const Alignment: Story = {
  render: () => (
    <div className="flex w-64 flex-col gap-1 border border-border">
      <Text align="left">align=left</Text>
      <Text align="center">align=center</Text>
      <Text align="right">align=right</Text>
    </div>
  ),
};

/**
 * `transform="uppercase"` and `tracking="wide"` - each has exactly one
 * implemented value, and both measured sites are the same eyebrow label, so
 * one story covers both axes at once.
 */
export const EyebrowCasing: Story = {
  render: () => (
    <Text size="3xs" tone="secondary" weight="medium" transform="uppercase" tracking="wide">
      Eyebrow label
    </Text>
  ),
};

/** Every `as` value - the rendered element never changes how the text looks. */
export const Elements: Story = {
  render: () => (
    <div className="flex flex-col gap-1">
      <Text as="span">as=span (default)</Text>
      <Text as="p">as=p</Text>
      <Text as="div">as=div</Text>
    </div>
  ),
};

/** The full `size` x `tone` grid, at `weight="medium"`, for visual QA. */
export const SizeToneMatrix: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      {SIZES.map((size) => (
        <div key={size} className="flex flex-wrap items-center gap-4">
          <span className="w-12 text-xs text-text-secondary">{size}</span>
          {TONES.map((tone) => (
            <Text key={tone} size={size} tone={tone} weight="medium">
              {tone}
            </Text>
          ))}
        </div>
      ))}
    </div>
  ),
};

/** Real measured signatures from the tracer pages, reproduced verbatim. */
export const RealSignatures: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <Text as="p" size="xs" tone="secondary">
        Acme Plumbing
      </Text>
      <Text size="3xs" tone="secondary" weight="medium" transform="uppercase" tracking="wide">
        VOIDED
      </Text>
      <Text as="p" size="3xl" weight="bold" tone="danger" className="tabular-nums">
        $1,240.00
      </Text>
      <Text align="right" weight="medium" className="tabular-nums block">
        $412.00
      </Text>
    </div>
  ),
};
