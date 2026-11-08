/* =============================================================================
   Avatar - Storybook stories, full-coverage pass (Storybook phase, W2 plan).

   Storybook 8 is scaffolded in this worktree (.storybook/main.ts globs every
   .stories.ts(x) file under components/ui, .storybook/preview.ts loads the
   app's own CSS), so this file uses the real `Meta` / `StoryObj` types from
   `@storybook/react` - matching button.stories.tsx / calendar.stories.tsx,
   not the loose local shape the earlier "new primitives" first-pass stories
   reached for before that package existed in this tree.

   Coverage requirement (the completeness pass this phase adds): every
   variant KEY and every VALUE across the file's two variant maps needs at
   least one story that actually renders it.

     Avatar's own `ring`  : none | stack | ai      -> Default (none) /
       RingStack / RingAi, plus AllRings side by side.
     Avatar's own `size`  : xs | sm | md | lg       -> SizeXs / SizeSm /
       Default (md) / SizeLg, plus AllSizes side by side.
     AvatarFallback's own `tone` : default | solid | subtle | custom ->
       Default (default) / ToneSolid / ToneSubtle / ToneCustom, plus
       AllTones side by side.

   `Default` sets all three values explicitly through args (rather than
   leaning on the components' own defaults) so the literal value text is
   present in this file even for the default cell, not just implied by
   omission.

   WHY THE `component` FIELD IS CAST, NOT PASSED STRAIGHT. `tone` is a real,
   shipped prop - but it lives on `AvatarFallback`, a different exported
   component than the one this story is about. `Meta<typeof Avatar>` only
   ever sees Avatar's own props (`ring`, `size`, plus the Radix root's), so it
   cannot carry `tone` through the Controls addon at all. `AvatarStoryArgs`
   below is the flattened surface a designer actually needs - the same
   flatten-and-cast button.stories.tsx / calendar.stories.tsx use for their
   own cases where the real component type does not line up 1:1 with the
   controls a designer needs. The cast is type-only; the runtime component is
   avatar.tsx's real, unchanged `Avatar`. Every story below supplies its own
   `render`, threading `ring`/`size` onto `<Avatar>` and `tone` onto the
   nested `<AvatarFallback>` it actually belongs to, so this never reaches
   the DOM as a stray `tone` attribute on the wrong element.
   ============================================================================= */
import type { ComponentType } from 'react';
import type { Meta, StoryObj } from '@storybook/react';

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  type AvatarRing,
  type AvatarSize,
  type AvatarTone,
} from './avatar';

/**
 * Inline SVG data URI, not a real photo URL - the story renders with no
 * network request and no fixture asset to keep in sync. Named CSS colours
 * only (matches thumbnail.stories.tsx's SWATCH convention) - no raw hex.
 */
const PHOTO =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80">' +
      '<rect width="80" height="80" fill="slategray"/>' +
      '<circle cx="40" cy="30" r="16" fill="gainsboro"/>' +
      '<rect x="12" y="54" width="56" height="30" rx="15" fill="gainsboro"/>' +
      '</svg>'
  );

/** Flattened Controls-panel surface - see the header note above for why. */
type AvatarStoryArgs = {
  ring?: AvatarRing;
  size?: AvatarSize;
  tone?: AvatarTone;
};

