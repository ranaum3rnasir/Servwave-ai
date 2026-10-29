/* =============================================================================
   Chip - Storybook stories, full-coverage pass (Storybook phase, W2 plan).

   Chip's first pass (this file, before this edit) predates Storybook being
   scaffolded in this worktree - see badge.stories.tsx's header note for why
   that first pass used a loose local `StoryDef` shape instead of the real
   `@storybook/react` types. Storybook is now wired (.storybook/main.ts,
   .storybook/preview.ts, the @storybook/react-vite devDependency), so this
   file imports the real `Meta` / `StoryObj` types and wires `argTypes` so
   every axis is a live control in the Storybook UI.

   Coverage requirement (the completeness pass this phase adds): every
   variant KEY and every VALUE in chip.tsx's cva() block needs at least one
   story that actually renders it.

     tone: neutral | brand | danger | success | warning | ai -> Neutral /
       Brand / Danger / Success / Warning / Ai each set it explicitly, and
       the Tones story renders all six side by side.
     size: 2xs -> Medium sets it explicitly. `2xs` (28px, measured from the
       base string's py-1.5 + text-xs) is the only rung chip.tsx mints -
       `3xs` / `xs` / `sm` / `md` / `lg` are reserved by the closed six-rung
       absolute-px vocabulary but not implemented (zero measured call-site
       signature; see chip.tsx's header note), the same treatment
       popover.stories.tsx gives Popover's own deferred `xs` width rung - so
       there is nothing else to render a story for.

   Chip has no `variant`, `gap`, or `pad` axis - chip.tsx's own header note
   explains why each was left out (no structural-appearance signature is on
   record, the evidenced padding is one atomic pair baked into `size` rather
   than an independent prop, and a static pill has no navigational-link
   meaning). There is no cva() entry for any of the three, so nothing here
   invents a control for them.
   ============================================================================= */
import type { Meta, StoryObj } from '@storybook/react';

import { Chip } from './chip';

const TONES = ['neutral', 'brand', 'danger', 'success', 'warning', 'ai'] as const;
const SIZES = ['2xs'] as const;

const meta = {
  title: 'UI/Chip',
  component: Chip,
  tags: ['autodocs'],
  argTypes: {
    tone: {
      control: { type: 'select' },
      options: TONES,
      description:
        'Semantic colour. `neutral` (the default) contributes no classes - the propless render is byte-identical to the 20-site evidenced signature (see chip.tsx). The rest reuse badge.tsx\'s surface/border/text triad.',
    },
    size: {
      control: { type: 'select' },
      options: SIZES,
      description:
        'Atomic padding + type rung, on the six-rung absolute-px ladder (3xs=24, 2xs=28, xs=32, sm=36, md=40, lg=44). `2xs` (the default, and the only rung minted) is a no-op - the base string already carries the evidenced px-2.5 py-1.5 text-xs, which measures 28px. `3xs` / `xs` / `sm` / `md` / `lg` are reserved by the closed vocabulary but not implemented - no measured call-site signature for any other rung.',
    },
    className: { control: false },
    children: { control: 'text' },
  },
  args: {
    children: 'Chip',
  },
} satisfies Meta<typeof Chip>;

export default meta;

type Story = StoryObj<typeof meta>;

/** `tone="neutral"`, `size="2xs"` - chip.tsx's own `defaultVariants`, set explicitly; byte-identical to the propless render. */
export const Default: Story = {
  args: {
    tone: 'neutral',
    size: '2xs',
    children: 'Default',
  },
};

/** `tone="neutral"` - the evidenced signature, no surface/border/text override. */
export const Neutral: Story = {
  args: {
    tone: 'neutral',
    children: 'Neutral',
  },
};

/** `tone="brand"` - reuses badge.tsx's brand surface/border/text triad. */
export const Brand: Story = {
  args: {
    tone: 'brand',
    children: 'Brand',
  },
};

/** `tone="danger"`. */
export const Danger: Story = {
  args: {
    tone: 'danger',
    children: 'Danger',
  },
};

/** `tone="success"`. */
export const Success: Story = {
  args: {
    tone: 'success',
    children: 'Success',
  },
};

/** `tone="warning"`. */
export const Warning: Story = {
  args: {
    tone: 'warning',
    children: 'Warning',
  },
};

/** `tone="ai"`. */
export const Ai: Story = {
  args: {
    tone: 'ai',
    children: 'AI',
  },
};

/** Every implemented `tone` value, side by side, at the default `size`. */
export const Tones: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      {TONES.map((tone) => (
        <Chip key={tone} tone={tone}>
          {tone}
        </Chip>
      ))}
    </div>
  ),
};

/** `size="2xs"` - the evidenced default (px-2.5 py-1.5 text-xs, 28px), set explicitly. */
export const Medium: Story = {
  args: {
    size: '2xs',
    children: 'Medium',
  },
};

/** A chip carrying a leading icon - the shape the base string's `gap-1` exists for. */
export const WithIcon: Story = {
  render: () => (
    <Chip tone="success">
      <svg
        className="h-3 w-3"
        viewBox="0 0 20 20"
        fill="currentColor"
        aria-hidden="true"
      >
        <path
          fillRule="evenodd"
          d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z"
          clipRule="evenodd"
        />
      </svg>
      Active
    </Chip>
  ),
};
