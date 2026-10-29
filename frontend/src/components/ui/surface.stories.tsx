/* =============================================================================
   Surface - Storybook stories, full coverage pass (Storybook phase, W2 plan).

   Storybook 8 is scaffolded in this worktree now (.storybook/main.ts,
   .storybook/preview.ts, the @storybook/react-vite devDependency in
   package.json) - unlike this file's first pass (see git history, written
   before Storybook itself existed in the tree), this version imports the real
   `Meta` / `StoryObj` types from `@storybook/react` and wires `argTypes` so
   every axis is a live control in the Storybook UI, matching
   box.stories.tsx / badge.stories.tsx / tabs.stories.tsx.

   Prop rename note: this file originally called the light/dark axis `tone`.
   VOCAB_V3 reserves `tone` for semantic colour, so surface.tsx renamed the
   prop to `backdrop` (see surface.tsx's own header note, "WHY THIS PROP IS
   `backdrop`, NOT `tone`") and kept `tone` alive as a deprecated alias. This
   file follows suit: every story below drives `backdrop`, and `LegacyToneAlias`
   is the dedicated case proving the deprecated `tone` prop still renders
   identically, matching the convention card.stories.tsx's `LegacyPadding`
   sets for its own deprecated `padding` word scale.

   Coverage requirement (the completeness pass this phase adds): every
   variant KEY and every VALUE in surface.tsx's cva() block needs at least
   one story that actually renders it.

     surfaceVariants has exactly one key, `backdrop`, with two values:
       backdrop: light | dark  -> Default sets `backdrop="light"` explicitly
         (the cva `defaultVariants` value, set out loud rather than left
         implicit - same convention badge.stories.tsx's `Default` uses for
         its own default cell); Dark sets `backdrop="dark"` explicitly.
         Backdrops renders both side by side for visual QA, the same shape
         as badge.stories.tsx's own `Tones` story.

   `pad`/`padX`/`padY`/`padTop`/`padRight`/`padBottom`/`padLeft`
   (design-system/spacing.ts's `PadProps`, spread into `SurfaceProps` - see
   surface.tsx's own header note on why this is measured demand, not a
   speculative add) are NOT part of the cva() block - `padClasses()` composes
   them separately, exactly the situation box.stories.tsx documents for Box's
   identical seven-prop surface. So the target for this half of the file is
   the real, shipped prop surface, covered as exhaustively as box.stories.tsx
   covers Box's own copy of the same seven props, not just the cva completeness
   floor.

   Also covered, because it is the entire reason Surface is a React context
   provider and not just a div with a dark background (surface.tsx's own
   header note, "THE PROBLEM THIS CLOSES"): `useSurfaceBackdrop()` actually
   propagating to a descendant. `ContextPropagation` renders a real child
   that calls the hook, the same technique surface.test.tsx's own dedicated
   verifier suite uses (never reading the DOM/class string as a proxy for
   context propagation).
   ============================================================================= */
import type { Meta, StoryObj } from '@storybook/react'

import { Surface, useSurfaceBackdrop, type SurfaceBackdrop } from './surface'
import { PAD_STEPS, type PadStep } from '@/design-system/spacing'

const BACKDROPS: SurfaceBackdrop[] = ['light', 'dark']

/** Shared demo paint - a dashed frame so a light Surface's own padding is
 *  visible (light emits no chrome of its own, same as Box's bare default). */
const DEMO_FRAME = 'inline-block rounded border border-dashed border-border bg-neutral-surface'