const meta = {
  title: 'UI/Avatar',
  component: Avatar as unknown as ComponentType<AvatarStoryArgs>,
  tags: ['autodocs'],
  args: {
    ring: 'none',
    size: 'md',
    tone: 'default',
  },
  argTypes: {
    ring: {
      control: { type: 'select' },
      options: ['none', 'stack', 'ai'],
      description: 'Which halo/border context the avatar sits in - not which classes paint it.',
    },
    size: {
      control: { type: 'select' },
      options: ['xs', 'sm', 'md', 'lg'],
      description: "Rendered diameter. md is the default and today's pre-existing geometry.",
    },
    tone: {
      control: { type: 'select' },
      options: ['default', 'solid', 'subtle', 'custom'],
      description:
        "AvatarFallback's own axis, not a root Avatar prop - threaded onto the nested fallback by this story's render.",
    },
  },
} satisfies Meta<ComponentType<AvatarStoryArgs>>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The interactive default - flipping `ring` / `size` / `tone` in the
 * Controls addon re-renders the fallback tile below with those props.
 * `ring="none"`, `size="md"`, `tone="default"` set explicitly (rather than
 * left to fall through the components' own defaults) so the literal default
 * value is present in this file for all three axes, not just implied by
 * omission.
 */
export const Default: Story = {
  render: (args) => (
    <Avatar ring={args.ring} size={args.size}>
      <AvatarFallback tone={args.tone}>JD</AvatarFallback>
    </Avatar>
  ),
};

/**
 * The real composition most call sites use - an image with a fallback
 * behind it. Byte-identical to the pre-`size`-prop render when no props are
 * set (see avatar.test.tsx's frozen-string assertion).
 */
export const ImageWithFallback: Story = {
  render: () => (
    <Avatar>
      <AvatarImage src={PHOTO} alt="Jamie Doe" />
      <AvatarFallback>JD</AvatarFallback>
    </Avatar>
  ),
};

/** `ring="stack"` - a tile sitting on its own card, bordered so it reads as a shape. */
export const RingStack: Story = {
  render: () => (
    <Avatar ring="stack">
      <AvatarImage src={PHOTO} alt="Jamie Doe" />
      <AvatarFallback>JD</AvatarFallback>
    </Avatar>
  ),
};

/** `ring="ai"` - the AI-agent halo used across the Copilot surfaces. */
export const RingAi: Story = {
  render: () => (
    <Avatar ring="ai">
      <AvatarFallback tone="solid">AI</AvatarFallback>
    </Avatar>
  ),
};

/** `size="xs"` - 32px, the CustomersPage/AssignTeamPopover rung. */
export const SizeXs: Story = {
  render: () => (
    <Avatar size="xs">
      <AvatarFallback>JD</AvatarFallback>
    </Avatar>
  ),
};

/** `size="sm"` - 36px, the Header/AiJobAssistantBar rung. */
export const SizeSm: Story = {
  render: () => (
    <Avatar size="sm">
      <AvatarFallback>JD</AvatarFallback>
    </Avatar>
  ),
};

/** `size="lg"` - 44px, the ladder's top rung (coincides with TeamCard.tsx's
 * existing diameter). AgentDetailModal.tsx/CustomerDetailPage.tsx render at
 * 64px, off the ladder entirely, and stay on a bespoke className override. */
export const SizeLg: Story = {
  render: () => (
    <Avatar size="lg">
      <AvatarFallback>JD</AvatarFallback>
    </Avatar>
  ),
};

/** All four `size` rungs side by side, smallest to largest, `md` labelled as the default. */
export const AllSizes: Story = {
  render: () => (
    <div className="flex flex-wrap items-end gap-4">
      <div className="flex flex-col items-center gap-2">
        <Avatar size="xs">
          <AvatarFallback>JD</AvatarFallback>
        </Avatar>
        <span className="text-sm text-text-primary">xs</span>
      </div>
      <div className="flex flex-col items-center gap-2">
        <Avatar size="sm">
          <AvatarFallback>JD</AvatarFallback>
        </Avatar>
        <span className="text-sm text-text-primary">sm</span>
      </div>
      <div className="flex flex-col items-center gap-2">
        <Avatar size="md">
          <AvatarFallback>JD</AvatarFallback>
        </Avatar>
        <span className="text-sm text-text-primary">md (default)</span>
      </div>
      <div className="flex flex-col items-center gap-2">
        <Avatar size="lg">
          <AvatarFallback>JD</AvatarFallback>
        </Avatar>
        <span className="text-sm text-text-primary">lg</span>
      </div>
    </div>
  ),
};

/** All three `ring` values side by side, `none` labelled as the default. */
export const AllRings: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-4">
      <div className="flex flex-col items-center gap-2">
        <Avatar ring="none" size="lg">
          <AvatarFallback>JD</AvatarFallback>
        </Avatar>
        <span className="text-sm text-text-primary">none (default)</span>
      </div>
      <div className="flex flex-col items-center gap-2">
        <Avatar ring="stack" size="lg">
          <AvatarFallback>JD</AvatarFallback>
        </Avatar>
        <span className="text-sm text-text-primary">stack</span>
      </div>
      <div className="flex flex-col items-center gap-2">
        <Avatar ring="ai" size="lg">
          <AvatarFallback tone="solid">AI</AvatarFallback>
        </Avatar>
        <span className="text-sm text-text-primary">ai</span>
      </div>
    </div>
  ),
};

/** `tone="solid"` - a filled brand tile, white initials. */
export const ToneSolid: Story = {
  render: () => (
    <Avatar size="lg">
      <AvatarFallback tone="solid">JD</AvatarFallback>
    </Avatar>
  ),
};

/** `tone="subtle"` - a tinted tile, brand-coloured initials. */
export const ToneSubtle: Story = {
  render: () => (
    <Avatar size="lg">
      <AvatarFallback tone="subtle">JD</AvatarFallback>
    </Avatar>
  ),
};

/**
 * `tone="custom"` - the component only guarantees legible white text; the
 * background is the caller's own per-record colour (an AI agent's brand
 * colour, say). The real call site passes an inline `style` built from that
 * record's own value - this story stands in with a token-composed string
 * (`rgb(var(--ai-500))`, the same "ai" role Avatar's own `ring="ai"` halo
 * draws from) rather than inventing a new literal colour for the fixture.
 */
export const ToneCustom: Story = {
  render: () => (
    <Avatar size="lg">
      <AvatarFallback tone="custom" style={{ backgroundColor: 'rgb(var(--ai-500))' }}>
        AI
      </AvatarFallback>
    </Avatar>
  ),
};

/** All four `tone` values side by side, `default` labelled as the default. */
export const AllTones: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-4">
      <div className="flex flex-col items-center gap-2">
        <Avatar size="lg">
          <AvatarFallback tone="default">JD</AvatarFallback>
        </Avatar>
        <span className="text-sm text-text-primary">default</span>
      </div>
      <div className="flex flex-col items-center gap-2">
        <Avatar size="lg">
          <AvatarFallback tone="solid">JD</AvatarFallback>
        </Avatar>
        <span className="text-sm text-text-primary">solid</span>
      </div>
      <div className="flex flex-col items-center gap-2">
        <Avatar size="lg">
          <AvatarFallback tone="subtle">JD</AvatarFallback>
        </Avatar>
        <span className="text-sm text-text-primary">subtle</span>
      </div>
      <div className="flex flex-col items-center gap-2">
        <Avatar size="lg">
          <AvatarFallback tone="custom" style={{ backgroundColor: 'rgb(var(--ai-500))' }}>
            AI
          </AvatarFallback>
        </Avatar>
        <span className="text-sm text-text-primary">custom</span>
      </div>
    </div>
  ),
};
