/* =============================================================================
   Separator - Storybook stories, full-coverage pass (Storybook phase, W2 plan).

   Storybook 8 is scaffolded (.storybook/main.ts, .storybook/preview.ts, the
   @storybook/react-vite devDependency in package.json), so this file imports
   the real `Meta` / `StoryObj` types from `@storybook/react` and wires
   `argTypes` so every axis is a live control in the Storybook UI - the same
   shape as badge.stories.tsx.

   COVERAGE, AND WHY THIS FILE TREATS "VARIANT KEY/VALUE" AS SEPARATOR'S
   variant/tone RATHER THAN A LITERAL cva() BLOCK. separator.tsx has no
   `cva()` call - its own header comment explains why: a naive cva `variants`
   object would happily compose the solid fill's height/width utility
   together with the dashed border, stacking a 1px box under a 1px border
   and rendering a 2px rule. So the two drawing modes are two hand-written
   literal-string lookup tables (SOLID_RULE, DASHED_RULE) instead. That is
   still a real, closed, two-axis prop surface - `SeparatorVariant`
   ("solid" | "dashed") and `SeparatorTone` ("default" | "danger") - and this
   file gives the completeness pass the same guarantee it would get from a
   literal cva block: every key, every value, at least one story.

     variant: solid | dashed          -> Default (solid) / Dashed each set it
       explicitly, and VariantToneMatrix renders both again for visual QA.
     tone:    default | danger        -> Default (default) / DashedDanger set
       it explicitly; SolidToneInert proves it is a no-op on variant="solid".

   `orientation` ("horizontal" | "vertical") and `decorative` (boolean) are
   not part of the closed vocabulary (they are Radix's own props on
   SeparatorPrimitive.Root, unchanged by phase 7) but they are real, shipped,
   and load-bearing - Header.tsx's three live sites all pass
   orientation="vertical" - so they get live controls and dedicated stories
   too, same as Alert's non-vocabulary `gap`/`pad` controls.

   NO `size` PROP HERE. The program plan's 8g step lists Separator under
   "size where demand exists" - the measured demand tables (1b/1c) show none,
   and separator.tsx ships none. Per the W2 plan's rule ("a primitive with no
   measured demand is left alone"), this file documents the real API instead
   of inventing a control for a prop that does not exist.

   VISUAL CONTEXT. A bare Separator is a 1px line with nothing around it -
   invisible on Storybook's blank canvas. Every story below wraps it in a
   small bordered panel so the rule is actually visible, using only classes
   already shipped elsewhere in this tree (bg-surface-light, border-border,
   text-text-secondary, text-danger - see badge.stories.tsx / alert.stories.tsx
   / collapse.stories.tsx for the same idiom). The wrapping panel is call-site
   layout, not something separator.tsx itself owns.
   ============================================================================= */
import type { Meta, StoryObj } from '@storybook/react';

import { Separator } from './separator';
import type { SeparatorTone, SeparatorVariant } from './separator';

const VARIANTS: SeparatorVariant[] = ['solid', 'dashed'];
const TONES: SeparatorTone[] = ['default', 'danger'];
const ORIENTATIONS = ['horizontal', 'vertical'] as const;

/** A horizontal rule needs vertical neighbours to read as a divider at all. */
function HorizontalPanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex w-72 flex-col gap-3 rounded-md border border-border bg-surface-light p-4 text-sm text-text-secondary">
      <span>Above the rule</span>
      {children}
      <span>Below the rule</span>
    </div>
  );
}

/**
 * A vertical rule needs an explicit-height flex row - exactly Header.tsx's
 * own shape (orientation="vertical" inside a fixed-height flex container).
 */
function VerticalPanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-8 items-center gap-2 rounded-md border border-border bg-surface-light px-4 text-sm text-text-secondary">
      <span>Left</span>
      {children}
      <span>Right</span>
    </div>
  );
}