const meta = {
  title: 'UI/Surface',
  component: Surface,
  tags: ['autodocs'],
  argTypes: {
    backdrop: {
      control: { type: 'select' },
      options: BACKDROPS,
      description:
        'Which ambient backdrop this region establishes for its children. "light" (the default) emits no chrome of its own - every other primitive is already tuned for a light ambient background. "dark" paints `bg-surface-dark text-on-dark` and provides "dark" through `useSurfaceBackdrop()` to every descendant.',
    },
    tone: {
      control: { type: 'select' },
      options: BACKDROPS,
      description:
        'Deprecated. Use `backdrop` - same two values, same render. Ignored when `backdrop` is also passed.',
    },
    pad: {
      control: { type: 'select' },
      options: [...PAD_STEPS],
      description: 'Uniform padding on all four sides, as a 4px-grid step. `pad={6}` is 24px.',
    },
    padX: {
      control: { type: 'select' },
      options: [...PAD_STEPS],
      description: 'Horizontal padding. Overrides `pad` on the left and right sides.',
    },
    padY: {
      control: { type: 'select' },
      options: [...PAD_STEPS],
      description: 'Vertical padding. Overrides `pad` on the top and bottom sides.',
    },
    padTop: {
      control: { type: 'select' },
      options: [...PAD_STEPS],
      description: 'Top padding. Overrides `padY` and `pad` on this side only.',
    },
    padRight: {
      control: { type: 'select' },
      options: [...PAD_STEPS],
      description: 'Right padding. Overrides `padX` and `pad` on this side only.',
    },
    padBottom: {
      control: { type: 'select' },
      options: [...PAD_STEPS],
      description: 'Bottom padding. Overrides `padY` and `pad` on this side only.',
    },
    padLeft: {
      control: { type: 'select' },
      options: [...PAD_STEPS],
      description: 'Left padding. Overrides `padX` and `pad` on this side only.',
    },
    className: { control: false },
  },
} satisfies Meta<typeof Surface>

export default meta

type Story = StoryObj<typeof meta>

/**
 * `backdrop="light"` (the cva `defaultVariants` value, set explicitly) with
 * no padding - renders exactly `<div class="">`, geometrically and
 * contextually inert. No demo frame here on purpose, matching
 * box.stories.tsx's own `Default` - wrapping existing markup in a bare
 * Surface cannot move a pixel. Flip the `backdrop` control to "dark" above
 * to see the backdrop appear.
 */
export const Default: Story = {
  args: {
    backdrop: 'light',
    children: 'Light surface (the default) - no chrome of its own.',
  },
}

/**
 * `backdrop="dark"` - the ambient backdrop the dead `onDark` Button variant
 * used to assume without ever painting it (surface.tsx's own header note).
 * Every other primitive's default styling is tuned for `light`, so anything
 * nested here that has not yet been wired to read `useSurfaceBackdrop()`
 * will look wrong on purpose until it is - that gap is exactly what this
 * primitive exists to make fixable in one place.
 */
export const Dark: Story = {
  args: {
    backdrop: 'dark',
    pad: 6,
    children: 'Dark surface - background and text flip together.',
  },
}

/** Both `backdrop` values side by side, for visual QA - the same shape as
 *  badge.stories.tsx's own `Tones` story. */
export const Backdrops: Story = {
  render: () => (
    <div className="flex flex-wrap gap-4">
      {BACKDROPS.map((backdrop) => (
        <Surface
          key={backdrop}
          backdrop={backdrop}
          pad={6}
          className={backdrop === 'light' ? DEMO_FRAME : undefined}
        >
          <p className={backdrop === 'light' ? 'text-sm text-text-primary' : 'text-sm'}>
            {`backdrop="${backdrop}"`}
          </p>
        </Surface>
      ))}
    </div>
  ),
}

/**
 * The deprecated `tone` alias - kept only so any pre-existing `tone`-based
 * call site keeps rendering identically to `backdrop`. Same shape as
 * card.stories.tsx's `LegacyPadding` for its own deprecated `padding` word
 * scale.
 */
export const LegacyToneAlias: Story = {
  render: () => (
    <div className="flex flex-wrap gap-4">
      <Surface tone="light" pad={6} className={DEMO_FRAME}>
        <p className="text-sm text-text-primary">tone=&quot;light&quot; (backdrop=&quot;light&quot;)</p>
      </Surface>
      <Surface tone="dark" pad={6}>
        <p className="text-sm">tone=&quot;dark&quot; (backdrop=&quot;dark&quot;)</p>
      </Surface>
    </div>
  ),
}

/** A child reading the context directly, proving propagation rather than
 *  just paint - surface.tsx's own reason for being a context provider. */