const meta = {
  title: 'UI/Separator',
  component: Separator,
  tags: ['autodocs'],
  argTypes: {
    variant: {
      control: { type: 'select' },
      options: VARIANTS,
      description:
        'How the rule is drawn. `solid` (the default) is a background fill sized by a 1px height/width utility - the shipped default, unchanged. `dashed` is a border with no fill and no sizing utility on its own axis, so the two never stack into a 2px rule.',
    },
    tone: {
      control: { type: 'select' },
      options: TONES,
      description:
        'Rule colour. Applies on variant="dashed" only - a tone passed alongside variant="solid" is inert by design (see SolidToneInert), because solid colour is a background fill with zero measured demand for a second one.',
    },
    orientation: {
      control: { type: 'select' },
      options: ORIENTATIONS,
      description:
        "Radix's own prop, not part of the closed vocabulary. Picks which axis gets the 1px sizing (solid) or the border (dashed). Default \"horizontal\".",
    },
    decorative: {
      control: { type: 'boolean' },
      description:
        'Radix\'s own prop. true (the default) keeps the rule out of the accessibility tree (role="none"); false publishes role="separator" and, when vertical, aria-orientation="vertical".',
    },
    className: { control: false },
  },
} satisfies Meta<typeof Separator>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * `variant="solid"`, `tone="default"`, `orientation="horizontal"` - the
 * shipped default, set explicitly. Byte-identical to the propless render
 * every existing call site uses (StaffSection.tsx, CustomerDetailPage.tsx).
 */
export const Default: Story = {
  args: {
    variant: 'solid',
    tone: 'default',
    orientation: 'horizontal',
    decorative: true,
  },
  render: (args) => (
    <HorizontalPanel>
      <Separator {...args} />
    </HorizontalPanel>
  ),
};

/**
 * `orientation="vertical"` on the solid branch - Header.tsx's real shape
 * (a vertical rule inside a fixed-height flex row).
 */
export const Vertical: Story = {
  args: {
    variant: 'solid',
    orientation: 'vertical',
  },
  render: (args) => (
    <VerticalPanel>
      <Separator {...args} />
    </VerticalPanel>
  ),
};

/**
 * `tone="danger"` alongside `variant="solid"` - inert by design. Renders
 * byte-identical to Default; the tone has nowhere to apply because solid
 * colour comes from a background fill, not a border.
 */
export const SolidToneInert: Story = {
  args: {
    variant: 'solid',
    tone: 'danger',
  },
  render: (args) => (
    <HorizontalPanel>
      <Separator {...args} />
    </HorizontalPanel>
  ),
};

/** `variant="dashed"`, `tone="default"` - border drawn, no background fill. */
export const Dashed: Story = {
  args: {
    variant: 'dashed',
    tone: 'default',
  },
  render: (args) => (
    <HorizontalPanel>
      <Separator {...args} />
    </HorizontalPanel>
  ),
};

/**
 * `variant="dashed"`, `tone="danger"` - the measured signature. Two live
 * sites in InvoiceDetailPage's payment ledger (either side of the "Refunds"
 * label) are hand-rolled bare divs carrying exactly these three classes plus
 * layout; see RefundsLedgerPattern below for the full shape.
 */
export const DashedDanger: Story = {
  args: {
    variant: 'dashed',
    tone: 'danger',
  },
  render: (args) => (
    <HorizontalPanel>
      <Separator {...args} />
    </HorizontalPanel>
  ),
};

/** `variant="dashed"`, `orientation="vertical"`, `tone="default"` - draws on the left edge. */
export const DashedVertical: Story = {
  args: {
    variant: 'dashed',
    orientation: 'vertical',
    tone: 'default',
  },
  render: (args) => (
    <VerticalPanel>
      <Separator {...args} />
    </VerticalPanel>
  ),
};

/** `variant="dashed"`, `orientation="vertical"`, `tone="danger"` - the last uncovered corner of the grid. */
export const DashedVerticalDanger: Story = {
  args: {
    variant: 'dashed',
    orientation: 'vertical',
    tone: 'danger',
  },
  render: (args) => (
    <VerticalPanel>
      <Separator {...args} />
    </VerticalPanel>
  ),
};

/**
 * The full `orientation` x `variant` x `tone` grid (8 cells), for visual QA
 * in one screen. Mirrors badge.stories.tsx's VariantToneMatrix.
 */
export const VariantToneMatrix: Story = {
  render: () => (
    <div className="flex flex-col gap-6">
      {ORIENTATIONS.map((orientation) => (
        <div key={orientation} className="flex flex-col gap-2">
          <span className="text-xs font-medium text-text-secondary">
            orientation=&quot;{orientation}&quot;
          </span>
          <div className="flex flex-wrap gap-4">
            {VARIANTS.map((variant) =>
              TONES.map((tone) =>
                orientation === 'vertical' ? (
                  <VerticalPanel key={`${orientation}-${variant}-${tone}`}>
                    <div className="flex flex-col items-center gap-1">
                      <Separator orientation={orientation} variant={variant} tone={tone} />
                      <span className="text-xs text-text-secondary">
                        {variant}/{tone}
                      </span>
                    </div>
                  </VerticalPanel>
                ) : (
                  <HorizontalPanel key={`${orientation}-${variant}-${tone}`}>
                    <Separator orientation={orientation} variant={variant} tone={tone} />
                    <span className="text-xs text-text-secondary">
                      {variant}/{tone}
                    </span>
                  </HorizontalPanel>
                ),
              ),
            )}
          </div>
        </div>
      ))}
    </div>
  ),
};

/**
 * `decorative={false}` - publishes `role="separator"` (and, when vertical,
 * `aria-orientation`) instead of staying out of the accessibility tree. Real
 * call sites never set this (every one is a visual flourish beside a label
 * that already carries the meaning), but it is a real, shipped control.
 */
export const NotDecorative: Story = {
  args: {
    variant: 'solid',
    decorative: false,
  },
  render: (args) => (
    <HorizontalPanel>
      <Separator {...args} />
    </HorizontalPanel>
  ),
};

/**
 * The real InvoiceDetailPage ledger pattern this branch exists to retire: a
 * dashed danger rule either side of a "Refunds" label, each with `flex-1` so
 * the call site's own layout sizes the rule instead of the primitive's cross
 * axis span.
 */
export const RefundsLedgerPattern: Story = {
  name: 'Real call site - InvoiceDetailPage Refunds ledger',
  render: () => (
    <div className="flex w-72 items-center gap-2 rounded-md border border-border bg-surface-light p-4">
      <Separator variant="dashed" tone="danger" className="flex-1" />
      <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-danger">
        Refunds
      </span>
      <Separator variant="dashed" tone="danger" className="flex-1" />
    </div>
  ),
};

/**
 * The other six live call sites, transcribed verbatim (see
 * __tests__/separator.test.tsx's own frozen list): a bare divider between
 * settings rows, three header toolbar dividers, and two content dividers
 * with call-site margin. All propless or solid - none reach for `dashed` or
 * `tone`, which is exactly why those two stayed a zero-risk addition.
 */
export const LiveCallSites: Story = {
  render: () => (
    <div className="flex flex-col gap-6 rounded-md border border-border bg-surface-light p-4">
      <div className="flex flex-col gap-2 text-sm text-text-secondary">
        <span>StaffSection.tsx - a bare row divider</span>
        <span>Row one</span>
        <Separator />
        <span>Row two</span>
      </div>
      <div className="flex items-center gap-2 text-sm text-text-secondary">
        <span>Header.tsx - vertical toolbar dividers</span>
        <span>Search</span>
        <Separator orientation="vertical" className="mx-2 h-6" />
        <span>Notifications</span>
        <Separator orientation="vertical" className="mx-2 h-6" />
        <span>Account</span>
      </div>
      <div className="flex flex-col gap-2 text-sm text-text-secondary">
        <span>data-table.tsx / CustomerDetailPage.tsx - call-site margin</span>
        <span>Section one</span>
        <Separator className="my-2" />
        <span>Section two</span>
        <Separator className="my-5" />
        <span>Section three</span>
      </div>
    </div>
  ),
};