function BackdropReadout() {
  const backdrop = useSurfaceBackdrop()
  return <p className="text-sm">{`useSurfaceBackdrop() reports: "${backdrop}"`}</p>
}

export const ContextPropagation: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <Surface pad={4} className={DEMO_FRAME}>
        <BackdropReadout />
      </Surface>
      <Surface backdrop="dark" pad={4}>
        <BackdropReadout />
      </Surface>
    </div>
  ),
}

/**
 * Every step on the `pad` scale - the uniform-padding case (13/13 values,
 * design-system/spacing.ts's `PAD_STEPS`), matching box.stories.tsx's own
 * `PaddingSteps`. `light` backdrop throughout, so the demo frame is the only
 * paint - Surface's own backdrop chrome is exercised separately above.
 */
export const PaddingSteps: Story = {
  render: () => (
    <div className="flex flex-wrap gap-4">
      {PAD_STEPS.map((step) => (
        <Surface key={step} pad={step} className={DEMO_FRAME}>
          <span className="text-sm text-text-primary">{`pad={${step}}`}</span>
        </Surface>
      ))}
    </div>
  ),
}

/**
 * Every step on the `padX` scale, overriding the horizontal sides only. A
 * fixed `pad={2}` baseline stays on the vertical sides throughout, so the
 * override is visible rather than Surface just looking uniformly padded -
 * the same technique box.stories.tsx's `HorizontalPaddingOverride` uses.
 */
export const HorizontalPaddingOverride: Story = {
  render: () => (
    <div className="flex flex-wrap gap-4">
      {PAD_STEPS.map((step) => (
        <Surface key={step} pad={2} padX={step} className={DEMO_FRAME}>
          <span className="text-sm text-text-primary">{`padX={${step}}`}</span>
        </Surface>
      ))}
    </div>
  ),
}

/**
 * Every step on the `padY` scale, overriding the vertical sides only. A
 * fixed `pad={2}` baseline stays on the horizontal sides throughout,
 * mirroring `HorizontalPaddingOverride`.
 */
export const VerticalPaddingOverride: Story = {
  render: () => (
    <div className="flex flex-wrap gap-4">
      {PAD_STEPS.map((step) => (
        <Surface key={step} pad={2} padY={step} className={DEMO_FRAME}>
          <span className="text-sm text-text-primary">{`padY={${step}}`}</span>
        </Surface>
      ))}
    </div>
  ),
}

/**
 * Every step on the `padTop` scale - a single side overridden, the other
 * three falling back to a fixed `pad={4}` baseline so the top-only change is
 * visible against the rest.
 */
export const TopPaddingOverride: Story = {
  render: () => (
    <div className="flex flex-wrap gap-4">
      {PAD_STEPS.map((step) => (
        <Surface key={step} pad={4} padTop={step} className={DEMO_FRAME}>
          <span className="text-sm text-text-primary">{`padTop={${step}}`}</span>
        </Surface>
      ))}
    </div>
  ),
}

/** Every step on the `padRight` scale, the other three sides fixed at `pad={4}`. */
export const RightPaddingOverride: Story = {
  render: () => (
    <div className="flex flex-wrap gap-4">
      {PAD_STEPS.map((step) => (
        <Surface key={step} pad={4} padRight={step} className={DEMO_FRAME}>
          <span className="text-sm text-text-primary">{`padRight={${step}}`}</span>
        </Surface>
      ))}
    </div>
  ),
}

/** Every step on the `padBottom` scale, the other three sides fixed at `pad={4}`. */
export const BottomPaddingOverride: Story = {
  render: () => (
    <div className="flex flex-wrap gap-4">
      {PAD_STEPS.map((step) => (
        <Surface key={step} pad={4} padBottom={step} className={DEMO_FRAME}>
          <span className="text-sm text-text-primary">{`padBottom={${step}}`}</span>
        </Surface>
      ))}
    </div>
  ),
}

/** Every step on the `padLeft` scale, the other three sides fixed at `pad={4}`. */
export const LeftPaddingOverride: Story = {
  render: () => (
    <div className="flex flex-wrap gap-4">
      {PAD_STEPS.map((step) => (
        <Surface key={step} pad={4} padLeft={step} className={DEMO_FRAME}>
          <span className="text-sm text-text-primary">{`padLeft={${step}}`}</span>
        </Surface>
      ))}
    </div>
  ),
}

/**
 * `padX` and `padY` set together with no uniform `pad` - box.stories.tsx's
 * `AxisPadOnly` shape (`px-4 py-2.5`), reproduced here for Surface since both
 * share `padClasses()`'s branch 2 verbatim.
 */
export const AxisPadOnly: Story = {
  args: {
    padX: 4,
    padY: 2.5 as PadStep,
    children: 'padX={4} padY={2.5}',
  },
  render: (args) => (
    <Surface {...args} className={DEMO_FRAME}>
      <span className="text-sm text-text-primary">{args.children}</span>
    </Surface>
  ),
}

/**
 * All four sides named individually and differently at once - no `pad` /
 * `padX` / `padY` baseline at all, every side resolves from its own prop
 * alone, the same shape as box.stories.tsx's `AllFourSidesIndividually`.
 */
export const AllFourSidesIndividually: Story = {
  render: () => (
    <Surface padTop={1} padRight={2} padBottom={3} padLeft={4} className={DEMO_FRAME}>
      <span className="text-sm text-text-primary">
        padTop={'{1}'} padRight={'{2}'} padBottom={'{3}'} padLeft={'{4}'}
      </span>
    </Surface>
  ),
}

/**
 * `pad` sets a baseline, `padTop` overrides one side only, the rest fall
 * back to `pad` - the exact combination surface.test.tsx's precedence case
 * pins (`pt-2 pr-4 pb-4 pl-4`).
 */
export const PerSideOverrideFallback: Story = {
  args: {
    pad: 4,
    padTop: 2,
    children: 'pad={4} padTop={2}',
  },
  render: (args) => (
    <Surface {...args} className={DEMO_FRAME}>
      <span className="text-sm text-text-primary">{args.children}</span>
    </Surface>
  ),
}

/**
 * `backdrop="dark"` composed with `pad={6}` - the exact combination
 * surface.test.tsx's "dark backdrop plus pad emits both, backdrop classes
 * first" case pins (`bg-surface-dark text-on-dark p-6`, in that order). This
 * is the story that proves Surface's own backdrop chrome and the shared
 * padding module compose deterministically rather than fighting over class
 * order.
 */
export const DarkBackdropPlusPad: Story = {
  args: {
    backdrop: 'dark',
    pad: 6,
    children: 'backdrop="dark" pad={6}',
  },
}

/**
 * A call-site `className` wins over the `backdrop` classes -
 * surface.test.tsx's own hygiene case. `backdrop="dark"` would render
 * `bg-surface-dark`, but the `bg-surface-light` supplied through `className`
 * is what tailwind-merge keeps, the same de-duplication box.stories.tsx's
 * `ClassNameOverride` demonstrates for `pad`.
 */
export const ClassNameOverride: Story = {
  render: () => (
    <Surface backdrop="dark" pad={6} className="bg-surface-light">
      <span className="text-sm text-text-primary">
        backdrop=&quot;dark&quot; + className=&quot;bg-surface-light&quot; -&gt; bg-surface-light wins
      </span>
    </Surface>
  ),
}

/**
 * A realistic composed example - a dark ambient panel (the CopilotSheet /
 * CopilotPanel shape surface.tsx's own header note describes, though neither
 * is converted to Surface by this session) hosting content that has not yet
 * been wired to read `useSurfaceBackdrop()`. The heading text is legible
 * because it inherits `text-on-dark` from the Surface itself; a real
 * descendant primitive reading the context is future work, flagged in
 * button.tsx's own header note.
 */
export const ComposedExample: Story = {
  render: () => (
    <Surface backdrop="dark" pad={6} className="max-w-sm rounded-card">
      <p className="text-sm font-medium">AI suggestion</p>
      <p className="mt-1 text-sm text-on-dark-muted">
        Estimate E00042 has been idle for 3 days. Send a follow-up?
      </p>
    </Surface>
  ),
}
